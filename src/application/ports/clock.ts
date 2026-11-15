/** Porta de relógio da aplicação (SPEC 2.2). */
export interface Clock {
  now(): Date;
}
