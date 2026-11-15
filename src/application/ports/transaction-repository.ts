import type { WagerTransaction } from '../../domain/wager-transaction';

export interface FindOptions {
  /** SELECT ... FOR UPDATE, sempre depois do lock da wallet (SPEC 8.2; ADR-0003). */
  readonly forUpdate?: boolean;
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
  add(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}
