# ADR-0001: ORM (MikroORM) e estratégia transacional

Status: proposta
Data: 2026-11-15

## Contexto
A stack obrigatória define MikroORM como ORM preferencial e pede justificativa (SPEC, "Stack obrigatória"; AGENTS.md §1). O fluxo de uma transação exige que transação, saldo, ledger, inbox e outbox sejam gravados numa única transação SQL (SPEC 5.3 a 5.8; RN-30), com `SET LOCAL lock_timeout` e `statement_timeout` (SPEC 5.3), `SELECT ... FOR UPDATE` na wallet (SPEC 5.5) e tratamento de `23505` com um novo `EntityManager` (SPEC 5.9). Os workers não podem deixar o Identity Map crescer entre iterações (SPEC 2.6; AGENTS.md §2.12). O domínio não pode importar o ORM (SPEC 2.1; AGENTS.md §2.11).

## Decisão
Usar MikroORM com PostgreSQL. Cada caso de uso roda numa única transação SQL aberta pela porta `UnitOfWork` (SPEC 2.2), e cada requisição, mensagem ou iteração de worker usa o seu próprio `em.fork()`. Entidades ORM e mappers ficam em `src/infrastructure/persistence/` (SPEC 2.3), e nenhum tipo do ORM cruza para o domínio.

## Alternativas consideradas
- **Outro ORM (TypeORM, Prisma):** rejeitado porque a stack obrigatória indica MikroORM como preferencial, e trocar exigiria justificar o desvio. O modelo de Unit of Work e Identity Map do MikroORM corresponde à porta `UnitOfWork` já prevista no SPEC 2.2.
- **SQL direto com o driver `pg`, sem ORM:** rejeitado porque transfere para o código o mapeamento e o controle de mudanças que o ORM já faz, e se afasta da stack preferencial. Continua permitido usar SQL explícito dentro dos repositórios, onde o SPEC exige (`FOR UPDATE`, advisory lock, `SET LOCAL`).
- **Um `EntityManager` global, sem `fork()`:** rejeitado pela invariante AGENTS.md §2.12. O Identity Map cresceria entre mensagens e reaproveitaria estado de transações anteriores.

## Consequências
- Ganho: uma transação por caso de uso, com fronteira explícita, e o mesmo caso de uso para HTTP e SQS (SPEC 5, "Não há caminho paralelo").
- Custo: mappers bidirecionais para cada entidade (SPEC 2.3).
- Risco residual: a compatibilidade do MikroORM com o Bun 1.x (decorators e `reflect-metadata`) ainda não foi verificada no repositório. Deve ser provada no primeiro teste de persistência.
- O `ARCHITECTURE.md` deve repetir a justificativa (SPEC 16.2).

## Verificação
- `test/unit/guards/guards.test.ts` (existe): a guarda `domain-imports` falha se `src/domain/` importar o MikroORM.
- `test/integration/persistence/unit-of-work.test.ts` (a criar): atomicidade de wallet, ledger, inbox e outbox na mesma transação (SPEC 15.2).
- `test/integration/persistence/round-trip.test.ts` (a criar): domínio → banco → domínio sem perda (SPEC, Parte 3, Fase 3).
