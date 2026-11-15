import { Migration } from '@mikro-orm/migrations';

/**
 * Schema mínimo da SPEC 12, com as constraints, índices e triggers que garantem
 * no banco as invariantes do AGENTS.md §2.4 e §2.8 (ADR-0001, ADR-0004, ADR-0006).
 */
export class Migration20261115000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance_amount numeric(19,2) NOT NULL CHECK (balance_amount >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(19,2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text,
        resulting_balance numeric(19,2) CHECK (resulting_balance >= 0),
        attempts integer NOT NULL DEFAULT 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (status <> 'PROCESSED' OR resulting_balance IS NOT NULL),
        CONSTRAINT ck_wager_failure_code_only_rejected
          CHECK (status = 'REJECTED' OR failure_code IS NULL),
        CONSTRAINT ck_wager_rejected_requires_failure_code
          CHECK (status <> 'REJECTED' OR failure_code IS NOT NULL)
      )`);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_single_processed_reversal
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
          AND reference_external_transaction_id IS NOT NULL`);

    this.addSql(`
      CREATE INDEX ix_wager_pending_reference
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(19,2) NOT NULL CHECK (amount > 0),
        balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(19,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        UNIQUE (transaction_id, wallet_id),
        CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )`);

    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries é append-only';
      END;
      $$ LANGUAGE plpgsql`);

    this.addSql(`
      CREATE TRIGGER trg_ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()`);

    this.addSql(`
      CREATE INDEX ix_ledger_wallet_cursor
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC)`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        seq bigserial NOT NULL,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz
      )`);

    this.addSql(`
      CREATE INDEX ix_outbox_pending
        ON outbox_messages (aggregate_id, seq)
        WHERE published_at IS NULL`);

    this.addSql(`
      CREATE FUNCTION forbid_terminal_status_change() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW.status <> OLD.status THEN
          RAISE EXCEPTION 'transação em estado terminal não muda de status';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    this.addSql(`
      CREATE TRIGGER trg_wager_terminal_status
        BEFORE UPDATE OF status ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_terminal_status_change()`);

    // RN-20: o snapshot devolvido no replay não muda depois de PROCESSED ou REJECTED, nem com o mesmo valor.
    this.addSql(`
      CREATE FUNCTION forbid_snapshot_change() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED') THEN
          RAISE EXCEPTION 'resulting_balance de transação PROCESSED ou REJECTED é imutável';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    this.addSql(`
      CREATE TRIGGER trg_wager_snapshot_immutable
        BEFORE UPDATE OF resulting_balance ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_snapshot_change()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER trg_wager_snapshot_immutable ON wager_transactions');
    this.addSql('DROP TRIGGER trg_wager_terminal_status ON wager_transactions');
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_rejected_requires_failure_code',
    );
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_failure_code_only_rejected',
    );
    this.addSql('DROP TRIGGER trg_ledger_append_only ON wallet_ledger_entries');
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
    this.addSql('DROP FUNCTION forbid_snapshot_change()');
    this.addSql('DROP FUNCTION forbid_terminal_status_change()');
    this.addSql('DROP FUNCTION forbid_ledger_mutation()');
  }
}
