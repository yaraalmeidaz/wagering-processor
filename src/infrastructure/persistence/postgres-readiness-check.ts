import type { MikroORM } from '@mikro-orm/postgresql';
import type { DependencyStatus, ReadinessCheck } from '../../application/ports/readiness-check';

/** Readiness do PostgreSQL com SELECT 1. O SQS entra na verificação com a mensageria (Fase 6). */
export class PostgresReadinessCheck implements ReadinessCheck {
  readonly #orm: MikroORM;

  constructor(orm: MikroORM) {
    this.#orm = orm;
  }

  async check(): Promise<{ postgres: DependencyStatus }> {
    try {
      await this.#orm.em.fork().getConnection().execute('SELECT 1');
      return { postgres: 'ok' };
    } catch {
      return { postgres: 'fail' };
    }
  }
}
