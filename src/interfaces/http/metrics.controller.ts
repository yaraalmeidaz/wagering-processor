import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Metrics } from '../../observability/metrics';
import { METRICS } from './tokens';

/** Exposição das métricas da SPEC 14.2, sem AuthGuard, como o health (ADR-0011). */
@Controller('metrics')
export class MetricsController {
  readonly #metrics: Metrics;

  constructor(@Inject(METRICS) metrics: Metrics) {
    this.#metrics = metrics;
  }

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return this.#metrics.render();
  }
}
