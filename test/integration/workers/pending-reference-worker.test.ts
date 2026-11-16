import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet';
import { OutboxPublisher } from '../../../src/infrastructure/messaging/outbox-publisher';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { PostgresOutboxPublicationStore } from '../../../src/infrastructure/persistence/postgres-outbox-publication-store';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { FakeClock, SystemClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { createTestQueues, drainQueue, type TestQueues } from '../../helpers/sqs';
import { betInput } from '../../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// SPEC 8.2; ADR-0007 (decisão E): o processo real do worker, com PostgreSQL e LocalStack.
const MAIN = new URL(
  '../../../src/infrastructure/workers/pending-reference.main.ts',
  import.meta.url,
);

describe('worker de PENDING_REFERENCE (processo separado)', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase('worker_pending_reference');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    queues = await createTestQueues('pendingref');
  });

  afterAll(async () => {
    await queues?.dispose();
    await db?.dispose();
  });

  function spawnMain() {
    return Bun.spawn([process.execPath, MAIN.pathname], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, POSTGRES_DB: db.name },
    });
  }

  async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('condição não atingida no prazo');
      await Bun.sleep(50);
    }
  }

  async function statuses(ids: readonly string[]) {
    const rows = await db.execute(
      `SELECT id, status, attempts FROM wager_transactions WHERE id IN (?) ORDER BY next_reference_attempt_at`,
      [ids],
    );
    return new Map(rows.map((r) => [String(r['id']), `${r['status']}/${r['attempts']}`]));
  }

  /** Esperando lock de linha de wallets neste banco (pg_stat_activity). */
  async function workerWaitsForWalletLock(): Promise<boolean> {
    const [row] = await db.execute(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = ? AND wait_event_type = 'Lock' AND query ILIKE '%from "wallets"%'`,
      [db.name],
    );
    return Number(row?.['n']) > 0;
  }

  test('SIGTERM no meio do lote termina o item em andamento, sai com 0 e o reinício trata o resto', async () => {
    // Pendências em ordem de next_reference_attempt_at, todas já vencidas.
    const clock = new FakeClock(new Date(Date.now() - 600_000));
    const processor = new ProcessWagerTransaction({ unitOfWork: uow, clock, random: () => 0.5 });
    const main = await seedWallet(uow, '100.00');
    const blocked = await seedWallet(uow, '100.00');
    const rollback = async (wallet: Wallet) => {
      clock.advance(1_000);
      const betId = `bet-${crypto.randomUUID()}`;
      const pending = await processor.execute(
        betInput(wallet, '10.00', { kind: 'ROLLBACK', referenceExternalTransactionId: betId }),
      );
      expect(pending.status).toBe('PENDING_REFERENCE');
      return { id: pending.transactionId, wallet, betId };
    };
    const before = [await rollback(main), await rollback(main), await rollback(main)];
    const middle = await rollback(blocked);
    const after = [await rollback(main), await rollback(main), await rollback(main)];
    const all = [...before, middle, ...after];
    // As BETs chegam depois: toda pendência agora encontra a referência.
    for (const item of all) {
      await processor.execute(
        betInput(item.wallet, '10.00', { externalTransactionId: item.betId }),
      );
    }

    // Trava a wallet da pendência do meio, para o worker parar nela.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = uow.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(blocked.id);
      locked();
      await held;
    });
    await isLocked;

    const first = spawnMain();
    try {
      await waitUntil(async () => {
        const state = await statuses(before.map((b) => b.id));
        return [...state.values()].every((s) => s.startsWith('PROCESSED'));
      });
      await waitUntil(workerWaitsForWalletLock);
      first.kill('SIGTERM');
      // Dá tempo de o sinal chegar enquanto o item do meio ainda espera o lock.
      await Bun.sleep(200);
    } finally {
      release();
    }
    await holder;
    expect(await first.exited).toBe(0);

    const afterStop = await statuses(all.map((a) => a.id));
    expect(afterStop.get(middle.id)).toBe('PROCESSED/0');
    for (const item of after) expect(afterStop.get(item.id)).toBe('PENDING_REFERENCE/0');

    // Evento só do que foi commitado: o publisher não vê nada das pendências não tratadas.
    const publisher = new OutboxPublisher({
      store: new PostgresOutboxPublicationStore(db.orm),
      sqs: queues.sqs,
      eventsQueueUrl: queues.events,
      clock: new SystemClock(),
      metrics: new InMemoryMetrics(),
      sink: { write: () => {} },
    });
    const publishAll = async () => {
      for (let round = 0; round < 50; round += 1) {
        const { published } = await publisher.publishOnce();
        if (published === 0) return;
      }
    };
    await publishAll();
    const firstBodies = (await drainQueue(queues.sqs, queues.events)).map((m) => m.Body ?? '');
    const processedFor = (bodies: string[], id: string) =>
      bodies.filter((body) => body.includes(id) && body.includes('WagerTransactionProcessed'))
        .length;
    for (const item of [...before, middle]) expect(processedFor(firstBodies, item.id)).toBe(1);
    for (const item of after) expect(processedFor(firstBodies, item.id)).toBe(0);

    // Reinício: o estado está todo no banco, e o novo processo trata o resto.
    const second = spawnMain();
    await waitUntil(async () => {
      const state = await statuses(after.map((a) => a.id));
      return [...state.values()].every((s) => s.startsWith('PROCESSED'));
    });
    second.kill('SIGTERM');
    expect(await second.exited).toBe(0);

    await publishAll();
    const secondBodies = (await drainQueue(queues.sqs, queues.events)).map((m) => m.Body ?? '');
    for (const item of after) expect(processedFor(secondBodies, item.id)).toBe(1);
    for (const item of [...before, middle]) expect(processedFor(secondBodies, item.id)).toBe(0);

    // Cada ROLLBACK creditou uma única vez.
    const credits = await db.execute(
      `SELECT transaction_id, count(*)::int AS n FROM wallet_ledger_entries
        WHERE transaction_id IN (?) GROUP BY transaction_id`,
      [all.map((a) => a.id)],
    );
    expect(credits).toHaveLength(all.length);
    for (const credit of credits) expect(credit['n']).toBe(1);
    for (const wallet of [main, blocked]) {
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    }
  }, 60_000);

  test('sem pendência vencida, o processo fica ocioso e sai com 0 no SIGTERM', async () => {
    const idle = spawnMain();
    await Bun.sleep(1_500);
    const started = Date.now();
    idle.kill('SIGTERM');
    expect(await idle.exited).toBe(0);
    // A espera ociosa de 1 s é interrompida pelo SIGTERM.
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 15_000);
});
