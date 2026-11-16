import type { Clock } from '../application/ports/clock';
import type {
  ReconciliationContext,
  ReconciliationMonitor,
} from '../application/ports/reconciliation-monitor';
import type { ReconciliationResult } from '../application/use-cases/reconcile-wallet';
import { JsonLogger } from './json-log';
import type { LogSink } from './log-sink';
import type { Metrics } from './metrics';

export const RECONCILIATION_DIVERGENCES = 'reconciliation_divergences_total';

/** Divergência de reconciliação: linha de log JSON e métrica, sem correção (RN-37; ADR-0009). */
export class LoggingReconciliationMonitor implements ReconciliationMonitor {
  readonly #metrics: Metrics;
  readonly #log: JsonLogger;

  constructor(dependencies: { metrics: Metrics; sink: LogSink; clock: Clock }) {
    this.#metrics = dependencies.metrics;
    this.#log = new JsonLogger(dependencies.sink, dependencies.clock);
  }

  divergenceDetected(result: ReconciliationResult, context: ReconciliationContext): void {
    this.#metrics.increment(RECONCILIATION_DIVERGENCES);
    // Sem valores financeiros (SPEC 14.1): o detalhe está no endpoint e no ledger.
    this.#log.write('warn', 'reconciliation_divergence', {
      correlationId: context.correlationId,
      walletId: result.walletId,
      result: { consistent: result.consistent, checkedEntries: result.checkedEntries },
    });
  }
}
