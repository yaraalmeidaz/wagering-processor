---
name: adr-decisao
description: Registra uma decisão de arquitetura, correção, schema, mensageria ou contrato como ADR em docs/adr/. Use sempre que uma mudança altere uma decisão já registrada, ou quando uma escolha técnica precisar ser justificada.
---

# ADR

Antes de codar uma mudança de decisão, escreva ou atualize a ADR. O código vem depois.

Arquivo: `docs/adr/NNNN-titulo-em-kebab-case.md`, com numeração sequencial de quatro dígitos.

Formato obrigatório:

```markdown
# ADR-NNNN: título

Status: proposta | aceita | substituída por ADR-XXXX
Data: AAAA-MM-DD

## Contexto
Problema e restrições. Cite a regra RN-NN, a seção do SPEC ou a seção do enunciado que motiva a decisão.

## Decisão
O que foi escolhido, em uma ou duas frases verificáveis.

## Alternativas consideradas
Pelo menos duas. Para cada uma, o motivo da rejeição.

## Consequências
Ganhos, custos e riscos residuais.

## Verificação
Qual teste prova a decisão. Use o nome do arquivo de teste.
```

Regras:
- Não apague ADR aceita. Para mudar a decisão, crie uma nova ADR e marque a antiga como substituída.
- Toda ADR nova entra no `ARCHITECTURE.md` na seção de decisões, no ciclo C13.
- Se a decisão afeta uma invariante da seção 2 do AGENTS.md, a ADR precisa de aprovação explícita antes de qualquer código.
