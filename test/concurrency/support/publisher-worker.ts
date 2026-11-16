/**
 * Processo de publisher para os testes de concorrência (SPEC 11.3 e 11.5; ADR-0006).
 * Uso: bun publisher-worker.ts <dbName> <eventsQueueUrl> <startAtEpochMs> <normal|die-after-send>
 * Publica até não sobrar pendente devido e imprime { pid, sent } (eventIds com ack).
 * Em die-after-send, morre com SIGKILL entre o ack do primeiro envio e o COMMIT.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxPublisher } from '../../../src/infrastructure/messaging/outbox-publisher';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { PostgresOutboxPublicationStore } from '../../../src/infrastructure/persistence/postgres-outbox-publication-store';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { SystemClock } from '../../helpers/clock';
import { testSqsEndpoint } from '../../helpers/sqs';

const [dbName, eventsQueueUrl, start, mode] = process.argv.slice(2);
if (dbName === undefined || eventsQueueUrl === undefined || start === undefined) {
  console.error('uso: bun publisher-worker.ts <dbName> <eventsQueueUrl> <startAt> <modo>');
  process.exit(2);
}

const orm = await MikroORM.init(createOrmConfig({ dbName }));
const sqs = createSqsClient({ endpoint: testSqsEndpoint() });
const store = new PostgresOutboxPublicationStore(orm);
const sent: string[] = [];
const publisher = new OutboxPublisher({
  store,
  sqs,
  eventsQueueUrl,
  clock: new SystemClock(),
  metrics: new InMemoryMetrics(),
  sink: { write: () => {} },
  hooks: {
    afterSend: (message) => {
      if (mode === 'die-after-send') process.kill(process.pid, 'SIGKILL');
      sent.push(message.id);
    },
  },
});

await Bun.sleep(Math.max(0, Number(start) - Date.now()));
const deadline = Date.now() + 30_000;
let idle = 0;
while (Date.now() < deadline && idle < 3) {
  const { published } = await publisher.publishOnce();
  const due = await store.dueAggregates(1);
  idle = published === 0 && due.length === 0 ? idle + 1 : 0;
  if (published === 0) await Bun.sleep(100);
}
console.log(JSON.stringify({ pid: process.pid, sent }));
sqs.destroy();
await orm.close(true);
