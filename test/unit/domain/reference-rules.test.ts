import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import {
  type ReferenceCheckInput,
  type ReferenceSnapshot,
  validateReference,
} from '../../../src/domain/reference-rules';

const brl = (amount: string): Money => Money.create(amount, 'BRL');

const transaction: ReferenceCheckInput['transaction'] = {
  kind: 'REFUND',
  providerId: 'provider-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  money: brl('25.00'),
};

const bet: ReferenceSnapshot = {
  kind: 'BET',
  status: 'PROCESSED',
  providerId: 'provider-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  money: brl('25.00'),
};

function check(overrides: Partial<ReferenceCheckInput> = {}) {
  return validateReference({
    transaction,
    reference: bet,
    referenceAlreadyReversed: false,
    ...overrides,
  });
}

describe('validação de referência, ordem da SPEC 4.2', () => {
  test('a) referência ausente: PENDING_REFERENCE (RN-12)', () => {
    expect(check({ reference: null })).toEqual({ outcome: 'PENDING_REFERENCE' });
  });

  test('b) referência não PROCESSED: REFERENCE_NOT_PROCESSED (RN-13), antes do contexto', () => {
    expect(check({ reference: { ...bet, status: 'PENDING_REFERENCE', roundId: 'other' } })).toEqual(
      {
        outcome: 'REJECTED',
        failureCode: 'REFERENCE_NOT_PROCESSED',
      },
    );
  });

  test.each([
    ['providerId', { providerId: 'provider-2' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['moeda', { money: Money.create('25.00', 'USD') }],
  ] as const)('c) %s diferente: REFERENCE_CONTEXT_MISMATCH (RN-14), antes do tipo', (_, diff) => {
    expect(check({ reference: { ...bet, kind: 'LOSS', ...diff } })).toEqual({
      outcome: 'REJECTED',
      failureCode: 'REFERENCE_CONTEXT_MISMATCH',
    });
  });

  test.each([
    ['REFUND', 'WIN'], // RN-08: só BET
    ['REFUND', 'REFUND'],
    ['WIN', 'REFUND'], // RN-06: só BET
    ['WIN', 'WIN'],
    ['ROLLBACK', 'LOSS'], // RN-09: BET, WIN ou REFUND
    ['ROLLBACK', 'ROLLBACK'],
  ] as const)(
    'd) %s sobre %s: REFERENCE_KIND_NOT_ALLOWED, antes do valor',
    (kind, referencedKind) => {
      expect(
        check({
          transaction: { ...transaction, kind },
          reference: { ...bet, kind: referencedKind, money: brl('1.00') },
        }),
      ).toEqual({ outcome: 'REJECTED', failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
    },
  );

  test.each(['REFUND', 'ROLLBACK'] as const)(
    'e) %s com valor diferente: REFERENCE_AMOUNT_MISMATCH (RN-15), antes da reversão única',
    (kind) => {
      expect(
        check({
          transaction: { ...transaction, kind },
          reference: { ...bet, money: brl('24.99') },
          referenceAlreadyReversed: true,
        }),
      ).toEqual({ outcome: 'REJECTED', failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
    },
  );

  test.each(['REFUND', 'ROLLBACK'] as const)(
    'f) %s sobre referência já revertida, por qualquer tipo: REFERENCE_ALREADY_REVERSED (RN-16)',
    (kind) => {
      expect(
        check({ transaction: { ...transaction, kind }, referenceAlreadyReversed: true }),
      ).toEqual({
        outcome: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
      });
    },
  );

  test('WIN não exige valor igual nem conta como reversão (RN-06)', () => {
    expect(
      check({
        transaction: { ...transaction, kind: 'WIN', money: brl('100.00') },
        referenceAlreadyReversed: true,
      }),
    ).toEqual({ outcome: 'OK' });
  });

  test.each([
    ['REFUND', 'BET'],
    ['ROLLBACK', 'BET'],
    ['ROLLBACK', 'WIN'],
    ['ROLLBACK', 'REFUND'],
  ] as const)('%s válido sobre %s: OK', (kind, referencedKind) => {
    expect(
      check({ transaction: { ...transaction, kind }, reference: { ...bet, kind: referencedKind } }),
    ).toEqual({
      outcome: 'OK',
    });
  });

  test('kind sem regra de referência é erro de programação', () => {
    expect(() => check({ transaction: { ...transaction, kind: 'BET' } })).toThrow();
  });
});
