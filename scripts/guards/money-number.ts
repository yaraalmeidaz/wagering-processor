/**
 * Guarda (b), AGENTS.md §2.1: dinheiro nunca é number, float ou double.
 *
 * Detecção por texto, linha a linha, depois de remover comentários. Um nome é
 * monetário quando contém, sem distinguir maiúsculas, uma destas palavras:
 * amount, balance, money, value, debit, credit, stake, payout (ex.: amount,
 * resultingBalance, creditLimit, stake). Falha em:
 *   1. nome monetário anotado como number, float ou double
 *      (`amount: number`, `creditLimit?: double`);
 *   2. nome monetário recebendo um literal numérico, em propriedade de objeto
 *      ou atribuição (`{ balance: 10.5 }`, `let debitValue = 0`).
 *
 * Não cobre: tipos indiretos (alias `type Amount = number`, `Array<number>`,
 * genéricos), `bigint`, conversões (`Number(x)`, `parseFloat`, `+x`),
 * decorators de ORM com `type: 'float'` ou `'double'`, nomes monetários fora
 * da lista (ex.: `price`, `total`, `winnings`) e expressões aritméticas sem
 * literal.
 * Falso positivo conhecido: `value` é genérico, e `cond ? balance : 0` casa
 * com a regra 2.
 *
 * Uso: bun scripts/guards/money-number.ts [diretório]  (padrão: src)
 */
import { resolve } from 'node:path';
import { finish, lineAt, readTsFiles, stripComments, type Violation } from './lib';

const GUARD = 'money-number';
const root = resolve(process.argv[2] ?? 'src');

const MONEY_NAME = String.raw`[\w$]*(?:amount|balance|money|value|debit|credit|stake|payout)[\w$]*`;
const NUMERIC_LITERAL = String.raw`[-+]?(?:\d|\.\d)`;
const RULES: { pattern: RegExp; message: (name: string, detail: string) => string }[] = [
  {
    pattern: new RegExp(String.raw`\b(${MONEY_NAME})\s*[?!]?\s*:\s*(number|float|double)\b`, 'gi'),
    message: (name, type) => `campo monetário '${name}' tipado como ${type}`,
  },
  {
    pattern: new RegExp(String.raw`\b(${MONEY_NAME})\s*[?!]?\s*(:|=)\s*(${NUMERIC_LITERAL})`, 'gi'),
    message: (name) => `campo monetário '${name}' recebe literal numérico`,
  },
];

const files = readTsFiles(root);
const violations: Violation[] = [];
for (const { path, content } of files) {
  const code = stripComments(content);
  for (const { pattern, message } of RULES) {
    for (const match of code.matchAll(pattern)) {
      violations.push({
        file: path,
        line: lineAt(code, match.index),
        message: message(match[1] ?? '', match[2] ?? ''),
      });
    }
  }
}
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
finish(GUARD, violations, files.length);
