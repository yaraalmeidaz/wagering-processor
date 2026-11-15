import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** Porta do ledger append-only (SPEC 2.2; RN-36): só acrescenta e lê. */
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}
