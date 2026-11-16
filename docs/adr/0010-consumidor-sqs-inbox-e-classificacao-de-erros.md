# ADR-0010: Consumidor SQS, inbox e classificação de erros

Status: aceita
Data: 2026-11-15

## Contexto
A entrada por fila usa o mesmo caso de uso da entrada HTTP (SPEC 5; enunciado §10). A SPEC 10 define as filas, o consumer, o retry e o SIGTERM, e a SPEC 9.1 define três classes de erro. Faltam decisões que o adapter precisa: o que entra no hash do inbox, o que fazer com o mesmo `messageId` e conteúdo diferente, como o inbox entra na transação do caso de uso, a classe do conflito de idempotência na fila, como a mensagem chega à DLQ, como a readiness verifica o SQS, como o CI roda o LocalStack e onde ficam as métricas da fase. A deduplicação por `(consumer_name, message_id)` precisa acontecer na mesma transação do efeito (enunciado §11; SPEC 5.7 d), e o ack só depois do COMMIT (SPEC 5.8; AGENTS.md §4).

## Decisão
- **Inbox na transação do efeito:** o consumer passa ao caso de uso a `InboxMessage` recebida. O caso de uso grava a linha, já processada, dentro da mesma unidade de trabalho do slow-path, qualquer que seja o resultado sob o lock (nova, replay, `PENDING_REFERENCE` ou rejeição). Se o trabalho falha, o ROLLBACK leva a linha junto. O replay pelo fast-path (SPEC 5.4) não abre escrita e não grava inbox: a reentrega cai no fast-path de novo, sem efeito.
- **Hash do inbox:** SHA-256 do JSON canônico do corpo inteiro da mensagem (`type`, `messageId`, `occurredAt`, `data`), com a mesma função da SPEC 5.2.
- **Leitura rápida (SPEC 10.2, passo 2):** linha processada com o mesmo hash: ack, sem chamar o caso de uso, e `messages_duplicate_total` + 1. Mesmo `messageId` com hash diferente: mensagem permanente, vai para a DLQ com motivo `INBOX_PAYLOAD_MISMATCH`, e a original recebe ack. Processar a segunda versão aplicaria um efeito que o produtor declarou como a mesma mensagem.
- **Classificação (SPEC 9.1; RN-33 a RN-35, RN-39):**

  | Resultado do caso de uso | Classe | Ação |
  |---|---|---|
  | Qualquer resultado devolvido (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay de `FAILED`) | Negócio, terminal | Ack (RN-33) |
  | JSON inválido, envelope fora do formato da SPEC 10.1, `InvalidInputError` do caso de uso | Malformada | DLQ e ack (RN-34) |
  | `IdempotencyConflictError` (409 na API) | Permanente | DLQ e ack. Repetir não muda o conflito. Interpretação |
  | `WalletNotFoundError` | Transitória | Sem ack (RN-39) |
  | `TransientFailureError`, `WalletVersionConflictError`, erro desconhecido | Transitória | Sem ack (SPEC 5.9) |

- **Retry transitório (SPEC 10.3; RN-35):** sem ack, com `ChangeMessageVisibility` para a espera da ADR-0007 calculada a partir de `ApproximateReceiveCount`, arredondada para cima em segundos. Esgotado `maxReceiveCount = 5`, o redrive do SQS move a mensagem para a DLQ.
- **DLQ explícita:** a mensagem malformada ou permanente é enviada para `wager-transactions-dlq.fifo` com o corpo original, o mesmo `MessageGroupId` e o atributo `dlqReason`. Só depois do envio confirmado a original recebe ack. Se o envio falha, não há ack, e a mensagem é tentada de novo.
- **Ordem dentro do lote:** as mensagens de um lote são processadas em sequência, para não inverter mensagens do mesmo `MessageGroupId`.
- **SIGTERM (SPEC 10.4):** o consumer para o polling, espera a mensagem em andamento por até 25 s, e devolve com `ChangeMessageVisibility(0)` toda mensagem recebida e não concluída.
- **Ganchos de teste:** o consumer aceita um gancho opcional chamado entre o COMMIT e o ack, e o publisher um gancho entre o ack do `SendMessage` e o COMMIT. Em produção ficam vazios. Os testes de queda usam os ganchos para matar o processo no ponto exato.
- **Filas:** no ambiente local, as filas da SPEC 10.1 são criadas por `scripts/localstack/create-queues.sh`, no init do LocalStack. Os testes criam filas próprias, com nome único e o mesmo redrive, pelo SDK, para não misturar mensagens entre arquivos.
- **Cliente SQS:** endpoint em `SQS_ENDPOINT` e região em `AWS_REGION`. Sem `AWS_ACCESS_KEY_ID`, e só quando há endpoint local, as credenciais são as de exemplo do LocalStack (`test`), que não são segredo.
- **Readiness:** `GET /health/ready` chama `GetQueueAttributes` na fila de entrada. Erro ou timeout: `sqs: "fail"` e 503.
- **CI:** os jobs `integration` e `concurrency` sobem o LocalStack em service container, com o token lido do secret `LOCALSTACK_AUTH_TOKEN` do repositório. Nenhum token entra em arquivo versionado.
- **Métricas da fase (enunciado §12; SPEC 14.2):** `messages_duplicate_total`, `messages_retried_total`, `messages_dead_lettered_total`, `outbox_published_total`, `outbox_publish_failures_total`, `outbox_retry_exhausted_total` e o gauge `outbox_lag_seconds`, em memória por processo.
- **Logs:** uma linha JSON por decisão do consumer e do publisher, com `event`, `messageId`, `correlationId` e, quando houver, `walletId` e `transactionId`. Nunca o payload financeiro (SPEC 14.1).

## Alternativas consideradas
- **Inbox gravado pelo consumer em transação própria, antes ou depois do caso de uso:** rejeitado. Antes do efeito, uma queda deixaria a mensagem marcada sem efeito. Depois, uma queda entre os dois commits reprocessaria a mensagem. É a mutação M15 do `docs/RED-TEAM.md`.
- **Mesmo `messageId` com hash diferente tratado como duplicata comum (ack):** rejeitado porque descartaria em silêncio uma mensagem diferente.
- **Conflito de idempotência como transitório:** rejeitado porque a mensagem voltaria cinco vezes sem chance de sucesso antes de chegar à DLQ.
- **Deixar todo erro permanente chegar à DLQ pelo redrive:** rejeitado porque a RN-34 pede o ack da original, e o redrive atrasaria a DLQ em cinco entregas.

## Consequências
- Ganho: a reentrega não duplica efeito, nem com o mesmo `messageId` e chave diferente, e o efeito e o inbox têm o mesmo destino.
- Custo: o caso de uso conhece a `InboxMessage` do domínio, embora o HTTP nunca a passe.
- Risco residual: as métricas são contadores em memória por processo. Cada instância conta só os próprios eventos, os valores zeram no reinício e não há endpoint de coleta. A métrica completa fica para a Fase 9.
- Risco residual: os logs do NestJS continuam em texto. Só o consumer, o publisher e a divergência de reconciliação escrevem JSON.
- Risco residual: o CI depende de o secret `LOCALSTACK_AUTH_TOKEN` estar cadastrado.

## Verificação
- `test/unit/domain/inbox-message.test.ts`.
- `test/integration/messaging/inbox.test.ts`: reentrega com um só efeito; mesmo `messageId` com outra chave sem segundo efeito; efeito que falha não deixa linha no inbox.
- `test/integration/messaging/sqs-consumer.test.ts` (LocalStack): ack depois do COMMIT, classificação de cada linha da tabela, DLQ explícita, redrive depois do limite, SIGTERM com visibilidade devolvida, referência ausente em `PENDING_REFERENCE`.
- `test/concurrency/consumer-crash.test.ts`: três consumers, um morto entre o COMMIT e o ack; a mensagem é reentregue e o efeito não duplica.
- `test/integration/http/health-and-auth.http.test.ts`: readiness com SQS inalcançável responde 503.
