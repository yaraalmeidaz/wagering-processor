import type { WagerTransaction } from '../../domain/wager-transaction';

/** Porta de persistência da WagerTransaction (SPEC 2.2). Busca idempotente entra na Fase 4. */
export interface TransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  add(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}
