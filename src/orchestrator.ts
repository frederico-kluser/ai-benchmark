import { randomUUID } from 'node:crypto';
import { generateStages } from './datagen.js';
import { runCompetitor } from './competitor.js';
import { judgeStage } from './judge.js';
import { generateReferences } from './gabarito.js';
import { judgeStageReference } from './refJudge.js';
import { runStageDuels, VERDICT_SCORE } from './duels.js';
import { mergeScenarios } from './scenarioPack.js';
import { sanitizeLlmVariants, variantsToContestants } from './llmVariants.js';
import { judgeScoreFromVerdicts } from './rank.js';
import { emitEvent } from './events.js';
import { saveRun } from './storage.js';
import { contestantsFromConfig } from './normalize.js';
import type { Contestant, RunConfig, RunRecord, StageRecord, StageSpec } from './types.js';

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

/**
 * Contestants do modo compare. compare-llms (competitorConfigs): as variantes
 * de config {modelo, temperatura, reasoning} viram os contestants (identidade =
 * tripla) e a PRIMEIRA e marcada isOriginal — ancora dos duelos/standings —
 * sem mudar o label. Saneamento invalido NAO lanca aqui (buildRecord e
 * sincrono): cai no fallback classico e o runLoop revalida para falhar a run
 * cedo com a mensagem PT-BR do sanitize.
 */
function compareContestants(config: RunConfig): Contestant[] {
  if (config.mode !== 'compare' || !config.competitorConfigs?.length) {
    return contestantsFromConfig(config);
  }
  const sane = sanitizeLlmVariants(config.competitorConfigs);
  if (sane.error) return contestantsFromConfig(config);
  for (const w of sane.warnings) console.warn(`[compare-llms] ${w}`);
  const contestants = variantsToContestants(sane.variants);
  if (contestants[0]) contestants[0] = { ...contestants[0], isOriginal: true };
  return contestants;
}

function buildRecord(config: RunConfig, opts: StartRunOpts): RunRecord {
  const runId = opts.runId ?? randomUUID();
  const concurrency = Math.max(1, config.concurrency ?? 8);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const contestants = opts.contestants ?? compareContestants(config);

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

  // compare-llms: falha a run CEDO (antes de qualquer chamada de LLM) se as
  // variantes forem invalidas. buildRecord nao pode lancar (e sincrono e a
  // rota espera o record de volta); sanitize e puro/barato, rodar 2x e inocuo.
  if (
    !opts.contestants &&
    record.config.mode === 'compare' &&
    record.config.competitorConfigs?.length
  ) {
    const sane = sanitizeLlmVariants(record.config.competitorConfigs);
    if (sane.error) throw new Error(sane.error);
  }

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

  // Datagen em lote/gabaritos podem ser lentos (varios cenarios por chamada,
  // as vezes com reasoning): folga alem do timeout dos competidores.
  const datagenTimeout = Math.max(record.config.timeoutMs ?? 60_000, 120_000);

  // Saneia maxTokens (o competidor faz Math.min(maxOutputTokens, stage.maxTokens);
  // ausente/<=0 viraria NaN). Aplica-se a pinadas, seed e geradas.
  const saneMaxTokens = (s: StageSpec): StageSpec => ({
    ...s,
    maxTokens: s.maxTokens && s.maxTokens > 0 ? s.maxTokens : record.config.maxOutputTokens ?? 1000,
  });

  // Etapas pinadas: do treino (opts.pinnedStages — iteracao > 0, ja trazem
  // `reference` congelada) OU fornecidas pelo usuario (config.customStages).
  // Ambas tem precedencia total e pulam o datagen (fluxo atual intacto), MAS
  // entram no fluxo de gabarito (fase 1.5) quando falta `reference`.
  const rawPinned = opts.pinnedStages ?? record.config.customStages;
  const pinnedStages = rawPinned?.map(saneMaxTokens);
  const pinado = Boolean(pinnedStages && pinnedStages.length);

  // repeats (so compare, nao-pinado): cada cenario vira R copias EXATAS como
  // cenarios distintos — mede a variancia das respostas e separa o vencedor
  // real do ruido (port do prompt-arena).
  const repeats =
    !pinado && record.config.mode === 'compare'
      ? Math.max(1, Math.floor(record.config.repeats ?? 1))
      : 1;

  // Julgamento por referencia efetivo: ligado por default em variation/training
  // e no compare-llms; DESLIGADO no compare classico — runs listwise antigas
  // ficam compativeis em comportamento. Se TODOS os gabaritos falharem,
  // nenhuma etapa tera `reference` e a run inteira degrada para o listwise
  // classico na fase 3 (degrada, nunca crash).
  const referenceJudging =
    record.config.referenceJudging ??
    (record.config.mode !== 'compare' || Boolean(record.config.competitorConfigs?.length));

  // === FASE 1: cenarios. Cria todos os slots e emite stage.generating ANTES
  // da geracao (a UI cria um slot por stageIndex a partir deste evento). ===
  const seed = pinado
    ? []
    : (record.config.scenarioSeed ?? []).map((s) => saneMaxTokens({ ...s, origin: 'import' as const }));
  const alvo = pinado ? pinnedStages!.length : Math.max(record.config.stages, seed.length);
  record.stages = Array.from(
    { length: alvo * repeats },
    (_, i): StageRecord => ({ index: i, responses: [], startedAt: nowIso() }),
  );
  for (let i = 0; i < record.stages.length; i++) {
    emitEvent({ type: 'stage.generating', runId, stageIndex: i });
  }

  let specs: StageSpec[];
  if (pinado) {
    specs = pinnedStages!;
  } else if (seed.length >= record.config.stages) {
    // O seed cobre (ou excede) o alvo: tudo importado, o datagen NAO e chamado.
    specs = seed;
  } else {
    // Gera em LOTE apenas o que falta para o alvo (batches paralelos + dedup
    // exato/ROUGE-L + 1 backfill dentro de generateStages — substitui o antigo
    // retry por etapa) e mescla: seed primeiro (curadoria do usuario, nunca
    // descartado), gerados como complemento nao-duplicado.
    const gerados = await generateStages({
      apiKey,
      theme: record.config.theme,
      scenarioBrief: record.config.scenarioBrief,
      count: alvo - seed.length,
      modelId: record.config.datagenModelId,
      excludePrompts: seed.map((s) => s.question),
      reasoningLevel: record.config.reasoning?.datagen,
      timeoutMs: datagenTimeout,
    });
    specs = mergeScenarios(seed, gerados).map(saneMaxTokens);
    if (specs.length === 0) {
      throw new Error(
        `Datagen nao entregou nenhum cenario valido (alvo: ${alvo}). Verifique o modelo gerador (${record.config.datagenModelId}) ou importe um pacote de cenarios.`,
      );
    }
  }

  // === FASE 1.5: gabaritos (respostas de referencia), ANTES da expansao por
  // repeats — as copias exatas herdam a mesma `reference`, evitando R chamadas
  // identicas. Etapas que ja trazem reference (seed/pinadas) passam intactas;
  // falha num gabarito so deixa a etapa sem reference (degrada na fase 3). ===
  if (referenceJudging) {
    specs = await generateReferences({
      stages: specs,
      apiKey,
      modelId: record.config.referenceModelId ?? record.config.judgeModelIds[0],
      reasoningLevel: record.config.reasoning?.judge,
      timeoutMs: datagenTimeout,
      // stageIndex -1 = progresso AGREGADO do lote (done/total de gabaritos
      // concluidos), nao de uma etapa especifica.
      onProgress: (done, total) =>
        emitEvent({ type: 'stage.gabarito', runId, stageIndex: -1, done, total }),
    });
  }

  // Expansao por repeats: R copias exatas de cada cenario (compartilham o
  // gabarito por construcao).
  if (repeats > 1) {
    specs = specs.flatMap((s) => Array.from({ length: repeats }, () => ({ ...s })));
  }

  // Materializa as specs nos slots; se faltou cenario (dedup/falha de lote),
  // os slots do rabo viram stage.failed e a run segue com o que houver.
  specs.forEach((spec, i) => {
    record.stages[i].spec = spec;
    emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec });
  });
  for (let i = specs.length; i < record.stages.length; i++) {
    const msg = `Datagen entregou menos cenarios que o alvo apos dedup/falha de lote; etapa descartada.`;
    record.stages[i].error = msg;
    record.stages[i].finishedAt = nowIso();
    emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
    log(runId, `stage ${i + 1} PULADA (sem cenario)`);
  }
  scheduleSave();

  // Contestants ja sao finais aqui (opts.prepare rodou). Controle = ancora dos
  // duelos e do standings: o prompt original (isOriginal), o 'carry' do treino,
  // ou o 1o contestant como fallback.
  const controlId =
    record.contestants.find((c) => c.isOriginal || c.id === 'carry')?.id ??
    record.contestants[0]?.id;
  // Duelos: ligados por default onde houver gabarito; `duels === false` desliga
  // (duels/duelTopK so existem no TrainingConfig — dai o narrowing por `in`).
  const duelsOn = !('duels' in record.config && record.config.duels === false);
  const duelTopK = ('duelTopK' in record.config ? record.config.duelTopK : undefined) ?? 5;
  // duel.progress agregado: done = etapas com duelo concluido, total = etapas
  // com reference (so elas duelam). Progresso por etapa — granular o bastante;
  // progresso por PAR de duelo seria ruido no SSE.
  const duelStagesTotal = duelsOn ? specs.filter((s) => s.reference?.trim()).length : 0;
  let duelStagesDone = 0;

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
              // compare-llms: temperatura/reasoning da tripla de identidade.
              // Prioridade do reasoning: override do contestant, senao o do papel.
              temperature: contestant.temperature,
              reasoningLevel: contestant.reasoningLevel ?? record.config.reasoning?.competitor,
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

        // === FASE 3: julgamento. Com gabarito: pointwise vs referencia +
        // duelos (port do prompt-arena). Sem gabarito: juiz LISTWISE classico
        // (compare antigo / fallback — fluxo intacto). ===
        emitEvent({ type: 'stage.judging', runId, stageIndex: i });
        try {
          if (stageSpec.reference?.trim()) {
            // Pointwise: cada resposta classificada isoladamente contra o
            // gabarito (resolve/parcial/nao) — base do judge-score.
            const refJudge = await judgeStageReference({
              stage: stageSpec,
              responses: stageRecord.responses,
              contestants: record.contestants,
              judgeModelIds: record.config.judgeModelIds,
              apiKey,
              reasoningLevel: record.config.reasoning?.judge,
              timeoutMs: record.config.timeoutMs,
            });
            stageRecord.referenceJudge = refJudge;

            // Duelos round-robin do bracket top-K (controle sempre entra) —
            // barreira por etapa: disparam assim que o pointwise dela termina.
            if (duelsOn) {
              stageRecord.duels = await runStageDuels({
                stage: stageSpec,
                responses: stageRecord.responses,
                contestants: record.contestants,
                judgeModelId: record.config.judgeModelIds[0],
                controlId,
                topK: duelTopK,
                verdictByContestant: refJudge.verdictByContestant,
                apiKey,
                reasoningLevel: record.config.reasoning?.judge,
                timeoutMs: record.config.timeoutMs,
              });
              duelStagesDone += 1;
              emitEvent({ type: 'stage.dueled', runId, stageIndex: i, duels: stageRecord.duels });
              emitEvent({
                type: 'duel.progress',
                runId,
                done: duelStagesDone,
                total: duelStagesTotal,
              });
            }

            // JudgeResult SINTETIZADO para nao quebrar scoreboard/medals/UI:
            // ranking = ordem Copeland dos duelos quando houver; senao, por
            // veredito (resolve > parcial > nao; desempate = ordem dos
            // contestants — Array.sort e estavel).
            const ranked = stageRecord.duels?.order.length
              ? stageRecord.duels.order
              : [...record.contestants]
                  .sort(
                    (a, b) =>
                      VERDICT_SCORE[refJudge.verdictByContestant[b.id] ?? 'nao'] -
                      VERDICT_SCORE[refJudge.verdictByContestant[a.id] ?? 'nao'],
                  )
                  .map((c) => c.id);
            stageRecord.judge = {
              rankedContestantIds: ranked,
              acceptableByContestant: Object.fromEntries(
                Object.entries(refJudge.verdictByContestant).map(([id, v]) => [id, v !== 'nao']),
              ),
              verdictByContestant: { ...refJudge.verdictByContestant },
              judges: [],
              blindMap: {},
              rawJudgeText: 'Juiz de referência (gabarito)',
              inconclusive: refJudge.inconclusive,
            };
          } else {
            log(runId, `stage ${i + 1} judging (${record.config.judgeModelIds.length} juiz(es))`);
            stageRecord.judge = await judgeStage({
              apiKey,
              stage: stageSpec,
              responses: stageRecord.responses,
              judgeModelIds: record.config.judgeModelIds,
              timeoutMs: record.config.timeoutMs,
              passes: record.config.judgePasses,
            });
          }
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
        // Placar ADITIVO (ordem-independente). Listwise: POR JUIZ (cada juiz
        // pontua seu ranking). Referencia: 1x pelo ranking sintetizado
        // (duelos > veredito) — judges vem vazio de proposito.
        if (!stageRecord.judge.inconclusive) {
          if (stageRecord.judge.judges.length > 0) {
            for (const j of stageRecord.judge.judges) {
              if (j.rankedContestantIds.length > 0) {
                applyScoreboard(record.scoreboard, j.rankedContestantIds);
              }
            }
          } else if (stageRecord.judge.rankedContestantIds.length > 0) {
            applyScoreboard(record.scoreboard, stageRecord.judge.rankedContestantIds);
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

  // === Agregados do julgamento por referencia (trainer/UI consomem). ===
  const stagesComRef = record.stages.filter((s) => s.referenceJudge);
  if (stagesComRef.length > 0) {
    // judge-score = (resolve + 0.5*parcial) / total * 100, por contestant,
    // sobre as etapas com juiz de referencia (ausente conta como 'nao').
    record.judgeScoreByContestant = Object.fromEntries(
      record.contestants.map((c) => [
        c.id,
        judgeScoreFromVerdicts(stagesComRef.map((s) => s.referenceJudge!.verdictByContestant[c.id])),
      ]),
    );
  }
  const stagesComDuelos = record.stages.filter((s) => s.duels);
  if (stagesComDuelos.length > 0) {
    // Copeland agregado cross-estagio: vitoria 1, empate 0.5, derrota 0.
    const acc = new Map(
      record.contestants.map((c) => [c.id, { points: 0, wins: 0, ties: 0, losses: 0 }]),
    );
    for (const s of stagesComDuelos) {
      for (const d of s.duels!.duels) {
        const A = acc.get(d.a);
        const B = acc.get(d.b);
        if (!A || !B) continue;
        if (d.outcome === 'a') {
          A.points += 1;
          A.wins += 1;
          B.losses += 1;
        } else if (d.outcome === 'b') {
          B.points += 1;
          B.wins += 1;
          A.losses += 1;
        } else {
          A.points += 0.5;
          B.points += 0.5;
          A.ties += 1;
          B.ties += 1;
        }
      }
    }
    const labelOf = (id: string): string =>
      record.contestants.find((c) => c.id === id)?.label ?? id;
    record.standings = [...acc.entries()]
      .map(([id, s]) => {
        const played = s.wins + s.ties + s.losses;
        return {
          id,
          label: labelOf(id),
          isControl: id === controlId,
          ...s,
          winRate: played > 0 ? Number(((s.wins + 0.5 * s.ties) / played).toFixed(4)) : 0,
        };
      })
      // Estavel: empate de pontos E winRate mantem a ordem dos contestants.
      .sort((a, b) => b.points - a.points || b.winRate - a.winRate);
  }

  record.status = 'finished';
  record.finishedAt = nowIso();
  await flushSave();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, 'finished', { totalCostUsd: record.totalCostUsd });
}
