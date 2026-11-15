import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionRepository } from '../../../application/ports/transaction-repository';
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
    this.#scope.assertActive();
    const row = await this.#em.findOne(
      WagerTransactionOrmEntity,
      { id },
      { disableIdentityMap: true },
    );
    return row === null ? null : transactionFromRow(row);
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
}
