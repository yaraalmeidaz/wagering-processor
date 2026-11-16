import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { AuthGuard } from '../../../src/interfaces/http/auth.guard';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { type HttpApp, startHttpApp } from '../../helpers/http-app';

// AGENTS.md §10; SPEC 13; ADR-0008, ADR-0009, ADR-0010 (readiness com PostgreSQL e SQS).
describe('HTTP: health e ponto de extensão de autenticação', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('http_health');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  describe('com PostgreSQL disponível', () => {
    let http: HttpApp;

    beforeAll(async () => {
      http = await startHttpApp(db.orm);
    });

    afterAll(async () => {
      await http?.close();
    });

    test('GET /health/live: 200 sem credenciais', async () => {
      const response = await http.call('GET', '/health/live');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    test('GET /health/ready: 200 com PostgreSQL e SQS verificados', async () => {
      const response = await http.call('GET', '/health/ready');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } });
    });

    test('rota inexistente: 404 NOT_FOUND', async () => {
      const response = await http.call('GET', '/nao-existe');
      expect(response.status).toBe(404);
      expect(response.body['code']).toBe('NOT_FOUND');
    });
  });

  test('GET /health/ready: 503 quando o PostgreSQL não responde', async () => {
    // Porta sem PostgreSQL: o ORM inicializa sem conectar e o SELECT 1 falha.
    const orm = await MikroORM.init({ ...createOrmConfig({ dbName: db.name }), port: 1 });
    const http = await startHttpApp(orm);
    try {
      const ready = await http.call('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'fail', sqs: 'ok' },
      });
      expect((await http.call('GET', '/health/live')).status).toBe(200);
    } finally {
      await http.close();
      await orm.close(true);
    }
  }, 15_000);

  test('GET /health/ready: 503 quando o SQS não responde (ADR-0010)', async () => {
    // Porta sem SQS: o mesmo padrão do PostgreSQL, sem parar o LocalStack da suíte.
    const unreachable = createSqsClient({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1_000,
    });
    const http = await startHttpApp(db.orm, undefined, {
      client: unreachable,
      inputQueueUrl: 'http://127.0.0.1:1/000000000000/wager-transactions.fifo',
    });
    try {
      const ready = await http.call('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'ok', sqs: 'fail' },
      });
      expect((await http.call('GET', '/health/live')).status).toBe(200);
    } finally {
      await http.close();
      unreachable.destroy();
    }
  }, 15_000);

  test('AuthGuard vale para os endpoints de negócio e não para os de health (ADR-0008)', async () => {
    const http = await startHttpApp(db.orm, (builder) =>
      builder.overrideGuard(AuthGuard).useValue({ canActivate: () => false }),
    );
    try {
      const wallets = await http.call('POST', '/wallets', {
        body: {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        },
      });
      expect(wallets.status).toBe(403);
      expect(wallets.body['code']).toBe('FORBIDDEN');
      expect((await http.call('POST', '/wagering/transactions', { body: {} })).status).toBe(403);
      expect((await http.call('GET', `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(
        403,
      );
      expect((await http.call('GET', `/wallets/${crypto.randomUUID()}`)).status).toBe(403);

      expect((await http.call('GET', '/health/live')).status).toBe(200);
      expect((await http.call('GET', '/health/ready')).status).toBe(200);
    } finally {
      await http.close();
    }
  });
});
