export interface OpenRouterModelPricing {
  prompt: number; // USD per token
  completion: number; // USD per token
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: OpenRouterModelPricing;
  /**
   * Parametros de amostragem que o modelo aceita (campo `supported_parameters`
   * do OpenRouter). Fonte de verdade para enviar `temperature`/`seed` so a quem
   * suporta — reasoning models (gpt-5*, serie o*) NAO listam `temperature` e
   * respondem vazio (HTTP 400) se ela for enviada. Ausente = desconhecido.
   */
  supportedParameters?: string[];
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// Modos de run e o conceito de "contestant"
// ----------------------------------------------------------------------------

export type RunMode = 'compare' | 'variation' | 'training';

/**
 * Um competidor genérico. No modo `compare`, cada contestant e um modelo
 * distinto (id === modelId, sem systemPrompt). Nos modos `variation`/`training`,
 * todos os contestants compartilham o MESMO modelId e diferem pelo `systemPrompt`
 * (a variacao do prompt sendo testada).
 */
export interface Contestant {
  /** Chave estavel. compare: === modelId. variation/training: "v0".."vN" | "original". */
  id: string;
  /** Rotulo humano: nome da tecnica, "Original (controle)", ou o proprio modelId (compare). */
  label: string;
  /** Modelo real OpenRouter (usado para preco/getModel). */
  modelId: string;
  /** Override do system message; ausente => usa stage.productContext (compare). */
  systemPrompt?: string;
  /** Tecnica da biblioteca que gerou esta variante (ausente = verbatim/original). */
  techniqueId?: string;
  /** true = o prompt base do usuario, rodado como controle. */
  isOriginal?: boolean;
  /** Lineage de treino: contestant vencedor de onde esta variante derivou. */
  parentContestantId?: string;
}

/** Variacao de prompt fornecida manualmente (toggle de otimizacao desligado). */
export interface ManualVariant {
  label: string;
  systemPrompt: string;
}

/** Tecnica de variacao de prompt da biblioteca curada (`src/techniques.ts`). */
export interface PromptTechnique {
  id: string;
  name: string;
  /** Nivel de confianca da evidencia (revisao sistematica): alta/media/baixa. Opcional no acervo interno; sempre preenchido por listTechniques(). */
  confidence?: 'alta' | 'media' | 'baixa';
  /** Por que a tecnica ajuda. */
  good: string;
  /** Quando a tecnica atrapalha. */
  bad: string;
  /** Meta-instrucao entregue ao optimizer (NAO exposta ao front). */
  metaInstruction: string;
}
/** Tecnica sem o meta-prompt — o que `GET /techniques` expoe. */
export type PublicTechnique = Omit<PromptTechnique, 'metaInstruction'>;

// ----------------------------------------------------------------------------
// Config da run (uniao discriminada por `mode`)
// ----------------------------------------------------------------------------

export interface RunConfigBase {
  theme: string;
  stages: number;
  datagenModelId: string;
  /** Um ou mais juizes — rodam em paralelo (gateados pelo limitador global). */
  judgeModelIds: string[];
  concurrency?: number;
  timeoutMs?: number;
  /** Cap absoluto de max_tokens da resposta dos competidores. */
  maxOutputTokens?: number;
  /** Liga/desliga a geracao automatica de variacoes por LLM (variation/training). */
  promptOptimization?: boolean;
  /** Meta-modelo que gera variacoes e analisa no treino. Default = datagenModelId. */
  optimizerModelId?: string;
  /** Passes do juiz: 2 = avalia em duas ordens e media (anti-vies de posicao). Default 1. */
  judgePasses?: 1 | 2;
  /**
   * Perfil de conformidade LGPD escolhido no assistente (passo Tema). CONSULTIVO:
   * gravado para transparencia/rastreabilidade do run; NAO forca roteamento de
   * providers no OpenRouter. Ausente = "livre" (sem filtro de conformidade).
   */
  compliance?: { area: string; includeRessalvas: boolean };
  /**
   * Etapas fornecidas pelo usuario (JSON), substituindo o datagen automatico.
   * Quando presente e nao-vazio, o pipeline PULA a geracao de cenarios e usa
   * estas specs verbatim; `stages` passa a valer o tamanho desta lista. Cada
   * etapa traz a pergunta, o contexto de produto e (opcional) a `rubric` que
   * ancora os juizes. Vale para todos os modos; no treino, vira o benchmark
   * pinado (mesmas etapas em todas as iteracoes).
   */
  customStages?: StageSpec[];
}

/** Campos comuns aos modos de 1 LLM (variation/training). */
export interface SingleModelFields {
  /** O unico modelo sob teste (eixo contestant). */
  contestantModelId: string;
  /** Prompt base opcional; ausente => variacoes partem do tema. */
  basePrompt?: string;
  /** Tecnicas selecionadas (quando promptOptimization=true). */
  techniqueIds?: string[];
  /** Variacoes verbatim (quando promptOptimization=false). */
  manualVariants?: ManualVariant[];
}

export interface CompareConfig extends RunConfigBase {
  mode: 'compare';
  competitorModelIds: string[];
}
export interface VariationConfig extends RunConfigBase, SingleModelFields {
  mode: 'variation';
}
export interface TrainingConfig extends RunConfigBase, SingleModelFields {
  mode: 'training';
  /** Numero fixo de iteracoes. */
  iterations: number;
}
export type RunConfig = CompareConfig | VariationConfig | TrainingConfig;

// ----------------------------------------------------------------------------

export interface StageSpec {
  question: string;
  productContext: string;
  maxTokens: number;
  /**
   * Criterio de corretude desta etapa: o que uma boa resposta DEVE conter/fazer
   * e o que a tornaria inaceitavel. Quando presente, e injetado no juiz como
   * RUBRICA ANCORADA (estilo G-Eval) — ancora a nocao de "correto" num criterio
   * explicito em vez de deixar o juiz inventar o seu, mitigando reward-hacking.
   * Em etapas fornecidas pelo usuario (customStages) e a "explicacao do que a
   * etapa resolve"; o datagen tambem pode gera-la automaticamente.
   */
  rubric?: string;
}

export type CompetitorStatus = 'ok' | 'error';

export interface CompetitorResponse {
  /** Chave universal. compare: === modelId. */
  contestantId: string;
  modelId: string;
  text: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: CompetitorStatus;
  errorMsg?: string;
}

/**
 * Veredito TERNARIO de uma etapa: a resposta resolve a tarefa, resolve
 * parcialmente, ou nao resolve. Mais robusto que o binario como portao de
 * qualidade (G-Eval / score absoluto como filtro). Ordem implicita: nao < parcial < resolve.
 */
export type Verdict = 'resolve' | 'parcial' | 'nao';

/** Veredito COMPACTO de UM juiz para UMA resposta: justificativa + veredito ternario. */
export interface JudgeVerdict {
  contestantId: string;
  /** Veredito ternario: resolve / parcial / nao. */
  verdict: Verdict;
  /**
   * Justificativa do juiz — gerada ANTES da classificacao (estilo G-Eval:
   * raciocinio primeiro, rotulo depois). Curta (1-2 frases).
   */
  motivo: string;
  /** @deprecated compat: records antigos guardavam so o binario. Derive de `verdict`. */
  acceptable?: boolean;
}

/** Resultado compacto de UM juiz numa etapa: ranking + vereditos. */
export interface SingleJudgeResult {
  judgeModelId: string;
  /** Melhor -> pior, por contestantId (deste juiz). */
  rankedContestantIds: string[];
  /** Aceitabilidade por resposta (deste juiz). */
  verdicts: JudgeVerdict[];
  /** letra -> contestantId desta avaliacao (cosmetico p/ a UI "(era X)"). */
  blindMap: Record<string, string>;
  inconclusive?: boolean;
}

/**
 * Resultado do estagio de julgamento (UM ou MAIS juizes). Compacto: cada juiz
 * devolve ranking + aceitavel/motivo por resposta. Agregamos um CONSENSO de
 * ranking (posicao media) e a aceitabilidade por MAIORIA dos juizes; guardamos
 * tambem o resultado individual de cada juiz (placar aditivo + justificativas).
 */
export interface JudgeResult {
  /** Consenso entre juizes (posicao media): melhor -> pior. Placar/heatmap/CSV usam isto. */
  rankedContestantIds: string[];
  /**
   * Aceitavel por contestant (compat/placar): MAIORIA dos juizes; derivado do
   * ternario (resolve|parcial => aceitavel). Respostas com erro/vazias = false.
   */
  acceptableByContestant: Record<string, boolean>;
  /** Veredito TERNARIO agregado por contestant (consenso entre juizes). Ausente em records antigos. */
  verdictByContestant?: Record<string, Verdict>;
  /** Resultado individual de cada juiz (placar aditivo por juiz + justificativas na UI). */
  judges: SingleJudgeResult[];
  blindMap: Record<string, string>; // letra -> contestantId (do 1o juiz; cosmetico)
  rawJudgeText: string;
  inconclusive?: boolean;
}

/**
 * @deprecated O avaliador foi fundido no juiz (ver JudgeResult). Tipo mantido
 * apenas para LER records antigos que tinham um estagio de avaliacao separado.
 */
export interface EvaluationVerdict {
  contestantId: string;
  /** true = utilizavel em producao sem causar erro/dano, mesmo nao sendo a melhor. */
  acceptable: boolean;
  justification: string;
}

/**
 * Avaliacao QUALITATIVA da etapa, rodada em paralelo com o juiz de ranking.
 * Explica por que o vencedor venceu e classifica cada resposta como
 * aceitavel ou nao para o trabalho (mesmo que nao seja a ideal).
 */
export interface StageEvaluation {
  bestContestantId: string; // vencedor segundo a avaliacao qualitativa
  bestReasons: string; // motivos do vitorioso
  verdicts: EvaluationVerdict[];
  blindMap: Record<string, string>; // letra -> contestantId (avaliacao cega)
  raw: string;
  inconclusive?: boolean;
}

export interface CompetitorLiveState {
  contestantId: string;
  modelId: string;
  label?: string;
  startedAt: number; // epoch ms
  chars: number;
  charsPerSec: number;
  preview: string; // ultimos N chars do texto gerado
  done: boolean;
}

export interface StageRecord {
  index: number;
  spec?: StageSpec;
  responses: CompetitorResponse[];
  /** Estado ao vivo dos competidores nesta etapa (por contestantId); limpo apos stage.judged. */
  live?: Record<string, CompetitorLiveState>;
  judge?: JudgeResult;
  /** @deprecated Avaliador fundido no juiz. Presente so em records antigos. */
  evaluation?: StageEvaluation;
  /** Preenchido quando a etapa falhou (ex.: datagen) e foi pulada sem matar a run. */
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type RunStatus = 'running' | 'finished' | 'error' | 'aborted';

export interface RunRecord {
  id: string;
  status: RunStatus;
  config: RunConfig;
  mode: RunMode; // denormalizado para listagem barata
  contestants: Contestant[]; // fonte de verdade para heatmap/standings
  stages: StageRecord[];
  scoreboard: Record<string, number>; // contestantId -> wins points (N-1 for first, ...)
  /** Custo acumulado por contestant (opcional, p/ painel de variantes). */
  costByContestant?: Record<string, number>;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  // Lineage de treino (ausente em compare/variation):
  sessionId?: string;
  iteration?: number; // 0-based
  parentRunId?: string;
}

// ----------------------------------------------------------------------------
// Sessao de treino (encadeia varias runs)
// ----------------------------------------------------------------------------

export interface SessionIterationSummary {
  iteration: number;
  runId: string;
  winnerContestantId: string;
  systemPrompt: string;
  /** Retrocompat: no de OUROS da vencedora (antes era pontos aditivos do placar). */
  score: number;
  /** Quadro de medalhas da vencedora: [0]=ouro,[1]=prata,[2]=bronze,... (ausente em sessoes antigas). */
  medals?: number[];
  golds?: number;
  silvers?: number;
  bronzes?: number;
}

export interface SessionRecord {
  id: string;
  status: RunStatus;
  config: TrainingConfig;
  runIds: string[]; // ordenados por iteracao
  pinnedStages?: StageSpec[]; // congelado apos a iteracao 0
  bestPromptByIteration: SessionIterationSummary[];
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

// ----------------------------------------------------------------------------
// Eventos
// ----------------------------------------------------------------------------

export type RunEvent =
  | { type: 'run.started'; runId: string; record: RunRecord }
  | { type: 'variants.generating'; runId: string }
  | { type: 'variants.generated'; runId: string; contestants: Contestant[] }
  | { type: 'stage.generating'; runId: string; stageIndex: number }
  | { type: 'stage.generated'; runId: string; stageIndex: number; spec: StageSpec }
  | { type: 'stage.failed'; runId: string; stageIndex: number; error: string }
  | { type: 'competitor.started'; runId: string; stageIndex: number; contestantId: string; modelId: string }
  | {
      type: 'competitor.progress';
      runId: string;
      stageIndex: number;
      contestantId: string;
      modelId: string;
      chars: number;
      charsPerSec: number;
      preview: string;
    }
  | { type: 'competitor.finished'; runId: string; stageIndex: number; response: CompetitorResponse }
  | { type: 'stage.judging'; runId: string; stageIndex: number }
  | {
      type: 'stage.judged';
      runId: string;
      stageIndex: number;
      judge: JudgeResult;
      scoreboard: Record<string, number>;
      totalCostUsd: number;
    }
  | { type: 'run.finished'; runId: string; record: RunRecord }
  | { type: 'run.error'; runId: string; error: string };

export type SessionEvent =
  | { type: 'session.started'; sessionId: string; record: SessionRecord }
  | { type: 'iteration.started'; sessionId: string; iteration: number; runId: string }
  | { type: 'iteration.analyzing'; sessionId: string; iteration: number; runId: string }
  | {
      type: 'iteration.finished';
      sessionId: string;
      iteration: number;
      runId: string;
      winnerContestantId: string;
    }
  | { type: 'session.finished'; sessionId: string; record: SessionRecord }
  | { type: 'session.error'; sessionId: string; error: string };
