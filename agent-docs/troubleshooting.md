# Problemas comuns

## `Faltou definir orçamento` (código 2)

Você está fora de um terminal interativo. Passe `--budget 5` ou `--budget none`.
Nada foi gasto.

## HTTP 400 ao mandar esforço de raciocínio

O nível pedido não existe naquele modelo. Confira antes:

```bash
benchmark-arena models show <id> --json | jq .model.thinkLevels
```

`accepted` lista o que pode ser pedido; `fit` mostra o que vai no fio para cada
pedido. Modelos com `canDisable: false` **ignoram** `off` — raciocínio é
obrigatório neles.

## `OpenRouter sem crédito (HTTP 402)` (código 5)

`benchmark-arena key check` mostra uso, limite e saldo. O pré-voo recusa antes de
gastar quando o saldo não cobre nem o piso da estimativa.

## Todos os vereditos vieram `parcial`

Significa que o juiz não teve gabarito para comparar. Causas, em ordem de
frequência:

1. o modelo de referência falhou (sem crédito, id errado, timeout) — os cenários
   ficam sem `reference` e o juiz pointwise degrada;
2. `referenceJudging` está desligado (padrão do `compare` clássico);
3. os cenários vieram de um pacote sem gabarito.

Rode com `--output-format ndjson` e procure `progress` com `phase: "gabarito"`.

## `modelos fora do catálogo (custo contado como zero)`

O id não existe no catálogo carregado — provavelmente um erro de digitação ou um
modelo retirado. Com `--budget` ligado isso vira **erro**, porque um orçamento
sobre um custo desconhecido não seria orçamento nenhum.

```bash
benchmark-arena models list --search <parte-do-nome>
```

## Run travada em `running`

O processo morreu sem finalizar (SIGKILL, queda de energia). O próximo comando
que lista runs marca as órfãs como `aborted`. Os dados parciais continuam lá.

## `Run "..." não encontrada`

Você está apontando para outro diretório de dados. Confira com
`benchmark-arena doctor` — runs vivem em `~/.benchmark-arena/runs/` por padrão,
e `--data-dir` / `$BENCHMARK_ARENA_HOME` mudam isso.

## O comando parece travar no fim

Não deveria: os temporizadores internos são `unref`ados. Se acontecer, reporte
com `--verbose`.

## Catálogo offline

Se o OpenRouter estiver fora do ar, o CLI usa o cache em disco (até 24 h) e
avisa no stderr. `models list` funciona offline; runs, não.
