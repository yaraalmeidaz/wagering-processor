import { createHash } from 'node:crypto';
import { canonicalJson } from '../../application/payload-hash';
import type { ProcessWagerInput } from '../../application/use-cases/process-wager-transaction';

/** Tipo da mensagem de entrada (SPEC 10.1). */
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Corpo fora do envelope da SPEC 10.1: malformada (RN-34). */
export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}

export interface WagerMessage {
  readonly messageId: string;
  /** Hash do corpo inteiro, para o inbox (ADR-0010). */
  readonly payloadHash: string;
  /** Campos de negócio. Validados pelo caso de uso, como na entrada HTTP (SPEC 5.1). */
  readonly data: Omit<ProcessWagerInput, 'inbox' | 'correlationId'>;
}

type Json = Parameters<typeof canonicalJson>[0];

/**
 * Valida só o envelope: type, messageId, occurredAt e data. Os campos de data são
 * do caso de uso, para não duplicar a validação do HTTP (CLAUDE.md, regra 4).
 */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new MalformedMessageError('corpo não é JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedMessageError('corpo não é objeto');
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope['type'] !== WAGER_MESSAGE_TYPE) {
    throw new MalformedMessageError(`type diferente de ${WAGER_MESSAGE_TYPE}`);
  }
  const messageId = envelope['messageId'];
  if (typeof messageId !== 'string' || messageId.trim() === '') {
    throw new MalformedMessageError('messageId ausente');
  }
  const occurredAt = envelope['occurredAt'];
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    throw new MalformedMessageError('occurredAt ausente ou inválido');
  }
  const data = envelope['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new MalformedMessageError('data ausente');
  }
  return {
    messageId,
    payloadHash: createHash('sha256')
      .update(canonicalJson(envelope as Json))
      .digest('hex'),
    data: data as WagerMessage['data'],
  };
}
