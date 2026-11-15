import { describe, expect, test } from 'bun:test';
import {
  decideIdempotency,
  type IncomingIdempotency,
  type StoredIdempotency,
} from '../../../src/domain/idempotency';

const incoming: IncomingIdempotency = {
  idempotencyKey: 'provider-1:ext-1',
  payloadHash: 'a'.repeat(64),
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
};

const stored = (overrides: Partial<StoredIdempotency> = {}): StoredIdempotency => ({
  ...incoming,
  status: 'PROCESSED',
  ...overrides,
});

describe('decisão de idempotência no fast-path (SPEC 5.4, ADR-0005)', () => {
  test('nada encontrado: NOT_FOUND', () => {
    expect(decideIdempotency(null, incoming, 'FAST_PATH')).toBe('NOT_FOUND');
  });

  test.each(['PROCESSED', 'REJECTED'] as const)(
    '%s com mesma chave e hash: REPLAY (RN-20)',
    (status) => {
      expect(decideIdempotency(stored({ status }), incoming, 'FAST_PATH')).toBe('REPLAY');
    },
  );

  test('terminal com hash diferente: PAYLOAD_MISMATCH (RN-21)', () => {
    expect(decideIdempotency(stored({ payloadHash: 'b'.repeat(64) }), incoming, 'FAST_PATH')).toBe(
      'PAYLOAD_MISMATCH',
    );
  });

  test('terminal com chave diferente para o mesmo par: KEY_CONFLICT (RN-22)', () => {
    expect(decideIdempotency(stored({ idempotencyKey: 'other-key' }), incoming, 'FAST_PATH')).toBe(
      'KEY_CONFLICT',
    );
  });

  test('PENDING_REFERENCE não é terminal: segue para o slow-path', () => {
    expect(decideIdempotency(stored({ status: 'PENDING_REFERENCE' }), incoming, 'FAST_PATH')).toBe(
      'SLOW_PATH',
    );
  });
});

describe('decisão de idempotência sob o lock (SPEC 5.5)', () => {
  test('PENDING_REFERENCE com mesma chave e hash: REPLAY, que a interface mapeia para 202', () => {
    expect(decideIdempotency(stored({ status: 'PENDING_REFERENCE' }), incoming, 'UNDER_LOCK')).toBe(
      'REPLAY',
    );
  });

  test('hash diferente: PAYLOAD_MISMATCH (RN-21)', () => {
    expect(
      decideIdempotency(
        stored({ status: 'PENDING_REFERENCE', payloadHash: 'b'.repeat(64) }),
        incoming,
        'UNDER_LOCK',
      ),
    ).toBe('PAYLOAD_MISMATCH');
  });

  test('chave diferente para o mesmo par: KEY_CONFLICT (RN-22)', () => {
    expect(decideIdempotency(stored({ idempotencyKey: 'other-key' }), incoming, 'UNDER_LOCK')).toBe(
      'KEY_CONFLICT',
    );
  });

  test('nada encontrado: NOT_FOUND', () => {
    expect(decideIdempotency(null, incoming, 'UNDER_LOCK')).toBe('NOT_FOUND');
  });
});
