import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletVersionConflictError } from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { Money } from '../../../src/domain/money';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../helpers/database';
import { seedWallet } from '../../helpers/wallet-seed';

// ADR-0003: o UPDATE da wallet é condicionado à versão lida (CAS), mesmo sob lock.
describe('CAS por version no UPDATE da wallet', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase('persistence_wallet_cas');
    await db.orm.migrator.up();
    uow = new MikroOrmUnitOfWork(db.orm.em);
  });

  afterAll(async () => {
    await db?.dispose();
  });

  test('versão esperada diferente da gravada: WalletVersionConflictError e nada muda', async () => {
    const wallet = await seedWallet(uow, '10.00');
    const debit = wallet.debit(Money.create('1.00', 'BRL'), {
      entryId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      now: new Date(),
    });
    if (!debit.ok) throw new Error('esperava débito');

    // Outra escrita já levou a wallet para a versão 2.
    await db.execute(`UPDATE wallets SET version = 2 WHERE id = ?`, [wallet.id]);

    await expect(uow.run(({ wallets }) => wallets.update(wallet, 1))).rejects.toBeInstanceOf(
      WalletVersionConflictError,
    );
    const rows = await db.execute(
      `SELECT balance_amount::text AS balance, version FROM wallets WHERE id = ?`,
      [wallet.id],
    );
    expect(rows[0]).toEqual({ balance: '10.00', version: 2 });
  });
});
