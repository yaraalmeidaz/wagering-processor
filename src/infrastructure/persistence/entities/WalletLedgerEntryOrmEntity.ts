import { defineEntity, p } from '@mikro-orm/core';

/** Tabela wallet_ledger_entries (SPEC 12). Append-only no banco (RN-36). */
export const WalletLedgerEntryOrmSchema = defineEntity({
  name: 'WalletLedgerEntryOrmEntity',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.decimal('string').precision(19).scale(2),
    balanceBefore: p.decimal('string').precision(19).scale(2),
    balanceAfter: p.decimal('string').precision(19).scale(2),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});

export class WalletLedgerEntryOrmEntity extends WalletLedgerEntryOrmSchema.class {}
WalletLedgerEntryOrmSchema.setClass(WalletLedgerEntryOrmEntity);
