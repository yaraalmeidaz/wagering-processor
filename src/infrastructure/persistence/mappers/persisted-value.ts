/** Valor persistido fora do conjunto esperado: dado corrompido, não caminho de negócio. */
export class InvalidPersistedValueError extends Error {
  constructor(field: string, value: unknown) {
    super(`valor persistido inválido em ${field}: ${String(value)}`);
    this.name = 'InvalidPersistedValueError';
  }
}

/** Estreita uma string lida do banco para um dos valores permitidos. */
export function oneOf<const T extends string>(
  allowed: readonly T[],
  value: string,
  field: string,
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new InvalidPersistedValueError(field, value);
  }
  return match;
}
