import type { Wallet } from '../../domain/wallet';

/** Porta de persistência da Wallet (SPEC 2.2). Lock e CAS por version entram na Fase 4. */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  add(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}
