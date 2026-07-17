# LEARNINGS — task-run-and-verify

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda. Só persista o não-óbvio.

- 2026-06-17 (inferência) — `node dist/server.js` lê `src/data/*.json` por `process.cwd()`; rode a
  partir da raiz do repo, senão não acha os dados.
- 2026-06-17 (inferência) — Os endpoints `/api/v1/models` e `/api/v1/endpoints/zdr` do OpenRouter
  são públicos — dá para verificar classificação/catálogo via `curl` sem key.
- 2026-07-17 (inferência) — O `npx tsc` resolvido fora de `web/node_modules` pode ser uma versão
  antiga (ex: 4.9.5) que não reconhece `moduleResolution: "bundler"`. Para type-check do frontend,
  use `./node_modules/.bin/tsc -b` dentro de `web/` após `npm install`.
- 2026-07-17 (inferência) — Sem navegador disponível, o smoke de responsividade mobile pode ser
  complementado verificando se as media queries e as classes do menu hambúrguer aparecem no CSS
  gerado (`web/dist/assets/index-*.css`) e se o servidor de produção responde `200` com o
  `<meta viewport>` correto.
