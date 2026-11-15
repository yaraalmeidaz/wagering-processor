import type { MoneyProps } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export interface EventContext {
  readonly eventId: string;
  /** walletId da carteira afetada (ADR-0006). */
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

/** Envelope da SPEC 11.2. eventType e version vêm do tipo, nunca de string solta. */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  readonly version: number = 1;
  readonly context: EventContext;
  readonly data: T;

  constructor(context: EventContext, data: T) {
    this.context = context;
    this.data = data;
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.context.eventId,
      eventType: this.eventType,
      aggregateId: this.context.aggregateId,
      correlationId: this.context.correlationId,
      ...(this.context.causationId === undefined ? {} : { causationId: this.context.causationId }),
      occurredAt: this.context.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

/** Dados de transação, com Money como MoneyProps (SPEC 11.2). */
export interface TransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly status: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly failureCode: string | null;
  readonly resultingBalance: MoneyProps | null;
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  /** Versão da wallet depois da mudança, para ordenação no consumidor (SPEC 11.2). */
  readonly walletVersion: number;
  readonly transactionId: string;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
}

export interface PendingReferenceData extends TransactionEventData {
  readonly nextReferenceAttemptAt: string | null;
}

/** RN-26: toda transação aplicada, inclusive LOSS e valor zero. */
export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed' as const;
}

/** RN-27: toda rejeição de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionRejected' as const;
}

/** RN-28: somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged' as const;
}

/** RN-29: quando a transação entra em PENDING_REFERENCE. */
export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
}

export function transactionEventData(transaction: WagerTransaction): TransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    failureCode: transaction.failureCode,
    resultingBalance: transaction.resultingBalance?.toJSON() ?? null,
  };
}

export function walletBalanceChangedData(
  wallet: Wallet,
  transactionId: string,
  balanceBefore: MoneyProps,
): WalletBalanceChangedData {
  return {
    walletId: wallet.id,
    walletVersion: wallet.version,
    transactionId,
    balanceBefore,
    balanceAfter: wallet.balance.toJSON(),
  };
}
