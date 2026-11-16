import type { OutboxMessage } from '../../domain/outbox-message';

/** Resultado de uma tentativa sobre um agregado. `locked: false`: outro publisher o tem. */
export type AggregateAttempt<T> =
  | { readonly locked: false }
  | { readonly locked: true; readonly value: T };

/**
 * Leitura e gravação do outbox para o publisher por agregado (SPEC 11.3; ADR-0006).
 * `withAggregate` abre uma transação com o advisory lock do agregado e o FOR UPDATE do
 * pendente mais antigo, e só faz COMMIT depois que `work` termina.
 */
export interface OutboxPublicationStore {
  /** Passo 1: agregados cujo pendente mais antigo já venceu, em ordem de seq. */
  dueAggregates(limit: number): Promise<string[]>;
  withAggregate<T>(
    aggregateId: string,
    work: (
      head: OutboxMessage | null,
      save: (message: OutboxMessage) => Promise<void>,
    ) => Promise<T>,
  ): Promise<AggregateAttempt<T>>;
  /** occurred_at do pendente mais antigo, para o outbox lag (SPEC 11.4). */
  oldestPendingOccurredAt(): Promise<Date | null>;
}
