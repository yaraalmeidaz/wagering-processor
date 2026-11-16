import { retryDelayMs } from './retry-backoff';

/** Backoff de PENDING_REFERENCE (RN-12; ADR-0007). A fórmula vive em retry-backoff. */
export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_JITTER,
} from './retry-backoff';

/** Espera antes da tentativa `attempt` de resolver a referência (ADR-0007). */
export const referenceRetryDelayMs = retryDelayMs;

export function nextReferenceAttemptAt(now: Date, attempt: number, random: () => number): Date {
  return new Date(now.getTime() + referenceRetryDelayMs(attempt, random));
}
