/**
 * Aplica ou reverte as migrations com o migrator do MikroORM (ADR-0001).
 * Uso: bun scripts/db/migrate.ts up | down
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

const command = process.argv[2];
if (command !== 'up' && command !== 'down') {
  console.error('uso: bun scripts/db/migrate.ts up | down');
  process.exit(2);
}

const orm = await MikroORM.init(createOrmConfig());
try {
  const executed = command === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  const names = executed.map((migration) => migration.name);
  console.log(`migrations ${command}: ${names.length === 0 ? 'nada a fazer' : names.join(', ')}`);
} finally {
  await orm.close(true);
}
