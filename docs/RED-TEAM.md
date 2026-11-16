# Red team de testes: fim de cada fase

## Objetivo

Verificar se a suíte de testes realmente pega defeitos. Um teste que passa com o código certo, mas também com o código errado, não protege nada. O red team injeta defeitos controlados no código e confere se algum teste falha.

Escopo: somente o código deste repositório, em ambiente local ou de CI. Não há alvo externo.

## Quando roda

Como passo final de cada fase, depois dos commits de código e antes do PR.

## Onde roda

Nunca na branch da fase. Use um worktree separado, para que nenhuma mutação possa vazar para um commit:

```bash
git worktree add ../rt-fase-NN HEAD
cd ../rt-fase-NN
```

O `.env` não é versionado e não vai para o worktree. Não o copie: os testes de integração leem o original com `bun --env-file=<caminho do .env do repositório> test ...`.

Ao terminar, remova o worktree:

```bash
cd ..
git worktree remove rt-fase-NN
```

## Regras

1. Cada mutação altera um único ponto do código e é desfeita antes da próxima.
2. Depois de cada mutação, rode apenas os testes da fase, e depois a suíte completa se algum sobreviver.
3. Mutação sobrevivente vira teste novo que a mata, em commit próprio feito pelo autor: `test(redteam): ...`.
4. Mutação nunca é commitada. Antes de qualquer commit, `git diff` deve mostrar só testes.
5. Não afrouxe asserção para que uma mutação deixe de ser detectada.

## Catálogo de mutações (invariantes da seção 2 do AGENTS.md)

| # | Mutação | Cenário que deve detectar |
|---|---|---|
| M01 | Money aceita `NaN` ou `Infinity` | Money: entrada com `NaN` ou `Infinity` é rejeitada |
| M02 | Money arredonda em vez de rejeitar mais de 2 casas | Money: valor com mais de 2 casas é rejeitado |
| M03 | Remover `FOR UPDATE` no slow-path | Caso de uso: duas apostas de 80,00 com saldo de 100,00 |
| M04 | Remover o re-check da idempotência sob o lock | Caso de uso: mesma chave em paralelo |
| M05 | Trocar `<` por `<=` na checagem de saldo suficiente | Wallet: aposta igual ao saldo |
| M06 | Remover um dos 5 campos da validação de referência (ex.: `currency`) | Regras de referência: cada campo do contexto separadamente |
| M07 | Incluir `kind` no índice de reversão | Schema: `REFUND` e `ROLLBACK` sobre a mesma `BET` |
| M08 | Remover trigger que bloqueia UPDATE no ledger | Schema: `UPDATE` e `DELETE` no ledger |
| M09 | Replay retorna `wallet.balance` atual em vez de `resulting_balance` | Caso de uso: replay devolve o saldo da época |
| M10 | Gravar o evento fora da transação | Outbox: evento invisível antes do commit |
| M11 | Ack do SQS antes do commit | Consumer SQS: queda entre o commit e o ack |
| M12 | Versão da wallet incrementa em aposta de valor zero | Wallet e caso de uso: aposta de valor zero |
| M13 | Gravar lançamento de valor zero | Caso de uso: valor zero sem lançamento |
| M14 | Remover `SET LOCAL lock_timeout` | Unidade de trabalho e caso de uso: espera de lock limitada |
| M15 | Inbox inserido pelo consumer fora da transação do caso de uso | Consumer SQS: queda entre a inbox e o commit |
| M16 | Emitir `WalletBalanceChanged` em LOSS | Caso de uso: evento correto por kind |
| M17 | Reversão de WIN que deixa saldo negativo retorna `INSUFFICIENT_FUNDS` | Caso de uso: código de falha distinto |
| M18 | Publisher sem lock por agregado | Publisher: dois ou mais publishers concorrentes |
| M19 | Chave idempotente sem comparação de hash | Caso de uso: payload divergente |
| M20 | Cursor do ledger sem desempate pelo `id` | HTTP: paginação do ledger com timestamps iguais |

Mutações M01 a M20 são obrigatórias. Uma mutação só pode ficar sem teste com justificativa escrita no PR e aprovação sua.

## Cenários adversariais por fase

Além das mutações, o agente escreve testes para estes cenários de ataque ao próprio sistema. Cada um precisa de teste ou de decisão documentada.

- **Replay em tempestade:** 50 requisições idênticas em paralelo. Nenhuma pode alterar saldo além da primeira.
- **Mesma chave, payload alterado:** qualquer campo de negócio muda, a resposta é 409.
- **Mesma (provider, external), chave diferente:** 409 `IDEMPOTENCY_KEY_CONFLICT`.
- **Referência de outro provider:** `REFERENCE_CONTEXT_MISMATCH`.
- **REFUND antes da BET:** `PENDING_REFERENCE`, depois resolve ou expira.
- **Valor com notação científica (`"1e3"`), 3 casas (`"25.001"`), negativo, espaços:** rejeição de entrada.
- **Moeda diferente da wallet:** `CURRENCY_MISMATCH`, sem lançamento.
- **Wallet inexistente:** 404 na API, nada gravado. Na fila, sem ack e sem gravar (RN-39).
- **Player diferente do da wallet:** WALLET_PLAYER_MISMATCH (RN-38).
- **Valor exatamente igual ao saldo:** aceito, saldo zero.
- **SIGKILL no meio da transação:** nada parcial no banco.
- **Restart do PostgreSQL durante processamento:** erro transitório, sem efeito parcial.
- **LocalStack indisponível:** readiness falha, nenhum evento perdido.
- **Entrega duplicada do SQS:** efeito único.
- **Mensagem com `messageId` repetido em consumidores diferentes:** deduplicação por `(consumer_name, message_id)`.

## Critério de saída

- Todas as mutações M01 a M20 que se aplicam à fase são detectadas.
- Nenhuma mutação sobrevivente sem teste novo ou justificativa aprovada.
- Cada cenário adversarial aplicável tem teste ou decisão documentada.
- Nenhuma mutação foi commitada: `git log` da fase mostra apenas `feat`, `fix`, `refactor`, `test`, `docs` e `db`, e `test(redteam)` só para testes novos.

## Relatório no PR

Cole no corpo do PR:

```markdown
## Red team
- Mutações testadas: X de Y
- Sobreviventes antes: N
- Testes adicionados: N (commits test(redteam))
- Cenários adversariais cobertos: X de Y
- Pendências com justificativa: ...
```

## Registro por fase

Números copiados da seção "Red team" do PR de cada fase. "Detectadas" conta o resultado final, depois dos testes `test(redteam)` escritos para as sobreviventes.

| Fase | Mutações | Detectadas | PR |
|---|---|---|---|
| 0. Base | não executado: infraestrutura, CI, guards e helpers de teste, sem lógica de domínio | não executado | #1 a #6 |
| 1. Domínio | não executado: ficou registrado como pendente no PR | não executado | #7, #8, #9 |
| 2. Schema | não executado nesta fase | não executado | #10 |
| 3. Persistência | não executado nesta fase | não executado | #11 |
| 4. Caso de uso | 16 | 16 | #12 |
| 5. HTTP | 20 | 20 | #13 |
| 6. Mensageria | 8 | 8 | #14 |
| 7. Pending reference | 7 | 7 | #15 |
| 8. Concorrência | 3 | 3 | esta PR |
| 9. Observabilidade | não executado: fase não implementada | não executado | não implementada |
| 10. Documentação | não executado: só documentação, sem código | não executado | #16 |

Sobreviventes na primeira rodada, todas mortas por teste novo antes do merge:
- **Fase 4:** 5 (a, b, c, g e M04).
- **Fase 5:** 3 (g, i2 e i3).
- **Fase 6:** nenhuma.
- **Fase 7:** 1 (R6: `FAILED` gravado dentro da transação que falhou).
- **Fase 8:** nenhuma.

Fase 8, red team do caminho de escrita da wallet com três instâncias HTTP reais (`test/concurrency/http-three-instances.test.ts`). Cada mutação rodou contra as suítes completas de concorrência e de integração:

| Mutação | Resultado |
|---|---|
| RT1. `findByIdForUpdate` sem `FOR UPDATE` | Detectada pelo cenário A: 4 respostas 201 e 56 respostas 503. O CAS manteve o ledger consistente, mas recusou a maior parte das apostas. Também falham 5 testes de concorrência e 5 de integração que dependem do lock |
| RT2. `UPDATE` da wallet sem CAS por `version` | Não detectada pelos testes de concorrência, porque o `FOR UPDATE` serializa a carteira e o CAS só atua se o lock faltar (ADR-0003). Detectada pela integração, em `wallet-cas.test.ts` |
| RT3. Sem `FOR UPDATE` e sem CAS | Detectada pelo cenário A: as 60 apostas de 3,00 receberam 201 sobre saldo de 100,00. O saldo gravado ficou 97,00 e o reconstruído pelo ledger, -80,00 |

Os cenários B (mesma chave nas três instâncias) e C (reversões concorrentes da mesma referência) passaram com as três mutações: a idempotência e a reversão única estão garantidas por unicidades do schema, não pelo lock da wallet (ADR-0004; ADR-0005).

Cobertura do catálogo M01 a M20. A correspondência foi feita pela descrição registrada em cada PR:
- **Fase 4:** M04, M09, M12, M13, M14, M16, M17 e M19.
- **Fase 5:** M20, o cursor sem desempate pelo `id`.
- **Fase 6:** M11, M15 e M18.
- **Fase 7:** M10, o evento fora da transação do efeito.
- **Fase 8:** M03, o `FOR UPDATE` removido do caminho de escrita.

Pendentes: M01, M02, M05, M06, M07 e M08. Elas tocam o domínio e o schema, que não tiveram red team nas Fases 1 e 2.
