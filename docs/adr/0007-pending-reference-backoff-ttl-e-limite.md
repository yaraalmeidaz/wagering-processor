# ADR-0007: PENDING_REFERENCE com backoff, TTL e limite de tentativas

Status: proposta
Data: 2026-11-15

## Contexto
Um `REFUND`, `ROLLBACK` ou `WIN` pode chegar antes da transação que ele referencia. Se a referência não existe, a transação vira `PENDING_REFERENCE` e é reprocessada depois (RN-12; SPEC 4.2 a). O enunciado §7.1 pede backoff exponencial e deixa o limite e o TTL a cargo do candidato, com justificativa (RN-12). O reprocessamento é feito pelo resolvedor (SPEC 8.2), e `FAILED` só é gravado por ele (RN-41).

## Decisão
- **Marcação (SPEC 8.1):** ao entrar em `PENDING_REFERENCE`, grava `next_reference_attempt_at` e `attempts = 0`, e publica `WagerTransactionPendingReference` (RN-29).
- **Backoff (SPEC 8.3; RN-12):** exponencial com base 2 s e fator 2, teto de 5 min e jitter de ±20%. O jitter é aplicado antes do teto, e o teto é absoluto: nenhuma espera passa de 5 min.
- **Limite (SPEC 8.4; RN-12):** 12 tentativas ou 24 h contadas a partir de `created_at`, o que vier primeiro. A 12ª tentativa é a última executada.
- **Esgotamento (SPEC 8.5):** a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e publica `WagerTransactionRejected` (RN-27). A transição é feita pelo caso de uso da seção 5, sob lock da wallet, como o resolvedor da SPEC 8.2.

## Alternativas consideradas
- **Pendência sem limite:** rejeitada porque uma referência que nunca chega deixaria a transação aberta para sempre, e o enunciado §7.1 exige definir limite e TTL (RN-12).
- **Intervalo fixo entre tentativas:** rejeitado porque o enunciado §7.1 pede backoff exponencial.
- **Rejeitar na hora quando a referência não existe:** rejeitada porque contraria a RN-12. A referência pode chegar fora de ordem (SPEC 2.5, fluxo C).

## Consequências
- Ganho: referências fora de ordem são resolvidas sem intervenção, e o tempo máximo em pendência é limitado.
- Custo: um worker a mais (SPEC 2.6) e um índice parcial para as pendências (`ix_wager_pending_reference`, SPEC 12).
- Consequência do teto absoluto: perto do teto, o jitter só encurta a espera e nunca a alonga, então as esperas longas se concentram em até 5 min. A justificativa dos valores vai para o `ARCHITECTURE.md` (SPEC 8.4).

## Verificação
- `test/unit/helpers/clock-backoff-example.test.ts` (existe): exemplo de `next_attempt_at` com base 2 s e fator 2 sobre relógio controlado, sem teto e sem jitter.
- `test/unit/domain/pending-reference-backoff.test.ts` (a criar): base, fator, teto, faixa do jitter, limite de 12 tentativas e TTL de 24 h com `FakeClock`.
- `test/concurrency/reference-out-of-order.test.ts` (a criar): `ROLLBACK` antes da `BET` resolve quando a `BET` chega, e `ROLLBACK` sem `BET` expira como `REJECTED` com `REFERENCE_NOT_FOUND` (SPEC 15.3 g; Parte 3, Fase 7).
