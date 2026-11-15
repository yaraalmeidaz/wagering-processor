import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import {
  outboxRecordOf,
  transactionEventData,
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../events';
import { requiredMoney, requiredUuid } from '../input';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface CreateWalletInput {
  readonly playerId: unknown;
  readonly initialBalance: unknown;
}

/** Identificadores do OPENING interno (ADR-0009). */
const OPENING_PROVIDER = 'internal';

/**
 * Cria a wallet e, se o saldo inicial for maior que zero, o OPENING com lançamento
 * de crédito e os eventos da RN-04, tudo na mesma transação (SPEC 13; ADR-0006).
 */
export class CreateWallet {
  readonly #uow: UnitOfWork;
  readonly #clock: Clock;

  constructor(dependencies: { unitOfWork: UnitOfWork; clock: Clock }) {
    this.#uow = dependencies.unitOfWork;
    this.#clock = dependencies.clock;
  }

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const playerId = requiredUuid(input.playerId, 'playerId');
    const initialBalance = requiredMoney(input.initialBalance, 'initialBalance');
    const now = this.#clock.now();
    const walletId = crypto.randomUUID();
    const openingId = crypto.randomUUID();
    const { wallet, openingEntry } = Wallet.create({
      id: walletId,
      playerId,
      currency: initialBalance.currency,
      initialBalance,
      opening: { entryId: crypto.randomUUID(), transactionId: openingId },
      now,
    });

    try {
      await this.#uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        await wallets.add(wallet);
        if (openingEntry === null) return;

        const externalTransactionId = `opening:${walletId}`;
        const opening = WagerTransaction.create({
          id: openingId,
          providerId: OPENING_PROVIDER,
          externalTransactionId,
          idempotencyKey: `${OPENING_PROVIDER}:${externalTransactionId}`,
          payloadHash: payloadHash({
            providerId: OPENING_PROVIDER,
            externalTransactionId,
            playerId,
            walletId,
            roundId: 'opening',
            gameId: 'opening',
            kind: 'OPENING',
            money: initialBalance.toJSON(),
          }),
          walletId,
          playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: 'OPENING',
          money: initialBalance,
          referenceExternalTransactionId: null,
          createdAt: now,
        });
        opening.markProcessed(wallet.balance, now);
        await transactions.add(opening);
        await ledger.append(openingEntry);

        const context = () => ({
          eventId: crypto.randomUUID(),
          aggregateId: walletId,
          correlationId: opening.id,
          occurredAt: now,
        });
        await outbox.append(
          outboxRecordOf(new WagerTransactionProcessed(context(), transactionEventData(opening))),
        );
        await outbox.append(
          outboxRecordOf(WalletBalanceChanged.from(wallet, openingEntry, context())),
        );
      });
    } catch (error) {
      // UNIQUE (player_id, currency) da SPEC 12 (RN-03).
      if (
        error instanceof UniqueViolationError &&
        error.constraint?.startsWith('wallets_') === true
      ) {
        throw new WalletAlreadyExistsError(
          `já existe wallet em ${initialBalance.currency} para o player ${playerId}`,
          { cause: error },
        );
      }
      throw error;
    }
    return wallet;
  }
}
