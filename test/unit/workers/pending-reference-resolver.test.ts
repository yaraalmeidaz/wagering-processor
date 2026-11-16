import { describe, expect, test } from 'bun:test';
import type { PendingReferenceCandidate } from '../../../src/application/ports/transaction-repository';
import type { ResolveResult } from '../../../src/application/use-cases/resolve-pending-reference';
import { PendingReferenceWorker } from '../../../src/infrastructure/workers/pending-reference-resolver';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { FakeClock } from '../../helpers/clock';

// Lógica pura do loop (ADR-0007, decisão E): fontes falsas são aceitas só aqui (AGENTS.md §2.10).
const candidate = (n: number): PendingReferenceCandidate => ({ id: `tx-${n}`, walletId: 'w-1' });

function worker(options: {
  batches: (limit: number) => Promise<readonly PendingReferenceCandidate[]>;
  resolve?: (candidate: PendingReferenceCandidate) => Promise<ResolveResult>;
  sleeps?: number[];
  lines?: string[];
}) {
  const sleeps = options.sleeps ?? [];
  return new PendingReferenceWorker({
    candidates: options.batches,
    resolver: {
      resolve:
        options.resolve ??
        (async (c) => ({ transactionId: c.id, outcome: 'RESCHEDULED' as const })),
    },
    clock: new FakeClock(new Date('2026-01-01T00:00:00.000Z')),
    metrics: new InMemoryMetrics(),
    sink: { write: (line) => options.lines?.push(line) },
    random: () => 0.5,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      // Espera curta e interrompível, para o teste não depender do tempo real.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  });
}

describe('PendingReferenceWorker (ADR-0007, decisão E)', () => {
  test('busca lotes de 50 e espera 1 s quando não há pendência vencida', async () => {
    const limits: number[] = [];
    const sleeps: number[] = [];
    const loop = worker({
      batches: async (limit) => {
        limits.push(limit);
        return [];
      },
      sleeps,
    });
    loop.start();
    while (sleeps.length < 2) await Bun.sleep(1);
    await loop.stop();
    expect(limits.every((limit) => limit === 50)).toBe(true);
    expect(sleeps.slice(0, 2)).toEqual([1_000, 1_000]);
  });

  test('com pendências tratadas, busca de novo sem esperar', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const loop = worker({
      batches: async () => {
        calls += 1;
        return calls === 1 ? [candidate(1), candidate(2)] : [];
      },
      sleeps,
    });
    loop.start();
    while (calls < 2) await Bun.sleep(1);
    await loop.stop();
    // A primeira espera só vem depois do lote vazio.
    expect(sleeps[0]).toBe(1_000);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('stop no meio do lote termina o item em andamento e não começa o próximo', async () => {
    const resolved: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const loop = worker({
      batches: async () => [candidate(1), candidate(2), candidate(3)],
      resolve: async (c) => {
        started();
        await gate;
        resolved.push(c.id);
        return { transactionId: c.id, outcome: 'PROCESSED' };
      },
    });
    loop.start();
    await inFlight;
    const stopping = loop.stop();
    release();
    await stopping;
    expect(resolved).toEqual(['tx-1']);
  });

  test('stop interrompe a espera ociosa', async () => {
    const sleeps: number[] = [];
    const loop = new PendingReferenceWorker({
      candidates: async () => [],
      resolver: { resolve: async (c) => ({ transactionId: c.id, outcome: 'SKIPPED' }) },
      clock: new FakeClock(new Date('2026-01-01T00:00:00.000Z')),
      metrics: new InMemoryMetrics(),
      sink: { write: () => {} },
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          sleeps.push(ms);
          // Sem o abort, esta espera nunca termina.
          signal.addEventListener('abort', () => resolve());
        }),
    });
    loop.start();
    while (sleeps.length < 1) await Bun.sleep(1);
    await loop.stop();
    expect(sleeps).toEqual([1_000]);
  });

  test('busca que falha espera com backoff crescente e zera depois de uma busca bem-sucedida', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const lines: string[] = [];
    const loop = worker({
      batches: async () => {
        calls += 1;
        if (calls <= 2) throw new Error('banco fora');
        return [];
      },
      sleeps,
      lines,
    });
    loop.start();
    while (sleeps.length < 4) await Bun.sleep(1);
    await loop.stop();
    // Tentativas 1 e 2 da ADR-0007 sem jitter, depois a espera ociosa normal.
    expect(sleeps.slice(0, 4)).toEqual([2_000, 4_000, 1_000, 1_000]);
    expect(lines.filter((line) => line.includes('pending_reference_cycle_failed'))).toHaveLength(2);
  });

  test('loga identificadores e resultado, nunca payload (SPEC 14.1)', async () => {
    const lines: string[] = [];
    let calls = 0;
    const loop = worker({
      batches: async () => {
        calls += 1;
        return calls === 1 ? [candidate(7)] : [];
      },
      resolve: async (c) => ({
        transactionId: c.id,
        outcome: 'POSTPONED',
        cause: new Error('lock'),
      }),
      lines,
    });
    loop.start();
    while (calls < 2) await Bun.sleep(1);
    await loop.stop();
    const attempt = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'pending_reference_attempt');
    expect(attempt).toMatchObject({
      level: 'warn',
      transactionId: 'tx-7',
      walletId: 'w-1',
      outcome: 'POSTPONED',
      error: 'Error',
    });
  });
});
