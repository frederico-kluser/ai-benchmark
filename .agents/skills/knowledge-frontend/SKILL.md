---
name: knowledge-frontend
description: Padrões do frontend React/Vite do ai-benchmark — camada api.ts, cache IndexedDB (v2, com a biblioteca de prompts), o componente ModelSelector, o assistente Nova Run em passos (com compare-llms, pacote de cenários e toggles de evolução), SSE ao vivo (incl. eventos de gabarito/duelos) e design tokens CSS. Use ao adicionar/alterar qualquer coisa em web/src/ (telas, componentes, chamadas de API, estilos).
metadata:
  version: 0.4.0
  type: knowledge
---
# Frontend — ai-benchmark

React 18 + Vite + TypeScript. Roteamento com `react-router-dom`. Sem testes, sem lib de UI.
Dev em `:5173` com proxy de `/v1` e `/health` → `:3001` (`vite.config.ts`).

## Engine client-side (`web/src/engine/`)
- O pipeline roda **no navegador** (port de `src/`): `api.ts` delega ao engine — `createRun`/
  `createSession` iniciam o run na aba; `openRunStream`/`openSessionStream` assinam o pub/sub em
  memória (`engine/events.ts`); persistência em IndexedDB (`engine/storage.ts`). Sem backend para a
  SPA estática (Vercel). Ver `knowledge-architecture` (código duplicado src/ ↔ engine/).

## Camada de API (`web/src/api.ts`)
- Porta única do app. No modo client-side delega ao engine; a key (`localStorage`) vai direto ao OpenRouter.
- Tipos do domínio (`OpenRouterModel`, `RunConfig`, `RunRecord`…) são **espelhados** dos tipos do backend — ao mudar um, mude nos dois lados.
- Padrão de novo endpoint: uma função `fetchX()` que faz `fetch('/v1/benchmark/...')`, checa `res.ok` com mensagem PT-BR e retorna `json.data` (ver `fetchTechniques`/`fetchLgpd`).

## Cache local (`web/src/idb.ts`)
- IndexedDB `benchmark-arena` (**DB_VERSION = 2**), stores `runs`/`sessions`/`runSummaries`/
  `sessionSummaries`/**`prompts`** (v2; o upgrade cria só as stores que faltam, sem perder dados).
- Estratégia: servidor é fonte de verdade; IndexedDB é fallback offline. `cacheRun`/`fetchRuns` fazem o merge.
- `idbDelete` foi adicionado na v2 (mesmo padrão de degradar silenciosamente sem IndexedDB).

## Biblioteca de prompts (`/prompts`)
- Rota `/prompts` → `pages/PromptsPage.tsx` (link "Prompts" na topbar). Lista prompts salvos com
  busca, card expansível (versões `v{N}`, badge de origem, link "ver treino/run"), **diff
  linha-a-linha** entre versões (`web/src/diff.ts`), renomear inline e excluir com confirmação.
- Store: `engine/promptStore.ts` (`savePrompt`/`updatePrompt`/`getPrompt`/`listPrompts`/
  `deletePrompt`, todas no-op graciosas sem IndexedDB). **Versionamento por texto** — renomear não
  versiona; `HISTORY_LIMIT = 50`. Tipo `SavedPrompt` (com `origin`) espelhado em `api.ts`.
- **Handoff "usar como base":** PromptsPage grava `localStorage 'arena:prompt-draft'` e navega a
  `/new`; o NewRun lê **uma vez** no mount (e remove a chave), preenche o `basePrompt` e mostra um
  banner dispensável. Quem salva hoje é o `BestPromptStudio` da TrainingView ("Salvar na biblioteca").

## Pacote de cenários JSON
- Export: botão "Baixar pacote (JSON)" na **RunView** (só variation terminada, com ≥1 gabarito —
  campeão = maior judge-score) e na **TrainingView** (cenários de todas as runs da sessão).
  Via `buildScenarioPack` + `downloadScenarioPack` (`api.ts`).
- Import: passo **Tema** do NewRun ("Importar pacote .json" → `readScenarioPackFile`, nunca lança);
  pré-preenche tema e basePrompt, vira `scenarioSeed` (perde o `id`) e eleva `stages` a
  `max(stages, seedCount)`; o gerador completa o restante (`mergeScenarios`, ROUGE-L < 0.7).

## SSE ao vivo
- `openRunStream(id, onEvent)` abre `EventSource` em `/runs/:id/events`. **Feche** o `EventSource` em eventos terminais — sem isso o browser reconecta infinitamente (há comentário explicando isso em `api.ts`).
- `RunView` (`pages/RunView.tsx`): o reducer `applyEvent` é **agnóstico à ordem das etapas** (atualiza `stages[stageIndex]` isolado; cada etapa tem seu `live`). Enquanto `status === 'running'`, mostra o **ProcessMonitor** (lista de etapas em paralelo + previews ao vivo, classes `.process-*` reusando `.live-*`/`.stage-badge`); placar/heatmap/etapas detalhadas só quando a run **termina**. Use `stageStatus()` para o badge por etapa.
- **Etapas chegam fora de ordem** (execução paralela): o reducer coloca etapas **por índice** (`stages[i] = …`, NUNCA `push` — push desalinha → array **esparso** → `record.stages.map(s => s.index)` quebra; foi o bug do heatmap/resumo). A UI de resultados deriva uma lista **densa e ordenada** (`denseStages`) e renderiza só dela. As etapas abrem **uma por vez** (carrossel: estado `openStage` + botões anterior/próxima), não todas expandidas.
- **Eventos do sistema de evolução:** `stage.dueled` entra no reducer **por índice** (`stages[i].duels = …`, chega antes do `stage.judged`). Já `stage.gabarito` (vem com **`stageIndex: -1`**) e `duel.progress` (**sem** stageIndex) são **agregados de lote** — a RunView os **intercepta antes do `applyEvent`** e guarda em estado local (`gabaritoProgress`/`duelProgress`); no reducer retornam `prev` (defesa). O ProcessMonitor ganhou linhas "Gabaritos: d/t" e "Duelos: d/t" (props `gabarito`/`duelos`, só na RunView). Detalhes do pipeline em `knowledge-prompt-evolution`.
- **Painéis novos na RunView** (run terminada): **judge-score vs gabarito** (0–100, de `judgeScoreByContestant`), **classificação Copeland** (de `standings`), **vereditos vs gabarito** por etapa (selo ✓/◐/✕ de `stage.referenceJudge`), **DuelsPanel** por etapa (placements + as 2 ordens de cada duelo) e o gabarito/rubrica no bloco do cenário.
- **TrainingView:** componentes internos `CopelandBoard` (standings Copeland da rodada/holdout) e
  `GateCards` (convergência / gate de holdout / significância — nunca bloqueantes), log de
  promoções via `iteration.promoted`, `session.converged`/`session.holdout` tratados no stream,
  `ScenarioPackExport` e o `BestPromptStudio` (tabs Prompt/Diff vs. original + "Salvar na
  biblioteca"). Eventos agregados das runs de iteração caem no `applyEvent` e são ignorados.

## ModelSelector (`components/ModelSelector.tsx`)
- Recebe um catálogo **compartilhado** `models` (evita refetch por seletor) + `excludeIds` (esconde modelos já usados em outro papel). Busca fuzzy por id/nome. Para filtrar o catálogo (ex.: LGPD), passe um array `models` já filtrado.
- **Filtros por papel (NewRun):** participantes recebem `participantModels` (LGPD + preço input/output); **gerador e juiz recebem `models` completo** (não filtrados) e **podem repetir o mesmo modelo** (sem `excludeIds` entre eles).

## Assistente Nova Run (`pages/NewRun.tsx`)
- Ver `task-add-wizard-step` para o passo a passo. Resumo: um array `STEPS` dirige o fluxo; um `models` compartilhado alimenta todos os seletores; estimativa de custo via `priceById` (já inclui gabaritos/duelos/repeats).
- **Controles novos do sistema de evolução:** passo Tema — `scenarioBrief` (textarea que guia o
  datagen) + **import de pacote de cenários** (ver seção acima). Passo Participantes (compare) —
  toggle do **eixo compare-llms** ("Mesmo modelo, configs diferentes"): editor de 2–12 linhas
  `{modelId, temperature, reasoningLevel}` (identidade = a tripla; aviso de duplicada) + stepper
  `repeats` 1–3. Passo Avaliação — toggle **`referenceJudging`** (todos os modos; default ON em
  variation/training/compare-llms, OFF no compare clássico; vai sempre explícito no config; o
  seletor de **modelo de referência** fica dentro deste card, visível só quando ligado) e bloco
  **"Treino evolutivo"** (só training: `duels`, `duelTopK` 0–32, `minGain` 0–100, `holdoutRatio`
  0–0.5 exibido em %, `feedbackDriven`).
- **Effort (reasoning) por papel fica JUNTO de cada seletor de modelo** (componente local
  `EffortCard`): competidor (players), reescritor (players, com ModelSelector próprio opcional →
  `optimizerModelId`), gerador e juízes (eval). O effort da referência é o do juiz. Não há mais
  seção "Avançado" de reasoning (restou só a de concorrência/timeout).
- **Max tokens por resposta é input numérico LIVRE** (sem teto na UI; estado string; vazio/inválido
  → `DEFAULT_MAX_OUTPUT_TOKENS`). O Zod do backend aceita até 1 000 000.
- **Importar config (JSON)** — botão no `wizard-foot` (todos os passos): lê `arena-config@1`
  (`readArenaConfigFile`/`parseArenaConfig` de `api.ts` → `engine/configFile.ts`), aplica só os
  campos presentes (`applyArenaConfig`) e mostra banner com `arenaConfigSummary`. Formato
  documentado para IA geradora em **`ARENA-CONFIG.md`** (raiz). Cenários do arquivo viram o mesmo
  estado `pack` do pacote de cenários (`origin: 'import'`).
- **Treino:** o passo Tema tem o card "Como funciona o treino" (4 bullets do loop + stepper de
  iterações dentro dele) — iterações não ficam mais no grid genérico.

## Estilos
- Tudo em `web/src/styles.css` com tokens `var(--…)` e tema claro/escuro. Reaproveite classes/tokens existentes (ver `knowledge-code-style`).
