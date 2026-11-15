export type DependencyStatus = 'ok' | 'fail';

/** Verifica as dependências da readiness (AGENTS.md §10). O SQS entra com a mensageria. */
export interface ReadinessCheck {
  check(): Promise<{ postgres: DependencyStatus }>;
}
