---
name: task-add-wizard-step
description: Procedimento para adicionar, remover ou alterar um passo do assistente Nova Run (web/src/pages/NewRun.tsx), ou ajustar os seletores de modelo dentro dele. Use sempre que a tarefa mexer no fluxo em passos, na validação por passo, no catálogo de modelos mostrado, ou no resumo de revisão.
metadata:
  version: 0.1.0
  type: task
---
# Tarefa: adicionar/alterar um passo do assistente

Pré-requisitos: `knowledge-frontend`. O assistente vive em `web/src/pages/NewRun.tsx` e é dirigido
por um array `STEPS` (`mode`, `theme`, `players`, `eval`, `review`).

## Anatomia (o array dirige tudo)
- `const STEPS = [{ id, label }, ...] as const;` → `type StepId` deriva dele. Adicionar um passo =
  uma entrada no array + um bloco de render `{stepId === '<id>' && (...)}` + um case em `validateStep`.
- `StepIntro` lê `STEPS.length` ("Passo N de X") — o contador se ajusta sozinho.
- Navegação: `goTo(target)` só avança até o **primeiro passo inválido** (`firstInvalid()`); cada
  passo tem uma regra em `validateStep(id)` que retorna mensagem de erro ou `null`.

## Catálogo de modelos compartilhado
- Um único `models` (de `fetchModels()`) é passado a **todos** os `ModelSelector` (competidores,
  modelo sob teste, gerador, juiz). Para filtrar (ex.: por LGPD), compute um `filteredModels`
  (memo) e passe-o no lugar de `models` em todos os seletores.
- Ao mudar o filtro, **pode** as seleções que ficaram inválidas (efeito que remove ids
  bloqueados de `competitors`/`contestantModel`/`datagen`/`judge`) — senão a validação do passo
  `eval` trava sem explicação. Veja o efeito de poda existente (filtro LGPD) como referência.

## Onde anexar conteúdo
- Conteúdo "de configuração" (como o card de propósito LGPD) pode ser **anexado a um passo
  existente** (ex.: `theme`) em vez de criar um passo novo — menos clique para o usuário.
- Atualize o resumo no passo `review` se a mudança afeta a config final.
- Reflita campos novos em `submit()` (objeto `common`/`config`) e em `RunConfig` (`web/src/api.ts`).

## Estilos
Reúse classes/tokens de `styles.css` (`mode-card`, `proposito-chip`, `field-hint`…). Ver `knowledge-code-style`.

## <evolution>
Ao concluir:
1. Só persista aprendizados se o type-check passou e o fluxo do assistente funcionou (smoke manual).
2. Registre gotchas (ex.: laço de efeito ao podar seleção, timing de `setState`, indentação que
   quebrou um replace) em `LEARNINGS.md` com data + fonte.
3. Padrão estável → destile no corpo + incremente `version`.
4. Nova área (ex.: persistência de rascunho do assistente) → `meta-skill-evolution`.
5. Não faça merge sozinho: diff git para revisão humana.
