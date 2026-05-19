import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunSummary } from '../api';
import { fetchRuns } from '../api';

export function RunsList() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRuns().then(setRuns).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="page"><div className="error-banner">{error}</div></div>;

  return (
    <div className="page">
      <h1>Histórico</h1>
      {runs.length === 0 && <p className="muted">Nenhuma run ainda.</p>}
      <table className="runs-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Tema</th>
            <th>Etapas</th>
            <th>Competidores</th>
            <th>Custo</th>
            <th>Início</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/runs/${r.id}`}><code>{r.id.slice(0, 8)}</code></Link></td>
              <td><span className={`status status-${r.status}`}>{r.status}</span></td>
              <td className="ellipsis">{r.theme}</td>
              <td>{r.stages}</td>
              <td>{r.competitors}</td>
              <td>${r.totalCostUsd.toFixed(4)}</td>
              <td>{new Date(r.startedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
