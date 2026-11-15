import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_CAP_MS,
  nextReferenceAttemptAt,
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
