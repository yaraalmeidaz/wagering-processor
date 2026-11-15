import { InvalidLedgerEntryError } from './errors';
import type { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WalletLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

/** Lançamento imutável do ledger (RN-36; SPEC 3.4). */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.amount = props.amount;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAt = new Date(props.createdAt);
    Object.freeze(this);
  }

  /** Valida balanceBefore ± amount == balanceAfter, valor positivo e saldos não negativos. */
  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    const { amount, balanceBefore, balanceAfter, direction } = props;
    if (!amount.hasSameCurrency(balanceBefore) || !amount.hasSameCurrency(balanceAfter)) {
      throw new InvalidLedgerEntryError('valor e saldos do lançamento precisam ter a mesma moeda');
    }
    if (!amount.isPositive()) {
      throw new InvalidLedgerEntryError('lançamento precisa de valor maior que zero');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('saldo do lançamento não pode ser negativo');
    }
    const expected =
      direction === 'CREDIT' ? balanceBefore.add(amount) : balanceBefore.subtract(amount);
    if (!expected.equals(balanceAfter)) {
      throw new InvalidLedgerEntryError('saldo anterior ± valor difere do saldo posterior');
    }
    return new WalletLedgerEntry(props);
  }

  /** Reconstrói um lançamento já persistido, sem revalidar (SPEC 2.1). */
  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }
}
