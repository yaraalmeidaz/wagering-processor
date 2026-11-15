import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON canônico: chaves ordenadas recursivamente, sem espaços (RN-24; SPEC 5.2). */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface PayloadHashFields {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string | null;
}

/**
 * SHA-256 em hex dos campos de negócio da SPEC 5.2. A referência só entra quando
 * existe. Idempotency-Key e metadados de transporte ficam fora (RN-24).
 */
export function payloadHash(fields: PayloadHashFields): string {
  const business: Record<string, Json> = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
  };
  const reference = fields.referenceExternalTransactionId;
  if (reference !== null && reference !== undefined) {
    business['referenceExternalTransactionId'] = reference;
  }
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}
