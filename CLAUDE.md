@AGENTS.md

# Regras técnicas do projeto

1. Antes de alterar código, leia AGENTS.md, docs/REGRAS-DE-NEGOCIO.md e docs/SPEC.md. Em conflito, as regras de negócio vencem, e o conflito vira ADR.
2. Cite o identificador da regra de negócio nos testes, por exemplo `RN-16`. Não repita regra de negócio em comentários ou documentação. Aponte para o identificador.
3. Mudança de decisão exige ADR nova ou atualizada em docs/adr/ antes do código.
4. Não duplique lógica. Reutilize o que já existe. HTTP e SQS chamam o mesmo caso de uso.
5. Nenhum segredo, credencial ou dado sensível em arquivo versionado, log ou teste.
6. Nunca afirme que um teste passou sem mostrar a saída do comando.
7. Nunca afirme desempenho sem medição reproduzível no repositório.
8. SQL escrito deve ser executado contra o PostgreSQL do docker compose antes de ser dado como correto.
