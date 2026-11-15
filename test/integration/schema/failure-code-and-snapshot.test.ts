import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, expectSqlState, type TestDatabase } from '../../helpers/database';
import { insertTransaction, insertWallet } from '../../helpers/schema-fixtures';

describe('failure_code só em REJECTED (RN-40)', () => {
  let db: TestDatabase;
  let walletId: string;

  beforeAll(async () => {
    db = await createTestDatabase('schema_failure_code');
    await db.orm.migrator.up();
    walletId = await insertWallet(db);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test.each(['PROCESSED', 'PENDING', 'PENDING_REFERENCE', 'FAILED'])(
    'failure_code em %s falha pelo CHECK',
    async (status) => {
      await expectSqlState(
        insertTransaction(db, {
          walletId,
          kind: 'BET',
          status,
          failureCode: 'INSUFFICIENT_FUNDS',
          resultingBalance: status === 'PROCESSED' ? '75.00' : null,
        }),
        '23514',
      );
    },
  );

  test('UPDATE que preenche failure_code em PROCESSED falha pelo CHECK', async () => {
    const id = await insertTransaction(db, { walletId, kind: 'BET', status: 'PROCESSED' });
    await expectSqlState(
      db.execute(`UPDATE wager_transactions SET failure_code = 'INSUFFICIENT_FUNDS' WHERE id = ?`, [
        id,
      ]),
      '23514',
    );
  });

  test('failure_code em REJECTED é aceito (RN-19)', async () => {
    await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  test('REJECTED sem failure_code falha pelo CHECK (RN-19)', async () => {
    await expectSqlState(
      insertTransaction(db, { walletId, kind: 'BET', status: 'REJECTED', failureCode: null }),
      '23514',
    );
  });
});

describe('resulting_balance imutável depois de PROCESSED ou REJECTED (RN-20)', () => {
  let db: TestDatabase;
  let walletId: string;

  const setSnapshot = (id: string, value: string) =>
    db.execute(`UPDATE wager_transactions SET resulting_balance = ? WHERE id = ?`, [value, id]);

  beforeAll(async () => {
    db = await createTestDatabase('schema_snapshot');
    await db.orm.migrator.up();
    walletId = await insertWallet(db);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('UPDATE de resulting_balance em PROCESSED falha pelo trigger', async () => {
    const id = await insertTransaction(db, { walletId, kind: 'BET', status: 'PROCESSED' });
    const message = await expectSqlState(setSnapshot(id, '10.00'), 'P0001');
    expect(message).toContain('resulting_balance');
  });

  test('o mesmo UPDATE com o mesmo valor também falha', async () => {
    const id = await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'PROCESSED',
      resultingBalance: '75.00',
    });
    await expectSqlState(setSnapshot(id, '75.00'), 'P0001');
    const rows = await db.execute(
      `SELECT resulting_balance::text AS snapshot FROM wager_transactions WHERE id = ?`,
      [id],
    );
    expect(rows).toEqual([{ snapshot: '75.00' }]);
  });

  test('UPDATE de resulting_balance em REJECTED falha pelo trigger', async () => {
    const id = await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      resultingBalance: '75.00',
    });
    const message = await expectSqlState(setSnapshot(id, '10.00'), 'P0001');
    expect(message).toContain('resulting_balance');
  });

  test('o mesmo UPDATE com o mesmo valor em REJECTED também falha', async () => {
    const id = await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      resultingBalance: '75.00',
    });
    await expectSqlState(setSnapshot(id, '75.00'), 'P0001');
    const rows = await db.execute(
      `SELECT resulting_balance::text AS snapshot FROM wager_transactions WHERE id = ?`,
      [id],
    );
    expect(rows).toEqual([{ snapshot: '75.00' }]);
  });

  test('a transição PENDING -> PROCESSED grava o snapshot normalmente', async () => {
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
    const rows = await db.execute(
      `SELECT status, resulting_balance::text AS snapshot FROM wager_transactions WHERE id = ?`,
      [id],
    );
    expect(rows).toEqual([{ status: 'PROCESSED', snapshot: '75.00' }]);
  });
});
