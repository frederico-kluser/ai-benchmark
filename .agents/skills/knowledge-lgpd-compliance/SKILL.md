---
name: knowledge-lgpd-compliance
description: O filtro consultivo de conformidade LGPD do ai-benchmark — a base de conhecimento JSON, a lógica de classificação por família/origem, o passo de propósito no assistente, como regenerar o snapshot e o gancho para enforcement de roteamento (fase 2). Use ao mexer em conformidade, no filtro de modelos por área, ou nos arquivos src/data/lgpd-*.json, src/lgpd.ts e web/src/lgpd.ts.
metadata:
  version: 0.1.0
  type: knowledge
---
# Conformidade LGPD — ai-benchmark

Filtra o catálogo de modelos por **propósito/área** de uso conforme adequação à LGPD. É
**consultivo**: orienta e esconde modelos, mas **NÃO força** o roteamento de providers no
OpenRouter. Contexto: o repo é do Grupo Fleury (dados de saúde = sensíveis).

## Arquivos
- `src/data/lgpd-compliance.json` — **base de conhecimento** (fonte de verdade): `aviso`,
  `status_adequacao_anpd`, 6 `areas`, 9 `familias` (com `areas_permitidas` canônicas +
  `areas_notas`), `creators_origem` (heurística), `providers` (origem/ZDR), `heuristica_nao_classificados`.
- `src/data/lgpd-allowlist.generated.json` — **snapshot** dos modelos do OpenRouter classificados
  por área. Gerado, versionado, é referência (não é lido em runtime).
- `src/lgpd.ts` — backend: `getLgpdData()` (lê o JSON via `process.cwd()`, cacheia). Serve em `GET /v1/benchmark/lgpd`.
- `web/src/lgpd.ts` — frontend: `classifyModel`, `statusFor`, `filterModels`, `isAllowed`, `permissionOf`, const `AREA_LIVRE`.

## Regra de classificação (centro de tudo)
Status de um modelo numa área ∈ {`permitido`, `permitido com ressalvas`, `não recomendado`}:
1. prefixo do id (antes de `/`, sem `~`) casa com `familia.prefixos` → usa `familia.areas_permitidas[area]`.
2. senão, origem do criador via `creators_origem`: `China`/`SG` → `defaults_restrita` (não recomendado);
   ocidental/indefinido → `defaults_ocidental` (permitido com ressalvas).
Filtro: passa se status é `permitido`, ou `permitido com ressalvas` **e** `includeRessalvas`.
Área `livre` (`AREA_LIVRE`) = bypass (mostra tudo).

## UI (anexada ao passo Tema do assistente)
Card "Propósito / Conformidade LGPD" com seletor de área (+ "Livre") e toggle de Rigor.
`filteredModels` (memo) alimenta os 4 `ModelSelector`. Um efeito **poda** seleções que deixaram
de ser permitidas (inclui os defaults de origem chinesa) e avisa. O perfil vai para `RunConfig.compliance`.

## Regenerar o snapshot
`node scripts/gen-lgpd-allowlist.mjs` — busca `/models` + `/endpoints/zdr` (públicos, sem key),
aplica a mesma regra, reescreve o `*.generated.json`. Rode quando o catálogo ou as regras mudarem.

## Gancho de enforcement (fase 2, ainda NÃO implementado)
Para tornar a conformidade garantida (não só consultiva): enviar `provider: { zdr:true, only:[…],
data_collection:'deny' }` no body das chamadas (ver `knowledge-openrouter`) e propagar
`RunConfig.compliance` pelo pipeline. A allowlist sai de `providers` (origem ocidental/UE) + ZDR.

## Cuidado
A classificação por origem é **heurística** e carrega a postura conservadora do relatório
(China/SG → não recomendado). Em rigor máximo, áreas sensíveis (saúde/crianças) podem **zerar** o
catálogo — comportamento correto, não bug. As tabelas refletem 2026-06-17; revise antes de produção.
**Não é aconselhamento jurídico** (string `aviso` exibida na UI).
