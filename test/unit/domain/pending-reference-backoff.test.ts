import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_CAP_MS,
  isLastReferenceAttempt,
  nextReferenceAttemptAt,
  REFERENCE_ATTEMPT_LIMIT,
  REFERENCE_TTL_MS,
  referenceRetryDelayMs,
} from '../../../src/domain/pending-reference-backoff';
import { FakeClock } from '../../helpers/clock';

// RN-12; ADR-0007: base 2 s, fator 2, teto 5 min absoluto, jitter de ±20% antes do teto.
const MIDDLE = () => 0.5; // jitter zero
const LOWEST = () => 0; // -20%
const HIGHEST = () => 0.999_999_999; // quase +20%

describe('referenceRetryDelayMs (ADR-0007)', () => {
  test.each([
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 16_000],
  ])('tentativa %i sem jitter espera %i ms', (attempt, expected) => {
    expect(referenceRetryDelayMs(attempt, MIDDLE)).toBe(expected);
  });

  test('jitter fica entre -20% e +20% da espera base', () => {
    expect(referenceRetryDelayMs(1, LOWEST)).toBe(1_600);
    expect(referenceRetryDelayMs(1, HIGHEST)).toBeLessThanOrEqual(2_400);
    expect(referenceRetryDelayMs(1, HIGHEST)).toBeGreaterThan(2_399);
  });

  test('teto absoluto de 5 min, mesmo com jitter positivo', () => {
    expect(BACKOFF_CAP_MS).toBe(300_000);
    expect(referenceRetryDelayMs(9, MIDDLE)).toBe(300_000);
    expect(referenceRetryDelayMs(12, HIGHEST)).toBe(300_000);
  });

  test('perto do teto, o jitter só encurta a espera', () => {
    expect(referenceRetryDelayMs(9, LOWEST)).toBe(300_000 * 1);
    expect(referenceRetryDelayMs(8, LOWEST)).toBe(Math.round(256_000 * 0.8));
  });

  test.each([0, -1, 1.5, Number.NaN])('tentativa inválida %p é erro de programação', (attempt) => {
    expect(() => referenceRetryDelayMs(attempt, MIDDLE)).toThrow();
  });
});

describe('nextReferenceAttemptAt', () => {
  test('soma a espera ao relógio controlado', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(nextReferenceAttemptAt(clock.now(), 1, MIDDLE).toISOString()).toBe(
      '2026-01-01T00:00:02.000Z',
    );
  });
});

describe('isLastReferenceAttempt (RN-12; ADR-0007)', () => {
  const CREATED = new Date('2026-01-01T00:00:00.000Z');
  const SOON = new Date('2026-01-01T00:01:00.000Z');

  test('limites da RN-12: 12 tentativas e 24 h', () => {
    expect(REFERENCE_ATTEMPT_LIMIT).toBe(12);
    expect(REFERENCE_TTL_MS).toBe(24 * 60 * 60 * 1_000);
  });

  test.each([1, 2, 11])('tentativa %i dentro da janela não é a última', (attempt) => {
    expect(isLastReferenceAttempt(attempt, CREATED, SOON)).toBe(false);
  });

  test('a 12ª tentativa é a última, mesmo dentro da janela', () => {
    expect(isLastReferenceAttempt(12, CREATED, SOON)).toBe(true);
  });

  test('tentativa que começa com 24 h ou mais desde created_at é a última', () => {
    const clock = new FakeClock(CREATED);
    clock.advance(REFERENCE_TTL_MS - 1);
    expect(isLastReferenceAttempt(1, CREATED, clock.now())).toBe(false);
    clock.advance(1);
    expect(isLastReferenceAttempt(1, CREATED, clock.now())).toBe(true);
    clock.advance(60_000);
    expect(isLastReferenceAttempt(3, CREATED, clock.now())).toBe(true);
  });

  test.each([0, -1, 1.5, Number.NaN])('tentativa inválida %p é erro de programação', (attempt) => {
    expect(() => isLastReferenceAttempt(attempt, CREATED, SOON)).toThrow(RangeError);
  });

  test('tentativa além do limite é erro de programação', () => {
    expect(() => isLastReferenceAttempt(13, CREATED, SOON)).toThrow(RangeError);
  });
});
