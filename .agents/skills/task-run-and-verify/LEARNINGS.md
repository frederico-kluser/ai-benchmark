# LEARNINGS — task-run-and-verify

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda. Só persista o não-óbvio.

- 2026-06-17 (inferência) — `node dist/server.js` lê `src/data/*.json` por `process.cwd()`; rode a
  partir da raiz do repo, senão não acha os dados.
- 2026-06-17 (inferência) — Os endpoints `/api/v1/models` e `/api/v1/endpoints/zdr` do OpenRouter
  são públicos — dá para verificar classificação/catálogo via `curl` sem key.
