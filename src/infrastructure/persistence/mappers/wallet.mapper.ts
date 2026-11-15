import { Money } from '../../../domain/money';
import { Wallet } from '../../../domain/wallet';
import type { WalletOrmEntity } from '../entities/WalletOrmEntity';

export type WalletRow = Pick<
  WalletOrmEntity,
  'id' | 'playerId' | 'currency' | 'balanceAmount' | 'version' | 'createdAt' | 'updatedAt'
>;

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.rehydrate(row.balanceAmount, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
