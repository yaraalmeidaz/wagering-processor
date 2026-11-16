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
type PublisherOutput = { pid: number; sent: string[] };

// Enunciado §13 item 8; SPEC 11.5 (recuperação obrigatória); ADR-0006.
describe('publisher morto entre o ack do SQS e o COMMIT', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase('conc_publisher_restart');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    queues = await createTestQueues('restart');
  });

  afterAll(async () => {
    await queues?.dispose();
    await db?.dispose();
  });

  test('outra instância assume, o evento é publicado e a duplicata não causa dano', async () => {
    const useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock: new SystemClock() });
    const wallets = [];
    for (let w = 0; w < 3; w++) {
      const wallet = await seedWallet(uow, '100.00');
      for (let b = 0; b < 2; b++) await useCase.execute(betInput(wallet, '1.00'));
      wallets.push(wallet);
    }

    // 1-2. Commit confirmado; o publisher morre depois do ack e antes de gravar published_at.
    const killed = await spawnWorker<PublisherOutput>(WORKER, [
      db.name,
      queues.events,
      startAt(0),
      'die-after-send',
    ]);
    expect(killed.signalCode).toBe('SIGKILL');
    expect(killed.output).toBeNull();
    const pending = await db.execute(
      `SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(pending[0]?.['n']).toBe(12);

    // 3-4. Outras três instâncias assumem e publicam tudo.
    const at = startAt();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        spawnWorker<PublisherOutput>(WORKER, [db.name, queues.events, at, 'normal']),
      ),
    );
    for (const result of results) expect(result.exitCode).toBe(0);
    const sent = results.flatMap((r) => r.output?.sent ?? []);
    expect(sent).toHaveLength(12);

    const rows = await db.execute(
      `SELECT id, aggregate_id, published_at FROM outbox_messages ORDER BY seq`,
    );
    expect(rows.every((row) => row['published_at'] !== null)).toBe(true);

    // 5. O evento enviado pelo processo morto foi reenviado, e o SQS FIFO descartou a repetição
    // pelo MessageDeduplicationId = eventId: uma mensagem por evento, na ordem de seq.
    const received = await drainQueue(queues.sqs, queues.events);
    expect(received).toHaveLength(12);
    expect(new Set(received.map((m) => JSON.parse(String(m.Body)).eventId)).size).toBe(12);
    for (const wallet of wallets) {
      const inQueue = received
        .filter((m) => m.Attributes?.['MessageGroupId'] === wallet.id)
        .map((m) => JSON.parse(String(m.Body)).eventId);
      expect(inQueue).toEqual(
        rows.filter((row) => row['aggregate_id'] === wallet.id).map((row) => row['id']),
      );
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    }
  }, 60_000);
});
