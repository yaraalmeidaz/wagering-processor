import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../../application/ports/ledger-repository';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { WalletLedgerEntryOrmEntity } from '../entities/WalletLedgerEntryOrmEntity';
import { WalletOrmEntity } from '../entities/WalletOrmEntity';
import { ledgerEntryFromRow, ledgerEntryToRow } from '../mappers/wallet-ledger-entry.mapper';
import type { TransactionScope } from '../transaction-scope';

/** Só INSERT e SELECT: o banco bloqueia UPDATE e DELETE no ledger (RN-36). */
export class MikroOrmLedgerRepository implements LedgerRepository {
  readonly #em: EntityManager;
  readonly #scope: TransactionScope;

  constructor(em: EntityManager, scope: TransactionScope) {
    this.#em = em;
    this.#scope = scope;
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.#scope.assertActive();
    await this.#em.insert(WalletLedgerEntryOrmEntity, ledgerEntryToRow(entry));
  }

  async listByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    this.#scope.assertActive();
    const wallet = await this.#em.findOne(
      WalletOrmEntity,
      { id: walletId },
      { fields: ['currency'], disableIdentityMap: true },
    );
    if (wallet === null) {
      return [];
    }
    const rows = await this.#em.find(
      WalletLedgerEntryOrmEntity,
      { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' }, disableIdentityMap: true },
    );
    return rows.map((row) => ledgerEntryFromRow(row, wallet.currency));
  }
}
