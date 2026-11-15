import { FAILURE_CODES } from '../../../domain/failure-code';
import { Money } from '../../../domain/money';
import { WAGER_KINDS } from '../../../domain/wager-kind';
import { TRANSACTION_STATUSES, WagerTransaction } from '../../../domain/wager-transaction';
import type { WagerTransactionOrmEntity } from '../entities/WagerTransactionOrmEntity';
import { oneOf } from './persisted-value';

export type WagerTransactionRow = Pick<
  WagerTransactionOrmEntity,
  | 'id'
  | 'providerId'
  | 'externalTransactionId'
  | 'idempotencyKey'
  | 'payloadHash'
  | 'walletId'
  | 'playerId'
  | 'roundId'
  | 'gameId'
  | 'kind'
  | 'amount'
  | 'currency'
  | 'referenceExternalTransactionId'
  | 'referenceTransactionId'
  | 'status'
  | 'failureCode'
  | 'resultingBalance'
  | 'attempts'
  | 'nextReferenceAttemptAt'
  | 'createdAt'
  | 'processedAt'
>;

/** Colunas que mudam depois da criação: estado, snapshot e controle de pendência. */
export type WagerTransactionStateRow = Pick<
  WagerTransactionRow,
  | 'status'
  | 'failureCode'
  | 'resultingBalance'
  | 'referenceTransactionId'
  | 'attempts'
  | 'nextReferenceAttemptAt'
  | 'processedAt'
>;

export function transactionToRow(transaction: WagerTransaction): WagerTransactionRow {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    createdAt: transaction.createdAt,
    ...transactionStateToRow(transaction),
  };
}

export function transactionStateToRow(transaction: WagerTransaction): WagerTransactionStateRow {
  return {
    status: transaction.status,
    failureCode: transaction.failureCode,
    resultingBalance: transaction.resultingBalance?.amount ?? null,
    referenceTransactionId: transaction.referenceTransactionId,
    attempts: transaction.attempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt,
    processedAt: transaction.processedAt,
  };
}

export function transactionFromRow(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: oneOf(WAGER_KINDS, row.kind, 'wager_transactions.kind'),
    money: Money.rehydrate(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? null,
    referenceTransactionId: row.referenceTransactionId ?? null,
    status: oneOf(TRANSACTION_STATUSES, row.status, 'wager_transactions.status'),
    failureCode:
      row.failureCode === null || row.failureCode === undefined
        ? null
        : oneOf(FAILURE_CODES, row.failureCode, 'wager_transactions.failure_code'),
    resultingBalance:
      row.resultingBalance === null || row.resultingBalance === undefined
        ? null
        : Money.rehydrate(row.resultingBalance, row.currency),
    attempts: row.attempts,
    nextReferenceAttemptAt: row.nextReferenceAttemptAt ?? null,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? null,
  });
}
