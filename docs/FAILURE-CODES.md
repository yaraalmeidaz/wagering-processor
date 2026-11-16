# Códigos de falha

Um `failureCode` só existe numa transação `REJECTED`, que é uma rejeição de negócio persistida (RN-19, RN-40). A lista vem de `src/domain/failure-code.ts`, e a SPEC 9.3 é a referência.

**Resposta:**
- **HTTP:** toda rejeição responde `422`, com `status: "REJECTED"` e o `failureCode`, tanto na primeira vez quanto no replay (SPEC 9.2).
- **Fila:** a mensagem recebe ack, sem retry e sem DLQ (RN-33).

**Repetir não muda o resultado.** `REJECTED` é estado terminal:
- reenviar a mesma requisição, com a mesma `Idempotency-Key` e o mesmo payload, devolve a mesma rejeição como replay (RN-20);
- reenviar com a mesma chave e o payload corrigido é conflito, `409 IDEMPOTENCY_PAYLOAD_MISMATCH` (RN-21).

Por isso nenhum `failureCode` pede "reenviar". Corrigir o payload significa mandar uma transação nova, com outro `externalTransactionId` e outra chave.

| Código | Significado | O que o provedor deve fazer | HTTP |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo da wallet (RN-05). | Desistir. Uma nova aposta só faz sentido como transação nova, quando houver saldo. | 422 |
| `CURRENCY_MISMATCH` | Moeda da operação diferente da moeda da wallet (RN-01). | Corrigir o payload: usar a moeda da wallet, em transação nova. | 422 |
| `WALLET_PLAYER_MISMATCH` | O `playerId` da transação não é o dono da wallet (RN-38). | Corrigir o payload: `playerId` e `walletId` do mesmo jogador, em transação nova. | 422 |
| `REFERENCE_NOT_FOUND` | A referência não chegou dentro do limite de 12 tentativas ou 24 h (RN-12). A referência de outro provider também não é encontrada (RN-11). | Desistir. Se o `referenceExternalTransactionId` estava errado, corrigir o payload em transação nova. | 422 |
| `REFERENCE_NOT_PROCESSED` | A referência existe, mas não está `PROCESSED` (RN-13). | Desistir: não há o que reverter ou referenciar. | 422 |
| `REFERENCE_CONTEXT_MISMATCH` | Jogador, wallet, rodada ou moeda da referência diferentes da transação (RN-14). | Corrigir o payload: o mesmo contexto da referência, em transação nova. | 422 |
| `REFERENCE_KIND_NOT_ALLOWED` | O tipo da referência não é aceito pelo `kind`, ou é `BET` ou `LOSS` com referência (RN-06, RN-08, RN-09, RN-42). | Corrigir o payload: o `kind` ou a referência, em transação nova. | 422 |
| `REFERENCE_AMOUNT_MISMATCH` | `REFUND` ou `ROLLBACK` com valor diferente do da referência. Não há reversão parcial (RN-15). | Corrigir o payload: o valor da referência, em transação nova. | 422 |
| `REFERENCE_ALREADY_REVERSED` | A referência já tem uma reversão `PROCESSED`, de qualquer tipo (RN-16; ADR-0004). | Desistir: a reversão já foi aplicada. | 422 |
| `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` | A reversão deixaria o saldo negativo. É diferente de `INSUFFICIENT_FUNDS` (RN-17). | Desistir. É uma situação operacional e precisa de análise fora do fluxo automático. | 422 |

## Respostas sem `failureCode`

Estas respostas não são rejeição de negócio e não carregam `failureCode` (RN-40). Estão aqui para separar o que se reenvia do que se corrige (SPEC 9.2; ADR-0009).

| Resposta | O que o provedor deve fazer |
|---|---|
| `202` com `status: "PENDING_REFERENCE"` | Esperar. O resolvedor reprocessa a transação (ADR-0007), e o resultado pode ser consultado em `GET /wagering/transactions/:transactionId`. |
| `400 INVALID_PAYLOAD` | Corrigir o payload. |
| `400 MISSING_IDEMPOTENCY_KEY` | Corrigir: enviar o header `Idempotency-Key`. |
| `409 IDEMPOTENCY_PAYLOAD_MISMATCH` | Corrigir: a chave já foi usada com outro payload. Usar outra chave para uma transação nova. |
| `409 IDEMPOTENCY_KEY_CONFLICT` | Corrigir: o par `providerId` e `externalTransactionId` já foi usado com outra chave. |
| `503 TRANSIENT_FAILURE` | Reenviar a mesma requisição, com a mesma chave, depois do `Retry-After`. É seguro, porque a idempotência devolve o resultado original se a primeira tentativa tiver sido aplicada. |
| `500 TRANSACTION_FAILED` | Desistir e abrir análise. A transação está `FAILED`, uma falha permanente de infraestrutura (RN-41). |
