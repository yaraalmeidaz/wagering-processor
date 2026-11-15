import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Repositories, UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';

// ADR-0001: uma transação por unidade de trabalho, em.fork() por execução, sem escrita fora dela.
const brl = (amount: string): Money => Money.create(amount, 'BRL');
const NOW = new Date('2026-01-01T00:00:00.000Z');

function newWallet(initial = '0.00'): Wallet {
  return Wallet.create({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency: 'BRL',
    initialBalance: brl(initial),
    opening: { entryId: crypto.randomUUID(), transactionId: crypto.randomUUID() },
    now: NOW,
  }).wallet;
}

describe('MikroOrmUnitOfWork', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('persistence_uow');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('exceção dentro da unidade desfaz todas as escritas', async () => {
    const wallet = newWallet();
    await expect(
      uow.run(async ({ wallets }) => {
        await wallets.add(wallet);
        throw new Error('falha depois da escrita');
      }),
    ).rejects.toThrow('falha depois da escrita');

    expect(await uow.run(({ wallets }) => wallets.findById(wallet.id))).toBeNull();
  });

  test('violação de constraint no meio da unidade desfaz as escritas anteriores (atomicidade)', async () => {
    const wallet = newWallet();
    const orphan = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: crypto.randomUUID(),
      direction: 'CREDIT',
      amount: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
      createdAt: NOW,
    });

    await expect(
      uow.run(async ({ wallets, ledger }) => {
        await wallets.add(wallet);
        await ledger.append(orphan);
      }),
    ).rejects.toThrow();

    expect(await uow.run(({ wallets }) => wallets.findById(wallet.id))).toBeNull();
  });

  test('cada unidade lê o estado commitado, sem cache de unidade anterior', async () => {
    const wallet = newWallet('10.00');
    await uow.run(({ wallets }) => wallets.add(wallet));
    expect((await uow.run(({ wallets }) => wallets.findById(wallet.id)))?.balance.amount).toBe(
      '10.00',
    );

    await db.execute(`UPDATE wallets SET balance_amount = '7.00' WHERE id = ?`, [wallet.id]);

    expect((await uow.run(({ wallets }) => wallets.findById(wallet.id)))?.balance.amount).toBe(
      '7.00',
    );
  });

  test('repositório usado depois do fim da unidade recusa a operação', async () => {
    let captured: Repositories | undefined;
    await uow.run(async (repositories) => {
      captured = repositories;
    });
    const wallet = newWallet();

    await expect(captured?.wallets.add(wallet) ?? Promise.resolve()).rejects.toThrow(
      'fora de uma unidade de trabalho',
    );
    expect(await uow.run(({ wallets }) => wallets.findById(wallet.id))).toBeNull();
  });

  test('o valor devolvido pela unidade chega ao chamador', async () => {
    expect(await uow.run(async () => 42)).toBe(42);
  });

  test('uma unidade lê, outra altera o saldo e commita, e a leitura seguinte vê o saldo novo (AGENTS.md §2.12)', async () => {
    const created = newWallet('10.00');
    await uow.run(({ wallets }) => wallets.add(created));

    const firstRead = await uow.run(({ wallets }) => wallets.findById(created.id));
    expect(firstRead?.balance.amount).toBe('10.00');

    await uow.run(async ({ wallets }) => {
      const wallet = await wallets.findById(created.id);
      if (wallet === null) throw new Error('wallet ausente');
      const debit = wallet.debit(brl('4.00'), {
        entryId: crypto.randomUUID(),
        transactionId: crypto.randomUUID(),
        now: NOW,
      });
      if (!debit.ok) throw new Error('esperava débito');
      await wallets.update(wallet);
    });

    const secondRead = await uow.run(({ wallets }) => wallets.findById(created.id));
    expect(secondRead?.balance.amount).toBe('6.00');
    expect(secondRead?.version).toBe(2);
  });
});
