import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DLQ_QUEUE, EVENTS_QUEUE, INPUT_QUEUE, type QueueUrls } from './queues';

/** Credenciais de exemplo do LocalStack. Não são segredo e só valem com endpoint local (ADR-0010). */
const LOCAL_EMULATOR_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

export interface SqsClientOptions {
  /** Ex.: http://127.0.0.1:4566. Ausente: endpoint padrão da AWS. */
  readonly endpoint?: string;
  readonly region?: string;
  /** Tempo máximo por chamada, em ms. */
  readonly requestTimeoutMs?: number;
}

/** Cliente SQS a partir do ambiente: SQS_ENDPOINT e AWS_REGION (ADR-0010). */
export function createSqsClient(options: SqsClientOptions = {}): SQSClient {
  const endpoint = options.endpoint ?? process.env['SQS_ENDPOINT'] ?? defaultLocalEndpoint();
  const region = options.region ?? process.env['AWS_REGION'] ?? 'us-east-1';
  const hasCredentials = process.env['AWS_ACCESS_KEY_ID'] !== undefined;
  return new SQSClient({
    region,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(endpoint !== undefined && !hasCredentials
      ? { credentials: LOCAL_EMULATOR_CREDENTIALS }
      : {}),
    requestHandler: { requestTimeout: options.requestTimeoutMs ?? 5_000 },
    maxAttempts: 1,
  });
}

/** Sem SQS_ENDPOINT, usa o LocalStack do docker compose se LOCALSTACK_PORT existir. */
function defaultLocalEndpoint(): string | undefined {
  const port = process.env['LOCALSTACK_PORT'];
  return port === undefined ? undefined : `http://127.0.0.1:${port}`;
}

/** URLs das filas da SPEC 10.1, que precisam existir. */
export async function resolveQueueUrls(sqs: SQSClient): Promise<QueueUrls> {
  const url = async (QueueName: string) => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName }));
    if (QueueUrl === undefined) throw new Error(`fila ${QueueName} sem URL`);
    return QueueUrl;
  };
  return {
    input: await url(INPUT_QUEUE),
    dlq: await url(DLQ_QUEUE),
    events: await url(EVENTS_QUEUE),
  };
}
