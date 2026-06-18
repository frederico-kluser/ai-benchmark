import { chatCompletionStream, computeCost, getModel } from './openrouter';
import type { CompetitorResponse, StageSpec } from './types';

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
    onProgress,
  } = params;

  const model = await getModel(apiKey, modelId).catch(() => undefined);

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
        temperature: 0,
        maxTokens: effectiveMaxTokens,
        timeoutMs,
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
        costUsd: computeCost(res.tokensIn, res.tokensOut, model),
        status: 'ok',
      };
    } catch (err) {
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
