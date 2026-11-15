import { describe, expect, test } from 'bun:test';

// Guarda de AGENTS.md §12: desligar `strict` do TypeScript é proibido.
describe('toolchain', () => {
  test('tsconfig mantém strict e as checagens adicionais ligadas', async () => {
    const tsconfig: {
      compilerOptions: {
        strict?: unknown;
        noImplicitAny?: unknown;
        noUncheckedIndexedAccess?: unknown;
        useUnknownInCatchVariables?: unknown;
      };
    } = await Bun.file(new URL('../../tsconfig.json', import.meta.url)).json();
    const options = tsconfig.compilerOptions;

    expect(options.strict).toBe(true);
    expect(options.noImplicitAny).toBe(true);
    expect(options.noUncheckedIndexedAccess).toBe(true);
    expect(options.useUnknownInCatchVariables).toBe(true);
  });

  test('runtime é Bun 1.x', () => {
    expect(Bun.version.startsWith('1.')).toBe(true);
  });
});
