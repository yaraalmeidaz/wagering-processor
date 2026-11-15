import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, expectSqlState, type TestDatabase } from '../../helpers/database';
import { insertTransaction, insertWallet } from '../../helpers/schema-fixtures';

// AGENTS.md §2.8; SPEC 12 (trg_ledger_append_only).
describe('wallet_ledger_entries append-only (RN-36)', () => {
  let db: TestDatabase;
  let walletId: string;
  let transactionId: string;

  const insertEntry = (before: string, amount: string, after: string, direction = 'DEBIT') =>
    db.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, now())`,
      [crypto.randomUUID(), walletId, transactionId, direction, amount, before, after],
    );

  beforeAll(async () => {
    db = await createTestDatabase('schema_ledger');
    await db.orm.migrator.up();
    walletId = await insertWallet(db, { balance: '75.00' });
    transactionId = await insertTransaction(db, { walletId, kind: 'BET', status: 'PROCESSED' });
    await insertEntry('100.00', '25.00', '75.00');
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('UPDATE falha pelo trigger', async () => {
    const message = await expectSqlState(
      db.execute(`UPDATE wallet_ledger_entries SET amount = '1.00' WHERE wallet_id = ?`, [
        walletId,
      ]),
      'P0001',
    );
    expect(message).toContain('append-only');
  });

  test('DELETE falha pelo trigger', async () => {
    const message = await expectSqlState(
      db.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]),
      'P0001',
    );
    expect(message).toContain('append-only');
  });

  test('saldo anterior ± valor diferente do saldo posterior falha pelo CHECK', async () => {
    await expectSqlState(insertEntry('100.00', '25.00', '80.00'), '23514');
  });

  test('segundo lançamento para a mesma (transação, wallet) falha pelo UNIQUE', async () => {
    await expectSqlState(insertEntry('75.00', '5.00', '70.00'), '23505');
  });

  test('o lançamento original continua intacto', async () => {
    const rows = await db.execute(
      `SELECT amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(rows).toEqual([{ amount: '25.00' }]);
  });
});
