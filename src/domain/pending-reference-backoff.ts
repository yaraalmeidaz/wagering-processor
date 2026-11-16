import { RETRY_ATTEMPT_LIMIT, retryDelayMs } from './retry-backoff';

/** Backoff de PENDING_REFERENCE (RN-12; ADR-0007). A fórmula vive em retry-backoff. */
export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_JITTER,
} from './retry-backoff';

/** Limite de tentativas e TTL contado a partir de created_at (RN-12; ADR-0007). */
export const REFERENCE_ATTEMPT_LIMIT = RETRY_ATTEMPT_LIMIT;
export const REFERENCE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Espera antes da tentativa `attempt` de resolver a referência (ADR-0007). */
export const referenceRetryDelayMs = retryDelayMs;

export function nextReferenceAttemptAt(now: Date, attempt: number, random: () => number): Date {
  return new Date(now.getTime() + referenceRetryDelayMs(attempt, random));
}

/**
 * A tentativa `attempt` (1 = primeira), iniciada em `now`, é a última (RN-12; ADR-0007).
 * A última tentativa também procura a referência; só a ausência dela rejeita.
 */
export function isLastReferenceAttempt(attempt: number, createdAt: Date, now: Date): boolean {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > REFERENCE_ATTEMPT_LIMIT) {
    throw new RangeError(
      `tentativa precisa ser inteiro entre 1 e ${REFERENCE_ATTEMPT_LIMIT}, recebeu ${attempt}`,
    );
  }
  return (
    attempt === REFERENCE_ATTEMPT_LIMIT || now.getTime() - createdAt.getTime() >= REFERENCE_TTL_MS
  );
}
