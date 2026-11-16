import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { payloadHash } from '../../../src/application/payload-hash';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { type HttpApp, startHttpApp } from '../../helpers/http-app';
import { ledgerInvariant } from '../../helpers/wallet-seed';

// SPEC 9.2 e 13; ADR-0005, ADR-0009; RN-04, RN-19 a RN-23, RN-39.
describe('HTTP: /wagering/transactions', () => {
  let db: TestDatabase;
  let http: HttpApp;

  /** Invariante final (SPEC 15.4; AGENTS.md §9): saldo gravado igual ao reconstruído pelo ledger. */
  const expectLedgerConsistent = async (walletId: string, amount: string) =>
    expect(await ledgerInvariant(db, walletId)).toEqual({
      stored: amount,
      reconstructed: amount,
      consistent: true,
    });

  const newWallet = async (amount: string) => {
    const playerId = crypto.randomUUID();
    const response = await http.call('POST', '/wallets', {
      body: { playerId, initialBalance: { amount, currency: 'BRL' } },
    });
    return { walletId: String(response.body['walletId']), playerId };
  };

  const wager = (
    wallet: { walletId: string; playerId: string },
    overrides: Record<string, unknown> = {},
  ) => {
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    return {
      providerId: 'provider-1',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    };
  };

  const post = (body: Record<string, unknown>, key?: string) =>
    http.call('POST', '/wagering/transactions', {
      body,
      headers:
        key === undefined
          ? {
              'Idempotency-Key': `${String(body['providerId'])}:${String(body['externalTransactionId'])}`,
            }
          : key === ''
            ? {}
            : { 'Idempotency-Key': key },
    });

  beforeAll(async () => {
    db = await createTestDatabase('http_wagering');
    await db.orm.migrator.up();
    http = await startHttpApp(db.orm);
  });

  afterAll(async () => {
    await http?.close();
    await db?.dispose();
  });

  test('transação nova PROCESSED: 201 com balance em string e idempotentReplay false', async () => {
    const wallet = await newWallet('100.00');
    const response = await post(wager(wallet));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(typeof response.body['transactionId']).toBe('string');
    await expectLedgerConsistent(wallet.walletId, '90.00');
  });

  test('replay: 200 com o mesmo corpo e idempotentReplay true (RN-20)', async () => {
    const wallet = await newWallet('100.00');
    const body = wager(wallet);
    const first = await post(body);
    await post(wager(wallet, { money: { amount: '5.00', currency: 'BRL' } }));

    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectLedgerConsistent(wallet.walletId, '85.00');
  });

  test('mesma chave com payload divergente: 409 IDEMPOTENCY_PAYLOAD_MISMATCH (RN-21)', async () => {
    const wallet = await newWallet('100.00');
    const body = wager(wallet);
    await post(body);

    const conflict = await post({ ...body, money: { amount: '11.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body['code']).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(conflict.body['failureCode']).toBeUndefined();
    await expectLedgerConsistent(wallet.walletId, '90.00');
  });

  test('mesmo par com chave diferente: 409 IDEMPOTENCY_KEY_CONFLICT (RN-22)', async () => {
    const wallet = await newWallet('100.00');
    const body = wager(wallet);
    await post(body);
    const conflict = await post(body, 'outra-chave');
    expect(conflict.status).toBe(409);
    expect(conflict.body['code']).toBe('IDEMPOTENCY_KEY_CONFLICT');
    await expectLedgerConsistent(wallet.walletId, '90.00');
  });

  test('Idempotency-Key ausente: 400 MISSING_IDEMPOTENCY_KEY (RN-23)', async () => {
    const wallet = await newWallet('10.00');
    const response = await post(wager(wallet), '');
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test('referência ausente: 202 PENDING_REFERENCE, e o replay também é 202 (SPEC 9.2)', async () => {
    const wallet = await newWallet('10.00');
    const body = wager(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-futura' });

    const first = await post(body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });

    const replay = await post(body);
    expect(replay.status).toBe(202);
    expect(replay.body['idempotentReplay']).toBe(true);
    await expectLedgerConsistent(wallet.walletId, '10.00');
  });

  test('rejeição de negócio: 422 com status REJECTED e failureCode (RN-19)', async () => {
    const wallet = await newWallet('5.00');
    const response = await post(wager(wallet, { money: { amount: '10.00', currency: 'BRL' } }));
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '5.00', currency: 'BRL' },
    });
    await expectLedgerConsistent(wallet.walletId, '5.00');
  });

  test.each([
    ['valor como number', { money: { amount: 10, currency: 'BRL' } }],
    ['valor com 3 casas', { money: { amount: '1.000', currency: 'BRL' } }],
    ['valor em notação científica', { money: { amount: '1e3', currency: 'BRL' } }],
    ['kind OPENING (enunciado §6.3; RN-04)', { kind: 'OPENING' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
  ])('%s: 400 INVALID_PAYLOAD', async (_, overrides) => {
    const wallet = await newWallet('10.00');
    const response = await post(wager(wallet, overrides));
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('INVALID_PAYLOAD');
  });

  test('JSON malformado: 400 INVALID_PAYLOAD', async () => {
    const response = await http.call('POST', '/wagering/transactions', {
      rawBody: '{"kind": ',
      headers: { 'Idempotency-Key': 'qualquer' },
    });
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('INVALID_PAYLOAD');
  });

  test('wallet inexistente: 404 WALLET_NOT_FOUND, nada gravado (RN-39)', async () => {
    const wallet = await newWallet('10.00');
    const body = wager({ ...wallet, walletId: crypto.randomUUID() });
    const response = await post(body);
    expect(response.status).toBe(404);
    expect(response.body['code']).toBe('WALLET_NOT_FOUND');
  });

  test('erro transitório: 503 TRANSIENT_FAILURE com Retry-After (SPEC 5.9)', async () => {
    const wallet = await newWallet('10.00');
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const holder = new MikroOrmUnitOfWork(db.orm.em).run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.walletId);
      signal();
      await released;
    });
    await locked;
    try {
      const response = await post(wager(wallet));
      expect(response.status).toBe(503);
      expect(response.body['code']).toBe('TRANSIENT_FAILURE');
      expect(response.headers.get('retry-after')).toBe('1');
    } finally {
      release();
      await holder;
    }
    await expectLedgerConsistent(wallet.walletId, '10.00');
  }, 15_000);

  test('replay de FAILED: POST 500 TRANSACTION_FAILED sem failureCode e sem Retry-After; GET 200 com status FAILED (SPEC 9.2; ADR-0005)', async () => {
    const wallet = await newWallet('10.00');
    const body = wager(wallet);
    const transactionId = crypto.randomUUID();
    // Inserida direto no banco: o resolvedor de pendências, que produz FAILED, ainda não existe.
    // FAILED não tem failure_code nem resulting_balance (SPEC 3.3; RN-40).
    await db.execute(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', now())`,
      [
        transactionId,
        body.providerId,
        body.externalTransactionId,
        `${body.providerId}:${body.externalTransactionId}`,
        payloadHash(body),
        wallet.walletId,
        wallet.playerId,
        body.roundId,
        body.gameId,
        body.kind,
        body.money.amount,
        body.money.currency,
      ],
    );

    const replay = await post(body);
    expect(replay.status).toBe(500);
    expect(replay.body).toEqual({
      code: 'TRANSACTION_FAILED',
      message: expect.any(String),
      transactionId,
    });
    expect(replay.body).not.toHaveProperty('failureCode');
    expect(replay.headers.get('retry-after')).toBeNull();

    const byId = await http.call('GET', `/wagering/transactions/${transactionId}`);
    const byExternal = await http.call(
      'GET',
      `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
    );
    for (const found of [byId, byExternal]) {
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        transactionId,
        status: 'FAILED',
        failureCode: null,
        resultingBalance: null,
      });
      expect(found.headers.get('retry-after')).toBeNull();
    }

    // O replay não aplica efeito: saldo e ledger ficam como estavam (RN-20).
    const balance = await http.call('GET', `/wallets/${wallet.walletId}`);
    expect(balance.body['balance']).toEqual({ amount: '10.00', currency: 'BRL' });
    const entries = await db.execute(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [transactionId],
    );
    expect(entries[0]?.['n']).toBe(0);
    await expectLedgerConsistent(wallet.walletId, '10.00');
  });

  describe('consultas', () => {
    test('GET /wagering/transactions/:id e GET /providers/:p/wagering/transactions/:ext', async () => {
      const wallet = await newWallet('100.00');
      const body = wager(wallet);
      const created = await post(body);
      const transactionId = String(created.body['transactionId']);

      const byId = await http.call('GET', `/wagering/transactions/${transactionId}`);
      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({
        transactionId,
        providerId: 'provider-1',
        externalTransactionId: body.externalTransactionId,
        kind: 'BET',
        status: 'PROCESSED',
        money: { amount: '10.00', currency: 'BRL' },
        resultingBalance: { amount: '90.00', currency: 'BRL' },
      });

      const byExternal = await http.call(
        'GET',
        `/providers/provider-1/wagering/transactions/${body.externalTransactionId}`,
      );
      expect(byExternal.status).toBe(200);
      expect(byExternal.body['transactionId']).toBe(transactionId);
      await expectLedgerConsistent(wallet.walletId, '90.00');
    });

    test('transação inexistente: 404 TRANSACTION_NOT_FOUND nas duas consultas', async () => {
      const byId = await http.call('GET', `/wagering/transactions/${crypto.randomUUID()}`);
      expect(byId.status).toBe(404);
      expect(byId.body['code']).toBe('TRANSACTION_NOT_FOUND');
      const byExternal = await http.call(
        'GET',
        '/providers/provider-1/wagering/transactions/nao-existe',
      );
      expect(byExternal.status).toBe(404);
      expect(byExternal.body['code']).toBe('TRANSACTION_NOT_FOUND');
    });
  });
});
