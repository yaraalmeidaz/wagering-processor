/**
 * Filas isoladas por teste no LocalStack real (ADR-0010). Mesmo formato da SPEC 10.1:
 * FIFO, DLQ com redrive. Sem mock de fila (AGENTS.md §2.10).
 */
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  QueueDoesNotExist,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  DLQ_QUEUE,
  EVENTS_QUEUE,
  INPUT_QUEUE,
  MAX_RECEIVE_COUNT,
  type QueueUrls,
} from '../../src/infrastructure/messaging/queues';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';

/** LocalStack do docker compose, ou SQS_ENDPOINT quando definido (CI). */
export function testSqsEndpoint(): string {
  return (
    process.env['SQS_ENDPOINT'] ?? `http://127.0.0.1:${process.env['LOCALSTACK_PORT'] ?? '4566'}`
  );
}

/**
 * Os processos reais (src/main.ts e o publisher) resolvem as filas da SPEC 10.1 ao subir.
 * No ambiente local o script do LocalStack já as criou com os atributos dele; na CI o
 * LocalStack sobe sem esse script, e aqui só se cria a que faltar.
 */
export async function ensureSpecQueues(): Promise<void> {
  const sqs = createSqsClient({ endpoint: testSqsEndpoint() });
  try {
    for (const QueueName of [DLQ_QUEUE, INPUT_QUEUE, EVENTS_QUEUE]) {
      try {
        await sqs.send(new GetQueueUrlCommand({ QueueName }));
      } catch (error) {
        if (!(error instanceof QueueDoesNotExist)) throw error;
        await sqs.send(new CreateQueueCommand({ QueueName, Attributes: { FifoQueue: 'true' } }));
      }
    }
  } finally {
    sqs.destroy();
  }
}

export interface TestQueues extends QueueUrls {
  readonly sqs: SQSClient;
  dispose(): Promise<void>;
}

export async function createTestQueues(
  prefix: string,
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const sqs = createSqsClient({ endpoint: testSqsEndpoint() });
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const create = async (name: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `${prefix}-${id}-${name}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
          ...attributes,
        },
      }),
    );
    if (QueueUrl === undefined) throw new Error(`fila ${name} sem URL`);
    return QueueUrl;
  };
  const dlq = await create('dlq');
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  const input = await create('in', {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount: String(options.maxReceiveCount ?? MAX_RECEIVE_COUNT),
    }),
  });
  const events = await create('events');
  return {
    sqs,
    input,
    dlq,
    events,
    async dispose() {
      for (const QueueUrl of [input, dlq, events]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      }
      sqs.destroy();
    },
  };
}

let sharedReadiness: Promise<{ client: SQSClient; inputQueueUrl: string }> | null = null;

/** Fila FIFO real usada só pela readiness dos testes HTTP. CreateQueue é idempotente. */
export function readinessSqs(): Promise<{ client: SQSClient; inputQueueUrl: string }> {
  sharedReadiness ??= (async () => {
    const client = createSqsClient({ endpoint: testSqsEndpoint() });
    const { QueueUrl } = await client.send(
      new CreateQueueCommand({
        QueueName: 'test-readiness.fifo',
        Attributes: { FifoQueue: 'true' },
      }),
    );
    if (QueueUrl === undefined) throw new Error('fila de readiness sem URL');
    return { client, inputQueueUrl: QueueUrl };
  })();
  return sharedReadiness;
}

/** Envia uma mensagem de entrada da SPEC 10.1. */
export function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: unknown,
  groupId: string,
  deduplicationId: string = crypto.randomUUID(),
) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

/** Lê e apaga todas as mensagens visíveis da fila, na ordem de entrega. */
export async function drainQueue(
  sqs: SQSClient,
  queueUrl: string,
  options: { waitSeconds?: number; deleteMessages?: boolean } = {},
): Promise<Message[]> {
  const messages: Message[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: options.waitSeconds ?? 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) return messages;
    messages.push(...Messages);
    if (options.deleteMessages !== false) {
      for (const message of Messages) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
  }
}

/** Mensagens na fila: visíveis e em andamento (recebidas e ainda não apagadas). */
export async function queueDepth(
  sqs: SQSClient,
  queueUrl: string,
): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes['ApproximateNumberOfMessages'] ?? 0),
    inFlight: Number(Attributes['ApproximateNumberOfMessagesNotVisible'] ?? 0),
  };
}

/** Corpo de WagerTransactionRequested (SPEC 10.1). */
export function wagerMessage(
  data: Record<string, unknown>,
  messageId: string = crypto.randomUUID(),
): Record<string, unknown> {
  return {
    type: 'WagerTransactionRequested',
    messageId,
    occurredAt: new Date().toISOString(),
    data,
  };
}
