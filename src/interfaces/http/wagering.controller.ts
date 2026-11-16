import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { InvalidWagerInputError } from '../../application/errors';
import { GetTransaction } from '../../application/use-cases/get-transaction';
import type {
  ProcessWager,
  ProcessWagerResult,
} from '../../application/use-cases/process-wager-transaction';
import { AuthGuard } from './auth.guard';
import { MissingIdempotencyKeyError } from './http-error.filter';
import { transactionJson, wagerResultJson } from './presenters';
import { PROCESS_WAGER } from './tokens';

interface StatusResponse {
  status(code: number): unknown;
}

/** Endpoints de transação da SPEC 13. O mesmo caso de uso atende HTTP e SQS (SPEC 5). */
@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  readonly #process: ProcessWager;
  readonly #getTransaction: GetTransaction;

  constructor(
    @Inject(PROCESS_WAGER) process: ProcessWager,
    @Inject(GetTransaction) getTransaction: GetTransaction,
  ) {
    this.#process = process;
    this.#getTransaction = getTransaction;
  }

  @Post('wagering/transactions')
  async process(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    // RN-23: o header é obrigatório e é a fonte da verdade da chave.
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new MissingIdempotencyKeyError();
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new InvalidWagerInputError('o corpo precisa ser um objeto JSON');
    }
    const input = body as Record<string, unknown>;
    const result = await this.#process.execute({
      idempotencyKey,
      providerId: input['providerId'] as string,
      externalTransactionId: input['externalTransactionId'] as string,
      playerId: input['playerId'] as string,
      walletId: input['walletId'] as string,
      roundId: input['roundId'] as string,
      gameId: input['gameId'] as string,
      kind: input['kind'] as string,
      money: input['money'] as { amount: string; currency: string },
      referenceExternalTransactionId: (input['referenceExternalTransactionId'] ?? null) as
        | string
        | null,
    });
    response.status(statusOf(result));
    if (result.status === 'FAILED') {
      // SPEC 9.2: replay de FAILED é 500 TRANSACTION_FAILED, sem failureCode (ADR-0005).
      return {
        code: 'TRANSACTION_FAILED',
        message: 'transação em falha permanente',
        transactionId: result.transactionId,
      };
    }
    return wagerResultJson(result);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    return transactionJson(await this.#getTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionJson(
      await this.#getTransaction.byExternalId(providerId, externalTransactionId),
    );
  }
}

/** Status da SPEC 9.2 para o resultado do caso de uso. */
function statusOf(result: ProcessWagerResult): number {
  switch (result.status) {
    case 'PROCESSED':
      return result.idempotentReplay ? 200 : 201;
    case 'PENDING_REFERENCE':
      return 202;
    case 'REJECTED':
      return 422;
    case 'FAILED':
      return 500;
    case 'PENDING':
      // Nunca é devolvido pelo caso de uso; tratado como transitório.
      return 503;
  }
}
