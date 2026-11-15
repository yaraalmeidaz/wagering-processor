import { describe, expect, test } from 'bun:test';
import {
  type EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/application/events';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:00:01.000Z');

const context: EventContext = {
  eventId: 'event-1',
  aggregateId: 'wallet-1',
  correlationId: 'tx-1',
  occurredAt: T1,
};

// SPEC 11.2; RN-28.
describe('WalletBalanceChanged.from', () => {
  test('monta o envelope a partir da wallet e do lançamento, com version 1 no tipo', () => {
    const { wallet } = Wallet.create({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      initialBalance: Money.create('100.00', 'BRL'),
      opening: { entryId: 'entry-opening', transactionId: 'tx-opening' },
      now: T0,
    });
    const result = wallet.debit(Money.create('30.00', 'BRL'), {
      entryId: 'entry-1',
      transactionId: 'tx-1',
      now: T1,
    });
    if (!result.ok || result.entry === null) throw new Error('débito deveria gerar lançamento');

    const event = WalletBalanceChanged.from(wallet, result.entry, context);

    // version é literal no tipo: atribuir a `1` só compila se não for `number`.
    const version: 1 = event.version;
    expect(version).toBe(1);
    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'tx-1',
      occurredAt: '2026-01-01T00:00:01.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        walletVersion: 2,
        transactionId: 'tx-1',
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
      },
    });
  });

  test('todas as subclasses têm version literal 1 no tipo e no envelope', () => {
    // O conteúdo de data não importa aqui; só o envelope.
    const data = {} as never;
    const versions: 1[] = [
      new WagerTransactionProcessed(context, data).version,
      new WagerTransactionRejected(context, data).version,
      new WalletBalanceChanged(context, data).version,
      new WagerTransactionPendingReference(context, data).version,
    ];
    expect(versions).toEqual([1, 1, 1, 1]);
  });
});
