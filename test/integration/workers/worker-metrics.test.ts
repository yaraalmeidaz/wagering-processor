import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';

// ADR-0011: os processos reais do publisher e do resolvedor expõem GET /metrics com METRICS_PORT.
// O consumer usa as filas fixas do ambiente e não é subido aqui; a composição dele com o
// decorator é provada em test/integration/messaging/sqs-consumer.test.ts.
const WORKERS = {
  publisher: new URL(
    '../../../src/infrastructure/workers/outbox-publisher.main.ts',
    import.meta.url,
  ),
  'pending-reference': new URL(
    '../../../src/infrastructure/workers/pending-reference.main.ts',
    import.meta.url,
  ),
} as const;

/** Porta livre: o sistema escolhe uma, e ela é liberada antes do uso. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) throw new Error('sem porta livre');
  return port;
}

async function waitForMetrics(port: number, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/metrics`);
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error('GET /metrics não respondeu no prazo');
}

describe('workers com METRICS_PORT (processo separado)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('worker_metrics');
    await db.orm.migrator.up();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  for (const [name, main] of Object.entries(WORKERS)) {
    test(`${name}: responde GET /metrics e fecha a porta no SIGTERM, saindo com 0`, async () => {
      const port = freePort();
      const child = Bun.spawn([process.execPath, main.pathname], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, POSTGRES_DB: db.name, METRICS_PORT: String(port) },
      });
      try {
        const response = await waitForMetrics(port);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
        await response.text();
      } finally {
        child.kill('SIGTERM');
      }
      expect(await child.exited).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
    }, 30_000);
  }

  test('publisher: o gauge outbox_lag_seconds aparece depois do primeiro ciclo', async () => {
    const port = freePort();
    const child = Bun.spawn([process.execPath, WORKERS.publisher.pathname], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, POSTGRES_DB: db.name, METRICS_PORT: String(port) },
    });
    try {
      await waitForMetrics(port);
      const deadline = Date.now() + 10_000;
      let text = '';
      while (Date.now() < deadline && !text.includes('outbox_lag_seconds')) {
        text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
        await Bun.sleep(100);
      }
      expect(text).toContain('# TYPE outbox_lag_seconds gauge\noutbox_lag_seconds 0\n');
    } finally {
      child.kill('SIGTERM');
      await child.exited;
    }
  }, 30_000);
});
