export type DependencyStatus = 'ok' | 'fail';

/** Uma dependência da readiness. Nunca lança: falha vira 'fail'. */
export interface DependencyCheck {
  check(): Promise<DependencyStatus>;
}

export interface ReadinessStatus {
  readonly postgres: DependencyStatus;
  readonly sqs: DependencyStatus;
}

/** Verifica as dependências da readiness (AGENTS.md §10; SPEC 13; ADR-0010). */
export interface ReadinessCheck {
  check(): Promise<ReadinessStatus>;
}
