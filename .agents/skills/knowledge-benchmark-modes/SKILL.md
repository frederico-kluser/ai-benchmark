---
name: knowledge-benchmark-modes
description: Os três modos de benchmark do prompt-builder (compare, variation, training — incluindo o eixo compare-llms), o conceito de "contestant" e o pipeline gerador→competidores→julgamento (por referência + duelos, com listwise de fallback). Use ao mexer em orchestrator/trainer/variator/datagen/competitor/judge, ao alterar RunConfig, ou ao trabalhar com placar, iterações e a tela de resultados.
metadata:
  version: 0.5.0
  type: knowledge
---
# Modos de benchmark — prompt-builder

`RunConfig` é uma **union discriminada por `mode`** (`src/types.ts`). Os três modos compartilham
o pipeline, mas diferem no que é o "contestant".

## Pipeline (comum)
**Gerador** (`datagen.ts`) cria N cenários/perguntas a partir do `theme` (em **lotes paralelos**,
com dedup ROUGE-L e `scenarioBrief` opcional) → **Competidores** (`competitor.ts`) respondem em
paralelo → **Julgamento**. O julgamento default é **por referência**: um **gabarito** temp-0 por
cenário (`gabarito.ts`) + juiz **pointwise** com vereditos `resolve/parcial/nao` (`refJudge.ts`),
de onde é **sintetizado um `JudgeResult`** que mantém scoreboard/UI funcionando — esse
`JudgeResult` ranqueia **SEMPRE por veredito** (`VERDICT_SCORE`), porque quando a etapa é julgada
os duelos ainda não rodaram; quem quer a ordem Copeland lê `record.standings`. O juiz **listwise**
de `judge.ts` (1 chamada por juiz devolve
`{ranking, acceptable, motivo}` por resposta — o antigo `evaluator.ts` foi fundido nele em
2026-06-18) virou **fallback**: compare clássico ou etapa sem gabarito. Detalhes do sistema de
evolução (gabarito/duelos/rank/holdout/pacote/reasoning) em **`knowledge-prompt-evolution`**.
Resultado: `scoreboard` por contestant + aceitabilidade.

**Uma rodada só (desde 2026-07-25):** cada cenário roda **exatamente uma vez** nos três modos. O
campo `repeats` (1–3 cópias por cenário, só compare) foi **removido** de `RunConfig`, do Zod, do
arena-config e do assistente — `record.stages.length === alvo`, sem expansão. Configs/arquivos
antigos que ainda tragam a chave passam sem erro (o Zod, sem `.strict()`, apenas a descarta).

## Fase 4 — FINAIS (desde 2026-07-25)
Os duelos **saíram de dentro da etapa**: não há mais bracket top-K por etapa. Depois de **todas**
as etapas serem julgadas e de `record.judgeScoreByContestant` ser calculado, o `orchestrator`
escolhe os **N finalistas GLOBAIS** por judge-score médio (`pickFinalists` em `duels.ts`, default
**3**, desempate por shuffle cego semeado em `seedFromId(record.id)`, **sem vaga garantida para o
controle**), emite `finals.started {finalists:[{id,label,score}]}` + grava `record.finalists`, e
roda `runStageDuels` em **TODAS** as etapas com gabarito **em paralelo** (`Promise.all`, sem cap
local) com o **mesmo bracket** — via a opção `duelists` de `RunStageDuelsOptions`, que **ignora
`topK`/`controlId`**. Por etapa sai `stage.dueled`; o agregado é `duel.progress`. O Copeland
cross-etapa continua indo para `record.standings`. Falha de duelo numa etapa **degrada** (etapa
sem duelo) e nunca derruba a run.
- Config: `finalists?: number` (default 3, `0` desliga) e `duels?: boolean` vivem em
  **`RunConfigBase`** (valem nos três modos). **`duelTopK` não existe mais** (fora de
  `TrainingConfig`, do Zod, do arena-config e da UI); `duels` saiu de `TrainingConfig`.
- Novo campo: **`RunRecord.finalists?: string[]`**.

## Execução paralela (desde 2026-06-18)
`runLoop` (`orchestrator.ts`) roda em fases: (1) **pré-gera todos os cenários em paralelo**
(`Promise.all`); (2+3) **roda todas as etapas em paralelo** (`Promise.all`, cada uma isolada em
try/catch: competidores em paralelo → julgamento pointwise/listwise); (4) **finais** (acima). O
placar é aditivo (`applyScoreboard`), então a ordem de término não importa. A
concorrência real é gateada pelo **limitador global adaptativo** em `openrouter.ts` (ver
`knowledge-openrouter`); `saveRun` é throttled. **Múltiplos juízes** (`judgeModelIds: string[]`)
rodam **em paralelo** (sem cap local); no listwise o ranking final é o **consenso** (posição média
entre juízes), a aceitabilidade é por **maioria** e o **placar é aditivo POR JUIZ** — com 2 juízes
e 3 competidores há até 6 pontuações/etapa. No **julgamento por referência** a agregação multi-juiz
é por média ordinal dos vereditos e o placar pontua **1×** (JudgeResult sintetizado). O juiz
listwise faz 1 chamada (ou 2 passes agregados por posição média quando `judgePasses=2`) — não mais
pairwise O(N²). No
**training**, as iterações seguem sequenciais (dependência de dados), mas as etapas de cada
iteração paralelizam. **Não há mais streaming ao vivo por competidor** (`competitor.started`/
`competitor.progress` foram removidos do `RunEvent`); na UI, `RunView` mostra o **ScoreHeatmap**
durante e depois da run, e o painel de finais quando a fase 4 começa.

**Cópia client-side:** todo o pipeline (orchestrator/trainer/datagen/competitor/judge/variator +
os módulos de evolução gabarito/refJudge/duels/rank/holdout/stats/llmVariants/scenarioPack/
reasoning/dedup) tem uma versão em `web/src/engine/` que roda no navegador (SPA estática). Mesma
lógica — sincronize os dois lados ao mexer. Ver `knowledge-architecture`.

## Contestant (`Contestant` em types.ts)
Competidor genérico com `id`, `label`, `modelId`, `systemPrompt?`, `techniqueId?` (+ `temperature?`/
`reasoningLevel?` no compare-llms).
- **compare**: cada contestant é um modelo distinto (`id === modelId`, sem systemPrompt) — **ou**, no
  eixo compare-llms, uma tripla `{modelId, temperature, reasoningLevel}` com id determinístico
  `llm__…` (a 1ª config vira `isOriginal` = controle/âncora do `standings`; nas finais ele **não**
  tem vaga garantida).
- **variation/training**: todos compartilham o **mesmo `modelId`**; diferem pelo `systemPrompt` (a variação testada).

## Os três modos
- **compare** (`POST /runs`): ≥2 `competitorModelIds` — **ou** o eixo **compare-llms**: 2–12
  `competitorConfigs` (XOR na API), onde a identidade do competidor é a **tripla
  {modelId, temperature, reasoningLevel}** (`llmVariants.ts`). Mesmas perguntas, ranking. Juiz e
  gerador não podem ser competidores.
- **variation** (`POST /runs`): 1 `contestantModelId` + variações de prompt. As variações vêm de **técnicas** (`techniqueIds`, otimização ligada → `variator.ts` reescreve via um modelo "optimizer") ou **manuais** (`manualVariants`). `basePrompt` opcional roda como controle. Juiz ≠ modelo sob teste (anti-viés).
- **training** (`POST /sessions`): como variation, porém **N `iterations`** encadeadas (`trainer.ts`).
  Sessão (`SessionRecord`) agrega as runs; `pinnedStages` congela os cenários após a iteração 0
  (com **split de holdout** intercalado, ratio default 0.2, piso de 5 cenários). Promoção só com
  margem **`minGain`** (default 1) de judge-score sobre a campeã (`rank.ts` → `pickWinner`); sem
  margem → `convergedAtIteration` + break. O feedback é o **reflection GEPA determinístico**
  (até 8 falhas da campeã → `<licoes_da_iteracao_anterior>`) — a chamada LLM `analyzeIteration`
  **não existe mais**. Ao final: run de **holdout** (controle × campeão) → `session.holdout` e
  **significância bootstrap pareada** (`stats.ts`) → `session.significance`.
  ⚠️ **`variationConfigFrom` (`trainer.ts`) é um whitelist**: monta a `VariationConfig` de cada
  iteração (e a do holdout) enumerando campo a campo. Todo campo novo de `RunConfigBase` precisa
  ser adicionado ali — o que faltar é descartado **em silêncio** e a run cai no default (foi assim
  que `finalists`/`duels` eram ignorados no treino). Irmão do mesmo problema em
  `normalizeRunRecord` (ver `knowledge-architecture`).

## Papéis de modelo numa run
`datagenModelId` (gerador), `judgeModelIds: string[]` (um ou mais juízes), e os competidores/contestant.
`optimizerModelId` default = `datagenModelId`. `judgePasses: 2` = duas ordens POR JUIZ (anti-viés de
posição, no listwise). Novos papéis/configs do sistema de evolução: `referenceModelId` (gabarito;
default = 1º juiz), `reasoning.{competitor,judge,rewriter,datagen}` (níveis off→max; `rewriter`
declarado mas ainda não aplicado), e os toggles `referenceJudging`/`duels`/`finalists`/`minGain`/
`holdoutRatio`/`feedbackDriven` (ver `knowledge-prompt-evolution`). **Tipos de domínio (RunConfig/JudgeResult) vivem em TRÊS arquivos** que devem ficar em
sincronia: `src/types.ts`, `web/src/engine/types.ts` **e** `web/src/api.ts` (não só os dois últimos).

## Persistência e tempo real
Cada run vira `data/runs/<id>.json`; progresso por SSE (ver `knowledge-backend`). A tela
`RunView` consome o stream; `TrainingView` acompanha a sessão.
