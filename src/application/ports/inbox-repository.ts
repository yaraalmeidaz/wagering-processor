import type { InboxMessage } from '../../domain/inbox-message';

/** Inbox da fila, por (consumerName, messageId) (SPEC 10.2 e 12; ADR-0010). */
export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  /** INSERT. Repetir o par viola o PRIMARY KEY (23505). */
  add(message: InboxMessage): Promise<void>;
}
