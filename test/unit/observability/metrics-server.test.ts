import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { startMetricsServer } from '../../../src/observability/metrics-server';

// ADR-0011: servidor de métricas dos workers, só com METRICS_PORT.
describe('startMetricsServer', () => {
  test('sem METRICS_PORT não abre porta', () => {
    expect(startMetricsServer(new InMemoryMetrics(), {})).toBeNull();
    expect(startMetricsServer(new InMemoryMetrics(), { METRICS_PORT: '' })).toBeNull();
  });

  test('METRICS_PORT inválida é erro de configuração', () => {
    expect(() => startMetricsServer(new InMemoryMetrics(), { METRICS_PORT: 'abc' })).toThrow();
    expect(() => startMetricsServer(new InMemoryMetrics(), { METRICS_PORT: '70000' })).toThrow();
  });

  test('responde GET /metrics em 127.0.0.1 no formato Prometheus, e 404 fora da rota', async () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('messages_retried_total');
    const server = startMetricsServer(metrics, { METRICS_PORT: '0' });
    if (server === null) throw new Error('servidor não abriu');
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
      expect(await response.text()).toContain('messages_retried_total 1\n');
      expect((await fetch(`http://127.0.0.1:${server.port}/outro`)).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
