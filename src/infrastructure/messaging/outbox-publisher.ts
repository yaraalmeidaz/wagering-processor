import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Clock } from '../../application/ports/clock';
import type { OutboxPublicationStore } from '../../application/ports/outbox-publication-store';
import type { OutboxMessage } from '../../domain/outbox-message';
import { JsonLogger } from '../../observability/json-log';
import type { LogSink } from '../../observability/log-sink';
import type { Metrics } from '../../observability/metrics';

/** Métricas do publisher (ADR-0010). */
export const OUTBOX_PUBLISHED = 'outbox_published_total';
export const OUTBOX_PUBLISH_FAILURES = 'outbox_publish_failures_total';
export const OUTBOX_RETRY_EXHAUSTED = 'outbox_retry_exhausted_total';
export const OUTBOX_LAG_SECONDS = 'outbox_lag_seconds';

export interface PublisherOptions {
  readonly store: OutboxPublicationStore;
  readonly sqs: SQSClient;
  readonly eventsQueueUrl: string;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly sink: LogSink;
  /** Fonte do jitter do backoff (ADR-0007). Padrão: Math.random. */
  readonly random?: () => number;
  readonly batchSize?: number;
  /** Gancho entre o ack do SendMessage e o COMMIT, usado só pelos testes de queda (ADR-0010). */
  readonly hooks?: { readonly afterSend?: (message: OutboxMessage) => Promise<void> | void };
}

/**
 * Publisher por agregado (SPEC 11.3; ADR-0006): um evento por agregado por ciclo, o
 * de menor seq, com MessageGroupId = walletId e MessageDeduplicationId = eventId.
 */
export class OutboxPublisher {
  readonly #options: PublisherOptions;
  readonly #log: JsonLogger;
  #stopping = false;
  #loop: Promise<void> = Promise.resolve();

  constructor(options: PublisherOptions) {
    this.#options = options;
    this.#log = new JsonLogger(options.sink, options.clock);
  }

  get stopped(): Promise<void> {
    return this.#loop;
  }

  /** Um ciclo sobre os agregados devidos. */
  async publishOnce(): Promise<{ published: number }> {
    const { store, clock, metrics } = this.#options;
    const oldest = await store.oldestPendingOccurredAt();
    metrics.set(
      OUTBOX_LAG_SECONDS,
      oldest === null ? 0 : Math.max(0, (clock.now().getTime() - oldest.getTime()) / 1_000),
    );

    let published = 0;
    for (const aggregateId of await store.dueAggregates(this.#options.batchSize ?? 100)) {
      const attempt = await store.withAggregate(aggregateId, (head, save) =>
        this.#publishHead(head, save),
      );
      if (attempt.locked && attempt.value) published += 1;
    }
    return { published };
  }

  /** Loop até o stop. Sem nada publicado, espera `idleMs`. */
  start(idleMs = 500): void {
    this.#stopping = false;
    this.#loop = (async () => {
      while (!this.#stopping) {
        try {
          const { published } = await this.publishOnce();
          if (published === 0) await Bun.sleep(idleMs);
        } catch (error) {
          this.#log.write('error', 'outbox_cycle_failed', { error: errorName(error) });
          await Bun.sleep(1_000);
        }
      }
    })();
  }

  /** Termina o ciclo em andamento: a transação aberta faz COMMIT ou ROLLBACK, nunca fica pela metade. */
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#loop;
  }

  async #publishHead(
    head: OutboxMessage | null,
    save: (message: OutboxMessage) => Promise<void>,
  ): Promise<boolean> {
    const { sqs, eventsQueueUrl, clock, metrics } = this.#options;
    // Passo 2b: o estado pode ter mudado desde o passo 1. Em backoff, nada do agregado sai.
    if (head === null || !head.isDue(clock.now())) return false;
    const fields = { eventId: head.id, aggregateId: head.aggregateId, eventType: head.eventType };
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: eventsQueueUrl,
          MessageBody: JSON.stringify(head.payload),
          MessageGroupId: head.aggregateId,
          MessageDeduplicationId: head.id,
          MessageAttributes: { eventType: { DataType: 'String', StringValue: head.eventType } },
        }),
      );
    } catch (error) {
      // Passo 2e: sem ack, nova tentativa com backoff (ADR-0006).
      head.scheduleRetry(clock.now(), this.#options.random ?? Math.random);
      await save(head);
      metrics.increment(OUTBOX_PUBLISH_FAILURES);
      const failure = { ...fields, attempts: head.attempts, error: errorName(error) };
      if (head.isRetryExhausted()) {
        metrics.increment(OUTBOX_RETRY_EXHAUSTED);
        this.#log.write('error', 'outbox_retry_exhausted', failure);
      } else {
        this.#log.write('warn', 'outbox_publish_failed', failure);
      }
      return false;
    }
    await this.#options.hooks?.afterSend?.(head);
    // Passo 2d: published_at só depois do ack.
    head.markPublished(clock.now());
    await save(head);
    metrics.increment(OUTBOX_PUBLISHED);
    this.#log.write('info', 'outbox_published', fields);
    return true;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown';
}
