# `train` — evoluir um system prompt

```bash
benchmark-arena train \
  --model openai/gpt-5-mini \
  --judge anthropic/claude-sonnet-5 \
  --datagen openai/gpt-5-mini \
  --theme "Suporte técnico de um SaaS de faturamento" \
  --base-prompt-file prompt.md \
  --techniques persona,constraints,format \
  --stages 8 --iterations 3 \
  --budget 3 --output-format ndjson
```

Ou, melhor para um agente, tudo declarado num arquivo:

```bash
benchmark-arena config example --mode train -o arena.json
benchmark-arena train --config arena.json --budget 3 --dry-run
benchmark-arena train --config arena.json --budget 3 --output-format ndjson
```

## Flags que importam

| Flag | Efeito |
|---|---|
| `--model <id>` | o modelo sob teste (todas as variantes rodam nele) |
| `--judge <id>` | juiz; repita para um painel. **Não pode ser o `--model`.** |
| `--techniques a,b,c` | técnicas de reescrita (`benchmark-arena techniques`) |
| `--base-prompt-file` | o prompt de partida; entra como controle |
| `--iterations N` | teto de iterações (2–10). O laço para antes se convergir. |
| `--min-gain N` | margem mínima em pontos de judge-score para promover (padrão 1) |
| `--holdout-ratio N` | fatia reservada para o gate final (padrão 0,2; 0 desliga) |
| `--stages N` | quantos cenários (1–50). Recomendado 6–12. |
| `--effort-judge high` | o juiz é a tarefa mais sensível — vale gastar aqui |
| `--effort-datagen low` | gerar cenários é mecânico |
| `--finalists N` / `--no-duels` | tamanho da final / desliga a final |

**Precisa de pelo menos 2 contestants**: `técnicas + (1 se houver prompt base)`.
Uma técnica sem prompt base não basta.

## Como ler o resultado

```bash
benchmark-arena sessions winner <sessionId>              # legível
benchmark-arena sessions winner <sessionId> --json       # estruturado
benchmark-arena sessions winner <sessionId> --prompt-only > prompt.md
```

- `holdout` — campeão vs. base nos cenários **reservados**. É a evidência de que
  a melhora generaliza.
- `significance` — bootstrap pareado: `pValue` e o intervalo de confiança de 95 %
  em pontos percentuais. `null` = amostra pequena demais.
- `holdoutSkipped: true` — **o campeão não passou pelo gate**. Trate o ganho como
  não verificado.
- `convergedAtIteration` — o treino parou por falta de ganho, não por falta de
  iterações. Isso é um bom sinal, não uma falha.

## Quando o resultado não presta

- **Todos `parcial`** — normalmente o gabarito falhou (modelo de referência
  fraco ou sem crédito) ou não havia gabarito. Confira `--effort-judge` e o
  modelo em `--reference`.
- **Ganho alto no treino e nenhum no holdout** — sobreajuste aos cenários.
  Aumente `--stages` ou o `--holdout-ratio`.
- **Convergiu na iteração 0** — nenhuma variante superou a base pela margem.
  Baixe `--min-gain`, troque as técnicas, ou aceite que a base já é boa.
