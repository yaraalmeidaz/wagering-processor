import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import {
  attemptsById,
  eventsById,
  ledgerEntriesById,
  pendingFactory,
  spawnResolvers,
  statusById,
} from './support/pending-reference-fixtures';

// SPEC 8.2; ADR-0007; AGENTS.md §2.9 e §9 (worker morto após commit).
const DIE_AFTER = 10;

describe('resolvedor morto no meio da fila e retomada', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('conc_pending_reference_restart');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('SIGKILL depois do COMMIT do 10º item; três processos retomam sem crédito nem evento duplicado', async () => {
    const factory = pendingFactory(uow);
    const wallets = [];
    const items = [];
    for (let w = 0; w < 6; w += 1) {
      const wallet = await seedWallet(uow, '100.00');
      wallets.push(wallet);
      for (let r = 0; r < 5; r += 1) items.push(await factory.reversal(wallet, '3.00'));
    }
    for (const item of items) await factory.betArrives(item, '3.00');
    const ids = items.map((item) => item.id);

    // 1. Um processo sozinho morre com SIGKILL logo depois do COMMIT do 10º PROCESSED.
    const [killed] = await spawnResolvers(db, [`die-after:${DIE_AFTER}`]);
    expect(killed?.signalCode).toBe('SIGKILL');
    expect(killed?.output).toBeNull();
    const afterKill = await statusById(db, ids);
    const done = ids.filter((id) => afterKill.get(id) === 'PROCESSED');
    const left = ids.filter((id) => afterKill.get(id) === 'PENDING_REFERENCE');
    expect(done).toHaveLength(DIE_AFTER);
    expect(left).toHaveLength(items.length - DIE_AFTER);

    // 2. Três processos retomam a fila: só as restantes são processadas.
    const runs = await spawnResolvers(db, ['normal', 'normal', 'normal']);
    for (const run of runs) expect(run.exitCode, run.stderr).toBe(0);
    const outputs = runs.map((run) => {
      if (run.output === null) throw new Error(`processo ${run.pid} sem saída: ${run.stderr}`);
      return run.output;
    });
    const attempts = attemptsById(outputs);
    for (const id of left) {
      expect((attempts.get(id) ?? []).filter((o) => o === 'PROCESSED')).toHaveLength(1);
    }
    // As já processadas não são candidatas de novo.
    for (const id of done) expect(attempts.get(id)).toBeUndefined();

    // 3. Um crédito e um par de eventos por transação, nem mais nem menos.
    const final = await statusById(db, ids);
    const ledger = await ledgerEntriesById(db, ids);
    const events = await eventsById(db, ids);
    for (const id of ids) {
      expect(final.get(id)).toBe('PROCESSED');
      expect(ledger.get(id)).toBe(1);
      expect(events.get(`${id}/WagerTransactionProcessed`)).toBe(1);
      expect(events.get(`${id}/WalletBalanceChanged`)).toBe(1);
    }
    for (const wallet of wallets) {
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    }
  }, 60_000);
});
