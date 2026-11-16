# ADR-0008: Autenticação sem IdP, com AuthGuard no-op como ponto de extensão

Status: aceita
Data: 2026-11-15

## Contexto
A autenticação é decisão do candidato (enunciado §2). Se ela não for implementada, a decisão deve ser documentada no `ARCHITECTURE.md` e o código deve expor um ponto de extensão, como um `AuthGuard` no-op ou um `ProviderIdentityPort`. A identidade do provedor que vem na mensagem continua sujeita às validações de domínio (SPEC 13). `/health/live` e `/health/ready` respondem sem autenticação (SPEC 13; AGENTS.md §10).

## Decisão
Não implementar provedor de identidade (IdP). As rotas de negócio passam por um `AuthGuard` no-op, que aceita toda requisição e é o ponto onde uma autenticação real será ligada. As rotas de health ficam fora do guard. O `providerId` recebido continua validado pelas regras de domínio, como o contexto da referência (RN-14).

## Alternativas consideradas
- **API key por provedor:** rejeitada neste escopo porque exige cadastro, rotação e armazenamento seguro de segredos, sem regra de negócio que dependa disso. Continua possível atrás do mesmo guard.
- **JWT ou mTLS emitidos por um IdP:** rejeitada pelo mesmo motivo, com o custo adicional de operar ou simular um IdP no ambiente local.
- **Nenhum ponto de extensão:** rejeitada porque o SPEC 13 exige expor um, caso a autenticação não seja implementada.

## Consequências
- Ganho: o escopo fica na correção financeira, e ligar autenticação depois não exige mudar controllers nem casos de uso.
- Custo: qualquer cliente que alcance a API pode enviar transações. O serviço precisa ficar atrás de uma fronteira de rede confiável até a autenticação existir.
- Risco residual: o `providerId` não é autenticado. Um cliente pode se passar por outro provedor. As validações de domínio limitam o efeito, mas não o impedem.
- A limitação vai para o `ARCHITECTURE.md` (SPEC 13 e 16.2).

## Verificação
- `test/integration/health-live.test.ts` (existe): `/health/live` responde 200 sem credenciais.
- `test/integration/http/health-and-auth.http.test.ts`: as rotas de negócio passam pelo `AuthGuard` no-op, e as rotas de health ficam fora dele.
