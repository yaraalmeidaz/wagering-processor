# ADR-0005: Idempotência com fast-path terminal sem lock e slow-path sob lock

Status: aceita
Data: 2026-11-15

## Contexto
A idempotência é persistida no PostgreSQL e nunca depende de cache em memória (SPEC 1.3; AGENTS.md §2.3). Repetir a mesma chave com o mesmo hash devolve a resposta original, com o `resulting_balance` da época (RN-20). Mesma chave com hash diferente é conflito (RN-21), e o mesmo par `(providerId, externalTransactionId)` com chave diferente também (RN-22). A chave vem do header `Idempotency-Key` (RN-23), e o hash é SHA-256 de um JSON canônico dos campos de negócio (RN-24; SPEC 5.2). Uma busca sem lock não enxerga uma transação concorrente ainda não commitada, então duas requisições iguais podem colidir no INSERT (SPEC, decisão 5).

## Decisão
- **Fast-path sem lock (SPEC 5.4):** busca por `idempotency_key` ou por `(provider_id, external_transaction_id)`, sem `FOR UPDATE`. Se a linha está em estado terminal (`PROCESSED` ou `REJECTED`): com a mesma chave e o mesmo hash, é replay (RN-20), sem abrir transação de escrita; com hash diferente, `409 IDEMPOTENCY_PAYLOAD_MISMATCH` (RN-21); com chave diferente para o mesmo par, `409 IDEMPOTENCY_KEY_CONFLICT` (RN-22). Qualquer outro caso segue para o slow-path.
- **Slow-path (SPEC 5.5):** trava a wallet e repete a mesma busca sob o lock. Uma linha em `PENDING_REFERENCE` com a mesma chave e o mesmo hash responde 202 (SPEC 5.5; SPEC 9.2).
- **Replay de FAILED:** `FAILED` não entra no fast-path, que só responde `PROCESSED` e `REJECTED` (SPEC 5.4). Sob o lock, a mesma chave com o mesmo hash sobre uma transação `FAILED` é replay e responde 500 `TRANSACTION_FAILED`, sem `Retry-After` e sem `failureCode` (RN-40; SPEC 9.2). Não é 422, porque 422 é rejeição de negócio com `failureCode`, e `FAILED` é falha permanente de infraestrutura (RN-41); não é 503, porque 503 indica falha transitória com `Retry-After`, e repetir a requisição não muda um estado terminal.
- **Origem de FAILED:** a RN-41 não restringe o estado de origem de `FAILED`. `PENDING` e `PENDING_REFERENCE` podem ir para `FAILED` (RN-25; SPEC 3.3). Hoje só o resolvedor de pendências tem um caminho para `FAILED`, e `PENDING -> FAILED` fica reservada. O replay de `FAILED` não depende da origem. A restrição anterior ao resolvedor foi retirada porque o enunciado §6.3 define `FAILED` só como estado terminal, e a regra de origem não vinha dele.
- **Rede de segurança (SPEC 5.9):** `23505` nas unicidades de idempotência faz ROLLBACK, usa um novo `em.fork()`, lê a linha commitada, compara o hash e responde replay ou 409. Erro inesperado nunca confirma sucesso. O 500 é reservado ao replay de FAILED (ADR-0005).
- **Ordem de validação:** `CURRENCY_MISMATCH` e `WALLET_PLAYER_MISMATCH` (SPEC 4.3) são verificados antes da validação de referência (SPEC 4.2), porque não exigem leitura adicional.
- **BET ou LOSS com referência:** rejeitada com `REFERENCE_KIND_NOT_ALLOWED`, sem lançamento (RN-42), logo depois de `CURRENCY_MISMATCH` e `WALLET_PLAYER_MISMATCH` e antes da SPEC 4.2. O código já existe na SPEC 9.3 e diz o que aconteceu: o tipo não admite referência.
- **Referência de outro provider:** a referência é sempre buscada por `(providerId, referenceExternalTransactionId)` (RN-11). Uma transação de outro provider com o mesmo `externalTransactionId` não é encontrada, então a referência é tratada como inexistente: fica `PENDING_REFERENCE` (SPEC 4.2 a) e vira `REJECTED` com `REFERENCE_NOT_FOUND` depois do limite (RN-12; ADR-0007). `REFERENCE_CONTEXT_MISMATCH` (SPEC 4.2 c) fica para a referência do mesmo provider com player, wallet, moeda ou rodada diferentes (RN-14).
- **CURRENCY_MISMATCH sem snapshot:** a transação fica `REJECTED` com `resulting_balance` nulo. O motivo é o schema: `wager_transactions` tem uma só coluna `currency` para `amount` e `resulting_balance` (SPEC 12). O saldo da wallet está em outra moeda, e gravá-lo ali faria o valor ser relido na moeda errada. O replay responde `balance: null` pelo mesmo motivo. A resposta original não tinha snapshot, então o replay continua devolvendo a resposta da época (RN-20).
- **23505 no índice de reversão é rede de segurança (SPEC 6.3):** sob o lock da wallet, a validação f) da SPEC 4.2 rejeita a segunda reversão antes do INSERT, então esse 23505 não é o caminho normal. A proteção real é o índice `uq_wager_single_processed_reversal` (ADR-0004), testado em `test/integration/schema/reversal-unique-index.test.ts`. O tratamento no caso de uso (REJECTED com `REFERENCE_ALREADY_REVERSED`, em transação nova, sob o lock da wallet, sem retry) existe para o caso de a validação falhar, e não é exercitado por nenhum teste.

## Alternativas consideradas
- **Sempre travar a wallet, sem fast-path:** rejeitada porque todo replay pagaria o lock e disputaria a wallet com transações novas, embora o SPEC 5.4 permita responder o replay terminal sem escrita.
- **Fast-path também para `PENDING_REFERENCE`:** rejeitada porque o estado não é terminal e pode mudar a qualquer momento pelo resolvedor (SPEC 8.2). O SPEC 5.4 manda esse caso para o slow-path.
- **Cache em memória de chaves vistas:** rejeitada pela invariante AGENTS.md §2.3 e pelo SPEC 1.3. Não sobrevive a reinício e não é compartilhado entre instâncias.

## Consequências
- Ganho: o replay terminal não abre transação de escrita nem disputa o lock da wallet.
- Custo: a busca idempotente roda duas vezes no caminho de uma transação nova (antes e depois do lock).
- Risco residual: o fast-path lê sem lock e pode ver um estado que muda logo depois. Isso só é aceito porque ele responde apenas estados terminais, que não mudam (RN-25).

## Verificação
- `test/unit/domain/idempotency.test.ts` (existe): decisão entre replay, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `IDEMPOTENCY_KEY_CONFLICT` e seguir para o slow-path (RN-20 a RN-22; SPEC 15.1, "chave com payload divergente").
- `test/integration/use-cases/process-wager-transaction.test.ts` (existe): replay com o snapshot da época, conflitos 409, mesma chave em paralelo para wallets diferentes (23505 de idempotência), RN-42 e CURRENCY_MISMATCH com `balance: null`, também no replay.
- `test/concurrency/same-bet-50x.test.ts` (existe): mesma aposta 50 vezes, em 5 processos, gera um débito, com as demais respostas em replay (SPEC 15.3 a).
- `test/concurrency/sequential-replay.test.ts` (existe): replay sequencial em 3 processos devolve o saldo da época (RN-20).
- `test/integration/use-cases/locking-and-atomicity.test.ts` (existe): replay terminal e 409 pelo fast-path sem esperar o lock, e replay de `PENDING_REFERENCE` decidido pela releitura sob o lock em duas unidades de trabalho, sem depender do 23505.
  - O teste do replay de `PENDING_REFERENCE` observa o número de unidades de trabalho do caso de uso. É o único meio encontrado de detectar o 23505 extra quando a releitura sob o lock é removida (mutação M04 do `docs/RED-TEAM.md`): sem ela, o INSERT bate na unicidade, a SPEC 5.9 relê a linha e a resposta final fica igual.
  - O wrapper `CountingUnitOfWork` espia só a nossa porta `UnitOfWork`, delegando à implementação real. Não espiona o ORM, e o banco é o PostgreSQL real.
  - Isso é exceção à regra de não espionar colaboradores: o resultado observável é idêntico com e sem a releitura, porque a unicidade no banco cobre o caso (AGENTS.md §2.4). Só o fluxo distingue os dois.
- `test/integration/use-cases/process-wager-transaction.test.ts` (existe): WIN de outro provider com o mesmo `externalTransactionId` fica `PENDING_REFERENCE` (RN-11).
