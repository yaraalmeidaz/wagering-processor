import { InboxMessageOrmEntity } from './InboxMessageOrmEntity';
import { OutboxMessageOrmEntity } from './OutboxMessageOrmEntity';
import { WagerTransactionOrmEntity } from './WagerTransactionOrmEntity';
import { WalletLedgerEntryOrmEntity } from './WalletLedgerEntryOrmEntity';
import { WalletOrmEntity } from './WalletOrmEntity';

/** Uma entidade ORM por tabela da SPEC 12. O schema é das migrations, não do ORM. */
export const ORM_ENTITIES = [
  WalletOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
];

export {
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
};
