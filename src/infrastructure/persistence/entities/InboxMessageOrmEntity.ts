import { defineEntity, p } from '@mikro-orm/core';

/** Tabela inbox_messages (SPEC 12). Repositório e domínio entram com a mensageria. */
export const InboxMessageOrmSchema = defineEntity({
  name: 'InboxMessageOrmEntity',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.string().columnType('char(64)'),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export class InboxMessageOrmEntity extends InboxMessageOrmSchema.class {}
InboxMessageOrmSchema.setClass(InboxMessageOrmEntity);
