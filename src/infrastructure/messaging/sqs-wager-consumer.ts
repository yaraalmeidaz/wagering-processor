import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { IdempotencyConflictError, InvalidInputError } from '../../application/errors';
import type { Clock } from '../../application/ports/clock';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import type { ProcessWager } from '../../application/use-cases/process-wager-transaction';
import { InboxMessage } from '../../domain/inbox-message';
import { JsonLogger, type LogFields } from '../../observability/json-log';
import type { LogSink } from '../../observability/log-sink';
import type { Metrics } from '../../observability/metrics';
import { WAGER_CONSUMER } from './queues';
import { retryVisibilitySeconds } from './retry-visibility';
import { MalformedMessageError, parseWagerMessage } from './wager-message';

/** Métricas da mensageria (ADR-0010). */
export const MESSAGES_DUPLICATE = 'messages_duplicate_total';
export const MESSAGES_RETRIED = 'messages_retried_total';
export const MESSAGES_DEAD_LETTERED = 'messages_dead_lettered_total';

export interface ConsumerOptions {
  readonly sqs: SQSClient;
  readonly queues: { readonly input: string; readonly dlq: string };
  /** O mesmo caso de uso da entrada HTTP (SPEC 5 e 10.2). */
  readonly useCase: ProcessWager;
  /** Só para a leitura rápida do inbox (SPEC 10.2, passo 2). */
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly sink: LogSink;
  readonly consumerName?: string;
  /** Long polling (SPEC 10.2). Padrão 20 s. */
  readonly waitTimeSeconds?: number;
  readonly maxMessages?: number;
  /** Espera do retry transitório. Padrão: ADR-0007 a partir do ApproximateReceiveCount. */
  readonly retryDelaySeconds?: (receiveCount: number) => number;
  /** Espera pela mensagem em andamento no stop (SPEC 10.4). Padrão 25 s. */
  readonly shutdownGraceMs?: number;
  /** Gancho entre o COMMIT e o ack, usado só pelos testes de queda (ADR-0010). */
  readonly hooks?: { readonly afterCommit?: (message: Message) => Promise<void> | void };
}

export type FailureClass =
  | { readonly kind: 'dead-letter'; readonly reason: string }
  | { readonly kind: 'retry' };

/** Classificação da ADR-0010 (SPEC 9.1; RN-33 a RN-35, RN-39). */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof MalformedMessageError) return { kind: 'dead-letter', reason: 'MALFORMED' };
  if (error instanceof InvalidInputError) return { kind: 'dead-letter', reason: 'INVALID_PAYLOAD' };
  if (error instanceof IdempotencyConflictError) return { kind: 'dead-letter', reason: error.code };
  // WalletNotFoundError (RN-39), TransientFailureError, CAS e erro desconhecido (SPEC 5.9).
  return { kind: 'retry' };
}

/**
 * Consumer de wager-transactions.fifo (SPEC 10.2 a 10.4; ADR-0010). Ack só depois
 * do COMMIT do caso de uso. Mensagens do lote em sequência, para não inverter um grupo.
 */
export class SqsWagerConsumer {
  readonly #options: ConsumerOptions;
  readonly #consumerName: string;
  readonly #log: JsonLogger;
  readonly #retryDelaySeconds: (receiveCount: number) => number;
  /** Mensagens recebidas e não concluídas, por MessageId do SQS. */
  readonly #received = new Map<string, Message>();
  /** Mensagens devolvidas no stop: não recebem mais mudança de visibilidade. */
  readonly #released = new Set<string>();
  #stopping = false;
  #receiveAbort: AbortController | null = null;
  #current: Promise<void> | null = null;
  #loop: Promise<void> = Promise.resolve();

  constructor(options: ConsumerOptions) {
    this.#options = options;
    this.#consumerName = options.consumerName ?? WAGER_CONSUMER;
    this.#log = new JsonLogger(options.sink, options.clock);
    this.#retryDelaySeconds =
      options.retryDelaySeconds ?? ((count) => retryVisibilitySeconds(count, Math.random));
  }

  /** Resolve quando o loop parou e a mensagem em andamento terminou. */
  get stopped(): Promise<void> {
    return this.#loop.then(() => this.#current ?? undefined);
  }

  /** Um ciclo de recebimento. Devolve quantas mensagens chegaram. */
  async pollOnce(): Promise<number> {
    const { sqs, queues } = this.#options;
    this.#receiveAbort = new AbortController();
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.input,
        MaxNumberOfMessages: this.#options.maxMessages ?? 10,
        WaitTimeSeconds: this.#options.waitTimeSeconds ?? 20,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.#receiveAbort.signal },
    );
    for (const message of Messages) this.#received.set(idOf(message), message);
    for (const message of Messages) {
      if (this.#stopping || this.#released.has(idOf(message))) continue;
      this.#current = this.#handle(message);
      await this.#current;
      this.#current = null;
    }
    return Messages.length;
  }

  /** Loop de polling até o stop. */
  start(): void {
    this.#stopping = false;
    this.#loop = (async () => {
      while (!this.#stopping) {
        try {
          await this.pollOnce();
        } catch (error) {
          if (this.#stopping) break;
          this.#log.write('error', 'consumer_poll_failed', { error: errorName(error) });
          await Bun.sleep(1_000);
        }
      }
    })();
  }

  /**
   * SIGTERM (SPEC 10.4): para o polling, espera a mensagem em andamento até o
   * prazo e devolve com visibilidade 0 toda mensagem recebida e não concluída.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#receiveAbort?.abort();
    const current = this.#current;
    if (current !== null) {
      const grace = Bun.sleep(this.#options.shutdownGraceMs ?? 25_000).then(() => 'timeout');
      await Promise.race([current.then(() => 'done'), grace]);
    }
    for (const message of [...this.#received.values()]) {
      this.#released.add(idOf(message));
      await this.#changeVisibility(message, 0);
      this.#log.write('info', 'message_released', { sqsMessageId: idOf(message) });
    }
  }

  async #handle(message: Message): Promise<void> {
    try {
      await this.#process(message);
    } catch (error) {
      // Falha ao falar com o SQS (DLQ, ack): sem ack, a mensagem volta pela visibilidade.
      this.#log.write('error', 'message_handling_failed', {
        sqsMessageId: idOf(message),
        error: errorName(error),
      });
    } finally {
      this.#received.delete(idOf(message));
    }
  }

  async #process(message: Message): Promise<void> {
    const { useCase, unitOfWork, clock, metrics } = this.#options;
    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(message.Body);
    } catch (error) {
      return this.#deadLetter(message, classifyReason(error), { sqsMessageId: idOf(message) });
    }
    const fields = {
      messageId: parsed.messageId,
      correlationId: parsed.messageId,
      ...(typeof parsed.data.walletId === 'string' ? { walletId: parsed.data.walletId } : {}),
    };

    try {
      // SPEC 10.2, passo 2: leitura rápida do inbox.
      const known = await unitOfWork.run(({ inbox }) =>
        inbox.find(this.#consumerName, parsed.messageId),
      );
      if (known?.isProcessed() === true) {
        if (!known.hasSamePayload(parsed.payloadHash)) {
          return this.#deadLetter(message, 'INBOX_PAYLOAD_MISMATCH', fields);
        }
        metrics.increment(MESSAGES_DUPLICATE);
        await this.#ack(message);
        this.#log.write('info', 'message_duplicate', fields);
        return;
      }

      const result = await useCase.execute({
        ...parsed.data,
        correlationId: parsed.messageId,
        inbox: InboxMessage.receive({
          consumerName: this.#consumerName,
          messageId: parsed.messageId,
          payloadHash: parsed.payloadHash,
          now: clock.now(),
        }),
      });
      // COMMIT feito pelo caso de uso. Só agora o ack (SPEC 5.8).
      await this.#options.hooks?.afterCommit?.(message);
      await this.#ack(message);
      this.#log.write('info', 'message_processed', {
        ...fields,
        transactionId: result.transactionId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === 'dead-letter') {
        return this.#deadLetter(message, failure.reason, fields);
      }
      // Transitório: sem ack, nova visibilidade com backoff (SPEC 10.3; RN-35).
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      metrics.increment(MESSAGES_RETRIED);
      this.#log.write('warn', 'message_retry', {
        ...fields,
        receiveCount,
        error: errorName(error),
      });
      if (!this.#released.has(idOf(message))) {
        await this.#changeVisibility(message, this.#retryDelaySeconds(receiveCount));
      }
    }
  }

  /** DLQ explícita: envia o corpo original e só então faz o ack (RN-34; ADR-0010). */
  async #deadLetter(message: Message, reason: string, fields: LogFields): Promise<void> {
    await this.#options.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.#options.queues.dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: idOf(message),
        MessageAttributes: { dlqReason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.#ack(message);
    this.#options.metrics.increment(MESSAGES_DEAD_LETTERED);
    this.#log.write('warn', 'message_dead_lettered', { ...fields, reason });
  }

  #ack(message: Message) {
    return this.#options.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.#options.queues.input,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  async #changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.#options.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.#options.queues.input,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // Recibo vencido: a mensagem já voltou à fila pela visibilidade original.
      this.#log.write('warn', 'visibility_change_failed', {
        sqsMessageId: idOf(message),
        error: errorName(error),
      });
    }
  }
}

function classifyReason(error: unknown): string {
  const failure = classifyFailure(error);
  return failure.kind === 'dead-letter' ? failure.reason : 'MALFORMED';
}

function idOf(message: Message): string {
  return message.MessageId ?? '';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown';
}
