import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { Money } from '../../../src/domain/money';
import { WagerTransaction } from '../../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { seedWallet } from '../../helpers/wallet-seed';

// RN-30; ADR-0006: o evento é gravado no outbox na mesma transação do efeito.
describe('OutboxRepository na unidade de trabalho', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.execute(sql, params))[0]?.['n'] ?? -1);

  beforeAll(async () => {
    db = await createTestDatabase('persistence_outbox');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  const message = (aggregateId: string) => ({
    id: crypto.randomUUID(),
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: { aggregateId, data: { amount: '1.00' } },
    occurredAt: new Date(),
  });

  test('append grava a mensagem pendente, com seq atribuído pelo banco', async () => {
    const wallet = await seedWallet(uow, '1.00');
    await uow.run(({ outbox }) => outbox.append(message(wallet.id)));

    const rows = await db.execute(
      `SELECT seq::text AS seq, published_at, attempts, next_attempt_at = occurred_at AS due
         FROM outbox_messages WHERE aggregate_id = ?`,
      [wallet.id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.['seq'])).toBeGreaterThan(0);
    expect(rows[0]?.['published_at']).toBeNull();
    expect(rows[0]?.['attempts']).toBe(0);
    expect(rows[0]?.['due']).toBe(true);
  });

  test('falha depois do insert na outbox desfaz outbox, wallet e ledger juntos', async () => {
    const before = await seedWallet(uow, '10.00');
    const now = new Date();
    const bet = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider-1',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      idempotencyKey: `key-${crypto.randomUUID()}`,
      payloadHash: 'a'.repeat(64),
      walletId: before.id,
      playerId: before.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: Money.create('4.00', 'BRL'),
      referenceExternalTransactionId: null,
      createdAt: now,
    });
    const debit = before.debit(bet.money, {
      entryId: crypto.randomUUID(),
      transactionId: bet.id,
      now,
    });
    if (!debit.ok || debit.entry === null) throw new Error('esperava débito');
    bet.markProcessed(debit.balanceAfter, now);
    const entry = debit.entry;

    await expect(
      uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        await transactions.add(bet);
        await wallets.update(before, 1);
        await ledger.append(entry);
        await outbox.append(message(before.id));
        throw new Error('falha depois da outbox');
      }),
    ).rejects.toThrow('falha depois da outbox');

    expect(
      await count(`SELECT count(*)::int AS n FROM wager_transactions WHERE id = ?`, [bet.id]),
    ).toBe(0);

    expect(
      await count(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ?`, [
        before.id,
      ]),
    ).toBe(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE id = ?`, [entry.id]),
    ).toBe(0);
    const rows = await db.execute(
      `SELECT balance_amount::text AS balance, version FROM wallets WHERE id = ?`,
      [before.id],
    );
    expect(rows[0]).toEqual({ balance: '10.00', version: 1 });
  });
});
