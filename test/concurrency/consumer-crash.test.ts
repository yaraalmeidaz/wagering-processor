import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
  createTestQueues,
  drainQueue,
  queueDepth,
  sendWagerMessage,
  type TestQueues,
  wagerMessage,
} from '../helpers/sqs';
import { betInput } from '../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import { spawnWorker, startAt } from './support/processes';

const WORKER = new URL('./support/consumer-worker.ts', import.meta.url);
type ConsumerOutput = { pid: number; duplicates: number };

// Enunciado §13 item 5; SPEC 10.5 e 15.3 e; ADR-0010; RN-20; AGENTS.md §2.9 (3 processos).
describe('consumer morto depois do COMMIT e antes do ack', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase('conc_consumer_crash');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    // Visibilidade curta: a mensagem do processo morto volta em 2 s.
    queues = await createTestQueues('crash', { visibilityTimeoutSeconds: 2 });
  });

  afterAll(async () => {
    await queues?.dispose();
    await db?.dispose();
  });

  test('a mensagem é reentregue e o efeito não duplica', async () => {
    const wallets = [];
    const keys: string[] = [];
    for (let w = 0; w < 4; w++) {
      const wallet = await seedWallet(uow, '100.00');
      wallets.push(wallet);
      for (let m = 0; m < 5; m++) {
        const { inbox: _inbox, correlationId: _correlationId, ...data } = betInput(wallet, '2.00');
        keys.push(data.idempotencyKey);
        await sendWagerMessage(queues.sqs, queues.input, wagerMessage(data), wallet.id);
      }
    }

    // O processo que morre recebe primeiro, para ter mensagem em andamento ao morrer. Os dois
    // sobreviventes partem juntos, enquanto as mensagens dele ainda estão invisíveis.
    const args = (at: string, mode: string) => [db.name, queues.input, queues.dlq, at, mode];
    const [killed, ...survivors] = await Promise.all([
      spawnWorker<ConsumerOutput>(WORKER, args(startAt(500), 'die-after-commit')),
      spawnWorker<ConsumerOutput>(WORKER, args(startAt(2_500), 'normal')),
      spawnWorker<ConsumerOutput>(WORKER, args(startAt(2_500), 'normal')),
    ]);

    expect(killed?.signalCode).toBe('SIGKILL');
    for (const survivor of survivors) expect(survivor.exitCode).toBe(0);
    // A mensagem commitada pelo processo morto voltou e foi reconhecida pelo inbox.
    expect(
      survivors.reduce((sum, s) => sum + (s.output?.duplicates ?? 0), 0),
    ).toBeGreaterThanOrEqual(1);

    const perKey = await db.execute(
      `SELECT idempotency_key, count(*)::int AS n FROM wager_transactions
        WHERE idempotency_key IN (?) GROUP BY idempotency_key`,
      [keys],
    );
    expect(perKey).toHaveLength(20);
    expect(perKey.every((row) => row['n'] === 1)).toBe(true);
    const inbox = await db.execute(`SELECT count(*)::int AS n FROM inbox_messages`);
    expect(inbox[0]?.['n']).toBe(20);

    for (const wallet of wallets) {
      const rows = await db.execute(
        `SELECT balance_amount::text AS b,
                (SELECT count(*)::int FROM wallet_ledger_entries
                  WHERE wallet_id = w.id AND direction = 'DEBIT') AS debits
           FROM wallets w WHERE id = ?`,
        [wallet.id],
      );
      expect(rows[0]).toEqual({ b: '90.00', debits: 5 });
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    }
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(await drainQueue(queues.sqs, queues.dlq)).toEqual([]);
  }, 60_000);
});
