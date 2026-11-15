import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import type { FailureCode } from './failure-code';
import type { Money } from './money';
import type { WagerKind } from './wager-kind';

export const TRANSACTION_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const TERMINAL: ReadonlySet<TransactionStatus> = new Set(['PROCESSED', 'REJECTED', 'FAILED']);

/** Transições válidas da RN-25. */
const TRANSITIONS: Readonly<Record<TransactionStatus, readonly TransactionStatus[]>> = {
  PENDING: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly referenceTransactionId: string | null;
  readonly status: TransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly resultingBalance: Money | null;
  readonly attempts: number;
  readonly nextReferenceAttemptAt: Date | null;
  readonly processedAt: Date | null;
}

/** Transação de aposta com máquina de estados da RN-25 (SPEC 3.3). */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;
  #referenceTransactionId: string | null;
  #status: TransactionStatus;
  #failureCode: FailureCode | null;
  #resultingBalance: Money | null;
  #attempts: number;
  #nextReferenceAttemptAt: Date | null;
  #processedAt: Date | null;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt);
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#status = state.status;
    this.#failureCode = state.failureCode;
    this.#resultingBalance = state.resultingBalance;
    this.#attempts = state.attempts;
    this.#nextReferenceAttemptAt = copyDate(state.nextReferenceAttemptAt);
    this.#processedAt = copyDate(state.processedAt);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      (props.kind === 'REFUND' || props.kind === 'ROLLBACK') &&
      props.referenceExternalTransactionId === null
    ) {
      throw new InvalidWagerTransactionError(`${props.kind} exige referência`);
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('payloadHash precisa ser SHA-256 em hex minúsculo');
    }
    return new WagerTransaction({
      ...props,
      referenceTransactionId: null,
      status: 'PENDING',
      failureCode: null,
      resultingBalance: null,
      attempts: 0,
      nextReferenceAttemptAt: null,
      processedAt: null,
    });
  }

  /** Reconstrói estado persistido sem revalidar transições (SPEC 2.1). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): TransactionStatus {
    return this.#status;
  }

  get failureCode(): FailureCode | null {
    return this.#failureCode;
  }

  get resultingBalance(): Money | null {
    return this.#resultingBalance;
  }

  get referenceTransactionId(): string | null {
    return this.#referenceTransactionId;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get nextReferenceAttemptAt(): Date | null {
    return copyDate(this.#nextReferenceAttemptAt);
  }

  get processedAt(): Date | null {
    return copyDate(this.#processedAt);
  }

  isTerminal(): boolean {
    return TERMINAL.has(this.#status);
  }

  /** resultingBalance é o snapshot do saldo ao processar, devolvido no replay (RN-20). */
  markProcessed(
    resultingBalance: Money,
    now: Date,
    referenceTransactionId: string | null = null,
  ): void {
    this.#transitionTo('PROCESSED');
    this.#setResultingBalance(resultingBalance);
    this.#referenceTransactionId = referenceTransactionId;
    this.#processedAt = new Date(now);
  }

  /** Rejeição de negócio persistida, com failureCode e saldo da época (RN-19, RN-20). */
  /**
   * Nulo só quando o saldo da wallet está em outra moeda (CURRENCY_MISMATCH): o
   * schema guarda amount e resulting_balance numa única coluna de moeda (SPEC 12).
   */
  reject(failureCode: FailureCode, resultingBalance: Money | null, now: Date): void {
    this.#transitionTo('REJECTED');
    if (resultingBalance === null) {
      this.#resultingBalance = null;
    } else {
      this.#setResultingBalance(resultingBalance);
    }
    this.#failureCode = failureCode;
    this.#processedAt = new Date(now);
  }

  /** Referência ausente: grava next_reference_attempt_at com attempts = 0 (SPEC 8.1). */
  markPendingReference(nextAttemptAt: Date): void {
    this.#transitionTo('PENDING_REFERENCE');
    this.#attempts = 0;
    this.#nextReferenceAttemptAt = new Date(nextAttemptAt);
  }

  /** Nova tentativa da pendência, sem mudar o status (SPEC 8.2). */
  scheduleNextReferenceAttempt(nextAttemptAt: Date): void {
    if (this.#status !== 'PENDING_REFERENCE') {
      throw new InvalidTransactionStateError(
        `reagendamento exige PENDING_REFERENCE, estado: ${this.#status}`,
      );
    }
    this.#attempts += 1;
    this.#nextReferenceAttemptAt = new Date(nextAttemptAt);
  }

  /** FAILED não guarda failureCode (RN-40, RN-41). */
  markFailed(now: Date): void {
    this.#transitionTo('FAILED');
    this.#processedAt = new Date(now);
  }

  #transitionTo(next: TransactionStatus): void {
    if (!TRANSITIONS[this.#status].includes(next)) {
      throw new InvalidTransactionStateError(`transição inválida: ${this.#status} -> ${next}`);
    }
    this.#status = next;
  }

  #setResultingBalance(resultingBalance: Money): void {
    if (!resultingBalance.hasSameCurrency(this.money)) {
      throw new InvalidWagerTransactionError(
        'resulting_balance precisa estar na moeda da transação',
      );
    }
    this.#resultingBalance = resultingBalance;
  }
}

function copyDate(date: Date | null): Date | null {
  return date === null ? null : new Date(date);
}
