/**
 * Guarda (c), AGENTS.md §2.10: teste de integração usa PostgreSQL e SQS reais.
 *
 * Falha em arquivo .ts de test/integration/ que:
 *   1. importa um especificador cujo nome contém "mock" (ex.: aws-sdk-client-mock,
 *      ../helpers/mock-sqs) ou um emulador em memória de banco (pg-mem);
 *   2. chama mock.module(), jest.mock() ou vi.mock() sobre um cliente de banco
 *      ou de fila (pg, postgres, @mikro-orm/*, @aws-sdk/*, sqs-*, knex, kysely,
 *      typeorm, drizzle-orm) ou sobre src/infrastructure/persistence|messaging.
 *
 * Não cobre: mocks feitos à mão sem import (classe falsa definida no próprio
 * teste), spyOn em métodos do cliente e injeção de dublê pelo módulo do Nest.
 *
 * Uso: bun scripts/guards/integration-mocks.ts [diretório]  (padrão: test/integration)
 */
import { resolve } from 'node:path';
import { findSpecifiers, finish, lineAt, readTsFiles, stripComments, type Violation } from './lib';

const GUARD = 'integration-mocks';
const root = resolve(process.argv[2] ?? 'test/integration');

const MOCK_IMPORT = /mock|^pg-mem$/i;
const MOCK_CALL = /\b(?:mock\.module|jest\.mock|vi\.mock)\s*\(\s*['"]([^'"]+)['"]/g;
const DB_OR_QUEUE_CLIENT =
  /^(?:pg|pg-pool|postgres|@mikro-orm\/.+|@aws-sdk\/.+|sqs-.+|knex|kysely|typeorm|drizzle-orm(?:\/.+)?)$|infrastructure\/(?:persistence|messaging)/;

const files = readTsFiles(root);
const violations: Violation[] = [];
for (const { path, content } of files) {
  for (const { specifier, index } of findSpecifiers(content)) {
    if (MOCK_IMPORT.test(specifier)) {
      violations.push({
        file: path,
        line: lineAt(content, index),
        message: `teste de integração importa mock '${specifier}'`,
      });
    }
  }
  for (const match of stripComments(content).matchAll(MOCK_CALL)) {
    const target = match[1] ?? '';
    if (DB_OR_QUEUE_CLIENT.test(target)) {
      violations.push({
        file: path,
        line: lineAt(content, match.index),
        message: `teste de integração substitui '${target}' por mock`,
      });
    }
  }
}
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
finish(GUARD, violations, files.length);
