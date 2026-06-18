---
name: meta-skill-consolidate
description: Faz o "garbage collection" periódico da biblioteca de skills do ai-benchmark — deduplica aprendizados redundantes, detecta contradições, aplica versionamento temporal e poda entradas obsoletas. Use semanalmente, ou quando os LEARNINGS.md incharem, ou quando a qualidade das respostas estagnar/cair apesar de aprendizados acumulados (sinal de guidance contraditório).
metadata:
  version: 0.1.0
  type: meta
---
# Meta-skill: Consolidação (GC periódico)

Sistemas de memória que só crescem incham, se contradizem e ficam vulneráveis a *poisoning*.
Esta skill é a varredura de manutenção. Rode-a fora do fluxo de uma tarefa específica.

## Quando usar
- Cadência semanal de manutenção.
- `LEARNINGS.md` de alguma skill passou de ~algumas dezenas de linhas.
- Os resultados pioram/estagnam apesar de aprendizados acumulando (provável *guidance*
  contraditório — pode agressivamente).

## Procedimento
1. **Varra** todas as skills e seus `LEARNINGS.md`.
2. **Deduplique**: mescle aprendizados redundantes (entre arquivos inclusive); mantenha um só.
3. **Detecte contradições**: dois aprendizados que se opõem → aplique **versionamento temporal**
   (prefira o mais novo; **marque** o superado como obsoleto, não apague o histórico).
4. **Promova com cautela** (*dual-buffer*): aprendizado ainda "em probação" no `LEARNINGS.md` só
   sobe para o corpo do `SKILL.md` depois de reverificado e estável.
5. **Pode**: remova entradas obsoletas/volúveis; respeite o orçamento de tokens por skill (corpo
   <500 linhas / ~5k tokens; mire mediana ~1.400 tokens).
6. **Atualize** `metadata.version` das skills tocadas e o `catalog.md` se algo mudou de nome/escopo.

## Salvaguardas
- Correções do usuário têm prioridade sobre inferências do agente.
- Toda consolidação é um **commit separado para revisão humana** (mesmo gate do `meta-skill-evolution`).
- Se uma skill ficou grande demais e mistura assuntos, proponha dividi-la (granularidade > tamanho).
