import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, expectSqlState, type TestDatabase } from '../../helpers/database';
import { insertTransaction, insertWallet } from '../../helpers/schema-fixtures';

// ADR-0004; SPEC 6.2 e 15.2.
describe('uq_wager_single_processed_reversal (RN-16)', () => {
  let db: TestDatabase;
  let walletId: string;

  beforeAll(async () => {
    db = await createTestDatabase('schema_reversal');
    await db.orm.migrator.up();
    walletId = await insertWallet(db);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('REFUND e ROLLBACK PROCESSED sobre a mesma BET: o segundo falha no índice', async () => {
    await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'PROCESSED',
      externalTransactionId: 'bet-1',
    });
    await insertTransaction(db, {
      walletId,
      kind: 'REFUND',
      status: 'PROCESSED',
      referenceExternalTransactionId: 'bet-1',
    });

    const message = await expectSqlState(
      insertTransaction(db, {
        walletId,
        kind: 'ROLLBACK',
        status: 'PROCESSED',
        referenceExternalTransactionId: 'bet-1',
      }),
      '23505',
    );
    expect(message).toContain('uq_wager_single_processed_reversal');
  });

  test('WIN com referência não ocupa o slot de reversão (RN-06)', async () => {
    await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'PROCESSED',
      externalTransactionId: 'bet-2',
    });
    await insertTransaction(db, {
      walletId,
      kind: 'WIN',
      status: 'PROCESSED',
      referenceExternalTransactionId: 'bet-2',
    });

    await insertTransaction(db, {
      walletId,
      kind: 'REFUND',
      status: 'PROCESSED',
      referenceExternalTransactionId: 'bet-2',
    });
  });

  test('reversão REJECTED não ocupa o slot', async () => {
    await insertTransaction(db, {
      walletId,
      kind: 'BET',
      status: 'PROCESSED',
      externalTransactionId: 'bet-3',
    });
    await insertTransaction(db, {
      walletId,
      kind: 'ROLLBACK',
      status: 'REJECTED',
      failureCode: 'REFERENCE_AMOUNT_MISMATCH',
      referenceExternalTransactionId: 'bet-3',
    });

    await insertTransaction(db, {
      walletId,
      kind: 'REFUND',
      status: 'PROCESSED',
      referenceExternalTransactionId: 'bet-3',
    });
  });
});
