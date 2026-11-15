/**
 * Processo separado que executa ProcessWagerTransaction contra o banco de teste.
 * Uso: bun wager-worker.ts <dbName> <startAtEpochMs> <entradas em base64>
 * Imprime uma linha JSON com o resultado de cada entrada.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import type { ProcessWagerInput } from '../../../src/application/use-cases/process-wager-transaction';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../helpers/clock';

const [dbName, startAt, encoded] = process.argv.slice(2);
if (dbName === undefined || startAt === undefined || encoded === undefined) {
  console.error('uso: bun wager-worker.ts <dbName> <startAtEpochMs> <entradas em base64>');
  process.exit(2);
}

const inputs = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ProcessWagerInput[];
const orm = await MikroORM.init(createOrmConfig({ dbName }));
const useCase = new ProcessWagerTransaction({
  unitOfWork: new MikroOrmUnitOfWork(orm.em),
  clock: new SystemClock(),
});

// Todos os processos começam juntos, para maximizar a disputa.
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

const settled = await Promise.allSettled(inputs.map((input) => useCase.execute(input)));
const results = settled.map((outcome) =>
  outcome.status === 'fulfilled'
    ? { ok: true, value: outcome.value }
    : {
        ok: false,
        error: outcome.reason instanceof Error ? outcome.reason.name : 'Unknown',
        message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      },
);
console.log(JSON.stringify({ pid: process.pid, results }));
await orm.close(true);
