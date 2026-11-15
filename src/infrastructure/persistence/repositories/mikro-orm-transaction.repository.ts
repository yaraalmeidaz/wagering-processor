import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  FindOptions,
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
