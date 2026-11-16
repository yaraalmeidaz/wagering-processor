/** Tokens de injeção das portas usadas pela camada HTTP. */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const METRICS = Symbol('METRICS');
export const READINESS_CHECK = Symbol('READINESS_CHECK');
export const RECONCILIATION_MONITOR = Symbol('RECONCILIATION_MONITOR');
export const LOG_SINK = Symbol('LOG_SINK');
/** Caso de uso de transação, real ou instrumentado (ADR-0011). */
export const PROCESS_WAGER = Symbol('PROCESS_WAGER');
