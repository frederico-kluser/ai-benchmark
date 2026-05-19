import { randomUUID } from 'node:crypto';
import { generateStage } from './datagen.js';
import { runCompetitor } from './competitor.js';
import { judgeStage } from './judge.js';
import { evaluateStage } from './evaluator.js';
import { emitEvent } from './events.js';
import { saveRun } from './storage.js';
import type {
  CompetitorResponse,
  RunConfig,
  RunRecord,
  StageRecord,
  StageSpec,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function log(runId: string, msg: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[bench ${runId}] ${msg}${payload}`);
}

async function runWithLimit<T>(
  items: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await items[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

function applyScoreboard(
  scoreboard: Record<string, number>,
  rankedModelIds: string[],
): void {
  // pontos: melhor recebe N-1, proximo N-2, ... pior 0
  const n = rankedModelIds.length;
  rankedModelIds.forEach((modelId, idx) => {
    const points = n - 1 - idx;
    scoreboard[modelId] = (scoreboard[modelId] ?? 0) + points;
  });
}

export interface StartRunResult {
  runId: string;
  record: RunRecord;
}

export function startRun(config: RunConfig, apiKey: string): StartRunResult {
  const runId = randomUUID();
  const concurrency = Math.max(1, config.concurrency ?? 8);
  const timeoutMs = config.timeoutMs ?? 60_000;

  const record: RunRecord = {
    id: runId,
    status: 'running',
    config: { ...config, concurrency, timeoutMs },
    stages: [],
    scoreboard: Object.fromEntries(config.competitorModelIds.map((id) => [id, 0])),
    totalCostUsd: 0,
    startedAt: nowIso(),
  };

  // dispara loop async
  void runLoop(record, apiKey).catch(async (err) => {
    console.error(`[bench ${runId}] run.error:`, err);
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveRun(record).catch(() => undefined);
    emitEvent({ type: 'run.error', runId, error: record.error });
  });

  return { runId, record };
}

async function runLoop(record: RunRecord, apiKey: string): Promise<void> {
  const { id: runId } = record;
  await saveRun(record);
  emitEvent({ type: 'run.started', runId, record });
  log(runId, 'started', { stages: record.config.stages, competitors: record.config.competitorModelIds.length });

  // Datagen pode ser lento (gera JSON, as vezes com reasoning): da uma folga
  // alem do timeout dos competidores, e tenta de novo antes de desistir.
  const datagenTimeout = Math.max(record.config.timeoutMs ?? 60_000, 90_000);
  const DATAGEN_ATTEMPTS = 2;

  for (let i = 0; i < record.config.stages; i++) {
    const stageRecord: StageRecord = {
      index: i,
      responses: [],
      startedAt: nowIso(),
    };
    record.stages.push(stageRecord);

    // Cada etapa e isolada: se UMA falhar (datagen, ou qualquer imprevisto),
    // marcamos a etapa e seguimos para a proxima — a run NUNCA trava por isso.
    try {
      emitEvent({ type: 'stage.generating', runId, stageIndex: i });
      log(runId, `stage ${i + 1}/${record.config.stages} generating`);

      let spec: StageSpec | undefined;
      let lastDatagenErr: unknown;
      for (let attempt = 1; attempt <= DATAGEN_ATTEMPTS; attempt++) {
        try {
          spec = await generateStage({
            apiKey,
            theme: record.config.theme,
            stageIndex: i,
            totalStages: record.config.stages,
            modelId: record.config.datagenModelId,
            timeoutMs: datagenTimeout,
          });
          break;
        } catch (err) {
          lastDatagenErr = err;
          log(
            runId,
            `stage ${i + 1} datagen tentativa ${attempt}/${DATAGEN_ATTEMPTS} falhou: ${(err as Error).message}`,
          );
        }
      }

      if (!spec) {
        const msg = `Datagen falhou apos ${DATAGEN_ATTEMPTS} tentativas: ${
          lastDatagenErr instanceof Error ? lastDatagenErr.message : String(lastDatagenErr)
        }`;
        stageRecord.error = msg;
        stageRecord.finishedAt = nowIso();
        await saveRun(record);
        emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
        log(runId, `stage ${i + 1} PULADA (datagen) — seguindo para a proxima`);
        continue; // <- proxima etapa; a run continua
      }

      // narrow para os closures abaixo (spec ja garantido nao-undefined aqui)
      const stageSpec = spec;
      stageRecord.spec = stageSpec;
      await saveRun(record);
      emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec: stageSpec });

    // competidores em paralelo com cap
    stageRecord.live = {};
    const PROGRESS_THROTTLE_MS = 150;
    const tasks = record.config.competitorModelIds.map((modelId) => async () => {
      emitEvent({ type: 'competitor.started', runId, stageIndex: i, modelId });
      const startedAt = Date.now();
      stageRecord.live![modelId] = {
        modelId,
        startedAt,
        chars: 0,
        charsPerSec: 0,
        preview: '',
        done: false,
      };
      let lastEmit = 0;

      const response = await runCompetitor({
        apiKey,
        modelId,
        stage: stageSpec,
        timeoutMs: record.config.timeoutMs,
        retries: 1,
        maxOutputTokens: record.config.maxOutputTokens,
        onProgress: (chars, charsPerSec, preview) => {
          const live = stageRecord.live?.[modelId];
          if (live) {
            live.chars = chars;
            live.charsPerSec = charsPerSec;
            live.preview = preview;
          }
          const now = Date.now();
          if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
          lastEmit = now;
          emitEvent({
            type: 'competitor.progress',
            runId,
            stageIndex: i,
            modelId,
            chars,
            charsPerSec,
            preview,
          });
        },
      });

      const live = stageRecord.live?.[modelId];
      if (live) {
        live.done = true;
        live.chars = response.text.length;
        const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
        live.charsPerSec = response.text.length / elapsedSec;
      }
      stageRecord.responses.push(response);
      record.totalCostUsd += response.costUsd;
      await saveRun(record);
      emitEvent({ type: 'competitor.finished', runId, stageIndex: i, response });
      return response;
    });

    await runWithLimit<CompetitorResponse>(tasks, record.config.concurrency ?? 8);
    // apos todos terminarem, limpa live state (mantemos apenas em memoria durante a etapa)
    stageRecord.live = undefined;

    // juiz (ranking) + avaliacao qualitativa (motivos do vencedor +
    // aceitabilidade) rodam EM PARALELO. allSettled => um nunca derruba o
    // outro nem a run.
    emitEvent({ type: 'stage.judging', runId, stageIndex: i });
    log(runId, `stage ${i + 1} judging + evaluating (paralelo)`);
    const [judgeRes, evalRes] = await Promise.allSettled([
      judgeStage({
        apiKey,
        stage: stageSpec,
        responses: stageRecord.responses,
        judgeModelId: record.config.judgeModelId,
        timeoutMs: record.config.timeoutMs,
      }),
      evaluateStage({
        apiKey,
        stage: stageSpec,
        responses: stageRecord.responses,
        evaluatorModelId: record.config.judgeModelId,
        timeoutMs: record.config.timeoutMs,
      }),
    ]);

    if (judgeRes.status === 'fulfilled') {
      stageRecord.judge = judgeRes.value;
    } else {
      stageRecord.judge = {
        rankedModelIds: [],
        blindMap: {},
        rawJudgeText: (judgeRes.reason as Error)?.message ?? String(judgeRes.reason),
        inconclusive: true,
      };
      log(runId, `stage ${i + 1} juiz falhou: ${stageRecord.judge.rawJudgeText}`);
    }
    if (!stageRecord.judge.inconclusive) {
      applyScoreboard(record.scoreboard, stageRecord.judge.rankedModelIds);
    }

    if (evalRes.status === 'fulfilled') {
      stageRecord.evaluation = evalRes.value;
    } else {
      stageRecord.evaluation = {
        bestModelId: '',
        bestReasons: '',
        verdicts: [],
        blindMap: {},
        raw: (evalRes.reason as Error)?.message ?? String(evalRes.reason),
        inconclusive: true,
      };
      log(runId, `stage ${i + 1} avaliacao falhou: ${stageRecord.evaluation.raw}`);
    }

    stageRecord.finishedAt = nowIso();
    await saveRun(record);
    emitEvent({
      type: 'stage.judged',
      runId,
      stageIndex: i,
      judge: stageRecord.judge,
      evaluation: stageRecord.evaluation,
      scoreboard: { ...record.scoreboard },
      totalCostUsd: record.totalCostUsd,
    });
    } catch (stageErr) {
      // rede de seguranca: qualquer imprevisto na etapa NAO mata a run
      const msg = stageErr instanceof Error ? stageErr.message : String(stageErr);
      stageRecord.error = stageRecord.error ?? msg;
      stageRecord.finishedAt = nowIso();
      stageRecord.live = undefined;
      await saveRun(record).catch(() => undefined);
      emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
      log(runId, `stage ${i + 1} erro inesperado, pulando: ${msg}`);
    }
  }

  record.status = 'finished';
  record.finishedAt = nowIso();
  await saveRun(record);
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, 'finished', { totalCostUsd: record.totalCostUsd });
}
