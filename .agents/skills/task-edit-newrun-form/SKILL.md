---
name: task-edit-newrun-form
description: Procedimento para alterar o formulário de Nova Run (web/src/pages/NewRun.tsx), que é uma PÁGINA ÚNICA de blocos — adicionar/remover um campo ou bloco, mexer na validação, nos seletores de modelo, no bloco Avançado ou no import de JSON. Use sempre que a tarefa tocar a tela de criação de run/sessão ou a montagem do RunConfig enviado.
metadata:
  version: 0.2.0
  type: task
---
# Tarefa: alterar o formulário de Nova Run

Pré-requisitos: `knowledge-frontend`. O formulário vive em `web/src/pages/NewRun.tsx`.
**Não é mais um assistente em passos** (o array `STEPS`, `validateStep`, `StepIntro`, `Pipeline` e o
passo `review` foram removidos em 2026-07-25). É um `<form className="screen nr">` único, lido de
cima a baixo, com um único botão `Iniciar →` no rodapé.

## Anatomia
Ordem fixa: título + `[Importar JSON]` → segmentado de modo (`.seg`) → avisos de import →
**blocos** → `<details className="nr-adv">` Avançado → `.nr-foot`.

- Um bloco é `<section className="nr-block">` com `.nr-block-head` (`.nr-block-title` +
  `.nr-block-status`, o resumo numérico à direita) e `.nr-block-body` (coluna, `gap: 14px`).
- Blocos atuais: **Cenários** (sempre) · **Modelos** (`mode === 'compare'`) · **Prompts**
  (`isSingle`, i.e. variation/training) · **Juízes** (sempre).
- Dentro do corpo use os campos locais já prontos, não escreva `<label>` cru:
  `NumField` (número), `TxtNumField` (número como texto — vazio = default/sem limite),
  `AreaField` (textarea), `EffortField` (select de reasoning), `Chip`, `ImportedLine`,
  `<ModelSelector inline>`, `.nr-inline` para pôr vários lado a lado.
- **Progressive disclosure**: o que é opcional começa escondido atrás de um
  `<button className="link-toggle">` (ex.: `briefOpen`, `genOpen`). O que já veio pronto de um
  arquivo **colapsa** para uma linha `✓ … [remover/editar]` (`ImportedLine`) e some da seleção.

### Onde pôr um campo novo
Regra: **se 9 em 10 runs não mexem nele, vai no `<details>` Avançado**; só sobe para um bloco o que
muda o resultado da run com frequência. O Avançado já concentra finalistas, tokens/timeout/
concorrência, juiz em 2 ordens, modelos de referência e reescritor, esforço por papel, o eixo
compare-llms, os gates de training, LGPD e o filtro de preço.

## Validação — `problems(): string[]`
Uma função só, sem estado, que devolve **uma frase por problema**. `const pendencias = problems()`
alimenta o rodapé (mostra `pendencias[0]`) e o `disabled` do botão; `submit()` a chama de novo.

- **Só exija um campo que a UI está mostrando.** Exigir campo escondido trava o `Iniciar →` sem o
  usuário ver o porquê — foi o caso do gerador quando os cenários já vieram do arquivo (hoje o
  check é `if (precisaGerar && datagen.length !== 1)`).
- Ao adicionar um filtro que pode invalidar seleções (LGPD, preço), **pode** as seleções órfãs no
  efeito de poda existente — senão a validação trava sem explicação.

## Cenários prontos vs. gerador
Três estados derivados no topo do componente governam metade da tela — mexeu em import, revise-os:
`rawStages` (array cru manda) · `seedCount` (pacote entra como seed) · `plannedStages`
(`max(stages, seedCount)`) · **`precisaGerar`** (só chama o datagen quando ainda falta cenário).

## Import unificado
UM `<input type="file">` escondido + `handleImport(file)` → `readImportFile` (`api.ts`), que nunca
lança e discrimina o formato:
- `kind: 'config'` → `applyArenaConfig(config)` + `setConfigSummary(arenaConfigSummary(config))`;
- `kind: 'pack'` → vira `pack` (seed), puxa tema e prompt base;
- `kind: 'stages'` → vira `customStages` (substitui o gerador).

**`applyArenaConfig` é campo-a-campo e `undefined` NÃO pisa o estado atual** — mantenha esse
contrato. Ao adicionar um campo ao `arena-config@1`: `engine/configFile.ts` (parse+validação) →
`applyArenaConfig` → `ARENA-CONFIG.md` (raiz, é o contrato lido por IA geradora).

## Montagem do `RunConfig` (`submit`)
`submit()` monta um objeto **`common`** (tudo que os três modos compartilham) e depois ramifica:
compare eixo models (`competitorModelIds`) · compare eixo configs (**só** `competitorConfigs`, sem
`competitorModelIds`) · variation/training (`contestantModelId`, variantes, e o bloco extra de
training). Depois `createSession` (training) ou `createRun`, e navega.

Convenções do `common` que já mordem quem edita:
- **clamp no envio, não na digitação** (`Math.max/min/round`) — o input aceita qualquer coisa;
- campos opcionais entram por spread condicional (`...(x ? { x } : {})`) para não mandar `undefined`;
- `referenceJudging` e `finalists` vão **sempre explícitos** (o default muda por modo/eixo);
- `stages: plannedStages`, não o estado `stages`.

**Ao adicionar ou remover um campo, são ~5 pontos de toque** e o type-check só pega alguns:
`useState` → JSX do bloco/Avançado → `estimate` (**incluindo o array de deps do `useMemo`**, que tem
`eslint-disable exhaustive-deps`) → `applyArenaConfig` → `common`/`config` do `submit`. Se o campo
existe no backend, feche o ciclo em `RunConfig` (`web/src/api.ts` **e** `src/types.ts`) e no Zod de
`src/routes.ts` (ver `task-add-endpoint`). **Grep pelo nome do campo antes de fechar.**

## Estilos
Reúse as classes que já existem (`.nr-block`, `.nr-field`, `.nr-inline`, `.nr-num`, `.tech-chip`,
`.picker-*`, `.link-toggle`, `.field-hint`) — ver `knowledge-code-style`. Atenção: `.nr-field` é um
**grid `132px | 1fr`**, então filho solto cai na coluna do rótulo (precisa de `grid-column: 2`).

## <evolution>
Ao concluir:
1. Só persista aprendizados se o type-check passou e o formulário funcionou de ponta a ponta nos
   três modos (smoke manual — inclusive com um JSON importado e no Avançado aberto).
2. Registre gotchas (layout de grid, elemento sempre renderizado, validação de campo escondido,
   deps órfãs de `useMemo`) em `LEARNINGS.md` com data + fonte.
3. Padrão estável → destile no corpo + incremente `version`.
4. Nova área (ex.: persistência de rascunho do formulário) → `meta-skill-evolution`.
5. Não faça merge sozinho: diff git para revisão humana.
