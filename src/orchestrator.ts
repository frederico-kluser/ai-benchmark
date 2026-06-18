import { randomUUID } from 'node:crypto';
import { generateStage } from './datagen.js';
import { runCompetitor } from './competitor.js';
import { judgeStage } from './judge.js';
import { evaluateStage } from './evaluator.js';
import { emitEvent } from './events.js';
import { saveRun } from './storage.js';
import { contestantsFromConfig } from './normalize.js';
import type {
  Contestant,
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
  rankedContestantIds: string[],
): void {
  // pontos: melhor recebe N-1, proximo N-2, ... pior 0
  const n = rankedContestantIds.length;
  rankedContestantIds.forEach((contestantId, idx) => {
    const points = n - 1 - idx;
    scoreboard[contestantId] = (scoreboard[contestantId] ?? 0) + points;
  });
}

export interface StartRunResult {
  runId: string;
  record: RunRecord;
}

export interface StartRunOpts {
  /** Id pre-gerado da run (treino emite iteration.started antes de rodar). */
  runId?: string;
  /** Contestants resolvidos (variation/training). Em compare derivam da config. */
  contestants?: Contestant[];
  /** Especificacoes de etapa pre-geradas — pula o datagen (benchmark pinado do treino). */
  pinnedStages?: StageSpec[];
  /**
   * Resolve os contestants no inicio da run (ex.: gerar variantes via optimizer),
   * emitindo variants.generating/generated. Usado pelo modo variacao.
   */
  prepare?: () => Promise<Contestant[]>;
  sessionId?: string;
  iteration?: number;
  parentRunId?: string;
}

function buildRecord(config: RunConfig, opts: StartRunOpts): RunRecord {
  const runId = opts.runId ?? randomUUID();
  const concurrency = Math.max(1, config.concurrency ?? 8);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const contestants = opts.contestants ?? contestantsFromConfig(config);

  return {
    id: runId,
    status: 'running',
    config: { ...config, concurrency, timeoutMs },
    mode: config.mode,
    contestants,
    stages: [],
    scoreboard: Object.fromEntries(contestants.map((c) => [c.id, 0])),
    costByContestant: Object.fromEntries(contestants.map((c) => [c.id, 0])),
    totalCostUsd: 0,
    startedAt: nowIso(),
    sessionId: opts.sessionId,
    iteration: opts.iteration,
    parentRunId: opts.parentRunId,
  };
}

/** Executa o loop e SEMPRE resolve com o record final (status finished/error). */
async function executeRun(
  record: RunRecord,
  apiKey: string,
  opts: StartRunOpts,
): Promise<RunRecord> {
  try {
    await runLoop(record, apiKey, opts);
  } catch (err) {
    console.error(`[bench ${record.id}] run.error:`, err);
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveRun(record).catch(() => undefined);
    emitEvent({ type: 'run.error', runId: record.id, error: record.error });
  }
  return record;
}

/** Dispara a run em background e retorna imediatamente. */
export function startRun(config: RunConfig, apiKey: string, opts: StartRunOpts = {}): StartRunResult {
  const record = buildRecord(config, opts);
  void executeRun(record, apiKey, opts);
  return { runId: record.id, record };
}

/** Roda ate o fim e resolve com o record final (usado pelo trainer). */
export function runToCompletion(
  config: RunConfig,
  apiKey: string,
  opts: StartRunOpts = {},
): Promise<RunRecord> {
  const record = buildRecord(config, opts);
  return executeRun(record, apiKey, opts);
}

async function runLoop(record: RunRecord, apiKey: string, opts: StartRunOpts): Promise<void> {
  const { id: runId } = record;
  await saveRun(record);
  emitEvent({ type: 'run.started', runId, record });
  log(runId, 'started', {
    mode: record.mode,
    stages: record.config.stages,
    contestants: record.contestants.length,
  });

  // Resolve contestants on-demand (variacao: gera as variantes via optimizer).
  if (opts.prepare) {
    emitEvent({ type: 'variants.generating', runId });
    log(runId, 'gerando variantes…');
    const contestants = await opts.prepare();
    if (contestants.length < 2) {
      throw new Error(
        'Variacao precisa de ao menos 2 contestants validos (verifique as tecnicas/variantes ou o modelo optimizer).',
      );
    }
    record.contestants = contestants;
    record.scoreboard = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    record.costByContestant = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    await saveRun(record);
    emitEvent({ type: 'variants.generated', runId, contestants });
  }

  // Datagen pode ser lento (gera JSON, as vezes com reasoning): da uma folga
  // alem do timeout dos competidores, e tenta de novo antes de desistir.
  const datagenTimeout = Math.max(record.config.timeoutMs ?? 60_000, 90_000);
  const DATAGEN_ATTEMPTS = 2;
  const pinnedStages = opts.pinnedStages;

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
      let spec: StageSpec | undefined;

      if (pinnedStages && pinnedStages[i]) {
        // Benchmark pinado (treino): reusa a etapa, pula o datagen.
        spec = pinnedStages[i];
        stageRecord.spec = spec;
        await saveRun(record);
        emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec });
      } else {
        emitEvent({ type: 'stage.generating', runId, stageIndex: i });
        log(runId, `stage ${i + 1}/${record.config.stages} generating`);

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

        stageRecord.spec = spec;
        await saveRun(record);
        emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec });
      }

      // narrow para os closures abaixo (spec ja garantido nao-undefined aqui)
      const stageSpec = spec;

      // contestants em paralelo com cap
      stageRecord.live = {};
      const PROGRESS_THROTTLE_MS = 150;
      const tasks = record.contestants.map((contestant) => async () => {
        emitEvent({
          type: 'competitor.started',
          runId,
          stageIndex: i,
          contestantId: contestant.id,
          modelId: contestant.modelId,
        });
        const startedAt = Date.now();
        stageRecord.live![contestant.id] = {
          contestantId: contestant.id,
          modelId: contestant.modelId,
          label: contestant.label,
          startedAt,
          chars: 0,
          charsPerSec: 0,
          preview: '',
          done: false,
        };
        let lastEmit = 0;

        const response = await runCompetitor({
          apiKey,
          contestantId: contestant.id,
          modelId: contestant.modelId,
          systemPrompt: contestant.systemPrompt,
          stage: stageSpec,
          timeoutMs: record.config.timeoutMs,
          retries: 1,
          maxOutputTokens: record.config.maxOutputTokens,
          onProgress: (chars, charsPerSec, preview) => {
            const live = stageRecord.live?.[contestant.id];
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
              contestantId: contestant.id,
              modelId: contestant.modelId,
              chars,
              charsPerSec,
              preview,
            });
          },
        });

        const live = stageRecord.live?.[contestant.id];
        if (live) {
          live.done = true;
          live.chars = response.text.length;
          const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
          live.charsPerSec = response.text.length / elapsedSec;
        }
        stageRecord.responses.push(response);
        record.totalCostUsd += response.costUsd;
        if (record.costByContestant) {
          record.costByContestant[contestant.id] =
            (record.costByContestant[contestant.id] ?? 0) + response.costUsd;
        }
        await saveRun(record);
        emitEvent({ type: 'competitor.finished', runId, stageIndex: i, response });
        return response;
      });

      await runWithLimit<CompetitorResponse>(tasks, record.config.concurrency ?? 8);
      // apos todos terminarem, limpa live state (mantemos apenas em memoria durante a etapa)
      stageRecord.live = undefined;

      // juiz (ranking) + avaliacao qualitativa rodam EM PARALELO. allSettled =>
      // um nunca derruba o outro nem a run.
      emitEvent({ type: 'stage.judging', runId, stageIndex: i });
      log(runId, `stage ${i + 1} judging + evaluating (paralelo)`);
      const [judgeRes, evalRes] = await Promise.allSettled([
        judgeStage({
          apiKey,
          stage: stageSpec,
          responses: stageRecord.responses,
          judgeModelId: record.config.judgeModelId,
          timeoutMs: record.config.timeoutMs,
          passes: record.config.judgePasses,
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
          rankedContestantIds: [],
          blindMap: {},
          rawJudgeText: (judgeRes.reason as Error)?.message ?? String(judgeRes.reason),
          inconclusive: true,
        };
        log(runId, `stage ${i + 1} juiz falhou: ${stageRecord.judge.rawJudgeText}`);
      }
      if (!stageRecord.judge.inconclusive) {
        applyScoreboard(record.scoreboard, stageRecord.judge.rankedContestantIds);
      }

      if (evalRes.status === 'fulfilled') {
        stageRecord.evaluation = evalRes.value;
      } else {
        stageRecord.evaluation = {
          bestContestantId: '',
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
