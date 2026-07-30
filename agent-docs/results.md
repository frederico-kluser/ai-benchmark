# Lendo os resultados

```bash
benchmark-arena runs list                       # últimas runs
benchmark-arena runs show <id> --json           # o RunRecord inteiro
benchmark-arena runs winner <id> --prompt-only  # só o prompt vencedor, cru
benchmark-arena sessions list | show | winner
```

## Duas réguas, não intercambiáveis

- **`judgeScoreByContestant`** — `(resolve + 0,5 × parcial) / total × 100` sobre
  os cenários com gabarito. Comparável **entre runs** com o mesmo juiz.
- **`standings`** — pontos Copeland dos duelos das finais (vitória 1, empate
  0,5). Só existe se as finais rodaram, e mede apenas os **finalistas** entre si.

O CLI sempre diz qual usou. Se as finais não rodaram (`--no-duels`,
`finalists: 0`, orçamento), a régua é o judge-score.

## Campos do `RunRecord` que importam

| Campo | O que é |
|---|---|
| `status` | `finished` \| `error` \| `aborted` |
| `stoppedReason` | `budget` \| `cancelled` — discrimina o `aborted` |
| `budgetExhausted` / `stoppedAtPhase` | parou cedo, e onde |
| `totalCostUsd` | gasto **total**, todos os papéis |
| `costByRole` | quebra por `competitor` / `judge` / `duel` / `gabarito` / `datagen` / `rewriter` |
| `costByContestant` | fatia **dos competidores** (gasto de juiz não é atribuível a ninguém) |
| `costAccuracy` | quantas chamadas tiveram preço exato / estimado / desconhecido |
| `stages[].incomplete` | etapa cortada no meio — **fora** do placar e do julgamento |
| `stages[].referenceJudge` | vereditos pointwise por contestant, com o motivo |
| `finalists` | ids que disputaram a final |

Uma etapa `incomplete` é o que separa "parou cedo, honesto" de "terminou,
mentindo": ela não vira veredito `parcial` nem entra na média.

## `SessionRecord` (treino)

| Campo | O que é |
|---|---|
| `bestPromptByIteration[]` | o campeão pós-gate de cada iteração, com o prompt |
| `convergedAtIteration` | parou por falta de ganho (bom sinal) |
| `holdout` | `{ n, controlScore, championScore, gain, regressed }` |
| `significance` | `{ n, meanDiffPp, ci95Pp, pValue }` ou `null` |
| `holdoutSkipped` | **campeão não validado** contra sobreajuste |
| `stoppedAtIteration` | onde o orçamento interrompeu |

`regressed: true` significa que o campeão foi **pior** que a base no holdout —
o ganho do treino era ruído ou sobreajuste. Não promova esse prompt.
