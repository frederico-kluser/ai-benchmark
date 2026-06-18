---
name: knowledge-benchmark-modes
description: Os três modos de benchmark do ai-benchmark (compare, variation, training), o conceito de "contestant" e o pipeline gerador→competidores→juiz. Use ao mexer em orchestrator/trainer/variator/datagen/competitor/judge, ao alterar RunConfig, ou ao trabalhar com placar, iterações e a tela de resultados.
metadata:
  version: 0.2.0
  type: knowledge
---
# Modos de benchmark — ai-benchmark

`RunConfig` é uma **union discriminada por `mode`** (`src/types.ts`). Os três modos compartilham
o pipeline, mas diferem no que é o "contestant".

## Pipeline (comum)
**Gerador** (`datagen.ts`) cria N cenários/perguntas a partir do `theme` → **Competidores**
(`competitor.ts`) respondem em paralelo → **Juiz(es)** (`judge.ts`) ranqueiam às cegas. O juiz é
**compacto**: 1 chamada por juiz devolve, por resposta, `{ranking, acceptable, motivo (<=1 frase)}`
— sem texto verboso. O antigo estágio `evaluator.ts` foi **removido e fundido no juiz** (2026-06-18).
Resultado: `scoreboard` por contestant + aceitabilidade.

## Execução paralela (desde 2026-06-18)
`runLoop` (`orchestrator.ts`) roda em 2 fases: (1) **pré-gera todos os cenários em paralelo**
(`Promise.all`); (2) **roda todas as etapas em paralelo** (`Promise.all`, cada uma isolada em
try/catch). O placar é aditivo (`applyScoreboard`), então a ordem de término não importa. A
concorrência real é gateada pelo **limitador global adaptativo** em `openrouter.ts` (ver
`knowledge-openrouter`); `saveRun` é throttled. **Múltiplos juízes** (`judgeModelIds: string[]`)
rodam **em paralelo** (sem cap local); o ranking final é o **consenso** (posição média entre juízes)
e a aceitabilidade é por **maioria**. O **placar é aditivo POR JUIZ** (cada juiz pontua seu próprio
ranking) — com 2 juízes e 3 competidores há até 6 pontuações/etapa. Cada juiz é **listwise** (1
chamada, ou 2 passes agregados por posição média quando `judgePasses=2`) — não mais pairwise O(N²). No
**training**, as iterações seguem sequenciais (dependência de dados), mas as etapas de cada
iteração paralelizam. Na UI, `RunView` mostra um visualizador de processo ao vivo enquanto roda e
revela placar/heatmap só ao terminar.

**Cópia client-side:** todo o pipeline (orchestrator/trainer/datagen/competitor/judge/evaluator/
variator) tem uma versão em `web/src/engine/` que roda no navegador (SPA estática). Mesma lógica —
sincronize os dois lados ao mexer. Ver `knowledge-architecture`.

## Contestant (`Contestant` em types.ts)
Competidor genérico com `id`, `label`, `modelId`, `systemPrompt?`, `techniqueId?`.
- **compare**: cada contestant é um modelo distinto (`id === modelId`, sem systemPrompt).
- **variation/training**: todos compartilham o **mesmo `modelId`**; diferem pelo `systemPrompt` (a variação testada).

## Os três modos
- **compare** (`POST /runs`): ≥2 `competitorModelIds`. Mesmas perguntas, ranking. Juiz e gerador não podem ser competidores.
- **variation** (`POST /runs`): 1 `contestantModelId` + variações de prompt. As variações vêm de **técnicas** (`techniqueIds`, otimização ligada → `variator.ts` reescreve via um modelo "optimizer") ou **manuais** (`manualVariants`). `basePrompt` opcional roda como controle. Juiz ≠ modelo sob teste (anti-viés).
- **training** (`POST /sessions`): como variation, porém **N `iterations`** encadeadas (`trainer.ts`) — a melhor variação de cada rodada evolui para a próxima. Sessão (`SessionRecord`) agrega as runs; `pinnedStages` congela os cenários após a iteração 0.

## Papéis de modelo numa run
`datagenModelId` (gerador), `judgeModelIds: string[]` (um ou mais juízes), e os competidores/contestant.
`optimizerModelId` default = `datagenModelId`. `judgePasses: 2` = duas ordens POR JUIZ (anti-viés de
posição). **Tipos de domínio (RunConfig/JudgeResult) vivem em TRÊS arquivos** que devem ficar em
sincronia: `src/types.ts`, `web/src/engine/types.ts` **e** `web/src/api.ts` (não só os dois últimos).

## Persistência e tempo real
Cada run vira `data/runs/<id>.json`; progresso por SSE (ver `knowledge-backend`). A tela
`RunView` consome o stream; `TrainingView` acompanha a sessão.
