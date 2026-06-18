import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunSummary } from '../api';
import { fetchRuns } from '../api';

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

const FILTERS: { key: 'all' | Group; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'running', label: 'Em andamento' },
  { key: 'finished', label: 'Concluídas' },
  { key: 'error', label: 'Com erro' },
];

export function RunsList() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Group>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetchRuns().then(setRuns).catch((e) => setError(e.message));
  }, []);

  const counts = useMemo(() => {
    const c = { all: runs.length, running: 0, finished: 0, error: 0 };
    for (const r of runs) c[groupOf(r.status)]++;
    return c;
  }, [runs]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter(
      (r) =>
        (filter === 'all' || groupOf(r.status) === filter) &&
        (!q || r.theme.toLowerCase().includes(q)),
    );
  }, [runs, filter, query]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;

  return (
    <div className="screen">
      <h1 className="page-title">Histórico</h1>
      <p className="page-sub">Runs executadas, mais recentes primeiro.</p>

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
          <div>ID</div><div>Status</div><div>Tema</div><div>Etapas</div><div>Comp.</div><div>Custo</div><div>Início</div>
        </div>
        {rows.map((r) => (
          <Link className="runs-row" key={r.id} to={`/runs/${r.id}`}>
            <div className="r-id">{r.id.slice(0, 8)}</div>
            <div>
              <span className={`pill pill-${r.status}`}>
                {r.status === 'running' && <span className="pill-dot" />}
                {r.status}
              </span>
            </div>
            <div className="r-theme">{r.theme}</div>
            <div className="r-num">{r.stages}</div>
            <div className="r-num">{r.competitors}</div>
            <div className="r-cost">${r.totalCostUsd.toFixed(4)}</div>
            <div className="r-date">{formatDate(r.startedAt)}</div>
          </Link>
        ))}
        {rows.length === 0 && (
          <div className="table-empty">
            {runs.length === 0 ? 'Nenhuma run ainda.' : 'Nenhuma run corresponde a esse filtro.'}
          </div>
        )}
      </div>
    </div>
  );
}
