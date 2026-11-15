import type {
  ProcessWagerInput,
  ProcessWagerResult,
} from '../../../src/application/use-cases/process-wager-transaction';

export type WorkerOutcome =
  | { ok: true; value: ProcessWagerResult }
  | { ok: false; error: string; message: string };

const WORKER = new URL('./wager-worker.ts', import.meta.url).pathname;

/**
 * Executa cada lote em um processo Bun separado, todos ao mesmo tempo
 * (AGENTS.md §2.9: concorrência com 3 ou mais processos).
 */
export async function runInProcesses(
  dbName: string,
  batches: ProcessWagerInput[][],
): Promise<{ pids: number[]; outcomes: WorkerOutcome[] }> {
  const startAt = String(Date.now() + 1_500);
  const children = batches.map((batch) =>
    Bun.spawn(
      [
        process.execPath,
        WORKER,
        dbName,
        startAt,
        Buffer.from(JSON.stringify(batch)).toString('base64'),
      ],
      { stdout: 'pipe', stderr: 'pipe', env: process.env },
    ),
  );

  const outputs = await Promise.all(
    children.map(async (child) => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) {
        throw new Error(`worker ${child.pid} saiu com ${code}: ${stderr}`);
      }
      const line = stdout.trim().split('\n').at(-1) ?? '';
      return JSON.parse(line) as { pid: number; results: WorkerOutcome[] };
    }),
  );

  return {
    pids: outputs.map((output) => output.pid),
    outcomes: outputs.flatMap((output) => output.results),
  };
}
