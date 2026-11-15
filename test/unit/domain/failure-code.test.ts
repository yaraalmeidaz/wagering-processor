import { describe, expect, test } from 'bun:test';
import { FAILURE_CODES, isFailureCode } from '../../../src/domain/failure-code';

describe('FailureCode (SPEC 9.3, RN-19, RN-40)', () => {
  test('contém exatamente os códigos da SPEC 9.3', () => {
    const actual: string[] = [...FAILURE_CODES].sort();
    expect(actual).toEqual(
      [
        'INSUFFICIENT_FUNDS',
        'CURRENCY_MISMATCH',
        'WALLET_PLAYER_MISMATCH',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_NOT_PROCESSED',
        'REFERENCE_CONTEXT_MISMATCH',
        'REFERENCE_KIND_NOT_ALLOWED',
        'REFERENCE_AMOUNT_MISMATCH',
        'REFERENCE_ALREADY_REVERSED',
        'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
      ].sort(),
    );
  });

  test('códigos HTTP sem transação não são failureCode (RN-40)', () => {
    expect(isFailureCode('INSUFFICIENT_FUNDS')).toBe(true);
    expect(isFailureCode('WALLET_NOT_FOUND')).toBe(false);
    expect(isFailureCode('IDEMPOTENCY_PAYLOAD_MISMATCH')).toBe(false);
  });
});
