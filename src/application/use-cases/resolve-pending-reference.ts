import { DomainError } from '../../domain/errors';
import type { FailureCode } from '../../domain/failure-code';
import {
  isLastReferenceAttempt,
  nextReferenceAttemptAt,
} from '../../domain/pending-reference-backoff';
import {
  PermanentDataError,
  TransientFailureError,
  UniqueViolationError,
  WalletVersionConflictError,
} from '../errors';
import type { Clock } from '../ports/clock';
import type { PendingReferenceCandidate } from '../ports/transaction-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { applyWagerRules, rejectWager, type WagerRuleContext } from './apply-wager-rules';

/** Índice parcial de reversão única (SPEC 6.2; ADR-0004). */
const REVERSAL_CONSTRAINT = 'uq_wager_single_processed_reversal';

/**
 * PROCESSED e REJECTED: estado terminal gravado com o evento no outbox.
 * RESCHEDULED: tentativa consumida, próxima agendada. POSTPONED: erro transitório,
 * sem consumir tentativa. FAILED: erro permanente (RN-41). SKIPPED: outro worker já
 * tratou, travou ou adiou a linha, ou ela não está mais vencida.
 */
export type ResolveOutcome =
  | 'PROCESSED'
  | 'REJECTED'
  | 'RESCHEDULED'
  | 'POSTPONED'
  | 'FAILED'
  | 'SKIPPED';

export interface ResolveResult {
  readonly transactionId: string;
  readonly outcome: ResolveOutcome;
  /** Erro que levou a POSTPONED ou FAILED, para o log do worker. */
  readonly cause?: unknown;
}

export interface ResolvePendingReferenceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  /** Fonte do jitter do backoff (ADR-0007). Padrão: Math.random. */
  readonly random?: () => number;
}

/**
 * Resolvedor de PENDING_REFERENCE (SPEC 8.2 a 8.5; RN-12; ADR-0007). Usa o mesmo
 * caminho de regras do caso de uso da seção 5, sob o lock da wallet.
 */
export class ResolvePendingReference {
  readonly #uow: UnitOfWork;
  readonly #clock: Clock;
  readonly #random: () => number;

  constructor(dependencies: ResolvePendingReferenceDependencies) {
    this.#uow = dependencies.unitOfWork;
    this.#clock = dependencies.clock;
    this.#random = dependencies.random ?? Math.random;
  }

  async resolve(candidate: PendingReferenceCandidate): Promise<ResolveResult> {
    const result = (outcome: ResolveOutcome, cause?: unknown): ResolveResult =>
      cause === undefined
        ? { transactionId: candidate.id, outcome }
        : { transactionId: candidate.id, outcome, cause };
    try {
      return result(await this.#attempt(candidate, null));
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === REVERSAL_CONSTRAINT) {
        // SPEC 6.3: a transação que recebeu 23505 já fez ROLLBACK; esta é uma nova, sem retry.
        return result(await this.#attempt(candidate, 'REFERENCE_ALREADY_REVERSED'), error);
      }
      if (isTransient(error)) return result(await this.#postpone(candidate), error);
      if (isPermanent(error)) return result(await this.#fail(candidate), error);
      // Erro inesperado: nada é gravado, e o worker decide (AGENTS.md §4, item 9).
      throw error;
    }
  }

  /** Uma tentativa: lock da wallet, depois a pendência (SPEC 8.2; RN-31). */
  #attempt(
    candidate: PendingReferenceCandidate,
    forcedFailure: FailureCode | null,
  ): Promise<ResolveOutcome> {
    return this.#uow.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(candidate.walletId);
      if (wallet === null) {
        // A FK de wallet_id impede este caso; se ocorrer, o dado está inconsistente.
        throw new PermanentDataError(`wallet ${candidate.walletId} ausente`, null);
      }
      const transaction = await repositories.transactions.findDuePendingForUpdate(candidate.id);
      if (transaction === null) return 'SKIPPED';

      const now = this.#clock.now();
      const rules: WagerRuleContext = {
        repositories,
        wallet,
        transaction,
        correlationId: transaction.id,
        now,
        persist: (pending) => repositories.transactions.update(pending),
      };
      if (forcedFailure !== null) {
        await rejectWager(rules, forcedFailure);
        return 'REJECTED';
      }

      const outcome = await applyWagerRules(rules, null);
      if (outcome === 'SETTLED') {
        return transaction.status === 'PROCESSED' ? 'PROCESSED' : 'REJECTED';
      }
      // Referência ausente. A última tentativa procura como as outras (decisão B da ADR-0007).
      const attempt = transaction.attempts + 1;
      if (isLastReferenceAttempt(attempt, transaction.createdAt, now)) {
        await rejectWager(rules, 'REFERENCE_NOT_FOUND');
        return 'REJECTED';
      }
      transaction.scheduleNextReferenceAttempt(
        nextReferenceAttemptAt(now, attempt + 1, this.#random),
      );
      await repositories.transactions.update(transaction);
      return 'RESCHEDULED';
    });
  }

  /** ADR-0007: adia sem consumir tentativa, com CAS sobre a leitura desta unidade. */
  #postpone(candidate: PendingReferenceCandidate): Promise<ResolveOutcome> {
    return this.#uow.run(async ({ transactions }) => {
      const current = await transactions.findById(candidate.id);
      if (current === null || current.status !== 'PENDING_REFERENCE') return 'SKIPPED';
      const next = nextReferenceAttemptAt(this.#clock.now(), current.attempts + 1, this.#random);
      return (await transactions.postponeReferenceAttempt(current, next)) ? 'POSTPONED' : 'SKIPPED';
    });
  }

  /** RN-41; ADR-0007: FAILED em transação nova, sem failureCode e sem retry. */
  #fail(candidate: PendingReferenceCandidate): Promise<ResolveOutcome> {
    return this.#uow.run(async ({ wallets, transactions }) => {
      // Mesma ordem de lock do fluxo principal quando a wallet existe (SPEC 8.2).
      await wallets.findByIdForUpdate(candidate.walletId);
      const failed = await transactions.markPendingReferenceFailed(candidate.id, this.#clock.now());
      return failed ? 'FAILED' : 'SKIPPED';
    });
  }
}

function isTransient(error: unknown): boolean {
  return error instanceof TransientFailureError || error instanceof WalletVersionConflictError;
}

/** Dado que o banco ou o domínio recusam, e 23505 que não é o de reversão (ADR-0007). */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentDataError ||
    error instanceof DomainError ||
    error instanceof UniqueViolationError
  );
}
