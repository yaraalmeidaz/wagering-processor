/** Base dos erros de domínio. Rejeição de negócio não é erro: é resultado (RN-19). */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}

export class InvalidWalletError extends DomainError {}

export class InvalidWagerTransactionError extends DomainError {}

/** Transição de estado fora da RN-25: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {}

export class InvalidInboxMessageError extends DomainError {}

export class InvalidOutboxMessageError extends DomainError {}
