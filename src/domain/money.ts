import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Forma serializada de Money: valor em string decimal, nunca number (ADR-0002). */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Escala fixa de 2 casas, sem zeros à esquerda e sem sinal (RN-02). Até 17 dígitos inteiros: NUMERIC(19,2).
const INPUT_PATTERN = /^(0|[1-9][0-9]{0,16})\.([0-9]{2})$/;
const PERSISTED_PATTERN = /^-?(0|[1-9][0-9]{0,16})\.([0-9]{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_CENTS = 10n ** 19n - 1n;

/** Valor monetário imutável, com aritmética exata em centavos bigint (ADR-0002). */
export class Money {
  readonly #cents: bigint;
  readonly currency: string;

  private constructor(cents: bigint, currency: string) {
    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new InvalidMoneyError('valor excede NUMERIC(19,2)');
    }
    this.#cents = cents;
    this.currency = currency;
    Object.freeze(this);
  }

  /** Valor de entrada: rejeita, sem arredondar, tudo fora da RN-02, inclusive negativos. */
  static create(amount: unknown, currency: unknown): Money {
    return new Money(parseCents(amount, INPUT_PATTERN), parseCurrency(currency));
  }

  /** Valor já persistido. Aceita o mesmo formato, com sinal. */
  static rehydrate(amount: string, currency: string): Money {
    return new Money(parseCents(amount, PERSISTED_PATTERN), parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, parseCurrency(currency));
  }

  get amount(): string {
    const sign = this.#cents < 0n ? '-' : '';
    const absolute = this.#cents < 0n ? -this.#cents : this.#cents;
    const units = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    return `${sign}${units}.${fraction}`;
  }

  add(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#cents + other.#cents, this.currency);
  }

  subtract(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#cents - other.#cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.#cents, this.currency);
  }

  isZero(): boolean {
    return this.#cents === 0n;
  }

  isPositive(): boolean {
    return this.#cents > 0n;
  }

  isNegative(): boolean {
    return this.#cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.#assertSameCurrency(other);
    return this.#cents < other.#cents;
  }

  /** Mesmo valor e mesma moeda. Moedas diferentes nunca são iguais. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.#cents === other.#cents;
  }

  hasSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  #assertSameCurrency(other: Money): void {
    if (!this.hasSameCurrency(other)) {
      throw new CurrencyMismatchError(`moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}

function parseCents(amount: unknown, pattern: RegExp): bigint {
  if (typeof amount !== 'string') {
    throw new InvalidMoneyError('valor monetário precisa ser string decimal');
  }
  const match = pattern.exec(amount);
  if (match === null) {
    throw new InvalidMoneyError('valor monetário fora do formato de 2 casas decimais');
  }
  const negative = amount.startsWith('-');
  const cents = BigInt(match[1] ?? '0') * 100n + BigInt(match[2] ?? '0');
  return negative ? -cents : cents;
}

function parseCurrency(currency: unknown): string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError('moeda precisa ser código ISO-4217 de 3 letras maiúsculas');
  }
  return currency;
}
