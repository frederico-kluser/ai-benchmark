---
name: knowledge-frontend
description: Padrões do frontend React/Vite do ai-benchmark — camada api.ts, cache IndexedDB (v2, com a biblioteca de prompts), o ModelSelector compacto (picker), a tela Nova Run em página única, o import unificado de JSON, o heatmap/painel de finais de runShared.tsx, SSE e design tokens CSS. Use ao adicionar/alterar qualquer coisa em web/src/ (telas, componentes, chamadas de API, estilos).
metadata:
  version: 0.6.0
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
- `export { x } from './engine/…'` **não** cria binding local — o que a própria `api.ts` usa
  (`parseArenaConfig`, `ARENA_CONFIG_FORMAT`) tem de ser importado no topo **além** de reexportado.

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
  aviso dispensável. Quem salva hoje é o `BestPromptStudio` da TrainingView ("Salvar na biblioteca").

## Import/export de JSON
- **Import unificado:** UM botão `[Importar JSON]` no topo do NewRun → `readImportFile` (`api.ts`),
  que detecta o formato sozinho pelo campo `format` e devolve
  `{ kind: 'config' | 'pack' | 'stages' }` — `arena-config@1`, `ai-benchmark-pack@1` ou **array cru
  de cenários** (também aceita `{ stages: [...] }`; teto de 200). **Nunca lança** — erro vira
  `{ ok:false, error }` em PT-BR. `readArenaConfigFile`/`readScenarioPackFile` continuam exportados
  mas a UI não os usa mais.
- `config` → `applyArenaConfig` + banner `arenaConfigSummary`; `pack` → seed do datagen (estado
  `pack`); `stages` → substitui o gerador por completo (estado `customStages` → `config.customStages`).
  Formato documentado para IA geradora em **`ARENA-CONFIG.md`** (raiz).
- **Export:** botão `Pacote` na **RunView** (só variation terminada, com ≥1 gabarito; prompt = o do
  campeão por judge-score) e na **TrainingView** (cenários de todas as runs da sessão) — botão
  direto, sem diálogo. Via `buildScenarioPack` + `downloadScenarioPack`.

## SSE e visualização ao vivo (`pages/runShared.tsx`)
- `openRunStream(id, onEvent)` abre `EventSource` em `/runs/:id/events`. **Feche** o `EventSource` em eventos terminais — sem isso o browser reconecta infinitamente (há comentário explicando isso em `api.ts`).
- **Não há mais streaming token-a-token:** `competitor.started`/`competitor.progress` sumiram do
  `RunEvent` e `StageRecord.live`/`CompetitorLiveState` só existem para **ler records antigos**
  (`@deprecated`). Nada de live cards, `ProcessMonitor`, anel de progresso ou carrossel de etapas.
- `applyEvent` (reducer) é **agnóstico à ordem das etapas**: coloca **por índice**
  (`stages[i] = …`, NUNCA `push` — push desalinha → array esparso → `stages.map(s => s.index)`
  quebra). A UI deriva uma lista **densa e ordenada** (`denseStages`) e só renderiza dela.
- **Eventos agregados** (`stage.gabarito`, com `stageIndex: -1`, e `duel.progress`, **sem** índice)
  não entram no reducer: RunView/TrainingView **interceptam antes** do `applyEvent` (o de duelos
  vira estado local que alimenta o `FinalsPanel`); no reducer retornam `prev` como defesa.
- **`finals.started`** (novo, fase de finais) grava `record.finalists` — o heatmap marca a linha com
  o selo `final`. `stage.dueled` chega **depois** de todas as etapas julgadas, por índice.
- Exports de `runShared.tsx`: `VERDICT_META`, `verdictOf`, `trunc`, `denseStages`, `rankColor`,
  `applyEvent`, `HeatRow`, `heatRows()`, `<ScoreHeatmap>`, `<FinalsPanel>`. **Não existem mais**
  `ProcessMonitor`, `computeStandings`/`Standing`, `stageStatus`, `medalStandings`/`MedalStanding`.
- **`<ScoreHeatmap record ranked?>` é a ÚNICA visualização** de progresso e de resultado: linhas =
  variantes em **ordem estável** (`record.contestants`; só ordena por score quando `ranked`, i.e. no
  fim), colunas = cenários, célula = ✓ resolve / ◐ parcial / ✕ não resolve / **· pendente**, mais
  uma coluna de score 0–100 `(resolve + 0,5·parcial)/julgados` com a contagem `n✓ n◐ n✕`.
  Classes `.hm-*`.
- **`<FinalsPanel record progress?>`**: pódio dos finalistas (Copeland de `record.standings` com
  pts e V–E–D; enquanto os duelos rodam, pódio provisório por `judgeScoreByContestant`) + accordion
  "Confrontos" agregando cada par nos dois sentidos. Classes `.finals-*`.

## Telas de resultado
- **`RunView`** (`pages/RunView.tsx`): header (`.rv-head`/`.rv-stat`, export JSON/CSV/Pacote) →
  `Resultados` (heatmap) → `Final` (FinalsPanel, só com finalistas/duelos) → `Cenários`
  (`<details className="stage-list">`, **fechado enquanto a run roda** — ao vivo a tela é só o
  heatmap) → `Variantes` (`<details>`). Não há mais abas Resumo/Etapas, tabelas de classificação
  por pontos/judge-score/Copeland nem `DuelsPanel` por etapa.
- **`TrainingView`**: header → 1 banner de gates (convergência/holdout/significância, nunca
  bloqueante) → rodada corrente (heatmap) → `Final da rodada` → `Evolução` (heatmap local variante ×
  rodada, célula = judge-score) → `Melhor prompt` (`BestPromptStudio`: tabs Prompt/Diff + "Salvar na
  biblioteca"). Sumiram `PhaseStepper`, `FanOutBar`, `MedalBoard`, `CopelandBoard`, `GateCards`,
  log de promoções e a lista de rodadas. `iteration.analyzing` não é mais emitido.

## ModelSelector (`components/ModelSelector.tsx`)
- **Compacto:** render é UMA linha — rótulo + chips do que já foi escolhido + botão
  `[+ adicionar]`/`[trocar]` que abre um popup com busca fuzzy (id×1.5 + nome). Classes `.picker-*`
  (as antigas `.selector-*`/`.model-chip*` não existem mais). Props novas: `inline` (default **true**;
  `false` = card próprio) e `hint` (vira `title` do rótulo).
- Recebe um catálogo **compartilhado** `models` (evita refetch por seletor) + `excludeIds` (esconde modelos já usados em outro papel). Para filtrar o catálogo (ex.: LGPD), passe um array `models` já filtrado.
- **Filtros por papel (NewRun):** participantes recebem `participantModels` (LGPD + preço input/output); **gerador, juiz e referência recebem `models` completo** (não filtrados) e **podem repetir o mesmo modelo** (sem `excludeIds` entre eles).
- Chips de ids fora do catálogo carregado continuam visíveis (defaults pré-preenchidos).

## Nova Run (`pages/NewRun.tsx`)
- **Página única**, não é mais assistente: não existem `STEPS`, `StepProgress`, `StepIntro`,
  `Pipeline`, `Stepper`, `MODE_META`, presets de tema, gerador de prompt de coleta nem textarea de
  etapas manuais. Ver `task-edit-newrun-form` para o procedimento de mexer nela.
- Layout: título + `[Importar JSON]` → segmentado de modo (`.seg`/`.seg-btn`) → blocos verticais
  `.nr-block` que só aparecem quando fazem sentido (`Cenários` → `Modelos` no compare /
  `Prompts` em variation·training → `Juízes`) → `<details className="nr-adv">` **Avançado** →
  `.nr-foot` com erro, estimativa de custo e `Iniciar →`.
- Validação = função **`problems(): string[]`** (não há mais `validateStep`): o rodapé mostra a 1ª
  pendência e o botão fica `disabled` enquanto houver alguma. **Só exija campo que a UI mostra** —
  ex.: o gerador só é obrigatório quando `precisaGerar`.
- Técnicas de prompt viraram chips inline (`.tech-chip` + botão "Todas", `title` com bom/cuidado);
  `components/TechniqueSelector.tsx` foi **deletado**.
- Reasoning por papel são 4 `EffortField` dentro do Avançado (`EffortCard`/`ReasoningSelect` sumiram).
  Config de finais é `finalists` (0 = sem finais); **`duelTopK` não existe mais**.
- **Max tokens por resposta é input numérico LIVRE** (sem teto na UI; estado string; vazio/inválido
  → `DEFAULT_MAX_OUTPUT_TOKENS`). O Zod do backend aceita até 1 000 000.

## Estilos
- Tudo em `web/src/styles.css` com tokens `var(--…)` e tema claro/escuro. Reaproveite classes/tokens existentes (ver `knowledge-code-style`).
- Famílias vivas: `.seg`, `.nr-*` (Nova Run), `.picker-*` (ModelSelector), `.tech-chip`, `.hm-*`
  (heatmap), `.finals-*`, `.rv-*`, `.stage-list`. As famílias `.process-*`, `.fanout-*`, `.medal-*`,
  `.wizard-*`, `.mode-card*`, `.pipeline*`, `.selector-*`, `.stepper*`, `.review-*`, `.technique-*`,
  `.live-card*`, `.run-ring*` foram **removidas** — não as ressuscite.
