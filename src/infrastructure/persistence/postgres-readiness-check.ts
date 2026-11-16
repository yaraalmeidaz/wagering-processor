import type { MikroORM } from '@mikro-orm/postgresql';
import type { DependencyCheck, DependencyStatus } from '../../application/ports/readiness-check';

/** Readiness do PostgreSQL com SELECT 1. */
export class PostgresReadinessCheck implements DependencyCheck {
  readonly #orm: MikroORM;

  constructor(orm: MikroORM) {
    this.#orm = orm;
  }

  async check(): Promise<DependencyStatus> {
    try {
      await this.#orm.em.fork().getConnection().execute('SELECT 1');
      return 'ok';
    } catch {
      return 'fail';
    }
  }
}
