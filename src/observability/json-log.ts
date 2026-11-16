import type { Clock } from '../application/ports/clock';
import type { LogSink } from './log-sink';

export type LogLevel = 'info' | 'warn' | 'error';

/** Campos permitidos: identificadores e resultado, nunca payload financeiro (SPEC 14.1). */
export type LogFields = Readonly<Record<string, string | number | boolean | null | object>>;

/** Uma linha JSON com timestamp, level e event (SPEC 14.1; ADR-0009, ADR-0010). */
export class JsonLogger {
  readonly #sink: LogSink;
  readonly #clock: Clock;

  constructor(sink: LogSink, clock: Clock) {
    this.#sink = sink;
    this.#clock = clock;
  }

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.#sink.write(
      JSON.stringify({ timestamp: this.#clock.now().toISOString(), level, event, ...fields }),
    );
  }
}
