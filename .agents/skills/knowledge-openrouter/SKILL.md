---
name: knowledge-openrouter
description: Integração com o OpenRouter no ai-benchmark — quais endpoints são públicos vs autenticados, a API de chatCompletion/streaming, o cache de modelos de 24h e como funciona (ou funcionaria) o roteamento de provider/ZDR. Use ao mexer em src/openrouter.ts, ao chamar modelos, ou ao trabalhar com catálogo de modelos, custo e roteamento.
metadata:
  version: 0.1.0
  type: knowledge
---
# OpenRouter — ai-benchmark

Todo acesso ao OpenRouter é centralizado em `src/openrouter.ts`. Base configurável por
`OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`). Header de auth montado em
`defaultHeaders(apiKey)` (`Authorization: Bearer …` + `HTTP-Referer` + `X-Title`).

## Endpoints: público vs autenticado (gotcha importante)
- `GET /models` e `GET /endpoints/zdr` são **PÚBLICOS** — respondem 200 **sem** key. Por isso a
  validação da key usa `GET /key` (autenticado), **não** `/models` (validar por `/models` marcava
  qualquer key como válida e a run só falhava lá no datagen).
- `POST /chat/completions` exige a key.

## Funções expostas
- `listModels(apiKey, force?)` — catálogo mapeado para `OpenRouterModel` (`id`, `name`, `contextLength`, `pricing`, `raw`). **Cache de 24h** por key (chave = últimos 12 chars da key, p/ não misturar contas).
- `chatCompletion(params)` / `chatCompletionStream(params)` — `params`: `apiKey, modelId, messages, temperature, maxTokens, timeoutMs, signal, responseFormatJson`. Streaming parseia SSE (`data: <json>`), acumula `usage`.
- `computeCost(tokensIn, tokensOut, model)` — custo em USD via `pricing`.
- `validateKey(apiKey)` — usa `GET /key`; retorna metadados (label, uso, limite, free tier).

## Limitador global de concorrência (desde 2026-06-18)
`chatCompletion`/`chatCompletionStream` são o ÚNICO ponto de saída para o OpenRouter, então um
**semáforo de módulo** ali dentro (`guardedFetch`) gateia TODAS as chamadas de geração (datagen,
competidores, juiz, avaliador, optimizer, variator) de uma vez — não precisa propagar limitador
pelo pipeline. É **adaptativo (AIMD)**: `concurrencyLimit` cresce sob pressão e recua pela metade em
**429**, com **retry + backoff exponencial** (429/5xx/rede; aborts/timeout não repetem). Teto via
env `OPENROUTER_MAX_CONCURRENCY` (default 32). `currentConcurrency()` expõe `{limit, active, queued}`
para logs. Quem paraleliza etapas/competidores (`orchestrator.ts`) NÃO usa cap local — confia no
semáforo. Ao adicionar uma nova chamada de LLM, use `chatCompletion`/`Stream` e ela já entra no limite.

## Roteamento de provider / ZDR (estado atual + gancho)
- Hoje o app **não** fixa provider: o OpenRouter roteia automaticamente. O `body` de
  `chatCompletion`/`Stream` envia `model`, `messages`, `temperature`, `max_tokens`, `response_format`.
- **Para enforcement de conformidade** (fase 2 do filtro LGPD): adicionar ao `body` um objeto
  `provider: { zdr: true, only: [<allowlist>], data_collection: 'deny' }` e propagar a config do
  run pelas chamadas (datagen/competidor/juiz/variator). Ver `knowledge-lgpd-compliance`.

## Erros
`describeOpenRouterError(status, body)` traduz 401/403 (key inválida), 402 (sem crédito), 429
(rate limit) para PT-BR. Reúse-o em vez de criar mensagens novas.
