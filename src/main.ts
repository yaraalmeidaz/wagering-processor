import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';

const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig());
  const app = await NestFactory.create(AppModule.forRoot({ orm }));
  app.enableShutdownHooks();
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  await app.listen(port);
}

void bootstrap();
