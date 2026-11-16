import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/application/events';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { CreateWallet } from '../../../src/application/use-cases/create-wallet';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { FakeClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// SPEC 11.2; RN-04, RN-28. Os casos de uso montam WalletBalanceChanged só pelo from.
describe('WalletBalanceChanged vem de WalletBalanceChanged.from nos casos de uso', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let clock: FakeClock;

  /** Invariante final (SPEC 15.4; AGENTS.md §9): saldo gravado igual ao reconstruído pelo ledger. */
  const expectLedgerConsistent = async (walletId: string, amount: string) =>
    expect(await ledgerInvariant(db, walletId)).toEqual({
      stored: amount,
      reconstructed: amount,
      consistent: true,
    });
  // Observa a implementação real: o evento continua sendo criado pelo from.
  const from = spyOn(WalletBalanceChanged, 'from');

  /** Payload gravado no outbox para o WalletBalanceChanged da wallet. */
  const storedPayloads = async (walletId: string) =>
    (
      await db.execute(
        `SELECT payload FROM outbox_messages
          WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged' ORDER BY seq`,
        [walletId],
      )
    ).map((row) => row['payload']);

  beforeAll(async () => {
    db = await createTestDatabase('usecase_event_from');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    from.mockClear();
  });

  afterAll(async () => {
    from.mockRestore();
    await db?.dispose();
  });

  test('CreateWallet: o OPENING grava no outbox o evento produzido pelo from (RN-04)', async () => {
    const wallet = await new CreateWallet({ unitOfWork: uow, clock }).execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    expect(from).toHaveBeenCalledTimes(1);
    const [walletArg, entryArg] = from.mock.calls[0] ?? [];
    expect(walletArg?.id).toBe(wallet.id);
    expect(entryArg?.balanceBefore.amount).toBe('0.00');
    const produced = from.mock.results[0]?.value as WalletBalanceChanged;
    expect(await storedPayloads(wallet.id)).toEqual([produced.toJSON()]);
    await expectLedgerConsistent(wallet.id, '100.00');
  });

  test('ProcessWagerTransaction: o BET grava no outbox o evento produzido pelo from (RN-28)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock, random: () => 0.5 });

    await useCase.execute(betInput(wallet, '30.00'));

    expect(from).toHaveBeenCalledTimes(1);
    const [walletArg, entryArg] = from.mock.calls[0] ?? [];
    expect(walletArg?.id).toBe(wallet.id);
    expect(entryArg?.balanceBefore.amount).toBe('100.00');
    expect(entryArg?.balanceAfter.amount).toBe('70.00');
    const produced = from.mock.results[0]?.value as WalletBalanceChanged;
    // seedWallet grava o OPENING direto, sem caso de uso: só o evento do BET está no outbox.
    expect(await storedPayloads(wallet.id)).toEqual([produced.toJSON()]);
    await expectLedgerConsistent(wallet.id, '70.00');
  });
});
