import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRecord, OutboxRepository } from '../../../application/ports/outbox-repository';
import { OutboxMessageOrmEntity } from '../entities/OutboxMessageOrmEntity';
import type { TransactionScope } from '../transaction-scope';

/** Só INSERT nesta fase. O seq é atribuído pelo banco (bigserial, ADR-0006). */
export class MikroOrmOutboxRepository implements OutboxRepository {
  readonly #em: EntityManager;
  readonly #scope: TransactionScope;

  constructor(em: EntityManager, scope: TransactionScope) {
    this.#em = em;
    this.#scope = scope;
  }

  async append(record: OutboxRecord): Promise<void> {
    this.#scope.assertActive();
    await this.#em.insert(OutboxMessageOrmEntity, {
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: 0,
      // Elegível para publicação a partir do momento em que ocorreu.
      nextAttemptAt: record.occurredAt,
      publishedAt: null,
    });
  }
}
