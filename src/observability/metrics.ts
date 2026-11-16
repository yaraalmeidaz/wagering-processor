/** Contadores e gauges mínimos até a fase de observabilidade (SPEC 14; ADR-0009, ADR-0010). */
export interface Metrics {
  increment(name: string): void;
  /** Gauge: guarda o último valor. */
  set(name: string, reading: number): void;
  value(name: string): number;
}

/** Em memória, por processo. Não é cache de idempotência (AGENTS.md §2.3). */
export class InMemoryMetrics implements Metrics {
  readonly #values = new Map<string, number>();

  increment(name: string): void {
    this.#values.set(name, this.value(name) + 1);
  }

  set(name: string, reading: number): void {
    this.#values.set(name, reading);
  }

  value(name: string): number {
    return this.#values.get(name) ?? 0;
  }
}
