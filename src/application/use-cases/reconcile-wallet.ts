import { Money } from '../../domain/money';
import { WalletNotFoundError } from '../errors';
import { requiredUuid } from '../input';
import type { ReconciliationContext, ReconciliationMonitor } from '../ports/reconciliation-monitor';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  /** storedBalance - calculatedBalance (ADR-0009). */
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Reconciliação da RN-37: soma o ledger sem usar balance_after e compara com o
 * saldo gravado. Divergência vai para o monitor (log e métrica). Nunca corrige.
 */
export class ReconcileWallet {
  readonly #uow: UnitOfWork;
  readonly #monitor: ReconciliationMonitor;

  constructor(dependencies: { unitOfWork: UnitOfWork; monitor: ReconciliationMonitor }) {
    this.#uow = dependencies.unitOfWork;
    this.#monitor = dependencies.monitor;
  }

  async execute(walletId: unknown, context: ReconciliationContext): Promise<ReconciliationResult> {
    const id = requiredUuid(walletId, 'walletId');
    const result = await this.#uow.run(async ({ wallets, ledger }) => {
      // FOR UPDATE: a soma e o saldo vêm do mesmo instante (ADR-0009).
      const wallet = await wallets.findByIdForUpdate(id);
      if (wallet === null) throw new WalletNotFoundError(`wallet ${id} não encontrada`);
      const summary = await ledger.summarize(id);
      const calculatedBalance = Money.rehydrate(summary.creditsMinusDebits, wallet.currency);
      const difference = wallet.balance.subtract(calculatedBalance);
      return {
        walletId: id,
        storedBalance: wallet.balance,
        calculatedBalance,
        difference,
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });
    if (!result.consistent) {
      this.#monitor.divergenceDetected(result, context);
    }
    return result;
  }
}
