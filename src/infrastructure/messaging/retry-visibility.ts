import { retryDelayMs } from '../../domain/retry-backoff';

/** Espera da ADR-0007, em segundos inteiros para ChangeMessageVisibility (SPEC 10.3; ADR-0010). */
export function retryVisibilitySeconds(receiveCount: number, random: () => number): number {
  return Math.ceil(retryDelayMs(receiveCount, random) / 1_000);
}
