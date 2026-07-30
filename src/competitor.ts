import { chatCompletionStream } from './openrouter.js';
import { isControlSignal } from './budget.js';
import type { CompetitorResponse, ReasoningLevel, RunCtx, StageSpec } from './types.js';

export interface RunCompetitorParams {
  apiKey: string;
  /** Chave estavel do competidor. compare: === modelId. */
  contestantId: string;
  modelId: string;
  /** Override do system message; ausente => usa stage.productContext. */
  systemPrompt?: string;
  stage: StageSpec;
  timeoutMs?: number;
  retries?: number;
  maxOutputTokens?: number;
  /** Temperatura deste contestant (compare-llms: parte da tripla de identidade). Default 0. */
  temperature?: number;
  /**
   * Nivel de reasoning ja RESOLVIDO pelo chamador (orquestrador aplica a
   * prioridade contestant.reasoningLevel ?? config.reasoning.competitor).
   */
  reasoningLevel?: ReasoningLevel;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  /** Teto por requisicao (USD por MILHAO de tokens). */
  maxPricePerMTok?: { prompt?: number; completion?: number };
  onProgress?: (chars: number, charsPerSec: number, preview: string) => void;
}

const PREVIEW_TAIL_CHARS = 240;

export async function runCompetitor(params: RunCompetitorParams): Promise<CompetitorResponse> {
  const {
    apiKey,
    contestantId,
    modelId,
    systemPrompt,
    stage,
    timeoutMs = 60_000,
    retries = 1,
    maxOutputTokens,
    temperature = 0,
    reasoningLevel,
    ctx,
    maxPricePerMTok,
    onProgress,
  } = params;

  const effectiveMaxTokens =
    typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? Math.min(maxOutputTokens, stage.maxTokens)
      : stage.maxTokens;

  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    const start = Date.now();
    try {
      const res = await chatCompletionStream({
        apiKey,
        modelId,
        messages: [
          { role: 'system', content: systemPrompt ?? stage.productContext },
          { role: 'user', content: stage.question },
        ],
        // deterministicSampling (openrouter.ts) so envia temperature a quem
        // suporta — reasoning models ignoram sem quebrar.
        temperature,
        reasoningLevel,
        maxTokens: effectiveMaxTokens,
        timeoutMs,
        role: 'competitor',
        signal: ctx?.signal,
        sink: ctx?.sink,
        maxPricePerMTok,
        onDelta: (_delta, fullText) => {
          if (!onProgress) return;
          const elapsedSec = Math.max(0.001, (Date.now() - start) / 1000);
          const charsPerSec = fullText.length / elapsedSec;
          const preview =
            fullText.length > PREVIEW_TAIL_CHARS
              ? '…' + fullText.slice(-PREVIEW_TAIL_CHARS)
              : fullText;
          onProgress(fullText.length, charsPerSec, preview);
        },
      });

      return {
        contestantId,
        modelId,
        text: res.text,
        latencyMs: res.latencyMs,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        // Custo EXATO vindo de `usage.cost` (fallback: catalogo). Antes era
        // sempre derivado do catalogo, ignorando cache e faixas de preco.
        costUsd: res.cost.usd,
        status: 'ok',
      };
    } catch (err) {
      // Orcamento/cancelamento sao SINAIS DE CONTROLE: repetir a chamada so
      // gastaria mais, e devolver status 'error' faria a run parecer completa
      // com um competidor "que falhou". Sai do laco propagando.
      if (isControlSignal(err)) throw err;
      lastError = err;
      attempt += 1;
      console.error(`[competitor ${modelId}] tentativa ${attempt} falhou:`, err);
    }
  }

  return {
    contestantId,
    modelId,
    text: '',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    status: 'error',
    errorMsg: lastError instanceof Error ? lastError.message : String(lastError),
  };
}
