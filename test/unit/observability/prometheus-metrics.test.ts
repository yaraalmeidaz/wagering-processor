import { describe, expect, test } from 'bun:test';
import { DURATION_BUCKETS, InMemoryMetrics } from '../../../src/observability/metrics';

// ADR-0011: formato de exposição de texto do Prometheus, versão 0.0.4 (SPEC 14.2).
describe('InMemoryMetrics no formato Prometheus', () => {
  test('contador sem rótulo mantém a leitura usada pelos workers', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('messages_retried_total');
    metrics.increment('messages_retried_total');
    expect(metrics.value('messages_retried_total')).toBe(2);
    expect(metrics.render()).toContain(
      '# TYPE messages_retried_total counter\nmessages_retried_total 2\n',
    );
  });

  test('contador com rótulos separa as séries e ordena os rótulos', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('wager_transactions_total', { status: 'PROCESSED', channel: 'http' });
    metrics.increment('wager_transactions_total', { channel: 'http', status: 'PROCESSED' });
    metrics.increment('wager_transactions_total', { channel: 'sqs', status: 'REJECTED' });
    expect(
      metrics.value('wager_transactions_total', { channel: 'http', status: 'PROCESSED' }),
    ).toBe(2);
    const text = metrics.render();
    expect(text).toContain('wager_transactions_total{channel="http",status="PROCESSED"} 2\n');
    expect(text).toContain('wager_transactions_total{channel="sqs",status="REJECTED"} 1\n');
    expect(text.match(/# TYPE wager_transactions_total counter/g)?.length).toBe(1);
  });

  test('gauge guarda o último valor', () => {
    const metrics = new InMemoryMetrics();
    metrics.set('outbox_lag_seconds', 4);
    metrics.set('outbox_lag_seconds', 1.5);
    expect(metrics.render()).toContain('# TYPE outbox_lag_seconds gauge\noutbox_lag_seconds 1.5\n');
  });

  test('histograma tem buckets cumulativos, +Inf, _sum e _count', () => {
    const metrics = new InMemoryMetrics();
    const labels = { channel: 'http', outcome: 'result' };
    metrics.observe('wager_processing_duration_seconds', 0.004, labels);
    metrics.observe('wager_processing_duration_seconds', 0.03, labels);
    metrics.observe('wager_processing_duration_seconds', 9, labels);
    const text = metrics.render();
    const series = 'wager_processing_duration_seconds_bucket{channel="http",outcome="result"';
    expect(text).toContain('# TYPE wager_processing_duration_seconds histogram\n');
    expect(text).toContain(`${series},le="0.005"} 1\n`);
    expect(text).toContain(`${series},le="0.025"} 1\n`);
    expect(text).toContain(`${series},le="0.05"} 2\n`);
    expect(text).toContain(`${series},le="5"} 2\n`);
    expect(text).toContain(`${series},le="+Inf"} 3\n`);
    expect(text).toContain(
      'wager_processing_duration_seconds_sum{channel="http",outcome="result"} 9.034\n',
    );
    expect(text).toContain(
      'wager_processing_duration_seconds_count{channel="http",outcome="result"} 3\n',
    );
    expect(DURATION_BUCKETS).toEqual([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]);
  });

  test('escapa barra, aspas e quebra de linha no valor do rótulo', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('x_total', { code: 'a"b\\c\nd' });
    expect(metrics.render()).toContain('x_total{code="a\\"b\\\\c\\nd"} 1\n');
  });

  test('sem métricas, renderiza vazio', () => {
    expect(new InMemoryMetrics().render()).toBe('');
  });
});
