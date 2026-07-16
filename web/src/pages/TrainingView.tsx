import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RunRecord, SessionRecord } from '../api';
import {
  cacheSession,
  fetchSession,
  openSessionStream,
  fetchRun,
  getLiveRun,
  subscribeRunLive,
  getConcurrency,
} from '../api';
import { useTheme } from '../theme';
import {
  applyEvent,
  denseStages,
  medalStandings,
  rankColor,
  ProcessMonitor,
} from './runShared';
import { diffLines } from '../diff';

// ---------------------------------------------------------------------------
// Cockpit de treino: acompanha a sessao inteira ao vivo (paralelismo, quadro de
// medalhas, heatmaps, colocacao) sem precisar entrar em cada /runs/:id, e no fim
// deixa escolher/comparar/copiar o melhor prompt. O pipeline (paralelo, juizes,
// medalhas) ja existe na engine — aqui so superficializamos e enriquecemos.
// ---------------------------------------------------------------------------

/** Passos macro do treino (reusa a estetica do assistente). */
function PhaseStepper({ status, done, planned }: { status: RunRecord['status']; done: number; planned: number }) {
  const phase = status === 'finished' ? 2 : 1; // 0=config (ja passou), 1=treinando, 2=escolher
  const steps = ['Configurado', `Treinando ${done}/${planned}`, 'Escolher o melhor'];
  return (
    <div className="phase-stepper">
      {steps.map((label, i) => (
        <div key={label} className={`phase-step ${i < phase ? 'done' : ''} ${i === phase ? 'current' : ''}`}>
          <span className="phase-step-num">{i + 1}</span>
          <span className="phase-step-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Barra de paralelismo: telemetria do limitador AIMD + estado semantico do run vivo. */
function FanOutBar({ fanout, liveRun }: { fanout: { limit: number; active: number; queued: number } | null; liveRun: RunRecord | null }) {
  const sem = useMemo(() => {
    let answering = 0;
    let judging = 0;
    let generating = 0;
    if (liveRun) {
      for (const s of denseStages(liveRun.stages)) {
        if (s.error || s.judge) continue;
        if (!s.spec) {
          generating++;
          continue;
        }
        const live = s.live ? Object.values(s.live) : [];
        const activeLive = live.filter((l) => !l.done).length;
        if (activeLive > 0) answering += activeLive;
        else judging++;
      }
    }
    return { answering, judging, generating };
  }, [liveRun]);

  return (
    <div className="fanout-bar">
      <span className="fanout-title">Paralelismo</span>
      <span className="fanout-chip fanout-run">▶ {fanout?.active ?? 0} chamadas ativas</span>
      <span className="fanout-chip fanout-queue">⏳ {fanout?.queued ?? 0} na fila</span>
      <span className="fanout-chip fanout-limit">teto AIMD {fanout?.limit ?? '—'}</span>
      {sem.generating > 0 && <span className="fanout-chip">🧩 {sem.generating} gerando cenário</span>}
      {sem.answering > 0 && <span className="fanout-chip fanout-answer">✍️ {sem.answering} respondendo</span>}
      {sem.judging > 0 && <span className="fanout-chip fanout-judge">⚖️ {sem.judging} no juiz</span>}
    </div>
  );
}

/** Quadro de medalhas (colocacao olimpica) de uma rodada. */
function MedalBoard({ record, dark }: { record: RunRecord; dark: boolean }) {
  const rows = medalStandings(record);
  if (!rows.length) return <div className="card" style={{ color: 'var(--text-3)' }}>Aguardando os primeiros vereditos…</div>;
  return (
    <div className="card medal-board">
      <div className="medal-row medal-head">
        <div>Col.</div>
        <div>Variante</div>
        <div title="Ouros (1os lugares)">🥇</div>
        <div title="Pratas (2os lugares)">🥈</div>
        <div title="Bronzes (3os lugares)">🥉</div>
        <div title="Provas em que foi ranqueada">Provas</div>
      </div>
      {rows.map((row, idx) => (
        <div className="medal-row" key={row.contestantId}>
          <div>
            <span className="place-badge" style={{ background: rankColor(idx + 1, rows.length, dark).solid }}>
              {idx + 1}º
            </span>
          </div>
          <div className="medal-model">
            {row.label}
            {row.isOriginal && <span className="control-tag">controle</span>}
            {row.techniqueId && <span className="tech-tag">{row.techniqueId}</span>}
          </div>
          <div className="medal-count medal-gold">{row.golds}</div>
          <div className="medal-count medal-silver">{row.silvers}</div>
          <div className="medal-count medal-bronze">{row.bronzes}</div>
          <div className="medal-count">{row.ranked}</div>
        </div>
      ))}
    </div>
  );
}

const VERDICT_CELL: Record<string, { glyph: string; bg: string; color: string }> = {
  resolve: { glyph: '✓', bg: 'var(--ok-soft)', color: 'var(--ok)' },
  parcial: { glyph: '◐', bg: 'var(--warn-soft)', color: 'var(--warn)' },
  nao: { glyph: '✕', bg: 'var(--err-soft)', color: 'var(--err)' },
};

/** Heatmap variante x cenario: como cada prompt performou (glifos colorblind-safe). */
function VerdictHeatmap({ record }: { record: RunRecord }) {
  const stages = denseStages(record.stages);
  const contestants = record.contestants ?? [];
  if (!contestants.length || !stages.length) return null;
  return (
    <div className="heat-card">
      <div className="heat-inner">
        <div className="heat-row head">
          <div className="heat-spacer" />
          {stages.map((s) => (
            <div className="heat-col" key={s.index}>{s.index + 1}</div>
          ))}
        </div>
        {contestants.map((c) => (
          <div className="heat-row" key={c.id}>
            <div className="heat-label">{c.label}</div>
            {stages.map((s) => {
              const v =
                s.judge?.verdictByContestant?.[c.id] ??
                (s.judge?.acceptableByContestant?.[c.id] === undefined
                  ? undefined
                  : s.judge.acceptableByContestant[c.id]
                    ? 'resolve'
                    : 'nao');
              const cell = v ? VERDICT_CELL[v] : undefined;
              if (!cell) {
                return (
                  <div className="heat-cell-wrap" key={s.index} title={`Cenário ${s.index + 1}: —`}>
                    <span className="heat-cell" style={{ background: 'var(--subtle)', color: 'var(--faint)' }}>·</span>
                  </div>
                );
              }
              return (
                <div className="heat-cell-wrap" key={s.index} title={`Cenário ${s.index + 1}: ${v}`}>
                  <span className="heat-cell" style={{ background: cell.bg, color: cell.color }}>{cell.glyph}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Heatmap de progressao: variante x rodada; celula = colocacao, campea com 🏆. */
function ProgressionHeatmap({ rounds, dark }: { rounds: RunRecord[]; dark: boolean }) {
  const perRound = useMemo(
    () =>
      rounds.map((r) => {
        const ms = medalStandings(r);
        return {
          iteration: r.iteration ?? 0,
          total: ms.length,
          place: new Map(ms.map((row, i) => [row.contestantId, i])),
          winner: ms[0]?.contestantId,
        };
      }),
    [rounds],
  );
  const vars = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; label: string; isOriginal?: boolean }[] = [];
    for (const r of rounds) {
      for (const c of r.contestants ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({ id: c.id, label: c.label, isOriginal: c.isOriginal });
      }
    }
    return out;
  }, [rounds]);

  if (!perRound.length || !vars.length) return null;
  return (
    <div className="heat-card">
      <div className="heat-inner">
        <div className="heat-row head">
          <div className="heat-spacer" />
          {perRound.map((pr) => (
            <div className="heat-col" key={pr.iteration}>R{pr.iteration + 1}</div>
          ))}
        </div>
        {vars.map((v) => (
          <div className="heat-row" key={v.id}>
            <div className="heat-label">
              {v.label}
              {v.isOriginal && <span className="control-tag">ctrl</span>}
            </div>
            {perRound.map((pr) => {
              const pos = pr.place.get(v.id);
              if (pos === undefined) {
                return (
                  <div className="heat-cell-wrap" key={pr.iteration} title={`Rodada ${pr.iteration + 1}: não participou`}>
                    <span className="heat-cell" style={{ background: 'var(--subtle)', color: 'var(--faint)' }}>·</span>
                  </div>
                );
              }
              const rc = rankColor(pos + 1, pr.total, dark);
              const win = pr.winner === v.id;
              return (
                <div
                  className="heat-cell-wrap"
                  key={pr.iteration}
                  title={`${v.label}: ${pos + 1}º na rodada ${pr.iteration + 1}${win ? ' (campeã)' : ''}`}
                >
                  <span className={`heat-cell ${win ? 'winner' : ''}`} style={{ background: rc.soft, color: rc.text }}>
                    {win ? '🏆' : pos + 1}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Estudio final: escolher qualquer variante de qualquer rodada, diff vs. original, copiar. */
function BestPromptStudio({
  rounds,
  originalPrompt,
  defaultRunId,
  defaultCid,
}: {
  rounds: RunRecord[];
  originalPrompt: string;
  defaultRunId?: string;
  defaultCid?: string;
}) {
  const data = useMemo(
    () =>
      rounds.map((r) => ({
        iteration: r.iteration ?? 0,
        runId: r.id,
        standings: medalStandings(r),
        byId: new Map((r.contestants ?? []).map((c) => [c.id, c])),
      })),
    [rounds],
  );

  const [selRunId, setSelRunId] = useState<string | undefined>(defaultRunId ?? data[data.length - 1]?.runId);
  const [selCid, setSelCid] = useState<string | undefined>(defaultCid);
  const [showDiff, setShowDiff] = useState(true);
  const [copied, setCopied] = useState(false);

  // Inicializa a selecao quando os dados/defaults chegam.
  useEffect(() => {
    if (!data.length) return;
    const run = data.find((d) => d.runId === (defaultRunId ?? selRunId)) ?? data[data.length - 1];
    setSelRunId((prev) => prev ?? run.runId);
    setSelCid((prev) => prev ?? defaultCid ?? run.standings[0]?.contestantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.length, defaultRunId, defaultCid]);

  const selRound = data.find((d) => d.runId === selRunId) ?? data[data.length - 1];
  const selContestant = selRound && selCid ? selRound.byId.get(selCid) : undefined;
  const selPrompt = selContestant?.systemPrompt ?? '';
  // useMemo antes de qualquer early-return (regras dos hooks).
  const diff = useMemo(() => diffLines(originalPrompt, selPrompt), [originalPrompt, selPrompt]);

  function copy() {
    if (!selPrompt) return;
    navigator.clipboard?.writeText(selPrompt).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!selRound) return null;

  return (
    <div className="card studio-card">
      <div className="studio-controls">
        <label className="studio-field">
          <span className="studio-field-label">Rodada</span>
          <select
            className="input studio-select"
            value={selRunId ?? ''}
            onChange={(e) => {
              const rid = e.target.value;
              setSelRunId(rid);
              const r = data.find((d) => d.runId === rid);
              setSelCid(r?.standings[0]?.contestantId);
            }}
          >
            {data.map((d) => (
              <option key={d.runId} value={d.runId}>
                Rodada {d.iteration + 1}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="studio-variants">
        {selRound.standings.map((row, idx) => {
          const c = selRound.byId.get(row.contestantId);
          const sel = row.contestantId === selCid;
          return (
            <button
              type="button"
              key={row.contestantId}
              className={`studio-variant ${sel ? 'selected' : ''}`}
              onClick={() => setSelCid(row.contestantId)}
              disabled={!c?.systemPrompt}
              title={c?.systemPrompt ? '' : 'Esta variante não tem system prompt próprio.'}
            >
              <span className="studio-variant-place">{idx + 1}º</span>
              <span className="studio-variant-label">
                {row.label}
                {row.isOriginal && <span className="control-tag">ctrl</span>}
              </span>
              <span className="studio-variant-medals">
                {row.golds}🥇 {row.silvers}🥈 {row.bronzes}🥉
              </span>
            </button>
          );
        })}
      </div>

      <div className="studio-toolbar">
        <div className="tabs">
          <button className={`tab ${!showDiff ? 'active' : ''}`} onClick={() => setShowDiff(false)}>Prompt</button>
          <button className={`tab ${showDiff ? 'active' : ''}`} onClick={() => setShowDiff(true)}>Diff vs. original</button>
        </div>
        <button type="button" className="btn-secondary" onClick={copy} disabled={!selPrompt}>
          {copied ? 'Copiado!' : 'Copiar prompt'}
        </button>
      </div>

      {!selPrompt ? (
        <div className="muted" style={{ fontSize: 13 }}>Esta variante usa o contexto do cenário (sem system prompt próprio).</div>
      ) : showDiff ? (
        <pre className="context-pre studio-diff">
          {diff.map((l, i) => (
            <div key={i} className={`diff-line diff-${l.type}`}>
              <span className="diff-gutter">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              {l.text || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <pre className="context-pre" style={{ maxHeight: 360 }}>{selPrompt}</pre>
      )}
    </div>
  );
}

export function TrainingView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const theme = useTheme();
  const dark = theme === 'dark';
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<RunRecord | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | undefined>(undefined);
  const [pastRuns, setPastRuns] = useState<Record<string, RunRecord>>({});
  const [fanout, setFanout] = useState<{ limit: number; active: number; queued: number } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Efeito A: eventos da SESSAO (iteracoes, snapshot, fim).
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const refetch = () =>
      fetchSession(sessionId)
        .then((s) => !cancelled && setSession(s))
        .catch((e) => !cancelled && setError(e.message));
    refetch();
    const close = openSessionStream(
      sessionId,
      (event) => {
        if (cancelled) return;
        if (event.type === 'snapshot') {
          const rec = event.record as SessionRecord;
          setSession(rec);
          void cacheSession(rec);
          const doneN = rec.bestPromptByIteration.length;
          const cur = rec.runIds.length > doneN ? rec.runIds[rec.runIds.length - 1] : undefined;
          if (cur) setCurrentRunId(cur);
          return;
        }
        if (event.type === 'iteration.started') {
          setAnalyzing(false);
          setLiveRun(null);
          setCurrentRunId(event.runId);
          return;
        }
        if (event.type === 'iteration.analyzing') {
          setAnalyzing(true);
          return;
        }
        if (event.type === 'iteration.finished') {
          setAnalyzing(false);
          fetchRun(event.runId)
            .then((r) => !cancelled && setPastRuns((prev) => ({ ...prev, [event.runId]: r })))
            .catch(() => undefined);
        }
        if (event.type === 'session.finished') void cacheSession(event.record);
        refetch();
      },
      () => refetch(),
    );
    return () => {
      cancelled = true;
      close();
    };
  }, [sessionId]);

  // Efeito B: assina o run da ITERACAO CORRENTE e dobra os eventos (applyEvent).
  useEffect(() => {
    if (!currentRunId) {
      setLiveRun(null);
      return;
    }
    let cancelled = false;
    const seed = getLiveRun(currentRunId);
    if (seed) setLiveRun(seed);
    // Runs de iteracao de treino NAO sao pre-cacheadas (so createRun cacheia), entao
    // o seed pode ser undefined ate run.started. O fetch de fallback e IDB e pode
    // resolver DEPOIS de a subscricao ja ter populado stages — nao pode sobrescrever
    // (prev ?? r); senao a rodada ao vivo "esvazia" ate run.finished.
    else fetchRun(currentRunId).then((r) => !cancelled && setLiveRun((prev) => prev ?? r)).catch(() => undefined);
    const unsub = subscribeRunLive(currentRunId, (e) => {
      if (cancelled) return;
      if (e.type === 'run.started' || e.type === 'run.finished') {
        setLiveRun(e.record);
        return;
      }
      setLiveRun((prev) => (prev ? applyEvent(prev, e) : prev));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [currentRunId]);

  // Efeito C: telemetria do paralelismo enquanto roda.
  useEffect(() => {
    if (session?.status !== 'running') {
      setFanout(null);
      return;
    }
    setFanout(getConcurrency());
    const t = setInterval(() => setFanout(getConcurrency()), 500);
    return () => clearInterval(t);
  }, [session?.status]);

  // Efeito D: backfill dos runs concluidos (inclui sessoes ja finalizadas).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    for (const rid of session.runIds ?? []) {
      if (rid === currentRunId || pastRuns[rid]) continue;
      fetchRun(rid)
        .then((r) => {
          if (!cancelled) setPastRuns((prev) => (prev[rid] ? prev : { ...prev, [rid]: r }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // pastRuns omitido de proposito (guardado por prev[rid]) p/ evitar loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, currentRunId]);

  // Rodadas conhecidas (concluidas + a corrente), ordenadas por iteracao.
  const rounds = useMemo(() => {
    const map = new Map<string, RunRecord>();
    for (const r of Object.values(pastRuns)) map.set(r.id, r);
    if (liveRun) map.set(liveRun.id, liveRun);
    return [...map.values()].filter((r) => r.iteration != null).sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
  }, [pastRuns, liveRun]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;
  if (!session) return <div className="screen center-screen"><div className="loading-note">Carregando…</div></div>;

  const done = session.bestPromptByIteration.length;
  const planned = session.config.iterations ?? 0;
  const isRunning = session.status === 'running';
  const best = session.bestPromptByIteration.length
    ? session.bestPromptByIteration.reduce((a, b) => (b.score >= a.score ? b : a))
    : undefined;
  const originalPrompt = session.config.basePrompt ?? '';
  const hasRounds = rounds.length > 0;

  return (
    <div className="screen">
      <div className="card run-header">
        <div className="run-header-main">
          <div className="run-title-row">
            <h1 className="run-title">Treino <code>{session.id.slice(0, 8)}</code></h1>
            <span className="pill pill-training">treino</span>
            {isRunning && <span className="live-pill"><span className="dot" />AO VIVO</span>}
          </div>
          <div className="run-theme">{session.config.theme}</div>
          <div className="run-theme" style={{ fontSize: 13, marginTop: 4 }}>
            Modelo sob teste: <code className="mono-id">{session.config.contestantModelId}</code>
          </div>
        </div>
        <div className="run-stats">
          <div>
            <div className="run-stat-label">Status</div>
            <span className={`pill pill-${session.status}`}>{session.status}</span>
          </div>
          <div>
            <div className="run-stat-label" style={{ marginBottom: 6 }}>Rodadas</div>
            <div className="run-stat-strong">{done}/{planned}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="run-stat-label" style={{ marginBottom: 6 }}>Custo total</div>
            <div className="run-cost">${session.totalCostUsd.toFixed(4)}</div>
          </div>
        </div>
      </div>

      {session.status === 'error' && session.error && (
        <div className="banner banner-error"><strong>Treino falhou:</strong> {session.error}</div>
      )}
      {session.status === 'aborted' && (
        <div className="banner banner-neutral">Treino interrompido — o servidor reiniciou enquanto ele rodava.</div>
      )}

      <PhaseStepper status={session.status} done={done} planned={planned} />

      {isRunning && <FanOutBar fanout={fanout} liveRun={liveRun} />}

      {/* Rodada em andamento — quadro de medalhas + heatmap + streaming ao vivo */}
      {isRunning && (
        <>
          <div className="section-label">
            Rodada {(liveRun?.iteration ?? done) + 1} — ao vivo
            {analyzing && <span className="inline-status" style={{ marginLeft: 10 }}><span className="spinner" />otimizando o prompt para esta rodada…</span>}
          </div>
          {liveRun ? (
            <>
              <MedalBoard record={liveRun} dark={dark} />
              <div className="section-label">Como cada prompt está performando (variante × cenário)</div>
              <div className="heat-legend">
                <span style={{ color: 'var(--ok)' }}>✓ resolve</span>
                <span style={{ color: 'var(--warn)' }}>◐ parcial</span>
                <span style={{ color: 'var(--err)' }}>✕ não resolve</span>
                <span style={{ marginLeft: 4 }}>· = ainda não julgado</span>
              </div>
              <VerdictHeatmap record={liveRun} />
              <ProcessMonitor record={liveRun} totalCompetitors={liveRun.contestants?.length ?? 0} />
              <div style={{ marginTop: 8 }}>
                <Link to={`/runs/${liveRun.id}`}>abrir esta rodada em detalhe →</Link>
              </div>
            </>
          ) : (
            <div className="card" style={{ color: 'var(--text-3)' }}>Preparando a rodada…</div>
          )}
        </>
      )}

      {/* Evolução entre rodadas (colocação por rodada, campeã com troféu) */}
      {rounds.length > 0 && (
        <>
          <div className="section-label">Evolução por rodada (colocação — 🏆 = campeã que evoluiu)</div>
          <ProgressionHeatmap rounds={rounds} dark={dark} />
        </>
      )}

      {/* Escolher o melhor prompt */}
      {hasRounds && (
        <>
          <div className="section-label">
            Escolher o melhor prompt
            {best && <span className="section-label-note"> · sugestão: campeã da rodada {best.iteration + 1}</span>}
          </div>
          <BestPromptStudio
            rounds={rounds}
            originalPrompt={originalPrompt}
            defaultRunId={best?.runId}
            defaultCid={best?.winnerContestantId}
          />
        </>
      )}

      {/* Lista compacta de rodadas para drill-down */}
      <div className="section-label">Rodadas</div>
      <div className="rounds-list">
        {session.bestPromptByIteration.length === 0 && !liveRun && (
          <div className="card" style={{ color: 'var(--text-3)' }}>Iniciando…</div>
        )}
        {[...session.bestPromptByIteration].reverse().map((it) => (
          <div className="iteration-row" key={it.iteration}>
            <div className="iteration-head">
              <div className="iteration-title">
                Rodada {it.iteration + 1}
                {best?.iteration === it.iteration && <span className="pill pill-finished">melhor</span>}
                <span className="iteration-meta">
                  {(it.golds ?? it.score) ?? 0}🥇 {it.silvers ?? 0}🥈 {it.bronzes ?? 0}🥉 · campeã <code>{it.winnerContestantId}</code>
                </span>
              </div>
              <div className="iteration-links">
                <Link to={`/runs/${it.runId}`}>abrir run →</Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
