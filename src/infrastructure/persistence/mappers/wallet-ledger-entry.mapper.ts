import { Money } from '../../../domain/money';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import type { WalletLedgerEntryOrmEntity } from '../entities/WalletLedgerEntryOrmEntity';
import { oneOf } from './persisted-value';

export type WalletLedgerEntryRow = Pick<
  WalletLedgerEntryOrmEntity,
  | 'id'
  | 'walletId'
  | 'transactionId'
  | 'direction'
  | 'amount'
  | 'balanceBefore'
  | 'balanceAfter'
  | 'createdAt'
>;

const DIRECTIONS = ['DEBIT', 'CREDIT'] as const;

export function ledgerEntryToRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.amount.amount,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  };
}

/** A moeda do lançamento é a da wallet, que o chamador informa. */
export function ledgerEntryFromRow(row: WalletLedgerEntryRow, currency: string): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: oneOf(DIRECTIONS, row.direction, 'wallet_ledger_entries.direction'),
    amount: Money.rehydrate(row.amount, currency),
    balanceBefore: Money.rehydrate(row.balanceBefore, currency),
    balanceAfter: Money.rehydrate(row.balanceAfter, currency),
    createdAt: row.createdAt,
  });
}
