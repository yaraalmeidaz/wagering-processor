import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransientFailureError } from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// Enunciado §11 (inbox na transação do efeito); SPEC 5.7 d e 10.2; ADR-0010; RN-20.
describe('inbox na transação do caso de uso', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let useCase: ProcessWagerTransaction;

  const inbox = (messageId: string) =>
    InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId,
      payloadHash: 'c'.repeat(64),
      now: new Date(),
    });

  const inboxRows = (messageId: string) =>
    db.execute(
      `SELECT consumer_name, processed_at IS NOT NULL AS processed
         FROM inbox_messages WHERE message_id = ?`,
      [messageId],
    );

  const debits = async (walletId: string) =>
    (
      await db.execute(
        `SELECT count(*)::int AS n FROM wallet_ledger_entries
          WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [walletId],
      )
    )[0]?.['n'];

  beforeAll(async () => {
    db = await createTestDatabase('messaging_inbox');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock: new SystemClock() });
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('grava a linha do inbox já processada, no mesmo commit do efeito', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const messageId = crypto.randomUUID();

    const result = await useCase.execute({ ...betInput(wallet, '10.00'), inbox: inbox(messageId) });

    expect(result.status).toBe('PROCESSED');
    expect(await inboxRows(messageId)).toEqual([
      { consumer_name: 'wager-transactions', processed: true },
    ]);
    expect(await debits(wallet.id)).toBe(1);
  });

  test('redelivery: a mesma mensagem duas vezes gera um único efeito (RN-20)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const messageId = crypto.randomUUID();
    const input = betInput(wallet, '10.00');

    const first = await useCase.execute({ ...input, inbox: inbox(messageId) });
    const second = await useCase.execute({ ...input, inbox: inbox(messageId) });

    expect(second.transactionId).toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(true);
    expect(await inboxRows(messageId)).toHaveLength(1);
    expect(await debits(wallet.id)).toBe(1);
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('mesmo messageId com outra chave não aplica segundo efeito (ADR-0010)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const messageId = crypto.randomUUID();
    await useCase.execute({ ...betInput(wallet, '10.00'), inbox: inbox(messageId) });

    // Mesmo messageId, outra transação: o PRIMARY KEY do inbox impede o segundo efeito.
    await expect(
      useCase.execute({ ...betInput(wallet, '10.00'), inbox: inbox(messageId) }),
    ).rejects.toBeInstanceOf(TransientFailureError);

    expect(await debits(wallet.id)).toBe(1);
    const balance = await db.execute(`SELECT balance_amount::text AS b FROM wallets WHERE id = ?`, [
      wallet.id,
    ]);
    expect(balance[0]?.['b']).toBe('90.00');
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('atomicidade: se o efeito falha depois do INSERT do inbox, a linha do inbox não fica', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const messageId = crypto.randomUUID();
    // Falha real do PostgreSQL no INSERT do outbox desta wallet, depois do inbox e do lançamento.
    await db.execute(`
      CREATE OR REPLACE FUNCTION fail_outbox_for_test() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'falha provocada pelo teste';
      END;
      $$ LANGUAGE plpgsql`);
    await db.execute(
      `CREATE TRIGGER trg_fail_outbox_for_test BEFORE INSERT ON outbox_messages
         FOR EACH ROW WHEN (NEW.aggregate_id = '${wallet.id}'::uuid)
         EXECUTE FUNCTION fail_outbox_for_test()`,
    );
    try {
      await expect(
        useCase.execute({ ...betInput(wallet, '10.00'), inbox: inbox(messageId) }),
      ).rejects.toThrow();
    } finally {
      await db.execute('DROP TRIGGER trg_fail_outbox_for_test ON outbox_messages');
    }

    expect(await inboxRows(messageId)).toEqual([]);
    expect(await debits(wallet.id)).toBe(0);
    const transactions = await db.execute(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [wallet.id],
    );
    expect(transactions[0]?.['n']).toBe(0);
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('entrada HTTP, sem inbox, não grava inbox', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const before = await db.execute(`SELECT count(*)::int AS n FROM inbox_messages`);
    await useCase.execute(betInput(wallet, '10.00'));
    const after = await db.execute(`SELECT count(*)::int AS n FROM inbox_messages`);
    expect(after[0]?.['n']).toBe(before[0]?.['n']);
  });
});
