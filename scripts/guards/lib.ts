import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Violation {
  file: string;
  line: number;
  message: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

/** Lista os arquivos .ts (exceto .d.ts) sob `root`, recursivamente. */
export function readTsFiles(root: string): SourceFile[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .sort()
    .map((entry) => {
      const path = join(root, entry);
      return { path, content: readFileSync(path, 'utf8') };
    });
}

/** Linha (1-based) do caractere na posição `index`. */
export function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/**
 * Troca comentários por espaços, mantendo as quebras de linha, para que as
 * posições e os números de linha continuem válidos.
 * Limite: não reconhece strings, então `'http://x'` perde o resto da linha.
 */
export function stripComments(content: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return content.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** Especificadores de import, export-from, import() e require(), com a posição. */
export function findSpecifiers(content: string): { specifier: string; index: number }[] {
  const pattern =
    /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const found: { specifier: string; index: number }[] = [];
  for (const match of stripComments(content).matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      found.push({ specifier, index: match.index });
    }
  }
  return found;
}

/** Imprime o resultado e encerra: 1 se houver violação, 0 caso contrário. */
export function finish(guard: string, violations: Violation[], checkedFiles: number): never {
  if (violations.length === 0) {
    console.log(`guard:${guard}: ok (${checkedFiles} arquivo(s) verificado(s))`);
    process.exit(0);
  }
  for (const v of violations) {
    console.error(`${relative(process.cwd(), v.file)}:${v.line}: ${v.message}`);
  }
  console.error(`guard:${guard}: ${violations.length} violação(ões)`);
  process.exit(1);
}
