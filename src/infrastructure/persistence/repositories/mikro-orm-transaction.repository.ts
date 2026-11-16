import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  FindOptions,
  PendingReferenceCandidate,
  TransactionRepository,
} from '../../../application/ports/transaction-repository';
import type { WagerTransaction } from '../../../domain/wager-transaction';
import { WagerTransactionOrmEntity } from '../entities/WagerTransactionOrmEntity';
import {
  transactionFromRow,
  transactionStateToRow,
  transactionToRow,
} from '../mappers/wager-transaction.mapper';
import type { TransactionScope } from '../transaction-scope';

export class MikroOrmTransactionRepository implements TransactionRepository {
  readonly #em: EntityManager;
  readonly #scope: TransactionScope;

  constructor(em: EntityManager, scope: TransactionScope) {
    this.#em = em;
    this.#scope = scope;
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.#findOne({ id }, {});
  }

  async findByIdempotencyKey(
    key: string,
    options: FindOptions = {},
  ): Promise<WagerTransaction | null> {
    return this.#findOne({ idempotencyKey: key }, options);
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    options: FindOptions = {},
  ): Promise<WagerTransaction | null> {
    return this.#findOne({ providerId, externalTransactionId }, options);
  }

  async hasProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<boolean> {
    this.#scope.assertActive();
    const count = await this.#em.count(WagerTransactionOrmEntity, {
      providerId,
      referenceExternalTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async findDueReferenceCandidates(limit: number): Promise<readonly PendingReferenceCandidate[]> {
    this.#scope.assertActive();
    // SQL da SPEC 8.2, conferido contra o PostgreSQL do compose; usa ix_wager_pending_reference.
    const rows = await this.#em.execute(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now()
        ORDER BY next_reference_attempt_at
        LIMIT ?`,
      [limit],
    );
    return (rows as { id: string; wallet_id: string }[]).map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
    }));
  }

  async findDuePendingForUpdate(id: string): Promise<WagerTransaction | null> {
    this.#scope.assertActive();
    const [locked] = await this.#em.execute(
      `SELECT id FROM wager_transactions
        WHERE id = ? AND status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now()
        FOR UPDATE SKIP LOCKED`,
      [id],
    );
    // A linha já está travada por esta transação; a leitura completa não espera.
    return locked === undefined ? null : this.#findOne({ id }, {});
  }

  async postponeReferenceAttempt(
    expected: WagerTransaction,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    this.#scope.assertActive();
    const affected = await this.#em.nativeUpdate(
      WagerTransactionOrmEntity,
      {
        id: expected.id,
        status: 'PENDING_REFERENCE',
        attempts: expected.attempts,
        nextReferenceAttemptAt: expected.nextReferenceAttemptAt,
      },
      { nextReferenceAttemptAt: nextAttemptAt },
    );
    return affected === 1;
  }

  async markPendingReferenceFailed(id: string, now: Date): Promise<boolean> {
    this.#scope.assertActive();
    // A transição PENDING_REFERENCE -> FAILED da RN-25 fica no WHERE; failure_code segue nulo (RN-40).
    const affected = await this.#em.nativeUpdate(
      WagerTransactionOrmEntity,
      { id, status: 'PENDING_REFERENCE' },
      { status: 'FAILED', processedAt: now },
    );
    return affected === 1;
  }

  async add(transaction: WagerTransaction): Promise<void> {
    this.#scope.assertActive();
    await this.#em.insert(WagerTransactionOrmEntity, transactionToRow(transaction));
  }

  /** Grava só as colunas de estado. Sem upsert, para não acionar o trigger de snapshot (RN-20). */
  async update(transaction: WagerTransaction): Promise<void> {
    this.#scope.assertActive();
    await this.#em.nativeUpdate(
      WagerTransactionOrmEntity,
      { id: transaction.id },
      transactionStateToRow(transaction),
    );
  }

  async #findOne(
    where: Partial<
      Record<'id' | 'idempotencyKey' | 'providerId' | 'externalTransactionId', string>
    >,
    options: FindOptions,
  ): Promise<WagerTransaction | null> {
    this.#scope.assertActive();
    const row = await this.#em.findOne(WagerTransactionOrmEntity, where, {
      disableIdentityMap: true,
      ...(options.forUpdate === true ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}),
    });
    return row === null ? null : transactionFromRow(row);
  }
}
