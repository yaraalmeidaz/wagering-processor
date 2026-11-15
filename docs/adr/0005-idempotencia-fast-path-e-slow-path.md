# ADR-0005: Idempotência com fast-path terminal sem lock e slow-path sob lock

Status: proposta
Data: 2026-11-15

## Contexto
A idempotência é persistida no PostgreSQL e nunca depende de cache em memória (SPEC 1.3; AGENTS.md §2.3). Repetir a mesma chave com o mesmo hash devolve a resposta original, com o `resulting_balance` da época (RN-20). Mesma chave com hash diferente é conflito (RN-21), e o mesmo par `(providerId, externalTransactionId)` com chave diferente também (RN-22). A chave vem do header `Idempotency-Key` (RN-23), e o hash é SHA-256 de um JSON canônico dos campos de negócio (RN-24; SPEC 5.2). Uma busca sem lock não enxerga uma transação concorrente ainda não commitada, então duas requisições iguais podem colidir no INSERT (SPEC, decisão 5).

## Decisão
- **Fast-path sem lock (SPEC 5.4):** busca por `idempotency_key` ou por `(provider_id, external_transaction_id)`, sem `FOR UPDATE`. Se a linha está em estado terminal (`PROCESSED` ou `REJECTED`): com a mesma chave e o mesmo hash, é replay (RN-20), sem abrir transação de escrita; com hash diferente, `409 IDEMPOTENCY_PAYLOAD_MISMATCH` (RN-21); com chave diferente para o mesmo par, `409 IDEMPOTENCY_KEY_CONFLICT` (RN-22). Qualquer outro caso segue para o slow-path.
- **Slow-path (SPEC 5.5):** trava a wallet e repete a mesma busca sob o lock. Uma linha em `PENDING_REFERENCE` com a mesma chave e o mesmo hash responde 202 (SPEC 5.5; SPEC 9.2).
- **Replay de FAILED:** `FAILED` não entra no fast-path, que só responde `PROCESSED` e `REJECTED` (SPEC 5.4). Sob o lock, a mesma chave com o mesmo hash sobre uma transação `FAILED` é replay e responde 500 `TRANSACTION_FAILED`, sem `Retry-After` e sem `failureCode` (RN-40; SPEC 9.2). Não é 422, porque 422 é rejeição de negócio com `failureCode`, e `FAILED` é falha permanente de infraestrutura (RN-41); não é 503, porque 503 indica falha transitória com `Retry-After`, e repetir a requisição não muda um estado terminal.
- **Rede de segurança (SPEC 5.9):** `23505` nas unicidades de idempotência faz ROLLBACK, usa um novo `em.fork()`, lê a linha commitada, compara o hash e responde replay ou 409. Erro inesperado nunca confirma sucesso. O 500 é reservado ao replay de FAILED (ADR-0005).
- **Ordem de validação:** `CURRENCY_MISMATCH` e `WALLET_PLAYER_MISMATCH` (SPEC 4.3) são verificados antes da validação de referência (SPEC 4.2), porque não exigem leitura adicional.

## Alternativas consideradas
- **Sempre travar a wallet, sem fast-path:** rejeitada porque todo replay pagaria o lock e disputaria a wallet com transações novas, embora o SPEC 5.4 permita responder o replay terminal sem escrita.
- **Fast-path também para `PENDING_REFERENCE`:** rejeitada porque o estado não é terminal e pode mudar a qualquer momento pelo resolvedor (SPEC 8.2). O SPEC 5.4 manda esse caso para o slow-path.
- **Cache em memória de chaves vistas:** rejeitada pela invariante AGENTS.md §2.3 e pelo SPEC 1.3. Não sobrevive a reinício e não é compartilhado entre instâncias.

## Consequências
- Ganho: o replay terminal não abre transação de escrita nem disputa o lock da wallet.
- Custo: a busca idempotente roda duas vezes no caminho de uma transação nova (antes e depois do lock).
- Risco residual: o fast-path lê sem lock e pode ver um estado que muda logo depois. Isso só é aceito porque ele responde apenas estados terminais, que não mudam (RN-25).

## Verificação
- `test/unit/domain/idempotency.test.ts` (a criar): decisão entre replay, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `IDEMPOTENCY_KEY_CONFLICT` e seguir para o slow-path (RN-20 a RN-22; SPEC 15.1, "chave com payload divergente").
- `test/concurrency/same-bet-50x.test.ts` (a criar): mesma aposta 50 vezes em paralelo gera um débito, com as demais respostas em replay (SPEC 15.3 a).
