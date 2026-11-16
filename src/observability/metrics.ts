/** Rótulos de uma série. A ordem das chaves não importa. */
export type MetricLabels = Readonly<Record<string, string>>;

/** Buckets do histograma de latência, em segundos (ADR-0011). Só definem a resolução da medida. */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

/** Contadores, gauges e histogramas da SPEC 14.2 (ADR-0009, ADR-0010, ADR-0011). */
export interface Metrics {
  increment(name: string, labels?: MetricLabels): void;
  /** Gauge: guarda o último valor. */
  set(name: string, reading: number, labels?: MetricLabels): void;
  /** Histograma com os DURATION_BUCKETS. */
  observe(name: string, reading: number, labels?: MetricLabels): void;
  /** Valor de um contador ou gauge. */
  value(name: string, labels?: MetricLabels): number;
  /** Formato de exposição de texto do Prometheus, versão 0.0.4. */
  render(): string;
}

type Kind = 'counter' | 'gauge' | 'histogram';

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

interface Family {
  readonly kind: Kind;
  /** Chave: rótulos já renderizados, como `channel="http",status="PROCESSED"`. */
  readonly series: Map<string, number | Histogram>;
}

/** Em memória, por processo. Não é cache de idempotência (AGENTS.md §2.3). */
export class InMemoryMetrics implements Metrics {
  readonly #families = new Map<string, Family>();

  increment(name: string, labels: MetricLabels = {}): void {
    const series = this.#family(name, 'counter').series;
    const key = labelKey(labels);
    series.set(key, ((series.get(key) as number | undefined) ?? 0) + 1);
  }

  set(name: string, reading: number, labels: MetricLabels = {}): void {
    this.#family(name, 'gauge').series.set(labelKey(labels), reading);
  }

  observe(name: string, reading: number, labels: MetricLabels = {}): void {
    const series = this.#family(name, 'histogram').series;
    const key = labelKey(labels);
    let histogram = series.get(key) as Histogram | undefined;
    if (histogram === undefined) {
      histogram = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      series.set(key, histogram);
    }
    const current = histogram;
    current.buckets = current.buckets.map((count, index) =>
      reading <= (DURATION_BUCKETS[index] ?? Number.POSITIVE_INFINITY) ? count + 1 : count,
    );
    histogram.sum += reading;
    histogram.count += 1;
  }

  value(name: string, labels: MetricLabels = {}): number {
    const reading = this.#families.get(name)?.series.get(labelKey(labels));
    return typeof reading === 'number' ? reading : 0;
  }

  render(): string {
    let text = '';
    for (const [name, family] of [...this.#families].sort(([a], [b]) => a.localeCompare(b))) {
      text += `# TYPE ${name} ${family.kind}\n`;
      for (const [key, reading] of family.series) {
        if (typeof reading === 'number') {
          text += `${name}${braces(key)} ${reading}\n`;
          continue;
        }
        DURATION_BUCKETS.forEach((bound, index) => {
          text += `${name}_bucket${braces(join(key, `le="${bound}"`))} ${reading.buckets[index]}\n`;
        });
        text += `${name}_bucket${braces(join(key, 'le="+Inf"'))} ${reading.count}\n`;
        text += `${name}_sum${braces(key)} ${round(reading.sum)}\n`;
        text += `${name}_count${braces(key)} ${reading.count}\n`;
      }
    }
    return text;
  }

  #family(name: string, kind: Kind): Family {
    let family = this.#families.get(name);
    if (family === undefined) {
      family = { kind, series: new Map() };
      this.#families.set(name, family);
    }
    if (family.kind !== kind) {
      throw new Error(`métrica ${name} já registrada como ${family.kind}`);
    }
    return family;
  }
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabel(labels[key] ?? '')}"`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function join(key: string, extra: string): string {
  return key === '' ? extra : `${key},${extra}`;
}

function braces(key: string): string {
  return key === '' ? '' : `{${key}}`;
}

/** Remove o ruído de ponto flutuante da soma (ex.: 9.034000000000001). */
function round(sum: number): number {
  return Number(sum.toFixed(9));
}
