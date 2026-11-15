import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** Posição de um lançamento na ordem (created_at DESC, id DESC) do ledger (ADR-0009). */
export interface LedgerPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export interface LedgerPageQuery {
  readonly limit: number;
  /** Devolve só os lançamentos depois desta posição na ordem do ledger. */
  readonly after: LedgerPosition | null;
}

/** Soma independente do ledger, sem usar balance_after (RN-37). */
export interface LedgerSummary {
  /** Créditos menos débitos, em string decimal de escala 2. */
  readonly creditsMinusDebits: string;
  readonly entries: number;
}

/** Porta do ledger append-only (SPEC 2.2; RN-36): só acrescenta e lê. */
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
  /** Do mais recente ao mais antigo, por (created_at DESC, id DESC). */
  listPage(walletId: string, query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string): Promise<LedgerSummary>;
}
