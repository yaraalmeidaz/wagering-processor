import type { LedgerRepository } from './ledger-repository';
import type { TransactionRepository } from './transaction-repository';
import type { WalletRepository } from './wallet-repository';

/** Repositórios disponíveis só dentro de uma unidade de trabalho. */
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: TransactionRepository;
  readonly ledger: LedgerRepository;
}

/**
 * Executa o trabalho numa única transação SQL (SPEC 2.2 e 5.7; ADR-0001).
 * Exceção dentro do trabalho desfaz todas as escritas. Os repositórios recusam
 * uso depois do fim da unidade, para que nenhuma escrita aconteça fora dela.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
