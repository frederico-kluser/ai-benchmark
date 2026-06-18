---
name: knowledge-frontend
description: Padrões do frontend React/Vite do ai-benchmark — camada api.ts, cache IndexedDB, o componente ModelSelector, o assistente Nova Run em passos, SSE ao vivo e design tokens CSS. Use ao adicionar/alterar qualquer coisa em web/src/ (telas, componentes, chamadas de API, estilos).
metadata:
  version: 0.2.0
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
- IndexedDB `benchmark-arena`, stores `runs`/`sessions`/`runSummaries`/`sessionSummaries`.
- Estratégia: servidor é fonte de verdade; IndexedDB é fallback offline. `cacheRun`/`fetchRuns` fazem o merge.

## SSE ao vivo
- `openRunStream(id, onEvent)` abre `EventSource` em `/runs/:id/events`. **Feche** o `EventSource` em eventos terminais — sem isso o browser reconecta infinitamente (há comentário explicando isso em `api.ts`).
- `RunView` (`pages/RunView.tsx`): o reducer `applyEvent` é **agnóstico à ordem das etapas** (atualiza `stages[stageIndex]` isolado; cada etapa tem seu `live`). Enquanto `status === 'running'`, mostra o **ProcessMonitor** (lista de etapas em paralelo + previews ao vivo, classes `.process-*` reusando `.live-*`/`.stage-badge`); placar/heatmap/etapas detalhadas só quando a run **termina**. Use `stageStatus()` para o badge por etapa.
- **Etapas chegam fora de ordem** (execução paralela): o reducer coloca etapas **por índice** (`stages[i] = …`, NUNCA `push` — push desalinha → array **esparso** → `record.stages.map(s => s.index)` quebra; foi o bug do heatmap/resumo). A UI de resultados deriva uma lista **densa e ordenada** (`denseStages`) e renderiza só dela. As etapas abrem **uma por vez** (carrossel: estado `openStage` + botões anterior/próxima), não todas expandidas.

## ModelSelector (`components/ModelSelector.tsx`)
- Recebe um catálogo **compartilhado** `models` (evita refetch por seletor) + `excludeIds` (esconde modelos já usados em outro papel). Busca fuzzy por id/nome. Para filtrar o catálogo (ex.: LGPD), passe um array `models` já filtrado.
- **Filtros por papel (NewRun):** participantes recebem `participantModels` (LGPD + preço input/output); **gerador e juiz recebem `models` completo** (não filtrados) e **podem repetir o mesmo modelo** (sem `excludeIds` entre eles).

## Assistente Nova Run (`pages/NewRun.tsx`)
- Ver `task-add-wizard-step` para o passo a passo. Resumo: um array `STEPS` dirige o fluxo; um `models` compartilhado alimenta todos os seletores; estimativa de custo via `priceById`.

## Estilos
- Tudo em `web/src/styles.css` com tokens `var(--…)` e tema claro/escuro. Reaproveite classes/tokens existentes (ver `knowledge-code-style`).
