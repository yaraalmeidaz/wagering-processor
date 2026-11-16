import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/inbox-repository';
import { InboxMessage } from '../../../domain/inbox-message';
import { InboxMessageOrmEntity } from '../entities/InboxMessageOrmEntity';
import type { TransactionScope } from '../transaction-scope';

/** Inbox da fila (SPEC 12). A deduplicação é o PRIMARY KEY (consumer_name, message_id). */
export class MikroOrmInboxRepository implements InboxRepository {
  readonly #em: EntityManager;
  readonly #scope: TransactionScope;

  constructor(em: EntityManager, scope: TransactionScope) {
    this.#em = em;
    this.#scope = scope;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    this.#scope.assertActive();
    const row = await this.#em.findOne(
      InboxMessageOrmEntity,
      { consumerName, messageId },
      { disableIdentityMap: true },
    );
    return row === null
      ? null
      : InboxMessage.rehydrate({
          consumerName: row.consumerName,
          messageId: row.messageId,
          payloadHash: row.payloadHash,
          receivedAt: row.receivedAt,
          processedAt: row.processedAt ?? null,
        });
  }

  async add(message: InboxMessage): Promise<void> {
    this.#scope.assertActive();
    await this.#em.insert(InboxMessageOrmEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt,
    });
  }
}
