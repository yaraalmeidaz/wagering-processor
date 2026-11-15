import type { FailureCode } from './failure-code';
import type { Money } from './money';
import type { WagerKind } from './wager-kind';
import type { TransactionStatus } from './wager-transaction';

/** Dados da transação referenciada necessários à validação da SPEC 4.2. */
export interface ReferenceSnapshot {
  readonly kind: WagerKind;
  readonly status: TransactionStatus;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly money: Money;
}

export interface ReferenceCheckInput {
  readonly transaction: {
    readonly kind: WagerKind;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly money: Money;
  };
  /** Nulo quando a referência não existe. */
  readonly reference: ReferenceSnapshot | null;
  /** Já existe reversão PROCESSED para a referência, de qualquer tipo (RN-16). */
  readonly referenceAlreadyReversed: boolean;
}

export type ReferenceCheckResult =
  | { readonly outcome: 'OK' }
  | { readonly outcome: 'PENDING_REFERENCE' }
  | { readonly outcome: 'REJECTED'; readonly failureCode: FailureCode };

/** Tipos que cada kind pode referenciar (RN-06, RN-08, RN-09). */
const ALLOWED_REFERENCES: Partial<Record<WagerKind, readonly WagerKind[]>> = {
  WIN: ['BET'],
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

const REVERSALS: ReadonlySet<WagerKind> = new Set(['REFUND', 'ROLLBACK']);

/**
 * Valida a referência na ordem a) a f) da SPEC 4.2. O passo g) (reversão que deixa
 * saldo negativo) é decidido pelo débito da Wallet com REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE.
 */
export function validateReference(input: ReferenceCheckInput): ReferenceCheckResult {
  const { transaction, reference } = input;
  const allowed = ALLOWED_REFERENCES[transaction.kind];
  if (allowed === undefined) {
    throw new Error(`${transaction.kind} não tem regra de referência`);
  }
  if (reference === null) {
    return { outcome: 'PENDING_REFERENCE' };
  }
  if (reference.status !== 'PROCESSED') {
    return rejected('REFERENCE_NOT_PROCESSED');
  }
  if (!sameContext(transaction, reference)) {
    return rejected('REFERENCE_CONTEXT_MISMATCH');
  }
  if (!allowed.includes(reference.kind)) {
    return rejected('REFERENCE_KIND_NOT_ALLOWED');
  }
  if (REVERSALS.has(transaction.kind)) {
    if (!transaction.money.equals(reference.money)) {
      return rejected('REFERENCE_AMOUNT_MISMATCH');
    }
    if (input.referenceAlreadyReversed) {
      return rejected('REFERENCE_ALREADY_REVERSED');
    }
  }
  return { outcome: 'OK' };
}

/** Jogador, wallet, rodada e moeda iguais (RN-14). O provider é filtro da busca (RN-11). */
function sameContext(
  transaction: ReferenceCheckInput['transaction'],
  reference: ReferenceSnapshot,
): boolean {
  return (
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.roundId === reference.roundId &&
    transaction.money.hasSameCurrency(reference.money)
  );
}

function rejected(failureCode: FailureCode): ReferenceCheckResult {
  return { outcome: 'REJECTED', failureCode };
}
