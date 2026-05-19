import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { RunRecord, StageRecord } from '../api';
import { fetchRun, openRunStream } from '../api';

function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.001) return `$${v.toExponential(2)}`;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

interface Standing {
  modelId: string;
  points: number;
  firstPlaces: number;
  avgPos: number | null;
  rankedStages: number;
  acceptable: number;
  evaluated: number;
  errors: number;
}

function computeStandings(record: RunRecord): Standing[] {
  const ids = record.config.competitorModelIds;
  const rows: Standing[] = ids.map((modelId) => {
    const positions: number[] = [];
    let firstPlaces = 0;
    let acceptable = 0;
    let evaluated = 0;
    let errors = 0;
    for (const s of record.stages) {
      const pos = (s.judge?.rankedModelIds ?? []).indexOf(modelId);
      if (pos >= 0) {
        positions.push(pos);
        if (pos === 0) firstPlaces++;
      }
      if (s.responses.some((r) => r.modelId === modelId && r.status === 'error')) errors++;
      const ev = s.evaluation;
      if (ev && !ev.inconclusive) {
        const v = ev.verdicts.find((x) => x.modelId === modelId);
        if (v) {
          evaluated++;
          if (v.acceptable) acceptable++;
        }
      }
    }
    return {
      modelId,
      points: record.scoreboard[modelId] ?? 0,
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
    return a.modelId.localeCompare(b.modelId);
  });
}

function rankColor(position: number, total: number): string {
  if (position < 0) return '#3a3a3a';
  const pct = position / Math.max(1, total - 1);
  // verde -> vermelho
  const r = Math.round(80 + pct * 175);
  const g = Math.round(180 - pct * 130);
  return `rgb(${r},${g},80)`;
}

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openStages, setOpenStages] = useState<Set<number>>(new Set());

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
          return;
        }
        // auto-abrir a etapa quando comeca a gerar
        if (event.type === 'stage.generating' || event.type === 'competitor.started') {
          setOpenStages((prev) => new Set(prev).add(event.stageIndex));
        }
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

  const competitorIds = useMemo(
    () => (record ? record.config.competitorModelIds : []),
    [record],
  );
  const standings = useMemo(() => (record ? computeStandings(record) : []), [record]);

  if (error) return <div className="page"><div className="error-banner">{error}</div></div>;
  if (!record) return <div className="page">Carregando…</div>;

  const totalCompetitors = competitorIds.length;

  return (
    <div className="page runview">
      <header className="run-header">
        <div>
          <h1>Run <code>{record.id.slice(0, 8)}</code></h1>
          <div className="muted">{record.config.theme}</div>
        </div>
        <div className="run-stats">
          <div><strong>Status:</strong> <span className={`status status-${record.status}`}>{record.status}</span></div>
          <div><strong>Etapas:</strong> {record.stages.length}/{record.config.stages}</div>
          <div><strong>Custo total:</strong> {formatUsd(record.totalCostUsd)}</div>
          <div>
            <a href={`/v1/benchmark/runs/${record.id}`} target="_blank" rel="noreferrer">JSON</a>
            {' · '}
            <a href={`/v1/benchmark/runs/${record.id}/export.csv`}>CSV</a>
          </div>
        </div>
      </header>

      {record.status === 'error' && record.error && (
        <div className="error-banner">
          <strong>A run falhou:</strong> {record.error}
        </div>
      )}
      {record.status === 'aborted' && (
        <div className="error-banner">
          Run interrompida (o servidor reiniciou enquanto ela rodava).
        </div>
      )}

      <section className="scoreboard">
        <h2>Classificação final (1º ao último)</h2>
        <table>
          <thead>
            <tr>
              <th>Col.</th>
              <th>Modelo</th>
              <th>Pontos</th>
              <th>1ºs</th>
              <th>Pos. média</th>
              <th>Aceitável p/ o trabalho</th>
              <th>Erros</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row, idx) => {
              const acceptRate =
                row.evaluated > 0 ? row.acceptable / row.evaluated : null;
              return (
                <tr key={row.modelId}>
                  <td>
                    <span
                      className="rank-badge"
                      style={{ background: rankColor(idx, standings.length) }}
                    >
                      {idx + 1}º
                    </span>
                  </td>
                  <td><code>{row.modelId}</code></td>
                  <td><strong>{row.points}</strong></td>
                  <td>{row.firstPlaces}</td>
                  <td>{row.avgPos != null ? row.avgPos.toFixed(2) : '—'}</td>
                  <td>
                    {row.evaluated === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        className={
                          acceptRate != null && acceptRate >= 0.5
                            ? 'verdict-ok'
                            : 'verdict-bad'
                        }
                      >
                        {row.acceptable}/{row.evaluated} etapas
                        {acceptRate != null &&
                          ` (${Math.round(acceptRate * 100)}%)`}
                      </span>
                    )}
                  </td>
                  <td>{row.errors > 0 ? <span className="error">{row.errors}</span> : 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small">
          Pontos: 1º lugar vale N−1, 2º vale N−2, … (somados em todas as etapas).
          “Aceitável p/ o trabalho” = avaliação qualitativa paralela: a resposta
          resolve a necessidade de forma correta e segura, mesmo não sendo a melhor.
        </p>
      </section>

      <section className="heatmap">
        <h2>Heatmap de posições</h2>
        <div className="heatmap-grid">
          <div className="heatmap-row heatmap-head">
            <div className="heatmap-cell model-label"> </div>
            {record.stages.map((s) => (
              <div key={s.index} className="heatmap-cell">{s.index + 1}</div>
            ))}
          </div>
          {competitorIds.map((modelId) => (
            <div key={modelId} className="heatmap-row">
              <div className="heatmap-cell model-label"><code>{modelId}</code></div>
              {record.stages.map((s) => {
                const ranking = s.judge?.rankedModelIds ?? [];
                const pos = ranking.indexOf(modelId);
                const label = pos >= 0 ? String(pos + 1) : '·';
                return (
                  <div
                    key={s.index}
                    className="heatmap-cell"
                    style={{ background: pos >= 0 ? rankColor(pos, totalCompetitors) : undefined }}
                    title={`Etapa ${s.index + 1}: ${label}`}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="stages">
        <h2>Etapas</h2>
        {record.stages.map((stage) => (
          <StageCard
            key={stage.index}
            stage={stage}
            open={openStages.has(stage.index)}
            onToggle={() => toggle(stage.index)}
            totalCompetitors={totalCompetitors}
          />
        ))}
      </section>
    </div>
  );
}

function StageCard({
  stage,
  open,
  onToggle,
  totalCompetitors,
}: {
  stage: StageRecord;
  open: boolean;
  onToggle: () => void;
  totalCompetitors: number;
}) {
  const ranking = stage.judge?.rankedModelIds ?? [];
  const blindMap = stage.judge?.blindMap ?? {};
  const modelToLetter: Record<string, string> = {};
  for (const [letter, modelId] of Object.entries(blindMap)) modelToLetter[modelId] = letter;

  const ev = stage.evaluation;
  const verdictByModel: Record<string, { acceptable: boolean; justification: string }> = {};
  for (const v of ev?.verdicts ?? []) verdictByModel[v.modelId] = v;

  return (
    <div className="stage-card">
      <div className="stage-head" onClick={onToggle}>
        <div>
          <strong>Etapa {stage.index + 1}</strong>
          {stage.error ? (
            <span className="muted"> — falhou (pulada)</span>
          ) : stage.spec ? (
            <span className="muted"> — {stage.spec.question.slice(0, 80)}</span>
          ) : (
            <span className="muted"> — gerando…</span>
          )}
        </div>
        <div>
          {stage.error && <span className="badge inconclusive">falhou</span>}
          {!stage.error && stage.judge?.inconclusive && <span className="badge inconclusive">inconclusivo</span>}
          {!stage.error && stage.judge && !stage.judge.inconclusive && <span className="badge ok">julgado</span>}
          {!stage.error && !stage.judge && stage.responses.length > 0 && <span className="badge pending">aguardando juiz</span>}
        </div>
      </div>
      {open && (
        <div className="stage-body">
          {stage.error && (
            <div className="error-banner">
              <strong>Etapa pulada:</strong> {stage.error}
              <div className="muted small">
                A run continuou normalmente nas demais etapas.
              </div>
            </div>
          )}
          {stage.spec && (
            <>
              <h4>Pergunta</h4>
              <p>{stage.spec.question}</p>
              <h4>Contexto de produto</h4>
              <pre className="context">{stage.spec.productContext}</pre>
            </>
          )}

          {ev && !ev.inconclusive && (
            <div className="evaluation">
              <h4>Avaliação qualitativa</h4>
              <p>
                <span className="badge ok">vencedor</span>{' '}
                <code>{ev.bestModelId}</code>
              </p>
              <p className="winner-reasons">{ev.bestReasons}</p>
            </div>
          )}
          {ev?.inconclusive && (
            <p className="muted small">Avaliação qualitativa indisponível nesta etapa.</p>
          )}

          {stage.spec && <h4>Respostas</h4>}

          {/* Live progress (durante a etapa) */}
          {stage.live && Object.values(stage.live).filter((l) => !l.done).length > 0 && (
            <div className="live-grid">
              {Object.values(stage.live)
                .filter((l) => !l.done)
                .map((l) => (
                  <div key={l.modelId} className="live-card">
                    <div className="live-head">
                      <code>{l.modelId}</code>
                      <span className="live-stats">
                        {l.chars} chars · {l.charsPerSec.toFixed(1)} ch/s
                      </span>
                    </div>
                    <pre className="live-preview">{l.preview || '…'}</pre>
                  </div>
                ))}
            </div>
          )}

          {stage.responses.length === 0 && !stage.live && <div className="muted">Aguardando competidores…</div>}
          {stage.responses
            .slice()
            .sort((a, b) => ranking.indexOf(a.modelId) - ranking.indexOf(b.modelId))
            .map((r) => {
              const pos = ranking.indexOf(r.modelId);
              const letter = modelToLetter[r.modelId];
              return (
                <div key={r.modelId} className="response">
                  <div className="response-head">
                    <div>
                      {pos >= 0 && (
                        <span
                          className="rank-badge"
                          style={{ background: rankColor(pos, totalCompetitors) }}
                        >
                          #{pos + 1}
                        </span>
                      )}
                      <code>{r.modelId}</code>
                      {letter && <span className="muted"> (era {letter})</span>}
                      {verdictByModel[r.modelId] && (
                        <span
                          className={
                            verdictByModel[r.modelId].acceptable
                              ? 'badge verdict-ok'
                              : 'badge verdict-bad'
                          }
                        >
                          {verdictByModel[r.modelId].acceptable
                            ? 'aceitável p/ o trabalho'
                            : 'não aceitável'}
                        </span>
                      )}
                    </div>
                    <div className="response-meta muted">
                      {formatMs(r.latencyMs)} · {r.tokensIn}→{r.tokensOut} tok · {r.text.length} chars · {formatUsd(r.costUsd)}
                      {r.status === 'error' && <span className="error"> · ERRO: {r.errorMsg}</span>}
                    </div>
                  </div>
                  {verdictByModel[r.modelId]?.justification && (
                    <p className="verdict-justification">
                      {verdictByModel[r.modelId].justification}
                    </p>
                  )}
                  {r.status === 'ok' && <pre className="response-text">{r.text}</pre>}
                </div>
              );
            })}
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
  switch (event.type) {
    case 'run.started':
      return event.record;
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
        s.live[event.modelId] = {
          modelId: event.modelId,
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
        const existing = s.live[event.modelId];
        s.live[event.modelId] = {
          modelId: event.modelId,
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
        const idx = s.responses.findIndex((r) => r.modelId === event.response.modelId);
        if (idx >= 0) s.responses[idx] = event.response;
        else s.responses.push(event.response);
        if (s.live && s.live[event.response.modelId]) {
          s.live[event.response.modelId] = { ...s.live[event.response.modelId], done: true };
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
