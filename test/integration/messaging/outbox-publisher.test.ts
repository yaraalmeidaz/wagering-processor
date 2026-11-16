import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import {
  OutboxPublisher,
  type PublisherOptions,
} from '../../../src/infrastructure/messaging/outbox-publisher';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { PostgresOutboxPublicationStore } from '../../../src/infrastructure/persistence/postgres-outbox-publication-store';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { SystemClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { createTestQueues, drainQueue, type TestQueues } from '../../helpers/sqs';
import { betInput } from '../../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// Enunciado §11; SPEC 11.3 a 11.5; ADR-0006; RN-30.
describe('OutboxPublisher com LocalStack e PostgreSQL reais', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let queues: TestQueues;
  let useCase: ProcessWagerTransaction;
  const clock = new SystemClock();

  const publisherWith = (options: Partial<PublisherOptions> = {}) => {
    const metrics = new InMemoryMetrics();
    const lines: string[] = [];
    const publisher = new OutboxPublisher({
      store: new PostgresOutboxPublicationStore(db.orm),
      sqs: queues.sqs,
      eventsQueueUrl: queues.events,
      clock,
      metrics,
      sink: { write: (line) => lines.push(line) },
      random: () => 0.5,
      ...options,
    });
    return { publisher, metrics, lines };
  };

  /** Carteiras com apostas executadas no caso em andamento, conferidas no afterEach. */
  const walletsWithBets: string[] = [];

  /** Wallet com `bets` apostas: 2 eventos por aposta no outbox (o seedWallet não gera eventos). */
  const walletWithEvents = async (bets: number) => {
    const wallet = await seedWallet(uow, '100.00');
    for (let i = 0; i < bets; i++) await useCase.execute(betInput(wallet, '1.00'));
    walletsWithBets.push(wallet.id);
    return wallet;
  };

  const outboxOf = (walletId: string) =>
    db.execute(
      `SELECT id, attempts, published_at, next_attempt_at
         FROM outbox_messages WHERE aggregate_id = ? ORDER BY outbox_messages.seq`,
      [walletId],
    );

  /** Publica até não sobrar pendente devido. */
  const publishAll = async (publisher: OutboxPublisher) => {
    for (let i = 0; i < 50; i++) {
      if ((await publisher.publishOnce()).published === 0) return;
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase('messaging_publisher');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock });
    queues = await createTestQueues('publisher');
  });

  // Invariante final de todo caso (SPEC 15.4): wallet.balance == saldo reconstruído pelo ledger.
  afterEach(async () => {
    for (const walletId of walletsWithBets.splice(0)) {
      const invariant = await ledgerInvariant(db, walletId);
      expect(invariant.consistent).toBe(true);
      expect(invariant.stored).toBe(invariant.reconstructed);
    }
  });

  afterAll(async () => {
    await queues?.dispose();
    await db?.dispose();
  });

  test('publica em ordem de seq, com MessageGroupId = walletId e MessageDeduplicationId = eventId', async () => {
    const wallet = await walletWithEvents(3);
    const { publisher, metrics } = publisherWith();
    await publishAll(publisher);

    const rows = await outboxOf(wallet.id);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row['published_at'] !== null)).toBe(true);
    const messages = await drainQueue(queues.sqs, queues.events);
    expect(messages.map((m) => String(m.Attributes?.['MessageGroupId']))).toEqual(
      rows.map(() => wallet.id),
    );
    expect(messages.map((m) => String(m.Attributes?.['MessageDeduplicationId']))).toEqual(
      rows.map((row) => String(row['id'])),
    );
    expect(messages.map((m) => JSON.parse(String(m.Body)).eventId)).toEqual(
      rows.map((row) => row['id']),
    );
    expect(metrics.value('outbox_published_total')).toBe(6);
  });

  test('published_at só é gravado depois do ack do SendMessage (SPEC 11.3, passo 2d)', async () => {
    const wallet = await walletWithEvents(1);
    const seenAfterSend: unknown[] = [];
    const { publisher } = publisherWith({
      hooks: {
        afterSend: async (message: OutboxMessage) => {
          // Outra conexão: o ack já chegou, mas o COMMIT ainda não.
          const row = await db.execute(`SELECT published_at FROM outbox_messages WHERE id = ?`, [
            message.id,
          ]);
          seenAfterSend.push(row[0]?.['published_at']);
        },
      },
    });
    await publishAll(publisher);

    expect(seenAfterSend).toEqual([null, null]);
    expect((await outboxOf(wallet.id)).every((row) => row['published_at'] !== null)).toBe(true);
    await drainQueue(queues.sqs, queues.events);
  });

  test('falha no envio: sem published_at, attempts + 1 e nova tentativa com backoff (ADR-0006)', async () => {
    const wallet = await walletWithEvents(1);
    const before = Date.now();
    const { publisher, metrics } = publisherWith({
      eventsQueueUrl: `${queues.events}-inexistente`,
    });
    await publisher.publishOnce();

    const [first, second] = await outboxOf(wallet.id);
    expect(first?.['published_at']).toBeNull();
    expect(first?.['attempts']).toBe(1);
    const wait = new Date(String(first?.['next_attempt_at'])).getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(2_000);
    expect(wait).toBeLessThan(3_000);
    // O evento seguinte da mesma carteira não sai antes do anterior.
    expect(second?.['attempts']).toBe(0);
    expect(second?.['published_at']).toBeNull();
    expect(metrics.value('outbox_publish_failures_total')).toBe(1);
  });

  test('pendente mais antigo em backoff: o agregado não publica nenhum evento (SPEC 11.3, passo 1)', async () => {
    const blocked = await walletWithEvents(2);
    const free = await walletWithEvents(1);
    const [head] = await outboxOf(blocked.id);
    await db.execute(
      `UPDATE outbox_messages SET next_attempt_at = now() + interval '1 hour', attempts = 1 WHERE id = ?`,
      [head?.['id']],
    );

    const { publisher } = publisherWith();
    await publishAll(publisher);

    expect((await outboxOf(blocked.id)).every((row) => row['published_at'] === null)).toBe(true);
    expect((await outboxOf(free.id)).every((row) => row['published_at'] !== null)).toBe(true);
    const groups = (await drainQueue(queues.sqs, queues.events)).map(
      (m) => m.Attributes?.['MessageGroupId'],
    );
    expect(groups).not.toContain(blocked.id);
    await db.execute(`UPDATE outbox_messages SET published_at = now() WHERE aggregate_id = ?`, [
      blocked.id,
    ]);
  });

  test('advisory lock por agregado: outro publisher com o lock faz este pular a carteira (ADR-0006)', async () => {
    const locked = await walletWithEvents(1);
    const free = await walletWithEvents(1);

    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const holder = db.orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT pg_try_advisory_xact_lock(hashtext(?::text))', [locked.id]);
      signal();
      await released;
    });
    await holding;
    try {
      const { publisher } = publisherWith();
      await publishAll(publisher);
      expect((await outboxOf(locked.id)).every((row) => row['published_at'] === null)).toBe(true);
      expect((await outboxOf(free.id)).every((row) => row['published_at'] !== null)).toBe(true);
    } finally {
      release();
      await holder;
    }
    const { publisher } = publisherWith();
    await publishAll(publisher);
    expect((await outboxOf(locked.id)).every((row) => row['published_at'] !== null)).toBe(true);
    await drainQueue(queues.sqs, queues.events);
  });

  test('12 falhas: segue pendente, tenta no teto e conta o esgotamento (ADR-0006)', async () => {
    const wallet = await walletWithEvents(1);
    const [head] = await outboxOf(wallet.id);
    await db.execute(`UPDATE outbox_messages SET attempts = 11 WHERE id = ?`, [head?.['id']]);
    const { publisher, metrics, lines } = publisherWith({
      eventsQueueUrl: `${queues.events}-inexistente`,
    });
    const before = Date.now();
    await publisher.publishOnce();

    const [after] = await outboxOf(wallet.id);
    expect(after?.['attempts']).toBe(12);
    expect(after?.['published_at']).toBeNull();
    const wait = new Date(String(after?.['next_attempt_at'])).getTime() - before;
    expect(wait).toBeGreaterThan(290_000);
    expect(wait).toBeLessThanOrEqual(301_000);
    expect(metrics.value('outbox_retry_exhausted_total')).toBe(1);
    const record = lines
      .map((line) => JSON.parse(line))
      .find((r) => r.event === 'outbox_retry_exhausted');
    expect(record).toMatchObject({ eventId: head?.['id'], aggregateId: wallet.id, attempts: 12 });
    await db.execute(`UPDATE outbox_messages SET published_at = now() WHERE aggregate_id = ?`, [
      wallet.id,
    ]);
  });

  test('outbox lag: idade do pendente mais antigo, em segundos (SPEC 11.4)', async () => {
    const wallet = await walletWithEvents(1);
    await db.execute(
      `UPDATE outbox_messages SET occurred_at = now() - interval '90 seconds', next_attempt_at = now() + interval '1 hour' WHERE aggregate_id = ?`,
      [wallet.id],
    );
    const { publisher, metrics } = publisherWith();
    await publisher.publishOnce();
    expect(metrics.value('outbox_lag_seconds')).toBeGreaterThanOrEqual(90);
    expect(metrics.value('outbox_lag_seconds')).toBeLessThan(120);
    await db.execute(`UPDATE outbox_messages SET published_at = now() WHERE aggregate_id = ?`, [
      wallet.id,
    ]);
  });
});
