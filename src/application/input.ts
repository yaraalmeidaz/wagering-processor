import { InvalidMoneyError } from '../domain/errors';
import { Money } from '../domain/money';
import { InvalidInputError } from './errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorFactory = new (message: string, options?: { cause?: unknown }) => InvalidInputError;

/** Validação de entrada comum aos casos de uso (SPEC 5.1). Usada por HTTP e SQS. */
export function requiredText(
  value: unknown,
  field: string,
  error: ErrorFactory = InvalidInputError,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new error(`${field} é obrigatório`);
  }
  return value;
}

export function requiredUuid(
  value: unknown,
  field: string,
  error: ErrorFactory = InvalidInputError,
): string {
  const checked = requiredText(value, field, error);
  if (!UUID_PATTERN.test(checked)) {
    throw new error(`${field} precisa ser uuid`);
  }
  return checked;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Money de entrada, sem arredondar (RN-02). Erro de formato vira erro de entrada. */
export function requiredMoney(
  value: unknown,
  field: string,
  error: ErrorFactory = InvalidInputError,
): Money {
  const props = (typeof value === 'object' && value !== null ? value : {}) as {
    amount?: unknown;
    currency?: unknown;
  };
  try {
    return Money.create(props.amount, props.currency);
  } catch (cause) {
    if (cause instanceof InvalidMoneyError) {
      throw new error(`${field}: ${cause.message}`, { cause });
    }
    throw cause;
  }
}
