# ADR-0002: Representação de Money (string decimal e NUMERIC(19,2))

Status: aceita
Data: 2026-11-15

## Contexto
Dinheiro nunca é `number`, `float` ou `double` (SPEC 1.1; AGENTS.md §2.1). Valores são strings decimais com exatamente 2 casas, e entradas inválidas são rejeitadas sem arredondar (RN-02; SPEC 1.2; AGENTS.md §2.2). Money é imutável e opera só com a mesma moeda (SPEC 3.1; RN-01). O SPEC 1.1 permite aritmética exata por "biblioteca decimal ou inteiros em centavos".

## Decisão
`Money` guarda `amount` como string decimal de escala 2 e `currency` ISO-4217, e é persistido em `NUMERIC(19,2)` com a moeda em coluna separada (SPEC 3.1; schema da seção 12). A conversão entre `NUMERIC` e `Money` acontece só nos mappers de persistência, sem passar por `number`.

A aritmética interna usa inteiros em centavos do tipo `bigint`, uma das duas opções do SPEC 1.1. A entrada e a saída continuam como string decimal de escala 2, e o valor máximo é o que cabe em `NUMERIC(19,2)`: 17 dígitos inteiros.

## Alternativas consideradas
- **`number` em JavaScript:** rejeitado pela invariante AGENTS.md §2.1 e listado como falha eliminatória (SPEC 16.3).
- **Coluna `bigint` em centavos:** rejeitada para a persistência porque o schema do SPEC 12 fixa `numeric(19,2)` em todas as colunas de valor, com `CHECK` sobre esses valores.
- **`float8` ou `real` no banco:** rejeitado pelo mesmo motivo de `number`. São tipos binários de ponto flutuante.
- **Biblioteca decimal para a aritmética interna:** rejeitada porque acrescenta uma dependência ao domínio, que deve ser TypeScript puro (SPEC 2.1). A guarda `domain-imports` rejeitaria o import. Com escala fixa de 2 casas, `bigint` em centavos já é exato.

## Consequências
- Ganho: igualdade e soma exatas, e o banco valida escala e não-negatividade (`CHECK`, SPEC 1.4).
- Custo: o driver do PostgreSQL precisa devolver `NUMERIC` como string, e isso precisa ser configurado e testado.
- Custo: toda conversão entre string e `bigint` passa por uma única função de parse no `Money`, que precisa ser testada nos limites (zero, máximo de 17 dígitos inteiros e formatos inválidos).
- Risco residual: a guarda `money-number` detecta só padrões textuais e tem limites conhecidos, listados no cabeçalho de `scripts/guards/money-number.ts`.

## Verificação
- `test/unit/guards/guards.test.ts` (existe): a guarda `money-number` falha com campo monetário tipado como `number`, `float` ou `double`.
- `test/unit/domain/money.test.ts`: escala, rejeição de `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, negativos e `"25"` (RN-02; SPEC 15.1).
- `test/integration/persistence/round-trip.test.ts`: `Money` → `NUMERIC(19,2)` → `Money` sem perda.
