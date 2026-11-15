import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from './../helpers/database';
import { type HttpApp, startHttpApp } from './../helpers/http-app';

// AGENTS.md §10: /health/live responde sem autenticação.
describe('GET /health/live', () => {
  let db: TestDatabase;
  let http: HttpApp;

  beforeAll(async () => {
    db = await createTestDatabase('http_live');
    http = await startHttpApp(db.orm);
  });

  afterAll(async () => {
    await http?.close();
    await db?.dispose();
  });

  test('retorna 200 com {"status":"ok"} sem credenciais', async () => {
    const response = await http.call('GET', '/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
