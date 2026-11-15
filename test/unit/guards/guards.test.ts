import { describe, expect, test } from 'bun:test';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const fixtures = new URL('../../guards/fixtures/', import.meta.url).pathname;

function runGuard(guard: string, target: string): { code: number; output: string } {
  const result = Bun.spawnSync([process.execPath, `scripts/guards/${guard}.ts`, target], {
    cwd: repoRoot,
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

// AGENTS.md §2.11: domínio não importa framework nem pacote externo.
describe('guarda domain-imports', () => {
  test('falha com arquivo e linha de cada import proibido', () => {
    const { code, output } = runGuard('domain-imports', `${fixtures}domain-imports/fail`);

    expect(code).toBe(1);
    expect(output).toContain('wallet.ts:1');
    expect(output).toContain('@nestjs/common');
    expect(output).toContain('wallet.ts:3');
    expect(output).toContain("'pg'");
    expect(output).toContain('wallet.ts:4');
    expect(output).not.toContain('wallet.ts:2');
  });

  test('passa com imports relativos ao domínio e biblioteca padrão', () => {
    const { code } = runGuard('domain-imports', `${fixtures}domain-imports/pass`);

    expect(code).toBe(0);
  });

  test('passa quando o diretório do domínio não existe', () => {
    const { code } = runGuard('domain-imports', `${fixtures}domain-imports/inexistente`);

    expect(code).toBe(0);
  });
});

// AGENTS.md §2.1: dinheiro nunca é number, float ou double.
describe('guarda money-number', () => {
  test('falha com arquivo e linha de cada campo monetário numérico', () => {
    const { code, output } = runGuard('money-number', `${fixtures}money-number/fail`);

    expect(code).toBe(1);
    expect(output).toContain('transaction.ts:3');
    expect(output).toContain('transaction.ts:4');
    expect(output).toContain('transaction.ts:6');
    expect(output).toContain('transaction.ts:7');
    expect(output).not.toContain('transaction.ts:2');
  });

  test('trata stake e payout como nomes monetários', () => {
    const { code, output } = runGuard('money-number', `${fixtures}money-number/fail`);

    expect(code).toBe(1);
    expect(output).toContain("wager.ts:2: campo monetário 'stake' tipado como number");
    expect(output).toContain("wager.ts:3: campo monetário 'payout' tipado como number");
  });

  test('passa com campos monetários string ou Money', () => {
    const { code } = runGuard('money-number', `${fixtures}money-number/pass`);

    expect(code).toBe(0);
  });
});

// AGENTS.md §2.10: integração usa PostgreSQL e SQS reais, sem mock.
describe('guarda integration-mocks', () => {
  test('falha com arquivo e linha de cada mock de banco ou fila', () => {
    const { code, output } = runGuard('integration-mocks', `${fixtures}integration-mocks/fail`);

    expect(code).toBe(1);
    expect(output).toContain('wallet.ts:2');
    expect(output).toContain('aws-sdk-client-mock');
    expect(output).toContain('wallet.ts:4');
    expect(output).not.toContain('wallet.ts:1');
  });

  test('passa com clientes reais e helpers de container', () => {
    const { code } = runGuard('integration-mocks', `${fixtures}integration-mocks/pass`);

    expect(code).toBe(0);
  });
});
