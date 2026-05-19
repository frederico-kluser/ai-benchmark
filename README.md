# AI Benchmark — Benchmark Arena

Sistema de benchmark paralelo de LLMs via [OpenRouter](https://openrouter.ai), com
gerador de cenários, juiz "overkill" e front-end em tempo real (SSE).

Dado um tema, o sistema gera cenários, executa vários modelos competidores em paralelo,
avalia as respostas com um modelo juiz e exibe placar, heatmap e custo ao vivo.

## Stack

- **Backend:** Node.js + Express + TypeScript (ESM), Zod para validação.
- **Frontend:** React 18 + Vite 5 + React Router 6.
- **Persistência:** arquivos JSON em `data/runs/*.json` (sem banco de dados).

## Configuração

Não é preciso nenhum `.env` para rodar — todos os parâmetros têm default.
A chave do OpenRouter **não** vai em variável de ambiente: você cola ela na
própria interface (tela de setup), e ela fica no `localStorage` do navegador.

Variáveis opcionais (veja `.env.example`):

| Variável | Default | Para quê |
|---|---|---|
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Apontar para um proxy/gateway |
| `OPENROUTER_APP_URL` | `http://localhost:3000` | Header `HTTP-Referer` de atribuição |
| `OPENROUTER_APP_TITLE` | `Benchmark Arena` | Header `X-Title` de atribuição |
| `BENCHMARK_PORT` | `3001` | Porta do backend |

## Como rodar

Um único `npm install` instala as dependências do backend **e** do front (`web/`).

### Desenvolvimento

```bash
npm install
npm run dev      # backend em :3001 + Vite em :5173 (proxy de /v1 e /health)
```

Abra `http://localhost:5173` e cole sua chave OpenRouter na tela de setup.

### Produção

```bash
npm install
npm run build    # compila o backend (dist/) e o front (web/dist/)
npm run start    # serve API + frontend em http://localhost:3001
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
