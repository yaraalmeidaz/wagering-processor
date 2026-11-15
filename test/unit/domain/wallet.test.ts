import { describe, expect, test } from 'bun:test';
import { InvalidWalletError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string): Money => Money.create(amount, 'BRL');
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:00:01.000Z');

let sequence = 0;
const op = () => {
  sequence++;
  return { entryId: `entry-${sequence}`, transactionId: `tx-${sequence}`, now: T1 };
};

function openWallet(initial: string) {
  return Wallet.create({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    initialBalance: brl(initial),
    opening: { entryId: 'entry-opening', transactionId: 'tx-opening' },
    now: T0,
  });
}

function reconstructFromLedger(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (sum, e) => (e.direction === 'CREDIT' ? sum.add(e.amount) : sum.subtract(e.amount)),
    brl('0.00'),
  );
}

describe('Wallet.create (RN-03, RN-04)', () => {
  test('saldo inicial maior que zero gera OPENING com lançamento de crédito, versão 1', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe('CREDIT');
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
  });

  test('saldo inicial zero não gera OPENING nem lançamento, versão 1', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  test('rejeita saldo inicial em moeda diferente da wallet (RN-01)', () => {
    expect(() =>
      Wallet.create({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        initialBalance: Money.create('1.00', 'USD'),
        opening: { entryId: 'e', transactionId: 't' },
        now: T0,
      }),
    ).toThrow(InvalidWalletError);
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.create({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        initialBalance: brl('0.00').subtract(brl('1.00')),
        opening: { entryId: 'e', transactionId: 't' },
        now: T0,
      }),
    ).toThrow(InvalidWalletError);
  });
});

describe('Wallet.debit e Wallet.credit (RN-05, RN-03)', () => {
  test('débito devolve saldo antes, depois e lançamento, e incrementa a versão', () => {
    const { wallet } = openWallet('100.00');
    const result = wallet.debit(brl('30.00'), op());
    if (!result.ok) throw new Error('esperava sucesso');
    expect(result.balanceBefore.amount).toBe('100.00');
    expect(result.balanceAfter.amount).toBe('70.00');
    expect(result.entry?.direction).toBe('DEBIT');
    expect(wallet.balance.amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
  });

  test('débito do saldo exato deixa zero', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.debit(brl('10.00'), op()).ok).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente é rejeição com INSUFFICIENT_FUNDS, sem alterar saldo nem versão', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.debit(brl('10.01'), op())).toEqual({
      ok: false,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('reversão que deixaria saldo negativo usa REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE (RN-17)', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.debit(brl('20.00'), op(), 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE')).toEqual({
      ok: false,
      failureCode: 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
    });
  });

  test('crédito incrementa saldo e versão', () => {
    const { wallet } = openWallet('10.00');
    const result = wallet.credit(brl('5.00'), op());
    expect(result.ok).toBe(true);
    expect(wallet.balance.amount).toBe('15.00');
    expect(wallet.version).toBe(2);
  });

  test('moeda diferente é rejeição com CURRENCY_MISMATCH, sem efeito (RN-01)', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.credit(Money.create('5.00', 'USD'), op())).toEqual({
      ok: false,
      failureCode: 'CURRENCY_MISMATCH',
    });
    expect(wallet.debit(Money.create('5.00', 'USD'), op())).toEqual({
      ok: false,
      failureCode: 'CURRENCY_MISMATCH',
    });
    expect(wallet.version).toBe(1);
  });

  test('valor zero não altera saldo nem versão e não gera lançamento (RN-10)', () => {
    const { wallet } = openWallet('10.00');
    for (const result of [wallet.debit(brl('0.00'), op()), wallet.credit(brl('0.00'), op())]) {
      if (!result.ok) throw new Error('esperava sucesso');
      expect(result.entry).toBeNull();
      expect(result.balanceAfter.amount).toBe('10.00');
    }
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('duas BET de 80,00 sobre 100,00: um débito, uma rejeição, saldo 20,00 (RN-32)', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const first = wallet.debit(brl('80.00'), op());
    const second = wallet.debit(brl('80.00'), op());
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, failureCode: 'INSUFFICIENT_FUNDS' });
    expect(wallet.balance.amount).toBe('20.00');

    const entries = [openingEntry, first.ok ? first.entry : null].filter(
      (e): e is WalletLedgerEntry => e !== null,
    );
    expect(entries.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    // AGENTS.md §9: saldo da wallet igual ao reconstruído pelo ledger.
    expect(reconstructFromLedger(entries).equals(wallet.balance)).toBe(true);
  });
});

describe('Wallet: dono e reidratação', () => {
  test('belongsTo compara o playerId (RN-38)', () => {
    const { wallet } = openWallet('1.00');
    expect(wallet.belongsTo('player-1')).toBe(true);
    expect(wallet.belongsTo('player-2')).toBe(false);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});
