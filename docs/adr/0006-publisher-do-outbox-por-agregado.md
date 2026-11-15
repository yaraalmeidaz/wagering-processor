# ADR-0006: Publisher do outbox por agregado

Status: proposta
Data: 2026-11-15

## Contexto
Todo evento é gravado no outbox na mesma transação do efeito e só é publicado depois do commit (RN-30; AGENTS.md §2.7). Todas as mensagens usam `MessageGroupId = walletId` (SPEC 10.1). Com vários publishers concorrentes, a ordem dos eventos de uma carteira pode se inverter (SPEC, decisão 13). A versão anterior do publisher filtrava `next_attempt_at` antes de ordenar, o que deixava um evento posterior sair antes de um anterior em backoff, e usava `hashtext(uuid)`, que não existe no PostgreSQL (AGENTS.md §13). A SPEC 11.3 descreve o publisher corrigido e aponta para esta ADR.

## Decisão
- **Agregado:** `aggregate_id` é o `walletId` da carteira afetada, em todos os eventos da SPEC 11.1. O agregado travado pelo publisher é o mesmo `MessageGroupId` da SPEC 10.1.
- **Ordem:** a coluna `seq bigserial` define a ordem dos eventos, sem desempate por `occurred_at` ou `id` (SPEC 11.3 e 12). O lock de linha da wallet dura até o COMMIT (SPEC 5.5; RN-31; ADR-0003). Por isso, as transações de uma carteira são serializadas, e o `seq` cresce na ordem de commit dentro da carteira.
- **Escolha do candidato:** para cada agregado, o publisher pega o pendente de menor `seq` e só então verifica `next_attempt_at`. Um agregado cujo pendente mais antigo está em backoff não publica nada (SPEC 11.3, passos 1 e 2b).
- **Exclusão entre publishers:** `pg_try_advisory_xact_lock(hashtext($1::text))`, com `$1 = aggregate_id`. O cast para `text` é obrigatório. A colisão de `hashtext` (int4) entre carteiras é tolerada: o único efeito é pular um agregado naquele ciclo, sem risco para a ordem (SPEC 11.3, passo 2a).
- **Confirmação:** `published_at` só é gravado depois do ack do `SendMessage`. A transação continua aberta durante a chamada ao SQS, e o advisory lock e o `FOR UPDATE` só são liberados no COMMIT (SPEC 11.3, passos 2c a 2e).
- **Índice:** `ix_outbox_pending ON outbox_messages (aggregate_id, seq) WHERE published_at IS NULL` (SPEC 12).

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
  - a garantia de ordem depende de todo INSERT no outbox de uma carteira acontecer sob o lock dessa carteira (SPEC 5.7 e, 6.3, 8.2 e 8.5);
  - o intervalo de backoff do outbox não está definido (SPEC 11.3, passo 2e, `$3`);
  - o SPEC não diz se `eventId` é o mesmo valor de `outbox_messages.id`;
  - a métrica de outbox lag (SPEC 11.4) não tem índice próprio.

## Verificação
SQL da SPEC 11.3 executado contra o PostgreSQL 16 do compose, com tabela temporária e `ROLLBACK`, na revisão da SPEC. Testes automatizados:
- `test/concurrency/outbox-two-publishers-order.test.ts` (a criar): dois publishers sobre o mesmo outbox publicam os eventos de cada carteira em ordem de `seq`, incluindo um evento anterior em backoff (SPEC 15.3 f; Parte 3, Fase 8).
- `test/integration/messaging/outbox-publisher.test.ts` (a criar, com LocalStack): `published_at` só é gravado depois do ack, falha no envio incrementa `attempts`, e a queda entre commit e publicação é recuperada por outra instância (SPEC 11.3 e 11.5).
