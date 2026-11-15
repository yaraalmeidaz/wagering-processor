/**
 * Relógio injetável para testes que dependem de tempo (backoff, TTL,
 * next_attempt_at). Sem imports de src/ nem de framework.
 *
 * A SPEC (seção 2.2, src/application/) prevê uma porta `Clock` na aplicação.
 * Quando ela existir, este helper deve implementá-la em vez de declarar a
 * própria interface.
 */
export interface Clock {
  now(): Date;
}

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
