/**
 * Erros da camada de aplicação. Rejeição de negócio não é erro: é resultado
 * persistido (RN-19). Estes erros não produzem transação e nunca têm failureCode (RN-40).
 */
export abstract class ApplicationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Payload inválido (SPEC 5.1): 400 INVALID_PAYLOAD na API, DLQ na fila (RN-34). */
export class InvalidWagerInputError extends ApplicationError {}

/** Wallet inexistente (RN-39): 404 na API, sem ack na fila. */
export class WalletNotFoundError extends ApplicationError {}

/** Conflito de idempotência (RN-21, RN-22): 409. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(code: IdempotencyConflictError['code']) {
    super(code);
    this.code = code;
  }
}

/** Falha transitória (SPEC 5.9): 503 com Retry-After na API, throw sem ack na fila. */
export class TransientFailureError extends ApplicationError {
  readonly sqlState: string | null;

  constructor(message: string, sqlState: string | null, options?: { cause?: unknown }) {
    super(message, options);
    this.sqlState = sqlState;
  }
}

/** Violação de unicidade (23505), com o nome da constraint, traduzida pela persistência. */
export class UniqueViolationError extends ApplicationError {
  readonly constraint: string | null;

  constructor(constraint: string | null, options?: { cause?: unknown }) {
    super(`violação de unicidade${constraint === null ? '' : `: ${constraint}`}`, options);
    this.constraint = constraint;
  }
}

/** UPDATE da wallet que não encontrou a versão esperada (CAS, ADR-0003). */
export class WalletVersionConflictError extends ApplicationError {}
