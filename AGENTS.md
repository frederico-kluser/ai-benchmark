# AGENTS.md — ai-benchmark

Monorepo TypeScript: backend Express (`src/`) + frontend React/Vite (`web/`). UI/comentários em PT-BR.

## Comandos (exatos)
- dev: `npm run dev` — backend `:3001` (tsx watch) + frontend `:5173` (Vite, com proxy de `/v1` e `/health`)
- build: `npm run build` — `tsc -p tsconfig.json` (backend → `dist/`) + `tsc -b && vite build` (web → `web/dist/`)
- start (prod): `npm start` — `node dist/server.js` (serve `web/dist` na raiz)
- SPA estática (client-side, deploy Vercel): `npm run web:build` → `web/dist` (roda sem backend; ver `vercel.json`)
- type-check backend: `npx tsc -p tsconfig.json --noEmit` · frontend: `cd web && npx tsc -b`
- **Não há** `test` nem `lint` configurados. Verifique por type-check + execução manual.
- ⚠️ **`npm install` exige `MOTION_TOKEN` no ambiente.** `web/.npmrc` aponta o escopo `@motionplus`
  para o registry privado da Motion, e `motion-plus` (`@motionplus/core`) é dependência de runtime
  real — `stagger-reveal` e `skeleton` a importam. Sem a variável, o npm falha com
  `Failed to replace env in config` em **qualquer** comando, até offline. Vale para todo mundo do
  time e para o CI/Vercel (adicione `MOTION_TOKEN` nas env vars do projeto). Token novo em
  <https://motion.dev/dashboard/tokens> (exige Motion+). No repo só existe o placeholder.

## Regras (só o não-óbvio)
- Backend é **ESM NodeNext**: imports relativos terminam em **`.js`** mesmo para arquivos `.ts`.
- `tsc` não copia `.json` para `dist/` → leia dados estáticos por `path.resolve(process.cwd(), 'src/data/...')` (padrão de `storage.ts`/`lgpd.ts`), nunca por import estático.
- Tipos de domínio são **duplicados** em `src/types.ts`, `web/src/engine/types.ts` e `web/src/api.ts` — mantenha sincronizados.
- Em SSE, feche o `EventSource` em eventos terminais (senão o browser reconecta infinitamente).
- OpenRouter: `/models` e `/endpoints/zdr` são **públicos**; valide a key por `/key`.
- Toda chamada de LLM passa por `chatCompletion`/`chatCompletionStream` (`openrouter.ts`), que têm um **limitador global adaptativo** (semáforo + backoff em 429). Não chame o OpenRouter por fora nem ponha cap de concorrência local — confie no limitador. Teto via `OPENROUTER_MAX_CONCURRENCY`.
- O pipeline roda **todas as etapas em paralelo** (`orchestrator.ts`); o placar é aditivo (ordem-independente) e o `saveRun` é throttled.
- Julgamento default é **por referência**: gabarito temp-0 por cenário (`gabarito.ts`) + juiz pointwise (`refJudge.ts`, vereditos resolve/parcial/nao) → `JudgeResult` sintetizado (ranking **sempre por veredito**). O listwise de `judge.ts` é **fallback** (compare clássico/etapa sem gabarito). Ver `knowledge-prompt-evolution`.
- **Fase 4 — finais:** os duelos NÃO acontecem mais dentro da etapa. Depois de todas as etapas julgadas, `pickFinalists` (`duels.ts`) escolhe os **N melhores por judge-score médio** (`config.finalists`, default 3; sem vaga garantida p/ o controle) e eles duelam em **todos** os cenários, tudo num `Promise.all` (sem cap local). Eventos: `finals.started` → `stage.dueled` + `duel.progress`. **`duelTopK` não existe mais**; `duels`/`finalists` vivem em `RunConfigBase`.
- **Capacidade de ajuste vem do catálogo, NUNCA de tabela por modelo:** `GET /models` traz
  `supported_parameters` (quem aceita `temperature`) **e** um objeto `reasoning` com
  `supported_efforts` (allowlist de degraus, 20 conjuntos distintos), `default_effort` e
  `mandatory`. `modelCaps`/`effortOptions` (`web/src/modelCaps.ts`) montam a UI a partir disso —
  a tela só oferece o que a chamada consegue enviar. Esforço tem **7 degraus**
  (`off/minimal/low/medium/high/xhigh/max`), vai sempre como `reasoning: { effort }` (junto com
  `max_tokens` = HTTP 400) e é encaixado na allowlist por `fitEffort`; em modelo `mandatory` o
  nível `off` não é enviado. Ao mexer nisso, revalide com o catálogo real (ver
  `scratchpad/smoke/fit-test.ts` no histórico: 214 modelos × 7 níveis, 0 violações).
- **UI = Tailwind v4 + shadcn + Motion UI (React 19).** `web/src/styles.css` e a linguagem visual
  iOS (`.ios-*`, `.nr-*`, `.picker-*`, `.hm-*`, `--sys-*`) **não existem mais** — não as ressuscite.
  Estilo é utilitário no JSX, **só com classe semântica** (`bg-card`, `text-muted-foreground`,
  `border-border`); tokens em `web/src/index.css`; tema claro/escuro pela classe `dark` no `<html>`.
  Antes de escrever JSX de UI novo, **consulte o catálogo do Motion UI** (skill `motion-plus-ui`):
  acordeão, tabs, segmentado, paleta ⌘K, overlay, sheet, toast, skeleton, progress, sparkline,
  copy/hold-to-confirm e shrink-header já estão instalados em `web/src/components/motion-ui/`.
  Essa pasta e `components/ui/` são do CLI — **edite em wrapper, nunca no source**; um `add` novo
  sobrescreve, e `add @motion/motion-theme` sobrescreve o `web/motion.theme.ts` customizado.
  Movimento vem do tema (`useMotionUITransition`), nunca `stiffness`/`damping` na mão.
  Tokens de veredito (`resolve`/`parcial`/`nao` + `-soft`) são dado, não decoração: ao mexer neles,
  **meça o contraste** (AA em 13px nos dois temas) em vez de julgar a olho.
  ⚠️ O React foi de 18 → **19** porque as peças do Motion UI são tipadas para 19 (`smooth-tabs`,
  `copy-button` e `sheet` não passam no `tsc -b` sob 18). Não regrida.
- **Não há mais streaming ao vivo por competidor:** os eventos `competitor.started`/`competitor.progress` foram removidos e ninguém escreve `StageRecord.live` (o tipo só sobrevive p/ ler records antigos). A tela de run em andamento é **só o heatmap**.
- ⚠️ **Dois whitelists engolem campo novo em silêncio** — ao adicionar campo em `RunConfigBase`/`RunRecord`, cheque os dois: (1) `normalizeRunRecord` (`normalize.ts`), que hoje espalha `...raw` de propósito (antes perdia `judgeScoreByContestant`/`standings`/`finalists` ao reler do IndexedDB); (2) **`variationConfigFrom` (`trainer.ts`)**, que enumera campo a campo — o que faltar ali é descartado em toda iteração do treino e no holdout, sem erro nenhum.
- No **training**, promoção exige margem `minGain` sobre a campeã (`rank.ts`); `analyzeIteration` **não existe mais** (feedback = lições GEPA determinísticas) e o evento `iteration.analyzing` não é mais emitido. Holdout (piso 5) + significância bootstrap fecham a sessão.
- IndexedDB do cliente é **v2** (store `prompts` — biblioteca `/prompts` via `web/src/engine/promptStore.ts`, client-only). Eventos agregados `stage.gabarito` (`stageIndex: -1`) e `duel.progress` (sem índice) **não** entram no reducer de etapas.
- Há um **modo client-side** (`web/src/engine/`) que **duplica** o pipeline de `src/` para rodar no navegador (SPA estática/Vercel). Ao mudar a lógica do pipeline, **sincronize os dois lados**. Ver `knowledge-architecture`.
- **Não rode o backend `src/` em serverless (Vercel):** ele grava runs no filesystem (`storage.ts`), efêmero/isolado no serverless → `GET /v1/benchmark/runs/:id` vira `Run nao encontrada`. Produção = **SPA estática** (`npm run web:build`); o backend é só dev/self-host. Deploy errado se denuncia quando `/health` responde JSON em vez do `index.html`. Ver `knowledge-architecture`.

## Skills (leia primeiro)
Toda tarefa passa por **`.agents/skills/project-router`**, que carrega as skills de conhecimento/tarefa
relevantes ANTES de implementar. Índice: **`.agents/skills/catalog.md`**. Fonte única em
`.agents/skills/`; `.claude/skills` é symlink. As skills são geradas por LLM — trate como rascunho
curado e revise por `git diff` (ver `meta-skill-evolution`).

## Segurança
- Nunca leia/commite: `.env`, secrets. A key do OpenRouter é do usuário (vai por header `x-openrouter-key` / `localStorage`) — não hardcode keys.
- `data/` (runs/sessions em runtime) é ignorado no git; `src/data/*.json` (conhecimento versionado) NÃO.
