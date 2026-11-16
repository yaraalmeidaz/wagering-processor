import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createTestQueues, drainQueue, type TestQueues } from '../helpers/sqs';
import { betInput } from '../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import { spawnWorker, startAt } from './support/processes';

const WORKER = new URL('./support/publisher-worker.ts', import.meta.url);

// Enunciado §13 item 6; SPEC 11.3 e 15.3 f; ADR-0006; AGENTS.md §2.9 (3 processos).
describe('três publishers concorrentes sobre o mesmo outbox', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase('conc_publishers');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    queues = await createTestQueues('publishers');
  });

  afterAll(async () => {
    await queues?.dispose();
    await db?.dispose();
  });

  test('ordem de seq por carteira, nenhum evento enviado duas vezes, agregado em backoff parado', async () => {
    const useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock: new SystemClock() });
    const wallets = [];
    for (let w = 0; w < 6; w++) {
      const wallet = await seedWallet(uow, '100.00');
      for (let b = 0; b < 4; b++) await useCase.execute(betInput(wallet, '1.00'));
      wallets.push(wallet);
    }
    // Carteira com o pendente mais antigo em backoff: nenhum evento dela pode sair.
    const blocked = await seedWallet(uow, '100.00');
    for (let b = 0; b < 2; b++) await useCase.execute(betInput(blocked, '1.00'));
    await db.execute(
      `UPDATE outbox_messages SET attempts = 1, next_attempt_at = now() + interval '1 hour'
        WHERE id = (SELECT id FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq LIMIT 1)`,
      [blocked.id],
    );

    const at = startAt();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        spawnWorker<{ pid: number; sent: string[] }>(WORKER, [
          db.name,
          queues.events,
          at,
          'normal',
        ]),
      ),
    );

    for (const result of results) expect(result.exitCode).toBe(0);
    expect(new Set(results.map((r) => r.pid)).size).toBe(3);
    const sent = results.flatMap((r) => r.output?.sent ?? []);
    // Nenhum evento recebeu ack duas vezes: não depende da deduplicação do SQS.
    expect(new Set(sent).size).toBe(sent.length);

    const rows = await db.execute(
      `SELECT id, aggregate_id, published_at FROM outbox_messages ORDER BY seq`,
    );
    const expected = rows.filter((row) => row['aggregate_id'] !== blocked.id);
    expect(expected).toHaveLength(48);
    expect(expected.every((row) => row['published_at'] !== null)).toBe(true);
    expect(
      rows
        .filter((row) => row['aggregate_id'] === blocked.id)
        .every((row) => row['published_at'] === null),
    ).toBe(true);
    expect(new Set(sent)).toEqual(new Set(expected.map((row) => String(row['id']))));

    // Ordem recebida por MessageGroupId igual à ordem de seq da carteira.
    const received = await drainQueue(queues.sqs, queues.events);
    expect(received).toHaveLength(48);
    for (const wallet of wallets) {
      const inQueue = received
        .filter((m) => m.Attributes?.['MessageGroupId'] === wallet.id)
        .map((m) => JSON.parse(String(m.Body)).eventId);
      const bySeq = expected
        .filter((row) => row['aggregate_id'] === wallet.id)
        .map((row) => row['id']);
      expect(inQueue).toEqual(bySeq);
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    }
  }, 60_000);
});
