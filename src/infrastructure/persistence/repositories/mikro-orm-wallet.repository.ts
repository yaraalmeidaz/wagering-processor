import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletVersionConflictError } from '../../../application/errors';
import type { WalletRepository } from '../../../application/ports/wallet-repository';
import type { Wallet } from '../../../domain/wallet';
import { WalletOrmEntity } from '../entities/WalletOrmEntity';
import { walletFromRow, walletToRow } from '../mappers/wallet.mapper';
import type { TransactionScope } from '../transaction-scope';

export class MikroOrmWalletRepository implements WalletRepository {
  readonly #em: EntityManager;
  readonly #scope: TransactionScope;

  constructor(em: EntityManager, scope: TransactionScope) {
    this.#em = em;
    this.#scope = scope;
  }

  async findById(id: string): Promise<Wallet | null> {
    this.#scope.assertActive();
    const row = await this.#em.findOne(WalletOrmEntity, { id }, { disableIdentityMap: true });
    return row === null ? null : walletFromRow(row);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    this.#scope.assertActive();
    const row = await this.#em.findOne(
      WalletOrmEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? null : walletFromRow(row);
  }

  async add(wallet: Wallet): Promise<void> {
    this.#scope.assertActive();
    await this.#em.insert(WalletOrmEntity, walletToRow(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    this.#scope.assertActive();
    const { balanceAmount, version, updatedAt } = walletToRow(wallet);
    const affected = await this.#em.nativeUpdate(
      WalletOrmEntity,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount, version, updatedAt },
    );
    if (affected !== 1) {
      throw new WalletVersionConflictError(
        `wallet ${wallet.id} não está na versão ${expectedVersion}`,
      );
    }
  }
}
