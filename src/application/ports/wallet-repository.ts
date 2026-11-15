import type { Wallet } from '../../domain/wallet';

/** Porta de persistência da Wallet (SPEC 2.2). */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE: o lock dura até o COMMIT ou ROLLBACK (SPEC 5.5; ADR-0003). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  add(wallet: Wallet): Promise<void>;
  /**
   * UPDATE condicionado à versão lida (CAS, ADR-0003), mesmo sob lock.
   * Lança WalletVersionConflictError se a versão não confere.
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}
