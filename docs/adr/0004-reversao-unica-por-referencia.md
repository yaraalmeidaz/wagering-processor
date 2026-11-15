# ADR-0004: Reversão única por referência, sem kind no índice

Status: proposta
Data: 2026-11-15

## Contexto
O enunciado §7, regra 4, limita a reversão "pelo mesmo tipo de operação". Lido ao pé da letra, um `REFUND` e um `ROLLBACK` da mesma `BET` seriam ambos aceitos e creditariam o valor duas vezes: uma aposta de 25,00 geraria +50,00 (SPEC, decisão 1). Isso contraria a invariante global do enunciado §3, que proíbe duplicar créditos. O enunciado §7, último parágrafo, exige documentar a interpretação adotada. A RN-16 é a origem desta decisão e já registra o desvio.

## Decisão
Uma referência pode ser revertida no máximo uma vez, independentemente do tipo (`REFUND` ou `ROLLBACK`), e a segunda reversão é rejeitada com `REFERENCE_ALREADY_REVERSED` (RN-16). Este é um desvio intencional do enunciado §7, regra 4 (AGENTS.md §2.13). O banco garante a regra com o índice parcial (SPEC 6.2):

```sql
CREATE UNIQUE INDEX uq_wager_single_processed_reversal
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PROCESSED'
    AND kind IN ('REFUND', 'ROLLBACK')
    AND reference_external_transaction_id IS NOT NULL;
```

A chave não inclui `kind`. Se a transição para `PROCESSED` disparar o índice (`23505`), a transação vira `REJECTED` com `REFERENCE_ALREADY_REVERSED`, em transação nova, pelo caso de uso da seção 5, sob lock da wallet, com `WagerTransactionRejected` publicado (SPEC 6.3; RN-27).

## Alternativas consideradas
- **Índice com `kind` na chave (leitura literal do enunciado):** rejeitado porque permite `REFUND` e `ROLLBACK` sobre a mesma `BET`, com crédito duplicado (SPEC, decisão 1).
- **Garantir só no código, sem índice:** rejeitado pela invariante AGENTS.md §2.4 e pelo SPEC 1.4. A unicidade precisa viver no schema.
- **Índice sem filtro de `kind`:** rejeitado porque um `WIN` com referência ocuparia o slot de reversão, e o `WIN` não é reversão (RN-06; SPEC 6.2).

## Consequências
- Ganho: crédito duplicado por reversão fica impossível mesmo com várias instâncias, porque o banco é a última barreira.
- Custo: o comportamento difere da leitura literal do enunciado, e isso precisa constar no `ARCHITECTURE.md` (SPEC 16.2).
- Risco residual: a validação em memória (SPEC 4.2 f) e o índice precisam concordar. Uma divergência apareceria como `23505` frequente.

## Verificação
- `test/integration/schema/reversal-unique-index.test.ts` (a criar): `REFUND` e `ROLLBACK` processados sobre a mesma `BET` falham no índice (SPEC 15.2; Parte 3, Fase 2).
- `test/unit/domain/reference-validation.test.ts` (a criar): segunda reversão rejeitada com `REFERENCE_ALREADY_REVERSED`, e `WIN` com referência não ocupa o slot (RN-06, RN-16).
