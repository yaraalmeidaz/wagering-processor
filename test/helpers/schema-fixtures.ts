import type { TestDatabase } from './database';

/** Inserções mínimas, em SQL, para provar constraints e triggers da SPEC 12. */

export async function insertWallet(
  db: TestDatabase,
  overrides: { id?: string; balance?: string; version?: number } = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  await db.execute(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', ?, ?, now(), now())`,
    [id, crypto.randomUUID(), overrides.balance ?? '100.00', overrides.version ?? 1],
  );
  return id;
}

export interface TransactionRow {
  id?: string;
  walletId: string;
  kind: string;
  status: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string | null;
  resultingBalance?: string | null;
  failureCode?: string | null;
}

export async function insertTransaction(db: TestDatabase, row: TransactionRow): Promise<string> {
  const id = row.id ?? crypto.randomUUID();
  const external = row.externalTransactionId ?? `ext-${id}`;
  await db.execute(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       status, failure_code, resulting_balance, created_at
     ) VALUES (?, 'provider-1', ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, '25.00', 'BRL', ?, ?, ?, ?, now())`,
    [
      id,
      external,
      `provider-1:${external}`,
      'a'.repeat(64),
      row.walletId,
      crypto.randomUUID(),
      row.kind,
      row.referenceExternalTransactionId ?? null,
      row.status,
      row.failureCode ?? null,
      row.resultingBalance === undefined ? '75.00' : row.resultingBalance,
    ],
  );
  return id;
}
