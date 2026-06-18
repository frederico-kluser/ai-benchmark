import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunMode, RunSummary, SessionSummary } from '../api';
import { fetchRuns, fetchSessions } from '../api';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Group = 'running' | 'finished' | 'error';

function groupOf(status: RunSummary['status']): Group {
  if (status === 'running') return 'running';
  if (status === 'finished') return 'finished';
  return 'error'; // error + aborted
}

function modeLabel(mode?: RunMode): string {
  if (mode === 'variation') return 'variação';
  if (mode === 'training') return 'treino';
  return 'comparar';
}

const FILTERS: { key: 'all' | Group; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'running', label: 'Em andamento' },
  { key: 'finished', label: 'Concluídas' },
  { key: 'error', label: 'Com erro' },
];

type Item =
  | { kind: 'session'; s: SessionSummary; at: string; status: RunSummary['status']; theme: string }
  | { kind: 'run'; r: RunSummary; at: string; status: RunSummary['status']; theme: string };

export function RunsList() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Group>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    Promise.all([fetchRuns(), fetchSessions().catch(() => [] as SessionSummary[])])
      .then(([r, s]) => {
        setRuns(r);
        setSessions(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Sessões de treino viram uma linha (link p/ /training); as runs-filhas (iterações)
  // ficam ocultas da lista plana — são acessíveis pela tela da sessão.
  const items = useMemo<Item[]>(() => {
    const standalone = runs.filter((r) => !r.sessionId);
    const list: Item[] = [
      ...sessions.map((s) => ({ kind: 'session' as const, s, at: s.startedAt, status: s.status, theme: s.theme })),
      ...standalone.map((r) => ({ kind: 'run' as const, r, at: r.startedAt, status: r.status, theme: r.theme })),
    ];
    return list.sort((a, b) => b.at.localeCompare(a.at));
  }, [runs, sessions]);

  const counts = useMemo(() => {
    const c = { all: items.length, running: 0, finished: 0, error: 0 };
    for (const it of items) c[groupOf(it.status)]++;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (it) =>
        (filter === 'all' || groupOf(it.status) === filter) &&
        (!q || it.theme.toLowerCase().includes(q)),
    );
  }, [items, filter, query]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;

  return (
    <div className="screen">
      <h1 className="page-title">Histórico</h1>
      <p className="page-sub">Runs e treinos executados, mais recentes primeiro.</p>

      <div className="hist-toolbar">
        <div className="filter-pills">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`filter-pill ${filter === f.key ? 'active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <input
          className="input input-pill search-input"
          placeholder="Buscar por tema…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="table-card">
        <div className="runs-head">
          <div>ID</div><div>Status</div><div>Modo</div><div>Tema</div><div>Etapas</div><div>Comp.</div><div>Custo</div><div>Início</div>
        </div>
        {visible.map((it) =>
          it.kind === 'run' ? (
            <Link className="runs-row" key={it.r.id} to={`/runs/${it.r.id}`}>
              <div className="r-id">{it.r.id.slice(0, 8)}</div>
              <div>
                <span className={`pill pill-${it.r.status}`}>
                  {it.r.status === 'running' && <span className="pill-dot" />}
                  {it.r.status}
                </span>
              </div>
              <div><span className={`pill pill-${it.r.mode ?? 'compare'} r-mode`}>{modeLabel(it.r.mode)}</span></div>
              <div className="r-theme">{it.r.theme}</div>
              <div className="r-num">{it.r.stages}</div>
              <div className="r-num">{it.r.contestants ?? it.r.competitors}</div>
              <div className="r-cost">${it.r.totalCostUsd.toFixed(4)}</div>
              <div className="r-date">{formatDate(it.r.startedAt)}</div>
            </Link>
          ) : (
            <Link className="runs-row" key={it.s.id} to={`/training/${it.s.id}`}>
              <div className="r-id">{it.s.id.slice(0, 8)}</div>
              <div>
                <span className={`pill pill-${it.s.status}`}>
                  {it.s.status === 'running' && <span className="pill-dot" />}
                  {it.s.status}
                </span>
              </div>
              <div><span className="pill pill-training r-mode">treino</span></div>
              <div className="r-theme">{it.s.theme}</div>
              <div className="r-num">{it.s.iterationsDone}/{it.s.iterationsPlanned}</div>
              <div className="r-num">—</div>
              <div className="r-cost">${it.s.totalCostUsd.toFixed(4)}</div>
              <div className="r-date">{formatDate(it.s.startedAt)}</div>
            </Link>
          ),
        )}
        {visible.length === 0 && (
          <div className="table-empty">
            {items.length === 0 ? 'Nenhuma run ainda.' : 'Nenhuma run corresponde a esse filtro.'}
          </div>
        )}
      </div>
    </div>
  );
}
