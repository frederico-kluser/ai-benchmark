// Mapeamento RunEvent/SessionEvent -> linhas NDJSON.
//
// ⚠️ REGRA CRITICA: nunca transmitir o evento verbatim. `run.started` e
// `run.finished` embutem RunRecords INTEIROS e `competitor.finished` carrega o
// TEXTO COMPLETO da resposta — uma unica run de treino estouraria a janela de
// contexto do agente que esta lendo o stream. Cada evento vira um payload
// enxuto; o record completo fica no disco, acessivel por `runs show`.

import type { Output } from './output.js';
import type { RunEvent, SessionEvent } from '../types.js';

export interface NdjsonMapperOptions {
  /** Com --verbose, inclui config e systemPrompt (que sao grandes). */
  verbose?: boolean;
  /** Marca as linhas de run com o sessionId, quando dentro de um treino. */
  sessionId?: string;
}

export function emitRunEvent(out: Output, e: RunEvent, opts: NdjsonMapperOptions = {}): void {
  if (!out.isNdjson) return;
  // Durante um treino, eventos de sessao e de cada iteracao se intercalam: sem
  // `scope` + os dois ids o stream fica ambiguo e nao da para reconstruir.
  const base = { scope: 'run' as const, runId: e.runId, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) };

  switch (e.type) {
    case 'run.started':
      out.event('run.started', {
        ...base,
        mode: e.record.mode,
        stages: e.record.config.stages,
        contestants: e.record.contestants.map((c) => ({ id: c.id, label: c.label })),
        ...(opts.verbose ? { config: e.record.config } : {}),
      });
      break;
    case 'variants.generating':
      out.event('variants.generating', base);
      break;
    case 'variants.generated':
      out.event('variants.generated', {
        ...base,
        contestants: e.contestants.map((c) => ({
          id: c.id,
          label: c.label,
          ...(c.parentContestantId ? { parentId: c.parentContestantId } : {}),
          ...(opts.verbose ? { systemPrompt: c.systemPrompt } : {}),
        })),
      });
      break;
    case 'stage.generating':
      out.event('stage.generating', { ...base, stageIndex: e.stageIndex });
      break;
    case 'stage.generated':
      out.event('stage.generated', {
        ...base,
        stageIndex: e.stageIndex,
        question: e.spec.question,
        hasRubric: Boolean(e.spec.rubric?.trim()),
        hasReference: Boolean(e.spec.reference?.trim()),
      });
      break;
    case 'stage.failed':
      out.event('stage.failed', { ...base, stageIndex: e.stageIndex, error: e.error });
      break;
    case 'competitor.finished':
      out.event('competitor.finished', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.response.contestantId,
        modelId: e.response.modelId,
        status: e.response.status,
        latencyMs: e.response.latencyMs,
        tokensIn: e.response.tokensIn,
        tokensOut: e.response.tokensOut,
        costUsd: e.response.costUsd,
        chars: e.response.text.length,
        ...(e.response.errorMsg ? { errorMsg: e.response.errorMsg } : {}),
      });
      break;
    case 'stage.judging':
      out.event('stage.judging', { ...base, stageIndex: e.stageIndex });
      break;
    case 'stage.judged':
      out.event('stage.judged', {
        ...base,
        stageIndex: e.stageIndex,
        verdicts: e.judge.verdictByContestant ?? {},
        ranked: e.judge.rankedContestantIds,
        scoreboard: e.scoreboard,
        totalCostUsd: e.totalCostUsd,
      });
      break;
    case 'stage.gabarito':
      // O sentinela `stageIndex: -1` significa "progresso agregado do lote",
      // nao uma etapa. Normalizado aqui para nao confundir quem consome.
      out.event('progress', { ...base, phase: 'gabarito', done: e.done, total: e.total });
      break;
    case 'finals.started':
      out.event('finals.started', { ...base, finalists: e.finalists });
      break;
    case 'stage.dueled':
      out.event('stage.dueled', {
        ...base,
        stageIndex: e.stageIndex,
        pairs: e.duels.duels.map((d) => ({ a: d.a, b: d.b, winner: d.outcome })),
      });
      break;
    case 'duel.progress':
      out.event('progress', { ...base, phase: 'duels', done: e.done, total: e.total });
      break;
    case 'run.spend':
      out.event('budget', {
        ...base,
        spentUsd: e.spentUsd,
        ...(e.budgetUsd !== undefined ? { budgetUsd: e.budgetUsd } : {}),
        byRole: e.byRole,
      });
      break;
    case 'run.budget':
      out.event('budget.gate', {
        ...base,
        phase: e.phase,
        projectedUsd: e.projectedUsd,
        remainingUsd: e.remainingUsd,
        decision: e.decision,
      });
      break;
    case 'run.finished':
      out.event('run.finished', {
        ...base,
        status: e.record.status,
        totalCostUsd: e.record.totalCostUsd,
        stages: e.record.stages.length,
        ...(e.record.budgetExhausted ? { budgetExhausted: true } : {}),
        ...(e.record.stoppedAtPhase ? { stoppedAtPhase: e.record.stoppedAtPhase } : {}),
        ...(e.record.standings ? { standings: e.record.standings } : {}),
        ...(e.record.judgeScoreByContestant
          ? { judgeScoreByContestant: e.record.judgeScoreByContestant }
          : {}),
      });
      break;
    case 'run.error':
      out.event('run.error', { ...base, error: e.error });
      break;
  }
}

export function emitSessionEventNdjson(out: Output, e: SessionEvent): void {
  if (!out.isNdjson) return;
  const base = { scope: 'session' as const, sessionId: e.sessionId };
  switch (e.type) {
    case 'session.started':
      out.event('session.started', {
        ...base,
        iterations: e.record.config.iterations,
        theme: e.record.config.theme,
      });
      break;
    case 'iteration.started':
      out.event('iteration.started', { ...base, iteration: e.iteration, runId: e.runId });
      break;
    case 'iteration.finished':
      out.event('iteration.finished', {
        ...base,
        iteration: e.iteration,
        runId: e.runId,
        winnerContestantId: e.winnerContestantId,
      });
      break;
    case 'iteration.promoted':
      out.event('iteration.promoted', {
        ...base,
        iteration: e.iteration,
        championId: e.championId,
        gain: e.gain,
      });
      break;
    case 'session.holdout':
      out.event('session.holdout', { ...base, ...e.holdout });
      break;
    case 'session.converged':
      out.event('session.converged', { ...base, iteration: e.iteration });
      break;
    case 'session.finished':
      out.event('session.finished', {
        ...base,
        status: e.record.status,
        totalCostUsd: e.record.totalCostUsd,
        iterationsDone: e.record.bestPromptByIteration.length,
        ...(e.record.significance ? { significance: e.record.significance } : {}),
        ...(e.record.holdoutSkipped ? { holdoutSkipped: true } : {}),
        ...(e.record.budgetExhausted ? { budgetExhausted: true } : {}),
      });
      break;
    case 'session.error':
      out.event('session.error', { ...base, error: e.error });
      break;
  }
}
