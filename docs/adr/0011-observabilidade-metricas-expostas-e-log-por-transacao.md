# ADR-0011: Observabilidade com métricas expostas e log JSON por transação

Status: aceita
Data: 2026-11-16

## Contexto
O enunciado §12 marca como obrigatórios os logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, e as métricas de transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência de processamento (SPEC 14.1 e 14.2). O critério de saída da Fase 9 (SPEC, Parte 3) é "métricas da seção 14 expostas".

Hoje existem só as métricas do consumer, do publisher, do resolvedor e da reconciliação, em memória por processo e sem endpoint (riscos residuais da ADR-0009 e da ADR-0010). Faltam transações por status, conflitos de lock e latência, e o replay HTTP não conta como duplicata. O caminho HTTP não escreve log JSON por transação, e o filtro de erros escreve texto.

Restrições:
- HTTP e SQS chamam o mesmo caso de uso (AGENTS.md §4; CLAUDE.md, regra 4). A medição não pode ser duplicada nos dois adapters.
- A camada de aplicação não importa adapter concreto (AGENTS.md §3).
- Os testes sobem até 4 workers do mesmo tipo na mesma máquina (`test/concurrency/support`).
- Nenhum payload financeiro no log (SPEC 14.1; AGENTS.md §10).

## Decisão
- **Medição num decorator do caso de uso.** `InstrumentedProcessWager`, em `src/observability/`, implementa o mesmo contrato de `ProcessWagerTransaction.execute` e envolve a instância real. A raiz de composição da API e o processo do consumer injetam o decorator, de modo que HTTP e SQS passam pelo mesmo ponto de medição. O canal é `sqs` quando a entrada traz `inbox`, e `http` nos demais casos.
- **Métricas novas, em formato Prometheus:**

  | Métrica | Tipo | Rótulos | Quando |
  |---|---|---|---|
  | `wager_transactions_total` | contador | `channel`, `status` | resultado novo (`idempotentReplay: false`) |
  | `wager_idempotent_replays_total` | contador | `channel` | resultado com `idempotentReplay: true` |
  | `wager_idempotency_conflicts_total` | contador | `channel`, `code` | `IdempotencyConflictError` |
  | `wager_lock_conflicts_total` | contador | `channel`, `reason` | `TransientFailureError` com SQLSTATE `55P03` (`lock_timeout`), `40P01` (`deadlock`) ou `40001` (`serialization`), e `WalletVersionConflictError` (`version_conflict`) |
  | `wager_processing_duration_seconds` | histograma | `channel`, `outcome` (`result` ou `error`) | toda execução, medida com relógio monotônico |

  Buckets do histograma, em segundos: 0,005; 0,01; 0,025; 0,05; 0,1; 0,25; 0,5; 1; 2,5; 5. A ADR não afirma latência; os buckets só definem a resolução da medida (AGENTS.md §12).
- **Duplicatas detectadas** são a soma de duas métricas com significado distinto: `messages_duplicate_total` (inbox, sem chamar o caso de uso, ADR-0010) e `wager_idempotent_replays_total` (replay pelo caso de uso).
- **Métricas existentes** mantêm os nomes da ADR-0009 e da ADR-0010 e passam a ser exportadas no mesmo formato.
- **Interface `Metrics`** ganha rótulos, histograma e a renderização no formato de exposição de texto do Prometheus (versão 0.0.4). A implementação é própria, em memória, sem dependência nova.
- **Exposição:**
  - API: `GET /metrics`, sem `AuthGuard`, como os endpoints de health, com `Content-Type: text/plain; version=0.0.4`.
  - Workers: servidor `Bun.serve` em `127.0.0.1`, só quando a variável `METRICS_PORT` está definida, com a mesma rota. Sem a variável, o worker não abre porta. O servidor fecha no SIGTERM, antes do `process.exit`.
- **Log JSON por transação**, escrito pelo decorator, uma linha por execução:
  - `event: "wager_transaction_result"`, `level: "info"`, com `channel`, `correlationId`, `messageId` (só no canal `sqs`), `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`, `idempotentReplay` e `durationMs`;
  - `event: "wager_transaction_error"`, `level: "warn"` para conflito de idempotência, conflito de lock e payload inválido, `"error"` para os demais, com os mesmos identificadores disponíveis e o nome da classe do erro.
  - Ficam fora do log: `money`, saldo, `playerId` e o corpo da requisição.
- **Filtro de erros HTTP:** o erro inesperado passa a ser registrado em JSON (`event: "http_unexpected_error"`, com o nome da classe do erro), pelo mesmo `JsonLogger`, em vez do logger em texto do NestJS.

## Alternativas consideradas
- **Medir dentro de `ProcessWagerTransaction`, por uma porta de métricas:** rejeitada. Funciona, mas mistura observabilidade com a regra de idempotência num arquivo que é o núcleo financeiro, e cada mudança de métrica passaria pelo caso de uso. O decorator mede o mesmo ponto sem tocar a regra.
- **Medir nos adapters (controller e consumer):** rejeitada. A mesma contagem ficaria escrita duas vezes, contra a regra 4 do CLAUDE.md.
- **`prom-client`:** rejeitada nesta fase. Traz um registro global por processo, que vaza estado entre testes no mesmo processo, e a interface `Metrics` já existe e é usada pelos workers. O formato de texto exigido é pequeno e é coberto por teste. Pode ser revista se surgir necessidade de métricas de runtime.
- **OpenTelemetry com collector:** rejeitada. O enunciado §12 o trata como opcional, e exigiria um container a mais no compose.
- **Agregar as métricas no PostgreSQL:** rejeitada. Uma escrita extra no caminho quente de toda transação, só para somar contadores que o coletor (Prometheus) já soma por instância.
- **Porta fixa de métricas em cada worker:** rejeitada. Duas instâncias do mesmo worker na mesma máquina colidiriam na porta, e os testes de concorrência sobem várias.

## Consequências
- Ganho: as sete métricas da SPEC 14.2 existem e podem ser coletadas, e cada transação HTTP ou SQS deixa uma linha JSON com os identificadores da SPEC 14.1.
- Ganho: a medição fica num único ponto, compartilhado por HTTP e SQS.
- Custo: o controller e o consumer passam a depender de uma interface do caso de uso, e não da classe concreta, para aceitar o decorator.
- Risco residual: os valores continuam por processo e zeram no reinício. A agregação entre instâncias e a taxa sobre reinícios ficam a cargo do coletor, como é o modelo do Prometheus.
- Risco residual: `GET /metrics` fica aberto. Em produção, a proteção seria de rede, como nos endpoints de health (ADR-0008).
- Risco residual: o outbox lag é medido só pelo publisher. A API não expõe esse gauge.
- Risco residual: os logs de inicialização do NestJS continuam em texto.

## Verificação
- `test/unit/observability/prometheus-metrics.test.ts`: contador com rótulos, histograma com buckets cumulativos, `_sum` e `_count`, e escape de rótulos no formato de texto.
- `test/unit/observability/instrumented-process-wager.test.ts`: cada resultado e cada classe de erro incrementa a métrica certa com o canal certo, e a linha de log não contém `money`, saldo nem `playerId`.
- `test/integration/http/metrics.http.test.ts` (PostgreSQL e LocalStack reais): uma BET e seu replay alteram `wager_transactions_total` e `wager_idempotent_replays_total` em `GET /metrics`, sem autenticação; uma BET com a wallet presa por outra sessão incrementa `wager_lock_conflicts_total{reason="lock_timeout"}`.
- `test/integration/messaging/sqs-consumer.test.ts`: a mensagem processada pelo consumer conta com `channel="sqs"` e a linha de log traz o `messageId`.
- `test/unit/observability/metrics-server.test.ts`: sem `METRICS_PORT` não abre porta; valor inválido é erro; com a variável, responde `GET /metrics` e 404 fora da rota.
- `test/integration/workers/worker-metrics.test.ts`: os processos reais do publisher e do resolvedor respondem `GET /metrics` com `METRICS_PORT` e fecham a porta no SIGTERM, saindo com 0.
- `test/unit/observability/http-error-log.test.ts`: erro inesperado no HTTP responde 503 e escreve uma linha JSON só com o nome do erro.
- Sem teste de processo: a ligação do decorator em `sqs-consumer.main.ts`, que lê as filas fixas do ambiente.
