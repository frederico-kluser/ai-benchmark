# AGENTS.md — ai-benchmark

Monorepo TypeScript: backend Express (`src/`) + frontend React/Vite (`web/`). UI/comentários em PT-BR.

## Comandos (exatos)
- dev: `npm run dev` — backend `:3001` (tsx watch) + frontend `:5173` (Vite, com proxy de `/v1` e `/health`)
- build: `npm run build` — `tsc -p tsconfig.json` (backend → `dist/`) + `tsc -b && vite build` (web → `web/dist/`)
- start (prod): `npm start` — `node dist/server.js` (serve `web/dist` na raiz)
- SPA estática (client-side, deploy Vercel): `npm run web:build` → `web/dist` (roda sem backend; ver `vercel.json`)
- type-check backend: `npx tsc -p tsconfig.json --noEmit` · frontend: `cd web && npx tsc -b`
- **Não há** `test` nem `lint` configurados. Verifique por type-check + execução manual.

## Regras (só o não-óbvio)
- Backend é **ESM NodeNext**: imports relativos terminam em **`.js`** mesmo para arquivos `.ts`.
- `tsc` não copia `.json` para `dist/` → leia dados estáticos por `path.resolve(process.cwd(), 'src/data/...')` (padrão de `storage.ts`/`lgpd.ts`), nunca por import estático.
- Tipos de domínio são **duplicados** em `src/types.ts` e `web/src/api.ts` — mantenha sincronizados.
- Em SSE, feche o `EventSource` em eventos terminais (senão o browser reconecta infinitamente).
- OpenRouter: `/models` e `/endpoints/zdr` são **públicos**; valide a key por `/key`.
- Toda chamada de LLM passa por `chatCompletion`/`chatCompletionStream` (`openrouter.ts`), que têm um **limitador global adaptativo** (semáforo + backoff em 429). Não chame o OpenRouter por fora nem ponha cap de concorrência local — confie no limitador. Teto via `OPENROUTER_MAX_CONCURRENCY`.
- O pipeline roda **todas as etapas em paralelo** (`orchestrator.ts`); o placar é aditivo (ordem-independente) e o `saveRun` é throttled.
- Há um **modo client-side** (`web/src/engine/`) que **duplica** o pipeline de `src/` para rodar no navegador (SPA estática/Vercel). Ao mudar a lógica do pipeline, **sincronize os dois lados**. Ver `knowledge-architecture`.

## Skills (leia primeiro)
Toda tarefa passa por **`.agents/skills/project-router`**, que carrega as skills de conhecimento/tarefa
relevantes ANTES de implementar. Índice: **`.agents/skills/catalog.md`**. Fonte única em
`.agents/skills/`; `.claude/skills` é symlink. As skills são geradas por LLM — trate como rascunho
curado e revise por `git diff` (ver `meta-skill-evolution`).

## Segurança
- Nunca leia/commite: `.env`, secrets. A key do OpenRouter é do usuário (vai por header `x-openrouter-key` / `localStorage`) — não hardcode keys.
- `data/` (runs/sessions em runtime) é ignorado no git; `src/data/*.json` (conhecimento versionado) NÃO.
