import type { TransactionStatus } from './wager-transaction';

export interface IncomingIdempotency {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
}

/** Linha encontrada por idempotency_key ou por (provider_id, external_transaction_id). */
export interface StoredIdempotency extends IncomingIdempotency {
  readonly status: TransactionStatus;
}

export type IdempotencyPhase = 'FAST_PATH' | 'UNDER_LOCK';

export type IdempotencyDecision =
  | 'NOT_FOUND'
  | 'REPLAY'
  | 'PAYLOAD_MISMATCH'
  | 'KEY_CONFLICT'
  | 'SLOW_PATH';

/** O fast-path só decide sobre estados terminais da SPEC 5.4. */
const FAST_PATH_TERMINAL: ReadonlySet<TransactionStatus> = new Set(['PROCESSED', 'REJECTED']);

/** Decisão de idempotência da SPEC 5.4 e 5.5 (RN-20 a RN-22; ADR-0005). */
export function decideIdempotency(
  found: StoredIdempotency | null,
  incoming: IncomingIdempotency,
  phase: IdempotencyPhase,
): IdempotencyDecision {
  if (found === null) {
    return 'NOT_FOUND';
  }
  if (phase === 'FAST_PATH' && !FAST_PATH_TERMINAL.has(found.status)) {
    return 'SLOW_PATH';
  }
  if (found.idempotencyKey !== incoming.idempotencyKey) {
    return 'KEY_CONFLICT';
  }
  if (found.payloadHash !== incoming.payloadHash) {
    return 'PAYLOAD_MISMATCH';
  }
  return 'REPLAY';
}
