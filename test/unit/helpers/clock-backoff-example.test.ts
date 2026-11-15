import { describe, expect, test } from 'bun:test';
import { type Clock, FakeClock } from '../../helpers/clock';

// Exemplo de uso do FakeClock, não é a implementação da RN-12.
// Usa só base 2 s e fator 2; o teto e o jitter da RN-12 ficam para o cálculo real.
const BASE_MS = 2_000;
const FACTOR = 2;

function nextAttemptAt(clock: Clock, attempt: number): Date {
  return new Date(clock.now().getTime() + BASE_MS * FACTOR ** (attempt - 1));
}

describe('exemplo: next_attempt_at com backoff base 2 s e fator 2 (RN-12, sem teto e sem jitter)', () => {
  test('cada tentativa dobra a espera a partir do relógio controlado', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));

    expect(nextAttemptAt(clock, 1).toISOString()).toBe('2026-01-01T00:00:02.000Z');
    expect(nextAttemptAt(clock, 2).toISOString()).toBe('2026-01-01T00:00:04.000Z');
    expect(nextAttemptAt(clock, 3).toISOString()).toBe('2026-01-01T00:00:08.000Z');
  });

  test('a tentativa só fica devida quando o relógio alcança next_attempt_at', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const due = nextAttemptAt(clock, 2);

    clock.advanceSeconds(3);
    expect(clock.now() >= due).toBe(false);

    clock.advance(1_000);
    expect(clock.now() >= due).toBe(true);
  });
});
