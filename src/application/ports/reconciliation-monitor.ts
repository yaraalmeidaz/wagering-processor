import type { ReconciliationResult } from '../use-cases/reconcile-wallet';

/** Contexto de quem pediu a reconciliação, para correlacionar o log (SPEC 14.1). */
export interface ReconciliationContext {
  readonly correlationId: string;
}

/** Recebe divergências de reconciliação: log e métrica, nunca correção (RN-37). */
export interface ReconciliationMonitor {
  divergenceDetected(result: ReconciliationResult, context: ReconciliationContext): void;
}
