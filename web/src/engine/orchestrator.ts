const randomUUID = (): string => crypto.randomUUID();
import { generateStage } from './datagen';
import { runCompetitor } from './competitor';
import { judgeStage } from './judge';
import { emitEvent } from './events';
import { saveRun } from './storage';
import { contestantsFromConfig } from './normalize';
import type { Contestant, RunConfig, RunRecord, StageRecord, StageSpec } from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function log(runId: string, msg: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[bench ${runId}] ${msg}${payload}`);
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

  // --- Persistencia com THROTTLE: as etapas paralelas geram MUITAS escritas;
  // coalescemos em no max. 1x/SAVE_INTERVAL_MS (trailing) e damos flush nos
  // marcos. O estado ao vivo ja vai por SSE, entao o disco nao precisa de cada
  // delta. storage.saveRun continua serializando por run (escrita atomica). ---
  const SAVE_INTERVAL_MS = 800;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;
  const scheduleSave = (): void => {
    if (saveTimer) return;
    const delay = Math.max(0, SAVE_INTERVAL_MS - (Date.now() - lastSave));
    saveTimer = setTimeout(() => {
      saveTimer = null;
      lastSave = Date.now();
      void saveRun(record).catch(() => undefined);
    }, delay);
  };
  const flushSave = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    lastSave = Date.now();
    await saveRun(record);
  };

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
  const totalStages = record.config.stages;

  // Cria todos os slots de etapa de uma vez (a run.started carregou stages=[];
  // emitimos stage.generating por etapa para a UI criar cada slot).
  record.stages = Array.from(
    { length: totalStages },
    (_, i): StageRecord => ({ index: i, responses: [], startedAt: nowIso() }),
  );

  // === FASE 1: gerar TODOS os cenarios EM PARALELO (datagen fora do caminho critico). ===
  // O limitador global (openrouter.ts) controla a concorrencia real das chamadas.
  await Promise.all(
    record.stages.map(async (stageRecord) => {
      const i = stageRecord.index;
      emitEvent({ type: 'stage.generating', runId, stageIndex: i });
      try {
        if (pinnedStages && pinnedStages[i]) {
          stageRecord.spec = pinnedStages[i];
          emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec: pinnedStages[i] });
          return;
        }
        let lastDatagenErr: unknown;
        for (let attempt = 1; attempt <= DATAGEN_ATTEMPTS; attempt++) {
          try {
            stageRecord.spec = await generateStage({
              apiKey,
              theme: record.config.theme,
              stageIndex: i,
              totalStages,
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
        if (!stageRecord.spec) {
          const msg = `Datagen falhou apos ${DATAGEN_ATTEMPTS} tentativas: ${
            lastDatagenErr instanceof Error ? lastDatagenErr.message : String(lastDatagenErr)
          }`;
          stageRecord.error = msg;
          stageRecord.finishedAt = nowIso();
          emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
          log(runId, `stage ${i + 1} PULADA (datagen)`);
          return;
        }
        emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec: stageRecord.spec });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stageRecord.error = stageRecord.error ?? msg;
        stageRecord.finishedAt = nowIso();
        emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
      }
    }),
  );
  scheduleSave();

  // === FASE 2: rodar TODAS as etapas (com spec) EM PARALELO. ===
  // Cada etapa e isolada (try/catch): uma falha nao derruba a run nem as outras.
  // O placar e ADITIVO (applyScoreboard) — independe da ordem de termino.
  const PROGRESS_THROTTLE_MS = 150;
  await Promise.all(
    record.stages.map(async (stageRecord) => {
      const i = stageRecord.index;
      const stageSpec = stageRecord.spec;
      if (!stageSpec || stageRecord.error) return; // pulada na fase 1

      try {
        stageRecord.live = {};
        // Competidores em paralelo — SEM cap local; o limitador global throttla.
        await Promise.all(
          record.contestants.map(async (contestant) => {
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
            scheduleSave();
            emitEvent({ type: 'competitor.finished', runId, stageIndex: i, response });
            return response;
          }),
        );
        stageRecord.live = undefined;

        // Juiz COMPACTO: 1+ juizes EM PARALELO (cada um devolve ranking +
        // aceitavel/motivo por resposta). A concorrencia e gateada pelo
        // limitador global (openrouter.ts) — sem cap local aqui.
        emitEvent({ type: 'stage.judging', runId, stageIndex: i });
        log(runId, `stage ${i + 1} judging (${record.config.judgeModelIds.length} juiz(es))`);
        try {
          stageRecord.judge = await judgeStage({
            apiKey,
            stage: stageSpec,
            responses: stageRecord.responses,
            judgeModelIds: record.config.judgeModelIds,
            timeoutMs: record.config.timeoutMs,
            passes: record.config.judgePasses,
          });
        } catch (judgeErr) {
          stageRecord.judge = {
            rankedContestantIds: [],
            acceptableByContestant: {},
            judges: [],
            blindMap: {},
            rawJudgeText: judgeErr instanceof Error ? judgeErr.message : String(judgeErr),
            inconclusive: true,
          };
          log(runId, `stage ${i + 1} juiz falhou: ${stageRecord.judge.rawJudgeText}`);
        }
        // Placar ADITIVO POR JUIZ: cada juiz contribui com seu ranking (ordem-
        // independente). Com 2 juizes e 3 competidores -> ate 6 pontuacoes/etapa.
        if (!stageRecord.judge.inconclusive) {
          for (const j of stageRecord.judge.judges) {
            if (j.rankedContestantIds.length > 0) {
              applyScoreboard(record.scoreboard, j.rankedContestantIds);
            }
          }
        }

        stageRecord.finishedAt = nowIso();
        scheduleSave();
        emitEvent({
          type: 'stage.judged',
          runId,
          stageIndex: i,
          judge: stageRecord.judge,
          scoreboard: { ...record.scoreboard },
          totalCostUsd: record.totalCostUsd,
        });
      } catch (stageErr) {
        // rede de seguranca: qualquer imprevisto na etapa NAO mata a run
        const msg = stageErr instanceof Error ? stageErr.message : String(stageErr);
        stageRecord.error = stageRecord.error ?? msg;
        stageRecord.finishedAt = nowIso();
        stageRecord.live = undefined;
        emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
        log(runId, `stage ${i + 1} erro inesperado, pulando: ${msg}`);
      }
    }),
  );

  record.status = 'finished';
  record.finishedAt = nowIso();
  await flushSave();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, 'finished', { totalCostUsd: record.totalCostUsd });
}
