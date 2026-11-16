import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createSqsClient, resolveQueueUrls } from './infrastructure/messaging/sqs-client';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';

const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig());
  const sqs = createSqsClient();
  const queues = await resolveQueueUrls(sqs);
  const app = await NestFactory.create(
    AppModule.forRoot({ orm, sqs: { client: sqs, inputQueueUrl: queues.input } }),
  );
  app.enableShutdownHooks();
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  await app.listen(port);
}

void bootstrap();
