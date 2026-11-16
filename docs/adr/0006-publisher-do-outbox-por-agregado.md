# ADR-0006: Publisher do outbox por agregado

Status: aceita
Data: 2026-11-15

## Contexto
Todo evento é gravado no outbox na mesma transação do efeito e só é publicado depois do commit (RN-30; AGENTS.md §2.7). Todas as mensagens usam `MessageGroupId = walletId` (SPEC 10.1). Com vários publishers concorrentes, a ordem dos eventos de uma carteira pode se inverter (SPEC, decisão 13). A versão anterior do publisher filtrava `next_attempt_at` antes de ordenar, o que deixava um evento posterior sair antes de um anterior em backoff, e usava `hashtext(uuid)`, que não existe no PostgreSQL (AGENTS.md §13). A SPEC 11.3 descreve o publisher corrigido e aponta para esta ADR.

## Decisão
- **Agregado:** `aggregate_id` é o `walletId` da carteira afetada, em todos os eventos da SPEC 11.1. O agregado travado pelo publisher é o mesmo `MessageGroupId` da SPEC 10.1.
- **Ordem:** a coluna `seq bigserial` define a ordem dos eventos, sem desempate por `occurred_at` ou `id` (SPEC 11.3 e 12). O lock de linha da wallet dura até o COMMIT (SPEC 5.5; RN-31; ADR-0003). Por isso, as transações de uma carteira são serializadas, e o `seq` cresce na ordem de commit dentro da carteira.
- **Escolha do candidato:** para cada agregado, o publisher pega o pendente de menor `seq` e só então verifica `next_attempt_at`. Um agregado cujo pendente mais antigo está em backoff não publica nada (SPEC 11.3, passos 1 e 2b).
- **Exclusão entre publishers:** `pg_try_advisory_xact_lock(hashtext($1::text))`, com `$1 = aggregate_id`. O cast para `text` é obrigatório. A colisão de `hashtext` (int4) entre carteiras é tolerada: o único efeito é pular um agregado naquele ciclo, sem risco para a ordem (SPEC 11.3, passo 2a).
- **Confirmação:** `published_at` só é gravado depois do ack do `SendMessage`. A transação continua aberta durante a chamada ao SQS, e o advisory lock e o `FOR UPDATE` só são liberados no COMMIT (SPEC 11.3, passos 2c a 2e).
- **Backoff de envio:** falha ou timeout no `SendMessage` chama `OutboxMessage.scheduleRetry`, que incrementa `attempts` e calcula `next_attempt_at` com a fórmula da ADR-0007 (base 2 s, fator 2, jitter de ±20% antes do teto absoluto de 5 min), sobre o relógio injetado. O valor calculado é o `$3` da SPEC 11.3, passo 2e, gravado como instante e não como intervalo.
- **Esgotamento:** depois de 12 falhas o evento não é descartado nem marcado. Ele continua pendente e é tentado de novo no teto de 5 min. Cada falha a partir da 12ª gera uma linha de log JSON e incrementa `outbox_retry_exhausted_total`, para intervenção. Descartar perderia o evento, e os eventos seguintes da carteira ficariam presos atrás dele de qualquer forma.
- **eventId:** o `eventId` do envelope é o `outbox_messages.id` (SPEC 11.2), e é o `MessageDeduplicationId`.
- **Índice:** `ix_outbox_pending ON outbox_messages (aggregate_id, seq) WHERE published_at IS NULL` (SPEC 12).
- **Criação com saldo inicial maior que zero:** o `OPENING` gera `WagerTransactionProcessed` e `WalletBalanceChanged` (`walletVersion = 1`), gravados no outbox na mesma transação da wallet. Base: enunciado §11 (qualquer transação aplicada; saldo mudou), §6.3 (`OPENING` é transação interna de crédito) e §9 (criação com `OPENING` na mesma transação SQL), e RN-04, RN-26 e RN-28. Esta é a interpretação adotada, porque o enunciado não cita o `OPENING` na tabela de eventos.
- **Criação com saldo zero:** não há `OPENING` e não há evento.

## Alternativas consideradas
- **`FOR UPDATE SKIP LOCKED` por linha, sem lock por agregado:** rejeitado porque dois publishers poderiam pegar eventos diferentes da mesma carteira e publicá-los fora de ordem (SPEC, decisão 13).
- **Um único publisher, ou lock global de publicação:** rejeitado porque a solução precisa funcionar com várias instâncias (AGENTS.md §2.9) e um lock global serializaria carteiras independentes.
- **Ordenar por `(occurred_at, id)`:** rejeitado porque eventos da mesma transação podem ter o mesmo `occurred_at`, e o `id` é um uuid aleatório, o que deixa a ordem entre eles indefinida.
- **Forma de dois argumentos do advisory lock, com uma classe fixa para o outbox:** evitaria dividir o espaço de chaves com outros advisory locks, mas a SPEC 11.3 fixa a forma de um argumento. Fica como risco residual.

## Consequências
- Ganho: ordem por carteira com N publishers, e recuperação após queda entre commit e publicação (SPEC 11.5).
- Custo: a transação do publisher fica aberta durante a latência do `SendMessage`.
- Duplicata aceita: uma queda entre o ack e o COMMIT republica o evento. O SQS FIFO descarta a repetição dentro da janela de deduplicação de 5 minutos. Depois dela, o consumidor deduplica por `eventId` e, nos eventos de wallet, compara `walletVersion` (SPEC 11.2 e 11.3).
- Risco residual:
  - a garantia de ordem depende de todo INSERT no outbox de uma carteira acontecer sob o lock dessa carteira (SPEC 5.7 e, 6.3, 8.2 e 8.5) ou, na criação da wallet, antes de a linha dela ficar visível (SPEC 13, `POST /wallets`). O `POST /wallets` grava o `OPENING` na mesma transação (RN-04), sem `FOR UPDATE`, porque a linha da wallet ainda não existe. Nenhum outro evento da carteira pode ser gravado antes do COMMIT, porque a linha só fica visível depois dele. Nesse caso, a ordem `seq` depende da visibilidade do PostgreSQL, e não de um lock;
  - `next_attempt_at` é calculado com o relógio da aplicação, e a escolha do candidato compara com o `now()` do banco (SPEC 11.3, passos 1 e 2b). Uma diferença entre os dois relógios só antecipa ou atrasa uma nova tentativa, sem efeito na ordem;
  - a métrica de outbox lag (SPEC 11.4) não tem índice próprio e é um valor em memória por processo (ADR-0010);
  - um evento que falha para sempre bloqueia os eventos seguintes da carteira. É detectado pelo log e por `outbox_retry_exhausted_total`, não resolvido.

## Verificação
SQL da SPEC 11.3 executado contra o PostgreSQL 16 do compose, com tabela temporária e `ROLLBACK`, na revisão da SPEC. Testes automatizados:
- `test/unit/domain/outbox-message.test.ts`: backoff, teto, esgotamento e `isDue` com relógio controlado.
- `test/concurrency/outbox-publishers.test.ts`: três publishers em processos separados sobre o mesmo outbox publicam os eventos de cada carteira em ordem de `seq`, sem evento enviado duas vezes, e um agregado com o pendente mais antigo em backoff não publica nada (SPEC 15.3 f). O enunciado §13 item 6 pede dois publishers; três atendem a ele e à invariante de 3 ou mais processos (AGENTS.md §2.9).
- `test/integration/messaging/outbox-publisher.test.ts` (LocalStack): `published_at` só é gravado depois do ack, falha no envio agenda nova tentativa, e o advisory lock exclui um segundo publisher do mesmo agregado.
- `test/concurrency/publisher-restart.test.ts`: o publisher morre entre o ack do SQS e o COMMIT, outra instância assume, o evento é publicado e a duplicata não causa dano (SPEC 11.5).
