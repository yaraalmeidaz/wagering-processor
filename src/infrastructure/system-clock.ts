import type { Clock } from '../application/ports/clock';

/** Relógio do sistema, implementação de produção da porta Clock (SPEC 2.2). */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
