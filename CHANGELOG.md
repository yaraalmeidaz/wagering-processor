# Changelog

## Não lançado

### Fases entregues

- Fase 0: base do projeto, lint, typecheck, guards e CI.
- Fase 1: domínio de dinheiro, carteira, transação e regras de referência, sem framework.
- Fase 2: schema do PostgreSQL com constraints, triggers e migrações.
- Fase 3: persistência com MikroORM, repositórios e unidade de trabalho.
- Fase 4: caso de uso de apostas com lock por wallet, CAS, idempotência e outbox na mesma transação.
- Fase 5: API HTTP de carteiras, apostas e consultas, com contratos de erro e health.
- Fase 6: mensageria com inbox, consumidor SQS, publisher do outbox e DLQ.
- Fase 7: resolvedor de PENDING_REFERENCE com backoff e limite.
- Fase 8: testes de concorrência com três instâncias HTTP reais.
- Fase 9: observabilidade com métricas da SPEC 14.2 expostas em `GET /metrics`, log JSON por transação e erro inesperado do HTTP em JSON (ADR-0011).
- Fase 10: documentação, ADRs, red team e README.
