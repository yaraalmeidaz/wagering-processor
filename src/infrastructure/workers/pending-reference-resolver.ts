import type { Clock } from '../../application/ports/clock';
import type { PendingReferenceCandidate } from '../../application/ports/transaction-repository';
import type {
  ResolvePendingReference,
  ResolveResult,
} from '../../application/use-cases/resolve-pending-reference';
import { retryDelayMs } from '../../domain/retry-backoff';
import { JsonLogger } from '../../observability/json-log';
import type { LogSink } from '../../observability/log-sink';
import type { Metrics } from '../../observability/metrics';

/** Lote e espera ociosa da decisão E da ADR-0007 (SPEC 8.2). */
export const PENDING_REFERENCE_BATCH = 50;
export const PENDING_REFERENCE_IDLE_MS = 1_000;
export const PENDING_REFERENCE_CYCLE_FAILURES = 'pending_reference_cycle_failures_total';

/** Espera interrompível pelo stop. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface PendingReferenceWorkerOptions {
  /** Candidatas vencidas, sem lock (SPEC 8.2). */
  readonly candidates: (limit: number) => Promise<readonly PendingReferenceCandidate[]>;
  readonly resolver: Pick<ResolvePendingReference, 'resolve'>;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly sink: LogSink;
  /** Fonte do jitter do backoff entre buscas que falharam (ADR-0007). Padrão: Math.random. */
  readonly random?: () => number;
  readonly sleep?: Sleep;
}

/**
 * Loop do resolvedor de pendências (SPEC 8.2; ADR-0007). Cada item é uma execução do
 * caso de uso, com em.fork() próprio na unidade de trabalho (AGENTS.md §2.12). O único
 * estado em memória é a contagem de buscas seguidas que falharam; o resto está no banco.
 */
export class PendingReferenceWorker {
  readonly #options: PendingReferenceWorkerOptions;
  readonly #log: JsonLogger;
  readonly #sleep: Sleep;
  #stopping = false;
  #abort = new AbortController();
  #loop: Promise<void> = Promise.resolve();

  constructor(options: PendingReferenceWorkerOptions) {
    this.#options = options;
    this.#log = new JsonLogger(options.sink, options.clock);
    this.#sleep = options.sleep ?? abortableSleep;
  }

  get stopped(): Promise<void> {
    return this.#loop;
  }

  /** Um lote. Para entre itens quando o stop foi pedido. Devolve quantos itens tratou. */
  async runOnce(): Promise<number> {
    const batch = await this.#options.candidates(PENDING_REFERENCE_BATCH);
    let handled = 0;
    for (const candidate of batch) {
      if (this.#stopping) break;
      this.#record(candidate, await this.#options.resolver.resolve(candidate));
      handled += 1;
    }
    return handled;
  }

  start(): void {
    this.#stopping = false;
    this.#abort = new AbortController();
    this.#loop = (async () => {
      let failures = 0;
      while (!this.#stopping) {
        try {
          const handled = await this.runOnce();
          failures = 0;
          if (handled === 0) await this.#sleep(PENDING_REFERENCE_IDLE_MS, this.#abort.signal);
        } catch (error) {
          // ADR-0007: banco fora também no adiamento; espera crescente entre as buscas.
          failures += 1;
          this.#options.metrics.increment(PENDING_REFERENCE_CYCLE_FAILURES);
          this.#log.write('error', 'pending_reference_cycle_failed', {
            failures,
            error: errorName(error),
          });
          const delay = retryDelayMs(failures, this.#options.random ?? Math.random);
          await this.#sleep(delay, this.#abort.signal);
        }
      }
    })();
  }

  /** SIGTERM: para de buscar, termina o item em andamento e encerra o loop. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#abort.abort();
    await this.#loop;
  }

  #record(candidate: PendingReferenceCandidate, result: ResolveResult): void {
    this.#options.metrics.increment(`pending_reference_${result.outcome.toLowerCase()}_total`);
    const level =
      result.outcome === 'FAILED' ? 'error' : result.outcome === 'POSTPONED' ? 'warn' : 'info';
    this.#log.write(level, 'pending_reference_attempt', {
      transactionId: result.transactionId,
      walletId: candidate.walletId,
      outcome: result.outcome,
      ...(result.cause === undefined ? {} : { error: errorName(result.cause) }),
    });
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown';
}
