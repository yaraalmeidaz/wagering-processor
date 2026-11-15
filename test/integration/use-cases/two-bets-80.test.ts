import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { ledgerDirections, ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// RN-32 (enunciado §8, Concorrência e ordenação): cenário obrigatório; SPEC, Parte 3, critério da Fase 4.
describe('duas BET de 80,00 em paralelo sobre saldo de 100,00', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('usecase_80x80');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('uma PROCESSED, uma REJECTED com INSUFFICIENT_FUNDS, saldo 20,00 e um único débito', async () => {
    const wallet = await seedWallet(new MikroOrmUnitOfWork(db.orm.em), '100.00');
    // Cada aposta com o próprio fork do EntityManager.
    const useCase = () =>
      new ProcessWagerTransaction({
        unitOfWork: new MikroOrmUnitOfWork(db.orm.em.fork()),
        clock: new SystemClock(),
      });

    const results = await Promise.all([
      useCase().execute(betInput(wallet, '80.00')),
      useCase().execute(betInput(wallet, '80.00')),
    ]);

    const byStatus = [...results].sort((a, b) => a.status.localeCompare(b.status));
    expect(byStatus.map((r) => r.status)).toEqual(['PROCESSED', 'REJECTED']);
    expect(byStatus[1]?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(byStatus[0]?.balance?.amount).toBe('20.00');

    const invariant = await ledgerInvariant(db, wallet.id);
    expect(invariant.stored).toBe('20.00');
    expect(invariant.consistent).toBe(true);
    expect((await ledgerDirections(db, wallet.id)).filter((d) => d === 'DEBIT')).toHaveLength(1);
  });
});
