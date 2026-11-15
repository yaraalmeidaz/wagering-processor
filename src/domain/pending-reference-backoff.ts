/** Backoff de PENDING_REFERENCE (RN-12; ADR-0007). Tempos em milissegundos. */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 300_000;
export const BACKOFF_JITTER = 0.2;

/**
 * Espera antes da tentativa `attempt` (1 = primeira). O jitter de ±20% é aplicado
 * antes do teto, e o teto é absoluto: nenhuma espera passa de 5 min (ADR-0007).
 * `random` devolve um valor em [0, 1), como Math.random.
 */
export function referenceRetryDelayMs(attempt: number, random: () => number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`tentativa precisa ser inteiro >= 1, recebeu ${attempt}`);
  }
  const base = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1);
  const jitter = 1 + (2 * random() - 1) * BACKOFF_JITTER;
  return Math.min(Math.round(base * jitter), BACKOFF_CAP_MS);
}

export function nextReferenceAttemptAt(now: Date, attempt: number, random: () => number): Date {
  return new Date(now.getTime() + referenceRetryDelayMs(attempt, random));
}
