import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PermanentDataError } from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { Money } from '../../../src/domain/money';
import { WagerTransaction } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';

// SPEC 8.2; RN-12; RN-41; ADR-0007: busca de pendências vencidas, releitura sob lock,
// adiamento com CAS, FAILED da pendência e tradução de erro permanente.
const brl = (amount: string): Money => Money.create(amount, 'BRL');
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
const HOUR = 3_600_000;

describe('consultas de PENDING_REFERENCE (SPEC 8.2)', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('pending_reference_queries');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  async function seedWallet(): Promise<Wallet> {
    const { wallet } = Wallet.create({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      currency: 'BRL',
      initialBalance: brl('100.00'),
      opening: { entryId: crypto.randomUUID(), transactionId: crypto.randomUUID() },
      now: ago(2 * HOUR),
    });
    await uow.run(({ wallets }) => wallets.add(wallet));
    return wallet;
  }

  function rollback(
    wallet: Wallet,
    nextAttemptAt: Date,
    overrides: { id?: string; walletId?: string } = {},
  ): WagerTransaction {
    const externalTransactionId = `rb-${crypto.randomUUID()}`;
    const tx = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider-1',
      externalTransactionId,
      idempotencyKey: `provider-1:${externalTransactionId}`,
      payloadHash: 'a'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'ROLLBACK',
      money: brl('10.00'),
      referenceExternalTransactionId: `bet-${crypto.randomUUID()}`,
      createdAt: ago(HOUR),
      ...overrides,
    });
    tx.markPendingReference(nextAttemptAt);
    return tx;
  }

  async function save(...transactions: WagerTransaction[]): Promise<void> {
    await uow.run(async ({ transactions: repository }) => {
      for (const tx of transactions) await repository.add(tx);
    });
  }

  /** Terminais com next_reference_attempt_at no passado: só o status as exclui. */
  function terminals(wallet: Wallet): WagerTransaction[] {
    const processed = rollback(wallet, ago(HOUR));
    processed.markProcessed(brl('110.00'), new Date());
    const rejected = rollback(wallet, ago(HOUR));
    rejected.reject('REFERENCE_NOT_FOUND', brl('100.00'), new Date());
    const failed = rollback(wallet, ago(HOUR));
    failed.markFailed(new Date());
    return [processed, rejected, failed];
  }

  test('candidatas: só pendências vencidas, pela ordem de next_reference_attempt_at (RN-12)', async () => {
    const wallet = await seedWallet();
    const older = rollback(wallet, ago(120_000));
    const newer = rollback(wallet, ago(1_000));
    const notDue = rollback(wallet, ahead(HOUR));
    const done = terminals(wallet);
    await save(newer, notDue, older, ...done);

    const candidates = await uow.run(({ transactions }) =>
      transactions.findDueReferenceCandidates(50),
    );
    const mine = candidates.filter((candidate) => candidate.walletId === wallet.id);
    expect(mine).toEqual([
      { id: older.id, walletId: wallet.id },
      { id: newer.id, walletId: wallet.id },
    ]);
    const ids = candidates.map((candidate) => candidate.id);
    expect(ids).not.toContain(notDue.id);
    for (const terminal of done) expect(ids).not.toContain(terminal.id);
  });

  test('candidatas: respeita o tamanho do lote (SPEC 8.2)', async () => {
    const wallet = await seedWallet();
    // Mais antigas que qualquer outra pendência deste arquivo, para ocupar o lote.
    const first = rollback(wallet, new Date('2001-01-01T00:00:00.000Z'));
    const second = rollback(wallet, new Date('2001-01-01T00:00:01.000Z'));
    const third = rollback(wallet, new Date('2001-01-01T00:00:02.000Z'));
    await save(third, first, second);

    const candidates = await uow.run(({ transactions }) =>
      transactions.findDueReferenceCandidates(2),
    );
    expect(candidates.map((candidate) => candidate.id)).toEqual([first.id, second.id]);
  });

  test('releitura sob lock: devolve a vencida e recusa a não vencida e as terminais (SPEC 8.2)', async () => {
    const wallet = await seedWallet();
    const due = rollback(wallet, ago(1_000));
    const notDue = rollback(wallet, ahead(HOUR));
    const done = terminals(wallet);
    await save(due, notDue, ...done);

    const found = await uow.run(async ({ wallets, transactions }) => {
      await wallets.findByIdForUpdate(wallet.id);
      return {
        due: await transactions.findDuePendingForUpdate(due.id),
        notDue: await transactions.findDuePendingForUpdate(notDue.id),
        done: await Promise.all(done.map((tx) => transactions.findDuePendingForUpdate(tx.id))),
      };
    });
    expect(found.due?.id).toBe(due.id);
    expect(found.due?.status).toBe('PENDING_REFERENCE');
    expect(found.due?.attempts).toBe(0);
    expect(found.notDue).toBeNull();
    expect(found.done).toEqual([null, null, null]);
  });

  test('releitura sob lock: SKIP LOCKED pula a linha travada por outro worker sem esperar', async () => {
    const wallet = await seedWallet();
    const due = rollback(wallet, ago(1_000));
    await save(due);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = uow.run(async ({ wallets, transactions }) => {
      await wallets.findByIdForUpdate(wallet.id);
      const row = await transactions.findDuePendingForUpdate(due.id);
      locked();
      await held;
      return row;
    });

    try {
      await isLocked;
      const started = Date.now();
      // Sem o lock da wallet, para observar só o SKIP LOCKED da linha.
      const skipped = await uow.run(({ transactions }) =>
        transactions.findDuePendingForUpdate(due.id),
      );
      expect(skipped).toBeNull();
      // lock_timeout é 3000 ms (ADR-0003): bem abaixo disso, não houve espera.
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      release();
    }
    expect((await holder)?.id).toBe(due.id);
  });

  test('adiamento com CAS: muda só next_reference_attempt_at e não consome tentativa (ADR-0007)', async () => {
    const wallet = await seedWallet();
    const due = rollback(wallet, ago(1_000));
    await save(due);
    const later = ahead(4_000);

    const postponed = await uow.run(({ transactions }) =>
      transactions.postponeReferenceAttempt(due, later),
    );
    expect(postponed).toBe(true);

    const reloaded = await uow.run(({ transactions }) => transactions.findById(due.id));
    expect(reloaded?.status).toBe('PENDING_REFERENCE');
    expect(reloaded?.attempts).toBe(0);
    expect(reloaded?.nextReferenceAttemptAt).toEqual(later);
    const candidates = await uow.run(({ transactions }) =>
      transactions.findDueReferenceCandidates(50),
    );
    expect(candidates.map((candidate) => candidate.id)).not.toContain(due.id);
  });

  test('adiamento com CAS: recusa leitura desatualizada e linha terminal (ADR-0007)', async () => {
    const wallet = await seedWallet();
    const stale = rollback(wallet, ago(1_000));
    await save(stale);
    // Outro worker fez a tentativa e reagendou depois da leitura de `stale`.
    const current = await uow.run(({ transactions }) => transactions.findById(stale.id));
    if (current === null) throw new Error('esperava a pendência');
    current.scheduleNextReferenceAttempt(ago(500));
    await uow.run(({ transactions }) => transactions.update(current));

    const [processed] = terminals(wallet);
    if (processed === undefined) throw new Error('esperava terminal');
    await save(processed);

    const result = await uow.run(async ({ transactions }) => ({
      stale: await transactions.postponeReferenceAttempt(stale, ahead(4_000)),
      terminal: await transactions.postponeReferenceAttempt(processed, ahead(4_000)),
    }));
    expect(result).toEqual({ stale: false, terminal: false });

    const reloaded = await uow.run(({ transactions }) => transactions.findById(stale.id));
    expect(reloaded?.attempts).toBe(1);
    expect(reloaded?.nextReferenceAttemptAt).toEqual(current.nextReferenceAttemptAt);
  });
  async function status(id: string) {
    const [found] = await db.execute(
      `SELECT status, failure_code, processed_at FROM wager_transactions WHERE id = ?`,
      [id],
    );
    return {
      status: String(found?.['status']),
      failureCode: found?.['failure_code'] ?? null,
      processedAt: found?.['processed_at'] ?? null,
    };
  }

  test('FAILED da pendência: sem failureCode, mesmo com linha que o domínio não reidrata (RN-40, RN-41)', async () => {
    const wallet = await seedWallet();
    const pending = rollback(wallet, ago(1_000));
    await save(pending);
    // Dado gravado que o domínio recusa: moeda fora do padrão ISO-4217.
    await db.execute(`UPDATE wager_transactions SET currency = 'br1' WHERE id = ?`, [pending.id]);
    await expect(
      uow.run(({ transactions }) => transactions.findById(pending.id)),
    ).rejects.toThrow();

    const failed = await uow.run(({ transactions }) =>
      transactions.markPendingReferenceFailed(pending.id, new Date()),
    );
    expect(failed).toBe(true);
    const after = await status(pending.id);
    expect(after.status).toBe('FAILED');
    expect(after.failureCode).toBeNull();
    expect(after.processedAt).not.toBeNull();
  });

  test('FAILED da pendência: linha terminal não muda (RN-25)', async () => {
    const wallet = await seedWallet();
    const done = terminals(wallet);
    await save(...done);
    const before = await Promise.all(done.map((tx) => status(tx.id)));

    const results = await uow.run(async ({ transactions }) =>
      Promise.all(done.map((tx) => transactions.markPendingReferenceFailed(tx.id, new Date()))),
    );
    expect(results).toEqual([false, false, false]);
    expect(await Promise.all(done.map((tx) => status(tx.id)))).toEqual(before);
  });

  test('classes 22 e 23 do PostgreSQL viram PermanentDataError (ADR-0007)', async () => {
    const wallet = await seedWallet();
    // 23503: wallet inexistente.
    const orphan = rollback(wallet, ago(1_000), { walletId: crypto.randomUUID() });
    await expect(uow.run(({ transactions }) => transactions.add(orphan))).rejects.toBeInstanceOf(
      PermanentDataError,
    );
    // 22P02: id que não é uuid.
    const invalid = rollback(wallet, ago(1_000), { id: 'não-é-uuid' });
    await expect(uow.run(({ transactions }) => transactions.add(invalid))).rejects.toBeInstanceOf(
      PermanentDataError,
    );
  });
});
