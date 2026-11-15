import type { FailureCode } from './failure-code';

export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WAGER_KINDS)[number];

/** Kinds aceitos pela API e pela fila. OPENING é interno (RN-04). */
export const EXTERNAL_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

const external: ReadonlySet<string> = new Set(EXTERNAL_KINDS);

export function isExternalKind(kind: string): kind is ExternalKind {
  return external.has(kind);
}

export type BalanceEffect = 'DEBIT' | 'CREDIT' | 'NONE';

/** Efeito no saldo por kind (SPEC 4.1). ROLLBACK aplica o inverso da referência (RN-09). */
export function balanceEffect(kind: WagerKind, referencedKind: WagerKind | null): BalanceEffect {
  switch (kind) {
    case 'OPENING':
    case 'WIN':
    case 'REFUND':
      return 'CREDIT';
    case 'BET':
      return 'DEBIT';
    case 'LOSS':
      return 'NONE';
    case 'ROLLBACK':
      if (referencedKind === null) {
        throw new Error('ROLLBACK exige o kind da referência');
      }
      return invert(balanceEffect(referencedKind, null));
  }
}

/** Saldo insuficiente em reversão tem código próprio (RN-05, RN-17). Só ROLLBACK debita como reversão. */
export function insufficientBalanceFailureCode(
  kind: WagerKind,
): Extract<FailureCode, 'INSUFFICIENT_FUNDS' | 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE'> {
  return kind === 'ROLLBACK' ? 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE' : 'INSUFFICIENT_FUNDS';
}

function invert(effect: BalanceEffect): BalanceEffect {
  if (effect === 'DEBIT') return 'CREDIT';
  if (effect === 'CREDIT') return 'DEBIT';
  return 'NONE';
}
