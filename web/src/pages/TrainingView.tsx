import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SessionIterationSummary, SessionRecord } from '../api';
import { fetchSession, openSessionStream } from '../api';

function TrendChart({ data }: { data: SessionIterationSummary[] }) {
  if (!data.length) return <div className="card trend-card"><div className="trend-empty">Sem iterações concluídas ainda.</div></div>;
  const max = Math.max(1, ...data.map((d) => d.score));
  return (
    <div className="card trend-card">
      <div className="trend-chart">
        {data.map((d) => (
          <div
            key={d.iteration}
            className="trend-col"
            title={`Iteração ${d.iteration + 1}: ${d.score} pts (vencedora ${d.winnerContestantId})`}
          >
            <div className="trend-bar" style={{ height: `${(d.score / max) * 100}%` }} />
            <div className="trend-val">{d.score}</div>
            <div className="trend-label">it {d.iteration + 1}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IterationRow({ it, isBest }: { it: SessionIterationSummary; isBest: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="iteration-row">
      <div className="iteration-head">
        <div className="iteration-title">
          Iteração {it.iteration + 1}
          {isBest && <span className="pill pill-finished">melhor</span>}
          <span className="iteration-meta">{it.score} pts · vencedora <code>{it.winnerContestantId}</code></span>
        </div>
        <div className="iteration-links">
          <Link to={`/runs/${it.runId}`}>abrir run →</Link>
          <button type="button" className="link-toggle" style={{ margin: 0 }} onClick={() => setOpen((o) => !o)}>
            {open ? 'ocultar prompt' : 'ver prompt'}
          </button>
        </div>
      </div>
      {open && <pre className="context-pre" style={{ marginTop: 12 }}>{it.systemPrompt}</pre>}
    </div>
  );
}

export function TrainingView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          setSession(event.record);
          return;
        }
        refetch();
      },
      () => refetch(),
    );
    return () => {
      cancelled = true;
      close();
    };
  }, [sessionId]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;
  if (!session) return <div className="screen center-screen"><div className="loading-note">Carregando…</div></div>;

  const done = session.bestPromptByIteration.length;
  const planned = session.config.iterations;
  const currentRunId =
    session.runIds.length > done ? session.runIds[session.runIds.length - 1] : undefined;
  const best = session.bestPromptByIteration.length
    ? session.bestPromptByIteration.reduce((a, b) => (b.score >= a.score ? b : a))
    : undefined;

  return (
    <div className="screen">
      <div className="card run-header">
        <div className="run-header-main">
          <div className="run-title-row">
            <h1 className="run-title">Treino <code>{session.id.slice(0, 8)}</code></h1>
            <span className="pill pill-training">treino</span>
            {session.status === 'running' && <span className="live-pill"><span className="dot" />AO VIVO</span>}
          </div>
          <div className="run-theme">{session.config.theme}</div>
        </div>
        <div className="run-stats">
          <div>
            <div className="run-stat-label">Status</div>
            <span className={`pill pill-${session.status}`}>{session.status}</span>
          </div>
          <div>
            <div className="run-stat-label" style={{ marginBottom: 6 }}>Iterações</div>
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

      <div className="run-theme" style={{ fontSize: 14, marginBottom: 14 }}>
        Modelo sob teste: <code className="mono-id">{session.config.contestantModelId}</code>
      </div>

      <div className="section-label">Curva de melhoria (pontos da vencedora por iteração)</div>
      <TrendChart data={session.bestPromptByIteration} />

      {best && session.status === 'finished' && (
        <>
          <div className="section-label">Melhor prompt</div>
          <div className="card best-prompt-card">
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Iteração {best.iteration + 1} · {best.score} pts · vencedora <code>{best.winnerContestantId}</code>
            </div>
            <pre className="context-pre" style={{ maxHeight: 320 }}>{best.systemPrompt}</pre>
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: 12 }}
              onClick={() => navigator.clipboard?.writeText(best.systemPrompt)}
            >
              Copiar prompt
            </button>
          </div>
        </>
      )}

      <div className="section-label">Iterações</div>
      {currentRunId && (
        <div className="iteration-row current">
          <div className="iteration-head">
            <div className="iteration-title">
              Iteração {done + 1}
              <span className="pill pill-running"><span className="pill-dot" />em andamento</span>
            </div>
            <div className="iteration-links">
              <Link to={`/runs/${currentRunId}`}>acompanhar ao vivo →</Link>
            </div>
          </div>
        </div>
      )}
      {[...session.bestPromptByIteration].reverse().map((it) => (
        <IterationRow key={it.iteration} it={it} isBest={best?.iteration === it.iteration} />
      ))}
      {done === 0 && !currentRunId && <div className="card" style={{ color: 'var(--text-3)' }}>Iniciando…</div>}
    </div>
  );
}
