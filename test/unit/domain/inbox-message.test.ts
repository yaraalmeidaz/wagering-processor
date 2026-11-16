import { describe, expect, test } from 'bun:test';
import { InvalidInboxMessageError } from '../../../src/domain/errors';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { FakeClock } from '../../helpers/clock';

// Enunciado §6.5 e §11; SPEC 10.2 e 12; ADR-0010.
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

function received(clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'))) {
  return InboxMessage.receive({
    consumerName: 'wager-transactions',
    messageId: 'msg-1',
    payloadHash: HASH,
    now: clock.now(),
  });
}

describe('InboxMessage.receive', () => {
  test('nasce recebida e não processada, com received_at do relógio', () => {
    const message = received();
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.messageId).toBe('msg-1');
    expect(message.receivedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeNull();
  });

  test.each([
    ['consumerName vazio', { consumerName: '' }],
    ['messageId vazio', { messageId: '  ' }],
    ['payloadHash fora do formato SHA-256 hex', { payloadHash: 'xyz' }],
  ])('%s: InvalidInboxMessageError', (_, override) => {
    expect(() =>
      InboxMessage.create({
        consumerName: 'wager-transactions',
        messageId: 'msg-1',
        payloadHash: HASH,
        receivedAt: new Date(),
        processedAt: null,
        ...override,
      }),
    ).toThrow(InvalidInboxMessageError);
  });
});

describe('InboxMessage.markProcessed e isProcessed', () => {
  test('marca o instante do processamento', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const message = received(clock);
    clock.advance(250);
    message.markProcessed(clock.now());
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe('2026-01-01T00:00:00.250Z');
  });

  test('processar duas vezes é erro de programação', () => {
    const message = received();
    message.markProcessed(new Date());
    expect(() => message.markProcessed(new Date())).toThrow(InvalidInboxMessageError);
  });

  test('processedAt antes de receivedAt é recusado', () => {
    const message = received();
    expect(() => message.markProcessed(new Date('2025-12-31T23:59:59.000Z'))).toThrow(
      InvalidInboxMessageError,
    );
  });
});

describe('InboxMessage.hasSamePayload (ADR-0010)', () => {
  test('compara o hash do corpo da mensagem', () => {
    const message = received();
    expect(message.hasSamePayload(HASH)).toBe(true);
    expect(message.hasSamePayload(OTHER_HASH)).toBe(false);
  });
});

describe('InboxMessage.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const message = InboxMessage.rehydrate({
      consumerName: 'wager-transactions',
      messageId: 'msg-1',
      payloadHash: HASH,
      receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      processedAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    expect(message.isProcessed()).toBe(true);
  });
});
