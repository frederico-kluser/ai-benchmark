---
name: knowledge-frontend
description: Padrões do frontend React/Vite do prompt-builder — stack Tailwind v4 + shadcn + Motion UI, o AppShell (header que condensa, paleta ⌘K, transição de rota, toasts), camada api.ts, cache IndexedDB (v2, com a biblioteca de prompts), o ModelSelector em modal, a Nova Run em abas animadas, o import unificado de JSON, o heatmap/painel de finais de runShared.tsx e SSE. Use ao adicionar/alterar qualquer coisa em web/src/ (telas, componentes, chamadas de API, estilos).
metadata:
  version: 0.7.0
  type: knowledge
---
# Frontend — prompt-builder

React **19** + Vite + TypeScript. Roteamento com `react-router-dom` v6. Sem testes.
Dev em `:5173` com proxy de `/v1` e `/health` → `:3001` (`vite.config.ts`).

## Stack de UI (reescrita de 2026-07-26)
- **Tailwind v4 + shadcn + Motion UI.** `web/src/styles.css` **não existe mais**; `web/src/index.css`
  carrega o Tailwind e declara os tokens (`--background`, `--primary`, … + `--resolve`/`--parcial`/
  `--nao` e seus `-soft`). Tema claro/escuro pela classe `dark` no `<html>` (`theme.ts`, com `system`).
- Duas pastas são **propriedade do CLI** — edite em wrapper, nunca no source:
  `components/ui/*` (`npx shadcn@latest add <nome>`) e `components/motion-ui/*`
  (`npx shadcn@latest add @motion/<nome>`, registry token-gated; o token vive em `$MOTION_TOKEN`,
  no repo só existe o placeholder em `components.json`/`.npmrc`).
- **Antes de escrever JSX novo de UI, consulte o catálogo do Motion UI** (skill `motion-plus-ui`):
  acordeão, tabs, segmentado, paleta ⌘K, sheet, overlay, toast, skeleton, progress, sparkline,
  copy-button, hold-to-confirm, split/stagger-reveal e shrink-header **já estão instalados**.
- `motion.theme.ts` fica na **raiz do `web/`** (não em `src/`) porque é lá que o CLI o gerencia —
  importado por caminho relativo em `main.tsx`. **Nunca rode `add @motion/motion-theme` de novo.**
- ⚠️ Os componentes do Motion UI são tipados para **React 19**; foi por isso que o projeto subiu de
  18 → 19. Não volte o React sem quebrar `smooth-tabs`/`copy-button`/`sheet` no `tsc -b`.

## Shell (`components/AppShell.tsx`)
- Monta `MotionUIThemeProvider` (em `main.tsx`), `ThemeContext`, `HelpContext` e o `ToastLayer`.
- `ShrinkHeader` fixo (84px → 56px ao rolar); marca, nav, **paleta ⌘K** (a navegação primária),
  botão de ajuda, alternador de tema e o CTA "Nova run" (escondido quando já se está em `/new`).
- `useToasts().notify(texto, 'ok'|'error')` é o feedback efêmero — usado no salvar/excluir prompt.
- Transição de rota é `AnimatePresence` + opacity/translateY no token `ui`. **Não** use `page-curtain`
  nem `mask-wipe`: os dois atravessam o nome da página na tela (coreografia de landing page).

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
- IndexedDB `prompt-builder` (**DB_VERSION = 2**), stores `runs`/`sessions`/`runSummaries`/
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
  `{ kind: 'config' | 'pack' | 'stages' }` — `arena-config@1`, `prompt-builder-pack@1 (legado: ai-benchmark-pack@1)` ou **array cru
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
  `ProcessMonitor`, `computeStandings`/`Standing`, `stageStatus`, `medalStandings`/`MedalStanding`,
  nem o `SectionHead` com tile colorido (o de hoje vem de `components/primitives.tsx`).
- **`<ScoreHeatmap record ranked?>` é a ÚNICA visualização** de progresso e de resultado: linhas =
  variantes em **ordem estável** (`record.contestants`; só ordena por score quando `ranked`, i.e. no
  fim), colunas = cenários, célula = ✓ resolve / ◐ parcial / ✕ não resolve / **· pendente**, mais
  uma coluna de score 0–100 `(resolve + 0,5·parcial)/julgados` com a contagem `n✓ n◐ n✕`.
  Grade em Tailwind com `gridTemplateColumns` derivado do nº de cenários (é dado, não layout à mão —
  o catálogo do Motion UI não tem matriz; `sparkline` é o único gráfico dele). Cores = tokens
  `resolve`/`parcial`/`nao` + `-soft`, **medidos** em AA nos dois temas.
- **`<FinalsPanel record progress?>`**: pódio dos finalistas (Copeland de `record.standings` com
  pts e V–E–D; enquanto os duelos rodam, pódio provisório por `judgeScoreByContestant` e uma
  `<ProgressBar>` — cujo `value` é fração em **[0,1]**, não 0–100) + `<Accordion>` "Confrontos"
  agregando cada par nos dois sentidos.

## Telas de resultado
- **`RunView`** (`pages/RunView.tsx`): header (id, status, tema, cenários/custo, export JSON/CSV/
  Pacote) → `Resultados` (heatmap) → `Final` (FinalsPanel, só com finalistas/duelos) → `Cenários`
  (`<Accordion>`, **recolhido enquanto a run roda** — ao vivo a tela é só o heatmap) → `Variantes`.
  O `value` de cada `AccordionItem` é `stage-{index}` e **É o id do elemento no DOM** (âncora de
  deep-link do componente) — é por ele que o clique no heatmap abre e rola até o cenário.
  `AccordionItem` **não aceita prop `id`** (o tipo a omite de propósito).
- **`TrainingView`**: header → 1 banner de gates (convergência/holdout/significância, nunca
  bloqueante) → rodada corrente (heatmap) → `Final da rodada` → `Evolução` (heatmap local variante ×
  rodada, célula = judge-score) → `Melhor prompt` (`BestPromptStudio`: tabs Prompt/Diff + "Salvar na
  biblioteca"). Sumiram `PhaseStepper`, `FanOutBar`, `MedalBoard`, `CopelandBoard`, `GateCards`,
  log de promoções e a lista de rodadas. `iteration.analyzing` não é mais emitido.

## ModelSelector (`components/ModelSelector.tsx`)
- **Compacto:** render é UMA linha — rótulo + chips do que já foi escolhido + botão
  `[+ adicionar]`/`[trocar]`. O botão abre um **`<Modal>`** (`components/Modal.tsx`, sobre os
  primitivos de `@motion/overlay`: focus trap + scroll lock + scrim) com busca fuzzy (id×1.5 + nome).
  Virou modal porque o popup absoluto era cortado por qualquer ancestral com `overflow` — não existe
  mais o `PICKER_SAFE` que o NewRun espalhava. Props: `inline` (default **true**; `false` = card
  próprio) e `hint` (vira `title` do rótulo).
- Recebe um catálogo **compartilhado** `models` (evita refetch por seletor) + `excludeIds` (esconde modelos já usados em outro papel). Para filtrar o catálogo (ex.: LGPD), passe um array `models` já filtrado.
- **Filtros por papel (NewRun):** participantes recebem `participantModels` (LGPD + preço input/output); **gerador, juiz e referência recebem `models` completo** (não filtrados) e **podem repetir o mesmo modelo** (sem `excludeIds` entre eles).
- Chips de ids fora do catálogo carregado continuam visíveis (defaults pré-preenchidos).

## Nova Run (`pages/NewRun.tsx`)
- **Fluxo em abas**, não é assistente nem página única: `<SegmentedToggle>` escolhe o MODO e
  `<SmoothTabs>` divide a configuração em 4 etapas. Não existem `STEPS`, `StepProgress`, `Pipeline`,
  `Stepper`, `MODE_META`, presets de tema nem textarea de etapas manuais. Ver `task-edit-newrun-form`.
- As abas têm **ids estáveis** `cenarios | sujeitos | juizes | avancado`. Só o RÓTULO de `sujeitos`
  muda (`Modelos` no compare, `Prompts` nos outros) — é isso que impede a aba ativa de sumir quando
  o usuário troca de modo.
- Validação = **`problems(): { tab, text }[]`** (não é mais `string[]`): cada pendência sabe a aba
  que a resolve. O rodapé mostra a primeira e **leva até lá** ao clique; a aba com pendência ganha um
  ponto no rótulo. O botão NÃO fica disabled — `submit()` valida, troca de aba e mostra o erro.
  **Só exija campo que a UI mostra** — ex.: o gerador só é obrigatório quando `precisaGerar`.
- Rodapé é **fixo** (`fixed bottom-0`): pendência/erro + estimativa de custo + `<MultiStateButton
  type="submit">`. O `Screen` compensa com `pb-32`.
- Técnicas de prompt são chips inline (componente `Chip` local + botão "Todas", `title` com
  bom/cuidado); `components/TechniqueSelector.tsx` foi **deletado**.
- Reasoning por papel são `EffortField` dentro do Avançado (`EffortCard`/`ReasoningSelect` sumiram).
  Config de finais é `finalists` (0 = sem finais); **`duelTopK` não existe mais**.
- **Max tokens por resposta é input numérico LIVRE** (sem teto na UI; estado string; vazio/inválido
  → `DEFAULT_MAX_OUTPUT_TOKENS`). O Zod do backend aceita até 1 000 000.

## Primitivos do app (`components/primitives.tsx`)
- A gramática do produto, escrita uma vez sobre os tokens: `Screen` (coluna central; `wide` para
  telas com heatmap), `PageHeader` (usa `StaggerReveal` do Motion UI), `SectionHead`, `Banner`,
  `ImportedLine`, `EmptyState`, `StatusPill`, `Tag`, `Kbd`, `SettingRow`/`SettingGroup`, `Pre`,
  `MiniLabel`, `DiffView`. **Prefira compor daqui** a repetir cadeias de classe Tailwind.
