import type { LedgerRepository } from './ledger-repository';
import type { OutboxRepository } from './outbox-repository';
import type { TransactionRepository } from './transaction-repository';
import type { WalletRepository } from './wallet-repository';

/** Repositórios disponíveis só dentro de uma unidade de trabalho. */
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: TransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
}

/**
 * Executa o trabalho numa única transação SQL (SPEC 2.2, 5.3 e 5.7; ADR-0001), com
 * SET LOCAL lock_timeout = '3000ms' e statement_timeout = '5000ms' (ADR-0003).
 * Exceção dentro do trabalho desfaz todas as escritas. Os repositórios recusam
 * uso depois do fim da unidade, para que nenhuma escrita aconteça fora dela.
 * Erros do banco chegam como erros da aplicação: TransientFailureError (55P03,
 * 40P01, 40001, 57014, conexão) e UniqueViolationError (23505).
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
