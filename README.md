# AI Benchmark — Benchmark Arena

Sistema de benchmark paralelo de LLMs via [OpenRouter](https://openrouter.ai), com
gerador de cenários, juiz "overkill" e front-end em tempo real (SSE).

Dado um tema, o sistema gera cenários, executa vários modelos competidores em paralelo,
avalia as respostas com um modelo juiz e exibe placar, heatmap e custo ao vivo.

## Stack

- **Backend:** Node.js + Express + TypeScript (ESM), Zod para validação.
- **Frontend:** React 18 + Vite 5 + React Router 6.
- **Persistência:** arquivos JSON em `data/runs/*.json` (sem banco de dados).

## Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste:

- `OPENROUTER_API_KEY` — chave OpenRouter. Opcional no `.env`: a chave normalmente é
  fornecida pela própria UI (tela de setup) e guardada no `localStorage` do navegador.
- `OPENROUTER_APP_URL` (opcional, default `http://localhost:3000`)
- `OPENROUTER_APP_TITLE` (opcional, default `Benchmark Arena`)
- `BENCHMARK_PORT` (opcional, default `3001`)

## Como rodar

### Desenvolvimento

```bash
npm install
npm run web:install
npm run dev          # backend (tsx watch) em :3001 + Vite em :5173
```

Acesse `http://localhost:5173`. O Vite faz proxy de `/v1` e `/health` para `:3001`.

### Produção

```bash
npm install
npm run web:install
npm run build        # compila TS para dist/ e builda o front em web/dist/
npm run start        # serve API + frontend em http://localhost:3001
```

## Endpoints

- `POST /v1/benchmark/validate-key` — valida uma chave OpenRouter.
- `GET /v1/benchmark/models` — lista modelos OpenRouter (com pricing).
- `POST /v1/benchmark/runs` — inicia um run, retorna `{ runId }`.
- `GET /v1/benchmark/runs` — histórico de runs.
- `GET /v1/benchmark/runs/:id` — record completo do run.
- `GET /v1/benchmark/runs/:id/events` — stream SSE em tempo real.
- `GET /v1/benchmark/runs/:id/export.csv` — exporta os resultados em CSV.
- `GET /health` — health check (`{ "status": "ok", "service": "benchmark-arena" }`).

## Persistência

Cada run é salvo como `data/runs/<runId>.json` (diretório `data/` é gitignored e criado
em runtime). Runs órfãos (interrompidos por restart do processo) são marcados como
abortados na inicialização do servidor.
