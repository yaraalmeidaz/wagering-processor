import type { FailureCode } from '../../domain/failure-code';
import {
  decideIdempotency,
  type IdempotencyDecision,
  type IncomingIdempotency,
  type StoredIdempotency,
} from '../../domain/idempotency';
import { InboxMessage } from '../../domain/inbox-message';
import type { Money, MoneyProps } from '../../domain/money';
import { nextReferenceAttemptAt } from '../../domain/pending-reference-backoff';
import { type ExternalKind, isExternalKind } from '../../domain/wager-kind';
import { type TransactionStatus, WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import {
  IdempotencyConflictError,
  InvalidWagerInputError,
  TransientFailureError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import { transactionEventData, WagerTransactionPendingReference } from '../events';
import { requiredMoney, requiredText, requiredUuid } from '../input';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { TransactionRepository } from '../ports/transaction-repository';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { applyWagerRules, emitWagerEvent, type WagerRuleContext } from './apply-wager-rules';

export interface ProcessWagerInput {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string | null;
  readonly correlationId?: string;
  /** Só na entrada pela fila: gravada processada na transação do efeito (ADR-0010). */
  readonly inbox?: InboxMessage;
}

export interface ProcessWagerResult {
  readonly transactionId: string;
  readonly status: TransactionStatus;
  readonly failureCode: FailureCode | null;
  /** resulting_balance gravado na transação: o saldo da época, nunca o atual (RN-20). */
  readonly balance: MoneyProps | null;
  readonly idempotentReplay: boolean;
}

export interface ProcessWagerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  /** Fonte do jitter do backoff (ADR-0007). Padrão: Math.random. */
  readonly random?: () => number;
}

/** Índice parcial de reversão única (SPEC 6.2; ADR-0004). */
const REVERSAL_CONSTRAINT = 'uq_wager_single_processed_reversal';

interface ValidatedRequest {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ExternalKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly correlationId: string | undefined;
  readonly inbox: InboxMessage | undefined;
}

/**
 * Caso de uso único para HTTP e SQS (SPEC 5; AGENTS.md §4). Fast-path terminal
 * sem lock, slow-path sob lock da wallet, rejeição como resultado e tratamento
 * de 23505 da SPEC 5.9 e 6.3 (ADR-0003, ADR-0004, ADR-0005, ADR-0007).
 */
export class ProcessWagerTransaction {
  readonly #uow: UnitOfWork;
  readonly #clock: Clock;
  readonly #random: () => number;

  constructor(dependencies: ProcessWagerDependencies) {
    this.#uow = dependencies.unitOfWork;
    this.#clock = dependencies.clock;
    this.#random = dependencies.random ?? Math.random;
  }

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const request = validate(input);
    const incoming: IncomingIdempotency = {
      idempotencyKey: request.idempotencyKey,
      payloadHash: request.payloadHash,
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
    };

    // SPEC 5.4: fast-path sem lock, só para estados terminais.
    const known = await this.#uow.run(({ transactions }) =>
      findExisting(transactions, incoming, false),
    );
    const fast = decide(known, incoming, 'FAST_PATH');
    if (fast !== null) return fast;

    try {
      return await this.#slowPath(request, incoming, null);
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      return this.#afterUniqueViolation(error, request, incoming);
    }
  }

  /** SPEC 5.9 e 6.3: a transação que recebeu 23505 já fez ROLLBACK; esta é uma nova. */
  async #afterUniqueViolation(
    violation: UniqueViolationError,
    request: ValidatedRequest,
    incoming: IncomingIdempotency,
  ): Promise<ProcessWagerResult> {
    if (violation.constraint === REVERSAL_CONSTRAINT) {
      try {
        return await this.#slowPath(request, incoming, 'REFERENCE_ALREADY_REVERSED');
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
      }
    }
    const committed = await this.#uow.run(({ transactions }) =>
      findExisting(transactions, incoming, false),
    );
    const outcome = decide(committed, incoming, 'UNDER_LOCK');
    if (outcome === null) {
      throw new TransientFailureError('23505 sem linha commitada correspondente', '23505', {
        cause: violation,
      });
    }
    return outcome;
  }

  /** SPEC 5.5 a 5.8: lock da wallet, depois da transação, e gravação na mesma unidade. */
  #slowPath(
    request: ValidatedRequest,
    incoming: IncomingIdempotency,
    forcedFailure: FailureCode | null,
  ): Promise<ProcessWagerResult> {
    return this.#uow.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(request.walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(`wallet ${request.walletId} não encontrada`);
      }
      // SPEC 5.7 d; ADR-0010: inbox na mesma transação. Mesmo messageId de novo: 23505 (SPEC 5.9).
      if (request.inbox !== undefined) {
        await repositories.inbox.add(processedCopy(request.inbox, this.#clock.now()));
      }
      const existing = await findExisting(repositories.transactions, incoming, true);
      const decided = decide(existing, incoming, 'UNDER_LOCK');
      if (decided !== null) return decided;
      return this.#processNew(repositories, wallet, request, forcedFailure);
    });
  }

  async #processNew(
    repositories: Repositories,
    wallet: Wallet,
    request: ValidatedRequest,
    forcedFailure: FailureCode | null,
  ): Promise<ProcessWagerResult> {
    const now = this.#clock.now();
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      idempotencyKey: request.idempotencyKey,
      payloadHash: request.payloadHash,
      walletId: request.walletId,
      playerId: request.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      money: request.money,
      referenceExternalTransactionId: request.referenceExternalTransactionId,
      createdAt: now,
    });
    const rules: WagerRuleContext = {
      repositories,
      wallet,
      transaction,
      correlationId: request.correlationId ?? transaction.id,
      now,
      persist: (created) => repositories.transactions.add(created),
    };

    const outcome = await applyWagerRules(rules, forcedFailure);
    if (outcome === 'REFERENCE_MISSING') {
      // SPEC 8.1; RN-12, RN-29; ADR-0007.
      transaction.markPendingReference(nextReferenceAttemptAt(now, 1, this.#random));
      await rules.persist(transaction);
      await emitWagerEvent(
        rules,
        (context) =>
          new WagerTransactionPendingReference(context, {
            ...transactionEventData(transaction),
            nextReferenceAttemptAt: transaction.nextReferenceAttemptAt?.toISOString() ?? null,
          }),
      );
    }
    return resultOf(transaction, false);
  }
}

async function findExisting(
  transactions: TransactionRepository,
  incoming: IncomingIdempotency,
  forUpdate: boolean,
): Promise<WagerTransaction | null> {
  const byKey = await transactions.findByIdempotencyKey(incoming.idempotencyKey, { forUpdate });
  if (byKey !== null) return byKey;
  return transactions.findByProviderAndExternalId(
    incoming.providerId,
    incoming.externalTransactionId,
    { forUpdate },
  );
}

/** Resposta já decidida pela idempotência, ou null para seguir (RN-20 a RN-22; ADR-0005). */
function decide(
  found: WagerTransaction | null,
  incoming: IncomingIdempotency,
  phase: 'FAST_PATH' | 'UNDER_LOCK',
): ProcessWagerResult | null {
  const decision: IdempotencyDecision = decideIdempotency(
    found === null ? null : storedOf(found),
    incoming,
    phase,
  );
  switch (decision) {
    case 'REPLAY':
      if (found === null) throw new Error('replay sem transação');
      return resultOf(found, true);
    case 'PAYLOAD_MISMATCH':
      throw new IdempotencyConflictError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    case 'KEY_CONFLICT':
      throw new IdempotencyConflictError('IDEMPOTENCY_KEY_CONFLICT');
    case 'NOT_FOUND':
    case 'SLOW_PATH':
      return null;
  }
}

function storedOf(transaction: WagerTransaction): StoredIdempotency {
  return {
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    status: transaction.status,
  };
}

function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): ProcessWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.resultingBalance?.toJSON() ?? null,
    idempotentReplay,
  };
}

/** SPEC 5.1: payload inválido não vira transação. */
function validate(input: ProcessWagerInput): ValidatedRequest {
  const text = (value: unknown, field: string) =>
    requiredText(value, field, InvalidWagerInputError);
  const uuid = (value: unknown, field: string) =>
    requiredUuid(value, field, InvalidWagerInputError);

  const kind = text(input.kind, 'kind');
  if (!isExternalKind(kind)) {
    // OPENING é interno e não entra pela API nem pela fila (RN-04).
    throw new InvalidWagerInputError(`kind não aceito: ${kind}`);
  }
  const money = requiredMoney(input.money, 'money', InvalidWagerInputError);
  const reference =
    input.referenceExternalTransactionId === undefined ||
    input.referenceExternalTransactionId === null
      ? null
      : text(input.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && reference === null) {
    throw new InvalidWagerInputError(`${kind} exige referenceExternalTransactionId`);
  }

  const fields = {
    providerId: text(input.providerId, 'providerId'),
    externalTransactionId: text(input.externalTransactionId, 'externalTransactionId'),
    playerId: uuid(input.playerId, 'playerId'),
    walletId: uuid(input.walletId, 'walletId'),
    roundId: text(input.roundId, 'roundId'),
    gameId: text(input.gameId, 'gameId'),
  };
  return {
    ...fields,
    idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'),
    payloadHash: payloadHash({
      ...fields,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: reference,
    }),
    kind,
    money,
    referenceExternalTransactionId: reference,
    correlationId: input.correlationId,
    inbox: input.inbox,
  };
}

/**
 * Cópia processada da mensagem recebida. Cada tentativa da unidade de trabalho grava
 * a própria cópia, sem alterar a da entrada (ADR-0010).
 */
function processedCopy(received: InboxMessage, now: Date): InboxMessage {
  const copy = InboxMessage.create({
    consumerName: received.consumerName,
    messageId: received.messageId,
    payloadHash: received.payloadHash,
    receivedAt: received.receivedAt,
    processedAt: null,
  });
  copy.markProcessed(now);
  return copy;
}
