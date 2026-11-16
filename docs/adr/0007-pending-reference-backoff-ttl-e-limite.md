# ADR-0007: PENDING_REFERENCE com backoff, TTL e limite de tentativas

Status: proposta
Data: 2026-11-15

## Contexto
Um `REFUND`, `ROLLBACK` ou `WIN` pode chegar antes da transação que ele referencia. Se a referência não existe, a transação vira `PENDING_REFERENCE` e é reprocessada depois (RN-12; SPEC 4.2 a). O enunciado §7.1 pede backoff exponencial e deixa o limite e o TTL a cargo do candidato, com justificativa (RN-12). O reprocessamento é feito pelo resolvedor (SPEC 8.2), que grava `FAILED` quando encontra erro permanente de infraestrutura (RN-41).

O resolvedor roda em vários processos ao mesmo tempo e precisa tratar três situações além do caminho feliz: queda do banco no meio da tentativa, reversão concorrente que bate no índice único (RN-16; SPEC 6.3) e linha que o domínio não consegue aceitar.

## Decisão
- **Marcação (SPEC 8.1):** ao entrar em `PENDING_REFERENCE`, grava `next_reference_attempt_at` com a espera da tentativa 1 e `attempts = 0`, e publica `WagerTransactionPendingReference` (RN-29).
- **Backoff (SPEC 8.3; RN-12):** exponencial com base 2 s e fator 2, teto de 5 min e jitter de ±20%. O jitter é aplicado antes do teto, e o teto é absoluto: nenhuma espera passa de 5 min. A fórmula é `retryDelayMs` de `src/domain/retry-backoff.ts`, a mesma do outbox (ADR-0006).
- **Tentativa:** uma tentativa é uma execução do resolvedor que lê a linha vencida sob o lock da wallet e procura a referência. A tentativa n que não encontra a referência grava `attempts = n` e agenda a próxima com a espera da tentativa n + 1.
- **Limite (SPEC 8.4; RN-12):** 12 tentativas ou 24 h contadas a partir de `created_at`, o que vier primeiro. Uma tentativa é a última quando é a 12ª ou quando começa com 24 h ou mais desde `created_at`.
- **Última tentativa:** o resolvedor procura a referência como em qualquer tentativa. Se ela existe, a transação segue a validação normal (SPEC 4.2 b a g) e termina `PROCESSED` ou `REJECTED` com o código correspondente. Se não existe, vira `REJECTED` com `REFERENCE_NOT_FOUND`. O motivo é evitar rejeição falsa: com o worker parado por mais de 24 h, a referência pode ter chegado durante a parada, e rejeitá-la só porque o relógio passou da janela recusaria uma transação válida.
- **Esgotamento (SPEC 8.5):** `REJECTED` com `REFERENCE_NOT_FOUND` publica `WagerTransactionRejected` (RN-27) no outbox, na mesma transação. A transição é feita pelo mesmo caminho de regras do caso de uso da seção 5, sob lock da wallet.
- **Erro transitório** (`55P03`, `40P01`, `40001`, timeout ou conexão perdida): ROLLBACK, sem consumir tentativa. Para não repetir a mesma linha em seguida durante uma queda, o resolvedor adia a linha numa transação nova, com CAS em `attempts` e `next_reference_attempt_at`, para agora mais a espera da tentativa `attempts + 1`. Se o adiamento também falhar (banco fora), o processo espera antes da próxima busca, com o mesmo backoff sobre o número de buscas seguidas que falharam, e zera a contagem na primeira busca bem-sucedida.
- **23505 do índice de reversão (RN-16; SPEC 6.3):** outra reversão sobre a mesma referência foi processada entre a leitura e o commit. ROLLBACK e, em transação nova sob lock da wallet, `REJECTED` com `REFERENCE_ALREADY_REVERSED`, sem retry.
- **Erro permanente (RN-41):** SQLSTATE da classe 22 (dado inválido), da classe 23 exceto o 23505 do índice de reversão, e falha ao reidratar a linha ou a wallet. ROLLBACK e, em transação nova, `FAILED` sem `failureCode` (RN-40), sem retry.
  - Por que é infraestrutura e não negócio: a mensagem já passou pela validação de entrada (RN-34) quando a pendência foi criada, e toda rejeição de negócio é decidida pelo domínio com `failureCode` (RN-19). Um erro da classe 22 ou 23 no resolvedor quer dizer que a linha gravada, o schema ou o código discordam entre si, o que é defeito de dado ou de implementação. Nenhuma regra RN-NN descreve esse caso, repetir não muda o resultado e responder com um `failureCode` diria ao provedor que a aposta violou uma regra que ela não violou. `FAILED` deixa a linha auditável e o replay responde `500 TRANSACTION_FAILED` (RN-41; ADR-0005).
- **Worker (SPEC 8.2):** processo separado. Busca até 50 candidatas por vez e espera 1 s quando não há pendência vencida. Usa `em.fork()` por item (AGENTS.md §2.12). No SIGTERM, para de buscar, termina o item em andamento e sai. Não guarda estado em memória além da contagem de buscas que falharam.

## Alternativas consideradas
- **Pendência sem limite:** rejeitada porque uma referência que nunca chega deixaria a transação aberta para sempre, e o enunciado §7.1 exige definir limite e TTL (RN-12).
- **Intervalo fixo entre tentativas:** rejeitado porque o enunciado §7.1 pede backoff exponencial.
- **Rejeitar na hora quando a referência não existe:** rejeitada porque contraria a RN-12. A referência pode chegar fora de ordem (SPEC 2.5, fluxo C).
- **Rejeitar sem procurar a referência quando a janela de 24 h passou:** rejeitada porque produz rejeição falsa quando a referência chegou durante uma parada do worker.
- **Erro transitório consome tentativa:** rejeitada porque uma queda de alguns minutos esgotaria as 12 tentativas sem que a referência fosse procurada de fato.
- **Erro transitório sem adiamento:** rejeitada porque a linha continuaria vencida e seria repetida em cada busca durante a queda.
- **Dado inválido como `REJECTED`:** rejeitada pelos motivos da decisão de erro permanente.

## Consequências
- Ganho: referências fora de ordem são resolvidas sem intervenção, e o tempo em pendência é limitado.
- Ganho: uma parada longa do worker não rejeita transação cuja referência já chegou.
- Custo: um worker a mais (SPEC 2.6) e um índice parcial para as pendências (`ix_wager_pending_reference`, SPEC 12).
- Consequência do teto absoluto: perto do teto, o jitter só encurta a espera e nunca a alonga, então as esperas longas se concentram em até 5 min.
- Consequência do limite: pela soma das 12 esperas da fórmula (cálculo, não medição), o limite de tentativas chega antes das 24 h, em menos de uma hora. O TTL só decide quando o worker fica parado ou adia muitas vezes por erro transitório.
- Risco residual: depois de uma parada longa, a última tentativa pode processar uma transação com mais de 24 h. É a escolha deliberada da decisão de última tentativa.
- A justificativa dos valores vai para o `ARCHITECTURE.md` na fase de documentação (SPEC 8.4).

## Verificação
- `test/unit/helpers/clock-backoff-example.test.ts`: exemplo de `next_attempt_at` com base 2 s e fator 2 sobre relógio controlado, sem teto e sem jitter.
- `test/unit/domain/pending-reference-backoff.test.ts`: base, fator, teto, faixa do jitter, e a regra de última tentativa por limite de 12 e por TTL de 24 h com `FakeClock`.
- `test/unit/domain/wager-transaction.test.ts`: transições de `PENDING_REFERENCE` para `PROCESSED`, `REJECTED` e `FAILED`, e reagendamento sem mudar o status.
- `test/integration/persistence/pending-reference-queries.test.ts`: SQL da SPEC 8.2 contra o PostgreSQL, com `SKIP LOCKED` e o adiamento com CAS.
- `test/integration/use-cases/resolve-pending-reference.test.ts`: resolução, reagendamento, esgotamento com `REFERENCE_NOT_FOUND`, última tentativa que encontra a referência depois de 24 h, 23505 de reversão, `FAILED` e erro transitório sem consumir tentativa.
- `test/integration/workers/pending-reference-worker.test.ts`: worker com PostgreSQL e LocalStack, evento publicado só depois do commit e SIGTERM.
- `test/concurrency/reference-out-of-order.test.ts`: três resolvedores sobre a mesma pendência, um só efeito no saldo, e `ROLLBACK` sem `BET` expira como `REJECTED` com `REFERENCE_NOT_FOUND` (SPEC 15.3 g; Parte 3, Fase 7).
- `test/concurrency/pending-reference-restart.test.ts`: resolvedor morto antes e depois do commit, e reprocessamento pelos processos restantes.
