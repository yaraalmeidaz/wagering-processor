/** Mensagem pendente do outbox. O id é o eventId do envelope (SPEC 11.2). */
export interface OutboxRecord {
  readonly id: string;
  /** walletId da carteira afetada (ADR-0006). */
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

/**
 * Porta do outbox (SPEC 2.2; RN-30). Nesta fase só grava, na mesma transação
 * do efeito. A publicação entra com a mensageria (ADR-0006).
 */
export interface OutboxRepository {
  append(record: OutboxRecord): Promise<void>;
}
