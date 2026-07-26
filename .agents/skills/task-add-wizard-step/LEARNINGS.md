# LEARNINGS — task-add-wizard-step

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda. Só persista o não-óbvio.

- 2026-06-17 (inferência) — Ao podar seleções por mudança de filtro, NÃO inclua as seleções nas
  deps do efeito: use um `useRef` com o estado mais recente e rode o efeito só em
  [área, rigor, dados]. Incluir as seleções faz o aviso de "removidos" piscar e sumir.
- 2026-06-17 (inferência) — `models={models}` aparece com indentações diferentes (seletores
  aninhados no ternário de `players` vs. seletores do passo `eval`). Um replace_all por string
  exata só pega uma das indentações — confira ambas.
- 2026-06-17 (inferência) — Default de filtro ficou em `livre` de propósito: qualquer área não-livre
  poda os defaults de origem chinesa (`deepseek` gerador, `moonshotai` juiz) na carga inicial.
- 2026-07-25 (usuário) — Não existe mais seletor de rodadas/repetições: `repeats` foi removido, cada
  cenário roda 1× nos três modos. Ao **remover** um campo do assistente são **6** pontos de toque, e
  o type-check só pega alguns: `useState`, o card JSX, a estimativa de custo **+ o array de deps do
  `useMemo`** (tem `eslint-disable exhaustive-deps` — deps órfãs passam batido), `applyArenaConfig`,
  o objeto de `submit()` e a linha do resumo do passo **Revisar**. Grep pelo nome do campo antes de
  fechar.
- 2026-06-18 (usuário) — Filtros são por PAPEL: participantes (competidores/contestant) recebem o
  catálogo filtrado (LGPD + preço via `participantModels`); gerador e juiz recebem `models` (completo,
  sem filtro) e a poda NÃO os toca. Gerador e juiz podem repetir o mesmo modelo (sem `excludeIds`
  entre eles; o check `datagen===judge` do Zod no backend foi relaxado). Filtro de preço = USD por 1M
  tokens (`pricing.prompt/completion * 1e6`).
