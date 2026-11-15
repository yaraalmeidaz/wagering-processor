# Regras de negócio

Este é o único lugar onde as regras de negócio são definidas. Outros documentos apontam para cá e não repetem o texto.

Em caso de conflito com `SPEC.md` ou outro documento sobre uma regra de negócio, esta página vence. O conflito deve ser resolvido com uma ADR, não com uma exceção no código.

Cada regra tem um identificador estável (RN-NN). Testes e mensagens de commit devem citar o identificador da regra que implementam, por exemplo `Refs: RN-16`. Não reordene nem reutilize números. Regra revogada fica marcada como revogada.

Cada regra indica sua origem:

- **Enunciado §N:** o texto vem do desafio, na seção indicada.
- **Interpretação:** o enunciado não decide o caso. A escolha é documentada aqui e na ADR correspondente, como o enunciado exige na seção 7.

---

## Moeda, valor e wallet

**RN-01.** A moeda padrão é BRL e o modelo é multi-moeda. Operação com moeda diferente da wallet é rejeitada com `CURRENCY_MISMATCH`, sem lançamento.
*Origem: enunciado §6.1 (BRL, multi-moeda) e §6.2 (moeda da operação igual à da wallet).*

**RN-02.** Valores são strings decimais com exatamente 2 casas. Zero é válido. Negativo em entrada é inválido. NaN, Infinity, notação científica, string vazia e mais de 2 casas são rejeitados. Nunca arredondar. Uma entrada sem casas decimais, como `"25"`, também é rejeitada, sem normalização.
*Origem: enunciado §6.1 (escala fixa de 2 casas, rejeição de entradas inválidas). Rejeitar `"25"` é interpretação.*

**RN-03.** Só pode existir uma wallet por par (playerId, currency). Criar wallet duplicada falha com `409 WALLET_ALREADY_EXISTS`. O saldo nunca fica negativo. A versão começa em 1 após a criação e incrementa somente quando o saldo muda.
*Origem: enunciado §6.2 e §9 (criar wallet duplicada é conflito).*

**RN-04.** `OPENING` é um tipo interno. Não entra pela API nem pela fila: na API, a requisição é rejeitada com `400 INVALID_PAYLOAD`; na fila, a mensagem é malformada e vai para a DLQ. Quando o saldo inicial é maior que zero, a wallet e o `OPENING` são criados na mesma transação SQL, com um lançamento de crédito. A versão é 1 após o `OPENING`. A criação com saldo inicial maior que zero gera `WagerTransactionProcessed` e `WalletBalanceChanged` (`walletVersion = 1`), gravados no outbox na mesma transação. Com saldo zero, nenhum evento é gerado.
*Origem: enunciado §6.3 (OPENING é interno) e §9 (saldo inicial gera OPENING na mesma transação). A forma da rejeição e os eventos do OPENING são interpretação (ADR-0006).*

## Tipos de transação e efeito

**RN-05.** `BET` debita o valor. Se o saldo for menor que o valor, a transação é rejeitada com `INSUFFICIENT_FUNDS`. Quando aceita, gera um lançamento de débito.
*Origem: enunciado §7 (tabela).*

**RN-06.** `WIN` credita o valor e gera um lançamento de crédito. A referência é opcional e, se existir, só pode apontar para `BET` da mesma rodada. Valem as regras RN-11 a RN-14. Não valem RN-15 nem RN-16: o valor do `WIN` não precisa igualar o da `BET`, e `WIN` não é reversão. Sem referência, não há pendência.
*Origem: enunciado §7 (tabela: "pode referenciar a BET da mesma rodada"). A exclusão de RN-15 e RN-16 é interpretação.*

**RN-07.** `LOSS` não altera saldo e não gera lançamento. Ele é marcado como `PROCESSED`. O valor deve ser maior ou igual a zero e não tem efeito no saldo.
*Origem: enunciado §6.3 (`affectsBalance` é falso para LOSS) e §6.4 (operações sem efeito no saldo não geram lançamento).*

**RN-08.** `REFUND` credita o valor da `BET` referenciada. A referência é obrigatória e só pode apontar para `BET`.
*Origem: enunciado §7 (tabela e regras 1 e 3).*

**RN-09.** `ROLLBACK` aplica o efeito inverso da transação referenciada. A referência é obrigatória e pode apontar para `BET`, `WIN` ou `REFUND`.
*Origem: enunciado §7 (tabela e regras 1 e 3).*

## Valor zero

**RN-10.** Transações de valor zero (`BET`, `WIN`, `REFUND`, `ROLLBACK`) são aceitas. Ficam `PROCESSED`, não alteram o saldo, não incrementam a versão e não geram lançamento. Não geram `WalletBalanceChanged`, mas geram `WagerTransactionProcessed`. O saldo observado é gravado em `resulting_balance`.
*Origem: interpretação, consistente com o enunciado §6.2 (a versão muda só quando o saldo muda) e §6.4 (operação sem efeito não gera lançamento).*

## Referências

**RN-11.** A referência é resolvida por (providerId, referenceExternalTransactionId).
*Origem: enunciado §7 regra 2.*

**RN-12.** Se a referência não existe, a transação vira `PENDING_REFERENCE`. Ela é reprocessada com backoff exponencial (base 2 s, fator 2, teto 5 min, jitter de ±20%) até 12 tentativas ou 24 horas contadas a partir de `created_at`, o que vier primeiro. Esgotado o limite, vira `REJECTED` com `REFERENCE_NOT_FOUND`.
*Origem: enunciado §7.1 (backoff exponencial; limite e TTL definidos e justificados pelo candidato). Os valores são escolha minha, justificados em ARCHITECTURE.md.*

**RN-13.** Se a referência existe mas não está `PROCESSED`, a transação é rejeitada com `REFERENCE_NOT_PROCESSED`.
*Origem: interpretação. O enunciado trata só a referência ausente.*

**RN-14.** Jogador, wallet, rodada e moeda da referência devem ser iguais aos da transação atual. Caso contrário, rejeição com `REFERENCE_CONTEXT_MISMATCH`. O provider é filtro da busca da referência (RN-11), não checagem de contexto: referência de outro provider não é encontrada.
*Origem: enunciado §7 regra 2. Tratar o provider como filtro da busca, e não como campo de contexto, é interpretação (ADR-0005).*

**RN-15.** Para `REFUND` e `ROLLBACK`, o valor deve ser igual ao valor da referência. Reversão parcial está fora do escopo. Diferença gera `REFERENCE_AMOUNT_MISMATCH`.
*Origem: enunciado §7 regra 5.*

**RN-16.** Uma referência pode ser revertida no máximo uma vez, independentemente do tipo de reversão (`REFUND` ou `ROLLBACK`). `REFUND` e `ROLLBACK` sobre a mesma `BET` são mutuamente exclusivos. Se já existir reversão `PROCESSED` para a referência, a nova é rejeitada com `REFERENCE_ALREADY_REVERSED`.
*Origem: enunciado §7 regra 4 diz "pelo mesmo tipo de operação". Esta regra é mais estrita de propósito. Com a leitura literal, um `REFUND` e um `ROLLBACK` da mesma `BET` creditariam o valor duas vezes, o que contraria a invariante global do enunciado §3 ("não pode duplicar créditos"). O enunciado §7, último parágrafo, exige documentar essa interpretação. Registrada na ADR-0004.*

**RN-17.** Reversão que deixaria o saldo negativo é rejeitada com `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`. Esse código é diferente de `INSUFFICIENT_FUNDS`, porque são situações operacionais distintas. A transação fica registrada como `REJECTED`, sem lançamento.
*Origem: enunciado §7 regra 9.*

**RN-18.** Reversão parcial não existe neste escopo.
*Origem: enunciado §7 regra 5.*

**RN-42.** `BET` e `LOSS` não aceitam referência. Se chegarem com `referenceExternalTransactionId`, a transação é rejeitada com `REFERENCE_KIND_NOT_ALLOWED`, sem lançamento.
*Origem: interpretação. O enunciado §7 só prevê referência para `WIN`, `REFUND` e `ROLLBACK`, e não diz o que fazer com `BET` ou `LOSS` que chegam com uma. Registrada na ADR-0005.*

## Rejeição, replay e idempotência

**RN-19.** Rejeição de negócio é um resultado persistido: a transação fica `REJECTED` com `failureCode`. Não altera o saldo e não gera lançamento.
*Origem: enunciado §7 regra 6 e §7.2 (toda rejeição carrega failureCode).*

**RN-20.** Repetir uma transação com a mesma chave e o mesmo hash retorna a resposta original: status, `failureCode` e `resulting_balance` da época. Nunca retorna o saldo atual. A resposta traz `idempotentReplay: true`.
*Origem: enunciado §7 regra 7.*

**RN-21.** Mesma chave com hash diferente é conflito: `409 IDEMPOTENCY_PAYLOAD_MISMATCH`, nunca replay.
*Origem: enunciado §6.3 e §9 (mesma chave com payload diferente é conflito).*

**RN-22.** Mesmo par (providerId, externalTransactionId) com chave diferente é conflito: `409 IDEMPOTENCY_KEY_CONFLICT`.
*Origem: interpretação. O enunciado §9 define a chave, mas não o caso de chave diferente para o mesmo par.*

**RN-23.** A chave padrão é `{providerId}:{externalTransactionId}`. O header `Idempotency-Key` é obrigatório e é a fonte da verdade. Ausente, a resposta é `400 MISSING_IDEMPOTENCY_KEY`.
*Origem: enunciado §9 (idempotência).*

**RN-24.** O hash é SHA-256 sobre um JSON canônico, com chaves ordenadas, dos campos de negócio. Headers e metadados de transporte ficam de fora.
*Origem: enunciado §9 (payloadHash de JSON canônico; metadados de transporte fora do hash).*

## Estados

**RN-25.** Estados terminais são `PROCESSED`, `REJECTED` e `FAILED`. Transições válidas: `PENDING` vai para `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` ou `FAILED`. `PENDING_REFERENCE` vai para `PROCESSED`, `REJECTED` ou `FAILED`. Qualquer outra transição lança `InvalidTransactionStateError`: é erro de programação, não caminho de negócio.
*Origem: enunciado §6.3 (estados terminais; "defina e documente as transições válidas").*

**RN-41.** `FAILED` é gravado somente pelo resolvedor de pendências, quando ocorre erro permanente de infraestrutura depois que a transação já existe. O caminho da fila não usa `FAILED`.
*Origem: enunciado §6.3 define o estado. Quando ele é usado é interpretação.*

## Eventos

**RN-26.** `WagerTransactionProcessed` é publicado para toda transação aplicada, inclusive `LOSS` e valor zero.
*Origem: enunciado §11 (eventos mínimos).*

**RN-27.** `WagerTransactionRejected` é publicado para toda rejeição de negócio, inclusive `REFERENCE_NOT_FOUND`.
*Origem: enunciado §11 (eventos mínimos).*

**RN-28.** `WalletBalanceChanged` é publicado somente quando o saldo muda.
*Origem: enunciado §11 (eventos mínimos) e §15 (invariante de versão).*

**RN-29.** `WagerTransactionPendingReference` é publicado quando a transação entra em `PENDING_REFERENCE`.
*Origem: enunciado §11 (eventos mínimos).*

**RN-30.** Todo evento é gravado no outbox na mesma transação do efeito que o originou. Nenhum evento é publicado antes do commit.
*Origem: enunciado §5 restrição 4 e §11 (atomicidade).*

## Concorrência

**RN-31.** A unidade de concorrência é a `walletId`, protegida por lock de linha. Não existe lock global.
*Origem: enunciado §5 restrição 6 e §8.*

**RN-32.** Cenário obrigatório: saldo inicial de 100,00. Duas `BET` de 80,00 processadas ao mesmo tempo. Resultado: uma `PROCESSED`, uma `REJECTED` com `INSUFFICIENT_FUNDS`, saldo final de 20,00 e exatamente um lançamento de débito. Nenhum retry duplica o débito.
*Origem: enunciado §8 (cenário obrigatório).*

## Falhas de infraestrutura e mensageria

**RN-33.** Erro de negócio permanente: a transação é persistida como `REJECTED` e a mensagem recebe ack. Não há retry e não há DLQ.
*Origem: enunciado §10 (erros de negócio terminam com ack).*

**RN-34.** Mensagem malformada (schema inválido, `type` diferente de `WagerTransactionRequested`, ou `kind` `OPENING`) vai para a DLQ, e a mensagem original recebe ack.
*Origem: enunciado §10 (erros permanentes vão para a DLQ). A classificação de "malformada" é interpretação.*

**RN-35.** Erro transitório não faz ack. A mensagem volta à fila com backoff exponencial calculado a partir de `ApproximateReceiveCount`. Esgotado o `maxReceiveCount` (valor 5), a mensagem vai para a DLQ.
*Origem: enunciado §10 (retry com limite de tentativas antes da DLQ). O valor 5 é escolha minha.*

**RN-38.** Se o `playerId` da transação for diferente do `playerId` da wallet, a transação é rejeitada com `WALLET_PLAYER_MISMATCH`, sem lançamento.
*Origem: interpretação. O enunciado §9 liga a wallet a um `playerId`, mas não define o código dessa rejeição.*

**RN-39.** Wallet inexistente. Na API: `404 WALLET_NOT_FOUND`, nada gravado. Na fila: nada gravado, sem ack, reentrega com backoff; esgotado o `maxReceiveCount`, a mensagem vai para a DLQ. Não é possível gravar `REJECTED` sem wallet, porque `wager_transactions` tem chave estrangeira para `wallets`. A fila não descarta a mensagem, porque a wallet pode ser criada depois.
*Origem: interpretação, decorrente do enunciado §10 (recuperação após falhas) e do schema da §5 restrição 9.*

**RN-40.** `failureCode` existe só em transação `REJECTED` persistida. Erros que não produzem transação (400, 404, 409, 503) usam o código de status HTTP e um código de erro próprio, nunca `failureCode`.
*Origem: enunciado §7.2 (failureCode de rejeição) e §9 (taxonomia de status HTTP).*

## Ledger e reconciliação

**RN-36.** O ledger é append-only: um trigger bloqueia `UPDATE` e `DELETE`. Há no máximo um lançamento por par (wallet, transação). Em todo lançamento, saldo anterior mais ou menos o valor deve ser igual ao saldo posterior, verificado na factory e por `CHECK` no banco.
*Origem: enunciado §5 restrição 5, §6.4 (imutável, um lançamento por transação e wallet) e §5 restrição 9 (garantias no schema).*

**RN-37.** `POST /wallets/:walletId/reconciliation` não recebe corpo. O servidor soma créditos menos débitos do ledger, sem usar `balance_after`, e responde `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. Divergência não é corrigida automaticamente: é registrada em log, contabilizada em métrica e sinalizada com `consistent: false`.
*Origem: enunciado §9 (formato da resposta e "divergências não são corrigidas silenciosamente"). Não aceitar corpo é interpretação: aceitar saldos do cliente tornaria a reconciliação uma verificação falsa.*
