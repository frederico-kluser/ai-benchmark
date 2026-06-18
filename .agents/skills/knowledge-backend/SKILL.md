---
name: knowledge-backend
description: Padrões do backend Express do ai-benchmark — rotas /v1/benchmark, validação Zod, autenticação por header de key, persistência atômica, eventos SSE e o pipeline do orquestrador. Use ao adicionar/alterar qualquer coisa em src/ (endpoints, validação, storage, streaming, etapas de run).
metadata:
  version: 0.1.0
  type: knowledge
---
# Backend — ai-benchmark

Express + TypeScript (ESM NodeNext). Entrypoint `src/server.ts` monta o router em
`app.use('/v1/benchmark', benchmarkRouter)` e serve `web/dist` com fallback SPA. Na subida,
`markOrphansAsAborted()` marca como `aborted` runs que ficaram "running" após um crash.

## Rotas (`src/routes.ts`)
- `POST /validate-key`, `GET /models` (exigem header `x-openrouter-key` via middleware `requireKey`).
- `POST /runs` (compare/variation), `POST /sessions` (training), `GET /runs`, `GET /runs/:id`, `GET /runs/:id/export.csv`.
- **SSE** (sem key): `GET /runs/:id/events`, `GET /sessions/:id/events`.
- Públicas (sem key): `GET /techniques`, `GET /lgpd`.

## Validação (Zod)
- `runConfigSchema` é uma **union discriminada por `mode`** (`compareObj`/`variationObj`/`trainingObj`) com `baseFields` comuns + `.superRefine` para regras cruzadas (ex.: juiz ≠ gerador; competidores únicos).
- `.preprocess` injeta `mode: 'compare'` em payloads antigos sem `mode` (retrocompat).
- Para um campo opcional novo, adicione em `baseFields` como `.optional()` (ex.: `compliance`).

## OpenRouter
- Toda chamada de modelo passa por `src/openrouter.ts` (ver `knowledge-openrouter`). Não chame `fetch` direto ao OpenRouter de outros arquivos.

## Persistência (`src/storage.ts`)
- Records em `data/runs/<id>.json` e `data/sessions/<id>.json`, resolvidos por `path.resolve(process.cwd(), 'data', ...)`.
- **Escrita atômica**: tmp único por escrita + `rename` (concorrência de competidores salvando junto já causou `ENOENT` no passado — não simplifique).
- Fila de escrita serializada por id (`saveQueues`).
- `loadRun` normaliza records antigos (`normalize.ts`) na leitura.

## Eventos / SSE (`src/events.ts`)
- `subscribe(runId, cb)` / `publish`. As rotas SSE enviam `snapshot` inicial e fecham (`res.end()`) em eventos terminais (`run.finished`/`run.error`). Manter o `keepalive` de 15s.

## Pipeline (orquestrador)
- `orchestrator.startRun(cfg, apiKey, {prepare?})` roda etapas: **gerador** (`datagen`) → **competidores** em paralelo (`competitor`) → **juiz** (`judge`) + avaliação qualitativa (`evaluator`). `trainer.ts` encadeia N iterações; `variator.ts` gera as variações de prompt. Ver `knowledge-benchmark-modes`.

## Ler dados/JSON em runtime
Use `path.resolve(process.cwd(), 'src/data/<arquivo>.json')` + `fs.readFileSync` (padrão de `lgpd.ts`) —
`tsc` **não** copia `.json` para `dist/`, então import estático quebraria em prod.
