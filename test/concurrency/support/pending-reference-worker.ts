/**
 * Processo resolvedor de PENDING_REFERENCE para os testes de concorrência (SPEC 8.2; ADR-0007).
 * Uso: bun pending-reference-worker.ts <dbName> <fetchAtEpochMs> <resolveAtEpochMs> <normal|die-after:N>
 * Busca o primeiro lote em fetchAt e só começa a resolver em resolveAt, para todos os
 * processos terem a mesma linha em mãos antes de qualquer um gravar. Depois segue como o
 * worker até não sobrar pendência vencida e imprime { pid, results }.
 * Em die-after:N, morre com SIGKILL logo depois do COMMIT do N-ésimo PROCESSED.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import type { PendingReferenceCandidate } from '../../../src/application/ports/transaction-repository';
import {
  type ResolveOutcome,
  ResolvePendingReference,
} from '../../../src/application/use-cases/resolve-pending-reference';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { PENDING_REFERENCE_BATCH } from '../../../src/infrastructure/workers/pending-reference-resolver';
import { SystemClock } from '../../helpers/clock';

const [dbName, fetchAt, resolveAt, mode = 'normal'] = process.argv.slice(2);
if (dbName === undefined || fetchAt === undefined || resolveAt === undefined) {
  console.error('uso: bun pending-reference-worker.ts <dbName> <fetchAt> <resolveAt> <modo>');
  process.exit(2);
}
const dieAfter = mode.startsWith('die-after:') ? Number(mode.slice('die-after:'.length)) : null;

const orm = await MikroORM.init(createOrmConfig({ dbName }));
const unitOfWork = new MikroOrmUnitOfWork(orm.em);
const resolver = new ResolvePendingReference({ unitOfWork, clock: new SystemClock() });
const due = () =>
  unitOfWork.run(({ transactions }) =>
    transactions.findDueReferenceCandidates(PENDING_REFERENCE_BATCH),
  );

const results: { id: string; outcome: ResolveOutcome }[] = [];
let processed = 0;
async function resolveAll(batch: readonly PendingReferenceCandidate[]): Promise<void> {
  for (const candidate of batch) {
    const { outcome } = await resolver.resolve(candidate);
    results.push({ id: candidate.id, outcome });
    if (outcome === 'PROCESSED') processed += 1;
    if (dieAfter !== null && processed === dieAfter) process.kill(process.pid, 'SIGKILL');
  }
}

await Bun.sleep(Math.max(0, Number(fetchAt) - Date.now()));
const first = await due();
await Bun.sleep(Math.max(0, Number(resolveAt) - Date.now()));
await resolveAll(first);

const deadline = Date.now() + 30_000;
let empty = 0;
while (Date.now() < deadline && empty < 3) {
  const batch = await due();
  empty = batch.length === 0 ? empty + 1 : 0;
  if (batch.length === 0) await Bun.sleep(100);
  else await resolveAll(batch);
}
console.log(JSON.stringify({ pid: process.pid, results }));
await orm.close(true);
