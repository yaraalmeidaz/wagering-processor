import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  InvalidInputError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  WalletVersionConflictError,
} from '../../application/errors';

/** Idempotency-Key ausente ou vazia (RN-23). Erro da camada HTTP. */
export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super('header Idempotency-Key é obrigatório');
    this.name = 'MissingIdempotencyKeyError';
  }
}

/** O que o filtro usa da resposta do Express, sem depender de @types/express. */
interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
}

/** Segundos do Retry-After em 503 (ADR-0009). */
export const RETRY_AFTER_SECONDS = '1';

/**
 * Mapeia erros para a taxonomia da SPEC 9.2 (ADR-0009). Erro nunca traz
 * failureCode (RN-40). Erro desconhecido é transitório (SPEC 5.9).
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger('HttpErrorFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const [status, body] = this.#map(error);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response.status(status).json(body);
  }

  #map(error: unknown): [number, ErrorBody] {
    if (error instanceof MissingIdempotencyKeyError) {
      return [400, { code: 'MISSING_IDEMPOTENCY_KEY', message: error.message }];
    }
    if (error instanceof InvalidInputError) {
      return [
        400,
        { code: 'INVALID_PAYLOAD', message: 'payload inválido', details: [error.message] },
      ];
    }
    if (error instanceof IdempotencyConflictError) {
      return [409, { code: error.code, message: error.message }];
    }
    if (error instanceof WalletAlreadyExistsError) {
      return [409, { code: 'WALLET_ALREADY_EXISTS', message: error.message }];
    }
    if (error instanceof WalletNotFoundError) {
      return [404, { code: 'WALLET_NOT_FOUND', message: error.message }];
    }
    if (error instanceof TransactionNotFoundError) {
      return [404, { code: 'TRANSACTION_NOT_FOUND', message: error.message }];
    }
    if (error instanceof TransientFailureError || error instanceof WalletVersionConflictError) {
      return [503, { code: 'TRANSIENT_FAILURE', message: 'falha transitória, tente de novo' }];
    }
    if (error instanceof HttpException) {
      return this.#mapFramework(error);
    }
    this.#logger.error(`erro inesperado tratado como transitório: ${String(error)}`);
    return [503, { code: 'TRANSIENT_FAILURE', message: 'falha transitória, tente de novo' }];
  }

  /** Erros do NestJS fora da SPEC 9.2 (ADR-0009). */
  #mapFramework(error: HttpException): [number, ErrorBody] {
    const status = error.getStatus();
    if (status === HttpStatus.BAD_REQUEST) {
      // JSON malformado no corpo (body parser do Express).
      return [
        400,
        { code: 'INVALID_PAYLOAD', message: 'payload inválido', details: [error.message] },
      ];
    }
    if (status === HttpStatus.FORBIDDEN) {
      return [403, { code: 'FORBIDDEN', message: 'acesso negado' }];
    }
    if (status === HttpStatus.NOT_FOUND) {
      return [404, { code: 'NOT_FOUND', message: 'rota inexistente' }];
    }
    return [status, { code: `HTTP_${status}`, message: error.message }];
  }
}
