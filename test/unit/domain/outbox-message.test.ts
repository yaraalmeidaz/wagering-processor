import { describe, expect, test } from 'bun:test';
import { InvalidOutboxMessageError } from '../../../src/domain/errors';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { referenceRetryDelayMs } from '../../../src/domain/pending-reference-backoff';
import { RETRY_ATTEMPT_LIMIT, retryDelayMs } from '../../../src/domain/retry-backoff';
import { FakeClock } from '../../helpers/clock';

// Enunciado §6.5 e §11; SPEC 11.3; ADR-0006 (backoff da ADR-0007).
const MIDDLE = () => 0.5; // jitter zero
const LOWEST = () => 0; // -20%
const HIGHEST = () => 0.999_999_999; // quase +20%
const T0 = new Date('2026-01-01T00:00:00.000Z');

function enqueued() {
  return OutboxMessage.enqueue({
    id: '00000000-0000-4000-8000-000000000001',
    aggregateId: '00000000-0000-4000-8000-0000000000aa',
    eventType: 'WalletBalanceChanged',
    payload: { eventId: '00000000-0000-4000-8000-000000000001' },
    occurredAt: T0,
  });
}

describe('OutboxMessage.enqueue, isPending e isDue', () => {
  test('nasce pendente, sem tentativas, devida a partir de occurredAt', () => {
    const message = enqueued();
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt.toISOString()).toBe(T0.toISOString());
    expect(message.isDue(T0)).toBe(true);
    expect(message.isDue(new Date(T0.getTime() - 1))).toBe(false);
  });

  test.each([
    ['aggregateId vazio', { aggregateId: '' }],
    ['eventType vazio', { eventType: ' ' }],
    ['attempts negativo', { attempts: -1 }],
    ['attempts não inteiro', { attempts: 1.5 }],
  ])('%s: InvalidOutboxMessageError', (_, override) => {
    expect(() =>
      OutboxMessage.create({
        id: '00000000-0000-4000-8000-000000000001',
        aggregateId: '00000000-0000-4000-8000-0000000000aa',
        eventType: 'WalletBalanceChanged',
        payload: {},
        occurredAt: T0,
        attempts: 0,
        nextAttemptAt: T0,
        publishedAt: null,
        ...override,
      }),
    ).toThrow(InvalidOutboxMessageError);
  });
});

describe('OutboxMessage.scheduleRetry (ADR-0006, fórmula da ADR-0007)', () => {
  test('base 2 s e fator 2 sobre o relógio injetado', () => {
    const clock = new FakeClock(T0);
    const message = enqueued();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      message.scheduleRetry(clock.now(), MIDDLE);
      waits.push(message.nextAttemptAt.getTime() - clock.now().getTime());
      expect(message.isDue(clock.now())).toBe(false);
      clock.advance(waits.at(-1) ?? 0);
      expect(message.isDue(clock.now())).toBe(true);
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(message.attempts).toBe(4);
  });

  test('mesma espera do PENDING_REFERENCE em toda tentativa e todo jitter', () => {
    for (const random of [LOWEST, MIDDLE, HIGHEST]) {
      const message = enqueued();
      for (let attempt = 1; attempt <= 14; attempt++) {
        message.scheduleRetry(T0, random);
        const wait = message.nextAttemptAt.getTime() - T0.getTime();
        expect(wait).toBe(referenceRetryDelayMs(attempt, random));
        expect(wait).toBe(retryDelayMs(attempt, random));
      }
    }
  });

  test('jitter antes do teto: tentativa 8 com +20% fica no teto, com -20% abaixo dele', () => {
    expect(retryDelayMs(8, HIGHEST)).toBe(300_000);
    expect(retryDelayMs(8, LOWEST)).toBe(204_800);
    expect(retryDelayMs(9, LOWEST)).toBe(300_000);
  });

  test('esgota em 12 falhas e segue tentando no teto de 5 min', () => {
    expect(RETRY_ATTEMPT_LIMIT).toBe(12);
    const message = enqueued();
    for (let attempt = 1; attempt < RETRY_ATTEMPT_LIMIT; attempt++) {
      message.scheduleRetry(T0, MIDDLE);
      expect(message.isRetryExhausted()).toBe(false);
    }
    message.scheduleRetry(T0, MIDDLE);
    expect(message.attempts).toBe(12);
    expect(message.isRetryExhausted()).toBe(true);

    message.scheduleRetry(T0, HIGHEST);
    expect(message.attempts).toBe(13);
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt.getTime() - T0.getTime()).toBe(300_000);
  });
});

describe('OutboxMessage.markPublished', () => {
  test('deixa de estar pendente e de estar devida', () => {
    const message = enqueued();
    message.markPublished(new Date('2026-01-01T00:00:01.000Z'));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date('2030-01-01T00:00:00.000Z'))).toBe(false);
    expect(message.publishedAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });

  test('publicar duas vezes ou reagendar depois de publicar é erro de programação', () => {
    const message = enqueued();
    message.markPublished(T0);
    expect(() => message.markPublished(T0)).toThrow(InvalidOutboxMessageError);
    expect(() => message.scheduleRetry(T0, MIDDLE)).toThrow(InvalidOutboxMessageError);
  });
});

describe('OutboxMessage.rehydrate', () => {
  test('reconstrói tentativas e publicação sem revalidar', () => {
    const message = OutboxMessage.rehydrate({
      id: '00000000-0000-4000-8000-000000000001',
      aggregateId: '00000000-0000-4000-8000-0000000000aa',
      eventType: 'WalletBalanceChanged',
      payload: {},
      occurredAt: T0,
      attempts: 3,
      nextAttemptAt: new Date('2026-01-01T00:00:10.000Z'),
      publishedAt: null,
    });
    expect(message.attempts).toBe(3);
    expect(message.isDue(new Date('2026-01-01T00:00:09.999Z'))).toBe(false);
  });
});
