import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { LOG_SINK } from '../../../src/interfaces/http/tokens';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { type HttpApp, startHttpApp } from '../../helpers/http-app';
import { ledgerInvariant } from '../../helpers/wallet-seed';

// ADR-0011; SPEC 14.1 e 14.2; RN-20 (replay), RN-23 (Idempotency-Key).
describe('HTTP: GET /metrics e log por transação', () => {
  let db: TestDatabase;
  let http: HttpApp;
  let baseUrl: string;
  const logLines: Record<string, unknown>[] = [];

  const metricsText = async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    return { response, text: await response.text() };
  };

  const createWallet = async (amount: string) => {
    const playerId = crypto.randomUUID();
    const response = await http.call('POST', '/wallets', {
      body: { playerId, initialBalance: { amount, currency: 'BRL' } },
    });
    return { playerId, walletId: String(response.body['walletId']) };
  };

  const bet = (walletId: string, playerId: string, externalTransactionId: string) =>
    http.call('POST', '/wagering/transactions', {
      headers: { 'Idempotency-Key': `provider-m:${externalTransactionId}` },
      body: {
        providerId: 'provider-m',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    });

  beforeAll(async () => {
    db = await createTestDatabase('http_metrics');
    await db.orm.migrator.up();
    http = await startHttpApp(db.orm, (builder) =>
      builder.overrideProvider(LOG_SINK).useValue({
        write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>),
      }),
    );
    baseUrl = await http.app.getUrl();
  });

  afterAll(async () => {
    await http?.close();
    await db?.dispose();
  });

  test('BET e replay aparecem nas métricas, sem autenticação, em formato Prometheus', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    expect((await bet(walletId, playerId, 'metrics-tx-1')).status).toBe(201);
    expect((await bet(walletId, playerId, 'metrics-tx-1')).status).toBe(200);

    const { response, text } = await metricsText();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    expect(text).toContain('wager_transactions_total{channel="http",status="PROCESSED"} 1\n');
    expect(text).toContain('wager_idempotent_replays_total{channel="http"} 1\n');
    expect(text).toContain(
      'wager_processing_duration_seconds_count{channel="http",outcome="result"} 2\n',
    );
    expect(await ledgerInvariant(db, walletId)).toEqual({
      stored: '70.00',
      reconstructed: '70.00',
      consistent: true,
    });
  });

  test('cada transação deixa uma linha JSON com os identificadores e sem money', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const response = await bet(walletId, playerId, 'metrics-tx-log');
    const line = logLines.find(
      (entry) =>
        entry['event'] === 'wager_transaction_result' &&
        entry['transactionId'] === response.body['transactionId'],
    );
    expect(line).toMatchObject({
      level: 'info',
      channel: 'http',
      walletId,
      providerId: 'provider-m',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(JSON.stringify(line)).not.toContain('30.00');
    expect(JSON.stringify(line)).not.toContain(playerId);
  });

  test('wallet presa por outra sessão: 503 e wager_lock_conflicts_total{reason="lock_timeout"}', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const holder = new MikroOrmUnitOfWork(db.orm.em);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locking = holder.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(walletId);
      await held;
    });
    await Bun.sleep(100);

    const response = await bet(walletId, playerId, 'metrics-tx-lock');
    release();
    await locking;

    expect(response.status).toBe(503);
    const { text } = await metricsText();
    expect(text).toContain('wager_lock_conflicts_total{channel="http",reason="lock_timeout"} 1\n');
    expect(await ledgerInvariant(db, walletId)).toEqual({
      stored: '100.00',
      reconstructed: '100.00',
      consistent: true,
    });
  }, 10_000);
});
