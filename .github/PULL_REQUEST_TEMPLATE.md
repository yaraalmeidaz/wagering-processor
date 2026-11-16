## Fase
Fase e branch. Exemplo: Fase 6, `feat/fase-06-mensageria`.

## O que muda
Uma ou duas frases.

## Por que
Cite a ADR ou a seção da SPEC que justifica a mudança.

## Invariantes preservadas (AGENTS.md seção 2)
- [ ] 1. Dinheiro sem number, float ou double
- [ ] 2. Money rejeita, não arredonda
- [ ] 3. Idempotência persistida no PostgreSQL, sem cache em memória
- [ ] 4. Constraints, trigger e índices no schema, não só no código
- [ ] 5. Concorrência por walletId com lock de linha, sem lock global
- [ ] 6. Nenhum saldo lido, calculado e escrito sem lock ou CAS
- [ ] 7. Evento publicado somente após o commit, gravado no outbox na mesma transação
- [ ] 8. Ledger append-only
- [ ] 9. Concorrência testada com 3 ou mais processos, quando aplicável
- [ ] 10. Testes de integração com PostgreSQL e LocalStack/MiniStack reais
- [ ] 11. Domínio sem imports de framework
- [ ] 12. em.fork() por iteração ou mensagem nos workers
- [ ] 13. Reversão única por referência (RN-16)
- [ ] 14. Replay retorna o snapshot da época, nunca o saldo atual (RN-20)
- [ ] 15. WalletBalanceChanged somente quando o saldo muda (RN-28)

## Testes
- [ ] Testes escritos antes da implementação (falharam antes)
- [ ] `bun run lint` verde
- [ ] `bun run typecheck` verde
- [ ] `bun run test` verde
- [ ] `bun run test:integration` verde (se aplicável)
- [ ] `bun run test:concurrency` verde (se aplicável)

## Red team
- Mutações testadas: X de Y
- Sobreviventes antes: N
- Testes adicionados: N
- Cenários adversariais cobertos: X de Y
- Pendências com justificativa: ...

## Docs
- [ ] ADR criada ou atualizada (se houve decisão)
- [ ] README ou ARCHITECTURE atualizados (se o comportamento mudou)
