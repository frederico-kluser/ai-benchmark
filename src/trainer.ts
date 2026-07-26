import { randomUUID } from 'node:crypto';
import { runToCompletion } from './orchestrator.js';
import { generateContestants } from './variator.js';
import { emitSessionEvent } from './events.js';
import { saveSession } from './storage.js';
import { computeMedals } from './medals.js';
import { judgeScoreFromVerdicts, pickWinner, type RankEntry } from './rank.js';
import { MIN_HOLDOUT_SCENARIOS, splitHoldout } from './holdout.js';
import { pairedSignificance, VERDICT_SCORE } from './stats.js';
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

/** Campeao corrente do treino (prompt + rotulo + o id que tinha na run em que venceu). */
interface Champion {
  contestantId: string;
  systemPrompt: string;
  label: string;
}

/**
 * Judge-score 0-100 do contestant na run. Usa o agregado do orchestrator
 * (preenchido quando houve juiz de referencia); em runs legadas, sem
 * `judgeScoreByContestant`, cai nos vereditos listwise dos estagios
 * (`stage.judge.verdictByContestant`).
 */
function judgeScoreOf(run: RunRecord, contestantId: string): number {
  const agg = run.judgeScoreByContestant?.[contestantId];
  if (agg !== undefined) return agg;
  return judgeScoreFromVerdicts(
    run.stages.map(
      (s) =>
        s.referenceJudge?.verdictByContestant?.[contestantId] ??
        s.judge?.verdictByContestant?.[contestantId],
    ),
  );
}

/** Placement medio do contestant nos estagios COM duelo (undefined se nenhum duelo). */
function meanPlacementOf(run: RunRecord, contestantId: string): number | undefined {
  const placements = run.stages
    .map((s) => s.duels?.placementByContestant?.[contestantId])
    .filter((p): p is number => p !== undefined);
  if (!placements.length) return undefined;
  return placements.reduce((sum, p) => sum + p, 0) / placements.length;
}

/**
 * Monta as entradas do ranking de selecao (port do evolve.mjs do prompt-arena).
 * `controlId` e a REGUA desta iteracao ('original' na 0, 'carry' nas demais):
 * ela nao disputa o titulo, entao seu promptLen e zerado — o desempate por
 * tamanho so vale entre candidatas.
 */
function buildRankEntries(run: RunRecord, controlId: string): RankEntry[] {
  return run.contestants.map((c) => {
    const isControl = c.id === controlId;
    let errored = 0;
    for (const s of run.stages) {
      for (const r of s.responses) {
        if (r.contestantId === c.id && r.status === 'error') errored++;
      }
    }
    return {
      id: c.id,
      label: c.label,
      isControl,
      judgeScore: judgeScoreOf(run, c.id),
      meanPlacement: meanPlacementOf(run, c.id),
      errored,
      promptLen: isControl ? 0 : (c.systemPrompt ?? '').length,
    };
  });
}

const LESSONS_PREFIX =
  'Fraquezas observadas ao benchmarkar o prompt base ATUAL. Enderece-as SEM quebrar o contrato de saida:\n';

/**
 * Reflection estilo GEPA (port do evolve.mjs): SUBSTITUI a antiga analise por
 * LLM (`analyzeIteration`, removida — a analise deixou de ser uma etapa do
 * pipeline, e o evento `iteration.analyzing` nao e mais emitido; o tipo
 * permanece em types.ts apenas para sessoes antigas). As licoes sao montadas
 * DETERMINISTICAMENTE das falhas do campeao na ultima run: ate 8 estagios em
 * que o veredito nao foi 'resolve', com cap de 4000 chars no total. O variator
 * injeta o resultado em `<licoes_da_iteracao_anterior>`.
 */
function buildLessons(run: RunRecord, championId: string): string {
  const items: string[] = [];
  for (const s of run.stages) {
    if (items.length >= 8) break;
    const verdict =
      s.referenceJudge?.verdictByContestant?.[championId] ??
      s.judge?.verdictByContestant?.[championId];
    if (verdict === 'resolve') continue;
    const motivo = (
      s.referenceJudge?.explanationByContestant?.[championId] ??
      (s.judge?.judges ?? [])
        .map((j) => j.verdicts.find((v) => v.contestantId === championId)?.motivo)
        .find((m) => m && m.trim()) ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    // Estagio sem veredito E sem motivo (o pipeline falhou ali) nao vira licao:
    // seria ruido, nao uma fraqueza observada do campeao.
    if (verdict === undefined && !motivo) continue;
    const question = (s.spec?.question ?? '?').replace(/\s+/g, ' ').trim().slice(0, 60);
    items.push(`- [${question}] veredito=${verdict ?? '?'} — ${motivo.slice(0, 200)}`);
  }
  if (!items.length) return '';
  return (LESSONS_PREFIX + items.join('\n')).slice(0, 4000);
}

/**
 * Scores por estagio (escala 0-1 de `VERDICT_SCORE`) de controle e campeao,
 * posicao a posicao, para o bootstrap pareado. Veredito ausente conta como
 * 'nao' (0) — mesma convencao de `judgeScoreFromVerdicts`.
 */
function pairedStageScores(
  run: RunRecord,
  controlId: string,
  championId: string,
): { controlScores: number[]; championScores: number[] } {
  const controlScores: number[] = [];
  const championScores: number[] = [];
  for (const s of run.stages) {
    const vc =
      s.referenceJudge?.verdictByContestant?.[controlId] ??
      s.judge?.verdictByContestant?.[controlId];
    const vh =
      s.referenceJudge?.verdictByContestant?.[championId] ??
      s.judge?.verdictByContestant?.[championId];
    controlScores.push(VERDICT_SCORE[vc ?? 'nao']);
    championScores.push(VERDICT_SCORE[vh ?? 'nao']);
  }
  return { controlScores, championScores };
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
    customStages: cfg.customStages,
    // Campos declarativos repassados verbatim p/ a run nao perder o intent do
    // usuario (datagen guiado, julgamento por referencia, reasoning por papel).
    compliance: cfg.compliance,
    reasoning: cfg.reasoning,
    referenceModelId: cfg.referenceModelId,
    referenceJudging: cfg.referenceJudging,
    scenarioBrief: cfg.scenarioBrief,
    scenarioSeed: cfg.scenarioSeed,
    // Fase de finais: sem repassar, TODA iteracao (e o holdout) cairia no
    // default de 3 finalistas — a escolha do usuario era descartada em silencio.
    duels: cfg.duels,
    finalists: cfg.finalists,
    contestantModelId: cfg.contestantModelId,
    basePrompt: cfg.basePrompt,
    techniqueIds: cfg.techniqueIds,
    manualVariants: cfg.manualVariants,
    // Sem repassar, a temperatura do modelo sob teste sumiria em toda iteracao.
    temperature: cfg.temperature,
  };
}

async function trainingLoop(record: SessionRecord, apiKey: string): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
  const promptOptimization = cfg.promptOptimization !== false;
  const hasBase = Boolean(cfg.basePrompt && cfg.basePrompt.trim());
  const minGain = cfg.minGain ?? 1;

  await saveSession(record);
  emitSessionEvent({ type: 'session.started', sessionId, record });
  log(sessionId, `started: ${cfg.iterations} iteracoes (minGain=${minGain})`);

  let pinnedStages: StageSpec[] | undefined;
  // Fatia de holdout (split anti-overfit na iteracao 0): fica so EM MEMORIA —
  // sessoes nao resumem entre processos hoje, entao nao precisa ir para o disco.
  let holdoutStages: StageSpec[] = [];
  let prevRun: RunRecord | undefined;
  let champion: Champion | undefined;
  // Id que o campeao teve na run MAIS RECENTE (promovido: o id da variante;
  // convergido: a regua, que segurou o titulo). Usado na linhagem e no
  // pareamento da significancia.
  let championIdInLastRun = '';

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
          reasoningLevel: cfg.reasoning?.rewriter,
          timeoutMs: cfg.timeoutMs,
        });
      } else {
        // Reflection GEPA (deterministico — ver buildLessons): substitui a
        // antiga etapa LLM de analise; so a partir da iteracao 1 e se
        // feedbackDriven nao foi desligado.
        const hint =
          cfg.feedbackDriven !== false && prevRun
            ? buildLessons(prevRun, champion!.contestantId)
            : '';
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          basePrompt: champion!.systemPrompt,
          originalPrompt: cfg.basePrompt,
          carryPrompt: champion!.systemPrompt,
          carryLabel: `Melhor it.${i}`,
          carryParentId: champion!.contestantId,
          includeOriginal: hasBase,
          techniqueIds: cfg.techniqueIds,
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          analysisHint: hint,
          reasoningLevel: cfg.reasoning?.rewriter,
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

      // 3) Pina o benchmark depois da iteracao 0 (mesmas perguntas em todas),
      //    com split anti-overfit: a fatia de holdout fica FORA da selecao e so
      //    entra no gate final (ver finalizeHoldout).
      if (i === 0) {
        const specs = runRec.stages
          .map((s) => s.spec)
          .filter((s): s is StageSpec => Boolean(s));
        if (cfg.holdoutRatio !== 0) {
          const split = splitHoldout(specs, cfg.holdoutRatio ?? 0.2);
          pinnedStages = split.train;
          holdoutStages = split.holdout;
        } else {
          pinnedStages = specs;
        }
        record.pinnedStages = pinnedStages;
      }

      // 4) Gate de promocao por margem (port do evolve.mjs): a melhor variante
      //    so vira campea se superar a REGUA desta iteracao por >= minGain
      //    pontos de judge-score. A regua e o 'original' (base) na iteracao 0 e
      //    o 'carry' (campeao anterior re-testado verbatim) nas demais.
      const controlId = i === 0 ? 'original' : 'carry';
      const pick = pickWinner(buildRankEntries(runRec, controlId), { minGain });
      let promoted = false;
      if (pick.isWinner && pick.best) {
        const wc = runRec.contestants.find((c) => c.id === pick.best!.id);
        champion = {
          contestantId: pick.best.id,
          systemPrompt: wc?.systemPrompt ?? champion?.systemPrompt ?? cfg.basePrompt ?? '',
          label: wc?.label ?? pick.best.id,
        };
        championIdInLastRun = pick.best.id;
        promoted = true;
      } else if (!champion) {
        // A regua segurou o titulo logo na 1a rodada.
        const controlC = runRec.contestants.find((c) => c.id === controlId);
        champion = {
          contestantId: controlId,
          systemPrompt: controlC?.systemPrompt ?? cfg.basePrompt ?? '',
          label: controlC?.label ?? controlId,
        };
        championIdInLastRun = controlId;
      } else {
        // Convergencia em i>0: o campeao anterior rodou como 'carry' e se manteve.
        championIdInLastRun = controlId;
      }

      // 5) Linhagem: registra o CAMPEAO POS-GATE de cada iteracao (score e
      //    medalhas seguem de computeMedals apenas para a UI — a decisao de
      //    promocao e do gate por margem, nao do quadro de medalhas).
      const medalRow = computeMedals(runRec).find((r) => r.contestantId === championIdInLastRun);
      record.bestPromptByIteration.push({
        iteration: i,
        runId: runRec.id,
        winnerContestantId: championIdInLastRun,
        systemPrompt: champion.systemPrompt,
        score: medalRow?.golds ?? 0,
        medals: medalRow?.medals ?? [],
        golds: medalRow?.golds ?? 0,
        silvers: medalRow?.silvers ?? 0,
        bronzes: medalRow?.bronzes ?? 0,
      });

      prevRun = runRec;
      emitSessionEvent({
        type: 'iteration.finished',
        sessionId,
        iteration: i,
        runId: runRec.id,
        winnerContestantId: championIdInLastRun,
      });
      if (promoted) {
        emitSessionEvent({
          type: 'iteration.promoted',
          sessionId,
          iteration: i,
          championId: champion.contestantId,
          gain: pick.gain,
        });
        log(sessionId, `iteracao ${i + 1}: promovido ${champion.contestantId} (ganho +${pick.gain.toFixed(1)}pp)`);
      }
      await saveSession(record);

      if (!promoted) {
        // Convergiu: a promocao exige margem real sobre o campeao. Sem ganho —
        // mesmo ja na iteracao 0 — nao ha campeao NOVO de onde derivar a
        // proxima geracao; continuar so queimaria custo re-testando a regua.
        record.convergedAtIteration = i;
        emitSessionEvent({ type: 'session.converged', sessionId, iteration: i });
        log(sessionId, `convergiu na iteracao ${i + 1} (ganho ${pick.gain.toFixed(1)}pp < minGain ${minGain})`);
        await saveSession(record);
        break;
      }
    }

    // 6) Gate final: holdout + significancia. NUNCA derruba a sessao — falha
    //    aqui vira warn e o treino termina com o que se tem.
    try {
      await finalizeHoldout(record, apiKey, champion, championIdInLastRun, holdoutStages, prevRun);
    } catch (err) {
      console.warn(
        `[train ${sessionId}] gate de holdout/significancia falhou (sessao segue): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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

/**
 * Gate final do treino (port do evolve.mjs): re-score do campeao contra o
 * controle (base) nos cenarios de HOLDOUT — que ficaram fora da selecao — mais
 * significancia estatistica (bootstrap pareado). E SUPORTE A DECISAO (a UI
 * mostra ganho/regressao/p-valor); nao bloqueia a promocao nem derruba a
 * sessao (o chamador envolve em try/catch).
 */
async function finalizeHoldout(
  record: SessionRecord,
  apiKey: string,
  champion: Champion | undefined,
  championIdInLastRun: string,
  holdoutStages: StageSpec[],
  lastRun: RunRecord | undefined,
): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const basePrompt = cfg.basePrompt ?? '';

  let holdoutRun: RunRecord | undefined;
  // So ha o que re-testar se a fatia de holdout e confiavel, existe um prompt
  // base p/ servir de controle e o campeao final e uma VARIANTE (se o treino
  // convergiu sem ganho, campeao == base e a run compararia ele consigo mesmo).
  if (
    champion &&
    holdoutStages.length >= MIN_HOLDOUT_SCENARIOS &&
    basePrompt.trim() &&
    champion.systemPrompt !== basePrompt
  ) {
    const runId = randomUUID();
    record.runIds.push(runId);
    await saveSession(record);
    log(sessionId, `holdout: run ${runId} (${holdoutStages.length} cenarios reservados)`);

    const contestants: Contestant[] = [
      {
        id: 'holdout-control',
        label: 'Controle (base)',
        modelId: cfg.contestantModelId,
        systemPrompt: basePrompt,
      },
      {
        id: 'holdout-champion',
        label: 'Campeao (final)',
        modelId: cfg.contestantModelId,
        systemPrompt: champion.systemPrompt,
      },
    ];
    holdoutRun = await runToCompletion(
      { ...variationConfigFrom(cfg), stages: holdoutStages.length, customStages: undefined },
      apiKey,
      {
        runId,
        contestants,
        pinnedStages: holdoutStages,
        sessionId,
        // Marcador "rodada H": a iteracao logo apos a ultima do treino — na UI
        // a run de holdout aparece como uma iteracao extra (N+1).
        iteration: cfg.iterations,
        parentRunId: lastRun?.id,
      },
    );
    record.totalCostUsd += holdoutRun.totalCostUsd;
    if (holdoutRun.status !== 'finished') {
      console.warn(
        `[train ${sessionId}] run de holdout terminou com status ${holdoutRun.status}; gate descartado`,
      );
      holdoutRun = undefined; // cai no fallback de significancia abaixo
    }
  }

  if (holdoutRun) {
    const controlScore = judgeScoreOf(holdoutRun, 'holdout-control');
    const championScore = judgeScoreOf(holdoutRun, 'holdout-champion');
    record.holdout = {
      n: holdoutStages.length,
      controlScore,
      championScore,
      gain: championScore - controlScore,
      regressed: championScore < controlScore,
    };
    emitSessionEvent({ type: 'session.holdout', sessionId, holdout: record.holdout });
    const { controlScores, championScores } = pairedStageScores(
      holdoutRun,
      'holdout-control',
      'holdout-champion',
    );
    record.significance = pairedSignificance(controlScores, championScores);
  } else if (lastRun && champion) {
    // Sem run de holdout (split invalido, campeao == base ou run falhou): a
    // significancia vem da ultima run de treino, pareando a BASE ('original',
    // quando presente — mesma comparacao que o holdout faria) com o campeao;
    // sem base na run, cai na regua da iteracao ('carry'). null se n<5 — a
    // funcao ja trata.
    const lastControlId = (lastRun.iteration ?? 0) === 0 ? 'original' : 'carry';
    const pairingControl = lastRun.contestants.some((c) => c.id === 'original')
      ? 'original'
      : lastControlId;
    const pairable =
      pairingControl !== championIdInLastRun &&
      lastRun.contestants.some((c) => c.id === pairingControl) &&
      lastRun.contestants.some((c) => c.id === championIdInLastRun);
    if (pairable) {
      const { controlScores, championScores } = pairedStageScores(
        lastRun,
        pairingControl,
        championIdInLastRun,
      );
      record.significance = pairedSignificance(controlScores, championScores);
    } else {
      // Campeao == controle (convergiu sem ganho) ou ids ausentes na run:
      // nao ha comparacao a testar.
      record.significance = null;
    }
  }
  await saveSession(record);
}
