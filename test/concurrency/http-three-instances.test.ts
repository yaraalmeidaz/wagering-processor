import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { ledgerInvariant } from '../helpers/wallet-seed';
import {
  type HttpInstance,
  type HttpInstances,
  type HttpReply,
  startHttpInstances,
} from './support/http-instances';

// SPEC 15.3 b, a e d; ADR-0003; ADR-0004; ADR-0005; AGENTS.md §2.9: três processos HTTP reais
// sobre o mesmo PostgreSQL.
describe('três instâncias HTTP sobre o mesmo banco', () => {
  let db: TestDatabase;
  let api: HttpInstances;

  beforeAll(async () => {
    db = await createTestDatabase('conc_http_three_instances');
    await db.orm.migrator.up();
    api = await startHttpInstances(db.name, 3);
  }, 60_000);

  afterAll(async () => {
    await api?.stop();
    await db?.dispose();
  }, 30_000);

  const instance = (i: number): HttpInstance => {
    const found = api.instances[i % api.instances.length];
    if (found === undefined) throw new Error('instância inexistente');
    return found;
  };

  async function createWallet(amount: string) {
    const playerId = crypto.randomUUID();
    const reply = await instance(0).post('/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    expect(reply.status).toBe(201);
    return { walletId: String(reply.body['walletId']), playerId };
  }

  function wager(
    wallet: { walletId: string; playerId: string },
    amount: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      providerId: 'provider-1',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      ...overrides,
    };
  }

  /** Chave da convenção da SPEC 13: {providerId}:{externalTransactionId}. */
  function send(target: HttpInstance, body: ReturnType<typeof wager>): Promise<HttpReply> {
    return target.post('/wagering/transactions', body, {
      'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
    });
  }

  async function ledgerOf(walletId: string) {
    return db.execute(
      `SELECT transaction_id, direction, balance_after::text AS balance_after
         FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at, id`,
      [walletId],
    );
  }

  async function balanceOf(walletId: string): Promise<string> {
    const [row] = await db.execute(`SELECT balance_amount::text AS b FROM wallets WHERE id = ?`, [
      walletId,
    ]);
    return String(row?.['b']);
  }

  test('A: 60 apostas de 3,00 sobre 100,00, distribuídas entre as três, aplicam 33 e rejeitam 27 (RN-05)', async () => {
    const wallet = await createWallet('100.00');
    const bodies = Array.from({ length: 60 }, () => wager(wallet, '3.00'));

    const replies = await Promise.all(bodies.map((body, i) => send(instance(i), body)));

    // Só 201 e 422: sem 503, nenhuma disputa virou conflito de CAS ou estouro de lock (ADR-0003).
    expect([...new Set(replies.map((r) => r.status))].sort()).toEqual([201, 422]);
    const processed = replies.filter((r) => r.status === 201);
    const rejected = replies.filter((r) => r.status === 422);
    expect(processed).toHaveLength(33);
    expect(rejected).toHaveLength(27);
    expect(rejected.every((r) => r.body['failureCode'] === 'INSUFFICIENT_FUNDS')).toBe(true);
    for (const reply of replies) {
      const balance = reply.body['balance'] as { amount: string } | null;
      expect(balance?.amount.startsWith('-')).toBe(false);
    }

    const ledger = await ledgerOf(wallet.walletId);
    const debits = ledger.filter((entry) => entry['direction'] === 'DEBIT');
    expect(debits).toHaveLength(33);
    // Nenhuma transação aplicada duas vezes, e cada 201 tem o seu único débito.
    const debited = debits.map((entry) => String(entry['transaction_id']));
    expect(new Set(debited).size).toBe(33);
    expect(debited.sort()).toEqual(processed.map((r) => String(r.body['transactionId'])).sort());
    // O saldo nunca ficou negativo em nenhum ponto do ledger.
    expect(ledger.every((entry) => !String(entry['balance_after']).startsWith('-'))).toBe(true);
    expect(await ledgerInvariant(db, wallet.walletId)).toEqual({
      stored: '1.00',
      reconstructed: '1.00',
      consistent: true,
    });
  }, 60_000);

  test('B: a mesma chave com o mesmo payload, 5 vezes em cada instância, gera um efeito e 14 replays (ADR-0005; RN-20)', async () => {
    const wallet = await createWallet('100.00');
    const body = wager(wallet, '10.00');

    const replies = await Promise.all(
      Array.from({ length: 15 }, (_, i) => send(instance(i), body)),
    );

    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(14);
    const first = replies.find((r) => r.status === 201);
    expect(first?.body['idempotentReplay']).toBe(false);
    for (const reply of replies) {
      // Replay devolve o mesmo corpo da primeira aplicação, com o saldo da época.
      expect(reply.body).toMatchObject({
        transactionId: first?.body['transactionId'],
        status: 'PROCESSED',
        failureCode: null,
        balance: { amount: '90.00', currency: 'BRL' },
        idempotentReplay: reply.status === 200,
      });
    }

    const rows = await db.execute(
      `SELECT count(*)::int AS n FROM wager_transactions
        WHERE provider_id = ? AND external_transaction_id = ?`,
      [body.providerId, body.externalTransactionId],
    );
    expect(rows[0]?.['n']).toBe(1);
    const debits = (await ledgerOf(wallet.walletId)).filter((e) => e['direction'] === 'DEBIT');
    expect(debits.map((e) => String(e['transaction_id']))).toEqual([
      String(first?.body['transactionId']),
    ]);
    expect(await ledgerInvariant(db, wallet.walletId)).toEqual({
      stored: '90.00',
      reconstructed: '90.00',
      consistent: true,
    });
  }, 60_000);

  test('C: três REFUND e três ROLLBACK da mesma BET, nas três instâncias, revertem uma vez só (ADR-0004; RN-16)', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, '30.00');
    expect((await send(instance(0), bet)).status).toBe(201);
    const reversals = (
      ['REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK'] as const
    ).map((kind) =>
      wager(wallet, '30.00', {
        kind,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    const replies = await Promise.all(reversals.map((body, i) => send(instance(i), body)));

    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = replies.filter((r) => r.status === 422);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((r) => r.body['failureCode'] === 'REFERENCE_ALREADY_REVERSED')).toBe(
      true,
    );

    const processed = await db.execute(
      `SELECT count(*)::int AS n FROM wager_transactions
        WHERE provider_id = ? AND reference_external_transaction_id = ?
          AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
      [bet.providerId, bet.externalTransactionId],
    );
    expect(processed[0]?.['n']).toBe(1);
    const credits = (await ledgerOf(wallet.walletId)).filter((e) => e['direction'] === 'CREDIT');
    // OPENING e uma única reversão.
    expect(credits).toHaveLength(2);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect((await ledgerInvariant(db, wallet.walletId)).consistent).toBe(true);
  }, 60_000);
});
