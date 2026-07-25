import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Contestant, DuelOutcome, JudgeVerdict, RunRecord, StageDuels, StageRecord, StageSpec, Verdict } from '../api';
import { buildScenarioPack, cacheRun, downloadScenarioPack, fetchRun, normalizeContestants, openRunStream, runMode } from '../api';
import { useTheme } from '../theme';
import { useProcessing } from '../processing';
import {
  VERDICT_META,
  verdictOf,
  trunc,
  denseStages,
  rankColor,
  computeStandings,
  stageStatus,
  applyEvent,
  ProcessMonitor,
} from './runShared';

// VERDICT_META / verdictOf: movidos para ./runShared (reuso na cockpit de treino).

function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.001) return `$${v.toExponential(2)}`;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// trunc: movido para ./runShared.

// Nome curto do modelo de um juiz (tira o prefixo do provider) p/ a UI compacta.
function shortModel(id: string): string {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

// Selo do veredito pointwise vs gabarito (bloco "Veredito vs gabarito").
const VERDICT_SEAL: Record<Verdict, string> = { resolve: '✓', parcial: '◐', nao: '✕' };

// Placement de duelos: fracionario em empate (ex.: 1.5) — mostra 1 casa so quando precisa.
function formatPlacement(p: number | undefined): string {
  if (p === undefined) return '—';
  return Number.isInteger(p) ? `${p}º` : `${p.toFixed(1)}º`;
}

// denseStages: movido para ./runShared.

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
    ['runId', 'sessionId', 'iteration', 'stageIndex', 'question', 'contestantId', 'label', 'technique', 'modelId', 'status', 'latencyMs', 'tokensIn', 'tokensOut', 'costUsd', 'rankPosition', 'verdict', 'errorMsg', 'text']
      .map(csvEscape)
      .join(','),
  );
  for (const stage of record.stages) {
    if (!stage) continue;
    const ranking = stage.judge?.rankedContestantIds ?? [];
    for (const r of stage.responses) {
      const rankPosition = ranking.indexOf(r.contestantId);
      const c = byId.get(r.contestantId);
      const verdict =
        stage.judge?.verdictByContestant?.[r.contestantId] ??
        (stage.judge?.acceptableByContestant?.[r.contestantId] === undefined
          ? ''
          : stage.judge.acceptableByContestant[r.contestantId]
            ? 'resolve'
            : 'nao');
      rows.push(
        [record.id, record.sessionId ?? '', record.iteration ?? '', stage.index, stage.spec?.question ?? '', r.contestantId, c?.label ?? '', c?.techniqueId ?? '', r.modelId, r.status, r.latencyMs, r.tokensIn, r.tokensOut, r.costUsd, rankPosition >= 0 ? rankPosition + 1 : '', verdict, r.errorMsg ?? '', r.text]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return rows.join('\n');
}

// RankColor / rankColor: movidos para ./runShared.

// Standing / computeStandings: movidos para ./runShared.

// stageStatus: movido para ./runShared.

const RING_R = 18;
const RING_C = 2 * Math.PI * RING_R;

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const theme = useTheme();
  const dark = theme === 'dark';
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Carrossel das etapas: no maximo UMA aberta por vez (null = todas fechadas).
  const [openStage, setOpenStage] = useState<number | null>(null);
  const [tab, setTab] = useState<'resumo' | 'etapas' | null>(null);
  const { setIsProcessing } = useProcessing();
  // Progresso agregado do julgamento por referencia (eventos `stage.gabarito` /
  // `duel.progress`) — NUNCA passa pelo reducer: o primeiro vem com stageIndex
  // -1 (agregado do lote) e o segundo nem stageIndex tem. Fica em estado local
  // e alimenta o ProcessMonitor.
  const [gabaritoProgress, setGabaritoProgress] = useState<{ done: number; total: number } | null>(null);
  const [duelProgress, setDuelProgress] = useState<{ done: number; total: number } | null>(null);
  // Dialog inline de export do pacote de cenarios (JSON) — so run variation
  // terminada e com referencias (ver `canExportPack` abaixo).
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [packSource, setPackSource] = useState<'champion' | 'base'>('champion');

  useEffect(() => {
    setIsProcessing(record?.status === 'running');
  }, [record?.status, setIsProcessing]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setGabaritoProgress(null);
    setDuelProgress(null);

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
        if (event.type === 'run.finished') void cacheRun(event.record);
        // Ramifica ANTES do applyEvent: progresso agregado nao e uma etapa —
        // `stage.gabarito` tem stageIndex -1 e `duel.progress` nem stageIndex
        // tem (o reducer tambem os devolve sem tocar em `stages`, por defesa).
        if (event.type === 'stage.gabarito') {
          setGabaritoProgress({ done: event.done, total: event.total });
          return;
        }
        if (event.type === 'duel.progress') {
          setDuelProgress({ done: event.done, total: event.total });
          return;
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

  function toggleStage(idx: number) {
    setOpenStage((prev) => (prev === idx ? null : idx));
  }

  const contestants = useMemo(() => (record ? normalizeContestants(record) : []), [record]);
  const byId = useMemo(
    () => new Map<string, Contestant>(contestants.map((c) => [c.id, c])),
    [contestants],
  );
  const standings = useMemo(() => (record ? computeStandings(record) : []), [record]);
  // Etapas densas (sem buracos) e ordenadas — base de toda a UI de resultados.
  const stages = useMemo(() => (record ? denseStages(record.stages) : []), [record]);

  // Judge-score vs gabarito por competidor (desc) — so existe em runs com
  // julgamento por referencia.
  const judgeScoreRows = useMemo(() => {
    const scores = record?.judgeScoreByContestant;
    if (!record || !scores) return [];
    return contestants
      .map((c) => ({ id: c.id, label: c.label, isControl: Boolean(c.isOriginal), score: scores[c.id] ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }, [record, contestants]);

  // Standings Copeland agregados (duelos) — vazio em runs listwise.
  const copelandStandings = useMemo(() => record?.standings ?? [], [record]);

  // Cenarios do pacote de export: spec de cada etapa, dedup por question
  // (repeats/seeds podem repetir a mesma pergunta; o gabarito viaja no spec).
  const packScenarios = useMemo(() => {
    const seen = new Set<string>();
    const out: StageSpec[] = [];
    for (const s of stages) {
      const spec = s.spec;
      if (!spec) continue;
      const key = spec.question.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
    return out;
  }, [stages]);
  const packRefCount = packScenarios.filter((s) => s.reference?.trim()).length;

  // Prompt "campeao" do pacote: maior judge-score entre NAO-controle;
  // fallback: 1o do standings; fallback: controle.
  const packChampion = useMemo(() => {
    if (!record) return undefined;
    const scores = record.judgeScoreByContestant;
    if (scores) {
      const best = contestants
        .filter((c) => !c.isOriginal && scores[c.id] !== undefined)
        .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))[0];
      if (best) return best;
    }
    const first = record.standings?.[0];
    if (first) {
      const c = byId.get(first.id);
      if (c) return c;
    }
    return contestants.find((c) => c.isOriginal) ?? contestants[0];
  }, [record, contestants, byId]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;
  if (!record) return <div className="screen center-screen"><div className="loading-note">Carregando…</div></div>;

  const mode = runMode(record);
  const totalCompetitors = contestants.length;
  const totalStages = record.config.stages;
  const doneStages = stages.filter((s) => s.judge || s.error).length;
  const hasRing = record.status === 'running' || record.status === 'finished';
  const ringOffset = RING_C * (1 - (totalStages ? doneStages / totalStages : 0));

  const isRunning = record.status === 'running';
  // Resultados (placar/heatmap/etapas detalhadas) só aparecem quando a run TERMINA.
  // Enquanto roda, mostramos o visualizador de processo (todas as etapas em paralelo).
  const hasScoreboard = stages.some((s) => s.judge);
  const effectiveTab = tab ?? (hasScoreboard ? 'resumo' : 'etapas');
  const showScoreboard = hasScoreboard && effectiveTab === 'resumo';
  const showStages = !hasScoreboard || effectiveTab === 'etapas';
  const isSingle = mode !== 'compare';
  // Pacote de cenarios: SO variation terminada e com referencias. Compare com
  // referencias NAO exporta aqui — seus contestants sao modelos, sem
  // systemPrompt proprio, e o schema do pacote exige `prompt.text` nao-vazio
  // (nao ha "prompt campeao" p/ embutir). Treino exporta pela TrainingView.
  const canExportPack =
    record.status === 'finished' && mode === 'variation' && packRefCount > 0 && Boolean(packChampion);
  const hasBasePrompt = Boolean(record.config.basePrompt?.trim());

  function exportScenarioPack() {
    if (!record || !packChampion) return;
    const prompt =
      packSource === 'base'
        ? { text: record.config.basePrompt ?? '', source: 'base' as const, label: 'Prompt base' }
        : { text: packChampion.systemPrompt ?? '', source: 'champion' as const, label: packChampion.label };
    // O schema do pacote exige prompt.text nao-vazio — sem prompt, nao exporta.
    if (!prompt.text.trim()) return;
    const pack = buildScenarioPack({ theme: record.config.theme, prompt, scenarios: packScenarios });
    downloadScenarioPack(pack);
    setPackDialogOpen(false);
  }

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
              {canExportPack && (
                <button type="button" className="export-btn" onClick={() => setPackDialogOpen((v) => !v)}>Baixar pacote (JSON)</button>
              )}
              <button type="button" className="export-btn" onClick={() => download(`run-${record.id}.json`, JSON.stringify(record, null, 2), 'application/json')}>JSON</button>
              <button type="button" className="export-btn" onClick={() => download(`run-${record.id}.csv`, runToCsv(record, byId), 'text/csv;charset=utf-8')}>CSV</button>
            </div>
          </div>
        </div>
      </div>

      {packDialogOpen && canExportPack && packChampion && (
        <div className="card" style={{ marginBottom: 22 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Baixar pacote (JSON)</div>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
            {packScenarios.length} cenários ({packRefCount} com gabarito) + o prompt escolhido —
            importável como seed numa próxima run.
          </p>
          <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, fontSize: 14 }}>
            <input
              type="radio"
              name="pack-prompt"
              checked={packSource === 'champion'}
              onChange={() => setPackSource('champion')}
            />
            <span>
              Melhor variação — <strong>{packChampion.label}</strong>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, color: hasBasePrompt ? undefined : 'var(--text-3)' }}>
            <input
              type="radio"
              name="pack-prompt"
              disabled={!hasBasePrompt}
              checked={packSource === 'base'}
              onChange={() => setPackSource('base')}
            />
            <span>Prompt base (controle)</span>
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={() => setPackDialogOpen(false)}>Cancelar</button>
            <button type="button" className="btn-primary" onClick={exportScenarioPack}>Baixar</button>
          </div>
        </div>
      )}

      {record.status === 'error' && record.error && (
        <div className="banner banner-error"><strong>A run falhou:</strong> {record.error}</div>
      )}
      {record.status === 'aborted' && (
        <div className="banner banner-neutral">
          Run interrompida — o servidor reiniciou enquanto ela rodava; por isso foi marcada como abortada.
        </div>
      )}

      {isSingle && <ContestantsPanel contestants={contestants} />}

      {isRunning && (
        <ProcessMonitor record={record} totalCompetitors={totalCompetitors} gabarito={gabaritoProgress} duelos={duelProgress} />
      )}

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
              Pontos somam o esquema corrida (1º = N−1, … último = 0) de todas as etapas — e de
              cada juiz (com vários juízes, cada um pontua). “Aceitável” = a resposta resolve a
              necessidade de forma correta e segura (maioria dos juízes), mesmo sem ser a melhor.
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
                {stages.map((s) => (
                  <div className="heat-col" key={s.index}>{s.index + 1}</div>
                ))}
              </div>
              {contestants.map((c) => (
                <div className="heat-row" key={c.id}>
                  <div className="heat-label">{c.label}</div>
                  {stages.map((s) => {
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
          {judgeScoreRows.length > 0 && (
            <>
              <div className="section-label">Judge-score vs gabarito (0–100)</div>
              <div className="score-card">
                <div className="score-head" style={{ gridTemplateColumns: 'minmax(0, 1fr) 110px' }}>
                  <div>{isSingle ? 'Variante' : 'Modelo'}</div>
                  <div>Judge-score</div>
                </div>
                {judgeScoreRows.map((row) => (
                  <div className="score-row" key={row.id} style={{ gridTemplateColumns: 'minmax(0, 1fr) 110px' }}>
                    <div className="score-model">
                      {row.label}
                      {row.isControl && <span className="control-tag" style={{ marginLeft: 8 }}>controle</span>}
                    </div>
                    <div className="score-points">{row.score.toFixed(1)}</div>
                  </div>
                ))}
                <div className="score-foot">
                  Judge-score = (resolve + 0,5 × parcial) / total × 100, sobre as etapas com gabarito.
                </div>
              </div>
            </>
          )}

          {copelandStandings.length > 0 && (
            <>
              <div className="section-label">Classificação Copeland (duelos)</div>
              <div className="score-card">
                <div className="score-head" style={{ gridTemplateColumns: '54px minmax(0, 1fr) 76px 96px 80px' }}>
                  <div>Col.</div>
                  <div>{isSingle ? 'Variante' : 'Modelo'}</div>
                  <div>Pontos</div>
                  <div>V-E-D</div>
                  <div>Win rate</div>
                </div>
                {copelandStandings.map((s, idx) => (
                  <div className="score-row" key={s.id} style={{ gridTemplateColumns: '54px minmax(0, 1fr) 76px 96px 80px' }}>
                    <div>
                      <span className="place-badge" style={{ background: rankColor(idx + 1, copelandStandings.length, dark).solid }}>
                        {idx + 1}º
                      </span>
                    </div>
                    <div className="score-model">
                      {s.label}
                      {s.isControl && <span className="control-tag" style={{ marginLeft: 8 }}>controle</span>}
                    </div>
                    <div className="score-points">{s.points}</div>
                    <div className="score-num">{s.wins}-{s.ties}-{s.losses}</div>
                    <div className="score-num">{Math.round(s.winRate * 100)}%</div>
                  </div>
                ))}
                <div className="score-foot">
                  Copeland dos duelos pairwise: vitória 1 ponto, empate 0,5. V-E-D = vitórias–empates–derrotas.
                </div>
              </div>
            </>
          )}
        </>
      )}

      {!isRunning && showStages && (
        <>
          <div className="section-label">Etapas</div>
          {stages.length === 0 && (
            <div className="card" style={{ color: 'var(--text-3)' }}>Aguardando a primeira etapa…</div>
          )}
          {stages.map((stage, i) => (
            <StageCard
              key={stage.index}
              stage={stage}
              byId={byId}
              contestants={contestants}
              open={openStage === stage.index}
              onToggle={() => toggleStage(stage.index)}
              totalCompetitors={totalCompetitors}
              dark={dark}
              position={`${i + 1} / ${stages.length}`}
              onPrev={i > 0 ? () => setOpenStage(stages[i - 1].index) : undefined}
              onNext={i < stages.length - 1 ? () => setOpenStage(stages[i + 1].index) : undefined}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ProcessMonitor / ProcessRow: movidos para ./runShared (reuso na cockpit de treino).

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
  contestants,
  open,
  onToggle,
  totalCompetitors,
  dark,
  position,
  onPrev,
  onNext,
}: {
  stage: StageRecord;
  byId: Map<string, Contestant>;
  /** Contestants na ordem da run — dirige o bloco "Veredito vs gabarito". */
  contestants: Contestant[];
  open: boolean;
  onToggle: () => void;
  totalCompetitors: number;
  dark: boolean;
  /** Posicao no carrossel, ex.: "2 / 5". */
  position?: string;
  /** Abre a etapa anterior (undefined = nao ha). */
  onPrev?: () => void;
  /** Abre a proxima etapa (undefined = nao ha). */
  onNext?: () => void;
}) {
  const judge = stage.judge;
  // Julgamento por referencia (quando a etapa tem gabarito): veredito pointwise
  // por competidor + duelos Copeland. Extraidos p/ const p/ narrowing no JSX.
  const refJudge = stage.referenceJudge;
  const stageDuels = stage.duels;
  const ranking = judge?.rankedContestantIds ?? [];
  const blindMap = judge?.blindMap ?? {};
  const contestantToLetter: Record<string, string> = {};
  for (const [letter, cid] of Object.entries(blindMap)) contestantToLetter[cid] = letter;

  // Veredito ternario de consenso (+ aceitabilidade compat) + vereditos por juiz.
  const acceptableBy = judge?.acceptableByContestant ?? {};
  const verdictBy = judge?.verdictByContestant ?? {};
  const judges = judge?.judges ?? [];
  // Retrocompat: records antigos guardavam aceitabilidade/justificativa num
  // estagio "evaluation" separado (hoje fundido no juiz).
  const ev = stage.evaluation;
  const oldVerdictBy: Record<string, { acceptable: boolean; justification: string }> = {};
  for (const v of ev?.verdicts ?? []) oldVerdictBy[v.contestantId] = v;

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
          {(onPrev || onNext) && (
            <div className="stage-carousel-nav">
              <button type="button" className="carousel-btn" disabled={!onPrev} onClick={onPrev}>
                ‹ Anterior
              </button>
              {position && <span className="stage-carousel-pos">Etapa {position}</span>}
              <button type="button" className="carousel-btn" disabled={!onNext} onClick={onNext}>
                Próxima ›
              </button>
            </div>
          )}
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
              {stage.spec.rubric && (
                <div className="stage-block">
                  <div className="label-mini">Critério de correção (rubrica do juiz)</div>
                  <pre className="context-pre">{stage.spec.rubric}</pre>
                </div>
              )}
              {stage.spec.reference?.trim() && (
                <div className="stage-block">
                  <div className="label-mini">Gabarito (resposta de referência)</div>
                  <pre className="context-pre">{stage.spec.reference}</pre>
                </div>
              )}
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

          {refJudge && (
            <div className="stage-block">
              <div className="label-mini">
                Veredito vs gabarito · {shortModel(refJudge.judgeModelId)}
              </div>
              <div className="judge-verdicts" style={{ marginTop: 8 }}>
                {contestants.map((c) => {
                  const v = refJudge.verdictByContestant[c.id];
                  const meta = v ? VERDICT_META[v] : undefined;
                  const explanation = refJudge.explanationByContestant[c.id];
                  return (
                    <div className="judge-verdict" key={c.id}>
                      <span className={`verdict-dot ${meta?.cls ?? 'bad'}`} />
                      <span className="judge-verdict-model">{c.label}</span>
                      {v && meta && (
                        <span className={`verdict-pill ${meta.cls}`}>
                          {VERDICT_SEAL[v]} {meta.label}
                        </span>
                      )}
                      <span className="judge-verdict-motivo">{explanation || '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {stage.judge && sortedResponses.length > 0 && (
            <div className="answers">
              {sortedResponses.map((r) => {
                const pos = ranking.indexOf(r.contestantId);
                const letter = contestantToLetter[r.contestantId];
                // Veredito ternario de consenso (fallback: aceitavel novo -> evaluation antigo).
                const consensus =
                  verdictOf({ verdict: verdictBy[r.contestantId] }) ??
                  (acceptableBy[r.contestantId] !== undefined
                    ? acceptableBy[r.contestantId]
                      ? 'resolve'
                      : 'nao'
                    : verdictOf(oldVerdictBy[r.contestantId]));
                const consensusMeta = consensus ? VERDICT_META[consensus] : undefined;
                // veredito de CADA juiz para esta resposta (justificativa + ternario).
                const perJudge = judges
                  .map((j) => ({ model: j.judgeModelId, v: j.verdicts.find((x) => x.contestantId === r.contestantId) }))
                  .filter((x): x is { model: string; v: JudgeVerdict } => Boolean(x.v));
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
                      {consensusMeta && (
                        <span className={`verdict-pill ${consensusMeta.cls}`}>
                          {consensusMeta.label}
                          {judges.length > 1 ? ` · consenso de ${judges.length}` : ''}
                        </span>
                      )}
                    </div>
                    <div className="answer-meta">
                      {formatMs(r.latencyMs)} · {r.tokensIn}→{r.tokensOut} tok · {r.text.length} chars · {formatUsd(r.costUsd)}
                      {r.status === 'error' && <span className="err"> · ERRO: {r.errorMsg}</span>}
                    </div>
                    {perJudge.length > 0 ? (
                      <div className="judge-verdicts">
                        {perJudge.map(({ model, v }) => {
                          const jv = verdictOf(v);
                          const meta = jv ? VERDICT_META[jv] : undefined;
                          return (
                            <div className="judge-verdict" key={model}>
                              <span className={`verdict-dot ${meta?.cls ?? 'bad'}`} />
                              <span className="judge-verdict-model" title={model}>{shortModel(model)}</span>
                              <span className="judge-verdict-motivo">
                                {v.motivo || meta?.label || '—'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      oldVerdictBy[r.contestantId]?.justification && (
                        <div className="answer-note">{oldVerdictBy[r.contestantId].justification}</div>
                      )
                    )}
                    {r.status === 'ok' && <pre className="answer-text">{r.text}</pre>}
                  </div>
                );
              })}
            </div>
          )}

          {stageDuels && <DuelsPanel duels={stageDuels} byId={byId} dark={dark} />}
        </div>
      )}
    </div>
  );
}

// Painel de auditoria dos duelos pairwise da etapa (Copeland): tabela de
// placements + lista expansivel com as DUAS ordens de cada duelo (desacordo
// entre ordens = empate). So e montado quando a etapa tem `duels` — runs
// listwise (sem gabarito) ficam como estao.
function DuelsPanel({
  duels,
  byId,
  dark,
}: {
  duels: StageDuels;
  byId: Map<string, Contestant>;
  dark: boolean;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  const total = duels.order.length;
  function toggle(i: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  // Vencedor de UMA ordem do duelo, com label real ('tie' = empate).
  const winnerLabel = (d: DuelOutcome, w: 'a' | 'b' | 'tie') =>
    w === 'tie' ? 'empate' : labelOf(w === 'a' ? d.a : d.b);
  return (
    <div className="stage-block">
      <div className="label-mini">
        Duelos (Copeland){duels.topK > 0 ? ` · bracket top ${duels.topK}` : ' · round-robin completo'}
      </div>
      <div className="score-card" style={{ marginTop: 8, marginBottom: duels.duels.length ? 12 : 0 }}>
        <div className="score-head" style={{ gridTemplateColumns: '54px minmax(0, 1fr) 76px' }}>
          <div>Pos.</div>
          <div>Competidor</div>
          <div>Pontos</div>
        </div>
        {duels.order.map((id) => {
          const placement = duels.placementByContestant[id];
          return (
            <div className="score-row" key={id} style={{ gridTemplateColumns: '54px minmax(0, 1fr) 76px' }}>
              <div>
                <span className="place-badge" style={{ background: rankColor(placement ?? total, total, dark).solid }}>
                  {formatPlacement(placement)}
                </span>
              </div>
              <div className="score-model">{labelOf(id)}</div>
              <div className="score-num">{duels.points[id] ?? 0}</div>
            </div>
          );
        })}
      </div>
      {duels.duels.map((d, i) => (
        <div className="contestant-row" key={`${d.a}-${d.b}-${i}`}>
          <button type="button" className="contestant-head" onClick={() => toggle(i)}>
            <span className="contestant-label">
              {labelOf(d.a)} × {labelOf(d.b)}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={`stage-badge ${d.outcome === 'tie' ? 'b-neutral' : 'b-ok'}`}>
                {d.outcome === 'tie' ? 'Empate' : `Venceu: ${winnerLabel(d, d.outcome)}`}
              </span>
              <span className={`stage-caret ${open.has(i) ? 'open' : ''}`}>▶</span>
            </span>
          </button>
          {open.has(i) && (
            <div className="judge-verdicts" style={{ padding: '4px 14px 12px', marginBottom: 0 }}>
              <div className="judge-verdict">
                <span className="judge-verdict-model">Ordem 1</span>
                <span className="judge-verdict-motivo">
                  <strong>{winnerLabel(d, d.order1.winner)}</strong>
                  {d.order1.explanation ? ` — ${d.order1.explanation}` : ''}
                </span>
              </div>
              <div className="judge-verdict">
                <span className="judge-verdict-model">Ordem 2</span>
                <span className="judge-verdict-motivo">
                  <strong>{winnerLabel(d, d.order2.winner)}</strong>
                  {d.order2.explanation ? ` — ${d.order2.explanation}` : ''}
                </span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// applyEvent: movido para ./runShared (reuso na cockpit de treino).
