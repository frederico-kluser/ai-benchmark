export interface OpenRouterModelPricing {
  prompt: number; // USD per token
  completion: number; // USD per token
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: OpenRouterModelPricing;
  raw?: unknown;
}

export interface RunConfig {
  theme: string;
  stages: number;
  competitorModelIds: string[];
  datagenModelId: string;
  judgeModelId: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Cap absoluto de max_tokens da resposta dos competidores. Sobrepoe o sugerido pelo datagen. */
  maxOutputTokens?: number;
}

export interface StageSpec {
  question: string;
  productContext: string;
  maxTokens: number;
}

export type CompetitorStatus = 'ok' | 'error';

export interface CompetitorResponse {
  modelId: string;
  text: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: CompetitorStatus;
  errorMsg?: string;
}

export interface JudgeResult {
  rankedModelIds: string[]; // best -> worst
  blindMap: Record<string, string>; // letter -> modelId
  rawJudgeText: string;
  inconclusive?: boolean;
}

/** Veredito de aceitabilidade de UMA resposta para uso real no trabalho. */
export interface EvaluationVerdict {
  modelId: string;
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
  bestModelId: string; // vencedor segundo a avaliacao qualitativa
  bestReasons: string; // motivos do vitorioso
  verdicts: EvaluationVerdict[];
  blindMap: Record<string, string>; // letter -> modelId (avaliacao cega)
  raw: string;
  inconclusive?: boolean;
}

export interface CompetitorLiveState {
  modelId: string;
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
  /** Estado ao vivo dos competidores nesta etapa; limpo apos stage.judged. */
  live?: Record<string, CompetitorLiveState>;
  judge?: JudgeResult;
  /** Avaliacao qualitativa (paralela ao juiz): motivos do vencedor + aceitabilidade. */
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
  stages: StageRecord[];
  scoreboard: Record<string, number>; // modelId -> wins points (N-1 for first, ...)
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export type RunEvent =
  | { type: 'run.started'; runId: string; record: RunRecord }
  | { type: 'stage.generating'; runId: string; stageIndex: number }
  | { type: 'stage.generated'; runId: string; stageIndex: number; spec: StageSpec }
  | { type: 'stage.failed'; runId: string; stageIndex: number; error: string }
  | { type: 'competitor.started'; runId: string; stageIndex: number; modelId: string }
  | {
      type: 'competitor.progress';
      runId: string;
      stageIndex: number;
      modelId: string;
      chars: number;
      charsPerSec: number;
      preview: string;
    }
  | { type: 'competitor.finished'; runId: string; stageIndex: number; response: CompetitorResponse }
  | { type: 'stage.judging'; runId: string; stageIndex: number }
  | { type: 'stage.judged'; runId: string; stageIndex: number; judge: JudgeResult; evaluation?: StageEvaluation; scoreboard: Record<string, number>; totalCostUsd: number }
  | { type: 'run.finished'; runId: string; record: RunRecord }
  | { type: 'run.error'; runId: string; error: string };
