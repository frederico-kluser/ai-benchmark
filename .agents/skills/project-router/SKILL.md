---
name: project-router
description: Roteia TODA tarefa de implementação no repositório ai-benchmark para as skills de conhecimento e tarefa corretas ANTES de qualquer passo. Use sempre que o usuário pedir qualquer mudança, correção, feature, análise ou refactor neste codebase — mesmo que não mencione skills explicitamente. Carregue o conhecimento das skills relevantes antes de editar código.
metadata:
  version: 0.1.0
  type: router
---
# Project Router — ai-benchmark

Este repositório adota um sistema de *knowledge skills*: o conhecimento do projeto vive
em `.agents/skills/` e é injetado sob demanda, em vez de reler docs ou varrer o codebase.
Esta skill é o ponto de entrada — ela seleciona e encadeia as demais.

## Protocolo (execute ANTES de qualquer trabalho)
1. **Classifique a tarefa**: que parte toca (backend `src/`, frontend `web/`, dados, build), que
   tipo é (bug/feature/refactor/análise) e a complexidade.
2. **Consulte** `catalog.md` e selecione as skills de **conhecimento** + **tarefa** relevantes.
3. **Carregue o conhecimento** dessas skills ANTES de implementar (leia os `SKILL.md`; só abra
   `references/` quando precisar do detalhe).
4. **Monte a cadeia**: ordem dos passos e o que pode rodar em paralelo via subagentes (contexto
   isolado — não polua a sessão principal).
5. **Execute**. Para análise ampla/independente, despache subagentes `Explore`.
6. **Ao concluir**, garanta que toda skill de **tarefa** usada rodou seu passo `<evolution>`.

## Mapa rápido tarefa → skills
- Novo endpoint / mudança na API → `task-add-endpoint` + `knowledge-backend` (+ `knowledge-openrouter` se chamar modelo).
- Mudar o assistente Nova Run / seletor de modelo → `task-add-wizard-step` + `knowledge-frontend`.
- Mexer no pipeline de run/treino/juiz → `knowledge-benchmark-modes` + `knowledge-backend`.
- Conformidade/LGPD/filtro de modelos → `knowledge-lgpd-compliance`.
- Integração com OpenRouter (chamadas, cache, roteamento) → `knowledge-openrouter`.
- Qualquer dúvida de "onde fica X" → `knowledge-architecture`.
- Antes de dar a tarefa por concluída → `task-run-and-verify`.

## Regras
- Se **nenhuma** skill cobre a tarefa, invoque `meta-skill-evolution` para propor uma nova (não
  improvise conhecimento que deveria virar skill).
- Em ambiguidade entre skills, prefira a **mais específica** do domínio.
- `knowledge-code-style` aplica-se a praticamente toda edição de código — consulte por padrão.
- **Nunca** pule o passo `<evolution>` ao concluir uma tarefa.
