/**
 * Relógio injetável para testes que dependem de tempo (backoff, TTL,
 * next_attempt_at). Implementa a porta Clock da aplicação (SPEC 2.2).
 */
import type { Clock } from '../../src/application/ports/clock';

export type { Clock };

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Relógio controlado: só anda quando o teste chama advance(). */
export class FakeClock implements Clock {
  #epochMs: number;

  constructor(start: Date) {
    this.#epochMs = start.getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  /** Avança `ms` milissegundos. Recusa valor negativo ou não finito. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance exige ms finito e >= 0, recebeu ${ms}`);
    }
    this.#epochMs += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1_000);
  }
}
