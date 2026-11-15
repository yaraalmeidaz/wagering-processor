import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { Money } from '../../../src/domain/money';
import { WagerTransaction } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';

// ADR-0001 e ADR-0002: domínio -> banco -> domínio sem perda (SPEC, Parte 3, Fase 3).
const brl = (amount: string): Money => Money.create(amount, 'BRL');
const T0 = new Date('2026-01-01T00:00:00.123Z');
const T1 = new Date('2026-01-01T00:00:01.456Z');

function openWallet(initial: string) {
  return Wallet.create({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency: 'BRL',
    initialBalance: brl(initial),
    opening: { entryId: crypto.randomUUID(), transactionId: crypto.randomUUID() },
    now: T0,
  });
}

function transaction(
  wallet: Wallet,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) {
  const externalTransactionId = `ext-${crypto.randomUUID()}`;
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'provider-1',
    externalTransactionId,
    idempotencyKey: `provider-1:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    referenceExternalTransactionId: null,
    createdAt: T0,
    ...overrides,
  });
}

function expectSameWallet(actual: Wallet | null, expected: Wallet) {
  expect(actual).not.toBeNull();
  expect(actual?.id).toBe(expected.id);
  expect(actual?.playerId).toBe(expected.playerId);
  expect(actual?.currency).toBe(expected.currency);
  expect(actual?.balance.equals(expected.balance)).toBe(true);
  expect(actual?.version).toBe(expected.version);
  expect(actual?.createdAt).toEqual(expected.createdAt);
  expect(actual?.updatedAt).toEqual(expected.updatedAt);
}

function expectSameTransaction(actual: WagerTransaction | null, expected: WagerTransaction) {
  expect(actual).not.toBeNull();
  for (const key of [
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'payloadHash',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'kind',
    'referenceExternalTransactionId',
    'referenceTransactionId',
    'status',
    'failureCode',
    'attempts',
  ] as const) {
    expect(actual?.[key]).toEqual(expected[key]);
  }
  expect(actual?.money.equals(expected.money)).toBe(true);
  expect(actual?.resultingBalance?.toJSON() ?? null).toEqual(
    expected.resultingBalance?.toJSON() ?? null,
  );
  expect(actual?.createdAt).toEqual(expected.createdAt);
  expect(actual?.processedAt).toEqual(expected.processedAt);
  expect(actual?.nextReferenceAttemptAt).toEqual(expected.nextReferenceAttemptAt);
}

function expectSameEntry(actual: WalletLedgerEntry | undefined, expected: WalletLedgerEntry) {
  expect(actual).toBeDefined();
  expect(actual?.id).toBe(expected.id);
  expect(actual?.walletId).toBe(expected.walletId);
  expect(actual?.transactionId).toBe(expected.transactionId);
  expect(actual?.direction).toBe(expected.direction);
  expect(actual?.amount.equals(expected.amount)).toBe(true);
  expect(actual?.balanceBefore.equals(expected.balanceBefore)).toBe(true);
  expect(actual?.balanceAfter.equals(expected.balanceAfter)).toBe(true);
  expect(actual?.createdAt).toEqual(expected.createdAt);
}

describe('round-trip domínio -> banco -> domínio', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('persistence_roundtrip');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('Wallet com OPENING e lançamento de crédito (RN-04)', async () => {
    const { wallet, openingEntry } = openWallet('100.00');
    if (openingEntry === null) throw new Error('esperava OPENING');
    const opening = transaction(wallet, {
      id: openingEntry.transactionId,
      kind: 'OPENING',
      money: brl('100.00'),
    });
    opening.markProcessed(wallet.balance, T0);

    await uow.run(async ({ wallets, transactions, ledger }) => {
      await wallets.add(wallet);
      await transactions.add(opening);
      await ledger.append(openingEntry);
    });

    const loaded = await uow.run(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(wallet.id),
      opening: await transactions.findById(opening.id),
      entries: await ledger.listByWallet(wallet.id),
    }));
    expectSameWallet(loaded.wallet, wallet);
    expectSameTransaction(loaded.opening, opening);
    expect(loaded.entries).toHaveLength(1);
    expectSameEntry(loaded.entries[0], openingEntry);
  });

  test('débito atualiza saldo e versão, grava BET PROCESSED e lançamento de débito (RN-05)', async () => {
    const { wallet } = openWallet('0.00');
    await uow.run(({ wallets }) => wallets.add(wallet));

    const credit = wallet.credit(brl('50.00'), {
      entryId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      now: T1,
    });
    if (!credit.ok || credit.entry === null) throw new Error('esperava crédito');
    const win = transaction(wallet, {
      id: credit.entry.transactionId,
      kind: 'WIN',
      money: brl('50.00'),
    });
    win.markProcessed(credit.balanceAfter, T1);

    const bet = transaction(wallet, { money: brl('20.00') });
    const debit = wallet.debit(bet.money, {
      entryId: crypto.randomUUID(),
      transactionId: bet.id,
      now: T1,
    });
    if (!debit.ok || debit.entry === null) throw new Error('esperava débito');
    bet.markProcessed(debit.balanceAfter, T1);

    await uow.run(async ({ wallets, transactions, ledger }) => {
      await transactions.add(win);
      await transactions.add(bet);
      await wallets.update(wallet, 1);
      await ledger.append(credit.entry as WalletLedgerEntry);
      await ledger.append(debit.entry as WalletLedgerEntry);
    });

    const loaded = await uow.run(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(wallet.id),
      bet: await transactions.findById(bet.id),
      entries: await ledger.listByWallet(wallet.id),
    }));
    expectSameWallet(loaded.wallet, wallet);
    expect(loaded.wallet?.balance.amount).toBe('30.00');
    expect(loaded.wallet?.version).toBe(3);
    expectSameTransaction(loaded.bet, bet);
    expect(loaded.entries.map((e) => e.direction).sort()).toEqual(['CREDIT', 'DEBIT']);
  });

  test('transição PENDING -> PENDING_REFERENCE -> REJECTED preserva tentativas, datas e failureCode (RN-12, RN-19)', async () => {
    const { wallet } = openWallet('10.00');
    await uow.run(({ wallets }) => wallets.add(wallet));

    const rollback = transaction(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'bet-ausente',
    });
    await uow.run(({ transactions }) => transactions.add(rollback));
    expectSameTransaction(
      await uow.run(({ transactions }) => transactions.findById(rollback.id)),
      rollback,
    );

    rollback.markPendingReference(new Date('2026-01-01T00:00:02.000Z'));
    await uow.run(({ transactions }) => transactions.update(rollback));
    rollback.scheduleNextReferenceAttempt(new Date('2026-01-01T00:00:06.000Z'));
    await uow.run(({ transactions }) => transactions.update(rollback));
    expectSameTransaction(
      await uow.run(({ transactions }) => transactions.findById(rollback.id)),
      rollback,
    );

    rollback.reject('REFERENCE_NOT_FOUND', wallet.balance, T1);
    await uow.run(({ transactions }) => transactions.update(rollback));
    const rejected = await uow.run(({ transactions }) => transactions.findById(rollback.id));
    expectSameTransaction(rejected, rollback);
    expect(rejected?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(rejected?.attempts).toBe(1);
  });

  test('Money no limite de NUMERIC(19,2) volta sem perda (ADR-0002)', async () => {
    const { wallet } = openWallet('99999999999999999.99');
    await uow.run(({ wallets }) => wallets.add(wallet));
    const loaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(loaded?.balance.amount).toBe('99999999999999999.99');
  });

  test('busca por id inexistente devolve null', async () => {
    expect(await uow.run(({ wallets }) => wallets.findById(crypto.randomUUID()))).toBeNull();
    expect(
      await uow.run(({ transactions }) => transactions.findById(crypto.randomUUID())),
    ).toBeNull();
  });
});
