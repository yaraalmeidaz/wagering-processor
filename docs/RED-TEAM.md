# Red team de testes: fim de cada ciclo

## Objetivo

Verificar se a suíte de testes realmente pega defeitos. Um teste que passa com o código certo, mas também com o código errado, não protege nada. O red team injeta defeitos controlados no código e confere se algum teste falha.

Escopo: somente o código deste repositório, em ambiente local ou de CI. Não há alvo externo.

## Quando roda

Como passo final de cada ciclo, depois dos commits de código e antes do PR.

## Onde roda

Nunca na branch do ciclo. Use um worktree separado, para que nenhuma mutação possa vazar para um commit:

```bash
git worktree add ../rt-cNN HEAD
cd ../rt-cNN
```

Ao terminar, remova o worktree:

```bash
cd ..
git worktree remove rt-cNN
```

## Regras

1. Cada mutação altera um único ponto do código e é desfeita antes da próxima.
2. Depois de cada mutação, rode apenas os testes do ciclo, e depois a suíte completa se algum sobreviver.
3. Mutação sobrevivente vira teste novo que a mata, em commit próprio feito pelo autor: `test(redteam): ...`.
4. Mutação nunca é commitada. Antes de qualquer commit, `git diff` deve mostrar só testes.
5. Não afrouxe asserção para que uma mutação deixe de ser detectada.

## Catálogo de mutações (invariantes da seção 2 do AGENTS.md)

| # | Mutação | Teste que deve falhar |
|---|---|---|
| M01 | Money aceita `NaN` ou `Infinity` | C02, validação de entrada |
| M02 | Money arredonda em vez de rejeitar mais de 2 casas | C02, borda de escala |
| M03 | Remover `FOR UPDATE` no slow-path | C06, cenário 80 + 80 |
| M04 | Remover o re-check da idempotência sob o lock | C06, mesma chave em paralelo |
| M05 | Trocar `<` por `<=` na checagem de saldo suficiente | C03, saldo igual à aposta |
| M06 | Remover um dos 5 campos da validação de referência (ex.: `currency`) | C03, cada campo separadamente |
| M07 | Incluir `kind` no índice de reversão | C04, REFUND + ROLLBACK no mesmo BET |
| M08 | Remover trigger que bloqueia UPDATE no ledger | C04 |
| M09 | Replay retorna `wallet.balance` atual em vez de `resulting_balance` | C06, replay da época |
| M10 | Gravar o evento fora da transação | C09, evento invisível antes do commit |
| M11 | Ack do SQS antes do commit | C10, crash entre commit e ack |
| M12 | Versão da wallet incrementa em aposta de valor zero | C03 e C06, free spin |
| M13 | Gravar lançamento de valor zero | C06, free spin sem ledger |
| M14 | Remover `SET LOCAL lock_timeout` | C05 ou C06, espera limitada |
| M15 | Inbox inserido pelo consumer fora da transação do caso de uso | C10, crash entre inbox e commit |
| M16 | Emitir `WalletBalanceChanged` em LOSS | C06, evento correto por kind |
| M17 | Reversão de WIN que deixa saldo negativo retorna `INSUFFICIENT_FUNDS` | C06, código de falha distinto |
| M18 | Publisher sem lock por agregado | C09, dois publishers concorrentes |
| M19 | Chave idempotente sem comparação de hash | C06, payload divergente |
| M20 | Cursor do ledger sem desempate pelo `id` | C07, paginação com timestamps iguais |

Mutações M01 a M20 são obrigatórias. Uma mutação só pode ficar sem teste com justificativa escrita no PR e aprovação sua.

## Cenários adversariais por ciclo

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

- Todas as mutações M01 a M20 que se aplicam ao ciclo são detectadas.
- Nenhuma mutação sobrevivente sem teste novo ou justificativa aprovada.
- Cada cenário adversarial aplicável tem teste ou decisão documentada.
- Nenhuma mutação foi commitada: `git log` do ciclo mostra apenas `feat`, `fix`, `refactor`, `test`, `docs` e `db`, e `test(redteam)` só para testes novos.

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
