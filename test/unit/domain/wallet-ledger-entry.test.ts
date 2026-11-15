import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string): Money => Money.create(amount, 'BRL');
const NOW = new Date('2026-01-01T00:00:00.000Z');

function entry(direction: 'DEBIT' | 'CREDIT', amount: string, before: string, after: string) {
  return WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction,
    amount: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    createdAt: NOW,
  });
}

describe('WalletLedgerEntry.create (RN-36)', () => {
  test('aceita crédito com before + amount == after', () => {
    const created = entry('CREDIT', '10.00', '90.00', '100.00');
    expect(created.direction).toBe('CREDIT');
    expect(created.balanceAfter.amount).toBe('100.00');
  });

  test('aceita débito com before - amount == after', () => {
    expect(entry('DEBIT', '30.00', '100.00', '70.00').balanceAfter.amount).toBe('70.00');
  });

  test('rejeita saldo posterior que não fecha a conta', () => {
    expect(() => entry('CREDIT', '10.00', '90.00', '99.99')).toThrow(InvalidLedgerEntryError);
    expect(() => entry('DEBIT', '10.00', '90.00', '100.00')).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero, porque operação sem efeito não gera lançamento (RN-10)', () => {
    expect(() => entry('CREDIT', '0.00', '10.00', '10.00')).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita saldo negativo', () => {
    const negative = brl('5.00').subtract(brl('10.00'));
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        amount: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: negative,
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita moedas diferentes entre valor e saldos (RN-01)', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'CREDIT',
        amount: Money.create('10.00', 'USD'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('10.00'),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('é imutável', () => {
    expect(Object.isFrozen(entry('CREDIT', '10.00', '0.00', '10.00'))).toBe(true);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstrói o estado persistido', () => {
    const rehydrated = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      amount: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
      createdAt: NOW,
    });
    expect(rehydrated.transactionId).toBe('tx-1');
    expect(rehydrated.amount.amount).toBe('30.00');
  });
});
