import type {
  DependencyCheck,
  ReadinessCheck,
  ReadinessStatus,
} from '../application/ports/readiness-check';

/** PostgreSQL e SQS verificados em paralelo (enunciado §9; ADR-0010). */
export class CompositeReadinessCheck implements ReadinessCheck {
  readonly #postgres: DependencyCheck;
  readonly #sqs: DependencyCheck;

  constructor(checks: { postgres: DependencyCheck; sqs: DependencyCheck }) {
    this.#postgres = checks.postgres;
    this.#sqs = checks.sqs;
  }

  async check(): Promise<ReadinessStatus> {
    const [postgres, sqs] = await Promise.all([this.#postgres.check(), this.#sqs.check()]);
    return { postgres, sqs };
  }
}
