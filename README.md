# Distributed Wagering Processor

Serviço que processa transações de aposta de provedores de jogos (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) sobre carteiras de jogadores, uma por moeda. As transações entram por HTTP ou por uma fila SQS FIFO, e as duas entradas usam o mesmo caso de uso.

O serviço garante:
- **dinheiro exato:** string decimal de escala 2, nunca `number`;
- **idempotência persistida** no PostgreSQL;
- **concorrência serializada por carteira:** lock de linha mais CAS por versão;
- **ledger append-only;**
- **eventos publicados só depois do commit**, pelo outbox;
- **recuperação depois de queda** de processo ou de infraestrutura.

Documentos de referência:

| Documento | Conteúdo |
|---|---|
| [docs/REGRAS-DE-NEGOCIO.md](docs/REGRAS-DE-NEGOCIO.md) | Regras de negócio, identificadas como RN-NN |
| [docs/SPEC.md](docs/SPEC.md) | Arquitetura, fluxos, schema e contratos |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Visão geral, índice das ADRs, trade-offs e limitações |
| [docs/adr/](docs/adr/) | Decisões de arquitetura (ADR-0001 a ADR-0010) |
| [docs/RED-TEAM.md](docs/RED-TEAM.md) | Procedimento de mutation testing e registro por fase |
| [AGENTS.md](AGENTS.md) | Invariantes, convenções de git e definição de pronto |

## Pré-requisitos

- **Bun 1.x:** o `package.json` aceita `>=1.1.0 <2.0.0`.
- **Docker com o plugin Compose.**
- **Token de autenticação do LocalStack:** a imagem do `docker-compose.yml` exige `LOCALSTACK_AUTH_TOKEN`.

### Como obter o `LOCALSTACK_AUTH_TOKEN`

Sem o token, o `docker compose up` não sobe: o compose recusa iniciar o LocalStack com a variável vazia. Sem o LocalStack, as suítes `test:integration` e `test:concurrency` não rodam.

1. Crie uma conta gratuita no site do LocalStack. Segundo o LocalStack, o plano gratuito é para uso não comercial; confira as condições atuais na página de preços.
2. Copie o auth token nas configurações da conta.
3. Coloque o token na variável `LOCALSTACK_AUTH_TOKEN` do `.env`, criado a partir do `.env.example` (seção Configuração). O `.env` não é versionado: não commite o token.

## Configuração

Copie o exemplo e preencha os valores locais. O `.env` não é versionado.

```bash
cp .env.example .env
```

Variáveis do `.env.example`:

| Variável | Uso |
|---|---|
| `POSTGRES_DB` | Nome do banco |
| `POSTGRES_USER` | Usuário do PostgreSQL |
| `POSTGRES_PASSWORD` | Senha do PostgreSQL. Obrigatória: o compose não sobe sem ela |
| `POSTGRES_PORT` | Porta publicada em `127.0.0.1` |
| `LOCALSTACK_PORT` | Porta do LocalStack publicada em `127.0.0.1` |
| `LOCALSTACK_AUTH_TOKEN` | Token do LocalStack. Obrigatório: o compose não sobe sem ele |
| `AWS_REGION` | Região usada pelo cliente SQS e pelo LocalStack |
| `SQS_ENDPOINT` | Opcional, comentada no exemplo. Sem ela, o cliente SQS usa o LocalStack em `127.0.0.1` na `LOCALSTACK_PORT` (ADR-0010) |

O código também lê duas variáveis que não estão no exemplo:
- `POSTGRES_HOST`, que tem padrão `127.0.0.1`;
- `PORT`, a porta HTTP da API, que tem padrão `3000`.

## Subir o ambiente

Siga esta ordem:

```bash
# 1. Dependências, na versão exata do lockfile
bun install --frozen-lockfile

# 2. PostgreSQL 16 e LocalStack. As filas FIFO são criadas por
#    scripts/localstack/create-queues.sh quando o LocalStack fica pronto.
docker compose up -d

# 3. Schema
bun run db:migrate:up

# 4. API HTTP
bun src/main.ts

# 5. Workers, cada um em seu terminal ou processo
bun run worker:consumer
bun run worker:publisher
bun run worker:pending-reference
```

Para desfazer a migration: `bun run db:migrate:down`.

As filas criadas são:
- `wager-transactions.fifo`, a entrada;
- `wager-transactions-dlq.fifo`, a DLQ, com redrive em `maxReceiveCount` 5;
- `wager-events.fifo`, para os eventos do outbox.

O script de criação e `src/infrastructure/messaging/queues.ts` usam os mesmos valores, e `test/unit/messaging/queue-setup.test.ts` confere isso.

### API

| Rota | Uso |
|---|---|
| `GET /health/live` | Liveness, sem autenticação |
| `GET /health/ready` | Readiness: verifica PostgreSQL e SQS, sem autenticação |
| `POST /wallets` | Cria carteira, com `OPENING` interno quando o saldo inicial é maior que zero |
| `GET /wallets/:walletId` | Consulta a carteira |
| `GET /wallets/:walletId/ledger` | Ledger paginado por cursor |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo gravado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | Processa uma transação. Exige o header `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consulta por id |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |

Contratos e códigos de status: SPEC 9.2, SPEC 13 e ADR-0009.

**Código de saída no SIGTERM:** a API encerra, mas sai com código 143 (128 + 15, o número do SIGTERM), e não 0. O `main.ts` chama `enableShutdownHooks()`, e o NestJS, ao receber o sinal, fecha a aplicação e reenvia o mesmo sinal ao próprio processo. Os três workers saem com código 0 depois de terminar o item em andamento. Um orquestrador que espere código 0 da API vai registrar a saída como término por sinal (ARCHITECTURE.md, "Encerramento com SIGTERM").

### Workers

Os três workers são processos separados, e mais de uma instância de cada pode rodar ao mesmo tempo.

| Script | O que faz | SIGTERM |
|---|---|---|
| `worker:consumer` | Consome `wager-transactions.fifo` e chama o mesmo caso de uso do HTTP. Grava a inbox na transação do efeito e envia mensagem malformada ou permanente para a DLQ (SPEC 10; ADR-0010) | Para o polling, espera a mensagem em andamento e devolve as não concluídas com visibilidade 0 |
| `worker:publisher` | Publica o outbox em `wager-events.fifo`, um agregado por vez, sob advisory lock (SPEC 11.3; ADR-0006) | Termina o ciclo em andamento com COMMIT ou ROLLBACK |
| `worker:pending-reference` | Reprocessa transações `PENDING_REFERENCE` com backoff, limite de 12 tentativas e TTL de 24 h (SPEC 8; ADR-0007) | Para de buscar, termina o item em andamento e sai com código 0 |

## Testes e verificações

| Comando | O que roda | Precisa do compose |
|---|---|---|
| `bun run lint` | Biome: formatação e lint | Não |
| `bun run typecheck` | `tsc --noEmit` em modo estrito | Não |
| `bun run guards` | Guards de arquitetura: domínio sem framework, dinheiro sem `number`, integração sem mock | Não |
| `bun run test` | Testes unitários (`test/unit`) | Não |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais (`test/integration`) | Sim |
| `bun run test:concurrency` | Concorrência com 3 ou mais processos Bun reais (`test/concurrency`) | Sim |
| `bun run test:load` | Teste de carga (`test/load`). Opcional: a pasta ainda não tem testes, e o comando passa sem nenhum | Sim |

A ordem recomendada é a mesma dos estágios do CI: `lint` e `guards`, depois `typecheck`, `test`, `test:integration` e `test:concurrency`.

```bash
bun run lint
bun run guards
bun run typecheck
bun run test
bun run test:integration
bun run test:concurrency
```

Cada teste de integração e de concorrência cria um banco próprio no PostgreSQL do compose e filas próprias no LocalStack, e apaga tudo ao terminar.

Para corrigir formatação e lint automaticamente: `bun run lint:fix`.
