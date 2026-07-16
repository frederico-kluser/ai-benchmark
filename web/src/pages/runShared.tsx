// Utilitarios de visualizacao de run compartilhados entre RunView (por run) e
// TrainingView (cockpit de treino). Extraidos de RunView para evitar duplicacao
// da logica de placar/heatmap/streaming ao vivo e do reducer de eventos.
import type { Contestant, RunRecord, StageRecord, Verdict } from '../api';
import { normalizeContestants } from '../api';
import { computeMedals, type MedalRow } from '../engine/medals';

// Veredito ternario -> rotulo + classe CSS (ok/partial/bad).
export const VERDICT_META: Record<Verdict, { label: string; cls: string }> = {
  resolve: { label: 'resolve', cls: 'ok' },
  parcial: { label: 'parcial', cls: 'partial' },
  nao: { label: 'não resolve', cls: 'bad' },
};

/** Veredito de um item, com retrocompat ao binario antigo (acceptable). */
export function verdictOf(v?: { verdict?: Verdict; acceptable?: boolean }): Verdict | undefined {
  if (!v) return undefined;
  if (v.verdict) return v.verdict;
  if (typeof v.acceptable === 'boolean') return v.acceptable ? 'resolve' : 'nao';
  return undefined;
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Etapas sem buracos (array pode ficar esparso/fora de ordem sob execucao
// paralela) e ordenadas por index. Toda a UI de resultados usa isto — sem o
// filtro, `stages.map(s => s.index)` quebra em buracos (foi o bug do heatmap).
export function denseStages(stages: StageRecord[]): StageRecord[] {
  return stages.filter((s): s is StageRecord => Boolean(s)).slice().sort((a, b) => a.index - b.index);
}

export interface RankColor {
  solid: string;
  soft: string;
  text: string;
}

// Verde (melhor) -> vermelho (pior), em HSL. `pos` é 1-based.
export function rankColor(pos: number, total: number, dark: boolean): RankColor {
  const tl = dark ? 72 : 34;
  const sa = dark ? 0.22 : 0.15;
  if (total <= 1 || pos < 1) {
    return { solid: 'hsl(145 60% 42%)', soft: `hsl(145 70% 50% / ${sa})`, text: `hsl(145 55% ${tl}%)` };
  }
  const frac = (pos - 1) / (total - 1);
  const hue = Math.round(145 - (145 - 6) * frac);
  return { solid: `hsl(${hue} 62% 44%)`, soft: `hsl(${hue} 75% 50% / ${sa})`, text: `hsl(${hue} 58% ${tl}%)` };
}

export interface Standing {
  contestantId: string;
  label: string;
  points: number;
  firstPlaces: number;
  avgPos: number | null;
  rankedStages: number;
  acceptable: number;
  evaluated: number;
  errors: number;
}

export function computeStandings(record: RunRecord): Standing[] {
  const contestants = normalizeContestants(record);
  const rows: Standing[] = contestants.map((c) => {
    const positions: number[] = [];
    let firstPlaces = 0;
    let acceptable = 0;
    let evaluated = 0;
    let errors = 0;
    for (const s of record.stages) {
      if (!s) continue;
      const pos = (s.judge?.rankedContestantIds ?? []).indexOf(c.id);
      if (pos >= 0) {
        positions.push(pos);
        if (pos === 0) firstPlaces++;
      }
      if (s.responses.some((r) => r.contestantId === c.id && r.status === 'error')) errors++;
      // Aceitabilidade: vem do juiz (maioria). Retrocompat: estagio "evaluation" antigo.
      const accBy = s.judge?.acceptableByContestant;
      if (accBy && c.id in accBy) {
        evaluated++;
        if (accBy[c.id]) acceptable++;
      } else if (s.evaluation && !s.evaluation.inconclusive) {
        const v = s.evaluation.verdicts.find((x) => x.contestantId === c.id);
        if (v) {
          evaluated++;
          if (v.acceptable) acceptable++;
        }
      }
    }
    return {
      contestantId: c.id,
      label: c.label,
      points: record.scoreboard[c.id] ?? 0,
      firstPlaces,
      avgPos: positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length + 1 : null,
      rankedStages: positions.length,
      acceptable,
      evaluated,
      errors,
    };
  });
  return rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const ap = a.avgPos ?? Infinity;
    const bp = b.avgPos ?? Infinity;
    if (ap !== bp) return ap - bp;
    if (b.firstPlaces !== a.firstPlaces) return b.firstPlaces - a.firstPlaces;
    return a.contestantId.localeCompare(b.contestantId);
  });
}

export function stageStatus(stage: StageRecord, totalComp: number): { text: string; cls: string } {
  if (stage.error) return { text: 'falhou', cls: 'b-neutral' };
  if (stage.judge?.inconclusive) return { text: 'inconclusivo', cls: 'b-neutral' };
  if (stage.judge) return { text: 'julgado', cls: 'b-ok' };
  if (!stage.spec) return { text: 'gerando cenário', cls: 'b-neutral' };
  const liveActive = stage.live ? Object.values(stage.live).some((l) => !l.done) : false;
  if (liveActive || stage.responses.length < totalComp) return { text: 'respondendo', cls: 'b-blue' };
  return { text: 'aguardando juiz', cls: 'b-warn' };
}

// ---------------------------------------------------------------------------
// Quadro de medalhas para a UI (metrica do treino). Envolve computeMedals com
// os rotulos/tecnica de cada contestant. Ver `engine/medals.ts`.
// ---------------------------------------------------------------------------

export interface MedalStanding extends MedalRow {
  label: string;
  techniqueId?: string;
  isOriginal?: boolean;
  parentContestantId?: string;
}

export function medalStandings(record: RunRecord): MedalStanding[] {
  const byId = new Map<string, Contestant>((record.contestants ?? []).map((c) => [c.id, c]));
  // computeMedals tipa pelo RunRecord da engine; a UI usa o do api.ts (config
  // mais frouxo). computeMedals nunca le `config`, entao o cast e seguro.
  return computeMedals(record as never).map((row) => {
    const c = byId.get(row.contestantId);
    return {
      ...row,
      label: c?.label ?? row.contestantId,
      techniqueId: c?.techniqueId,
      isOriginal: c?.isOriginal,
      parentContestantId: c?.parentContestantId,
    };
  });
}

// ---------------------------------------------------------------------------
// Visualizador de PROCESSO ao vivo: todas as etapas rodando em paralelo. Os
// resultados finais (placar/heatmap) só aparecem quando a run termina.
// ---------------------------------------------------------------------------

export function ProcessMonitor({
  record,
  totalCompetitors,
}: {
  record: RunRecord;
  totalCompetitors: number;
}) {
  const total = record.config.stages;
  const stages = denseStages(record.stages);
  const done = stages.filter((s) => s.judge || s.error).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <>
      <div className="section-label">Processo ao vivo</div>
      <div className="process-progress">
        <div className="process-bar">
          <div className="process-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="process-progress-label">{done}/{total} etapas concluídas</span>
      </div>
      {stages.length === 0 && (
        <div className="card" style={{ color: 'var(--text-3)' }}>Preparando as etapas…</div>
      )}
      <div className="process-list">
        {stages.map((s) => (
          <ProcessRow key={s.index} stage={s} totalCompetitors={totalCompetitors} />
        ))}
      </div>
    </>
  );
}

function ProcessRow({ stage, totalCompetitors }: { stage: StageRecord; totalCompetitors: number }) {
  const badge = stageStatus(stage, totalCompetitors);
  const liveValues = stage.live ? Object.values(stage.live) : [];
  const numLabel = String(stage.index + 1).padStart(2, '0');
  return (
    <div className="process-row">
      <div className="process-row-head">
        <span className="stage-num">{numLabel}</span>
        <span className={`stage-badge ${badge.cls}`}>{badge.text}</span>
        <span className="process-row-meta">{stage.responses.length}/{totalCompetitors} respostas</span>
      </div>
      {stage.spec && <div className="process-row-q">{trunc(stage.spec.question, 110)}</div>}
      {!stage.spec && !stage.error && (
        <div className="inline-status"><span className="spinner" />Gerando cenário…</div>
      )}
      {stage.error && <div className="process-row-err">Etapa pulada: {stage.error}</div>}
      {liveValues.length > 0 && (
        <div className="process-live">
          {liveValues.map((l) => (
            <div className="process-live-item" key={l.contestantId}>
              <div className="process-live-head">
                <span className="live-model">{l.label ?? l.modelId}</span>
                <span className="live-counter">
                  {l.chars} chars · {l.charsPerSec.toFixed(0)} ch/s{l.done ? ' ✓' : ''}
                </span>
              </div>
              <div className="live-preview">
                {l.preview || '…'}
                {!l.done && <span className="live-caret" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reducer client-side: dobra os eventos granulares (chegam FORA de ordem sob
// execucao paralela) sobre o RunRecord vivo. Usado por RunView e pela cockpit.
// ---------------------------------------------------------------------------

export function applyEvent(prev: RunRecord, event: any): RunRecord {
  const next: RunRecord = {
    ...prev,
    stages: prev.stages.map((s) => ({
      ...s,
      responses: [...s.responses],
      live: s.live ? { ...s.live } : undefined,
    })),
  };
  const labelOf = (id: string) => next.contestants?.find((c) => c.id === id)?.label;
  switch (event.type) {
    case 'run.started':
      return event.record;
    case 'variants.generated':
      return { ...next, contestants: event.contestants };
    case 'stage.generating': {
      // Coloca POR INDICE (nao push): sob execucao paralela os eventos chegam
      // fora de ordem; o push desalinhava o array (era o bug do heatmap/resumo).
      if (!next.stages[event.stageIndex]) {
        next.stages[event.stageIndex] = {
          index: event.stageIndex,
          responses: [],
          startedAt: new Date().toISOString(),
        };
      }
      return next;
    }
    case 'stage.generated': {
      const s = next.stages[event.stageIndex];
      if (s) s.spec = event.spec;
      return next;
    }
    case 'stage.failed': {
      let s = next.stages[event.stageIndex];
      if (!s) {
        s = { index: event.stageIndex, responses: [], startedAt: new Date().toISOString() };
        next.stages[event.stageIndex] = s;
      }
      s.error = event.error;
      s.live = undefined;
      s.finishedAt = new Date().toISOString();
      return next;
    }
    case 'competitor.started': {
      const s = next.stages[event.stageIndex];
      if (s) {
        if (!s.live) s.live = {};
        s.live[event.contestantId] = {
          contestantId: event.contestantId,
          modelId: event.modelId,
          label: labelOf(event.contestantId),
          startedAt: Date.now(),
          chars: 0,
          charsPerSec: 0,
          preview: '',
          done: false,
        };
      }
      return next;
    }
    case 'competitor.progress': {
      const s = next.stages[event.stageIndex];
      if (s) {
        if (!s.live) s.live = {};
        const existing = s.live[event.contestantId];
        s.live[event.contestantId] = {
          contestantId: event.contestantId,
          modelId: event.modelId,
          label: existing?.label ?? labelOf(event.contestantId),
          startedAt: existing?.startedAt ?? Date.now(),
          chars: event.chars,
          charsPerSec: event.charsPerSec,
          preview: event.preview,
          done: false,
        };
      }
      return next;
    }
    case 'competitor.finished': {
      const s = next.stages[event.stageIndex];
      if (s) {
        const idx = s.responses.findIndex((r) => r.contestantId === event.response.contestantId);
        if (idx >= 0) s.responses[idx] = event.response;
        else s.responses.push(event.response);
        if (s.live && s.live[event.response.contestantId]) {
          s.live[event.response.contestantId] = { ...s.live[event.response.contestantId], done: true };
        }
        next.totalCostUsd = (next.totalCostUsd ?? 0) + event.response.costUsd;
      }
      return next;
    }
    case 'stage.judged': {
      const s = next.stages[event.stageIndex];
      if (s) {
        s.judge = event.judge;
        s.finishedAt = new Date().toISOString();
        s.live = undefined;
      }
      next.scoreboard = event.scoreboard;
      next.totalCostUsd = event.totalCostUsd;
      return next;
    }
    case 'run.finished':
      return event.record;
    case 'run.error':
      return { ...next, status: 'error', error: event.error };
    default:
      return next;
  }
}
