/** Processos Bun reais para os testes de concorrência e queda (AGENTS.md §2.9). */
export interface ProcessResult<T> {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  /** Última linha JSON do stdout, ou null se o processo morreu antes de imprimir. */
  readonly output: T | null;
  readonly stderr: string;
}

export function spawnWorker<T>(script: URL, args: string[]): Promise<ProcessResult<T>> {
  const child = Bun.spawn([process.execPath, script.pathname, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    const line = stdout.trim().split('\n').at(-1) ?? '';
    let output: T | null = null;
    try {
      output = line === '' ? null : (JSON.parse(line) as T);
    } catch {
      output = null;
    }
    return {
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      output,
      stderr,
    };
  })();
}

/** Instante comum de partida, para os processos disputarem ao mesmo tempo. */
export function startAt(delayMs = 1_500): string {
  return String(Date.now() + delayMs);
}
