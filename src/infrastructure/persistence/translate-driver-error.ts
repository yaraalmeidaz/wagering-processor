import { ConnectionException, DriverException } from '@mikro-orm/core';
import {
  PermanentDataError,
  TransientFailureError,
  UniqueViolationError,
} from '../../application/errors';

/** SQLSTATEs transitórios da SPEC 5.9, mais o statement_timeout (57014). */
const TRANSIENT_STATES = new Set(['55P03', '40P01', '40001', '57014']);

function sqlStateOf(error: DriverException): string | null {
  return error.sqlState ?? error.code ?? null;
}

function constraintOf(error: DriverException): string | null {
  const direct = (error as { constraint?: unknown }).constraint;
  if (typeof direct === 'string') return direct;
  const match = /constraint "([^"]+)"/.exec(error.message);
  return match?.[1] ?? null;
}

/** Converte erros do driver em erros da aplicação. Os demais passam sem mudança. */
export function translateDriverError(error: unknown): unknown {
  if (error instanceof ConnectionException) {
    return new TransientFailureError('conexão com o banco indisponível', null, { cause: error });
  }
  if (!(error instanceof DriverException)) {
    return error;
  }
  const state = sqlStateOf(error);
  if (state === '23505') {
    return new UniqueViolationError(constraintOf(error), { cause: error });
  }
  if (state !== null && TRANSIENT_STATES.has(state)) {
    return new TransientFailureError(`falha transitória ${state}`, state, { cause: error });
  }
  // Classe 22 (dado inválido) e 23 (restrição de integridade): permanentes (ADR-0007).
  if (state !== null && (state.startsWith('22') || state.startsWith('23'))) {
    return new PermanentDataError(`dado recusado pelo banco ${state}`, state, { cause: error });
  }
  return error;
}
