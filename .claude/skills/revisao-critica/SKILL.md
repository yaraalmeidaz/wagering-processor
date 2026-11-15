---
name: revisao-critica
description: Revisa criticamente um prompt, um passo ou uma alteração antes de executar, procurando contradições com o SPEC, SQL inválido, afirmações sem teste e riscos para as invariantes. Use antes de qualquer implementação e antes de aceitar uma entrega do agente.
---

# Revisão crítica

Antes de implementar, verifique o pedido contra o projeto. Não execute por obediência. Se encontrar um problema, pare e aponte, com a seção exata.

## Checklist antes de executar um passo

1. O pedido contradiz alguma invariante da seção 2 do AGENTS.md? Se sim, pare.
2. O pedido contradiz o docs/SPEC.md ou uma ADR aceita? Se sim, pare e diga qual.
3. Há SQL no pedido ou no SPEC? Valide a sintaxe contra o PostgreSQL do docker compose antes de usar. Não confie na memória.
4. Há afirmação de desempenho, "~X ms" ou "p99 de Y"? Não aceite sem medição reproduzível.
5. O passo cabe em um commit atômico? Se não, proponha a divisão.
6. Há dependência de passo anterior ainda não concluído? Se sim, pare.

## Checklist ao receber uma entrega do agente

1. Os testes foram executados de fato? Peça a saída. "Testes passam" sem saída não vale.
2. Algum teste foi enfraquecido, marcado como skip ou removido?
3. Algum `number` apareceu em valor monetário?
4. Alguma lógica está duplicada em HTTP e SQS, ou em dois lugares do domínio?
5. A entrega alterou algo fora do passo pedido?
6. A entrega contém afirmação que o código não prova? Liste essas afirmações.

## Formato da resposta

Liste os problemas por severidade: bloqueante, relevante ou cosmético. Cite arquivo e seção. Não suavize um bloqueante. Se nada for encontrado, diga que a revisão foi feita e quais itens foram verificados.
