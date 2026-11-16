import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { REFERENCE_TTL_MS } from '../../src/domain/pending-reference-backoff';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { ledgerInvariant, seedWallet } from '../helpers/wallet-seed';
import {
  attemptsById,
  eventsById,
  ledgerEntriesById,
  pendingFactory,
  type ResolverOutput,
  spawnResolvers,
  statusById,
} from './support/pending-reference-fixtures';

// SPEC 8.2 e 15.3 g; Parte 3, Fase 7; RN-12, RN-16; ADR-0007; AGENTS.md §2.9 (3 processos).
const THREE = ['normal', 'normal', 'normal'] as const;

describe('três resolvedores de PENDING_REFERENCE em processos reais', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('conc_reference_out_of_order');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  async function runThree(): Promise<ResolverOutput[]> {
    const runs = await spawnResolvers(db, THREE);
    for (const run of runs) expect(run.exitCode, run.stderr).toBe(0);
    return runs.map((run) => {
      if (run.output === null) throw new Error(`processo ${run.pid} sem saída: ${run.stderr}`);
      return run.output;
    });
  }

  test('mesma transação pendente: os três tentam, um processa, um crédito e um evento', async () => {
    const factory = pendingFactory(uow);
    const wallet = await seedWallet(uow, '100.00');
    const pending = await factory.reversal(wallet, '25.00');
    await factory.betArrives(pending, '25.00');

    const outputs = await runThree();

    // Disputa real: cada processo tentou a linha e registrou um resultado para ela.
    const tries = outputs.map((output) =>
      output.results.filter((r) => r.id === pending.id).map((r) => r.outcome),
    );
    expect(tries.every((outcomes) => outcomes.length === 1)).toBe(true);
    const outcomes = tries.flat().sort();
    expect(outcomes).toEqual(['PROCESSED', 'SKIPPED', 'SKIPPED']);
    const winners = outputs.filter((o) =>
      o.results.some((r) => r.id === pending.id && r.outcome === 'PROCESSED'),
    );
    expect(winners).toHaveLength(1);

    expect((await statusById(db, [pending.id])).get(pending.id)).toBe('PROCESSED');
    expect((await ledgerEntriesById(db, [pending.id])).get(pending.id)).toBe(1);
    const events = await eventsById(db, [pending.id]);
    expect(events.get(`${pending.id}/WagerTransactionProcessed`)).toBe(1);
    expect(events.get(`${pending.id}/WalletBalanceChanged`)).toBe(1);
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  }, 60_000);

  test('wallets diferentes: cada pendência é tentada pelos três e processada uma vez', async () => {
    const factory = pendingFactory(uow);
    const items = [];
    const wallets = [];
    for (let w = 0; w < 10; w += 1) {
      const wallet = await seedWallet(uow, '100.00');
      wallets.push(wallet);
      for (let r = 0; r < 3; r += 1) items.push(await factory.reversal(wallet, '5.00'));
    }
    for (const item of items) await factory.betArrives(item, '5.00');
    const ids = items.map((item) => item.id);

    const outputs = await runThree();

    const attempts = attemptsById(outputs);
    for (const id of ids) {
      expect((attempts.get(id) ?? []).sort()).toEqual(['PROCESSED', 'SKIPPED', 'SKIPPED']);
    }
    const processedBy = outputs.map(
      (o) => o.results.filter((r) => r.outcome === 'PROCESSED').length,
    );
    expect(processedBy.reduce((a, b) => a + b, 0)).toBe(items.length);
    console.log(`PROCESSED por processo: ${JSON.stringify(processedBy)}`);

    const ledger = await ledgerEntriesById(db, ids);
    const events = await eventsById(db, ids);
    for (const id of ids) {
      expect(ledger.get(id)).toBe(1);
      expect(events.get(`${id}/WagerTransactionProcessed`)).toBe(1);
      expect(events.get(`${id}/WalletBalanceChanged`)).toBe(1);
    }
    for (const wallet of wallets) {
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    }
  }, 60_000);

  test('REFUND e ROLLBACK pendentes sobre a mesma BET: um processa, o outro é REFERENCE_ALREADY_REVERSED (RN-16)', async () => {
    const factory = pendingFactory(uow);
    const wallet = await seedWallet(uow, '100.00');
    const refund = await factory.reversal(wallet, '40.00', 'REFUND');
    const rollback = await factory.reversal(wallet, '40.00', 'ROLLBACK', refund.betExternalId);
    await factory.betArrives(refund, '40.00');
    const ids = [refund.id, rollback.id];

    const outputs = await runThree();

    const attempts = attemptsById(outputs);
    for (const id of ids) expect(attempts.get(id)).toHaveLength(3);
    const statuses = [...(await statusById(db, ids)).values()].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED:REFERENCE_ALREADY_REVERSED']);
    const ledger = await ledgerEntriesById(db, ids);
    expect([...ledger.values()]).toEqual([1]);
    // BET de 40,00 debitada e uma única reversão creditada: volta a 100,00.
    const [row] = await db.execute(`SELECT balance_amount::text AS b FROM wallets WHERE id = ?`, [
      wallet.id,
    ]);
    expect(row?.['b']).toBe('100.00');
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  }, 60_000);

  test('ROLLBACK sem BET depois de 24 h: um REJECTED com REFERENCE_NOT_FOUND e um evento', async () => {
    const factory = pendingFactory(uow, REFERENCE_TTL_MS + 600_000);
    const wallet = await seedWallet(uow, '100.00');
    const orphan = await factory.reversal(wallet, '10.00');

    const outputs = await runThree();

    expect((attemptsById(outputs).get(orphan.id) ?? []).sort()).toEqual([
      'REJECTED',
      'SKIPPED',
      'SKIPPED',
    ]);
    expect((await statusById(db, [orphan.id])).get(orphan.id)).toBe('REJECTED:REFERENCE_NOT_FOUND');
    expect((await ledgerEntriesById(db, [orphan.id])).get(orphan.id)).toBeUndefined();
    expect((await eventsById(db, [orphan.id])).get(`${orphan.id}/WagerTransactionRejected`)).toBe(
      1,
    );
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  }, 60_000);
});
