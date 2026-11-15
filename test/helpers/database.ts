import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export interface TestDatabase {
  readonly name: string;
  readonly orm: MikroORM;
  execute(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  dispose(): Promise<void>;
}

/**
 * Cria um banco descartável no PostgreSQL do docker compose, para isolar cada
 * arquivo de teste de integração. Sem mocks (AGENTS.md §2.10).
 */
export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const name = `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = await MikroORM.init(createOrmConfig());
  await admin.em.getConnection().execute(`CREATE DATABASE "${name}"`);
  const orm = await MikroORM.init(createOrmConfig({ dbName: name }));

  return {
    name,
    orm,
    execute: (sql, params = []) => orm.em.getConnection().execute(sql, params),
    async dispose() {
      await orm.close(true);
      await admin.em.getConnection().execute(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close(true);
    },
  };
}

/** SQLSTATE de um erro do driver, ou indefinido se não houver. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; sqlState?: unknown };
  if (typeof candidate.sqlState === 'string') return candidate.sqlState;
  if (typeof candidate.code === 'string') return candidate.code;
  return undefined;
}

/** Espera que a promessa falhe com o SQLSTATE indicado e devolve a mensagem do erro. */
export async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const actual = sqlStateOf(error);
    if (actual !== sqlState) {
      throw new Error(`esperava SQLSTATE ${sqlState}, recebeu ${String(actual)}: ${String(error)}`);
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`esperava SQLSTATE ${sqlState}, mas a instrução passou`);
}
