/**
 * Filas da SPEC 10.1. No ambiente local, scripts/localstack/create-queues.sh cria
 * estas filas com os mesmos valores (ADR-0010).
 */
export const INPUT_QUEUE = 'wager-transactions.fifo';
export const DLQ_QUEUE = 'wager-transactions-dlq.fifo';
export const EVENTS_QUEUE = 'wager-events.fifo';

/** Entregas antes do redrive para a DLQ (RN-35). */
export const MAX_RECEIVE_COUNT = 5;

/** Nome do consumer no inbox (SPEC 12: consumer_name). */
export const WAGER_CONSUMER = 'wager-transactions';

export interface QueueUrls {
  readonly input: string;
  readonly dlq: string;
  readonly events: string;
}
