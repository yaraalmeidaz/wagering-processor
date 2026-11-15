import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InvalidInputError } from '../../application/errors';
import { CreateWallet } from '../../application/use-cases/create-wallet';
import { ReconcileWallet } from '../../application/use-cases/reconcile-wallet';
import {
  GetLedger,
  GetWallet,
  LEDGER_DEFAULT_LIMIT,
} from '../../application/use-cases/wallet-queries';
import { AuthGuard } from './auth.guard';
import { correlationIdOf } from './correlation-id';
import { decodeLedgerCursor, encodeLedgerCursor, parseLedgerLimit } from './ledger-cursor';
import { ledgerEntryJson, reconciliationJson, walletJson } from './presenters';

/** Endpoints de wallet da SPEC 13 (ADR-0009). */
@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  readonly #createWallet: CreateWallet;
  readonly #getWallet: GetWallet;
  readonly #getLedger: GetLedger;
  readonly #reconcile: ReconcileWallet;

  constructor(
    @Inject(CreateWallet) createWallet: CreateWallet,
    @Inject(GetWallet) getWallet: GetWallet,
    @Inject(GetLedger) getLedger: GetLedger,
    @Inject(ReconcileWallet) reconcile: ReconcileWallet,
  ) {
    this.#createWallet = createWallet;
    this.#getWallet = getWallet;
    this.#getLedger = getLedger;
    this.#reconcile = reconcile;
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = objectBody(body);
    const wallet = await this.#createWallet.execute({
      playerId: input['playerId'],
      initialBalance: input['initialBalance'],
    });
    return walletJson(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletJson(await this.#getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.#getLedger.execute(
      walletId,
      parseLedgerLimit(limit, LEDGER_DEFAULT_LIMIT),
      cursor === undefined ? null : decodeLedgerCursor(cursor),
    );
    return {
      items: page.items.map(ledgerEntryJson),
      nextCursor: page.next === null ? null : encodeLedgerCursor(page.next),
    };
  }

  /** Sem corpo (RN-37). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
  ) {
    return reconciliationJson(
      await this.#reconcile.execute(walletId, {
        correlationId: correlationIdOf(correlationHeader),
      }),
    );
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidInputError('o corpo precisa ser um objeto JSON');
  }
  return body as Record<string, unknown>;
}
