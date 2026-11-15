import type { ProcessWagerInput } from '../../src/application/use-cases/process-wager-transaction';
import type { Wallet } from '../../src/domain/wallet';

/** Entrada válida de BET para a wallet, com chave padrão {providerId}:{externalTransactionId} (RN-23). */
export function betInput(
  wallet: Wallet,
  amount: string,
  overrides: Partial<ProcessWagerInput> = {},
): ProcessWagerInput {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
  const providerId = overrides.providerId ?? 'provider-1';
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: wallet.currency },
    referenceExternalTransactionId: null,
    ...overrides,
  };
}
