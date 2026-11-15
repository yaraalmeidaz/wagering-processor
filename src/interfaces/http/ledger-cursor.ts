import { InvalidInputError } from '../../application/errors';
import { isUuid } from '../../application/input';
import type { LedgerPosition } from '../../application/ports/ledger-repository';

/** Cursor opaco do ledger: base64url de { createdAt, id } (ADR-0009). */
export function encodeLedgerCursor(position: LedgerPosition): string {
  return Buffer.from(
    JSON.stringify({ createdAt: position.createdAt.toISOString(), id: position.id }),
  ).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): LedgerPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt = typeof parsed.createdAt === 'string' ? new Date(parsed.createdAt) : null;
    if (
      createdAt === null ||
      Number.isNaN(createdAt.getTime()) ||
      typeof parsed.id !== 'string' ||
      !isUuid(parsed.id)
    ) {
      throw new Error('cursor sem createdAt ou id válidos');
    }
    return { createdAt, id: parsed.id };
  } catch (cause) {
    throw new InvalidInputError('cursor inválido', { cause });
  }
}

/** limit do ledger: ausente usa o padrão; presente precisa ser inteiro decimal. */
export function parseLedgerLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new InvalidInputError('limit precisa ser inteiro');
  return Number.parseInt(raw, 10);
}
