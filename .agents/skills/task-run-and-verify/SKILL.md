---
name: task-run-and-verify
description: Procedimento para rodar o ai-benchmark e verificar uma mudança ponta a ponta, já que não há framework de testes. Use ANTES de dar qualquer tarefa por concluída — type-check dos dois lados, build, e smoke test (curl nos endpoints ou a UI no navegador).
metadata:
  version: 0.1.0
  type: task
---
# Tarefa: rodar e verificar

Não há testes automatizados. A verificação é type-check + execução + observação.

## Verificação rápida (type-check — barato, faça sempre)
- Backend: `npx tsc -p tsconfig.json --noEmit`
- Frontend: `cd web && npx tsc -b`
- Ambos juntos + bundle: `npm run build`

## Rodar em dev
- `npm run dev` → backend `:3001`, frontend `:5173` (Vite faz proxy de `/v1` e `/health`).
- Acesse `http://localhost:5173`. A key OpenRouter fica em `localStorage` (tela de Configurações).

## Smoke de backend (sem subir o Vite)
- `BENCHMARK_PORT=<porta> node dist/server.js` (após `npm run build`).
- `curl localhost:<porta>/health` → `{"status":"ok",...}`.
- Endpoints públicos: `curl localhost:<porta>/v1/benchmark/techniques`, `.../lgpd`.
- Endpoints com key: enviar header `-H 'x-openrouter-key: <key>'`.
- **Pare o servidor depois** (`pkill -f "dist/server.js"`); confirme que parou.

## Smoke de feature (exemplos)
- Run curta: crie uma run com `stages=1` e confira o `data/runs/<id>.json` gerado.
- Filtro LGPD: no passo Tema, troque a área e veja o catálogo dos seletores mudar; "Livre" volta tudo.

## Critério de "pronto"
Type-check verde + comportamento observado bate com o esperado. Relate honestamente o que foi (e
o que não foi) verificado.

## <evolution>
Ao concluir:
1. Persista só se a verificação realmente passou.
2. Registre em `LEARNINGS.md` qualquer passo de verificação novo/útil ou armadilha de ambiente
   (porta ocupada, cwd errado, cache) com data + fonte.
3. Padrão estável → destile no corpo + incremente `version`.
4. Não faça merge sozinho: diff git para revisão humana.
