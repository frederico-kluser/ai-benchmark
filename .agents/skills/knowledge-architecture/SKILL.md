---
name: knowledge-architecture
description: Mapa do repositório ai-benchmark — layout do monorepo, separação backend/frontend, fluxo de dados ponta a ponta e comandos exatos de build/run. Use no início de qualquer tarefa para saber ONDE mora cada coisa antes de varrer o codebase, ou quando precisar entender como as peças se conectam.
metadata:
  version: 0.2.0
  type: knowledge
---
# Arquitetura — ai-benchmark

Ferramenta de benchmark de LLMs via OpenRouter. Monorepo TypeScript: backend Express
(`src/`) + frontend React/Vite (`web/`). UI e comentários em **PT-BR**. Sem framework de testes.

## Comandos exatos
- `npm run dev` — sobe backend (`tsx watch src/server.ts`, porta 3001) **e** frontend (Vite, 5173) via `concurrently`.
- `npm run build` — `tsc -p tsconfig.json` (backend → `dist/`) **e** `npm run web:build` (`tsc -b && vite build` → `web/dist/`).
- `npm start` — `node dist/server.js` (prod; serve `web/dist` estático na raiz).
- Type-check só backend: `npx tsc -p tsconfig.json --noEmit`. Só frontend: `cd web && npx tsc -b`.
- **Não há** `test` nem `lint` configurados (os `// eslint-disable` no código são inertes).

## Layout
```
src/            backend (Express, ESM NodeNext — imports com extensão .js)
  server.ts     entrypoint: monta /v1/benchmark, /health, estático web/dist, SPA fallback
  routes.ts     todas as rotas /v1/benchmark + schemas Zod
  orchestrator.ts / trainer.ts / variator.ts   pipelines de run/treino/variação
  datagen.ts / competitor.ts / judge.ts / evaluator.ts   etapas do pipeline
  openrouter.ts client HTTP do OpenRouter (chat, models, key)
  storage.ts    persistência atômica em data/runs/*.json e data/sessions/*.json
  events.ts     pub/sub para SSE; techniques.ts  biblioteca de técnicas; lgpd.ts  base LGPD
  normalize.ts  migração de records antigos; types.ts  tipos compartilhados
  data/         JSON ESTÁTICO versionado (techniques não; lgpd-*.json sim)
web/src/        frontend
  api.ts        wrappers fetch + tipos espelhados do backend
  idb.ts        cache IndexedDB (db "benchmark-arena")
  pages/        NewRun (assistente 5 passos), RunView (SSE ao vivo), RunsList, TrainingView, Settings
  components/    ModelSelector, Toggle, TechniqueSelector, ManualVariantsEditor, KeySetup, HelpModal
  lgpd.ts       classificação/filtragem de conformidade; styles.css  design tokens (claro/escuro)
data/           runtime: runs/ e sessions/ (IGNORADO no git; ver /data/ no .gitignore)
```

## Fluxo de dados
1. Frontend guarda a key OpenRouter em `localStorage` e a envia no header `x-openrouter-key`.
2. Backend valida (`requireKey`), chama o OpenRouter, persiste o `RunRecord` em `data/runs/<id>.json`.
3. Progresso ao vivo via **SSE** (`GET /v1/benchmark/runs/:id/events`); o frontend espelha em IndexedDB (fallback offline).
4. Catálogo de modelos: cache de 24h no backend + IndexedDB no cliente.
5. As **etapas de uma run rodam todas em paralelo**; a concorrência das chamadas ao OpenRouter é gateada por um **limitador global adaptativo** em `openrouter.ts` (env `OPENROUTER_MAX_CONCURRENCY`). Ver `knowledge-benchmark-modes` / `knowledge-openrouter`.

## Dois modos de execução (atenção: código duplicado)
- **Backend** (`src/`): Express + run no servidor + filesystem. Usado por `npm run dev`/`npm start`.
- **Client-side** (`web/src/engine/`): o MESMO pipeline portado para o navegador (chama o OpenRouter
  direto, orquestra na aba, persiste no IndexedDB). Permite SPA estática (Vercel, `vercel.json`).
  `web/src/api.ts` delega ao engine; `engine/events.ts` (pub/sub) e `engine/storage.ts` (IndexedDB)
  substituem `events.ts`/`storage.ts` do Node.
- **⚠️ `web/src/engine/*` é uma CÓPIA de `src/*`** (datagen/competitor/judge/evaluator/variator/
  orchestrator/trainer/openrouter/normalize/techniques/types). Ao mudar a lógica do pipeline,
  **atualize os dois lados** (ou só o engine, se o backend já é legado no seu caso).

## Gotcha de path
`server.ts` resolve `web/dist` por `__dirname` (relativo ao arquivo). Mas **dados runtime e JSON
de `src/data/` são lidos por `process.cwd()`** (ver `storage.ts` e `lgpd.ts`) — porque `tsc` não
copia `.json` para `dist/`. Siga a convenção `process.cwd()` para ler qualquer arquivo de dados.

## Deploy / serverless (gotcha)
- **Produção = SPA estática client-side** (`vercel.json`: build `npm run web:build` → `web/dist`,
  rewrite `/(.*) → /index.html`). O backend `src/` é só para `npm run dev` / self-host persistente.
- **NUNCA publique `src/` (Express) em serverless/Vercel.** `storage.ts` persiste runs no filesystem
  (`process.cwd()/data/runs/*.json`); no serverless o FS é efêmero, isolado por invocação e read-only
  fora de `/tmp` → a run criada no `POST` some no `GET` e `GET /v1/benchmark/runs/:id` devolve
  `404 {"error":"Run nao encontrada"}`. É o mesmo motivo de o backend não rodar lá (não é só pela run
  longa: até **ler** uma run falha).
- **Detectar deploy errado:** na SPA, `GET /health` cai no rewrite e devolve `index.html` (HTML). Se
  devolver `{"status":"ok","service":"benchmark-arena"}` (= `server.ts:14`), há um deploy ANTIGO do
  backend preso em produção — force um novo deploy estático (não é bug de código).
- **Na SPA, runs vivem no IndexedDB do navegador** que as criou: não são compartilháveis entre
  dispositivos/navegadores (link de `/runs/:id` em outro navegador → `Run nao encontrada` em `api.ts`).
  Para compartilhar, trocaria `storage.ts`/engine por datastore compartilhado (Vercel KV/Postgres/Blob).
