import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerPageQuery,
  LedgerRepository,
  LedgerSummary,
} from '../../../application/ports/ledger-repository';
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
    const currency = await this.#walletCurrency(walletId);
    if (currency === null) return [];
    const rows = await this.#em.find(
      WalletLedgerEntryOrmEntity,
      { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' }, disableIdentityMap: true },
    );
    return rows.map((row) => ledgerEntryFromRow(row, currency));
  }

  /** Mesma ordem do índice ix_ledger_wallet_cursor: (created_at DESC, id DESC) (SPEC 12). */
  async listPage(walletId: string, query: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    this.#scope.assertActive();
    const currency = await this.#walletCurrency(walletId);
    if (currency === null) return [];
    const { after } = query;
    const where =
      after === null
        ? { walletId }
        : {
            walletId,
            $or: [
              { createdAt: { $lt: after.createdAt } },
              { createdAt: after.createdAt, id: { $lt: after.id } },
            ],
          };
    const rows = await this.#em.find(WalletLedgerEntryOrmEntity, where, {
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: query.limit,
      disableIdentityMap: true,
    });
    return rows.map((row) => ledgerEntryFromRow(row, currency));
  }

  /** Créditos menos débitos, sem usar balance_after (RN-37). */
  async summarize(walletId: string): Promise<LedgerSummary> {
    this.#scope.assertActive();
    const rows = await this.#em.execute(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS total,
              count(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0] as { total?: unknown; entries?: unknown } | undefined;
    return { creditsMinusDebits: String(row?.total ?? '0.00'), entries: Number(row?.entries ?? 0) };
  }

  async #walletCurrency(walletId: string): Promise<string | null> {
    const wallet = await this.#em.findOne(
      WalletOrmEntity,
      { id: walletId },
      { fields: ['currency'], disableIdentityMap: true },
    );
    return wallet?.currency ?? null;
  }
}
