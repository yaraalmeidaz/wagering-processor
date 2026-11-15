import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import type { ReadinessCheck } from '../../application/ports/readiness-check';
import { READINESS_CHECK } from './tokens';

interface StatusResponse {
  status(code: number): unknown;
}

/** Health sem autenticação e fora do AuthGuard (AGENTS.md §10; ADR-0008). */
@Controller('health')
export class HealthController {
  readonly #readiness: ReadinessCheck;

  constructor(@Inject(READINESS_CHECK) readiness: ReadinessCheck) {
    this.#readiness = readiness;
  }

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL agora. O SQS entra na verificação com a mensageria (Fase 6). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse) {
    const checks = await this.#readiness.check();
    const ok = checks.postgres === 'ok';
    response.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}
