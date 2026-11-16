import type { FailureCode } from '../../domain/failure-code';
import { type ReferenceSnapshot, validateReference } from '../../domain/reference-rules';
import {
  balanceEffect,
  insufficientBalanceFailureCode,
  type WagerKind,
} from '../../domain/wager-kind';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { BalanceResult, Wallet } from '../../domain/wallet';
import {
  type EventContext,
  type IntegrationEvent,
  outboxRecordOf,
  transactionEventData,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events';
import type { Repositories } from '../ports/unit-of-work';

/**
 * Uma avaliação de regras, sempre dentro da unidade de trabalho e sob o lock da
 * wallet (SPEC 5.5; SPEC 8.2). Serve à transação nova e à pendência que volta.
 */
export interface WagerRuleContext {
  readonly repositories: Repositories;
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly correlationId: string;
  readonly now: Date;
  /** Grava a transação no estado novo: insert para a nova, update para a pendência. */
  readonly persist: (transaction: WagerTransaction) => Promise<void>;
}

/** SETTLED: PROCESSED ou REJECTED gravada. REFERENCE_MISSING: nada gravado (SPEC 4.2 a). */
export type WagerRuleOutcome = 'SETTLED' | 'REFERENCE_MISSING';

/** Efeito do kind ou rejeição com failureCode, na ordem das SPEC 4.2 e 4.3. */
export async function applyWagerRules(
  rules: WagerRuleContext,
  forcedFailure: FailureCode | null,
): Promise<WagerRuleOutcome> {
  const { repositories, wallet, transaction, now } = rules;
  const expectedVersion = wallet.version;

  if (forcedFailure !== null) return rejectWager(rules, forcedFailure);
  // SPEC 4.3: estes dois vêm antes da referência, porque não exigem leitura adicional.
  if (!wallet.belongsTo(transaction.playerId)) return rejectWager(rules, 'WALLET_PLAYER_MISMATCH');
  if (transaction.money.currency !== wallet.currency) {
    return rejectWager(rules, 'CURRENCY_MISMATCH');
  }

  let referenced: WagerTransaction | null = null;
  const reference = transaction.referenceExternalTransactionId;
  // RN-42: BET e LOSS não aceitam referência.
  if (reference !== null && !hasReferenceRule(transaction.kind)) {
    return rejectWager(rules, 'REFERENCE_KIND_NOT_ALLOWED');
  }
  if (reference !== null) {
    const found = await repositories.transactions.findByProviderAndExternalId(
      transaction.providerId,
      reference,
    );
    const isReversal = transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK';
    const check = validateReference({
      transaction: {
        kind: transaction.kind,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        money: transaction.money,
      },
      reference: found === null ? null : snapshotOf(found),
      referenceAlreadyReversed: isReversal
        ? await repositories.transactions.hasProcessedReversal(transaction.providerId, reference)
        : false,
    });
    if (check.outcome === 'PENDING_REFERENCE') return 'REFERENCE_MISSING';
    if (check.outcome === 'REJECTED') return rejectWager(rules, check.failureCode);
    referenced = found;
  }

  const operation = { entryId: crypto.randomUUID(), transactionId: transaction.id, now };
  const effect = balanceEffect(transaction.kind, referenced?.kind ?? null);
  const outcome: BalanceResult =
    effect === 'DEBIT'
      ? wallet.debit(transaction.money, operation, insufficientBalanceFailureCode(transaction.kind))
      : effect === 'CREDIT'
        ? wallet.credit(transaction.money, operation)
        : { ok: true, balanceBefore: wallet.balance, balanceAfter: wallet.balance, entry: null };
  if (!outcome.ok) return rejectWager(rules, outcome.failureCode);

  transaction.markProcessed(outcome.balanceAfter, now, referenced?.id ?? null);
  await rules.persist(transaction);
  await emitWagerEvent(
    rules,
    (context) => new WagerTransactionProcessed(context, transactionEventData(transaction)),
  );
  if (outcome.entry !== null) {
    const entry = outcome.entry;
    await repositories.wallets.update(wallet, expectedVersion);
    await repositories.ledger.append(entry);
    // RN-28: só quando o saldo muda.
    await emitWagerEvent(rules, (context) => WalletBalanceChanged.from(wallet, entry, context));
  }
  return 'SETTLED';
}

/** Rejeição de negócio é resultado persistido, não exceção (RN-19, RN-27). */
export async function rejectWager(
  rules: WagerRuleContext,
  failureCode: FailureCode,
): Promise<'SETTLED'> {
  const { wallet, transaction, now } = rules;
  // Saldo em outra moeda não cabe na coluna currency da transação (SPEC 12): sem snapshot.
  const snapshot = wallet.balance.hasSameCurrency(transaction.money) ? wallet.balance : null;
  transaction.reject(failureCode, snapshot, now);
  await rules.persist(transaction);
  await emitWagerEvent(
    rules,
    (context) => new WagerTransactionRejected(context, transactionEventData(transaction)),
  );
  return 'SETTLED';
}

/** Grava o evento no outbox, na mesma transação do efeito (AGENTS.md §2.7). */
export function emitWagerEvent(
  rules: WagerRuleContext,
  build: (context: EventContext) => IntegrationEvent<object>,
): Promise<void> {
  return rules.repositories.outbox.append(
    outboxRecordOf(
      build({
        eventId: crypto.randomUUID(),
        aggregateId: rules.wallet.id,
        correlationId: rules.correlationId,
        occurredAt: rules.now,
      }),
    ),
  );
}

function hasReferenceRule(kind: WagerKind): boolean {
  return kind === 'WIN' || kind === 'REFUND' || kind === 'ROLLBACK';
}

function snapshotOf(transaction: WagerTransaction): ReferenceSnapshot {
  return {
    kind: transaction.kind,
    status: transaction.status,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    money: transaction.money,
  };
}
