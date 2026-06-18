---
name: knowledge-benchmark-modes
description: Os três modos de benchmark do ai-benchmark (compare, variation, training), o conceito de "contestant" e o pipeline gerador→competidores→juiz. Use ao mexer em orchestrator/trainer/variator/datagen/competitor/judge, ao alterar RunConfig, ou ao trabalhar com placar, iterações e a tela de resultados.
metadata:
  version: 0.1.0
  type: knowledge
---
# Modos de benchmark — ai-benchmark

`RunConfig` é uma **union discriminada por `mode`** (`src/types.ts`). Os três modos compartilham
o pipeline, mas diferem no que é o "contestant".

## Pipeline (comum)
**Gerador** (`datagen.ts`) cria N cenários/perguntas a partir do `theme` → **Competidores**
(`competitor.ts`) respondem em paralelo → **Juiz** (`judge.ts`) ranqueia às cegas + **Avaliador**
(`evaluator.ts`) dá veredito qualitativo de aceitabilidade. Resultado: `scoreboard` por contestant.

## Execução paralela (desde 2026-06-18)
`runLoop` (`orchestrator.ts`) roda em 2 fases: (1) **pré-gera todos os cenários em paralelo**
(`Promise.all`); (2) **roda todas as etapas em paralelo** (`Promise.all`, cada uma isolada em
try/catch). O placar é aditivo (`applyScoreboard`), então a ordem de término não importa. A
concorrência real é gateada pelo **limitador global adaptativo** em `openrouter.ts` (ver
`knowledge-openrouter`); `saveRun` é throttled. O **juiz é listwise** (1 chamada, ou 2 passes
paralelos agregados por posição média quando `judgePasses=2`) — não mais pairwise O(N²). No
**training**, as iterações seguem sequenciais (dependência de dados), mas as etapas de cada
iteração paralelizam. Na UI, `RunView` mostra um visualizador de processo ao vivo enquanto roda e
revela placar/heatmap só ao terminar.

## Contestant (`Contestant` em types.ts)
Competidor genérico com `id`, `label`, `modelId`, `systemPrompt?`, `techniqueId?`.
- **compare**: cada contestant é um modelo distinto (`id === modelId`, sem systemPrompt).
- **variation/training**: todos compartilham o **mesmo `modelId`**; diferem pelo `systemPrompt` (a variação testada).

## Os três modos
- **compare** (`POST /runs`): ≥2 `competitorModelIds`. Mesmas perguntas, ranking. Juiz e gerador não podem ser competidores.
- **variation** (`POST /runs`): 1 `contestantModelId` + variações de prompt. As variações vêm de **técnicas** (`techniqueIds`, otimização ligada → `variator.ts` reescreve via um modelo "optimizer") ou **manuais** (`manualVariants`). `basePrompt` opcional roda como controle. Juiz ≠ modelo sob teste (anti-viés).
- **training** (`POST /sessions`): como variation, porém **N `iterations`** encadeadas (`trainer.ts`) — a melhor variação de cada rodada evolui para a próxima. Sessão (`SessionRecord`) agrega as runs; `pinnedStages` congela os cenários após a iteração 0.

## Papéis de modelo numa run
`datagenModelId` (gerador), `judgeModelId` (juiz), e os competidores/contestant. `optimizerModelId`
default = `datagenModelId`. `judgePasses: 2` avalia em duas ordens (anti-viés de posição).

## Persistência e tempo real
Cada run vira `data/runs/<id>.json`; progresso por SSE (ver `knowledge-backend`). A tela
`RunView` consome o stream; `TrainingView` acompanha a sessão.
