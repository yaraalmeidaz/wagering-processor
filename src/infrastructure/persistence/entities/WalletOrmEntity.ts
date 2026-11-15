import { defineEntity, p } from '@mikro-orm/core';

/** Tabela wallets (SPEC 12). Valores em NUMERIC(19,2), lidos como string (ADR-0002). */
export const WalletOrmSchema = defineEntity({
  name: 'WalletOrmEntity',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().columnType('char(3)'),
    balanceAmount: p.decimal('string').precision(19).scale(2),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export class WalletOrmEntity extends WalletOrmSchema.class {}
WalletOrmSchema.setClass(WalletOrmEntity);
