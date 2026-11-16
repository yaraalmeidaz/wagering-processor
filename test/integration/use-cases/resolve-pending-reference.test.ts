import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Repositories, UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { ResolvePendingReference } from '../../../src/application/use-cases/resolve-pending-reference';
import { REFERENCE_TTL_MS } from '../../../src/domain/pending-reference-backoff';
import type { Wallet } from '../../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { FakeClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// SPEC 8.2 a 8.5; RN-12; ADR-0007: o resolvedor usa o mesmo caminho de regras do caso de uso.
const START = new Date('2026-01-01T00:00:00.000Z');
const JITTER_ZERO = () => 0.5;

/**
 * Repositórios reais; só `hasProcessedReversal` ganha um efeito depois da leitura,
 * para reproduzir a reversão concorrente que chega ao commit primeiro (SPEC 6.3).
 */
class RacingReversalUnitOfWork implements UnitOfWork {
  readonly #inner: UnitOfWork;
  #race: (() => Promise<void>) | null;

  constructor(inner: UnitOfWork, race: () => Promise<void>) {
    this.#inner = inner;
    this.#race = race;
  }

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.#inner.run((repositories) => {
      const transactions = repositories.transactions;
      const hasProcessedReversal: Repositories['transactions']['hasProcessedReversal'] = async (
        providerId,
        reference,
      ) => {
        const answer = await transactions.hasProcessedReversal(providerId, reference);
        const race = this.#race;
        this.#race = null;
        if (race !== null) await race();
        return answer;
      };
      // Proxy repassa as chamadas ao repositório real, que usa campos privados.
      const racing = new Proxy(transactions, {
        get(target, property) {
          if (property === 'hasProcessedReversal') return hasProcessedReversal;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return work({ ...repositories, transactions: racing });
    });
  }
}

describe('ResolvePendingReference (SPEC 8.2)', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('usecase_resolve_pending');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  function setup(unitOfWork: UnitOfWork = uow) {
    const clock = new FakeClock(START);
    return {
      clock,
      processor: new ProcessWagerTransaction({ unitOfWork: uow, clock, random: JITTER_ZERO }),
      resolver: new ResolvePendingReference({ unitOfWork, clock, random: JITTER_ZERO }),
    };
  }

  /** ROLLBACK antes da BET: fica PENDING_REFERENCE (RN-12; SPEC 8.1). */
  async function pendingRollback(
    processor: ProcessWagerTransaction,
    wallet: Wallet,
    amount: string,
  ): Promise<{ id: string; walletId: string; betExternalId: string }> {
    const betExternalId = `bet-${crypto.randomUUID()}`;
    const result = await processor.execute(
      betInput(wallet, amount, { kind: 'ROLLBACK', referenceExternalTransactionId: betExternalId }),
    );
    expect(result.status).toBe('PENDING_REFERENCE');
    return { id: result.transactionId, walletId: wallet.id, betExternalId };
  }

  async function row(id: string) {
    const [found] = await db.execute(
      `SELECT status, failure_code, attempts, next_reference_attempt_at, processed_at,
              resulting_balance::text AS resulting_balance, reference_transaction_id, xmin::text AS xmin
         FROM wager_transactions WHERE id = ?`,
      [id],
    );
    if (found === undefined) throw new Error(`transação ${id} não encontrada`);
    return {
      status: String(found['status']),
      failureCode: found['failure_code'] === null ? null : String(found['failure_code']),
      attempts: Number(found['attempts']),
      nextAttemptAt: new Date(String(found['next_reference_attempt_at'])),
      processedAt: found['processed_at'],
      resultingBalance:
        found['resulting_balance'] === null ? null : String(found['resulting_balance']),
      referenceTransactionId: found['reference_transaction_id'],
      xmin: String(found['xmin']),
    };
  }

  async function outbox(walletId: string) {
    return (
      await db.execute(
        `SELECT event_type, xmin::text AS xmin FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq`,
        [walletId],
      )
    ).map((r) => ({ eventType: String(r['event_type']), xmin: String(r['xmin']) }));
  }

  async function walletRow(walletId: string) {
    const [found] = await db.execute(
      `SELECT balance_amount::text AS balance, xmin::text AS xmin FROM wallets WHERE id = ?`,
      [walletId],
    );
    return { balance: String(found?.['balance']), xmin: String(found?.['xmin']) };
  }

  async function ledgerXmin(transactionId: string): Promise<string[]> {
    return (
      await db.execute(
        `SELECT xmin::text AS xmin FROM wallet_ledger_entries WHERE transaction_id = ?`,
        [transactionId],
      )
    ).map((r) => String(r['xmin']));
  }

  describe('referência encontrada', () => {
    test('ROLLBACK credita; transação, wallet, ledger e eventos na mesma transação SQL (SPEC 8.2; AGENTS.md §2.7)', async () => {
      const { processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      const bet = await processor.execute(
        betInput(wallet, '30.00', { externalTransactionId: pending.betExternalId }),
      );
      expect(bet.balance?.amount).toBe('70.00');
      const before = (await outbox(wallet.id)).length;

      const result = await resolver.resolve(pending);

      expect(result.outcome).toBe('PROCESSED');
      const resolved = await row(pending.id);
      expect(resolved).toMatchObject({
        status: 'PROCESSED',
        failureCode: null,
        resultingBalance: '100.00',
        referenceTransactionId: bet.transactionId,
      });
      const events = (await outbox(wallet.id)).slice(before);
      expect(events.map((e) => e.eventType)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      // xmin igual: as linhas foram escritas pela mesma transação SQL do efeito.
      const walletAfter = await walletRow(wallet.id);
      expect(walletAfter.balance).toBe('100.00');
      for (const event of events) expect(event.xmin).toBe(resolved.xmin);
      expect(walletAfter.xmin).toBe(resolved.xmin);
      expect(await ledgerXmin(pending.id)).toEqual([resolved.xmin]);
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    });

    test('referência inválida segue a SPEC 4.2: valor diferente é REFERENCE_AMOUNT_MISMATCH (RN-15)', async () => {
      const { processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      await processor.execute(
        betInput(wallet, '20.00', { externalTransactionId: pending.betExternalId }),
      );
      const before = (await outbox(wallet.id)).length;

      expect((await resolver.resolve(pending)).outcome).toBe('REJECTED');

      const rejected = await row(pending.id);
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_AMOUNT_MISMATCH',
        resultingBalance: '80.00',
      });
      const events = (await outbox(wallet.id)).slice(before);
      expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
      expect(events[0]?.xmin).toBe(rejected.xmin);
      expect((await walletRow(wallet.id)).balance).toBe('80.00');
    });
  });

  describe('referência ausente (RN-12; ADR-0007)', () => {
    test('tentativa que não é a última reagenda com a espera da próxima, sem evento', async () => {
      const { clock, processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      const before = await outbox(wallet.id);
      clock.advance(10_000);

      expect((await resolver.resolve(pending)).outcome).toBe('RESCHEDULED');

      const rescheduled = await row(pending.id);
      expect(rescheduled.status).toBe('PENDING_REFERENCE');
      expect(rescheduled.attempts).toBe(1);
      // Tentativa 1 falhou: a próxima é a 2, com espera de 4 s sem jitter (ADR-0007).
      expect(rescheduled.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 4_000));
      expect(await outbox(wallet.id)).toEqual(before);
    });

    test('a 12ª tentativa sem referência vira REJECTED com REFERENCE_NOT_FOUND e WagerTransactionRejected', async () => {
      const { processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      for (let attempt = 1; attempt <= 11; attempt += 1) {
        expect((await resolver.resolve(pending)).outcome).toBe('RESCHEDULED');
      }
      expect((await row(pending.id)).attempts).toBe(11);
      const before = (await outbox(wallet.id)).length;

      expect((await resolver.resolve(pending)).outcome).toBe('REJECTED');

      const rejected = await row(pending.id);
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        attempts: 11,
        resultingBalance: '100.00',
      });
      const events = (await outbox(wallet.id)).slice(before);
      expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
      expect(events[0]?.xmin).toBe(rejected.xmin);
      expect((await walletRow(wallet.id)).balance).toBe('100.00');
    });

    test('depois de 24 h, a tentativa é a última: sem referência, REJECTED já na primeira', async () => {
      const { clock, processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      clock.advance(REFERENCE_TTL_MS);

      expect((await resolver.resolve(pending)).outcome).toBe('REJECTED');
      expect(await row(pending.id)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        attempts: 0,
      });
    });

    test('depois de 24 h, a última tentativa que encontra a referência processa (decisão B da ADR-0007)', async () => {
      const { clock, processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      clock.advance(REFERENCE_TTL_MS + 60_000);
      await processor.execute(
        betInput(wallet, '30.00', { externalTransactionId: pending.betExternalId }),
      );

      expect((await resolver.resolve(pending)).outcome).toBe('PROCESSED');
      expect(await row(pending.id)).toMatchObject({ status: 'PROCESSED', failureCode: null });
      expect((await walletRow(wallet.id)).balance).toBe('100.00');
    });
  });

  describe('linhas que não podem ser tratadas', () => {
    test('terminal ou não vencida: SKIPPED, sem mudança', async () => {
      const { processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      await processor.execute(
        betInput(wallet, '30.00', { externalTransactionId: pending.betExternalId }),
      );
      expect((await resolver.resolve(pending)).outcome).toBe('PROCESSED');
      const settled = await row(pending.id);
      expect((await resolver.resolve(pending)).outcome).toBe('SKIPPED');
      expect(await row(pending.id)).toEqual(settled);

      const notDue = await pendingRollback(processor, wallet, '10.00');
      await db.execute(
        `UPDATE wager_transactions SET next_reference_attempt_at = now() + interval '1 hour' WHERE id = ?`,
        [notDue.id],
      );
      const untouched = await row(notDue.id);
      expect((await resolver.resolve(notDue)).outcome).toBe('SKIPPED');
      expect(await row(notDue.id)).toEqual(untouched);
    });
  });

  describe('erros (ADR-0007)', () => {
    test('transitório (lock_timeout) não consome tentativa e adia com CAS', async () => {
      const { clock, processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      clock.advance(3_600_000);

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => {};
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = uow.run(async ({ wallets }) => {
        await wallets.findByIdForUpdate(wallet.id);
        locked();
        await held;
      });

      try {
        await isLocked;
        const result = await resolver.resolve(pending);
        expect(result.outcome).toBe('POSTPONED');
      } finally {
        release();
      }
      await holder;

      const postponed = await row(pending.id);
      expect(postponed.status).toBe('PENDING_REFERENCE');
      expect(postponed.attempts).toBe(0);
      // Espera da tentativa attempts + 1 = 1: 2 s sem jitter, a partir do relógio.
      expect(postponed.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 2_000));
    }, 15_000);

    // Rede de segurança, não fluxo esperado (ADR-0004): pela RN-14 toda reversão PROCESSED da
    // referência está na mesma wallet, e o lock da wallet serializa as duas. O teste grava uma
    // reversão PROCESSED em outra wallet, estado que os fluxos atuais não produzem, só para
    // provar que o índice segura e que o resolvedor responde REFERENCE_ALREADY_REVERSED.
    test('rede de segurança: 23505 do índice de reversão vira REFERENCE_ALREADY_REVERSED em transação nova (RN-16; SPEC 6.3; ADR-0004)', async () => {
      const wallet = await seedWallet(uow, '100.00');
      const plain = setup();
      const pending = await pendingRollback(plain.processor, wallet, '30.00');
      await plain.processor.execute(
        betInput(wallet, '30.00', { externalTransactionId: pending.betExternalId }),
      );
      // Linha gravada entre a checagem da RN-16 e o UPDATE do resolvedor. Em outra wallet,
      // porque na mesma ela esperaria o lock (ADR-0003) e não haveria corrida.
      const other = await seedWallet(uow, '10.00');
      const racing = new RacingReversalUnitOfWork(uow, async () => {
        const id = crypto.randomUUID();
        await db.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
             payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
             reference_external_transaction_id, status, resulting_balance, attempts, created_at, processed_at)
           VALUES (?, 'provider-1', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'REFUND', 30.00, 'BRL',
             ?, 'PROCESSED', 100.00, 0, now(), now())`,
          [
            id,
            `refund-${id}`,
            `provider-1:refund-${id}`,
            'b'.repeat(64),
            other.id,
            other.playerId,
            pending.betExternalId,
          ],
        );
      });
      const { resolver } = setup(racing);
      const before = (await outbox(wallet.id)).length;

      expect((await resolver.resolve(pending)).outcome).toBe('REJECTED');

      const rejected = await row(pending.id);
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
        resultingBalance: '70.00',
      });
      // A tentativa que recebeu o 23505 não deixou evento nem crédito.
      const events = (await outbox(wallet.id)).slice(before);
      expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
      expect(events[0]?.xmin).toBe(rejected.xmin);
      expect((await walletRow(wallet.id)).balance).toBe('70.00');
      expect(await ledgerXmin(pending.id)).toEqual([]);
    });

    test('erro permanente do banco aborta a tentativa: FAILED em transação nova, sem evento nem crédito (RN-41; ADR-0007)', async () => {
      const { processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      await processor.execute(
        betInput(wallet, '30.00', { externalTransactionId: pending.betExternalId }),
      );
      // Lançamento já gravado para a pendência: o append do resolvedor recebe o 23505 de
      // UNIQUE (transaction_id, wallet_id), que não é o índice de reversão, e a transação aborta.
      await db.execute(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', 1.00, 0.00, 1.00, now())`,
        [crypto.randomUUID(), wallet.id, pending.id],
      );
      const before = await outbox(wallet.id);

      const result = await resolver.resolve(pending);

      expect(result.outcome).toBe('FAILED');
      const failed = await row(pending.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.failureCode).toBeNull();
      expect(await outbox(wallet.id)).toEqual(before);
      expect((await walletRow(wallet.id)).balance).toBe('70.00');
    });

    test('linha que não reidrata é erro permanente: FAILED sem failureCode e sem evento (RN-40, RN-41)', async () => {
      const { processor, resolver } = setup();
      const wallet = await seedWallet(uow, '100.00');
      const pending = await pendingRollback(processor, wallet, '30.00');
      // Dado gravado que o domínio recusa: moeda fora do padrão ISO-4217.
      await db.execute(`UPDATE wager_transactions SET currency = 'br1' WHERE id = ?`, [pending.id]);
      const before = await outbox(wallet.id);

      expect((await resolver.resolve(pending)).outcome).toBe('FAILED');

      const failed = await row(pending.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.failureCode).toBeNull();
      expect(failed.processedAt).not.toBeNull();
      expect(await outbox(wallet.id)).toEqual(before);
      expect((await walletRow(wallet.id)).balance).toBe('100.00');
      expect((await resolver.resolve(pending)).outcome).toBe('SKIPPED');
    });
  });
});
