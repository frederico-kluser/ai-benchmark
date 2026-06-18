# Catálogo de Skills — ai-benchmark

> Índice da biblioteca de *knowledge skills*. Toda tarefa passa primeiro pelo
> **[project-router](project-router/SKILL.md)**, que seleciona e encadeia as skills
> abaixo **ANTES** de implementar. Fonte única em `.agents/skills/`; `.claude/skills`
> é um symlink. As skills foram geradas por LLM a partir do código — trate-as como
> **rascunho curado** e revise por `git diff` antes de confiar (ver `meta-skill-evolution`).

## Roteador
- **[project-router](project-router/SKILL.md)** — despacha toda tarefa para as skills certas antes de qualquer passo de implementação.

## Conhecimento (memória semântica)
- **[knowledge-architecture](knowledge-architecture/SKILL.md)** — mapa do monorepo, fluxo de dados, comandos exatos de build/run, arquivos-chave.
- **[knowledge-code-style](knowledge-code-style/SKILL.md)** — convenções: PT-BR, ESM com extensão `.js`, TS strict, `interface Props`, tokens CSS.
- **[knowledge-backend](knowledge-backend/SKILL.md)** — Express + Zod, `openrouter.ts`, escrita atômica em `storage.ts`, SSE, orquestrador, leitura de dados via `process.cwd()`.
- **[knowledge-frontend](knowledge-frontend/SKILL.md)** — React + Vite, `api.ts`, cache IndexedDB, `ModelSelector`, assistente em passos, design tokens, sem framework de testes.
- **[knowledge-openrouter](knowledge-openrouter/SKILL.md)** — endpoints públicos vs autenticados, `chatCompletion`, cache de 24h, roteamento de provider/ZDR.
- **[knowledge-benchmark-modes](knowledge-benchmark-modes/SKILL.md)** — modos `compare`/`variation`/`training`, `contestants`, pipeline gerador→competidores→juiz.
- **[knowledge-lgpd-compliance](knowledge-lgpd-compliance/SKILL.md)** — filtro consultivo LGPD, base de conhecimento, regeneração do snapshot, gancho de enforcement (fase 2).

## Tarefa (memória procedural) — terminam com passo `<evolution>`
- **[task-add-endpoint](task-add-endpoint/SKILL.md)** — adicionar um endpoint na API `/v1/benchmark`.
- **[task-add-wizard-step](task-add-wizard-step/SKILL.md)** — adicionar/alterar um passo do assistente Nova Run.
- **[task-run-and-verify](task-run-and-verify/SKILL.md)** — rodar o app e verificar uma mudança ponta a ponta.

## Meta-skills
- **[meta-skill-evolution](meta-skill-evolution/SKILL.md)** — decide atualizar/criar/descartar skills a partir de aprendizados; sempre via `git diff` para revisão humana.
- **[meta-skill-consolidate](meta-skill-consolidate/SKILL.md)** — GC periódico: deduplicação, detecção de contradição, versionamento temporal, poda.
