import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Clock } from './application/ports/clock';
import type { ReconciliationMonitor } from './application/ports/reconciliation-monitor';
import type { UnitOfWork } from './application/ports/unit-of-work';
import { CreateWallet } from './application/use-cases/create-wallet';
import { GetTransaction } from './application/use-cases/get-transaction';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { ReconcileWallet } from './application/use-cases/reconcile-wallet';
import { GetLedger, GetWallet } from './application/use-cases/wallet-queries';
import { SqsReadinessCheck } from './infrastructure/messaging/sqs-readiness-check';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { PostgresReadinessCheck } from './infrastructure/persistence/postgres-readiness-check';
import { CompositeReadinessCheck } from './infrastructure/readiness';
import { SystemClock } from './infrastructure/system-clock';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import {
  CLOCK,
  LOG_SINK,
  METRICS,
  PROCESS_WAGER,
  READINESS_CHECK,
  RECONCILIATION_MONITOR,
  UNIT_OF_WORK,
} from './interfaces/http/tokens';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { type LogSink, stdoutLogSink } from './observability/log-sink';
import { LoggingReconciliationMonitor } from './observability/logging-reconciliation-monitor';
import { InMemoryMetrics, type Metrics } from './observability/metrics';

/** Cliente SQS e fila de entrada, para a readiness (ADR-0010). */
export interface AppSqsOptions {
  readonly client: SQSClient;
  readonly inputQueueUrl: string;
}

export interface AppModuleOptions {
  readonly orm: MikroORM;
  readonly sqs: AppSqsOptions;
}

/** Raiz de composição: liga as portas às implementações (SPEC 2). */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: módulo dinâmico do NestJS, que exige a classe com forRoot.
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const deps = (unitOfWork: UnitOfWork, clock: Clock) => ({ unitOfWork, clock });
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        { provide: UNIT_OF_WORK, useFactory: () => new MikroOrmUnitOfWork(options.orm.em) },
        { provide: CLOCK, useValue: new SystemClock() },
        { provide: METRICS, useValue: new InMemoryMetrics() },
        {
          provide: READINESS_CHECK,
          useFactory: () =>
            new CompositeReadinessCheck({
              postgres: new PostgresReadinessCheck(options.orm),
              sqs: new SqsReadinessCheck(options.sqs.client, options.sqs.inputQueueUrl),
            }),
        },
        { provide: LOG_SINK, useValue: stdoutLogSink },
        {
          provide: RECONCILIATION_MONITOR,
          useFactory: (metrics: Metrics, sink: LogSink, clock: Clock) =>
            new LoggingReconciliationMonitor({ metrics, sink, clock }),
          inject: [METRICS, LOG_SINK, CLOCK],
        },
        {
          provide: ProcessWagerTransaction,
          useFactory: (uow: UnitOfWork, clock: Clock) =>
            new ProcessWagerTransaction(deps(uow, clock)),
          inject: [UNIT_OF_WORK, CLOCK],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, clock: Clock) => new CreateWallet(deps(uow, clock)),
          inject: [UNIT_OF_WORK, CLOCK],
        },
        {
          provide: GetWallet,
          useFactory: (uow: UnitOfWork) => new GetWallet({ unitOfWork: uow }),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: GetLedger,
          useFactory: (uow: UnitOfWork) => new GetLedger({ unitOfWork: uow }),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: GetTransaction,
          useFactory: (uow: UnitOfWork) => new GetTransaction({ unitOfWork: uow }),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: ReconcileWallet,
          useFactory: (uow: UnitOfWork, monitor: ReconciliationMonitor) =>
            new ReconcileWallet({ unitOfWork: uow, monitor }),
          inject: [UNIT_OF_WORK, RECONCILIATION_MONITOR],
        },
        AuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
