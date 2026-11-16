import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../../src/application/use-cases/process-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet';
import {
  type ConsumerOptions,
  SqsWagerConsumer,
} from '../../../src/infrastructure/messaging/sqs-wager-consumer';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import {
  InstrumentedProcessWager,
  WAGER_TRANSACTIONS,
} from '../../../src/observability/instrumented-process-wager';
import { InMemoryMetrics } from '../../../src/observability/metrics';
import { SystemClock } from '../../helpers/clock';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import {
  createTestQueues,
  drainQueue,
  queueDepth,
  sendWagerMessage,
  type TestQueues,
  wagerMessage,
} from '../../helpers/sqs';
import { betInput } from '../../helpers/wager-input';
import { ledgerInvariant, seedWallet } from '../../helpers/wallet-seed';

// Enunciado §10 e §11; SPEC 9.1, 10.2 a 10.5; ADR-0010; RN-33, RN-34, RN-35, RN-39.
describe('SqsWagerConsumer com LocalStack e PostgreSQL reais', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let queues: TestQueues;
  const clock = new SystemClock();

  /** Consumer novo por teste, com métricas e log próprios. */
  const consumerWith = (options: Partial<ConsumerOptions> = {}) => {
    const metrics = new InMemoryMetrics();
    const lines: string[] = [];
    const consumer = new SqsWagerConsumer({
      sqs: queues.sqs,
      queues: { input: queues.input, dlq: queues.dlq },
      useCase: new ProcessWagerTransaction({ unitOfWork: uow, clock }),
      unitOfWork: uow,
      clock,
      metrics,
      sink: { write: (line) => lines.push(line) },
      waitTimeSeconds: 1,
      retryDelaySeconds: () => 0,
      ...options,
    });
    return { consumer, metrics, lines };
  };

  const dataOf = (wallet: Wallet, amount: string, overrides: Record<string, unknown> = {}) => {
    const {
      inbox: _inbox,
      correlationId: _correlationId,
      ...data
    } = betInput(wallet, amount, overrides);
    return data;
  };

  const send = (body: unknown, groupId: string) =>
    sendWagerMessage(queues.sqs, queues.input, body, groupId);

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.execute(sql, params))[0]?.['n'] ?? 0);

  const debits = (walletId: string) =>
    count(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [walletId],
    );

  /** Recebe da fila até esvaziar. */
  const pollUntilEmpty = async (consumer: SqsWagerConsumer) => {
    for (let i = 0; i < 10; i++) {
      if ((await consumer.pollOnce()) === 0) return;
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase('messaging_consumer');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
    queues = await createTestQueues('consumer', { maxReceiveCount: 2 });
  });

  afterAll(async () => {
    await queues?.dispose();
    await db?.dispose();
  });

  test('BET válida: efeito, inbox e ack só depois do COMMIT (SPEC 5.8, 10.2)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const data = dataOf(wallet, '10.00');
    const body = wagerMessage(data);
    await send(body, wallet.id);

    const seenAtCommit: { committed: number; inFlight: number }[] = [];
    const { consumer, lines } = consumerWith({
      hooks: {
        afterCommit: async () => {
          seenAtCommit.push({
            committed: await count(
              `SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ?`,
              [data.idempotencyKey],
            ),
            inFlight: (await queueDepth(queues.sqs, queues.input)).inFlight,
          });
        },
      },
    });
    expect(await consumer.pollOnce()).toBe(1);

    // No gancho, entre o COMMIT e o ack: a linha já está commitada e a mensagem ainda não foi apagada.
    expect(seenAtCommit).toEqual([{ committed: 1, inFlight: 1 }]);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(await debits(wallet.id)).toBe(1);
    expect(
      await count(`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ?`, [
        body['messageId'],
      ]),
    ).toBe(1);

    // Log JSON com messageId e correlationId, sem valor financeiro (SPEC 14.1).
    const record = JSON.parse(String(lines.at(-1))) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: 'message_processed',
      messageId: body['messageId'],
      correlationId: body['messageId'],
      walletId: wallet.id,
      status: 'PROCESSED',
    });
    expect(lines.join('\n')).not.toContain('10.00');
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('com o caso de uso instrumentado: canal sqs na métrica e messageId no log (ADR-0011)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const body = wagerMessage(dataOf(wallet, '10.00'));
    await send(body, wallet.id);

    const metrics = new InMemoryMetrics();
    const lines: string[] = [];
    const sink = { write: (line: string) => lines.push(line) };
    const { consumer } = consumerWith({
      metrics,
      sink,
      useCase: new InstrumentedProcessWager(
        new ProcessWagerTransaction({ unitOfWork: uow, clock }),
        {
          metrics,
          sink,
          clock,
        },
      ),
    });
    expect(await consumer.pollOnce()).toBe(1);

    expect(metrics.value(WAGER_TRANSACTIONS, { channel: 'sqs', status: 'PROCESSED' })).toBe(1);
    const result = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['event'] === 'wager_transaction_result');
    expect(result).toMatchObject({
      channel: 'sqs',
      messageId: body['messageId'],
      walletId: wallet.id,
      status: 'PROCESSED',
    });
    expect(lines.join('\n')).not.toContain('10.00');
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('rejeição de negócio: REJECTED e ack, sem DLQ (RN-33)', async () => {
    const wallet = await seedWallet(uow, '5.00');
    await send(wagerMessage(dataOf(wallet, '10.00')), wallet.id);

    const { consumer } = consumerWith();
    await pollUntilEmpty(consumer);

    const rows = await db.execute(
      `SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [wallet.id],
    );
    expect(rows).toEqual([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }]);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(await drainQueue(queues.sqs, queues.dlq)).toEqual([]);
  });

  test('a mesma mensagem reentregue: um efeito, ack e duplicata contada (SPEC 10.5)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const body = wagerMessage(dataOf(wallet, '10.00'));
    await send(body, wallet.id);
    await send(body, wallet.id);

    const { consumer, metrics, lines } = consumerWith();
    await pollUntilEmpty(consumer);

    expect(await debits(wallet.id)).toBe(1);
    expect(metrics.value('messages_duplicate_total')).toBe(1);
    expect(lines.some((line) => JSON.parse(line).event === 'message_duplicate')).toBe(true);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(await drainQueue(queues.sqs, queues.dlq)).toEqual([]);
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('mesmo messageId com outro conteúdo: DLQ com INBOX_PAYLOAD_MISMATCH, sem segundo efeito (ADR-0010)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const messageId = crypto.randomUUID();
    await send(wagerMessage(dataOf(wallet, '10.00'), messageId), wallet.id);
    await send(wagerMessage(dataOf(wallet, '10.00'), messageId), wallet.id);

    const { consumer } = consumerWith();
    await pollUntilEmpty(consumer);

    expect(await debits(wallet.id)).toBe(1);
    const dead = await drainQueue(queues.sqs, queues.dlq);
    expect(dead.map((m) => m.MessageAttributes?.['dlqReason']?.StringValue)).toEqual([
      'INBOX_PAYLOAD_MISMATCH',
    ]);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
  });

  test.each([
    ['JSON inválido', () => '{nao e json', 'MALFORMED'],
    [
      'type diferente',
      (data: Record<string, unknown>) => ({ ...wagerMessage(data), type: 'Outro' }),
      'MALFORMED',
    ],
    [
      'envelope sem messageId',
      (data: Record<string, unknown>) => ({ ...wagerMessage(data), messageId: undefined }),
      'MALFORMED',
    ],
    [
      'kind OPENING (RN-34)',
      (data: Record<string, unknown>) => wagerMessage({ ...data, kind: 'OPENING' }),
      'INVALID_PAYLOAD',
    ],
    [
      'valor como number',
      (data: Record<string, unknown>) =>
        wagerMessage({ ...data, money: { amount: 10, currency: 'BRL' } }),
      'INVALID_PAYLOAD',
    ],
  ])('%s: DLQ com motivo e ack da original, nada gravado (RN-34)', async (_, build, reason) => {
    const wallet = await seedWallet(uow, '100.00');
    const before = await count(`SELECT count(*)::int AS n FROM wager_transactions`, []);
    await send(build(dataOf(wallet, '10.00')), wallet.id);

    const { consumer, metrics } = consumerWith();
    await pollUntilEmpty(consumer);

    const dead = await drainQueue(queues.sqs, queues.dlq);
    expect(dead.map((m) => m.MessageAttributes?.['dlqReason']?.StringValue)).toEqual([reason]);
    expect(metrics.value('messages_dead_lettered_total')).toBe(1);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(await count(`SELECT count(*)::int AS n FROM wager_transactions`, [])).toBe(before);
  });

  test('conflito de idempotência: DLQ com o código do 409 e ack (ADR-0010)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const data = dataOf(wallet, '10.00');
    await send(wagerMessage(data), wallet.id);
    // Mesma chave, valor diferente: IDEMPOTENCY_PAYLOAD_MISMATCH (RN-21).
    await send(wagerMessage({ ...data, money: { amount: '20.00', currency: 'BRL' } }), wallet.id);

    const { consumer } = consumerWith();
    await pollUntilEmpty(consumer);

    const dead = await drainQueue(queues.sqs, queues.dlq);
    expect(dead.map((m) => m.MessageAttributes?.['dlqReason']?.StringValue)).toEqual([
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    ]);
    expect(await debits(wallet.id)).toBe(1);
  });

  test('transitório (wallet inexistente): sem ack, nova visibilidade por tentativa e redrive no limite (RN-35, RN-39)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const missingWallet = crypto.randomUUID();
    const body = wagerMessage(dataOf(wallet, '10.00', { walletId: missingWallet }));
    await send(body, missingWallet);

    const receiveCounts: number[] = [];
    const { consumer, metrics } = consumerWith({
      retryDelaySeconds: (receiveCount) => {
        receiveCounts.push(receiveCount);
        return 0;
      },
    });
    await pollUntilEmpty(consumer);

    // maxReceiveCount = 2 nesta fila: duas entregas, depois o redrive do SQS.
    expect(receiveCounts).toEqual([1, 2]);
    expect(metrics.value('messages_retried_total')).toBe(2);
    const dead = await drainQueue(queues.sqs, queues.dlq);
    expect(dead.map((m) => JSON.parse(String(m.Body)).messageId)).toEqual([body['messageId']]);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(
      await count(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ?`, [
        missingWallet,
      ]),
    ).toBe(0);
  }, 20_000);

  test('ROLLBACK antes da referência: PENDING_REFERENCE e ack, sem rejeição (SPEC 15.3 g; RN-12)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const data = dataOf(wallet, '10.00', {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: `bet-${crypto.randomUUID()}`,
    });
    await send(wagerMessage(data), wallet.id);

    const { consumer } = consumerWith();
    await pollUntilEmpty(consumer);

    const rows = await db.execute(
      `SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = ?`,
      [data.idempotencyKey],
    );
    expect(rows).toEqual([{ status: 'PENDING_REFERENCE', failure_code: null }]);
    expect(await queueDepth(queues.sqs, queues.input)).toEqual({ visible: 0, inFlight: 0 });
    expect(await drainQueue(queues.sqs, queues.dlq)).toEqual([]);
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
  });

  test('stop (SIGTERM): para o polling e devolve a visibilidade da mensagem em andamento (SPEC 10.4)', async () => {
    const wallet = await seedWallet(uow, '100.00');
    const body = wagerMessage(dataOf(wallet, '10.00'));
    await send(body, wallet.id);

    // Outra sessão segura o lock da wallet: a mensagem fica em andamento.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = db.orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      signalLocked();
      await released;
    });
    await locked;

    const { consumer } = consumerWith({ shutdownGraceMs: 300 });
    try {
      consumer.start();
      for (let i = 0; i < 50 && (await queueDepth(queues.sqs, queues.input)).inFlight === 0; i++) {
        await Bun.sleep(50);
      }
      const startedAt = Date.now();
      await consumer.stop();
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      // Visibilidade devolvida: a mensagem volta na hora, sem esperar os 30 s da fila.
      const { Messages = [] } = await queues.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queues.input, WaitTimeSeconds: 1 }),
      );
      expect(Messages.map((m) => JSON.parse(String(m.Body)).messageId)).toEqual([
        body['messageId'],
      ]);
      // Segura o lock além do lock_timeout (3 s): a tentativa em andamento falha sem efeito.
      await Bun.sleep(3_500);
    } finally {
      release();
      await holder;
      await consumer.stopped;
    }
    expect(await debits(wallet.id)).toBe(0);
    expect((await ledgerInvariant(db, wallet.id)).consistent).toBe(true);
    await drainQueue(queues.sqs, queues.input, { waitSeconds: 0 });
  }, 20_000);
});
