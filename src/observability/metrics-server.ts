import type { Metrics } from './metrics';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsServer {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * GET /metrics dos workers em 127.0.0.1, só com METRICS_PORT definida (ADR-0011).
 * Sem a variável, nenhuma porta é aberta, e várias instâncias convivem na mesma máquina.
 */
export function startMetricsServer(
  metrics: Metrics,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MetricsServer | null {
  const raw = env['METRICS_PORT'];
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65_535) {
    throw new Error(`METRICS_PORT inválida: ${raw}`);
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === '/metrics') {
        return new Response(metrics.render(), {
          headers: { 'content-type': METRICS_CONTENT_TYPE },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    port: server.port ?? port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
