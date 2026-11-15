import type { WagerTransaction } from '../../domain/wager-transaction';
import { TransactionNotFoundError } from '../errors';
import { requiredText, requiredUuid } from '../input';
import type { UnitOfWork } from '../ports/unit-of-work';

/** GET /wagering/transactions/:id e GET /providers/:p/wagering/transactions/:ext (SPEC 13). */
export class GetTransaction {
  readonly #uow: UnitOfWork;

  constructor(dependencies: { unitOfWork: UnitOfWork }) {
    this.#uow = dependencies.unitOfWork;
  }

  async byId(transactionId: unknown): Promise<WagerTransaction> {
    const id = requiredUuid(transactionId, 'transactionId');
    const found = await this.#uow.run(({ transactions }) => transactions.findById(id));
    if (found === null) throw new TransactionNotFoundError(`transação ${id} não encontrada`);
    return found;
  }

  async byExternalId(
    providerId: unknown,
    externalTransactionId: unknown,
  ): Promise<WagerTransaction> {
    const provider = requiredText(providerId, 'providerId');
    const external = requiredText(externalTransactionId, 'externalTransactionId');
    const found = await this.#uow.run(({ transactions }) =>
      transactions.findByProviderAndExternalId(provider, external),
    );
    if (found === null) {
      throw new TransactionNotFoundError(`transação ${provider}/${external} não encontrada`);
    }
    return found;
  }
}
