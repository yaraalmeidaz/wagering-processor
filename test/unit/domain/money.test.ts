import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';

const brl = (amount: string): Money => Money.create(amount, 'BRL');

describe('Money.create (RN-02)', () => {
  test.each(['0.00', '25.00', '100.10', '99999999999999999.99'])('aceita %p', (amount) => {
    expect(brl(amount).amount).toBe(amount);
  });

  test.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e2',
    '1E2',
    '2.5e1',
    '',
    '25',
    '25.5',
    '25.000',
    '-1.00',
    '+1.00',
    ' 1.00',
    '1.00 ',
    '01.00',
    '1,00',
    '.50',
    '100000000000000000.00',
  ])('rejeita %p sem arredondar', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([25, 25.5, Number.NaN, null, undefined, 25n])(
    'rejeita valor que não é string: %p',
    (amount) => {
      expect(() => Money.create(amount, 'BRL')).toThrow(InvalidMoneyError);
    },
  );

  test.each(['BRL', 'USD'])('aceita moeda ISO-4217 %p', (currency) => {
    expect(Money.create('1.00', currency).currency).toBe(currency);
  });

  test.each(['brl', 'BR', '', 'BRLX', 1])('rejeita moeda %p', (currency) => {
    expect(() => Money.create('1.00', currency)).toThrow(InvalidMoneyError);
  });
});

describe('Money: aritmética exata (SPEC 3.1)', () => {
  test('0.10 + 0.20 = 0.30', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('subtract pode resultar negativo, e negate inverte o sinal', () => {
    const result = brl('0.10').subtract(brl('0.20'));
    expect(result.amount).toBe('-0.10');
    expect(result.isNegative()).toBe(true);
    expect(result.negate().amount).toBe('0.10');
  });

  test('isZero, isPositive, isNegative e isLessThan', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(brl('0.99').isLessThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
    expect(brl('1.00').equals(Money.create('1.00', 'USD'))).toBe(false);
  });

  test('operação entre moedas diferentes lança erro de domínio (RN-01)', () => {
    const usd = Money.create('1.00', 'USD');
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('resultado acima de NUMERIC(19,2) é recusado', () => {
    expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  test('é imutável', () => {
    const original = brl('1.00');
    original.add(brl('2.00'));
    expect(original.amount).toBe('1.00');
    expect(Object.isFrozen(original)).toBe(true);
  });
});

describe('Money.rehydrate e serialização', () => {
  test('reconstrói valor persistido', () => {
    expect(Money.rehydrate('100.00', 'BRL').equals(brl('100.00'))).toBe(true);
  });

  test('rejeita formato inválido vindo da persistência', () => {
    expect(() => Money.rehydrate('1e2', 'BRL')).toThrow(InvalidMoneyError);
  });

  test('toJSON devolve MoneyProps com amount em string', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });
});
