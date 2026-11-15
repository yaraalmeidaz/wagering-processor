import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InvalidInputError, WalletNotFoundError } from '../errors';
import { requiredUuid } from '../input';
import type { LedgerPosition } from '../ports/ledger-repository';
import type { UnitOfWork } from '../ports/unit-of-work';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 100;

/** GET /wallets/:walletId (SPEC 13). */
export class GetWallet {
  readonly #uow: UnitOfWork;

  constructor(dependencies: { unitOfWork: UnitOfWork }) {
    this.#uow = dependencies.unitOfWork;
  }

  async execute(walletId: unknown): Promise<Wallet> {
    const id = requiredUuid(walletId, 'walletId');
    const wallet = await this.#uow.run(({ wallets }) => wallets.findById(id));
    if (wallet === null) throw new WalletNotFoundError(`wallet ${id} não encontrada`);
    return wallet;
  }
}

export interface LedgerPage {
  readonly items: WalletLedgerEntry[];
  /** Posição do último item, quando há mais páginas. */
  readonly next: LedgerPosition | null;
}

/** GET /wallets/:walletId/ledger, paginado por posição (SPEC 13; ADR-0009). */
export class GetLedger {
  readonly #uow: UnitOfWork;

  constructor(dependencies: { unitOfWork: UnitOfWork }) {
    this.#uow = dependencies.unitOfWork;
  }

  async execute(
    walletId: unknown,
    limit: number,
    after: LedgerPosition | null,
  ): Promise<LedgerPage> {
    const id = requiredUuid(walletId, 'walletId');
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw new InvalidInputError(`limit precisa ser inteiro de 1 a ${LEDGER_MAX_LIMIT}`);
    }
    return this.#uow.run(async ({ wallets, ledger }) => {
      if ((await wallets.findById(id)) === null) {
        throw new WalletNotFoundError(`wallet ${id} não encontrada`);
      }
      const rows = await ledger.listPage(id, { limit: limit + 1, after });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const next =
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null;
      return { items, next };
    });
  }
}
