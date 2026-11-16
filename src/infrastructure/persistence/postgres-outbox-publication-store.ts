import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  AggregateAttempt,
  OutboxPublicationStore,
} from '../../application/ports/outbox-publication-store';
import { OutboxMessage } from '../../domain/outbox-message';
import { translateDriverError } from './translate-driver-error';

interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: Date;
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly published_at: Date | null;
}

/** SQL da SPEC 11.3 (ADR-0006). Cada chamada usa um em.fork() novo (AGENTS.md §2.12). */
export class PostgresOutboxPublicationStore implements OutboxPublicationStore {
  readonly #orm: MikroORM;

  constructor(orm: MikroORM) {
    this.#orm = orm;
  }

  async dueAggregates(limit: number): Promise<string[]> {
    // Passo 1: o filtro de next_attempt_at vale só para o pendente mais antigo de cada agregado.
    const rows = await this.#run((em) =>
      em.execute(
        `SELECT aggregate_id
           FROM (
             SELECT DISTINCT ON (aggregate_id) aggregate_id, seq, next_attempt_at
               FROM outbox_messages
              WHERE published_at IS NULL
              ORDER BY aggregate_id, seq
           ) AS head
          WHERE head.next_attempt_at <= now()
          ORDER BY head.seq
          LIMIT ?`,
        [limit],
      ),
    );
    return rows.map((row) => String(row['aggregate_id']));
  }

  async withAggregate<T>(
    aggregateId: string,
    work: (
      head: OutboxMessage | null,
      save: (message: OutboxMessage) => Promise<void>,
    ) => Promise<T>,
  ): Promise<AggregateAttempt<T>> {
    return this.#run((root) =>
      root.transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '3000ms'`);
        // Passo 2a: o cast ::text é obrigatório; hashtext(uuid) não existe.
        const [lock] = await em.execute(
          'SELECT pg_try_advisory_xact_lock(hashtext(?::text)) AS locked',
          [aggregateId],
        );
        if (lock?.['locked'] !== true) return { locked: false } as const;

        // Passo 2b: sem filtro de next_attempt_at; quem decide é OutboxMessage.isDue.
        const [row] = (await em.execute(
          `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
             FROM outbox_messages
            WHERE aggregate_id = ? AND published_at IS NULL
            ORDER BY seq
            LIMIT 1
            FOR UPDATE`,
          [aggregateId],
        )) as OutboxRow[];
        const head = row === undefined ? null : messageOf(row);
        const save = async (message: OutboxMessage) => {
          // Passos 2d e 2e: published_at só depois do ack; senão, attempts e next_attempt_at.
          await em.execute(
            `UPDATE outbox_messages
                SET attempts = ?, next_attempt_at = ?, published_at = ?
              WHERE id = ? AND published_at IS NULL`,
            [message.attempts, message.nextAttemptAt, message.publishedAt, message.id],
          );
        };
        return { locked: true, value: await work(head, save) } as const;
      }),
    );
  }

  async oldestPendingOccurredAt(): Promise<Date | null> {
    const [row] = await this.#run((em) =>
      em.execute(
        `SELECT min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
      ),
    );
    const oldest = row?.['oldest'];
    return oldest === null || oldest === undefined ? null : new Date(String(oldest));
  }

  async #run<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await work(this.#orm.em.fork() as EntityManager);
    } catch (error) {
      throw translateDriverError(error);
    }
  }
}

function messageOf(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: new Date(row.next_attempt_at),
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
  });
}
