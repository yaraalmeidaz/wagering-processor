import 'reflect-metadata';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface HttpApp {
  readonly app: INestApplication;
  readonly logs: string[];
  call(
    method: string,
    path: string,
    options?: { body?: unknown; rawBody?: string; headers?: Record<string, string> },
  ): Promise<HttpResponse>;
  close(): Promise<void>;
}

/** Guarda as mensagens de log da aplicação, para os testes conferirem. */
class CollectingLogger implements LoggerService {
  readonly messages: string[] = [];
  log(message: unknown) {
    this.messages.push(String(message));
  }
  warn(message: unknown) {
    this.messages.push(String(message));
  }
  error(message: unknown) {
    this.messages.push(String(message));
  }
}

/**
 * Um coletor por processo: app.useLogger troca o logger global do NestJS, então
 * um segundo app no mesmo arquivo de teste passaria a receber os logs do primeiro.
 */
const logger = new CollectingLogger();

/** Sobe a aplicação Nest real sobre o ORM do banco descartável, sem mock do banco. */
export async function startHttpApp(
  orm: MikroORM,
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<HttpApp> {
  const moduleRef = await customize(
    Test.createTestingModule({ imports: [AppModule.forRoot({ orm })] }),
  ).compile();
  const app = moduleRef.createNestApplication();
  app.useLogger(logger);
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  return {
    app,
    logs: logger.messages,
    async call(method, path, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      let payload: string | undefined;
      if (options.rawBody !== undefined) {
        payload = options.rawBody;
        headers['content-type'] = 'application/json';
      } else if (options.body !== undefined) {
        payload = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
      const text = await response.text();
      const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      return { status: response.status, headers: response.headers, body };
    },
    close: () => app.close(),
  };
}
