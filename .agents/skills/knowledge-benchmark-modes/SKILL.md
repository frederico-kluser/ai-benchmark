---
name: knowledge-benchmark-modes
description: Os três modos de benchmark do ai-benchmark (compare, variation, training — incluindo o eixo compare-llms), o conceito de "contestant" e o pipeline gerador→competidores→julgamento (por referência + duelos, com listwise de fallback). Use ao mexer em orchestrator/trainer/variator/datagen/competitor/judge, ao alterar RunConfig, ou ao trabalhar com placar, iterações e a tela de resultados.
metadata:
  version: 0.3.0
  type: knowledge
---
# Modos de benchmark — ai-benchmark

`RunConfig` é uma **union discriminada por `mode`** (`src/types.ts`). Os três modos compartilham
o pipeline, mas diferem no que é o "contestant".

## Pipeline (comum)
**Gerador** (`datagen.ts`) cria N cenários/perguntas a partir do `theme` (em **lotes paralelos**,
com dedup ROUGE-L e `scenarioBrief` opcional) → **Competidores** (`competitor.ts`) respondem em
paralelo → **Julgamento**. O julgamento default é **por referência**: um **gabarito** temp-0 por
cenário (`gabarito.ts`), juiz **pointwise** com vereditos `resolve/parcial/nao` (`refJudge.ts`) e
**duelos Copeland** top-K (`duels.ts`); disso é **sintetizado um `JudgeResult`** que mantém
scoreboard/medals/UI funcionando. O juiz **listwise** de `judge.ts` (1 chamada por juiz devolve
`{ranking, acceptable, motivo}` por resposta — o antigo `evaluator.ts` foi fundido nele em
2026-06-18) virou **fallback**: compare clássico ou etapa sem gabarito. Detalhes do sistema de
evolução (gabarito/duelos/rank/holdout/pacote/reasoning) em **`knowledge-prompt-evolution`**.
Resultado: `scoreboard` por contestant + aceitabilidade.

## Execução paralela (desde 2026-06-18)
`runLoop` (`orchestrator.ts`) roda em 2 fases: (1) **pré-gera todos os cenários em paralelo**
(`Promise.all`); (2) **roda todas as etapas em paralelo** (`Promise.all`, cada uma isolada em
try/catch). O placar é aditivo (`applyScoreboard`), então a ordem de término não importa. A
concorrência real é gateada pelo **limitador global adaptativo** em `openrouter.ts` (ver
`knowledge-openrouter`); `saveRun` é throttled. **Múltiplos juízes** (`judgeModelIds: string[]`)
rodam **em paralelo** (sem cap local); no listwise o ranking final é o **consenso** (posição média
entre juízes), a aceitabilidade é por **maioria** e o **placar é aditivo POR JUIZ** — com 2 juízes
e 3 competidores há até 6 pontuações/etapa. No **julgamento por referência** a agregação multi-juiz
é por média ordinal dos vereditos e o placar pontua **1×** (JudgeResult sintetizado). O juiz
listwise faz 1 chamada (ou 2 passes agregados por posição média quando `judgePasses=2`) — não mais
pairwise O(N²). No
**training**, as iterações seguem sequenciais (dependência de dados), mas as etapas de cada
iteração paralelizam. Na UI, `RunView` mostra um visualizador de processo ao vivo enquanto roda e
revela placar/heatmap só ao terminar.

**Cópia client-side:** todo o pipeline (orchestrator/trainer/datagen/competitor/judge/variator +
os módulos de evolução gabarito/refJudge/duels/rank/holdout/stats/llmVariants/scenarioPack/
reasoning/dedup) tem uma versão em `web/src/engine/` que roda no navegador (SPA estática). Mesma
lógica — sincronize os dois lados ao mexer. Ver `knowledge-architecture`.

## Contestant (`Contestant` em types.ts)
Competidor genérico com `id`, `label`, `modelId`, `systemPrompt?`, `techniqueId?` (+ `temperature?`/
`reasoningLevel?` no compare-llms).
- **compare**: cada contestant é um modelo distinto (`id === modelId`, sem systemPrompt) — **ou**, no
  eixo compare-llms, uma tripla `{modelId, temperature, reasoningLevel}` com id determinístico
  `llm__…` (a 1ª config vira `isOriginal`, âncora dos duelos).
- **variation/training**: todos compartilham o **mesmo `modelId`**; diferem pelo `systemPrompt` (a variação testada).

## Os três modos
- **compare** (`POST /runs`): ≥2 `competitorModelIds` — **ou** o eixo **compare-llms**: 2–12
  `competitorConfigs` (XOR na API), onde a identidade do competidor é a **tripla
  {modelId, temperature, reasoningLevel}** (`llmVariants.ts`), com `repeats` 1–3 (cada cenário
  vira R cópias). Mesmas perguntas, ranking. Juiz e gerador não podem ser competidores.
- **variation** (`POST /runs`): 1 `contestantModelId` + variações de prompt. As variações vêm de **técnicas** (`techniqueIds`, otimização ligada → `variator.ts` reescreve via um modelo "optimizer") ou **manuais** (`manualVariants`). `basePrompt` opcional roda como controle. Juiz ≠ modelo sob teste (anti-viés).
- **training** (`POST /sessions`): como variation, porém **N `iterations`** encadeadas (`trainer.ts`).
  Sessão (`SessionRecord`) agrega as runs; `pinnedStages` congela os cenários após a iteração 0
  (com **split de holdout** intercalado, ratio default 0.2, piso de 5 cenários). Promoção só com
  margem **`minGain`** (default 1) de judge-score sobre a campeã (`rank.ts` → `pickWinner`); sem
  margem → `convergedAtIteration` + break. O feedback é o **reflection GEPA determinístico**
  (até 8 falhas da campeã → `<licoes_da_iteracao_anterior>`) — a chamada LLM `analyzeIteration`
  **não existe mais**. Ao final: run de **holdout** (controle × campeão) → `session.holdout` e
  **significância bootstrap pareada** (`stats.ts`) → `session.significance`.

## Papéis de modelo numa run
`datagenModelId` (gerador), `judgeModelIds: string[]` (um ou mais juízes), e os competidores/contestant.
`optimizerModelId` default = `datagenModelId`. `judgePasses: 2` = duas ordens POR JUIZ (anti-viés de
posição, no listwise). Novos papéis/configs do sistema de evolução: `referenceModelId` (gabarito;
default = 1º juiz), `reasoning.{competitor,judge,rewriter,datagen}` (níveis off→max; `rewriter`
declarado mas ainda não aplicado), e os toggles `referenceJudging`/`duels`/`duelTopK`/`minGain`/
`holdoutRatio`/`feedbackDriven` (ver `knowledge-prompt-evolution`). **Tipos de domínio (RunConfig/JudgeResult) vivem em TRÊS arquivos** que devem ficar em
sincronia: `src/types.ts`, `web/src/engine/types.ts` **e** `web/src/api.ts` (não só os dois últimos).

## Persistência e tempo real
Cada run vira `data/runs/<id>.json`; progresso por SSE (ver `knowledge-backend`). A tela
`RunView` consome o stream; `TrainingView` acompanha a sessão.
