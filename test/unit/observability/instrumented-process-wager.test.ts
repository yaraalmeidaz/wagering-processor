import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidWagerInputError,
  TransientFailureError,
  WalletVersionConflictError,
} from '../../../src/application/errors';
import type {
  ProcessWager,
  ProcessWagerInput,
  ProcessWagerResult,
} from '../../../src/application/use-cases/process-wager-transaction';
import { InboxMessage } from '../../../src/domain/inbox-message';
import {
  InstrumentedProcessWager,
  WAGER_IDEMPOTENCY_CONFLICTS,
  WAGER_IDEMPOTENT_REPLAYS,
  WAGER_LOCK_CONFLICTS,
  WAGER_PROCESSING_DURATION,
  WAGER_TRANSACTIONS,
} from '../../../src/observability/instrumented-process-wager';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { FakeClock } from '../../helpers/clock';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

const input: ProcessWagerInput = {
  idempotencyKey: 'provider-a:tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: PLAYER,
  walletId: WALLET,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  correlationId: 'corr-1',
};

const processed: ProcessWagerResult = {
  transactionId: 'tx-internal-1',
  status: 'PROCESSED',
  failureCode: null,
  balance: { amount: '75.00', currency: 'BRL' },
  idempotentReplay: false,
};

function harness(outcome: () => Promise<ProcessWagerResult>) {
  const metrics = new InMemoryMetrics();
  const lines: Record<string, unknown>[] = [];
  let tick = 0;
  const inner: ProcessWager = { execute: () => outcome() };
  const instrumented = new InstrumentedProcessWager(inner, {
    metrics,
    sink: { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    clock: new FakeClock(new Date('2026-11-16T12:00:00Z')),
    // Relógio monotônico controlado: cada leitura avança 40 ms.
    elapsedMs: () => {
      tick += 40;
      return tick;
    },
  });
  return { metrics, lines, instrumented };
}

function sqsInput(): ProcessWagerInput {
  return {
    ...input,
    inbox: InboxMessage.receive({
      consumerName: 'wager-consumer',
      messageId: 'msg-1',
      payloadHash: 'a'.repeat(64),
      now: new Date('2026-11-16T12:00:00Z'),
    }),
  };
}

// ADR-0011; SPEC 14.1 e 14.2.
describe('InstrumentedProcessWager', () => {
  test('resultado novo conta por canal e status, mede a latência e escreve uma linha JSON', async () => {
    const { metrics, lines, instrumented } = harness(async () => processed);
    expect(await instrumented.execute(input)).toEqual(processed);

    expect(metrics.value(WAGER_TRANSACTIONS, { channel: 'http', status: 'PROCESSED' })).toBe(1);
    expect(metrics.value(WAGER_IDEMPOTENT_REPLAYS, { channel: 'http' })).toBe(0);
    expect(metrics.render()).toContain(
      `${WAGER_PROCESSING_DURATION}_count{channel="http",outcome="result"} 1`,
    );
    expect(metrics.render()).toContain(
      `${WAGER_PROCESSING_DURATION}_sum{channel="http",outcome="result"} 0.04`,
    );
    expect(lines).toEqual([
      {
        timestamp: '2026-11-16T12:00:00.000Z',
        level: 'info',
        event: 'wager_transaction_result',
        channel: 'http',
        correlationId: 'corr-1',
        transactionId: 'tx-internal-1',
        walletId: WALLET,
        providerId: 'provider-a',
        kind: 'BET',
        status: 'PROCESSED',
        failureCode: null,
        idempotentReplay: false,
        durationMs: 40,
      },
    ]);
  });

  test('replay conta como duplicata e não como transação nova (RN-20)', async () => {
    const { metrics, instrumented } = harness(async () => ({
      ...processed,
      idempotentReplay: true,
    }));
    await instrumented.execute(input);
    expect(metrics.value(WAGER_IDEMPOTENT_REPLAYS, { channel: 'http' })).toBe(1);
    expect(metrics.value(WAGER_TRANSACTIONS, { channel: 'http', status: 'PROCESSED' })).toBe(0);
  });

  test('rejeição conta com o status REJECTED e leva o failureCode ao log (RN-19)', async () => {
    const { metrics, lines, instrumented } = harness(async () => ({
      ...processed,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    }));
    await instrumented.execute(input);
    expect(metrics.value(WAGER_TRANSACTIONS, { channel: 'http', status: 'REJECTED' })).toBe(1);
    expect(lines[0]?.['failureCode']).toBe('INSUFFICIENT_FUNDS');
  });

  test('entrada com inbox é do canal sqs e leva o messageId ao log', async () => {
    const { metrics, lines, instrumented } = harness(async () => processed);
    await instrumented.execute(sqsInput());
    expect(metrics.value(WAGER_TRANSACTIONS, { channel: 'sqs', status: 'PROCESSED' })).toBe(1);
    expect(lines[0]?.['channel']).toBe('sqs');
    expect(lines[0]?.['messageId']).toBe('msg-1');
  });

  test.each([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'serialization'],
  ])(
    'TransientFailureError %s conta como conflito de lock %s e é relançado',
    async (state, reason) => {
      const failure = new TransientFailureError('falha', state);
      const { metrics, lines, instrumented } = harness(async () => {
        throw failure;
      });
      await expect(instrumented.execute(input)).rejects.toBe(failure);
      expect(metrics.value(WAGER_LOCK_CONFLICTS, { channel: 'http', reason })).toBe(1);
      expect(metrics.render()).toContain(
        `${WAGER_PROCESSING_DURATION}_count{channel="http",outcome="error"} 1`,
      );
      expect(lines[0]).toMatchObject({
        level: 'warn',
        event: 'wager_transaction_error',
        error: 'TransientFailureError',
        walletId: WALLET,
        providerId: 'provider-a',
      });
    },
  );

  test('conflito de CAS da wallet conta como version_conflict (ADR-0003)', async () => {
    const { metrics, instrumented } = harness(async () => {
      throw new WalletVersionConflictError('versão');
    });
    await expect(instrumented.execute(input)).rejects.toBeInstanceOf(WalletVersionConflictError);
    expect(
      metrics.value(WAGER_LOCK_CONFLICTS, { channel: 'http', reason: 'version_conflict' }),
    ).toBe(1);
  });

  test('falha transitória sem lock não conta como conflito de lock', async () => {
    const { metrics, lines, instrumented } = harness(async () => {
      throw new TransientFailureError('conexão', null);
    });
    await expect(instrumented.execute(input)).rejects.toBeInstanceOf(TransientFailureError);
    expect(metrics.render()).not.toContain(WAGER_LOCK_CONFLICTS);
    expect(lines[0]?.['level']).toBe('error');
  });

  test('conflito de idempotência conta pelo código (RN-21, RN-22)', async () => {
    const { metrics, lines, instrumented } = harness(async () => {
      throw new IdempotencyConflictError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });
    await expect(instrumented.execute(input)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(
      metrics.value(WAGER_IDEMPOTENCY_CONFLICTS, {
        channel: 'http',
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      }),
    ).toBe(1);
    expect(lines[0]?.['level']).toBe('warn');
  });

  test('payload inválido é warn, e identificador que não é texto fica fora do log', async () => {
    const { lines, instrumented } = harness(async () => {
      throw new InvalidWagerInputError('walletId');
    });
    const bad = { ...input, walletId: 42 as unknown as string };
    await expect(instrumented.execute(bad)).rejects.toBeInstanceOf(InvalidWagerInputError);
    expect(lines[0]?.['level']).toBe('warn');
    expect(lines[0]).not.toHaveProperty('walletId');
  });

  test('o log não carrega money, saldo nem playerId (SPEC 14.1)', async () => {
    const { lines, instrumented } = harness(async () => processed);
    await instrumented.execute(input);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('25.00');
    expect(text).not.toContain('75.00');
    expect(text).not.toContain(PLAYER);
    expect(lines[0]).not.toHaveProperty('money');
    expect(lines[0]).not.toHaveProperty('balance');
  });
});
