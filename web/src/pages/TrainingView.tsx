import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RunRecord, SessionRecord, StageSpec } from '../api';
import {
  cacheSession,
  fetchSession,
  openSessionStream,
  fetchRun,
  getLiveRun,
  subscribeRunLive,
  savePrompt,
  buildScenarioPack,
  downloadScenarioPack,
} from '../api';
import { useTheme } from '../theme';
import { applyEvent, denseStages, rankColor, ScoreHeatmap, FinalsPanel, SectionHead } from './runShared';
import { diffLines } from '../diff';

// ---------------------------------------------------------------------------
// Cockpit de treino: acompanha a sessao inteira sem precisar entrar em cada
// /runs/:id. So o essencial — heatmap da rodada corrente, finais, evolucao
// entre rodadas e a escolha do melhor prompt.
// ---------------------------------------------------------------------------

/** Heatmap de evolucao: variante x rodada; celula = judge-score arredondado. */
function EvolutionHeatmap({
  rounds,
  dark,
  holdoutAt,
}: {
  rounds: RunRecord[];
  dark: boolean;
  holdoutAt?: number;
}) {
  const cols = useMemo(
    () =>
      rounds.map((r) => {
        const scores = r.judgeScoreByContestant ?? {};
        const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        return {
          iteration: r.iteration ?? 0,
          isHoldout: r.iteration === holdoutAt,
          scores,
          total: ordered.length,
          place: new Map(ordered.map(([id], i) => [id, i + 1])),
        };
      }),
    [rounds, holdoutAt],
  );
  // Ordem estavel: primeira aparicao da variante ao longo das rodadas.
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

  if (!cols.length || !vars.length) return null;
  return (
    <div className="hm">
      <div className="hm-scroll">
        <div className="hm-row hm-head">
          <div className="hm-name" />
          {cols.map((col) => (
            <div className="hm-col" key={col.iteration}>
              {col.isHoldout ? 'H' : `R${col.iteration + 1}`}
            </div>
          ))}
        </div>
        {vars.map((v) => (
          <div className="hm-row" key={v.id}>
            <div className="hm-name">
              {v.label}
              {v.isOriginal && <span className="control-tag">base</span>}
            </div>
            {cols.map((col) => {
              const rodada = col.isHoldout ? 'Holdout' : `Rodada ${col.iteration + 1}`;
              const score = col.scores[v.id];
              if (score === undefined) {
                return (
                  <div className="hm-cell none" key={col.iteration} title={`${rodada}: não participou`}>
                    ·
                  </div>
                );
              }
              const rc = rankColor(col.place.get(v.id) ?? 1, col.total, dark);
              return (
                <div
                  className="hm-cell"
                  key={col.iteration}
                  style={{ background: rc.soft, color: rc.text }}
                  title={`${rodada}: judge-score ${score.toFixed(1)}`}
                >
                  {Math.round(score)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Estudio final: escolher qualquer variante de qualquer rodada, ver o diff vs.
 *  o prompt original, copiar e salvar na biblioteca local. */
function BestPromptStudio({
  rounds,
  originalPrompt,
  defaultRunId,
  defaultCid,
  sessionId,
  holdoutAt,
}: {
  rounds: RunRecord[];
  originalPrompt: string;
  defaultRunId?: string;
  defaultCid?: string;
  sessionId: string;
  holdoutAt?: number;
}) {
  // Variantes de cada rodada, ordenadas por judge-score (sem score vai pro fim).
  const data = useMemo(
    () =>
      rounds.map((r) => {
        const scores = r.judgeScoreByContestant ?? {};
        const variants = (r.contestants ?? [])
          .map((c) => ({
            id: c.id,
            label: c.label,
            isOriginal: c.isOriginal,
            techniqueId: c.techniqueId,
            systemPrompt: c.systemPrompt,
            score: scores[c.id],
          }))
          .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        return { iteration: r.iteration ?? 0, runId: r.id, variants };
      }),
    [rounds],
  );

  const [selRunId, setSelRunId] = useState<string | undefined>(defaultRunId ?? data[data.length - 1]?.runId);
  const [selCid, setSelCid] = useState<string | undefined>(defaultCid);
  const [showDiff, setShowDiff] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Quem o usuario ja escolheu a mao manda; enquanto ele nao escolheu, a
  // selecao SEGUE o campeao sugerido. Acompanhando a sessao ao vivo, `defaultRunId`
  // /`defaultCid` so existem depois da 1a rodada fechar — com `prev ?? …` a
  // sugestao nunca chegava e a tela ficava presa numa variante arbitraria.
  const escolhaManual = useRef(false);
  useEffect(() => {
    if (!data.length || escolhaManual.current) return;
    const run = data.find((d) => d.runId === defaultRunId) ?? data[data.length - 1];
    setSelRunId(run.runId);
    setSelCid(defaultCid ?? run.variants[0]?.id);
  }, [data, defaultRunId, defaultCid]);

  function escolher(runId: string | undefined, cid: string | undefined) {
    escolhaManual.current = true;
    if (runId !== undefined) setSelRunId(runId);
    setSelCid(cid);
  }

  const selRound = data.find((d) => d.runId === selRunId) ?? data[data.length - 1];
  const selVariant = selRound && selCid ? selRound.variants.find((v) => v.id === selCid) : undefined;
  const selPrompt = selVariant?.systemPrompt ?? '';
  // useMemo antes de qualquer early-return (regras dos hooks).
  const diff = useMemo(() => diffLines(originalPrompt, selPrompt), [originalPrompt, selPrompt]);

  // Trocar de rodada/variante reseta o form e o feedback de salvar.
  useEffect(() => {
    setSaveOpen(false);
    setSaved(false);
    setSaveError(null);
  }, [selRunId, selCid]);

  function copy() {
    if (!selPrompt) return;
    navigator.clipboard?.writeText(selPrompt).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function openSaveForm() {
    if (!selRound) return;
    const tag = selRound.iteration === holdoutAt ? 'holdout' : `rodada ${selRound.iteration + 1}`;
    setSaveName(`Prompt ${selVariant?.label ?? selCid ?? 'variante'} · ${tag}`);
    setSaveError(null);
    setSaveOpen(true);
  }

  async function saveToLibrary() {
    const name = saveName.trim();
    if (!selRound || !selPrompt || !name || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await savePrompt({
        name,
        text: selPrompt,
        origin: {
          kind: 'training',
          sessionId,
          runId: selRound.runId,
          techniqueId: selVariant?.techniqueId,
          iteration: selRound.iteration,
        },
      });
      setSaved(true);
      setSaveOpen(false);
    } catch {
      setSaveError('Não foi possível salvar na biblioteca.');
    } finally {
      setSaving(false);
    }
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
              const r = data.find((d) => d.runId === rid);
              escolher(rid, r?.variants[0]?.id);
            }}
          >
            {data.map((d) => (
              <option key={d.runId} value={d.runId}>
                {d.iteration === holdoutAt ? 'Holdout' : `Rodada ${d.iteration + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="studio-variants">
        {selRound.variants.map((v, idx) => (
          <button
            type="button"
            key={v.id}
            className={`studio-variant ${v.id === selCid ? 'selected' : ''}`}
            onClick={() => escolher(undefined, v.id)}
            disabled={!v.systemPrompt}
            title={v.systemPrompt ? '' : 'Esta variante não tem system prompt próprio.'}
          >
            <span className="studio-variant-place">{idx + 1}º</span>
            <span className="studio-variant-label">
              {v.label}
              {v.isOriginal && <span className="control-tag">base</span>}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {v.score === undefined ? '—' : `${Math.round(v.score)} pts`}
            </span>
          </button>
        ))}
      </div>

      <div className="studio-toolbar">
        <div className="tabs">
          <button className={`tab ${!showDiff ? 'active' : ''}`} onClick={() => setShowDiff(false)}>Prompt</button>
          <button className={`tab ${showDiff ? 'active' : ''}`} onClick={() => setShowDiff(true)}>Diff vs. original</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-secondary" onClick={openSaveForm} disabled={!selPrompt || saved}>
            {saved ? 'Salvo ✓' : 'Salvar na biblioteca'}
          </button>
          <button type="button" className="btn-secondary" onClick={copy} disabled={!selPrompt}>
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
      </div>

      {saveOpen && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '1 1 260px', width: 'auto' }}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Nome na biblioteca"
          />
          <button
            type="button"
            className="btn-primary"
            style={{ fontSize: 14, padding: '10px 18px' }}
            onClick={saveToLibrary}
            disabled={saving || !saveName.trim()}
          >
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setSaveOpen(false)}>
            Cancelar
          </button>
        </div>
      )}
      {saveError && <div className="banner banner-error" style={{ marginBottom: 0 }}>{saveError}</div>}
      {saved && (
        <div className="muted" style={{ fontSize: 13 }}>
          Salvo ✓ · <Link to="/prompts">ver na biblioteca →</Link>
        </div>
      )}

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
  const navigate = useNavigate();
  const theme = useTheme();
  const dark = theme === 'dark';
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<RunRecord | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | undefined>(undefined);
  const [pastRuns, setPastRuns] = useState<Record<string, RunRecord>>({});
  const [duelProgress, setDuelProgress] = useState<{ done: number; total: number } | null>(null);

  // Efeito A: eventos da SESSAO (iteracoes, snapshot, fim).
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const refetch = () =>
      fetchSession(sessionId)
        .then((s) => {
          if (cancelled) return;
          setSession(s);
          // Mesma regra do snapshot: mais runs do que iteracoes concluidas => a
          // ultima e a corrente (cobre a run de holdout, que NAO emite iteration.started).
          const doneN = s.bestPromptByIteration.length;
          const cur = s.runIds.length > doneN ? s.runIds[s.runIds.length - 1] : undefined;
          if (cur) setCurrentRunId(cur);
        })
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
          setLiveRun(null);
          setCurrentRunId(event.runId);
          return;
        }
        if (event.type === 'iteration.finished') {
          fetchRun(event.runId)
            .then((r) => !cancelled && setPastRuns((prev) => ({ ...prev, [event.runId]: r })))
            .catch(() => undefined);
        }
        if (event.type === 'session.converged') {
          setSession((prev) => (prev ? { ...prev, convergedAtIteration: event.iteration } : prev));
        }
        if (event.type === 'session.holdout') {
          setSession((prev) => (prev ? { ...prev, holdout: event.holdout } : prev));
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
    setDuelProgress(null);
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
      // Progresso agregado dos duelos: nao entra no record (applyEvent devolve
      // `prev`), vive em estado proprio e alimenta o painel de finais.
      if (e.type === 'duel.progress') {
        setDuelProgress({ done: e.done, total: e.total });
        return;
      }
      setLiveRun((prev) => (prev ? applyEvent(prev, e) : prev));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [currentRunId]);

  // Efeito C: backfill dos runs concluidos (inclui sessoes ja finalizadas).
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

  // Cenarios do pacote: dedup por pergunta preferindo a versao COM gabarito;
  // fallback = cenarios pinados da sessao.
  const packScenarios = useMemo(() => {
    const byQuestion = new Map<string, StageSpec>();
    for (const r of rounds) {
      for (const st of denseStages(r.stages)) {
        const spec = st.spec;
        if (!spec?.question) continue;
        const prev = byQuestion.get(spec.question);
        if (!prev || (!prev.reference && spec.reference)) byQuestion.set(spec.question, spec);
      }
    }
    const list = [...byQuestion.values()];
    if (list.length) return list;
    return (session?.pinnedStages ?? []).filter((s) => s.question);
  }, [rounds, session]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;
  if (!session) return <div className="screen center-screen"><div className="loading-note">Carregando…</div></div>;

  const done = session.bestPromptByIteration.length;
  const planned = session.config.iterations ?? 0;
  const isRunning = session.status === 'running';
  // A run de holdout e marcada com iteracao == planned ("rodada H"): em toda
  // lista de rodadas ela vira "Holdout", nunca "Rodada N+1".
  const holdoutAt = planned > 0 ? planned : undefined;
  const best = session.bestPromptByIteration.length
    ? session.bestPromptByIteration.reduce((a, b) => (b.score >= a.score ? b : a))
    : undefined;
  const originalPrompt = session.config.basePrompt ?? '';
  // Rodada em foco: a corrente ao vivo, ou a ultima conhecida quando acabou.
  const roundShown = liveRun ?? rounds[rounds.length - 1];
  const roundLabel = roundShown
    ? roundShown.iteration === holdoutAt
      ? 'Holdout'
      : `Rodada ${(roundShown.iteration ?? 0) + 1}`
    : '';
  const showFinals = Boolean(
    roundShown &&
      ((roundShown.finalists?.length ?? 0) > 0 || denseStages(roundShown.stages).some((s) => s.duels)),
  );

  // Gates (holdout / significancia / convergencia) em UMA linha.
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
  const gates: string[] = [];
  if (session.convergedAtIteration != null) gates.push(`Convergiu na rodada ${session.convergedAtIteration + 1}`);
  if (session.holdout) {
    const h = session.holdout;
    gates.push(
      `Holdout n=${h.n}: base ${h.controlScore.toFixed(0)} → campeão ${h.championScore.toFixed(0)} (${signed(h.gain)})${h.regressed ? ' — regrediu' : ''}`,
    );
  }
  if (session.significance !== undefined) {
    const sig = session.significance;
    gates.push(sig === null ? 'amostra insuficiente p/ significância' : sig.pValue < 0.001 ? 'p<0.001' : `p=${sig.pValue.toFixed(3)}`);
  }

  function downloadPack() {
    if (!session || !packScenarios.length) return;
    const lastBest = session.bestPromptByIteration[session.bestPromptByIteration.length - 1];
    const prompt = lastBest?.systemPrompt
      ? { text: lastBest.systemPrompt, source: 'champion' as const, label: `Campeão da rodada ${lastBest.iteration + 1}` }
      : { text: session.config.basePrompt ?? '', source: 'base' as const, label: 'Prompt base' };
    downloadScenarioPack(buildScenarioPack({ theme: session.config.theme, prompt, scenarios: packScenarios }));
  }

  return (
    <div className="screen">
      <div className="card rv-head">
        <div className="run-header-main">
          <div className="run-title-row">
            <h1 className="run-title">Treino <code>{session.id.slice(0, 8)}</code></h1>
            <span className={`pill pill-${session.status}`}>{session.status}</span>
            {isRunning && <span className="live-pill"><span className="dot" />AO VIVO</span>}
          </div>
          <div className="run-theme">
            {session.config.theme} · <code className="mono-id">{session.config.contestantModelId}</code>
          </div>
        </div>
        <div className="rv-stats">
          <div className="rv-stat">
            <span className="rv-stat-label">rodada</span>
            {done}/{planned}
          </div>
          <div className="rv-stat">
            <span className="rv-stat-label">custo</span>
            ${session.totalCostUsd.toFixed(4)}
          </div>
          <button type="button" className="btn-secondary" onClick={downloadPack} disabled={!packScenarios.length}>
            Pacote
          </button>
        </div>
      </div>

      {session.status === 'error' && session.error && (
        <div className="banner banner-error"><strong>Treino falhou:</strong> {session.error}</div>
      )}
      {session.status === 'aborted' && (
        <div className="banner banner-neutral">Treino interrompido — o servidor reiniciou enquanto ele rodava.</div>
      )}
      {gates.length > 0 && (
        <div className={`banner ${session.holdout?.regressed ? 'banner-error' : 'banner-neutral'}`}>
          {gates.join(' · ')}
        </div>
      )}

      {roundShown ? (
        <>
          <SectionHead
            glyph="◱"
            tone="teal"
            status={<Link to={`/runs/${roundShown.id}`}>detalhe →</Link>}
          >
            {roundLabel}
            {isRunning && ' — ao vivo'}
          </SectionHead>
          <ScoreHeatmap
            record={roundShown}
            ranked={roundShown.status === 'finished'}
            onStageClick={() => navigate(`/runs/${roundShown.id}`)}
          />

          {showFinals && (
            <>
              <SectionHead glyph="▲" tone="orange" style={{ marginTop: 30 }}>Final da rodada</SectionHead>
              <FinalsPanel record={roundShown} progress={duelProgress} />
            </>
          )}
        </>
      ) : (
        <div className="card" style={{ color: 'var(--text-3)' }}>Preparando a rodada…</div>
      )}

      {rounds.length > 1 && (
        <>
          <SectionHead glyph="↗" tone="blue" style={{ marginTop: 30 }}>Evolução</SectionHead>
          <EvolutionHeatmap rounds={rounds} dark={dark} holdoutAt={holdoutAt} />
        </>
      )}

      {rounds.length > 0 && (
        <>
          <SectionHead glyph="✓" tone="purple" style={{ marginTop: 30 }}>Melhor prompt</SectionHead>
          <BestPromptStudio
            rounds={rounds}
            originalPrompt={originalPrompt}
            defaultRunId={best?.runId}
            defaultCid={best?.winnerContestantId}
            sessionId={session.id}
            holdoutAt={holdoutAt}
          />
        </>
      )}
    </div>
  );
}
