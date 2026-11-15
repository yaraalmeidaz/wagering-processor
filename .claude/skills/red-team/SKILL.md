---
name: red-team
description: Testa a qualidade da suíte injetando defeitos controlados em worktree isolado. Use no fim de cada ciclo, ou quando o usuário pedir red team, mutation testing ou verificação de testes.
---

# Red team de testes

Siga docs/RED-TEAM.md. Resumo do procedimento:

1. Crie worktree separado: `git worktree add ../rt-<ciclo> HEAD`. Nunca trabalhe na branch do ciclo.
2. Para cada mutação do catálogo (M01 a M20) que se aplica aos arquivos alterados, aplique uma única mutação, rode os testes relevantes, registre o resultado e desfaça a mutação antes da próxima.
3. Liste os sobreviventes. Para cada um, escreva um teste que o mate.
4. Escreva apenas os testes novos ou ajustados. Não faça git add nem commit: o autor do projeto faz os commits, com a mensagem sugerida `test(redteam): <descrição>`. Nunca inclua mutação no diff.
5. Verifique os cenários adversariais aplicáveis e registre cobertura ou justificativa.
6. Remova o worktree com `git worktree remove`.
7. Entregue o relatório no formato da seção "Relatório no PR" de docs/RED-TEAM.md.

Regras:
- Não afrouxe asserção para que uma mutação deixe de ser detectada.
- Nos ciclos fora do núcleo financeiro, rode só as mutações que tocam os arquivos alterados. O catálogo completo roda em C06, C09, C10 e C12.
- Pare ao terminar. Não faça push nem merge.
