/** Códigos de rejeição de negócio (SPEC 9.3). Existem só em transação REJECTED (RN-40). */
export const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'CURRENCY_MISMATCH',
  'WALLET_PLAYER_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_CONTEXT_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED',
  'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_ALREADY_REVERSED',
  'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

const codes: ReadonlySet<string> = new Set(FAILURE_CODES);

export function isFailureCode(code: string): code is FailureCode {
  return codes.has(code);
}
