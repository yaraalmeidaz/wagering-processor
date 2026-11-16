/**
 * Instâncias reais da API (src/main.ts) em processos separados, sobre o mesmo PostgreSQL
 * (AGENTS.md §2.9 e §2.10). Sem mock de banco nem de fila.
 */
import { createServer } from 'node:net';
import { CreateQueueCommand, GetQueueUrlCommand, QueueDoesNotExist } from '@aws-sdk/client-sqs';
import { DLQ_QUEUE, EVENTS_QUEUE, INPUT_QUEUE } from '../../../src/infrastructure/messaging/queues';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { testSqsEndpoint } from '../../helpers/sqs';

const MAIN = new URL('../../../src/main.ts', import.meta.url);

export interface HttpReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface HttpInstance {
  readonly pid: number;
  readonly baseUrl: string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpReply>;
}

export interface HttpInstances {
  readonly instances: readonly HttpInstance[];
  /** SIGTERM em todas e espera a saída; SIGKILL na que passar do prazo. */
  stop(): Promise<void>;
}

/** Espera a condição ficar verdadeira, sem sleep fixo para o resultado. */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`prazo esgotado esperando ${what}`);
    await Bun.sleep(50);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('porta livre sem endereço'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * O main.ts resolve as filas da SPEC 10.1 ao subir. No ambiente local o script do
 * LocalStack já as criou com os atributos dele; aqui só se cria a que faltar.
 */
async function ensureQueues(): Promise<void> {
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

async function isLive(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/health/live`)).status === 200;
  } catch {
    return false;
  }
}

/** Sobe `count` instâncias da API, cada uma num processo e numa porta, todas no banco `dbName`. */
export async function startHttpInstances(dbName: string, count = 3): Promise<HttpInstances> {
  await ensureQueues();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  // stderr lido desde o início: um pipe cheio travaria o processo.
  const stderrs: Promise<string>[] = [];
  const instances: HttpInstance[] = [];
  for (let i = 0; i < count; i += 1) {
    const port = await freePort();
    const child = Bun.spawn([process.execPath, MAIN.pathname], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        POSTGRES_DB: dbName,
        PORT: String(port),
        SQS_ENDPOINT: testSqsEndpoint(),
      },
    });
    children.push(child);
    stderrs.push(new Response(child.stderr as ReadableStream).text());
    const baseUrl = `http://127.0.0.1:${port}`;
    instances.push({
      pid: child.pid,
      baseUrl,
      async post(path, body, headers = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        return {
          status: response.status,
          body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
        };
      },
    });
  }

  const stop = async () => {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(
      children.map(async (child) => {
        const exited = await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(10_000).then(() => false),
        ]);
        if (!exited) child.kill('SIGKILL');
        await child.exited;
      }),
    );
  };

  try {
    for (const [i, instance] of instances.entries()) {
      await waitFor(
        async () => {
          if (children[i]?.exitCode !== null) {
            const stderr = await stderrs[i];
            throw new Error(`instância ${instance.pid} saiu antes de ficar viva: ${stderr}`);
          }
          return isLive(instance.baseUrl);
        },
        20_000,
        `/health/live da instância ${instance.pid}`,
      );
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { instances, stop };
}
