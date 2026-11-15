import type { EntityManager } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports/unit-of-work';
import { MikroOrmLedgerRepository } from './repositories/mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository';
import { MikroOrmTransactionRepository } from './repositories/mikro-orm-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';
import { TransactionScope } from './transaction-scope';
import { translateDriverError } from './translate-driver-error';

/**
 * Cada execução usa um em.fork() novo e uma única transação SQL (ADR-0001).
 * O Identity Map não passa de uma execução para outra (AGENTS.md §2.12).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  readonly #em: EntityManager;

  constructor(em: EntityManager) {
    this.#em = em;
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    // O fork garante a fronteira da unidade de trabalho. O transactional() também cria um fork internamente.
    const fork = this.#em.fork();
    try {
      return await fork.transactional(async (em) => {
        // SPEC 5.3; ADR-0003.
        await em.execute(`SET LOCAL lock_timeout = '3000ms'`);
        await em.execute(`SET LOCAL statement_timeout = '5000ms'`);
        const scope = new TransactionScope();
        try {
          return await work({
            wallets: new MikroOrmWalletRepository(em, scope),
            transactions: new MikroOrmTransactionRepository(em, scope),
            ledger: new MikroOrmLedgerRepository(em, scope),
            outbox: new MikroOrmOutboxRepository(em, scope),
          });
        } finally {
          scope.close();
        }
      });
    } catch (error) {
      throw translateDriverError(error);
    }
  }
}
