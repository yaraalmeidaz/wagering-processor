/** Destino de linhas de log JSON, uma por chamada (SPEC 14.1). */
export interface LogSink {
  write(line: string): void;
}

/** Uma linha JSON por registro na saída padrão. */
export const stdoutLogSink: LogSink = {
  write(line) {
    process.stdout.write(`${line}\n`);
  },
};
