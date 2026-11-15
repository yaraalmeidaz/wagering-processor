/**
 * Guarda (a), AGENTS.md §2.11 e §3: src/domain/ só importa a biblioteca padrão
 * do Node (com ou sem o prefixo `node:`) e arquivos do próprio domínio.
 *
 * Falha em: qualquer pacote (NestJS, MikroORM, SDK da AWS, pg ou outro),
 * módulos `bun:` e imports relativos que saem de src/domain/.
 *
 * Uso: bun scripts/guards/domain-imports.ts [diretório]  (padrão: src/domain)
 */
import { builtinModules } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { findSpecifiers, finish, lineAt, readTsFiles, type Violation } from './lib';

const GUARD = 'domain-imports';
const root = resolve(process.argv[2] ?? 'src/domain');
const builtins = new Set(builtinModules);

function violationFor(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier);
    return target === root || target.startsWith(root + sep)
      ? undefined
      : `import relativo '${specifier}' sai do domínio`;
  }
  if (specifier.startsWith('node:') || builtins.has(specifier)) {
    return undefined;
  }
  return `domínio importa o pacote '${specifier}'`;
}

const files = readTsFiles(root);
if (files.length === 0) {
  console.log(
    `guard:${GUARD}: ${relative(process.cwd(), root)} não existe ou não tem arquivos .ts; nada a verificar`,
  );
  process.exit(0);
}

const violations: Violation[] = [];
for (const { path, content } of files) {
  for (const { specifier, index } of findSpecifiers(content)) {
    const message = violationFor(path, specifier);
    if (message !== undefined) {
      violations.push({ file: path, line: lineAt(content, index), message });
    }
  }
}
finish(GUARD, violations, files.length);
