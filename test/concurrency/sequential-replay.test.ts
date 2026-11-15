import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { betInput } from '../helpers/wager-input';
import { ledgerDirections, ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import { runInProcesses } from './support/run-workers';

// RN-20: replay sequencial, em 3 processos diferentes, devolve a resposta original.
describe('mesma aposta reenviada em sequência por processos diferentes', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('concurrency_sequential_replay');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('a primeira processa e as seguintes são replay equivalente, sem novo lançamento', async () => {
    const uow = new MikroOrmUnitOfWork(db.orm.em);
    const wallet = await seedWallet(uow, '50.00');
    const input = betInput(wallet, '5.00');

    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await runInProcesses(db.name, [[input]]));
      // Outra aposta entre os replays: o replay precisa devolver o saldo da época, não o atual.
      await runInProcesses(db.name, [[betInput(wallet, '1.00')]]);
    }

    expect(new Set(runs.map((run) => run.pids[0])).size).toBe(3);
    const values = runs.map((run) => {
      const outcome = run.outcomes[0];
      if (outcome === undefined || !outcome.ok) throw new Error('esperava resultado');
      return outcome.value;
    });
    expect(values.map((v) => v.idempotentReplay)).toEqual([false, true, true]);
    expect(values.every((v) => v.status === 'PROCESSED')).toBe(true);
    expect(values.map((v) => v.balance?.amount)).toEqual(['45.00', '45.00', '45.00']);
    expect(new Set(values.map((v) => v.transactionId)).size).toBe(1);

    expect((await ledgerDirections(db, wallet.id)).filter((d) => d === 'DEBIT')).toHaveLength(4);
    const invariant = await ledgerInvariant(db, wallet.id);
    expect(invariant).toEqual({ stored: '42.00', reconstructed: '42.00', consistent: true });
  }, 60_000);
});
