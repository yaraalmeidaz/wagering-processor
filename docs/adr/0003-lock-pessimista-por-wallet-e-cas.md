# ADR-0003: Lock pessimista por wallet com lock_timeout, e CAS por version

Status: aceita
Data: 2026-11-15

## Contexto
A unidade de concorrência é a `walletId`, protegida por lock de linha, e não existe lock global (RN-31; SPEC 1.5; AGENTS.md §2.5). Nenhum saldo pode ser lido, calculado e escrito sem lock ou CAS (SPEC 1.6; AGENTS.md §2.6). O cenário obrigatório de duas `BET` de 80,00 sobre saldo de 100,00 deve terminar com um único débito (RN-32). A solução precisa ser correta com várias instâncias (AGENTS.md §2.9; SPEC 16.3).

## Decisão
O slow-path abre a transação com `SET LOCAL lock_timeout = '3000ms'` e `SET LOCAL statement_timeout = '5000ms'` (SPEC 5.3) e trava a wallet com `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` (SPEC 5.5). O lock de linha é mantido até o COMMIT ou ROLLBACK (SPEC 5.5). A atualização da wallet usa `WHERE id = $1 AND version = $v` como segunda barreira (SPEC 5.7 b). Falha por `55P03`, `40P01` ou `40001` é transitória: 503 com `Retry-After` na API, ou erro sem ack na fila (SPEC 5.9). O resolvedor de pendências segue a mesma ordem de lock do fluxo principal: primeiro a wallet com `FOR UPDATE`, depois a linha da pendência em `wager_transactions` com `FOR UPDATE SKIP LOCKED` (SPEC 8.2), o que evita deadlock entre os dois.

## Alternativas consideradas
- **Só CAS por `version`, sem lock (otimista):** rejeitado porque, sob contenção na mesma wallet, transforma colisões em retries, e o SPEC 5.5 exige repetir a busca idempotente sob o lock.
- **Lock global ou por tabela:** rejeitado pela RN-31 e pela invariante AGENTS.md §2.5.
- **Isolamento `SERIALIZABLE` sem lock explícito:** rejeitado porque o SPEC 5.5 define o lock de linha como mecanismo, e `40001` passaria a ser o caminho normal de conflito em vez de exceção transitória.

## Consequências
- Ganho: transações da mesma carteira são serializadas, e carteiras diferentes não se bloqueiam. A ordem `seq` do outbox depende disso (ADR-0006).
- Custo: espera de até 3 s por lock antes do 503.
- Consequência da ordem de lock do resolvedor: ele segura a wallet por mais tempo, desde antes de travar a pendência até o COMMIT. O `FOR UPDATE SKIP LOCKED` continua valendo para a linha da pendência em `wager_transactions`.

## Verificação
- `test/integration/use-cases/two-bets-80.test.ts` (existe): cenário da RN-32 (enunciado §8) com duas apostas em paralelo no mesmo processo, cada uma com o próprio fork do EntityManager.
- `test/concurrency/no-negative-balance.test.ts` (existe): 40 apostas em 4 processos sobre a mesma wallet. O saldo nunca fica negativo, e o ledger fecha com o saldo.
- `test/concurrency/same-bet-50x.test.ts` (existe): mesma aposta 50 vezes, em 5 processos, um débito (SPEC 15.3 a).
- `test/integration/use-cases/process-wager-transaction.test.ts` (existe): lock segurado por outra sessão por mais de 3 s gera `55P03` e `TransientFailureError` (AGENTS.md §9, caos).
