import { describe, expect, test } from 'bun:test';
import {
  balanceEffect,
  insufficientBalanceFailureCode,
  isExternalKind,
} from '../../../src/domain/wager-kind';

describe('efeito por kind (SPEC 4.1)', () => {
  test.each([
    ['OPENING', 'CREDIT'], // RN-04
    ['BET', 'DEBIT'], // RN-05
    ['WIN', 'CREDIT'], // RN-06
    ['LOSS', 'NONE'], // RN-07
    ['REFUND', 'CREDIT'], // RN-08
  ] as const)('%s -> %s', (kind, effect) => {
    expect(balanceEffect(kind, null)).toBe(effect);
  });

  test.each([
    ['BET', 'CREDIT'],
    ['WIN', 'DEBIT'],
    ['REFUND', 'DEBIT'],
  ] as const)('ROLLBACK de %s aplica o inverso: %s (RN-09)', (referencedKind, effect) => {
    expect(balanceEffect('ROLLBACK', referencedKind)).toBe(effect);
  });

  test('ROLLBACK sem o kind da referência é erro de programação', () => {
    expect(() => balanceEffect('ROLLBACK', null)).toThrow();
  });

  test('código de saldo insuficiente: BET usa INSUFFICIENT_FUNDS, reversão usa REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE (RN-05, RN-17)', () => {
    expect(insufficientBalanceFailureCode('BET')).toBe('INSUFFICIENT_FUNDS');
    expect(insufficientBalanceFailureCode('ROLLBACK')).toBe(
      'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
    );
  });

  test('OPENING é interno e não entra pela API nem pela fila (RN-04)', () => {
    expect(isExternalKind('OPENING')).toBe(false);
    for (const kind of ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']) {
      expect(isExternalKind(kind)).toBe(true);
    }
    expect(isExternalKind('DEPOSIT')).toBe(false);
  });
});
