import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction';
import type { ReconciliationResult } from '../../application/use-cases/reconcile-wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** Representações JSON da API. Dinheiro sempre como { amount, currency } (ADR-0009). */

export function walletJson(wallet: Wallet) {
  return {
    walletId: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function ledgerEntryJson(entry: WalletLedgerEntry) {
  return {
    entryId: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.amount.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function transactionJson(transaction: WagerTransaction) {
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
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

/** Corpo de POST /wagering/transactions (SPEC 9.2; ADR-0009). */
export function wagerResultJson(result: ProcessWagerResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    failureCode: result.failureCode,
    balance: result.balance,
    idempotentReplay: result.idempotentReplay,
  };
}

/** Corpo da reconciliação (RN-37). */
export function reconciliationJson(result: ReconciliationResult) {
  return {
    walletId: result.walletId,
    storedBalance: result.storedBalance.toJSON(),
    calculatedBalance: result.calculatedBalance.toJSON(),
    difference: result.difference.toJSON(),
    consistent: result.consistent,
    checkedEntries: result.checkedEntries,
  };
}
