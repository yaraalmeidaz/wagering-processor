/** Montagem e consultas comuns aos testes de concorrência de PENDING_REFERENCE (SPEC 8.2; ADR-0007). */
import { expect } from 'bun:test';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import type { ResolveOutcome } from '../../../src/application/use-cases/resolve-pending-reference';
import type { Wallet } from '../../../src/domain/wallet';
import { FakeClock } from '../../helpers/clock';
import type { TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { type ProcessResult, spawnWorker, startAt } from './processes';

const WORKER = new URL('./pending-reference-worker.ts', import.meta.url);

export type ResolverOutput = { pid: number; results: { id: string; outcome: ResolveOutcome }[] };

export interface PendingItem {
  readonly id: string;
  readonly wallet: Wallet;
  readonly betExternalId: string;
}

/**
 * Cria pendências pelo caso de uso real, com relógio no passado para já estarem vencidas.
 * `ageMs` controla created_at (RN-12: TTL de 24 h).
 */
export function pendingFactory(uow: UnitOfWork, ageMs = 600_000) {
  const clock = new FakeClock(new Date(Date.now() - ageMs));
  const processor = new ProcessWagerTransaction({ unitOfWork: uow, clock, random: () => 0.5 });
  return {
    async reversal(
      wallet: Wallet,
      amount: string,
      kind: 'ROLLBACK' | 'REFUND' = 'ROLLBACK',
      betExternalId = `bet-${crypto.randomUUID()}`,
    ): Promise<PendingItem> {
      clock.advance(10);
      const result = await processor.execute(
        betInput(wallet, amount, { kind, referenceExternalTransactionId: betExternalId }),
      );
      expect(result.status).toBe('PENDING_REFERENCE');
      return { id: result.transactionId, wallet, betExternalId };
    },
    /** A BET chega depois da reversão (SPEC 2.5, fluxo C). */
    async betArrives(item: PendingItem, amount: string): Promise<void> {
      const bet = await processor.execute(
        betInput(item.wallet, amount, { externalTransactionId: item.betExternalId }),
      );
      expect(bet.status).toBe('PROCESSED');
    },
  };
}

/** Três ou mais resolvedores reais com as barreiras de busca e de resolução (AGENTS.md §2.9). */
export function spawnResolvers(
  db: TestDatabase,
  modes: readonly string[],
): Promise<ProcessResult<ResolverOutput>[]> {
  const fetchAt = startAt(1_500);
  const resolveAt = String(Number(fetchAt) + 1_000);
  return Promise.all(
    modes.map((mode) => spawnWorker<ResolverOutput>(WORKER, [db.name, fetchAt, resolveAt, mode])),
  );
}

/** Tentativas de cada processo sobre cada transação: id -> outcomes, um por processo que tentou. */
export function attemptsById(outputs: readonly ResolverOutput[]): Map<string, ResolveOutcome[]> {
  const byId = new Map<string, ResolveOutcome[]>();
  for (const output of outputs) {
    for (const { id, outcome } of output.results) byId.set(id, [...(byId.get(id) ?? []), outcome]);
  }
  return byId;
}

export async function statusById(db: TestDatabase, ids: readonly string[]) {
  const rows = await db.execute(
    `SELECT id, status, failure_code FROM wager_transactions WHERE id IN (?)`,
    [ids],
  );
  return new Map(
    rows.map((r) => [
      String(r['id']),
      r['failure_code'] === null ? String(r['status']) : `${r['status']}:${r['failure_code']}`,
    ]),
  );
}

/** Lançamentos do ledger por transação. */
export async function ledgerEntriesById(db: TestDatabase, ids: readonly string[]) {
  const rows = await db.execute(
    `SELECT transaction_id, count(*)::int AS n FROM wallet_ledger_entries
      WHERE transaction_id IN (?) GROUP BY transaction_id`,
    [ids],
  );
  return new Map(rows.map((r) => [String(r['transaction_id']), Number(r['n'])]));
}

/** Eventos do outbox por transação e tipo: `${id}/${eventType}` -> quantidade. */
export async function eventsById(db: TestDatabase, ids: readonly string[]) {
  const rows = await db.execute(
    `SELECT payload->'data'->>'transactionId' AS id, event_type, count(*)::int AS n
       FROM outbox_messages
      WHERE payload->'data'->>'transactionId' IN (?)
      GROUP BY 1, 2`,
    [ids],
  );
  return new Map(rows.map((r) => [`${r['id']}/${r['event_type']}`, Number(r['n'])]));
}
