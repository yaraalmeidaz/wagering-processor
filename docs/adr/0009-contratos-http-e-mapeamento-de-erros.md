# ADR-0009: Contratos HTTP e mapeamento de erros

Status: aceita
Data: 2026-11-15

## Contexto
A SPEC 9.2 define o status HTTP de cada situação, e a SPEC 13 lista os endpoints. Faltam decisões que a camada HTTP precisa para existir: o corpo de cada resposta, o formato do erro, o valor do `Retry-After`, a paginação do ledger, o tratamento de identificador malformado na rota, os identificadores internos do `OPENING`, o mapeamento do conflito de CAS e o corpo da readiness. Dinheiro nunca é `number` (AGENTS.md §2.1), e HTTP e SQS usam o mesmo caso de uso (SPEC 5).

## Decisão
- **Status:** segue a tabela da SPEC 9.2, sem mapeamento novo para as situações que ela já cobre.
- **Dinheiro:** sempre `{ "amount": "<string decimal>", "currency": "<ISO-4217>" }`, na entrada e na saída (ADR-0002).
- **Corpo de erro:** `{ "code": "<CÓDIGO>", "message": "<texto>", "details"?: [...] }`. O `code` é um dos códigos da SPEC 9.2. Erro nunca traz `failureCode` (RN-40).
- **Transitório:** 503 `TRANSIENT_FAILURE` com `Retry-After: 1`, em segundos. O conflito de CAS da wallet (ADR-0003) é transitório pela SPEC 5.9 ("erro desconhecido: transitório por padrão") e também responde 503.
- **Payload inválido:** JSON malformado, corpo que não é objeto e UUID malformado na rota respondem 400 `INVALID_PAYLOAD`. A validação de negócio da entrada fica no caso de uso, para não duplicar lógica entre HTTP e SQS (CLAUDE.md, regra 4).
- **Idempotency-Key:** header obrigatório. Ausente ou vazio: 400 `MISSING_IDEMPOTENCY_KEY` (RN-23).
- **`POST /wagering/transactions`:** resposta `{ transactionId, status, failureCode, balance, idempotentReplay }`, em que `balance` é o `resulting_balance` da época (RN-20).
- **`POST /wallets`:** o servidor gera o `walletId`. Resposta 201 com a representação da wallet: `{ walletId, playerId, balance, version, createdAt, updatedAt }`. O `OPENING` interno, quando o saldo inicial é maior que zero (RN-04), usa `providerId = "internal"`, `externalTransactionId = "opening:{walletId}"`, `idempotencyKey = "internal:opening:{walletId}"`, `roundId = gameId = "opening"`, e `payloadHash` calculado como na SPEC 5.2.
- **`GET /wallets/:walletId/ledger`:** ordem do mais recente para o mais antigo, por `(created_at DESC, id DESC)`, a mesma ordem do índice `ix_ledger_wallet_cursor` (SPEC 12). `limit` padrão 50, aceito de 1 a 100. O cursor é opaco: base64url de `{ createdAt, id }` do último item da página. Cursor ou limit inválidos: 400 `INVALID_PAYLOAD`. Resposta `{ items, nextCursor }`, com `nextCursor` nulo na última página.
- **`GET /wagering/transactions/...`:** resposta com os campos da transação e o dinheiro como `{ amount, currency }`.
- **`POST /wallets/:walletId/reconciliation`:** 200 com os campos da RN-37. `storedBalance`, `calculatedBalance` e `difference` são dinheiro. `difference = storedBalance - calculatedBalance` e pode ser negativo. Divergência é registrada numa linha de log JSON e contada na métrica `reconciliation_divergences_total`, sem correção. A linha tem `timestamp`, `level`, `event: "reconciliation_divergence"`, `correlationId`, `walletId` e `result` com `consistent` e `checkedEntries`. Valores financeiros ficam fora do log (SPEC 14.1); quem investiga consulta o endpoint ou o ledger. A wallet é lida com `FOR UPDATE` na mesma transação da soma do ledger, para que uma escrita concorrente não produza divergência falsa entre as duas leituras (ADR-0003).
- **correlationId:** vem do header `X-Correlation-Id` quando ele tem de 1 a 128 caracteres de `[A-Za-z0-9._:-]`. Ausente ou fora desse formato, o servidor gera um UUID. O formato restrito impede que o header injete conteúdo no log. O header não é devolvido na resposta.
- **Erros do framework, fora da SPEC 9.2:** rota inexistente responde 404 `NOT_FOUND`, e acesso negado pelo `AuthGuard` (ADR-0008) responde 403 `FORBIDDEN`. Erro desconhecido responde 503 `TRANSIENT_FAILURE` (SPEC 5.9).
- **Readiness:** `GET /health/ready` responde 200 `{ status: "ok", checks: { postgres: "ok" } }`, ou 503 com `status: "unavailable"` e a verificação que falhou. O SQS entra na verificação com a mensageria.

## Alternativas consideradas
- **Validação da entrada também no DTO, com biblioteca de validação:** rejeitada porque duplicaria no HTTP a validação que o caso de uso já faz para HTTP e SQS (CLAUDE.md, regra 4), e acrescentaria uma dependência.
- **Paginação por offset no ledger:** rejeitada porque não é estável quando entram lançamentos novos, e a SPEC 13 pede cursor "opaco e estável".
- **404 para UUID malformado na rota:** rejeitada porque a requisição é inválida, não um recurso ausente. A SPEC 9.2 proíbe colapsar situações distintas no mesmo código.

## Consequências
- Ganho: o contrato fica previsível e não depende de detalhes do NestJS.
- Custo: os campos de cada resposta precisam ser mantidos junto com a SPEC 13.
- Risco residual: a métrica `reconciliation_divergences_total` continua em memória por processo. Cada instância conta só as próprias divergências, o valor zera no reinício e não há endpoint de coleta. A métrica completa do enunciado §12 (SPEC 14.2) fica para a Fase 9.
- Risco residual: nesta fase só o log de divergência é JSON. Os demais logs do NestJS seguem em texto até a Fase 9.

## Verificação
- `test/integration/http/wallets.http.test.ts` (existe): criação, duplicata, OPENING, consulta, ledger paginado (inclusive com `created_at` empatado), reconciliação sob `FOR UPDATE`, e a linha JSON da divergência com `correlationId`.
- `test/integration/http/wagering.http.test.ts` (existe): todos os status da SPEC 9.2 para `POST /wagering/transactions`, inclusive o replay de FAILED, e as consultas.
- `test/integration/http/health-and-auth.http.test.ts` (existe): readiness, liveness e AuthGuard só nos endpoints de negócio.
