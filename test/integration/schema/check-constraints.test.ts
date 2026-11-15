import { afterAll, beforeAll, describe, test } from 'bun:test';
import { createTestDatabase, expectSqlState, type TestDatabase } from '../../helpers/database';
import { insertTransaction, insertWallet } from '../../helpers/schema-fixtures';

// AGENTS.md §2.4; SPEC 1.4 e 12.
describe('CHECKs e UNIQUEs do schema', () => {
  let db: TestDatabase;
  let walletId: string;

  beforeAll(async () => {
    db = await createTestDatabase('schema_checks');
    await db.orm.migrator.up();
    walletId = await insertWallet(db);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('saldo negativo na wallet falha pelo CHECK (RN-03)', async () => {
    await expectSqlState(insertWallet(db, { balance: '-0.01' }), '23514');
  });

  test('versão da wallet menor que 1 falha pelo CHECK (RN-03)', async () => {
    await expectSqlState(insertWallet(db, { version: 0 }), '23514');
  });

  test('saldo negativo pelo UPDATE também falha', async () => {
    await expectSqlState(
      db.execute(`UPDATE wallets SET balance_amount = '-1.00' WHERE id = ?`, [walletId]),
      '23514',
    );
  });

  test('PROCESSED sem resulting_balance falha pelo CHECK (RN-20)', async () => {
    await expectSqlState(
      insertTransaction(db, { walletId, kind: 'BET', status: 'PROCESSED', resultingBalance: null }),
      '23514',
    );
  });

  test.each(['REFUND', 'ROLLBACK'])(
    '%s sem referência falha pelo CHECK (RN-08, RN-09)',
    async (kind) => {
      await expectSqlState(insertTransaction(db, { walletId, kind, status: 'PENDING' }), '23514');
    },
  );

  test('kind fora da lista falha pelo CHECK', async () => {
    await expectSqlState(
      insertTransaction(db, { walletId, kind: 'DEPOSIT', status: 'PENDING' }),
      '23514',
    );
  });

  test('mesmo (provider_id, external_transaction_id) duas vezes falha pelo UNIQUE (RN-22)', async () => {
    await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'PENDING',
      externalTransactionId: 'dup-1',
    });
    await expectSqlState(
      insertTransaction(db, {
        walletId,
        kind: 'BET',
        status: 'PENDING',
        externalTransactionId: 'dup-1',
      }),
      '23505',
    );
  });

  test('wallet duplicada para (player_id, currency) falha pelo UNIQUE (RN-03)', async () => {
    const playerId = crypto.randomUUID();
    const insert = () =>
      db.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', '0.00', 1, now(), now())`,
        [crypto.randomUUID(), playerId],
      );
    await insert();
    await expectSqlState(insert(), '23505');
  });
});
