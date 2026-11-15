export interface WagerTransactionFixture {
  retryCount: number;
  amount: number;
  creditLimit?: double;
}
export const walletFixture = { balance: 10.5 };
let debitValue = 0;
