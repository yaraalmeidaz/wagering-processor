import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { betInput } from '../helpers/wager-input';
import { ledgerDirections, ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import { runInProcesses } from './support/run-workers';

// RN-03, RN-05, RN-31: 40 apostas distintas de 7,00 em 4 processos sobre saldo de 100,00.
describe('saldo nunca negativo sob disputa', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('concurrency_no_negative');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('14 débitos, 26 INSUFFICIENT_FUNDS, saldo final 2,00 e ledger consistente', async () => {
    const wallet = await seedWallet(new MikroOrmUnitOfWork(db.orm.em), '100.00');

    const { pids, outcomes } = await runInProcesses(
      db.name,
      Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => betInput(wallet, '7.00'))),
    );

    expect(new Set(pids).size).toBe(4);
    const values = outcomes.map((outcome) => {
      if (!outcome.ok) throw new Error(`${outcome.error}: ${outcome.message}`);
      return outcome.value;
    });
    expect(values.filter((v) => v.status === 'PROCESSED')).toHaveLength(14);
    const rejected = values.filter((v) => v.status === 'REJECTED');
    expect(rejected).toHaveLength(26);
    expect(rejected.every((v) => v.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(values.every((v) => !v.balance?.amount.startsWith('-'))).toBe(true);

    expect((await ledgerDirections(db, wallet.id)).filter((d) => d === 'DEBIT')).toHaveLength(14);
    const invariant = await ledgerInvariant(db, wallet.id);
    expect(invariant).toEqual({ stored: '2.00', reconstructed: '2.00', consistent: true });
  }, 60_000);
});
