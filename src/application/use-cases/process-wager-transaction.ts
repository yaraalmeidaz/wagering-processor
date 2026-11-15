import { InvalidMoneyError } from '../../domain/errors';
import type { FailureCode } from '../../domain/failure-code';
import {
  decideIdempotency,
  type IdempotencyDecision,
  type IncomingIdempotency,
  type StoredIdempotency,
} from '../../domain/idempotency';
import { Money, type MoneyProps } from '../../domain/money';
import { nextReferenceAttemptAt } from '../../domain/pending-reference-backoff';
import { type ReferenceSnapshot, validateReference } from '../../domain/reference-rules';
import {
  balanceEffect,
  type ExternalKind,
  insufficientBalanceFailureCode,
  isExternalKind,
} from '../../domain/wager-kind';
import { type TransactionStatus, WagerTransaction } from '../../domain/wager-transaction';
import type { BalanceResult, Wallet } from '../../domain/wallet';
import {
  IdempotencyConflictError,
  InvalidWagerInputError,
  TransientFailureError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import {
  type IntegrationEvent,
  transactionEventData,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  walletBalanceChangedData,
} from '../events';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { TransactionRepository } from '../ports/transaction-repository';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';

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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const expectedVersion = wallet.version;
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
    const emit = (event: IntegrationEvent<object>) =>
      repositories.outbox.append({
        id: event.context.eventId,
        aggregateId: event.context.aggregateId,
        eventType: event.eventType,
        payload: event.toJSON(),
        occurredAt: event.context.occurredAt,
      });
    const context = () => ({
      eventId: crypto.randomUUID(),
      aggregateId: wallet.id,
      correlationId: request.correlationId ?? transaction.id,
      occurredAt: now,
    });

    // Rejeição de negócio é resultado persistido, não exceção (RN-19, RN-27).
    const reject = async (failureCode: FailureCode) => {
      // Saldo em outra moeda não cabe na coluna currency da transação (SPEC 12): sem snapshot.
      const snapshot = wallet.balance.hasSameCurrency(request.money) ? wallet.balance : null;
      transaction.reject(failureCode, snapshot, now);
      await repositories.transactions.add(transaction);
      await emit(new WagerTransactionRejected(context(), transactionEventData(transaction)));
      return resultOf(transaction, false);
    };

    if (forcedFailure !== null) return reject(forcedFailure);
    // SPEC 4.3: estes dois vêm antes da referência, porque não exigem leitura adicional.
    if (!wallet.belongsTo(request.playerId)) return reject('WALLET_PLAYER_MISMATCH');
    if (request.money.currency !== wallet.currency) return reject('CURRENCY_MISMATCH');

    let referenced: WagerTransaction | null = null;
    const reference = request.referenceExternalTransactionId;
    // RN-42: BET e LOSS não aceitam referência.
    if (reference !== null && !hasReferenceRule(request.kind)) {
      return reject('REFERENCE_KIND_NOT_ALLOWED');
    }
    if (reference !== null) {
      const found = await repositories.transactions.findByProviderAndExternalId(
        request.providerId,
        reference,
      );
      const isReversal = request.kind === 'REFUND' || request.kind === 'ROLLBACK';
      const check = validateReference({
        transaction: {
          kind: request.kind,
          playerId: request.playerId,
          walletId: request.walletId,
          roundId: request.roundId,
          money: request.money,
        },
        reference: found === null ? null : snapshotOf(found),
        referenceAlreadyReversed: isReversal
          ? await repositories.transactions.hasProcessedReversal(request.providerId, reference)
          : false,
      });
      if (check.outcome === 'PENDING_REFERENCE') {
        // SPEC 8.1; RN-12, RN-29; ADR-0007.
        transaction.markPendingReference(nextReferenceAttemptAt(now, 1, this.#random));
        await repositories.transactions.add(transaction);
        await emit(
          new WagerTransactionPendingReference(context(), {
            ...transactionEventData(transaction),
            nextReferenceAttemptAt: transaction.nextReferenceAttemptAt?.toISOString() ?? null,
          }),
        );
        return resultOf(transaction, false);
      }
      if (check.outcome === 'REJECTED') return reject(check.failureCode);
      referenced = found;
    }

    const operation = { entryId: crypto.randomUUID(), transactionId: transaction.id, now };
    const effect = balanceEffect(request.kind, referenced?.kind ?? null);
    const outcome: BalanceResult =
      effect === 'DEBIT'
        ? wallet.debit(request.money, operation, insufficientBalanceFailureCode(request.kind))
        : effect === 'CREDIT'
          ? wallet.credit(request.money, operation)
          : { ok: true, balanceBefore: wallet.balance, balanceAfter: wallet.balance, entry: null };
    if (!outcome.ok) return reject(outcome.failureCode);

    transaction.markProcessed(outcome.balanceAfter, now, referenced?.id ?? null);
    await repositories.transactions.add(transaction);
    await emit(new WagerTransactionProcessed(context(), transactionEventData(transaction)));
    if (outcome.entry !== null) {
      await repositories.wallets.update(wallet, expectedVersion);
      await repositories.ledger.append(outcome.entry);
      // RN-28: só quando o saldo muda.
      await emit(
        new WalletBalanceChanged(
          context(),
          walletBalanceChangedData(wallet, transaction.id, outcome.balanceBefore.toJSON()),
        ),
      );
    }
    return resultOf(transaction, false);
  }
}

function hasReferenceRule(kind: ExternalKind): boolean {
  return kind === 'WIN' || kind === 'REFUND' || kind === 'ROLLBACK';
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

function snapshotOf(transaction: WagerTransaction): ReferenceSnapshot {
  return {
    kind: transaction.kind,
    status: transaction.status,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    money: transaction.money,
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
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWagerInputError(`${field} é obrigatório`);
    }
    return value;
  };
  const uuid = (value: unknown, field: string): string => {
    const checked = text(value, field);
    if (!UUID_PATTERN.test(checked)) throw new InvalidWagerInputError(`${field} precisa ser uuid`);
    return checked;
  };

  const kind = text(input.kind, 'kind');
  if (!isExternalKind(kind)) {
    // OPENING é interno e não entra pela API nem pela fila (RN-04).
    throw new InvalidWagerInputError(`kind não aceito: ${kind}`);
  }
  let money: Money;
  try {
    money = Money.create(input.money?.amount, input.money?.currency);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidWagerInputError(error.message, { cause: error });
    }
    throw error;
  }
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
  };
}
