import {
  IdempotencyConflictError,
  InvalidInputError,
  TransientFailureError,
  WalletVersionConflictError,
} from '../application/errors';
import type { Clock } from '../application/ports/clock';
import type {
  ProcessWager,
  ProcessWagerInput,
  ProcessWagerResult,
} from '../application/use-cases/process-wager-transaction';
import { JsonLogger, type LogFields, type LogLevel } from './json-log';
import type { LogSink } from './log-sink';
import type { Metrics } from './metrics';

/** Métricas do caso de uso de transação (ADR-0011; SPEC 14.2). */
export const WAGER_TRANSACTIONS = 'wager_transactions_total';
export const WAGER_IDEMPOTENT_REPLAYS = 'wager_idempotent_replays_total';
export const WAGER_IDEMPOTENCY_CONFLICTS = 'wager_idempotency_conflicts_total';
export const WAGER_LOCK_CONFLICTS = 'wager_lock_conflicts_total';
export const WAGER_PROCESSING_DURATION = 'wager_processing_duration_seconds';

/** SQLSTATE do conflito de lock para o rótulo `reason` (ADR-0011). */
const LOCK_REASONS: Readonly<Record<string, string>> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization',
};

export interface InstrumentationOptions {
  readonly metrics: Metrics;
  readonly sink: LogSink;
  readonly clock: Clock;
  /** Relógio monotônico em milissegundos. Padrão: performance.now. */
  readonly elapsedMs?: () => number;
}

/**
 * Decorator do caso de uso: o único ponto de medição de HTTP e SQS (ADR-0011).
 * Não muda o resultado nem o erro do caso de uso.
 */
export class InstrumentedProcessWager implements ProcessWager {
  readonly #inner: ProcessWager;
  readonly #metrics: Metrics;
  readonly #log: JsonLogger;
  readonly #elapsedMs: () => number;

  constructor(inner: ProcessWager, options: InstrumentationOptions) {
    this.#inner = inner;
    this.#metrics = options.metrics;
    this.#log = new JsonLogger(options.sink, options.clock);
    this.#elapsedMs = options.elapsedMs ?? (() => performance.now());
  }

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const channel = input.inbox === undefined ? 'http' : 'sqs';
    const started = this.#elapsedMs();
    let result: ProcessWagerResult;
    try {
      result = await this.#inner.execute(input);
    } catch (error) {
      const durationMs = this.#elapsedMs() - started;
      this.#metrics.observe(WAGER_PROCESSING_DURATION, durationMs / 1_000, {
        channel,
        outcome: 'error',
      });
      this.#log.write(this.#countError(error, channel), 'wager_transaction_error', {
        ...identifiers(input, channel),
        error: error instanceof Error ? error.name : 'Unknown',
        durationMs,
      });
      throw error;
    }

    const durationMs = this.#elapsedMs() - started;
    this.#metrics.observe(WAGER_PROCESSING_DURATION, durationMs / 1_000, {
      channel,
      outcome: 'result',
    });
    if (result.idempotentReplay) {
      this.#metrics.increment(WAGER_IDEMPOTENT_REPLAYS, { channel });
    } else {
      this.#metrics.increment(WAGER_TRANSACTIONS, { channel, status: result.status });
    }
    this.#log.write('info', 'wager_transaction_result', {
      ...identifiers(input, channel),
      transactionId: result.transactionId,
      ...text('kind', input.kind),
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
      durationMs,
    });
    return result;
  }

  /** Conta o erro e devolve o nível do log. */
  #countError(error: unknown, channel: string): LogLevel {
    if (error instanceof IdempotencyConflictError) {
      this.#metrics.increment(WAGER_IDEMPOTENCY_CONFLICTS, { channel, code: error.code });
      return 'warn';
    }
    if (error instanceof WalletVersionConflictError) {
      this.#metrics.increment(WAGER_LOCK_CONFLICTS, { channel, reason: 'version_conflict' });
      return 'warn';
    }
    const reason =
      error instanceof TransientFailureError && error.sqlState !== null
        ? LOCK_REASONS[error.sqlState]
        : undefined;
    if (reason !== undefined) {
      this.#metrics.increment(WAGER_LOCK_CONFLICTS, { channel, reason });
      return 'warn';
    }
    return error instanceof InvalidInputError ? 'warn' : 'error';
  }
}

/** Identificadores da SPEC 14.1. Nunca money, saldo nem playerId. */
function identifiers(input: ProcessWagerInput, channel: string): LogFields {
  return {
    channel,
    ...text('correlationId', input.correlationId),
    ...(input.inbox === undefined ? {} : { messageId: input.inbox.messageId }),
    ...text('walletId', input.walletId),
    ...text('providerId', input.providerId),
  };
}

/** Só texto entra no log: um campo inválido no payload não vira valor arbitrário. */
function text(field: string, value: unknown): LogFields {
  return typeof value === 'string' ? { [field]: value } : {};
}
