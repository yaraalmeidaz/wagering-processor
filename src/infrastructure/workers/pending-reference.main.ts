/** Processo do resolvedor de PENDING_REFERENCE (SPEC 2.6 e 8.2; ADR-0007). Várias instâncias podem rodar juntas. */
import { MikroORM } from '@mikro-orm/postgresql';
import { ResolvePendingReference } from '../../application/use-cases/resolve-pending-reference';
import { stdoutLogSink } from '../../observability/log-sink';
import { InMemoryMetrics } from '../../observability/metrics';
import { createOrmConfig } from '../persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../system-clock';
import { PendingReferenceWorker } from './pending-reference-resolver';

const orm = await MikroORM.init(createOrmConfig());
// Cada execução usa um em.fork() novo (MikroOrmUnitOfWork; AGENTS.md §2.12).
const unitOfWork = new MikroOrmUnitOfWork(orm.em);
const clock = new SystemClock();
const worker = new PendingReferenceWorker({
  candidates: (limit) =>
    unitOfWork.run(({ transactions }) => transactions.findDueReferenceCandidates(limit)),
  resolver: new ResolvePendingReference({ unitOfWork, clock }),
  clock,
  metrics: new InMemoryMetrics(),
  sink: stdoutLogSink,
});

// O item em andamento termina com COMMIT ou ROLLBACK antes de o processo sair.
process.once('SIGTERM', () => {
  void worker.stop().then(async () => {
    await orm.close(true);
    process.exit(0);
  });
});

worker.start();
