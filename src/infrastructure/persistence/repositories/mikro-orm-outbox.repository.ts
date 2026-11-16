import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRecord, OutboxRepository } from '../../../application/ports/outbox-repository';
import { OutboxMessage } from '../../../domain/outbox-message';
import { OutboxMessageOrmEntity } from '../entities/OutboxMessageOrmEntity';
import type { TransactionScope } from '../transaction-scope';

/** INSERT na transação do efeito (RN-30). O seq é atribuído pelo banco (bigserial, ADR-0006). */
export class MikroOrmOutboxRepository implements OutboxRepository {
  readonly #em: EntityManager;
  readonly #scope: TransactionScope;

  constructor(em: EntityManager, scope: TransactionScope) {
    this.#em = em;
    this.#scope = scope;
  }

  async append(record: OutboxRecord): Promise<void> {
    this.#scope.assertActive();
    // Pendente, sem tentativas, devido a partir de quando ocorreu (OutboxMessage.enqueue).
    const message = OutboxMessage.enqueue(record);
    await this.#em.insert(OutboxMessageOrmEntity, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt,
    });
  }
}
