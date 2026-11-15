import { fileURLToPath } from 'node:url';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { ORM_ENTITIES } from './entities';

/** Diretório versionado das migrations (AGENTS.md §7). */
export const MIGRATIONS_PATH = fileURLToPath(new URL('../../../migrations', import.meta.url));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`variável de ambiente ${name} não definida (veja .env.example)`);
  }
  return value;
}

/** Configuração do MikroORM com PostgreSQL e migrator (ADR-0001). Credenciais vêm do ambiente. */
export function createOrmConfig(overrides: { dbName?: string } = {}) {
  return defineConfig({
    host: process.env['POSTGRES_HOST'] ?? '127.0.0.1',
    port: Number(process.env['POSTGRES_PORT'] ?? '5432'),
    user: requiredEnv('POSTGRES_USER'),
    password: requiredEnv('POSTGRES_PASSWORD'),
    dbName: overrides.dbName ?? requiredEnv('POSTGRES_DB'),
    entities: ORM_ENTITIES,
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      glob: '!(*.d).ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
  });
}
