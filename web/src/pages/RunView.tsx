import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Contestant, RunRecord, StageRecord } from '../api';
import { cacheRun, fetchRun, normalizeContestants, openRunStream, runMode } from '../api';
import { useTheme } from '../theme';

function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.001) return `$${v.toExponential(2)}`;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Export client-side (sem backend): gera o blob e dispara o download.
function download(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function runToCsv(record: RunRecord, byId: Map<string, Contestant>): string {
  const rows: string[] = [];
  rows.push(
    ['runId', 'sessionId', 'iteration', 'stageIndex', 'question', 'contestantId', 'label', 'technique', 'modelId', 'status', 'latencyMs', 'tokensIn', 'tokensOut', 'costUsd', 'rankPosition', 'errorMsg', 'text']
      .map(csvEscape)
      .join(','),
  );
  for (const stage of record.stages) {
    const ranking = stage.judge?.rankedContestantIds ?? [];
    for (const r of stage.responses) {
      const rankPosition = ranking.indexOf(r.contestantId);
      const c = byId.get(r.contestantId);
      rows.push(
        [record.id, record.sessionId ?? '', record.iteration ?? '', stage.index, stage.spec?.question ?? '', r.contestantId, c?.label ?? '', c?.techniqueId ?? '', r.modelId, r.status, r.latencyMs, r.tokensIn, r.tokensOut, r.costUsd, rankPosition >= 0 ? rankPosition + 1 : '', r.errorMsg ?? '', r.text]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return rows.join('\n');
}

interface RankColor {
  solid: string;
  soft: string;
  text: string;
}

// Verde (melhor) -> vermelho (pior), em HSL. `pos` é 1-based.
function rankColor(pos: number, total: number, dark: boolean): RankColor {
  const tl = dark ? 72 : 34;
  const sa = dark ? 0.22 : 0.15;
  if (total <= 1 || pos < 1) {
    return { solid: 'hsl(145 60% 42%)', soft: `hsl(145 70% 50% / ${sa})`, text: `hsl(145 55% ${tl}%)` };
  }
  const frac = (pos - 1) / (total - 1);
  const hue = Math.round(145 - (145 - 6) * frac);
  return { solid: `hsl(${hue} 62% 44%)`, soft: `hsl(${hue} 75% 50% / ${sa})`, text: `hsl(${hue} 58% ${tl}%)` };
}

interface Standing {
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

function computeStandings(record: RunRecord): Standing[] {
  const contestants = normalizeContestants(record);
  const rows: Standing[] = contestants.map((c) => {
    const positions: number[] = [];
    let firstPlaces = 0;
    let acceptable = 0;
    let evaluated = 0;
    let errors = 0;
    for (const s of record.stages) {
      const pos = (s.judge?.rankedContestantIds ?? []).indexOf(c.id);
      if (pos >= 0) {
        positions.push(pos);
        if (pos === 0) firstPlaces++;
      }
      if (s.responses.some((r) => r.contestantId === c.id && r.status === 'error')) errors++;
      const ev = s.evaluation;
      if (ev && !ev.inconclusive) {
        const v = ev.verdicts.find((x) => x.contestantId === c.id);
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

function stageStatus(stage: StageRecord, totalComp: number): { text: string; cls: string } {
  if (stage.error) return { text: 'falhou', cls: 'b-neutral' };
  if (stage.judge?.inconclusive) return { text: 'inconclusivo', cls: 'b-neutral' };
  if (stage.judge) return { text: 'julgado', cls: 'b-ok' };
  if (!stage.spec) return { text: 'gerando cenário', cls: 'b-neutral' };
  const liveActive = stage.live ? Object.values(stage.live).some((l) => !l.done) : false;
  if (liveActive || stage.responses.length < totalComp) return { text: 'respondendo', cls: 'b-blue' };
  return { text: 'aguardando juiz', cls: 'b-warn' };
}

const RING_R = 18;
const RING_C = 2 * Math.PI * RING_R;

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const theme = useTheme();
  const dark = theme === 'dark';
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openStages, setOpenStages] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<'resumo' | 'etapas' | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    fetchRun(id)
      .then((r) => !cancelled && setRecord(r))
      .catch((e) => !cancelled && setError(e.message));

    const close = openRunStream(
      id,
      (event) => {
        if (cancelled) return;
        if (event.type === 'snapshot') {
          setRecord(event.record);
          void cacheRun(event.record);
          return;
        }
        if (event.type === 'stage.generating' || event.type === 'competitor.started') {
          setOpenStages((prev) => new Set(prev).add(event.stageIndex));
        }
        if (event.type === 'run.finished') void cacheRun(event.record);
        setRecord((prev) => prev && applyEvent(prev, event));
      },
      () => {
        fetchRun(id).then((r) => !cancelled && setRecord(r)).catch(() => undefined);
      },
    );

    return () => {
      cancelled = true;
      close();
    };
  }, [id]);

  function toggle(idx: number) {
    setOpenStages((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  const contestants = useMemo(() => (record ? normalizeContestants(record) : []), [record]);
  const byId = useMemo(
    () => new Map<string, Contestant>(contestants.map((c) => [c.id, c])),
    [contestants],
  );
  const standings = useMemo(() => (record ? computeStandings(record) : []), [record]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;
  if (!record) return <div className="screen center-screen"><div className="loading-note">Carregando…</div></div>;

  const mode = runMode(record);
  const totalCompetitors = contestants.length;
  const totalStages = record.config.stages;
  const doneStages = record.stages.filter((s) => s.judge || s.error).length;
  const hasRing = record.status === 'running' || record.status === 'finished';
  const ringOffset = RING_C * (1 - (totalStages ? doneStages / totalStages : 0));

  const isRunning = record.status === 'running';
  // Resultados (placar/heatmap/etapas detalhadas) só aparecem quando a run TERMINA.
  // Enquanto roda, mostramos o visualizador de processo (todas as etapas em paralelo).
  const hasScoreboard = record.stages.some((s) => s.judge);
  const effectiveTab = tab ?? (hasScoreboard ? 'resumo' : 'etapas');
  const showScoreboard = hasScoreboard && effectiveTab === 'resumo';
  const showStages = !hasScoreboard || effectiveTab === 'etapas';
  const isSingle = mode !== 'compare';

  return (
    <div className="screen runview">
      <div className="card run-header">
        <div className="run-header-main">
          <div className="run-title-row">
            <h1 className="run-title">Run <code>{record.id.slice(0, 8)}</code></h1>
            {isSingle && <span className={`pill pill-${mode}`}>{mode === 'variation' ? 'variação' : 'treino'}</span>}
            {record.iteration != null && <span className="run-iter">iteração {record.iteration + 1}</span>}
            {record.status === 'running' && (
              <span className="live-pill"><span className="dot" />AO VIVO</span>
            )}
          </div>
          {record.sessionId && (
            <Link className="session-link" to={`/training/${record.sessionId}`}>← voltar à sessão de treino</Link>
          )}
          <div className="run-theme">{record.config.theme}</div>
        </div>

        <div className="run-stats">
          <div>
            <div className="run-stat-label">Status</div>
            <span className={`pill pill-${record.status}`}>{record.status}</span>
          </div>

          {hasRing && (
            <div className="run-ring-wrap">
              <svg className="run-ring" width="46" height="46" viewBox="0 0 46 46">
                <circle className="run-ring-track" cx="23" cy="23" r={RING_R} fill="none" strokeWidth="5" />
                <circle
                  className="run-ring-fill"
                  cx="23"
                  cy="23"
                  r={RING_R}
                  fill="none"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={RING_C.toFixed(2)}
                  strokeDashoffset={ringOffset.toFixed(2)}
                  transform="rotate(-90 23 23)"
                />
              </svg>
              <div>
                <div className="run-stat-label" style={{ marginBottom: 2 }}>Etapas</div>
                <div className="run-stat-strong">{doneStages}/{totalStages}</div>
              </div>
            </div>
          )}

          <div style={{ textAlign: 'right' }}>
            <div className="run-stat-label" style={{ marginBottom: 6 }}>Custo total</div>
            <div className="run-cost">{formatUsd(record.totalCostUsd)}</div>
            <div className="export-row">
              <button type="button" className="export-btn" onClick={() => download(`run-${record.id}.json`, JSON.stringify(record, null, 2), 'application/json')}>JSON</button>
              <button type="button" className="export-btn" onClick={() => download(`run-${record.id}.csv`, runToCsv(record, byId), 'text/csv;charset=utf-8')}>CSV</button>
            </div>
          </div>
        </div>
      </div>

      {record.status === 'error' && record.error && (
        <div className="banner banner-error"><strong>A run falhou:</strong> {record.error}</div>
      )}
      {record.status === 'aborted' && (
        <div className="banner banner-neutral">
          Run interrompida — o servidor reiniciou enquanto ela rodava; por isso foi marcada como abortada.
        </div>
      )}

      {isSingle && <ContestantsPanel contestants={contestants} />}

      {isRunning && <ProcessMonitor record={record} totalCompetitors={totalCompetitors} />}

      {!isRunning && hasScoreboard && (
        <div className="run-tabs-bar">
          <div className="tabs">
            <button className={`tab ${effectiveTab === 'resumo' ? 'active' : ''}`} onClick={() => setTab('resumo')}>Resumo</button>
            <button className={`tab ${effectiveTab === 'etapas' ? 'active' : ''}`} onClick={() => setTab('etapas')}>Etapas</button>
          </div>
        </div>
      )}

      {!isRunning && showScoreboard && (
        <>
          <div className="section-label">Classificação final (1º ao último)</div>
          <div className="score-card">
            <div className="score-head">
              <div>Col.</div><div>{isSingle ? 'Variante' : 'Modelo'}</div><div>Pontos</div><div>1ºs</div><div>Pos. média</div><div>Aceitável p/ o trabalho</div><div>Erros</div>
            </div>
            {standings.map((row, idx) => {
              const acceptRate = row.evaluated > 0 ? row.acceptable / row.evaluated : null;
              return (
                <div className="score-row" key={row.contestantId}>
                  <div>
                    <span className="place-badge" style={{ background: rankColor(idx + 1, standings.length, dark).solid }}>
                      {idx + 1}º
                    </span>
                  </div>
                  <div className="score-model">{row.label}</div>
                  <div className="score-points">{row.points}</div>
                  <div className="score-num">{row.firstPlaces}</div>
                  <div className="score-num">{row.avgPos != null ? row.avgPos.toFixed(2) : '—'}</div>
                  <div className="score-accept" style={{ color: row.evaluated === 0 ? 'var(--text-3)' : acceptRate != null && acceptRate >= 0.5 ? 'var(--ok)' : 'var(--err)' }}>
                    {row.evaluated === 0
                      ? '—'
                      : `${row.acceptable}/${row.evaluated}${acceptRate != null ? ` (${Math.round(acceptRate * 100)}%)` : ''}`}
                  </div>
                  <div className="score-num" style={{ color: row.errors > 0 ? 'var(--err)' : 'var(--text-2)' }}>{row.errors}</div>
                </div>
              );
            })}
            <div className="score-foot">
              Pontos somam o esquema corrida (1º = N−1, … último = 0) de todas as etapas.
              “Aceitável” = a resposta resolve a necessidade de forma correta e segura, mesmo sem ser a melhor.
            </div>
          </div>

          <div className="section-label">Heatmap de posições</div>
          <div className="heat-legend">
            <span>1º melhor</span>
            <span className="bar" />
            <span>último</span>
            <span style={{ marginLeft: 4 }}>·&nbsp;· = não ranqueado</span>
          </div>
          <div className="heat-card">
            <div className="heat-inner">
              <div className="heat-row head">
                <div className="heat-spacer" />
                {record.stages.map((s) => (
                  <div className="heat-col" key={s.index}>{s.index + 1}</div>
                ))}
              </div>
              {contestants.map((c) => (
                <div className="heat-row" key={c.id}>
                  <div className="heat-label">{c.label}</div>
                  {record.stages.map((s) => {
                    const ranking = s.judge?.rankedContestantIds ?? [];
                    const pos = ranking.indexOf(c.id);
                    if (pos < 0) {
                      return (
                        <div className="heat-cell-wrap" key={s.index} title={`Etapa ${s.index + 1}: não ranqueado`}>
                          <span className="heat-cell" style={{ background: 'var(--subtle)', color: 'var(--faint)' }}>·</span>
                        </div>
                      );
                    }
                    const rc = rankColor(pos + 1, totalCompetitors, dark);
                    return (
                      <div className="heat-cell-wrap" key={s.index} title={`Etapa ${s.index + 1}: posição ${pos + 1}`}>
                        <span className="heat-cell" style={{ background: rc.soft, color: rc.text }}>{pos + 1}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {!isRunning && showStages && (
        <>
          <div className="section-label">Etapas</div>
          {record.stages.length === 0 && (
            <div className="card" style={{ color: 'var(--text-3)' }}>Aguardando a primeira etapa…</div>
          )}
          {record.stages.map((stage) => (
            <StageCard
              key={stage.index}
              stage={stage}
              byId={byId}
              open={openStages.has(stage.index)}
              onToggle={() => toggle(stage.index)}
              totalCompetitors={totalCompetitors}
              dark={dark}
            />
          ))}
        </>
      )}
    </div>
  );
}

// Visualizador de PROCESSO ao vivo: todas as etapas rodando em paralelo. Os
// resultados finais (placar/heatmap) só aparecem quando a run termina.
function ProcessMonitor({
  record,
  totalCompetitors,
}: {
  record: RunRecord;
  totalCompetitors: number;
}) {
  const total = record.config.stages;
  const done = record.stages.filter((s) => s.judge || s.error).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const stages = record.stages.slice().sort((a, b) => a.index - b.index);
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

function ContestantsPanel({ contestants }: { contestants: Contestant[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const modelId = contestants[0]?.modelId;
  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <>
      <div className="section-label">Variantes de prompt</div>
      <div className="card variants-card">
        {modelId && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Modelo sob teste: <code className="mono-id">{modelId}</code>
          </div>
        )}
        {contestants.map((c) => (
          <div className="contestant-row" key={c.id}>
            <button type="button" className="contestant-head" onClick={() => toggle(c.id)}>
              <span className="contestant-label">
                {c.label}
                {c.isOriginal && <span className="control-tag">controle</span>}
                {c.techniqueId && <span className="tech-tag">{c.techniqueId}</span>}
              </span>
              <span className={`stage-caret ${open.has(c.id) ? 'open' : ''}`}>▶</span>
            </button>
            {open.has(c.id) &&
              (c.systemPrompt ? (
                <pre className="context-pre contestant-prompt">{c.systemPrompt}</pre>
              ) : (
                <div className="contestant-prompt muted" style={{ fontSize: 13 }}>
                  (usa o contexto do cenário gerado por etapa)
                </div>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}

function StageCard({
  stage,
  byId,
  open,
  onToggle,
  totalCompetitors,
  dark,
}: {
  stage: StageRecord;
  byId: Map<string, Contestant>;
  open: boolean;
  onToggle: () => void;
  totalCompetitors: number;
  dark: boolean;
}) {
  const ranking = stage.judge?.rankedContestantIds ?? [];
  const blindMap = stage.judge?.blindMap ?? {};
  const contestantToLetter: Record<string, string> = {};
  for (const [letter, cid] of Object.entries(blindMap)) contestantToLetter[cid] = letter;

  const ev = stage.evaluation;
  const verdictByContestant: Record<string, { acceptable: boolean; justification: string }> = {};
  for (const v of ev?.verdicts ?? []) verdictByContestant[v.contestantId] = v;

  const labelFor = (cid: string, fallback: string) => byId.get(cid)?.label ?? fallback;

  const badge = stageStatus(stage, totalCompetitors);
  const numLabel = String(stage.index + 1).padStart(2, '0');
  const snippet = stage.error
    ? stage.spec ? trunc(stage.spec.question, 76) : 'Etapa pulada'
    : stage.spec ? trunc(stage.spec.question, 76) : 'Gerando cenário…';

  const liveValues = stage.live ? Object.values(stage.live) : [];
  const showLive = !stage.judge && !stage.error && liveValues.length > 0;
  const liveActive = liveValues.some((l) => !l.done);

  const sortedResponses = stage.responses
    .slice()
    .sort((a, b) => {
      const pa = ranking.indexOf(a.contestantId);
      const pb = ranking.indexOf(b.contestantId);
      return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
    });

  return (
    <div className="stage-card">
      <button className="stage-head" onClick={onToggle}>
        <span className="stage-head-left">
          <span className="stage-num">{numLabel}</span>
          <span className="stage-snippet">{snippet}</span>
        </span>
        <span className="stage-head-right">
          <span className={`stage-badge ${badge.cls}`}>{badge.text}</span>
          <span className={`stage-caret ${open ? 'open' : ''}`}>▶</span>
        </span>
      </button>

      {open && (
        <div className="stage-body">
          {stage.error && (
            <div className="banner banner-neutral" style={{ marginTop: 16, marginBottom: 0 }}>
              <strong>Etapa pulada:</strong> {stage.error} A run seguiu normalmente nas demais etapas.
            </div>
          )}

          {!stage.error && !stage.spec && (
            <div className="inline-status">
              <span className="spinner" />
              Gerando cenário com o modelo gerador…
            </div>
          )}

          {stage.spec && (
            <>
              <div className="stage-block">
                <div className="label-mini">Pergunta</div>
                <div className="q-text">{stage.spec.question}</div>
              </div>
              <div className="stage-block">
                <div className="label-mini">Contexto do cenário (gerado)</div>
                <pre className="context-pre">{stage.spec.productContext}</pre>
              </div>
            </>
          )}

          {ev && !ev.inconclusive && (
            <div className="evaluation-box">
              <div className="evaluation-head">
                <span className="winner-pill">Vencedor</span>
                <span className="evaluation-model">{labelFor(ev.bestContestantId, ev.bestContestantId)}</span>
              </div>
              <p className="evaluation-reasons">{ev.bestReasons}</p>
            </div>
          )}
          {ev?.inconclusive && (
            <div className="stage-block label-mini" style={{ letterSpacing: 0, textTransform: 'none', color: 'var(--text-3)', fontWeight: 400, fontSize: 13 }}>
              Avaliação qualitativa indisponível nesta etapa.
            </div>
          )}

          {showLive && (
            <div className="live-cards">
              {liveValues.map((l) => (
                <div className="live-card" key={l.contestantId}>
                  <div className="live-head">
                    <span className="live-model">{l.label ?? l.modelId}</span>
                    <span className="live-counter">{l.chars} chars · {l.charsPerSec.toFixed(1)} ch/s</span>
                  </div>
                  <div className="live-preview">
                    {l.preview || '…'}
                    {!l.done && <span className="live-caret" />}
                  </div>
                </div>
              ))}
              {!liveActive && (
                <div className="judging-row">
                  <span className="spinner spinner-muted" />
                  Respostas enviadas ao juiz — aguardando ranking às cegas…
                </div>
              )}
            </div>
          )}

          {stage.judge && sortedResponses.length > 0 && (
            <div className="answers">
              {sortedResponses.map((r) => {
                const pos = ranking.indexOf(r.contestantId);
                const letter = contestantToLetter[r.contestantId];
                const verdict = verdictByContestant[r.contestantId];
                return (
                  <div className="answer-card" key={r.contestantId}>
                    <div className="answer-head">
                      {pos >= 0 && (
                        <span className="rank-badge" style={{ background: rankColor(pos + 1, totalCompetitors, dark).solid }}>
                          #{pos + 1}
                        </span>
                      )}
                      <span className="answer-model">{labelFor(r.contestantId, r.modelId)}</span>
                      {letter && <span className="answer-blind">(era {letter})</span>}
                      {verdict && (
                        <span className={`verdict-pill ${verdict.acceptable ? 'ok' : 'bad'}`}>
                          {verdict.acceptable ? 'aceitável p/ o trabalho' : 'não aceitável'}
                        </span>
                      )}
                    </div>
                    <div className="answer-meta">
                      {formatMs(r.latencyMs)} · {r.tokensIn}→{r.tokensOut} tok · {r.text.length} chars · {formatUsd(r.costUsd)}
                      {r.status === 'error' && <span className="err"> · ERRO: {r.errorMsg}</span>}
                    </div>
                    {verdict?.justification && <div className="answer-note">{verdict.justification}</div>}
                    {r.status === 'ok' && <pre className="answer-text">{r.text}</pre>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function applyEvent(prev: RunRecord, event: any): RunRecord {
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
      if (!next.stages[event.stageIndex]) {
        next.stages.push({ index: event.stageIndex, responses: [], startedAt: new Date().toISOString() });
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
        s.evaluation = event.evaluation;
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
