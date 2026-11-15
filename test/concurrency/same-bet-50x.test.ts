import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { betInput } from '../helpers/wager-input';
import { ledgerDirections, ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import { runInProcesses } from './support/run-workers';

// SPEC 15.3 a; RN-20; ADR-0005: a mesma aposta 50 vezes, em 5 processos, gera um único débito.
describe('mesma aposta 50 vezes em paralelo', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('concurrency_same_bet');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('um débito, uma resposta nova e 49 replays com o mesmo snapshot', async () => {
    const wallet = await seedWallet(new MikroOrmUnitOfWork(db.orm.em), '100.00');
    const input = betInput(wallet, '10.00');

    const { pids, outcomes } = await runInProcesses(
      db.name,
      Array.from({ length: 5 }, () => Array.from({ length: 10 }, () => input)),
    );

    expect(new Set(pids).size).toBe(5);
    expect(outcomes).toHaveLength(50);
    const values = outcomes.map((outcome) => {
      if (!outcome.ok) throw new Error(`${outcome.error}: ${outcome.message}`);
      return outcome.value;
    });
    expect(values.every((v) => v.status === 'PROCESSED')).toBe(true);
    expect(values.filter((v) => !v.idempotentReplay)).toHaveLength(1);
    expect(new Set(values.map((v) => v.transactionId)).size).toBe(1);
    expect(new Set(values.map((v) => v.balance?.amount)).size).toBe(1);
    expect(values[0]?.balance?.amount).toBe('90.00');

    expect((await ledgerDirections(db, wallet.id)).filter((d) => d === 'DEBIT')).toHaveLength(1);
    const invariant = await ledgerInvariant(db, wallet.id);
    expect(invariant).toEqual({ stored: '90.00', reconstructed: '90.00', consistent: true });
  }, 60_000);
});
