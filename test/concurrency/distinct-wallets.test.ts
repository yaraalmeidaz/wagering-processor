import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { betInput } from '../helpers/wager-input';
import { ledgerDirections, ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import { runInProcesses } from './support/run-workers';

// RN-31, RN-05; ADR-0003: wallets distintas em paralelo, em 4 processos, sem esperar o lock de outra wallet.
describe('wallets distintas processadas em paralelo', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('concurrency_distinct_wallets');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('3 wallets em 4 processos com uma quarta wallet travada: 48 débitos, nenhum transitório, ledger consistente', async () => {
    const uow = new MikroOrmUnitOfWork(db.orm.em);
    const wallets = [
      await seedWallet(uow, '100.00'),
      await seedWallet(uow, '100.00'),
      await seedWallet(uow, '100.00'),
    ];
    const locked = await seedWallet(uow, '100.00');

    // Outra sessão segura o lock de linha da quarta wallet durante todo o processamento.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = new MikroOrmUnitOfWork(db.orm.em.fork()).run(async ({ wallets: repo }) => {
      await repo.findByIdForUpdate(locked.id);
      signalLocked();
      await released;
    });
    await isLocked;

    let run: Awaited<ReturnType<typeof runInProcesses>>;
    try {
      // Cada processo recebe 4 apostas de 5,00 em cada wallet, intercaladas.
      run = await runInProcesses(
        db.name,
        Array.from({ length: 4 }, () =>
          Array.from({ length: 4 }, () => wallets.map((w) => betInput(w, '5.00'))).flat(),
        ),
      );
    } finally {
      release();
      await holder;
    }

    expect(new Set(run.pids).size).toBe(4);
    const values = run.outcomes.map((outcome) => {
      if (!outcome.ok) throw new Error(`${outcome.error}: ${outcome.message}`);
      return outcome.value;
    });
    expect(values).toHaveLength(48);
    expect(values.every((v) => v.status === 'PROCESSED')).toBe(true);

    for (const wallet of wallets) {
      const directions = await ledgerDirections(db, wallet.id);
      expect(directions.filter((d) => d === 'DEBIT')).toHaveLength(16);
      expect(await ledgerInvariant(db, wallet.id)).toEqual({
        stored: '20.00',
        reconstructed: '20.00',
        consistent: true,
      });
    }

    // A wallet travada não foi tocada e segue utilizável depois do release.
    expect(await ledgerInvariant(db, locked.id)).toEqual({
      stored: '100.00',
      reconstructed: '100.00',
      consistent: true,
    });
    const after = await new ProcessWagerTransaction({
      unitOfWork: new MikroOrmUnitOfWork(db.orm.em.fork()),
      clock: new SystemClock(),
    }).execute(betInput(locked, '5.00'));
    expect(after).toMatchObject({ status: 'PROCESSED', balance: { amount: '95.00' } });
    expect(await ledgerInvariant(db, locked.id)).toEqual({
      stored: '95.00',
      reconstructed: '95.00',
      consistent: true,
    });
  }, 60_000);
});
