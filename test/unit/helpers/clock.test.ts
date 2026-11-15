import { describe, expect, test } from 'bun:test';
import { type Clock, FakeClock, SystemClock } from '../../helpers/clock';

const START = new Date('2026-01-01T00:00:00.000Z');

describe('SystemClock', () => {
  test('devolve a data atual', () => {
    const clock: Clock = new SystemClock();

    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe('FakeClock', () => {
  test('começa na data que recebe', () => {
    const clock: Clock = new FakeClock(START);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('não avança sozinho', () => {
    const clock = new FakeClock(START);

    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  test('avança em milissegundos', () => {
    const clock = new FakeClock(START);

    clock.advance(1_500);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.500Z');
  });

  test('avança em segundos', () => {
    const clock = new FakeClock(START);

    clock.advanceSeconds(90);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:30.000Z');
  });

  test('recusa avanço negativo e mantém o tempo', () => {
    const clock = new FakeClock(START);

    expect(() => clock.advance(-1)).toThrow();
    expect(() => clock.advanceSeconds(-1)).toThrow();
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('recusa avanço não finito', () => {
    const clock = new FakeClock(START);

    expect(() => clock.advance(Number.NaN)).toThrow();
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow();
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('dois relógios não compartilham estado', () => {
    const a = new FakeClock(START);
    const b = new FakeClock(START);

    a.advance(10_000);

    expect(a.now().toISOString()).toBe('2026-01-01T00:00:10.000Z');
    expect(b.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('não é afetado por mutação da data recebida nem da devolvida', () => {
    const start = new Date(START);
    const clock = new FakeClock(start);

    start.setUTCFullYear(2000);
    clock.now().setUTCFullYear(2000);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
