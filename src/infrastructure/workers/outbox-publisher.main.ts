/** Processo do publisher do outbox (SPEC 2.6 e 11.3; ADR-0006). Várias instâncias podem rodar juntas. */
import { MikroORM } from '@mikro-orm/postgresql';
import { stdoutLogSink } from '../../observability/log-sink';
import { InMemoryMetrics } from '../../observability/metrics';
import { OutboxPublisher } from '../messaging/outbox-publisher';
import { createSqsClient, resolveQueueUrls } from '../messaging/sqs-client';
import { createOrmConfig } from '../persistence/mikro-orm.config';
import { PostgresOutboxPublicationStore } from '../persistence/postgres-outbox-publication-store';
import { SystemClock } from '../system-clock';

const orm = await MikroORM.init(createOrmConfig());
const sqs = createSqsClient();
const queues = await resolveQueueUrls(sqs);
const publisher = new OutboxPublisher({
  store: new PostgresOutboxPublicationStore(orm),
  sqs,
  eventsQueueUrl: queues.events,
  clock: new SystemClock(),
  metrics: new InMemoryMetrics(),
  sink: stdoutLogSink,
});

// O ciclo em andamento termina com COMMIT ou ROLLBACK antes de o processo sair.
process.once('SIGTERM', () => {
  void publisher.stop().then(async () => {
    sqs.destroy();
    await orm.close(true);
    process.exit(0);
  });
});

publisher.start();
