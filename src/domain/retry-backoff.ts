/**
 * Backoff exponencial da ADR-0007, usado pelo PENDING_REFERENCE (RN-12) e pelo
 * outbox (ADR-0006). Tempos em milissegundos.
 */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 300_000;
export const BACKOFF_JITTER = 0.2;
/** Tentativas antes do esgotamento (ADR-0006; ADR-0007). */
export const RETRY_ATTEMPT_LIMIT = 12;

/**
 * Espera antes da tentativa `attempt` (1 = primeira). O jitter de ±20% é aplicado
 * antes do teto, e o teto é absoluto: nenhuma espera passa de 5 min (ADR-0007).
 * `random` devolve um valor em [0, 1), como Math.random.
 */
export function retryDelayMs(attempt: number, random: () => number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`tentativa precisa ser inteiro >= 1, recebeu ${attempt}`);
  }
  const base = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1);
  const jitter = 1 + (2 * random() - 1) * BACKOFF_JITTER;
  return Math.min(Math.round(base * jitter), BACKOFF_CAP_MS);
}
