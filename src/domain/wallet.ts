import { InvalidWalletError } from './errors';
import type { FailureCode } from './failure-code';
import type { Money } from './money';
import { type LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly initialBalance: Money;
  /** Identificadores do OPENING, usados só quando o saldo inicial é maior que zero (RN-04). */
  readonly opening: { readonly entryId: string; readonly transactionId: string };
  readonly now: Date;
}

export interface BalanceOperation {
  readonly entryId: string;
  readonly transactionId: string;
  readonly now: Date;
}

export type InsufficientBalanceCode = Extract<
  FailureCode,
  'INSUFFICIENT_FUNDS' | 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE'
>;

/** Resultado de débito ou crédito. Rejeição é resultado, não exceção (RN-19). */
export type BalanceResult =
  | {
      readonly ok: true;
      readonly balanceBefore: Money;
      readonly balanceAfter: Money;
      /** Nulo quando o valor é zero: sem lançamento (RN-10). */
      readonly entry: WalletLedgerEntry | null;
    }
  | { readonly ok: false; readonly failureCode: FailureCode };

/** Aggregate root da carteira (SPEC 3.2). */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  #balance: Money;
  #version: number;
  #updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.createdAt = new Date(state.createdAt);
    this.#balance = state.balance;
    this.#version = state.version;
    this.#updatedAt = new Date(state.updatedAt);
  }

  /** Cria a wallet com versão 1. Saldo inicial maior que zero gera o lançamento do OPENING (RN-03, RN-04). */
  static create(props: CreateWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | null;
  } {
    const { initialBalance } = props;
    if (initialBalance.currency !== props.currency) {
      throw new InvalidWalletError('saldo inicial precisa estar na moeda da wallet');
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('saldo inicial não pode ser negativo');
    }
    const wallet = new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.currency,
      balance: initialBalance,
      version: 1,
      createdAt: props.now,
      updatedAt: props.now,
    });
    const openingEntry = initialBalance.isZero()
      ? null
      : WalletLedgerEntry.create({
          id: props.opening.entryId,
          walletId: props.id,
          transactionId: props.opening.transactionId,
          direction: 'CREDIT',
          amount: initialBalance,
          balanceBefore: initialBalance.subtract(initialBalance),
          balanceAfter: initialBalance,
          createdAt: props.now,
        });
    return { wallet, openingEntry };
  }

  /** Reconstrói a wallet persistida, sem revalidar (SPEC 2.1). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  belongsTo(playerId: string): boolean {
    return this.playerId === playerId;
  }

  debit(
    money: Money,
    operation: BalanceOperation,
    insufficientCode: InsufficientBalanceCode = 'INSUFFICIENT_FUNDS',
  ): BalanceResult {
    if (money.currency !== this.currency) {
      return { ok: false, failureCode: 'CURRENCY_MISMATCH' };
    }
    if (this.#balance.isLessThan(money)) {
      return { ok: false, failureCode: insufficientCode };
    }
    return this.#apply('DEBIT', money, operation);
  }

  credit(money: Money, operation: BalanceOperation): BalanceResult {
    if (money.currency !== this.currency) {
      return { ok: false, failureCode: 'CURRENCY_MISMATCH' };
    }
    return this.#apply('CREDIT', money, operation);
  }

  /** A versão só incrementa quando o saldo muda (RN-03, RN-10). */
  #apply(direction: LedgerDirection, money: Money, operation: BalanceOperation): BalanceResult {
    const balanceBefore = this.#balance;
    if (money.isZero()) {
      return { ok: true, balanceBefore, balanceAfter: balanceBefore, entry: null };
    }
    const balanceAfter =
      direction === 'CREDIT' ? balanceBefore.add(money) : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: operation.entryId,
      walletId: this.id,
      transactionId: operation.transactionId,
      direction,
      amount: money,
      balanceBefore,
      balanceAfter,
      createdAt: operation.now,
    });
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = new Date(operation.now);
    return { ok: true, balanceBefore, balanceAfter, entry };
  }
}
