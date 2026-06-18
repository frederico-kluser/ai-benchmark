import { randomUUID } from 'node:crypto';
import { runToCompletion } from './orchestrator.js';
import { generateContestants } from './variator.js';
import { chatCompletion } from './openrouter.js';
import { emitSessionEvent } from './events.js';
import { saveSession } from './storage.js';
import type {
  Contestant,
  RunRecord,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  VariationConfig,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function log(sessionId: string, msg: string): void {
  console.log(`[train ${sessionId}] ${msg}`);
}

/** Escolhe a vencedora: mais pontos -> mais etapas aceitaveis -> ordem (1a vence empate). */
function pickWinner(run: RunRecord): { contestantId: string; points: number } | null {
  if (!run.contestants.length) return null;
  const acc: Record<string, number> = {};
  for (const s of run.stages) {
    for (const [cid, ok] of Object.entries(s.judge?.acceptableByContestant ?? {})) {
      if (ok) acc[cid] = (acc[cid] ?? 0) + 1;
    }
  }
  let bestId = '';
  let bestPoints = -Infinity;
  let bestAcc = -Infinity;
  let chosen = false;
  for (const c of run.contestants) {
    const points = run.scoreboard[c.id] ?? 0;
    const a = acc[c.id] ?? 0;
    if (!chosen || points > bestPoints || (points === bestPoints && a > bestAcc)) {
      bestId = c.id;
      bestPoints = points;
      bestAcc = a;
      chosen = true;
    }
  }
  return chosen ? { contestantId: bestId, points: bestPoints } : null;
}

export interface AnalyzeIterationParams {
  apiKey: string;
  optimizerModelId: string;
  run: RunRecord;
  winnerContestantId: string;
  timeoutMs?: number;
}

/**
 * Analisa onde a vencedora ganhou/perdeu (ranking + vereditos + respostas) e
 * devolve uma critica concisa e acionavel para guiar a proxima geracao.
 */
export async function analyzeIteration(p: AnalyzeIterationParams): Promise<string> {
  const winner = p.run.contestants.find((c) => c.id === p.winnerContestantId);
  const lines: string[] = [];
  for (const s of p.run.stages) {
    if (!s.spec) continue;
    const ranking = s.judge?.rankedContestantIds ?? [];
    const pos = ranking.indexOf(p.winnerContestantId);
    const total = ranking.length;
    const acceptable = s.judge?.acceptableByContestant?.[p.winnerContestantId];
    // motivos curtos dos juizes para a vencedora (1 frase cada).
    const motivos = (s.judge?.judges ?? [])
      .map((j) => j.verdicts.find((v) => v.contestantId === p.winnerContestantId)?.motivo)
      .filter((m): m is string => Boolean(m && m.trim()));
    const topId = ranking[0];
    const topResp =
      topId && topId !== p.winnerContestantId
        ? s.responses.find((r) => r.contestantId === topId)
        : undefined;
    lines.push(
      `Etapa ${s.index + 1}: pos=${pos >= 0 ? pos + 1 : '?'}/${total}; aceitavel=${
        acceptable === undefined ? '?' : acceptable
      }; ${motivos.join(' | ')}` +
        (topResp ? ` | resposta que superou: ${topResp.text.slice(0, 220)}` : ''),
    );
  }

  const userPrompt = `SYSTEM PROMPT VENCEDOR desta iteracao:
${winner?.systemPrompt ?? '(desconhecido)'}

DESEMPENHO POR ETAPA:
${lines.join('\n')}

Liste de forma concisa (bullets) as fraquezas do prompt vencedor e mudancas ACIONAVEIS no system prompt para melhorar nas etapas onde ele perdeu ou foi "nao aceitavel". Nao reescreva o prompt; so aponte o que mudar.`;

  const result = await chatCompletion({
    apiKey: p.apiKey,
    modelId: p.optimizerModelId,
    messages: [
      { role: 'system', content: 'Voce e um analista de prompts. Seja conciso e acionavel.' },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    timeoutMs: p.timeoutMs ?? 90_000,
  });
  return result.text.trim();
}

export interface StartTrainingResult {
  sessionId: string;
  record: SessionRecord;
}

export async function startTraining(
  config: TrainingConfig,
  apiKey: string,
): Promise<StartTrainingResult> {
  const sessionId = randomUUID();
  const record: SessionRecord = {
    id: sessionId,
    status: 'running',
    config,
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: nowIso(),
  };
  // Persiste ANTES de responder ao cliente, para a TrainingView nunca pegar 404.
  await saveSession(record);
  void trainingLoop(record, apiKey).catch(async (err) => {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveSession(record).catch(() => undefined);
    emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
  });
  return { sessionId, record };
}

function variationConfigFrom(cfg: TrainingConfig): VariationConfig {
  return {
    mode: 'variation',
    theme: cfg.theme,
    stages: cfg.stages,
    datagenModelId: cfg.datagenModelId,
    judgeModelIds: cfg.judgeModelIds,
    concurrency: cfg.concurrency,
    timeoutMs: cfg.timeoutMs,
    maxOutputTokens: cfg.maxOutputTokens,
    promptOptimization: cfg.promptOptimization,
    optimizerModelId: cfg.optimizerModelId,
    judgePasses: cfg.judgePasses,
    contestantModelId: cfg.contestantModelId,
    basePrompt: cfg.basePrompt,
    techniqueIds: cfg.techniqueIds,
    manualVariants: cfg.manualVariants,
  };
}

async function trainingLoop(record: SessionRecord, apiKey: string): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
  const promptOptimization = cfg.promptOptimization !== false;
  const hasBase = Boolean(cfg.basePrompt && cfg.basePrompt.trim());

  await saveSession(record);
  emitSessionEvent({ type: 'session.started', sessionId, record });
  log(sessionId, `started: ${cfg.iterations} iteracoes`);

  let pinnedStages: StageSpec[] | undefined;
  let prevRun: RunRecord | undefined;
  let prevWinner: { contestantId: string; systemPrompt: string; label: string } | undefined;

  try {
    for (let i = 0; i < cfg.iterations; i++) {
      // 1) Resolve as variantes desta iteracao.
      let contestants: Contestant[];
      if (i === 0) {
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          basePrompt: cfg.basePrompt,
          originalPrompt: cfg.basePrompt,
          includeOriginal: hasBase,
          techniqueIds: cfg.techniqueIds,
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          timeoutMs: cfg.timeoutMs,
        });
      } else {
        emitSessionEvent({ type: 'iteration.analyzing', sessionId, iteration: i, runId: prevRun!.id });
        const hint = await analyzeIteration({
          apiKey,
          optimizerModelId,
          run: prevRun!,
          winnerContestantId: prevWinner!.contestantId,
          timeoutMs: cfg.timeoutMs,
        }).catch(() => '');
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          basePrompt: prevWinner!.systemPrompt,
          originalPrompt: cfg.basePrompt,
          carryPrompt: prevWinner!.systemPrompt,
          carryLabel: `Melhor it.${i}`,
          carryParentId: prevWinner!.contestantId,
          includeOriginal: hasBase,
          techniqueIds: cfg.techniqueIds,
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          analysisHint: hint,
          timeoutMs: cfg.timeoutMs,
        });
      }

      if (contestants.length < 2) {
        throw new Error(`Iteracao ${i + 1}: variantes insuficientes (${contestants.length}).`);
      }

      // 2) Roda a iteracao (benchmark pinado a partir da iteracao 1).
      const runId = randomUUID();
      record.runIds.push(runId);
      await saveSession(record);
      emitSessionEvent({ type: 'iteration.started', sessionId, iteration: i, runId });
      log(sessionId, `iteracao ${i + 1}/${cfg.iterations} -> run ${runId} (${contestants.length} variantes)`);

      const runRec = await runToCompletion(variationConfigFrom(cfg), apiKey, {
        runId,
        contestants,
        pinnedStages,
        sessionId,
        iteration: i,
        parentRunId: prevRun?.id,
      });

      record.totalCostUsd += runRec.totalCostUsd;

      // 3) Pina o benchmark depois da iteracao 0 (mesmas perguntas em todas).
      if (i === 0) {
        pinnedStages = runRec.stages
          .map((s) => s.spec)
          .filter((s): s is StageSpec => Boolean(s));
        record.pinnedStages = pinnedStages;
      }

      // 4) Vencedora -> base da proxima.
      const winner = pickWinner(runRec);
      if (winner) {
        const wc = runRec.contestants.find((c) => c.id === winner.contestantId);
        const sp = wc?.systemPrompt ?? prevWinner?.systemPrompt ?? cfg.basePrompt ?? '';
        prevWinner = {
          contestantId: winner.contestantId,
          systemPrompt: sp,
          label: wc?.label ?? winner.contestantId,
        };
        record.bestPromptByIteration.push({
          iteration: i,
          runId: runRec.id,
          winnerContestantId: winner.contestantId,
          systemPrompt: sp,
          score: winner.points,
        });
      } else if (!prevWinner) {
        prevWinner = { contestantId: 'original', systemPrompt: cfg.basePrompt ?? '', label: 'Original' };
      }

      prevRun = runRec;
      emitSessionEvent({
        type: 'iteration.finished',
        sessionId,
        iteration: i,
        runId: runRec.id,
        winnerContestantId: prevWinner?.contestantId ?? '',
      });
      await saveSession(record);
    }

    record.status = 'finished';
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.finished', sessionId, record });
    log(sessionId, `finished: custo ${record.totalCostUsd}`);
  } catch (err) {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
    log(sessionId, `error: ${record.error}`);
  }
}
