import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidWagerInputError,
  TransientFailureError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { FakeClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { betInput } from '../../helpers/wager-input';
import { ledgerDirections, ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

describe('ProcessWagerTransaction', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let clock: FakeClock;
  let useCase: ProcessWagerTransaction;

  const outbox = async (walletId: string) =>
    (
      await db.execute(
        `SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq`,
        [walletId],
      )
    ).map((row) => ({
      eventType: String(row['event_type']),
      payload: row['payload'] as Record<string, unknown>,
    }));

  beforeAll(async () => {
    db = await createTestDatabase('usecase_process');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    useCase = new ProcessWagerTransaction({ unitOfWork: uow, clock, random: () => 0.5 });
  });

  afterAll(async () => {
    await db?.dispose();
  });

  describe('efeito e eventos (SPEC 4.1, 5.7; RN-26, RN-28)', () => {
    test('BET debita, grava lançamento, WagerTransactionProcessed e WalletBalanceChanged', async () => {
      const wallet = await seedWallet(uow, '100.00');
      const result = await useCase.execute(betInput(wallet, '30.00'));

      expect(result).toMatchObject({
        status: 'PROCESSED',
        failureCode: null,
        balance: { amount: '70.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT', 'DEBIT']);
      const events = await outbox(wallet.id);
      expect(events.map((e) => e.eventType)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      const changed = events[1]?.payload;
      expect(changed?.['aggregateId']).toBe(wallet.id);
      const data = changed?.['data'] as Record<string, unknown> | undefined;
      expect(data?.['walletVersion']).toBe(2);
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    });

    test('LOSS fica PROCESSED sem lançamento e sem WalletBalanceChanged (RN-07, RN-28)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const result = await useCase.execute(betInput(wallet, '5.00', { kind: 'LOSS' }));

      expect(result.status).toBe('PROCESSED');
      expect(result.balance?.amount).toBe('10.00');
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT']);
      expect((await outbox(wallet.id)).map((e) => e.eventType)).toEqual([
        'WagerTransactionProcessed',
      ]);
    });

    test('BET de valor zero fica PROCESSED sem lançamento e sem mudar a versão (RN-10)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const result = await useCase.execute(betInput(wallet, '0.00'));

      expect(result.status).toBe('PROCESSED');
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT']);
      const rows = await db.execute(`SELECT version FROM wallets WHERE id = ?`, [wallet.id]);
      expect(rows[0]?.['version']).toBe(1);
    });
  });

  describe('rejeição como resultado (RN-19, RN-27)', () => {
    test('saldo insuficiente grava REJECTED, sem lançamento, com WagerTransactionRejected', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const result = await useCase.execute(betInput(wallet, '10.01'));

      expect(result).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00' },
      });
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT']);
      expect((await outbox(wallet.id)).map((e) => e.eventType)).toEqual([
        'WagerTransactionRejected',
      ]);
    });

    test('playerId diferente do dono da wallet: WALLET_PLAYER_MISMATCH (RN-38)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const result = await useCase.execute(
        betInput(wallet, '1.00', { playerId: crypto.randomUUID() }),
      );
      expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    });

    test('moeda diferente da wallet: CURRENCY_MISMATCH, antes da referência (RN-01; SPEC 4.3)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const result = await useCase.execute(
        betInput(wallet, '1.00', {
          kind: 'REFUND',
          money: { amount: '1.00', currency: 'USD' },
          referenceExternalTransactionId: 'bet-inexistente',
        }),
      );
      expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
    });

    test('CURRENCY_MISMATCH não tem snapshot: balance null, também no replay (RN-20; ADR-0005)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const input = betInput(wallet, '1.00', { money: { amount: '1.00', currency: 'USD' } });

      const first = await useCase.execute(input);
      expect(first).toMatchObject({
        status: 'REJECTED',
        failureCode: 'CURRENCY_MISMATCH',
        balance: null,
      });

      const replay = await useCase.execute(input);
      expect(replay).toMatchObject({
        status: 'REJECTED',
        failureCode: 'CURRENCY_MISMATCH',
        balance: null,
        idempotentReplay: true,
      });
    });

    test.each(['BET', 'LOSS'])(
      '%s com referência: REFERENCE_KIND_NOT_ALLOWED, sem lançamento (RN-42)',
      async (kind) => {
        const wallet = await seedWallet(uow, '10.00');
        const result = await useCase.execute(
          betInput(wallet, '1.00', { kind, referenceExternalTransactionId: 'qualquer-ref' }),
        );
        expect(result).toMatchObject({
          status: 'REJECTED',
          failureCode: 'REFERENCE_KIND_NOT_ALLOWED',
          balance: { amount: '10.00' },
        });
        expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT']);
      },
    );
  });

  describe('referências (SPEC 4.2; RN-12, RN-16)', () => {
    test('REFUND da BET credita o valor e aponta para a referência (RN-08)', async () => {
      const wallet = await seedWallet(uow, '50.00');
      const bet = betInput(wallet, '20.00');
      await useCase.execute(bet);

      const refund = await useCase.execute(
        betInput(wallet, '20.00', {
          kind: 'REFUND',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '50.00' } });
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    });

    test('ROLLBACK depois de REFUND da mesma BET: REFERENCE_ALREADY_REVERSED (RN-16)', async () => {
      const wallet = await seedWallet(uow, '50.00');
      const bet = betInput(wallet, '20.00');
      await useCase.execute(bet);
      const reference = { referenceExternalTransactionId: bet.externalTransactionId };
      await useCase.execute(betInput(wallet, '20.00', { kind: 'REFUND', ...reference }));

      const rollback = await useCase.execute(
        betInput(wallet, '20.00', { kind: 'ROLLBACK', ...reference }),
      );
      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
        balance: { amount: '50.00' },
      });
    });

    test('WIN de outro provider com o mesmo externalTransactionId da BET: PENDING_REFERENCE, não REJECTED (RN-11)', async () => {
      const wallet = await seedWallet(uow, '50.00');
      const bet = betInput(wallet, '10.00', { providerId: 'provider-A' });
      expect((await useCase.execute(bet)).status).toBe('PROCESSED');

      const win = await useCase.execute(
        betInput(wallet, '15.00', {
          providerId: 'provider-B',
          kind: 'WIN',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(win).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null, balance: null });
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT', 'DEBIT']);
    });

    test('ROLLBACK de WIN que deixaria o saldo negativo: REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE, não INSUFFICIENT_FUNDS (RN-17)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const win = betInput(wallet, '50.00', { kind: 'WIN' });
      await useCase.execute(win);
      await useCase.execute(betInput(wallet, '55.00'));

      const rollback = await useCase.execute(
        betInput(wallet, '50.00', {
          kind: 'ROLLBACK',
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );
      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
        balance: { amount: '5.00' },
      });
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
      expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    });

    test('referência ausente vira PENDING_REFERENCE com WagerTransactionPendingReference (RN-12, RN-29)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const result = await useCase.execute(
        betInput(wallet, '5.00', {
          kind: 'ROLLBACK',
          referenceExternalTransactionId: 'bet-futura',
        }),
      );

      expect(result).toMatchObject({ status: 'PENDING_REFERENCE', balance: null });
      const rows = await db.execute(
        `SELECT attempts, next_reference_attempt_at FROM wager_transactions WHERE id = ?`,
        [result.transactionId],
      );
      expect(rows[0]?.['attempts']).toBe(0);
      expect(new Date(String(rows[0]?.['next_reference_attempt_at'])).toISOString()).toBe(
        '2026-01-01T00:00:02.000Z',
      );
      expect((await outbox(wallet.id)).map((e) => e.eventType)).toEqual([
        'WagerTransactionPendingReference',
      ]);
    });
  });

  describe('idempotência (RN-20 a RN-22; ADR-0005)', () => {
    test('replay devolve o snapshot da época, não o saldo atual (RN-20)', async () => {
      const wallet = await seedWallet(uow, '100.00');
      const first = betInput(wallet, '10.00');
      await useCase.execute(first);
      await useCase.execute(betInput(wallet, '30.00'));

      const replay = await useCase.execute(first);
      expect(replay).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '90.00' },
        idempotentReplay: true,
      });
      expect(await ledgerDirections(db, wallet.id)).toEqual(['CREDIT', 'DEBIT', 'DEBIT']);
    });

    test('replay de rejeição devolve o mesmo failureCode (RN-20)', async () => {
      const wallet = await seedWallet(uow, '1.00');
      const input = betInput(wallet, '5.00');
      await useCase.execute(input);
      expect(await useCase.execute(input)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: true,
      });
    });

    test('replay de PENDING_REFERENCE responde a mesma pendência (SPEC 5.5)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const input = betInput(wallet, '5.00', {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'bet-que-nao-chega',
      });
      const first = await useCase.execute(input);
      const replay = await useCase.execute(input);
      expect(replay).toMatchObject({
        status: 'PENDING_REFERENCE',
        transactionId: first.transactionId,
        idempotentReplay: true,
      });
    });

    test('mesma chave com payload diferente: IDEMPOTENCY_PAYLOAD_MISMATCH (RN-21)', async () => {
      const wallet = await seedWallet(uow, '100.00');
      const input = betInput(wallet, '10.00');
      await useCase.execute(input);

      const error = await useCase
        .execute({ ...input, money: { amount: '11.00', currency: 'BRL' } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect((error as IdempotencyConflictError).code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });

    test('mesmo par com chave diferente: IDEMPOTENCY_KEY_CONFLICT (RN-22)', async () => {
      const wallet = await seedWallet(uow, '100.00');
      const input = betInput(wallet, '10.00');
      await useCase.execute(input);

      const error = await useCase
        .execute({ ...input, idempotencyKey: 'outra-chave' })
        .catch((e: unknown) => e);
      expect((error as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    test('mesma chave em paralelo para wallets diferentes: um PROCESSED e um 409, nunca 500 (SPEC 5.9)', async () => {
      const a = await seedWallet(uow, '10.00');
      const b = await seedWallet(uow, '10.00');
      const input = betInput(a, '1.00');
      const other = { ...input, walletId: b.id, playerId: b.playerId };

      const outcomes = await Promise.allSettled([useCase.execute(input), useCase.execute(other)]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        IdempotencyConflictError,
      );
    });
  });

  describe('entrada e infraestrutura (SPEC 5.1, 5.5, 5.9)', () => {
    test('wallet inexistente: WalletNotFoundError, nada gravado (RN-39)', async () => {
      const wallet = await seedWallet(uow, '1.00');
      const input = betInput(wallet, '1.00', { walletId: crypto.randomUUID() });
      await expect(useCase.execute(input)).rejects.toBeInstanceOf(WalletNotFoundError);
      const rows = await db.execute(
        `SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ?`,
        [input.idempotencyKey],
      );
      expect(rows[0]?.['n']).toBe(0);
    });

    test.each([
      ['valor com 3 casas', { money: { amount: '1.000', currency: 'BRL' } }],
      ['kind OPENING (RN-04)', { kind: 'OPENING' }],
      ['REFUND sem referência', { kind: 'REFUND', referenceExternalTransactionId: null }],
    ])('%s: InvalidWagerInputError', async (_, overrides) => {
      const wallet = await seedWallet(uow, '1.00');
      await expect(
        useCase.execute({ ...betInput(wallet, '1.00'), ...(overrides as object) }),
      ).rejects.toBeInstanceOf(InvalidWagerInputError);
    });

    test('wallet travada por outra sessão além do lock_timeout: TransientFailureError (55P03)', async () => {
      const wallet = await seedWallet(uow, '10.00');
      const holder = new MikroOrmUnitOfWork(db.orm.em);
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locking = holder.run(async ({ wallets }) => {
        await wallets.findByIdForUpdate(wallet.id);
        await held;
      });
      await Bun.sleep(100);

      const error = await useCase.execute(betInput(wallet, '1.00')).catch((e: unknown) => e);
      release();
      await locking;
      expect(error).toBeInstanceOf(TransientFailureError);
      expect((error as TransientFailureError).sqlState).toBe('55P03');
    }, 10_000);
  });
});
