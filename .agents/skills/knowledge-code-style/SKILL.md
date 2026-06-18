---
name: knowledge-code-style
description: Convenções de código do ai-benchmark — idioma, módulos ESM, tipagem, componentes React e CSS. Use em PRATICAMENTE TODA edição de código neste repositório para escrever no mesmo estilo do que já existe, evitando refações por inconsistência.
metadata:
  version: 0.1.0
  type: knowledge
---
# Estilo de código — ai-benchmark

Escreva código que se pareça com o que já está em volta. Pontos não-óbvios:

## Idioma
- **PT-BR** em strings de UI, mensagens de erro e comentários. Identificadores em inglês.

## Backend (TypeScript, ESM NodeNext)
- **Imports relativos DEVEM terminar em `.js`** mesmo apontando para um `.ts` (`import { x } from './foo.js'`). É exigência do NodeNext — sem isso o runtime quebra.
- `strict: true`, sem `any`. Erros tratados com mensagens claras em PT-BR (ver `describeOpenRouterError` em `openrouter.ts`).
- Validação de entrada com **Zod** em `routes.ts` (union discriminada por `mode`).
- Comentários explicam o **porquê** (há vários explicando armadilhas de concorrência/SSE) — preserve esse estilo.

## Frontend (React 18 + TS)
- Componentes funcionais; props tipadas como `interface Props { ... }` no topo do arquivo.
- Estado local com `useState`/`useMemo`/`useEffect`; estado compartilhado via **React Context** (`theme.ts`, `help.ts`) — **não** há Redux/Zustand.
- Estrutura **plana**: `components/` e `pages/` sem subpastas por componente; import direto por arquivo (`import { Toggle } from '../components/Toggle'`), sem `index.ts` de barril.
- Sem biblioteca de UI: componentes próprios.

## CSS
- **Vanilla CSS** num único `web/src/styles.css`, com **design tokens** `var(--token)` (ex.: `--accent`, `--card`, `--text-2`, `--warn`, `--err-soft`). Tema claro/escuro via `data-theme`.
- Nomes de classe estilo BEM-ish (`mode-card`, `proposito-chip`). Reaproveite tokens e padrões existentes em vez de cores hardcoded.

## Geral
- Sem framework de testes — valide por type-check + execução manual (ver `task-run-and-verify`).
- Mensagens de commit em PT-BR, estilo conventional (`feat:`, `feat(web):`, `fix:` …).
