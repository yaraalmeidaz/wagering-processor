import { defineEntity, p } from '@mikro-orm/core';

/** Tabela outbox_messages (SPEC 12; ADR-0006). Repositório e domínio entram com a mensageria. */
export const OutboxMessageOrmSchema = defineEntity({
  name: 'OutboxMessageOrmEntity',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    // bigserial: o banco atribui o valor no INSERT; lido como string para não perder precisão.
    seq: p.bigint('string').columnType('bigserial').persist(false),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz'),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export class OutboxMessageOrmEntity extends OutboxMessageOrmSchema.class {}
OutboxMessageOrmSchema.setClass(OutboxMessageOrmEntity);
