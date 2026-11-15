import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import type { TestDatabase } from './database';

/** Cria uma wallet com OPENING e lançamento de crédito (RN-04), pelos repositórios reais. */
export async function seedWallet(
  uow: UnitOfWork,
  initial: string,
  currency = 'BRL',
): Promise<Wallet> {
  const now = new Date();
  const openingId = crypto.randomUUID();
  const { wallet, openingEntry } = Wallet.create({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency,
    initialBalance: Money.create(initial, currency),
    opening: { entryId: crypto.randomUUID(), transactionId: openingId },
    now,
  });
  await uow.run(async ({ wallets, transactions, ledger }) => {
    await wallets.add(wallet);
    if (openingEntry !== null) {
      const opening = WagerTransaction.create({
        id: openingId,
        providerId: 'internal',
        externalTransactionId: `opening-${wallet.id}`,
        idempotencyKey: `internal:opening-${wallet.id}`,
        payloadHash: '0'.repeat(64),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'opening',
        gameId: 'opening',
        kind: 'OPENING',
        money: wallet.balance,
        referenceExternalTransactionId: null,
        createdAt: now,
      });
      opening.markProcessed(wallet.balance, now);
      await transactions.add(opening);
      await ledger.append(openingEntry);
    }
  });
  return wallet;
}

/**
 * Invariante final de todo teste (enunciado §13, Testes obrigatórios; SPEC 15.4; AGENTS.md §9): o saldo da wallet é
 * igual ao saldo reconstruído pelo ledger, sem usar balance_after.
 */
export async function ledgerInvariant(
  db: TestDatabase,
  walletId: string,
): Promise<{ stored: string; reconstructed: string; consistent: boolean }> {
  const rows = await db.execute(
    `SELECT w.balance_amount::text AS stored,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS reconstructed,
            w.balance_amount = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ?
      GROUP BY w.balance_amount`,
    [walletId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`wallet ${walletId} não encontrada`);
  return {
    stored: String(row['stored']),
    reconstructed: String(row['reconstructed']),
    consistent: row['consistent'] === true,
  };
}

/** Direções dos lançamentos da wallet, em ordem alfabética (não dependem do relógio). */
export async function ledgerDirections(db: TestDatabase, walletId: string): Promise<string[]> {
  const rows = await db.execute(
    `SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY direction`,
    [walletId],
  );
  return rows.map((row) => String(row['direction']));
}
