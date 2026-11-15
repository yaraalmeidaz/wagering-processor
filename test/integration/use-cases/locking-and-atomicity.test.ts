import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../../src/application/errors';
import type { Repositories, UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { seedWallet } from '../../helpers/wallet-seed';

/** Conta as unidades de trabalho executadas sobre a porta real, sem substituir o banco. */
class CountingUnitOfWork implements UnitOfWork {
  runs = 0;
  readonly #inner: UnitOfWork;

  constructor(inner: UnitOfWork) {
    this.#inner = inner;
  }

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.runs += 1;
    return this.#inner.run(work);
  }
}

/** Segura o lock da wallet em outra sessão até `release()` (SPEC 5.5). */
function holdWalletLock(uow: UnitOfWork, walletId: string) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalLocked: () => void = () => {};
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const done = uow.run(async ({ wallets }) => {
    await wallets.findByIdForUpdate(walletId);
    signalLocked();
    await released;
  });
  return { locked, release, done };
}

describe('lock, fast-path e atomicidade do ProcessWagerTransaction', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let useCase: ProcessWagerTransaction;

  beforeAll(async () => {
    db = await createTestDatabase('usecase_locking');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock: new SystemClock() });
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('replay terminal responde pelo fast-path, sem esperar o lock da wallet (SPEC 5.4; ADR-0005)', async () => {
    const wallet = await seedWallet(uow, '10.00');
    const input = betInput(wallet, '1.00');
    await useCase.execute(input);

    const holder = holdWalletLock(new MikroOrmUnitOfWork(db.orm.em), wallet.id);
    await holder.locked;
    try {
      const replay = await useCase.execute(input);
      expect(replay).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
      // 409 de payload divergente também sai do fast-path, sem lock.
      await expect(
        useCase.execute({ ...input, money: { amount: '2.00', currency: 'BRL' } }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    } finally {
      holder.release();
      await holder.done;
    }
  }, 15_000);

  test('a wallet é travada antes da transação: sem deadlock com quem trava na mesma ordem (SPEC 8.2; ADR-0003)', async () => {
    const wallet = await seedWallet(uow, '10.00');
    const input = betInput(wallet, '5.00', {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'bet-que-nao-chega',
    });
    const pending = await useCase.execute(input);
    expect(pending.status).toBe('PENDING_REFERENCE');

    // Outra sessão trava a wallet e, depois, a linha da pendência (ordem da SPEC 8.2).
    let signalLocked: () => void = () => {};
    const walletLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const resolver = new MikroOrmUnitOfWork(db.orm.em).run(async ({ wallets, transactions }) => {
      await wallets.findByIdForUpdate(wallet.id);
      signalLocked();
      await Bun.sleep(400);
      await transactions.findByIdempotencyKey(input.idempotencyKey, { forUpdate: true });
    });
    await walletLocked;

    // O replay da pendência vai ao slow-path e precisa esperar a wallet antes de travar a transação.
    const replay = useCase.execute(input);
    const [resolverOutcome, replayOutcome] = await Promise.allSettled([resolver, replay]);

    expect(resolverOutcome.status).toBe('fulfilled');
    expect(replayOutcome.status).toBe('fulfilled');
    if (replayOutcome.status === 'fulfilled') {
      expect(replayOutcome.value).toMatchObject({
        status: 'PENDING_REFERENCE',
        idempotentReplay: true,
      });
    }
  }, 15_000);

  test('replay de PENDING_REFERENCE é decidido pela releitura sob o lock, sem depender do 23505 (SPEC 5.5)', async () => {
    const wallet = await seedWallet(uow, '10.00');
    const input = betInput(wallet, '5.00', {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'bet-ausente-m04',
    });
    await useCase.execute(input);

    const counting = new CountingUnitOfWork(new MikroOrmUnitOfWork(db.orm.em));
    const counted = new ProcessWagerTransaction({ unitOfWork: counting, clock: new SystemClock() });
    const replay = await counted.execute(input);

    expect(replay).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: true });
    // Fast-path (1) e slow-path (1). Sem a releitura sob o lock, o INSERT falharia
    // com 23505 e uma terceira unidade releria a linha (SPEC 5.9).
    expect(counting.runs).toBe(2);
  });

  test('falha no meio da unidade não deixa evento no outbox nem transação gravada (RN-30)', async () => {
    const wallet = await seedWallet(uow, '10.00');
    // Falha injetada no banco real: o INSERT do lançamento desta wallet é recusado.
    await db.execute(`
      CREATE FUNCTION fail_ledger_for_wallet() RETURNS trigger AS $$
      BEGIN
        IF NEW.wallet_id = '${wallet.id}' THEN
          RAISE EXCEPTION 'falha injetada no ledger';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db.execute(`
      CREATE TRIGGER trg_fail_ledger BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fail_ledger_for_wallet()`);
    try {
      const input = betInput(wallet, '3.00');
      await expect(useCase.execute(input)).rejects.toThrow('falha injetada no ledger');

      const count = async (sql: string) =>
        Number((await db.execute(sql, [wallet.id]))[0]?.['n'] ?? -1);
      expect(
        await count(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ?`),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
        ),
      ).toBe(0);
      const rows = await db.execute(
        `SELECT balance_amount::text AS balance, version FROM wallets WHERE id = ?`,
        [wallet.id],
      );
      expect(rows[0]).toEqual({ balance: '10.00', version: 1 });
    } finally {
      await db.execute(`DROP TRIGGER trg_fail_ledger ON wallet_ledger_entries`);
      await db.execute(`DROP FUNCTION fail_ledger_for_wallet()`);
    }
  });
});
