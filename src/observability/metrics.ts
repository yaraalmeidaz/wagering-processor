/** Contadores mínimos até a fase de observabilidade (SPEC 14; ADR-0009). */
export interface Metrics {
  increment(name: string): void;
  value(name: string): number;
}

/** Contador em memória, por processo. Não é cache de idempotência (AGENTS.md §2.3). */
export class InMemoryMetrics implements Metrics {
  readonly #counters = new Map<string, number>();

  increment(name: string): void {
    this.#counters.set(name, this.value(name) + 1);
  }

  value(name: string): number {
    return this.#counters.get(name) ?? 0;
  }
}
