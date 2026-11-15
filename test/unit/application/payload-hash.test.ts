import { describe, expect, test } from 'bun:test';
import { canonicalJson, payloadHash } from '../../../src/application/payload-hash';

// RN-24; SPEC 5.2: SHA-256 em hex de JSON canônico dos campos de negócio.
const fields = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: null,
};

describe('payloadHash (RN-24)', () => {
  test('é SHA-256 em hex minúsculo', () => {
    expect(payloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('não depende da ordem das chaves, inclusive aninhadas', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-1',
      referenceExternalTransactionId: null,
    };
    expect(payloadHash(reordered)).toBe(payloadHash(fields));
  });

  test('qualquer campo de negócio diferente muda o hash', () => {
    expect(payloadHash({ ...fields, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      payloadHash(fields),
    );
    expect(payloadHash({ ...fields, walletId: 'wallet-2' })).not.toBe(payloadHash(fields));
  });

  test('referência ausente e nula produzem o mesmo hash', () => {
    const { referenceExternalTransactionId: _, ...withoutReference } = fields;
    expect(payloadHash(withoutReference)).toBe(payloadHash(fields));
  });

  test('JSON canônico ordena as chaves e não tem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: null } })).toBe('{"a":{"c":null,"d":"x"},"b":1}');
  });
});
