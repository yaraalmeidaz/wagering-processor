import type { WagerTransaction } from '../../domain/wager-transaction';

export interface FindOptions {
  /** SELECT ... FOR UPDATE, sempre depois do lock da wallet (SPEC 8.2; ADR-0003). */
  readonly forUpdate?: boolean;
}

/** Pendência vencida, lida sem lock (SPEC 8.2). */
export interface PendingReferenceCandidate {
  readonly id: string;
  readonly walletId: string;
}

/** Porta de persistência da WagerTransaction (SPEC 2.2). */
export interface TransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string, options?: FindOptions): Promise<WagerTransaction | null>;
  /** Por (provider_id, external_transaction_id): idempotência (RN-22) e referência (RN-11). */
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    options?: FindOptions,
  ): Promise<WagerTransaction | null>;
  /** Existe REFUND ou ROLLBACK PROCESSED sobre a referência, de qualquer tipo (RN-16). */
  hasProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<boolean>;
  /** SPEC 8.2: PENDING_REFERENCE vencidas, sem lock, por next_reference_attempt_at. */
  findDueReferenceCandidates(limit: number): Promise<readonly PendingReferenceCandidate[]>;
  /**
   * SPEC 8.2: releitura da pendência vencida com FOR UPDATE SKIP LOCKED, sempre depois do
   * lock da wallet. Nulo quando outro worker já tratou, travou ou adiou a pendência.
   */
  findDuePendingForUpdate(id: string): Promise<WagerTransaction | null>;
  /**
   * ADR-0007: adia a pendência depois de erro transitório, sem consumir tentativa. CAS em
   * attempts e next_reference_attempt_at lidos em `expected`. Falso se a linha mudou.
   */
  postponeReferenceAttempt(expected: WagerTransaction, nextAttemptAt: Date): Promise<boolean>;
  add(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}
