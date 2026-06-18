# LEARNINGS — task-add-endpoint

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda periodicamente. Só persista o que
> é surpreendente, não-óbvio e não está no código.

- 2026-06-17 (inferência) — `tsc` não copia `.json` para `dist/`; leia dados estáticos por
  `process.cwd()` (não por import estático), senão o endpoint quebra em produção. Ex.: `src/lgpd.ts`.
- 2026-06-17 (inferência) — Rotas públicas (sem `requireKey`): `/techniques` e `/lgpd`. Use o mesmo
  padrão para servir dados estáticos que não dependem da key do usuário.
