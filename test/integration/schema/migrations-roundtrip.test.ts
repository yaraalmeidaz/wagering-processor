import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';

// AGENTS.md §11: migration com up e down testados.
const SNAPSHOT_SQL = `
  SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
         || ' default=' || coalesce(column_default, '') AS item
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
  UNION ALL
  SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'mikro_orm_migrations'
  UNION ALL
  SELECT 'index ' || indexname || ' ' || indexdef
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'
  UNION ALL
  SELECT 'trigger ' || tgname || ' ' || pg_get_triggerdef(oid)
    FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL
  SELECT 'function ' || proname || ' ' || md5(pg_get_functiondef(oid))
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  ORDER BY 1`;

const EXPECTED_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

describe('migrations: down e up voltam ao mesmo schema', () => {
  let db: TestDatabase;

  const snapshot = async () => (await db.execute(SNAPSHOT_SQL)).map((row) => String(row['item']));
  const tables = async () =>
    (
      await db.execute(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations' ORDER BY 1`,
      )
    ).map((row) => String(row['table_name']));

  beforeAll(async () => {
    db = await createTestDatabase('schema_roundtrip');
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('up cria as cinco tabelas, os índices e os triggers da SPEC 12', async () => {
    await db.orm.migrator.up();
    expect(await tables()).toEqual(EXPECTED_TABLES);
    const items = await snapshot();
    for (const name of [
      'index uq_wager_single_processed_reversal',
      'index ix_wager_pending_reference',
      'index ix_ledger_wallet_cursor',
      'index ix_outbox_pending',
      'trigger trg_ledger_append_only',
      'trigger trg_wager_terminal_status',
      'trigger trg_wager_snapshot_immutable',
      'function forbid_ledger_mutation',
      'function forbid_terminal_status_change',
      'function forbid_snapshot_change',
      'constraint wager_transactions ck_wager_failure_code_only_rejected',
      'constraint wager_transactions ck_wager_rejected_requires_failure_code',
    ]) {
      expect(items.some((item) => item.startsWith(`${name} `))).toBe(true);
    }
  });

  test('down remove tudo, e up de novo recria o mesmo schema', async () => {
    const afterFirstUp = await snapshot();

    await db.orm.migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    expect(await snapshot()).toEqual([]);

    await db.orm.migrator.up();
    expect(await snapshot()).toEqual(afterFirstUp);
  });
});
