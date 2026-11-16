import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/domain/wager-transaction';

const brl = (amount: string): Money => Money.create(amount, 'BRL');
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:00:01.000Z');

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-1:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('10.00'),
    referenceExternalTransactionId: null,
    createdAt: T0,
    ...overrides,
  };
}

const pending = () => WagerTransaction.create(props());
function pendingReference() {
  const tx = WagerTransaction.create(
    props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }),
  );
  tx.markPendingReference(T1);
  return tx;
}

describe('WagerTransaction.create (SPEC 3.3)', () => {
  test('começa em PENDING, sem tentativas e não terminal', () => {
    const tx = pending();
    expect(tx.status).toBe('PENDING');
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeNull();
    expect(tx.resultingBalance).toBeNull();
  });

  test.each(['REFUND', 'ROLLBACK'] as const)('%s exige referência', (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
  });

  test('payloadHash precisa ser SHA-256 em hex (RN-24)', () => {
    expect(() => WagerTransaction.create(props({ payloadHash: 'abc' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction: transições válidas (RN-25)', () => {
  test('PENDING -> PROCESSED grava resulting_balance e processedAt', () => {
    const tx = pending();
    tx.markProcessed(brl('90.00'), T1);
    expect(tx.status).toBe('PROCESSED');
    expect(tx.resultingBalance?.amount).toBe('90.00');
    expect(tx.processedAt).toEqual(T1);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> REJECTED grava failureCode e resulting_balance (RN-19, RN-20)', () => {
    const tx = pending();
    tx.reject('INSUFFICIENT_FUNDS', brl('5.00'), T1);
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.resultingBalance?.amount).toBe('5.00');
  });

  test('REJECTED aceita resulting_balance nulo quando o saldo da wallet está em outra moeda (RN-01)', () => {
    const tx = WagerTransaction.create(props({ money: Money.create('10.00', 'USD') }));
    tx.reject('CURRENCY_MISMATCH', null, T1);
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('CURRENCY_MISMATCH');
    expect(tx.resultingBalance).toBeNull();
  });

  test('PENDING -> PENDING_REFERENCE grava next_reference_attempt_at com attempts 0 (SPEC 8.1)', () => {
    const tx = pendingReference();
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.nextReferenceAttemptAt).toEqual(T1);
    expect(tx.attempts).toBe(0);
  });

  test('PENDING -> FAILED não guarda failureCode (RN-40, RN-41)', () => {
    const tx = pending();
    tx.markFailed(T1);
    expect(tx.status).toBe('FAILED');
    expect(tx.failureCode).toBeNull();
  });

  test('PENDING_REFERENCE -> PROCESSED, REJECTED ou FAILED', () => {
    const processed = pendingReference();
    processed.markProcessed(brl('10.00'), T1);
    expect(processed.status).toBe('PROCESSED');

    const rejected = pendingReference();
    rejected.reject('REFERENCE_NOT_FOUND', brl('10.00'), T1);
    expect(rejected.status).toBe('REJECTED');

    const failed = pendingReference();
    failed.markFailed(T1);
    expect(failed.status).toBe('FAILED');
  });

  test('reagendar a pendência incrementa attempts e só vale em PENDING_REFERENCE', () => {
    const tx = pendingReference();
    const next = new Date('2026-01-01T00:00:05.000Z');
    tx.scheduleNextReferenceAttempt(next);
    expect(tx.attempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(next);
    expect(() => pending().scheduleNextReferenceAttempt(next)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('reagendar não muda o status, e a última tentativa sem referência rejeita (RN-12; ADR-0007)', () => {
    const tx = pendingReference();
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      tx.scheduleNextReferenceAttempt(new Date(T1.getTime() + attempt * 1_000));
      expect(tx.status).toBe('PENDING_REFERENCE');
    }
    expect(tx.attempts).toBe(11);
    tx.reject('REFERENCE_NOT_FOUND', brl('10.00'), T1);
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(tx.attempts).toBe(11);
  });

  test('pendência reagendada que encontra a referência vira PROCESSED com o id dela (SPEC 8.2)', () => {
    const tx = pendingReference();
    tx.scheduleNextReferenceAttempt(new Date('2026-01-01T00:00:05.000Z'));
    tx.markProcessed(brl('110.00'), T1, 'bet-tx-id');
    expect(tx.status).toBe('PROCESSED');
    expect(tx.referenceTransactionId).toBe('bet-tx-id');
    expect(tx.resultingBalance?.amount).toBe('110.00');
  });

  test('resulting_balance em moeda diferente da transação é recusado', () => {
    expect(() => pending().markProcessed(Money.create('1.00', 'USD'), T1)).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction: transições inválidas lançam InvalidTransactionStateError (RN-25)', () => {
  const terminals = {
    PROCESSED: () => {
      const tx = pending();
      tx.markProcessed(brl('1.00'), T1);
      return tx;
    },
    REJECTED: () => {
      const tx = pending();
      tx.reject('INSUFFICIENT_FUNDS', brl('1.00'), T1);
      return tx;
    },
    FAILED: () => {
      const tx = pending();
      tx.markFailed(T1);
      return tx;
    },
  };

  for (const [status, build] of Object.entries(terminals)) {
    test(`${status} é terminal e não aceita nenhuma transição`, () => {
      expect(() => build().markProcessed(brl('1.00'), T1)).toThrow(InvalidTransactionStateError);
      expect(() => build().reject('INSUFFICIENT_FUNDS', brl('1.00'), T1)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => build().markPendingReference(T1)).toThrow(InvalidTransactionStateError);
      expect(() => build().markFailed(T1)).toThrow(InvalidTransactionStateError);
    });
  }

  test('PENDING_REFERENCE -> PENDING_REFERENCE é inválida', () => {
    expect(() => pendingReference().markPendingReference(T1)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói estado persistido sem revalidar transições (SPEC 2.1)', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      referenceTransactionId: null,
      status: 'PROCESSED',
      failureCode: null,
      resultingBalance: brl('90.00'),
      attempts: 0,
      nextReferenceAttemptAt: null,
      processedAt: T1,
    });
    expect(tx.status).toBe('PROCESSED');
    expect(tx.isTerminal()).toBe(true);
  });
});
