/**
 * Processo de consumer para os testes de queda (SPEC 10.2 e 10.5; ADR-0010).
 * Uso: bun consumer-worker.ts <dbName> <inputUrl> <dlqUrl> <startAtEpochMs> <normal|die-after-commit>
 * Consome até `IDLE_POLLS` recebimentos vazios seguidos e imprime { pid, duplicates }.
 * Em die-after-commit, morre com SIGKILL entre o COMMIT da primeira mensagem e o ack.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import {
  MESSAGES_DUPLICATE,
  SqsWagerConsumer,
} from '../../../src/infrastructure/messaging/sqs-wager-consumer';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { SystemClock } from '../../helpers/clock';
import { testSqsEndpoint } from '../../helpers/sqs';

/** Recebimentos vazios seguidos antes de sair: precisa passar da visibilidade da fila do teste. */
const IDLE_POLLS = 5;

const [dbName, inputUrl, dlqUrl, start, mode] = process.argv.slice(2);
if (dbName === undefined || inputUrl === undefined || dlqUrl === undefined || start === undefined) {
  console.error('uso: bun consumer-worker.ts <dbName> <inputUrl> <dlqUrl> <startAt> <modo>');
  process.exit(2);
}

const orm = await MikroORM.init(createOrmConfig({ dbName }));
const sqs = createSqsClient({ endpoint: testSqsEndpoint() });
const unitOfWork = new MikroOrmUnitOfWork(orm.em);
const clock = new SystemClock();
const metrics = new InMemoryMetrics();
const consumer = new SqsWagerConsumer({
  sqs,
  queues: { input: inputUrl, dlq: dlqUrl },
  useCase: new ProcessWagerTransaction({ unitOfWork, clock }),
  unitOfWork,
  clock,
  metrics,
  sink: { write: () => {} },
  waitTimeSeconds: 1,
  retryDelaySeconds: () => 1,
  hooks: {
    afterCommit: () => {
      if (mode === 'die-after-commit') process.kill(process.pid, 'SIGKILL');
    },
  },
});

await Bun.sleep(Math.max(0, Number(start) - Date.now()));
let idle = 0;
while (idle < IDLE_POLLS) {
  idle = (await consumer.pollOnce()) === 0 ? idle + 1 : 0;
}
console.log(JSON.stringify({ pid: process.pid, duplicates: metrics.value(MESSAGES_DUPLICATE) }));
sqs.destroy();
await orm.close(true);
