# Benchmark Arena — Guia das Telas

Documento descritivo da interface: o que cada **tela** mostra, quais **elementos** possui,
em quais **estados** pode estar e como reage **em tempo real**. Para entender o projeto como
um todo (arquitetura, API, como rodar), veja o [`README.md`](./README.md).

A interface é uma **SPA em React + React Router** (`web/`), com **tema escuro** e CSS próprio
(`web/src/styles.css`). São **4 telas** mais um *gate* de chave e dois componentes reutilizáveis.

> **Nota (modo client-side / deploy estático):** no deploy estático (Vercel) **não há backend** — o
> pipeline roda no próprio navegador (`web/src/engine/`). As telas são as mesmas, mas: o tempo real
> vem de um **barramento em memória** (não SSE), o histórico fica no **IndexedDB** do navegador, e a
> key vai **direto ao OpenRouter** (não a um backend). Onde este guia disser "backend/servidor/SSE",
> leia "engine na aba" no modo client-side.

---

## Sumário

- [Design system](#design-system)
- [Estrutura comum (shell)](#estrutura-comum-shell)
- [Mapa de navegação](#mapa-de-navegação)
- [Padrões globais (loading, erro, vazio, gate)](#padrões-globais-loading-erro-vazio-gate)
- [Tela: Configurações](#tela-configurações-settings)
- [Componente: KeySetup + KeyGate](#componente-keysetup--keygate)
- [Tela: Nova Run](#tela-nova-run-new)
- [Componente: ModelSelector](#componente-modelselector)
- [Tela: Histórico](#tela-histórico-runs)
- [Tela: Visão da Run](#tela-visão-da-run-runsid)
- [Comportamento em tempo real](#comportamento-em-tempo-real)
- [Legenda de cores e badges](#legenda-de-cores-e-badges)
- [Console do navegador](#console-do-navegador)

---

## Design system

Tema **dark** definido por variáveis CSS em `:root`:

| Token | Cor | Uso |
|---|---|---|
| `--bg` | `#0f1115` | Fundo da página |
| `--bg-elev` | `#181b22` | Cartões, topbar, inputs |
| `--bg-elev-2` | `#21252e` | Cartões aninhados, chips, dropdown |
| `--border` | `#2a2f3a` | Bordas e divisórias |
| `--text` | `#e4e6eb` | Texto principal |
| `--muted` | `#8a8f9a` | Texto secundário/legendas |
| `--accent` | `#4f8cff` (azul) | Links, foco, botão primário, progresso ao vivo |
| `--ok` | `#4ade80` (verde) | Sucesso, "julgado", "aceitável" |
| `--warn` | `#f5b25b` (âmbar) | "running", "aguardando juiz" |
| `--danger` | `#ff5577` (vermelho) | Erros, "não aceitável" |

- **Tipografia:** *system fonts* (San Francisco/Segoe/Roboto), base 14px; `code`/`pre` em fonte
  monoespaçada. Títulos `h2` em maiúsculas, espaçadas, na cor *muted* (rótulos de seção).
- **Container:** conteúdo centralizado, largura máxima **1200px**, padding 24px (`.page`).
- **Botões:** `primary` (azul, cheio), `ghost` (contornado, discreto).

---

## Estrutura comum (shell)

Toda tela é renderizada dentro de um **Layout** comum (`web/src/main.tsx`):

```
┌───────────────────────────────────────────────────────────────┐
│  Benchmark Arena        Nova Run   Histórico   Configurações    │  ← topbar fixa
├───────────────────────────────────────────────────────────────┤
│                                                                 │
│                      « conteúdo da tela »                       │  ← <main>
│                                                                 │
└───────────────────────────────────────────────────────────────┘
```

- **Topbar:** à esquerda a marca **"Benchmark Arena"** (link para a raiz `/`); à direita a
  **navegação** com três links: **Nova Run** (`/new`), **Histórico** (`/runs`),
  **Configurações** (`/settings`). Links ficam *muted* e clareiam no *hover*.
- Não há rodapé nem barra lateral — a interface é enxuta.

---

## Mapa de navegação

| Rota | Tela | Observação |
|---|---|---|
| `/` | — | Redireciona para `/new` |
| `/new` | **Nova Run** | Protegida pelo **KeyGate** (exige key) |
| `/runs` | **Histórico** | Lista de runs |
| `/runs/:id` | **Visão da Run** | Detalhe ao vivo de uma run |
| `/settings` | **Configurações** | Gerenciar a API key |

---

## Padrões globais (loading, erro, vazio, gate)

- **Carregando:** telas que buscam dados mostram um texto simples (ex.: *"Carregando…"* na
  Visão da Run; *"Carregando modelos…"* no seletor).
- **Erro:** aparece em um **banner vermelho** (`.error-banner`) — fundo translúcido, borda
  vermelha, cantos arredondados.
- **Vazio:** mensagens *muted* (ex.: *"Nenhuma run ainda."*, *"Nenhum modelo encontrado"*).
- **KeyGate:** a tela **Nova Run** é embrulhada por um *gate*. Sem key salva no `localStorage`,
  em vez do formulário aparece o **KeySetup** (abaixo). Assim que a key é validada, o formulário
  aparece sem recarregar a página.

---

## Tela: Configurações (`/settings`)

Tela mínima: renderiza o componente **KeySetup** em modo completo. É onde você cola, valida,
inspeciona e remove a chave da OpenRouter. (Detalhes do componente logo abaixo.)

```
OpenRouter API Key
Cole sua key do OpenRouter. Ela fica salva no localStorage do seu navegador
e é enviada ao backend apenas em requests desta tela.

[ sk-or-v1-•••••••••••••••••••• ]  [ Validar e salvar ]  [ Remover ]

✓ Key válida (Minha Key) — uso $0.4213 / limite $10.00 · tier gratuito.
Tudo certo — você já pode criar uma nova run.
```

---

## Componente: KeySetup + KeyGate

`web/src/components/KeySetup.tsx`. Reutilizado em **Configurações** (modo completo) e no
**KeyGate** da Nova Run.

**Elementos:**

- **Título e ajuda** (só no modo completo): explicação + link para `openrouter.ai/keys`,
  deixando claro que a key fica no `localStorage` e só é enviada nas requests desta tela.
- **Campo da key:** input do tipo `password` (mascarado), placeholder `sk-or-v1-...`,
  `autoComplete="off"`.
- **Colar = validar:** ao **colar** uma key, ela é preenchida e **validada automaticamente**
  (não precisa clicar no botão).
- **Botão "Validar e salvar":** dispara a validação manual; durante a chamada vira *"Validando…"*
  e fica desabilitado.
- **Botão "Remover"** (`ghost`): aparece só quando há key válida; limpa a key do `localStorage`.
- **Mensagem de status:**
  - **Válida** (verde): *"Key válida (label) — uso $X / limite $Y · tier gratuito."* — os
    metadados (label, uso, limite, free tier) vêm do `GET /key` da OpenRouter.
  - **Inválida** (vermelha): mensagem traduzida (key recusada, sem crédito, rede, etc.).

**KeyGate:** componente que decide, em tempo de render, se mostra o conteúdo protegido ou o
KeySetup. Estado inicial baseado em `getStoredKey()`; ao salvar uma key válida, libera o
conteúdo (a Nova Run) imediatamente.

---

## Tela: Nova Run (`/new`)

**Assistente em 5 passos** que monta a configuração da run (`web/src/pages/NewRun.tsx`). Em vez de
mostrar tudo de uma vez, guia o usuário por etapas — cada uma com **texto explicando** o que faz —
até o disparo. Tudo vem **pré-preenchido** com defaults sensatos; o passo só libera o próximo quando
está completo. Largura focada (~760px, coluna única).

```
Nova Run
Monte seu benchmark em 5 passos. Cada etapa explica o que faz — no fim, é só disparar os robôs.

①Objetivo ─ ②Tema ─ ③Participantes ─ ④Avaliação ─ ⑤Revisar      ← trilha clicável

┌─ Passo 1 de 5 ─────────────────────────────────────────────┐
│ O que você quer descobrir?                                  │
│ [⚖️ Comparar]  [🧬 Testar prompts]  [📈 Treinar prompt]      │  ← cartões escolhíveis
│ Como roda: Gerador → Competidores → Juiz   (tutorial ↗)     │
└────────────────────────────────────────────────────────────┘

                              [ ← Voltar ]            [ Continuar → ]
```

**Os 5 passos** (`STEPS`):

| # | Passo | Conteúdo | Regra para avançar |
|---|---|---|---|
| 1 | **Objetivo** | 3 cartões de modo (Comparar / Variação / Treino) + diagrama do pipeline + link p/ tutorial | sempre válido |
| 2 | **Tema** | `textarea` do tema + presets; steppers **Etapas** e **Max tokens** (+ **Iterações** no Treino) | tema preenchido |
| 3 | **Participantes** | **Filtro de preço** (input/output máx., $/1M — só participantes) + *compare:* Competidores (≥2); *variação/treino:* Modelo sob teste + prompt base + toggle de otimização + técnicas/variantes manuais | ≥2 competidores **ou** 1 modelo + ≥2 variantes |
| 4 | **Avaliação** | Gerador (1) + Juiz (1) — **podem ser o mesmo modelo** e veem o catálogo completo (não filtrados por área/preço); toggle "Juiz em 2 ordens" (modos de 1 LLM); "Ajustes avançados" | 1 gerador + 1 juiz |
| 5 | **Revisar** | Resumo (modo, nº de participantes, etapas, iterações, gerador, juiz, nº de chamadas) + **custo estimado** + tema | sempre válido |

**Defaults:** Etapas 5 · Max tokens 500 · Concorrência 8 · Timeout 60.000 ms · Iterações 3 ·
Competidores: 4 modelos GPT-5 · Gerador `deepseek/deepseek-v4-pro` · Juiz `moonshotai/kimi-k2.6`.
Faixas (steppers): Etapas 1–50, Max tokens 50–16.000 (passo 50), Concorrência 1–32, Timeout
1.000–300.000 (passo 1000), Iterações 2–10.

**Navegação:** rodapé com **← Voltar** e **Continuar →**; no último passo o botão vira
**🚀 Disparar os robôs** (ou *"Disparar o treino"*). A **trilha** no topo mostra o progresso
(número → ✓ quando concluído) e permite pular para qualquer passo já alcançável; clicar num passo
à frente que dependa de algo incompleto leva ao **primeiro passo pendente**, mostrando o que falta.
Validação por passo aparece num banner vermelho acima do rodapé; `Enter` fora do último passo
apenas avança o assistente (não dispara).

**Papéis e filtros:** os **participantes** (competidores / modelo sob teste) são filtrados por
**área (LGPD)** e por **preço** (input/output máx.); o **gerador** e o **juiz** veem o **catálogo
completo** (não são afetados por esses filtros) e **podem ser o mesmo modelo** (repetição
permitida). Competidores e gerador/juiz continuam mutuamente exclusivos (um modelo não é, ao mesmo
tempo, competidor e gerador/juiz); no variação/treino o juiz ainda não pode ser o modelo sob teste
(anti-viés). No passo 5, o botão é desabilitado durante o envio
(*"Disparando…"*); o backend revalida tudo (Zod) e, em sucesso, **navega para `/runs/:id`** (ou
`/training/:sessionId` no Treino), onde o acompanhamento ao vivo começa.

---

## Componente: ModelSelector

`web/src/components/ModelSelector.tsx`. Seletor de modelos com **busca fuzzy** e exibição de
**preços**. Usado três vezes na Nova Run (competidores, gerador, juiz).

**Partes:**

- **Rótulo** da seção (ex.: *"Competidores — 2 ou mais modelos"*).
- **Chips dos selecionados:** cada modelo vira um *chip* com o **id** e, abaixo, o **preço**
  formatado por **1 milhão de tokens** — `in $X / out $Y /1M`. Um **×** remove o chip.
  - Se o modelo selecionado ainda não está no catálogo carregado (ex.: um default), o chip
    mostra *"carregando…"* ou *"fora do catálogo?"* — mas **continua selecionado**.
- **Campo de busca:** placeholder muda conforme o modo:
  - múltiplo: *"Buscar modelo (ex.: \"claude sonnet\", \"gpt 4o mini\")"*;
  - único sem seleção: *"Escolher 1 modelo…"*;
  - único com seleção: *"Trocar modelo (apenas 1 permitido)…"*.
- **Dropdown de resultados:** abre ao focar/digitar; cada item mostra o **id** (em destaque), o
  **preço** in/out por 1M e o **nome** do modelo. Lista até 50 resultados; *"Nenhum modelo
  encontrado"* quando vazio.

**Busca fuzzy:** pontua por correspondência exata, prefixo, substring e *subsequência* (com
bônus para caracteres consecutivos e em fronteiras como `/ - _ . :`), penalizando ids muito
longos. Consulta com várias palavras exige que **todas** apareçam. O **id** pesa mais que o nome
(útil para algo como `anthropic/claude-3.5-sonnet`).

**Comportamento:**

- **Múltiplo** (`multi`): adiciona ao clicar; mantém aberto para escolher vários.
- **Único** (`multi={false}`): escolher **substitui** a seleção e fecha o dropdown.
- **Fechar:** clique fora, *toque* fora ou tecla **Esc**.
- Modelos já selecionados (e os excluídos pelos outros papéis) **não** aparecem na lista.
- Os modelos vêm de `GET /v1/benchmark/models`; enquanto carrega, o campo fica desabilitado com
  *"Carregando modelos…"*; em erro, exibe a mensagem ao lado.

---

## Tela: Histórico (`/runs`)

Tabela com todas as runs já executadas (`web/src/pages/RunsList.tsx`), mais recentes primeiro.

| Coluna | Conteúdo |
|---|---|
| **ID** | Primeiros 8 caracteres do id, em `code`, **linkando** para a Visão da Run |
| **Status** | *Badge* colorido: `running` / `finished` / `error` / `aborted` |
| **Tema** | Tema da run, truncado com reticências se longo |
| **Etapas** | Quantidade de etapas configuradas |
| **Competidores** | Quantos modelos competiram |
| **Custo** | `totalCostUsd` com 4 casas (ex.: `$0.0123`) |
| **Início** | Data/hora local de início |

Estados: *"Nenhuma run ainda."* quando vazio; banner vermelho em caso de erro de carregamento.

---

## Tela: Visão da Run (`/runs/:id`)

A tela mais rica (`web/src/pages/RunView.tsx`). As **etapas rodam todas em paralelo**, então a tela
tem dois momentos: **enquanto a run roda**, mostra um **visualizador de processo** (uma lista com
todas as etapas, seu status — gerando / respondendo / aguardando juiz / julgado — e os **previews ao
vivo** dos competidores em streaming, mais uma barra de progresso `X/N`); **quando a run termina**,
revela o **resultado completo** (classificação, heatmap, etapas detalhadas). O placar/heatmap **não**
aparecem no meio (com etapas terminando fora de ordem, um placar parcial seria enganoso). Layout do
resultado final, de cima para baixo:

```
Run a1b2c3d4                                    Status: running
clínica de diagnósticos…                        Etapas: 2/5
                                                Custo total: $0.0042
                                                JSON · CSV

[ banner de erro/abortada, se houver ]

CLASSIFICAÇÃO FINAL (1º AO ÚLTIMO)
Col. │ Modelo            │ Pontos │ 1ºs │ Pos. média │ Aceitável p/ o trabalho │ Erros
 1º  │ openai/gpt-5-mini │   6    │  2  │    1.33    │   3/3 etapas (100%)     │  0
 2º  │ openai/gpt-5-nano │   3    │  1  │    2.00    │   2/3 etapas (67%)      │  0
 …

HEATMAP DE POSIÇÕES
                      1   2   3   4   5
 openai/gpt-5-mini   [1] [1] [2] [·] [·]
 openai/gpt-5-nano   [2] [3] [1] [·] [·]
 …

ETAPAS
▸ Etapa 1 — Qual o tempo de jejum para…           [ julgado ]
▸ Etapa 2 — Posso tomar meu remédio de…           [ aguardando juiz ]
▾ Etapa 3 — …                                     [ julgado ]
    « corpo expandido da etapa »
```

### 1. Cabeçalho

- **Título** *"Run \<id curto\>"* + o **tema** logo abaixo (em *muted*).
- **Bloco de stats** à direita: **Status** (badge), **Etapas** `concluídas/total`,
  **Custo total** (formatado, com notação científica para valores ínfimos) e **links**
  **JSON** (abre o record bruto) e **CSV** (baixa o export).

### 2. Banners de estado

- Run com `status: error`: banner vermelho com *"A run falhou:"* + a mensagem.
- Run com `status: aborted`: banner explicando que o servidor reiniciou enquanto ela rodava.

### 3. Classificação final (placar)

Tabela `Col. · Modelo · Pontos · 1ºs · Pos. média · Aceitável p/ o trabalho · Erros`:

- **Col.** (coluna/colocação): *badge* numerado **1º, 2º…**, colorido do **verde** (topo) ao
  **vermelho** (fim) — `rankColor`.
- **Pontos:** soma do esquema N−1, N−2, … de todas as etapas.
- **1ºs:** quantas etapas o modelo venceu (posição 1 do juiz).
- **Pos. média:** média das posições (1-based); `—` se nunca ranqueado.
- **Aceitável p/ o trabalho:** `aceitáveis/avaliadas etapas (%)`, em **verde** se ≥ 50%,
  **vermelho** se < 50%; `—` se não houve avaliação.
- **Erros:** nº de etapas em que aquele modelo deu erro (vermelho se > 0).
- Ordenação: pontos → posição média → nº de 1ºs → id.
- Abaixo, uma **legenda** *muted* explica a pontuação e o conceito de "aceitável".

### 4. Heatmap de posições

Grade: uma **linha por competidor**, uma **coluna por etapa**. Cada célula traz a **posição**
do modelo naquela etapa, com **cor** do verde (1º) ao vermelho (último); `·` (cinza) = não
ranqueado. *Tooltip* no *hover* mostra *"Etapa N: posição"*. Rola horizontalmente se houver
muitas etapas. É a leitura visual rápida de "quem foi consistente".

### 5. Etapas (cartões colapsáveis)

Cada etapa é um **StageCard**. O **cabeçalho** (clicável para abrir/fechar) mostra
*"Etapa N"* + um trecho da pergunta (ou *"gerando…"* / *"falhou (pulada)"*) e um **badge** de
estado:

| Badge | Significado |
|---|---|
| **julgado** (verde) | Juiz concluiu o ranking |
| **aguardando juiz** (âmbar) | Competidores responderam, juiz ainda não |
| **inconclusivo** (cinza) | Juiz não conseguiu ranquear |
| **falhou** (cinza) | Etapa pulada (datagen/imprevisto) |

> Etapas **abrem automaticamente** quando começam a gerar/responder, para você acompanhar ao vivo.

**Corpo expandido**, na ordem:

1. **Banner de etapa pulada** (se aplicável): *"Etapa pulada: …"* + nota de que a run seguiu normal.
2. **Pergunta** — o `question` do cenário.
3. **Contexto de produto** — o `productContext` num bloco `pre` rolável (era o *system prompt*
   dos competidores).
4. **Avaliação qualitativa** (quando disponível): badge **vencedor** + id do vencedor + os
   **motivos** de ter vencido. Se indisponível: *"Avaliação qualitativa indisponível nesta etapa."*
5. **Respostas:**
   - **Progresso ao vivo** (durante a etapa): para cada competidor ainda gerando, um *card* com
     borda azul mostrando o **id**, **contadores** (`chars · ch/s`) num *badge* azul, e um
     **preview** rolável com os últimos ~240 caracteres do texto que está sendo gerado.
   - **Respostas finais** (ordenadas pelo ranking do juiz), cada uma com:
     - **rank badge** `#1`, `#2`… colorido por posição;
     - **id** do modelo + a **letra cega** com que foi julgado — *"(era A)"*;
     - **veredito** do avaliador: badge **aceitável p/ o trabalho** (verde) ou **não aceitável**
       (vermelho);
     - **meta** em *muted*: `latência · tokensIn→tokensOut tok · nº chars · custo` (e, se deu
       erro, `· ERRO: mensagem` em vermelho);
     - **justificativa** do veredito (citação à esquerda, *muted*);
     - **texto completo** da resposta num bloco `pre` rolável (respostas com erro não exibem texto).

---

## Comportamento em tempo real

A Visão da Run abre um **`EventSource`** para `/runs/:id/events` e aplica cada evento ao estado
local (sem recarregar). O mapeamento evento → UI:

| Evento SSE | Efeito na tela |
|---|---|
| `snapshot` | Carrega/repõe o estado completo da run |
| `stage.generating` | Cria/abre a etapa; cabeçalho vira *"gerando…"* |
| `stage.generated` | Preenche **Pergunta** e **Contexto de produto** |
| `competitor.started` | Abre a etapa; cria o *card* de progresso ao vivo do modelo |
| `competitor.progress` | Atualiza contadores (`chars`, `ch/s`) e o *preview* ao vivo |
| `competitor.finished` | Substitui o *card* ao vivo pela **resposta final**; soma custo |
| `stage.judging` | Etapa passa a *"aguardando juiz"* |
| `stage.judged` | Marca a etapa como *"julgado"* no monitor de processo (o **placar/heatmap** só são montados no fim) |
| `stage.failed` | Marca a etapa como **pulada** (badge *"falhou"*) |
| `run.finished` / `run.error` | Estado final; revela os resultados; o `EventSource` é fechado |

Como as etapas rodam **em paralelo**, vários `stage.*`/`competitor.*` chegam **concorrentemente** —
o reducer aplica cada um ao seu `stageIndex` isolado, então o monitor mostra várias etapas ativas ao
mesmo tempo. Se a conexão SSE cair, a tela faz um *fetch* de fallback para se ressincronizar.
Runs **já terminadas** não mantêm stream aberto — o servidor envia o estado final e encerra.

---

## Legenda de cores e badges

**Status da run** (badge em Histórico e na Visão da Run):

| Status | Cor |
|---|---|
| `running` | âmbar |
| `finished` | verde |
| `error` | vermelho |
| `aborted` | cinza |

**Posição/colocação** (rank badges, células do heatmap): gradiente contínuo **verde → vermelho**
calculado por `rankColor(posição, total)` — verde = melhor, vermelho = pior, cinza = não ranqueado.

**Vereditos do avaliador:** verde = **aceitável p/ o trabalho**; vermelho = **não aceitável**.

**Badges de etapa:** verde *julgado* · âmbar *aguardando juiz* · cinza *inconclusivo* / *falhou*.

---

## Console do navegador

Além da UI, o cliente faz **log estruturado e rico** no DevTools (`web/src/api.ts`,
`openRunStream`) — útil para depurar uma run sem poluir a tela:

- conexão/início/fim da run e status;
- *"gerando cenário…"* e, em grupo recolhível, o **cenário completo** (pergunta, contexto,
  maxTokens) a cada `stage.generated`;
- progresso por competidor (`chars` e `ch/s`) e o resultado final (ok com nº de tokens, ou
  **ERRO** com a mensagem);
- ao julgar, um grupo com o **ranking**, o **vencedor**, os **motivos** e a lista de vereditos
  (✅ aceitável / ❌ não aceitável) por modelo;
- avisos quando uma etapa é **pulada** ou a avaliação fica **inconclusiva**.
