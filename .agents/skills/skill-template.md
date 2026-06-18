# Template de SKILL.md

Copie para `.agents/skills/<nome>/SKILL.md`. Mantenha enxuto (corpo <500 linhas / ~5k tokens;
mediana ideal ~1.400 tokens). Para portabilidade entre agentes, use só `name`+`description` no
frontmatter (Claude Code/Codex leem `metadata` extra; outros ignoram).

```markdown
---
name: <lowercase-com-hifens, ≤64 chars, igual ao nome da pasta>
description: <3ª pessoa; o que faz E quando usar; gatilhos explícitos; ligeiramente "pushy" (Claude tende a sub-acionar). ≤1024 chars.>
metadata:
  version: 0.1.0
  type: <knowledge|task|router|meta>
---
# <Nome da Skill>

## Quando usar
<contexto de ativação; sintomas/gatilhos>

## Conhecimento injetado
<o mínimo de alto sinal que o agente não tem: comandos EXATOS, constraints, padrões não-óbvios,
gotchas. Explique o PORQUÊ das regras (evite MUST/ALWAYS/NEVER em caps sem justificativa).
Forneça um default com escape hatch, não um leque de opções.>

## Procedimento (apenas skills de tarefa)
<passos com verbos de ação; referencie scripts/ para passos determinísticos>

## Referências
<links para references/*.md carregados sob demanda>

## <evolution>  <!-- obrigatório em skills de tarefa -->
Ao concluir a tarefa:
1. Só persista aprendizados se a tarefa passou nos testes/critérios.
2. Identifique o que vale persistir: surpresas, correções do usuário, convenções, anti-padrões.
   Ignore o óbvio e o volátil.
3. Faça append em LEARNINGS.md (com data + fonte: usuário > inferência).
4. Se um padrão estável acumular, destile no corpo desta SKILL.md e incremente version.
5. Se emergiu nova área, invoque meta-skill-evolution.
6. NÃO faça merge sozinho: deixe a mudança como diff git para revisão humana.
```

## Princípios (Anthropic — *Skill authoring best practices*)
- Descrição é o ÚNICO sinal de roteamento: diga **o que faz E quando usar**, em 3ª pessoa.
- Explique o porquê; não despeje regras imperativas em caixa-alta.
- *Evals*: liste *queries* que DEVEM acionar e *near-misses* que NÃO devem.
- Scripts em `scripts/` rodam via bash sem carregar conteúdo no contexto — só a saída custa tokens.
