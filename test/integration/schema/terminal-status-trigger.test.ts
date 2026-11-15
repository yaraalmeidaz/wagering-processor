import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, expectSqlState, type TestDatabase } from '../../helpers/database';
import { insertTransaction, insertWallet } from '../../helpers/schema-fixtures';

// RN-25; SPEC 3.3 e 12 (trg_wager_terminal_status).
describe('trg_wager_terminal_status', () => {
  let db: TestDatabase;
  let walletId: string;

  const setStatus = (id: string, status: string) =>
    db.execute(`UPDATE wager_transactions SET status = ? WHERE id = ?`, [status, id]);

  beforeAll(async () => {
    db = await createTestDatabase('schema_terminal');
    await db.orm.migrator.up();
    walletId = await insertWallet(db);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test.each([
    ['PROCESSED', 'PENDING'],
    ['PROCESSED', 'REJECTED'],
    ['REJECTED', 'PROCESSED'],
    ['FAILED', 'PENDING_REFERENCE'],
  ])('%s -> %s falha pelo trigger', async (from, to) => {
    const id = await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: from,
      failureCode: from === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
      resultingBalance: from === 'FAILED' ? null : '75.00',
    });
    const message = await expectSqlState(setStatus(id, to), 'P0001');
    expect(message).toContain('estado terminal');
  });

  test('PENDING -> PROCESSED é permitido', async () => {
    const id = await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'PENDING',
      resultingBalance: null,
    });
    await db.execute(
      `UPDATE wager_transactions SET status = 'PROCESSED', resulting_balance = '75.00' WHERE id = ?`,
      [id],
    );
    const rows = await db.execute(`SELECT status FROM wager_transactions WHERE id = ?`, [id]);
    expect(rows).toEqual([{ status: 'PROCESSED' }]);
  });
});
