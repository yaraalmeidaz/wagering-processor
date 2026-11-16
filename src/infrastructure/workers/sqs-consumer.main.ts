/** Processo do consumer de wager-transactions.fifo (SPEC 2.6 e 10; ADR-0010). */
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { InstrumentedProcessWager } from '../../observability/instrumented-process-wager';
import { stdoutLogSink } from '../../observability/log-sink';
import { InMemoryMetrics } from '../../observability/metrics';
import { startMetricsServer } from '../../observability/metrics-server';
import { createSqsClient, resolveQueueUrls } from '../messaging/sqs-client';
import { SqsWagerConsumer } from '../messaging/sqs-wager-consumer';
import { createOrmConfig } from '../persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../system-clock';

const orm = await MikroORM.init(createOrmConfig());
const sqs = createSqsClient({ requestTimeoutMs: 30_000 });
const queues = await resolveQueueUrls(sqs);
// Cada execução do caso de uso usa um em.fork() novo (MikroOrmUnitOfWork; AGENTS.md §2.12).
const unitOfWork = new MikroOrmUnitOfWork(orm.em);
const clock = new SystemClock();
const metrics = new InMemoryMetrics();
// ADR-0011: GET /metrics só com METRICS_PORT.
const metricsServer = startMetricsServer(metrics);
const consumer = new SqsWagerConsumer({
  sqs,
  queues,
  // ADR-0011: o mesmo ponto de medição da API.
  useCase: new InstrumentedProcessWager(new ProcessWagerTransaction({ unitOfWork, clock }), {
    metrics,
    sink: stdoutLogSink,
    clock,
  }),
  unitOfWork,
  clock,
  metrics,
  sink: stdoutLogSink,
});

// SPEC 10.4: para o polling, espera a mensagem em andamento e devolve as não concluídas.
process.once('SIGTERM', () => {
  void consumer.stop().then(async () => {
    await consumer.stopped;
    await metricsServer?.stop();
    sqs.destroy();
    await orm.close(true);
    process.exit(0);
  });
});

consumer.start();
