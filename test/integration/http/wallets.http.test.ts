import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CLOCK, LOG_SINK, METRICS } from '../../../src/interfaces/http/tokens';
import type { Metrics } from '../../../src/observability/metrics';
import { FakeClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { type HttpApp, startHttpApp } from '../../helpers/http-app';

// SPEC 13; ADR-0009; RN-03, RN-04, RN-37.
describe('HTTP: wallets', () => {
  let db: TestDatabase;
  let http: HttpApp;
  /** Linhas escritas no LOG_SINK da aplicação. */
  const logLines: string[] = [];

  const createWallet = (amount: string, playerId = crypto.randomUUID()) =>
    http.call('POST', '/wallets', {
      body: { playerId, initialBalance: { amount, currency: 'BRL' } },
    });

  const bet = (walletId: string, playerId: string, amount: string) => {
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    return http.call('POST', '/wagering/transactions', {
      headers: { 'Idempotency-Key': `provider-1:${externalTransactionId}` },
      body: {
        providerId: 'provider-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      },
    });
  };

  beforeAll(async () => {
    db = await createTestDatabase('http_wallets');
    await db.orm.migrator.up();
    http = await startHttpApp(db.orm, (builder) =>
      builder.overrideProvider(LOG_SINK).useValue({ write: (line: string) => logLines.push(line) }),
    );
  });

  afterAll(async () => {
    await http?.close();
    await db?.dispose();
  });

  describe('POST /wallets (RN-03, RN-04)', () => {
    test('201 com a wallet e OPENING com lançamento CREDIT na mesma transação', async () => {
      const playerId = crypto.randomUUID();
      const response = await createWallet('100.00', playerId);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        playerId,
        balance: { amount: '100.00', currency: 'BRL' },
        version: 1,
      });
      const walletId = String(response.body['walletId']);

      const rows = await db.execute(
        `SELECT t.kind, t.status, l.direction, l.amount::text AS amount
           FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE l.wallet_id = ?`,
        [walletId],
      );
      expect(rows).toEqual([
        { kind: 'OPENING', status: 'PROCESSED', direction: 'CREDIT', amount: '100.00' },
      ]);
      const events = await db.execute(
        `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq`,
        [walletId],
      );
      expect(events.map((e) => e['event_type'])).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    test('saldo inicial zero não gera OPENING nem lançamento', async () => {
      const response = await createWallet('0.00');
      expect(response.status).toBe(201);
      const rows = await db.execute(
        `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [String(response.body['walletId'])],
      );
      expect(rows[0]?.['n']).toBe(0);
    });

    test('duplicata para o mesmo (playerId, currency): 409 WALLET_ALREADY_EXISTS', async () => {
      const playerId = crypto.randomUUID();
      expect((await createWallet('1.00', playerId)).status).toBe(201);
      const duplicate = await createWallet('1.00', playerId);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body['code']).toBe('WALLET_ALREADY_EXISTS');
    });

    test.each([
      [
        'valor como number',
        { playerId: crypto.randomUUID(), initialBalance: { amount: 100, currency: 'BRL' } },
      ],
      [
        'valor negativo',
        { playerId: crypto.randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } },
      ],
      [
        'playerId sem formato uuid',
        { playerId: 'abc', initialBalance: { amount: '1.00', currency: 'BRL' } },
      ],
    ])('%s: 400 INVALID_PAYLOAD', async (_, body) => {
      const response = await http.call('POST', '/wallets', { body });
      expect(response.status).toBe(400);
      expect(response.body['code']).toBe('INVALID_PAYLOAD');
    });
  });

  describe('GET /wallets/:walletId e ledger', () => {
    test('200 com saldo em string; 404 para id inexistente; 400 para id malformado', async () => {
      const created = await createWallet('12.34');
      const walletId = String(created.body['walletId']);

      const found = await http.call('GET', `/wallets/${walletId}`);
      expect(found.status).toBe(200);
      expect(found.body['balance']).toEqual({ amount: '12.34', currency: 'BRL' });

      const missing = await http.call('GET', `/wallets/${crypto.randomUUID()}`);
      expect(missing.status).toBe(404);
      expect(missing.body['code']).toBe('WALLET_NOT_FOUND');

      const malformed = await http.call('GET', '/wallets/nao-e-uuid');
      expect(malformed.status).toBe(400);
      expect(malformed.body['code']).toBe('INVALID_PAYLOAD');
    });

    test('ledger paginado por cursor opaco, do mais recente ao mais antigo, sem repetir itens', async () => {
      const playerId = crypto.randomUUID();
      const created = await createWallet('10.00', playerId);
      const walletId = String(created.body['walletId']);
      // Intervalo entre escritas: a ordem esperada vem do created_at, não do desempate por id.
      for (const amount of ['1.00', '2.00', '3.00']) {
        await Bun.sleep(5);
        expect((await bet(walletId, playerId, amount)).status).toBe(201);
      }

      const first = await http.call('GET', `/wallets/${walletId}/ledger?limit=2`);
      expect(first.status).toBe(200);
      const firstItems = first.body['items'] as Record<string, unknown>[];
      expect(firstItems).toHaveLength(2);
      expect(typeof first.body['nextCursor']).toBe('string');

      const second = await http.call(
        'GET',
        `/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(String(first.body['nextCursor']))}`,
      );
      const secondItems = second.body['items'] as Record<string, unknown>[];
      expect(secondItems).toHaveLength(2);
      expect(second.body['nextCursor']).toBeNull();

      const all = [...firstItems, ...secondItems];
      expect(new Set(all.map((item) => item['entryId'])).size).toBe(4);
      expect(all.map((item) => (item['amount'] as { amount: string }).amount)).toEqual([
        '3.00',
        '2.00',
        '1.00',
        '10.00',
      ]);
      expect(all.at(-1)?.['direction']).toBe('CREDIT');
    });

    test('lançamentos com o mesmo created_at: o desempate por id mantém a ordem e não perde itens', async () => {
      // Relógio parado: todos os lançamentos têm o mesmo created_at, e só o id decide (ADR-0009).
      const frozen = await startHttpApp(db.orm, (builder) =>
        builder.overrideProvider(CLOCK).useValue(new FakeClock(new Date('2026-11-15T12:00:00Z'))),
      );
      try {
        const playerId = crypto.randomUUID();
        const created = await frozen.call('POST', '/wallets', {
          body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } },
        });
        const walletId = String(created.body['walletId']);
        for (const amount of ['1.00', '2.00', '3.00']) {
          const externalTransactionId = `ext-${crypto.randomUUID()}`;
          const response = await frozen.call('POST', '/wagering/transactions', {
            headers: { 'Idempotency-Key': `provider-1:${externalTransactionId}` },
            body: {
              providerId: 'provider-1',
              externalTransactionId,
              playerId,
              walletId,
              roundId: 'round-1',
              gameId: 'game-1',
              kind: 'BET',
              money: { amount, currency: 'BRL' },
            },
          });
          expect(response.status).toBe(201);
        }

        const pages: Record<string, unknown>[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
          const response = await frozen.call('GET', `/wallets/${walletId}/ledger?limit=1${query}`);
          expect(response.status).toBe(200);
          pages.push(...(response.body['items'] as Record<string, unknown>[]));
          cursor = response.body['nextCursor'] as string | null;
          if (cursor === null) break;
        }

        expect(new Set(pages.map((item) => item['createdAt'])).size).toBe(1);
        const ids = pages.map((item) => String(item['entryId']));
        expect(ids).toHaveLength(4);
        expect(new Set(ids).size).toBe(4);
        expect(ids).toEqual([...ids].sort().reverse());
      } finally {
        await frozen.close();
      }
    });

    test.each([
      ['limit=0', 'limit=0'],
      ['limit=101', 'limit=101'],
      ['limit não numérico', 'limit=abc'],
      ['cursor inválido', 'cursor=isto-nao-e-um-cursor'],
    ])('%s: 400 INVALID_PAYLOAD', async (_, query) => {
      const created = await createWallet('1.00');
      const response = await http.call(
        'GET',
        `/wallets/${String(created.body['walletId'])}/ledger?${query}`,
      );
      expect(response.status).toBe(400);
      expect(response.body['code']).toBe('INVALID_PAYLOAD');
    });

    test('ledger de wallet inexistente: 404 WALLET_NOT_FOUND', async () => {
      const response = await http.call('GET', `/wallets/${crypto.randomUUID()}/ledger`);
      expect(response.status).toBe(404);
      expect(response.body['code']).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('POST /wallets/:walletId/reconciliation (RN-37)', () => {
    test('consistent true quando o saldo bate com o ledger', async () => {
      const playerId = crypto.randomUUID();
      const created = await createWallet('50.00', playerId);
      const walletId = String(created.body['walletId']);
      await bet(walletId, playerId, '20.00');

      const response = await http.call('POST', `/wallets/${walletId}/reconciliation`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        walletId,
        storedBalance: { amount: '30.00', currency: 'BRL' },
        calculatedBalance: { amount: '30.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });

    test('divergência: logada, contada e sinalizada, sem correção silenciosa', async () => {
      const created = await createWallet('50.00');
      const walletId = String(created.body['walletId']);
      // Divergência provocada fora do sistema: o saldo gravado não bate mais com o ledger.
      await db.execute(`UPDATE wallets SET balance_amount = '45.00' WHERE id = ?`, [walletId]);
      const metrics = http.app.get<Metrics>(METRICS);
      const before = metrics.value('reconciliation_divergences_total');

      const response = await http.call('POST', `/wallets/${walletId}/reconciliation`, {
        headers: { 'X-Correlation-Id': 'corr-divergencia.1' },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        storedBalance: { amount: '45.00' },
        calculatedBalance: { amount: '50.00' },
        difference: { amount: '-5.00' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(metrics.value('reconciliation_divergences_total')).toBe(before + 1);

      // Uma linha JSON parseável, sem valores financeiros (SPEC 14.1; ADR-0009).
      const lines = logLines.filter((line) => line.includes(walletId));
      expect(lines).toHaveLength(1);
      const line = String(lines[0]);
      expect(line).not.toContain('\n');
      expect(JSON.parse(line)).toEqual({
        timestamp: expect.any(String),
        level: 'warn',
        event: 'reconciliation_divergence',
        correlationId: 'corr-divergencia.1',
        walletId,
        result: { consistent: false, checkedEntries: 1 },
      });
      for (const amount of ['45.00', '50.00', '5.00']) {
        expect(line).not.toContain(amount);
      }

      const after = await db.execute(`SELECT balance_amount::text AS b FROM wallets WHERE id = ?`, [
        walletId,
      ]);
      expect(after[0]?.['b']).toBe('45.00');
    });

    test.each([
      ['sem header', undefined],
      ['header com caractere fora do formato', 'corr id {"x":1}'],
      ['header acima de 128 caracteres', 'a'.repeat(129)],
    ])('correlationId gerado pelo servidor: %s (ADR-0009)', async (_, header) => {
      const created = await createWallet('20.00');
      const walletId = String(created.body['walletId']);
      await db.execute(`UPDATE wallets SET balance_amount = '19.00' WHERE id = ?`, [walletId]);

      const response = await http.call('POST', `/wallets/${walletId}/reconciliation`, {
        headers: header === undefined ? {} : { 'X-Correlation-Id': header },
      });
      expect(response.status).toBe(200);
      const lines = logLines.filter((line) => line.includes(walletId));
      expect(lines).toHaveLength(1);
      const record = JSON.parse(String(lines[0])) as Record<string, unknown>;
      expect(String(record['correlationId'])).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    test('lê a wallet com FOR UPDATE: espera a escrita concorrente e reconcilia o estado commitado', async () => {
      const created = await createWallet('50.00');
      const walletId = String(created.body['walletId']);

      // Outra sessão trava a wallet e só altera o saldo depois que a reconciliação começou.
      let signalLocked: () => void = () => {};
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = db.orm.em.fork().transactional(async (em) => {
        await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
        signalLocked();
        await released;
        await em.execute(`UPDATE wallets SET balance_amount = '45.00' WHERE id = ?`, [walletId]);
      });
      await locked;

      let settled = false;
      const reconciliation = http
        .call('POST', `/wallets/${walletId}/reconciliation`)
        .finally(() => {
          settled = true;
        });
      try {
        await Bun.sleep(300);
        expect(settled).toBe(false);
      } finally {
        release();
        await holder;
      }
      const response = await reconciliation;
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        storedBalance: { amount: '45.00' },
        calculatedBalance: { amount: '50.00' },
        consistent: false,
      });
    });

    test('wallet inexistente: 404 WALLET_NOT_FOUND', async () => {
      const response = await http.call('POST', `/wallets/${crypto.randomUUID()}/reconciliation`);
      expect(response.status).toBe(404);
    });
  });
});
