import { defineEntity, p } from '@mikro-orm/core';

/** Tabela wager_transactions (SPEC 12). Valores em NUMERIC(19,2), lidos como string (ADR-0002). */
export const WagerTransactionOrmSchema = defineEntity({
  name: 'WagerTransactionOrmEntity',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.string().columnType('char(64)'),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.decimal('string').precision(19).scale(2),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    resultingBalance: p.decimal('string').precision(19).scale(2).nullable(),
    attempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export class WagerTransactionOrmEntity extends WagerTransactionOrmSchema.class {}
WagerTransactionOrmSchema.setClass(WagerTransactionOrmEntity);
