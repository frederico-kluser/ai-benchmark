import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Contestant, RunRecord, StageRecord, StageSpec, Verdict } from '../api';
import { buildScenarioPack, cacheRun, downloadScenarioPack, fetchRun, normalizeContestants, openRunStream, runMode } from '../api';
import {
  VERDICT_META,
  verdictOf,
  trunc,
  denseStages,
  applyEvent,
  ScoreHeatmap,
  FinalsPanel,
} from './runShared';

// Notacao decimal sempre: "$4.00e-4" e ilegivel para quem so quer saber quanto
// custou. Abaixo de 1 centesimo de centavo, um teto basta.
function formatUsd(v: number): string {
  if (!v) return '$0';
  if (v < 0.0001) return '<$0.0001';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Ordem de exibicao das respostas dentro do cenario: melhor veredito primeiro.
const VERDICT_ORDER: Record<Verdict, number> = { resolve: 0, parcial: 1, nao: 2 };

// Veredito de um competidor na etapa: pointwise vs gabarito quando existe,
// senao o consenso do juiz (com retrocompat ao binario `acceptable`).
function stageVerdict(stage: StageRecord, contestantId: string): Verdict | undefined {
  const ref = stage.referenceJudge?.verdictByContestant?.[contestantId];
  if (ref) return ref;
  return verdictOf({
    verdict: stage.judge?.verdictByContestant?.[contestantId],
    acceptable: stage.judge?.acceptableByContestant?.[contestantId],
  });
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

// CSV plano: uma linha por resposta (cenario × competidor), com o veredito.
function runToCsv(record: RunRecord, byId: Map<string, Contestant>): string {
  const rows: string[] = [];
  rows.push(
    ['runId', 'sessionId', 'iteration', 'stageIndex', 'question', 'contestantId', 'label', 'technique', 'modelId', 'status', 'latencyMs', 'tokensIn', 'tokensOut', 'costUsd', 'verdict', 'errorMsg', 'text']
      .map(csvEscape)
      .join(','),
  );
  for (const stage of record.stages) {
    if (!stage) continue;
    for (const r of stage.responses) {
      const c = byId.get(r.contestantId);
      rows.push(
        [record.id, record.sessionId ?? '', record.iteration ?? '', stage.index, stage.spec?.question ?? '', r.contestantId, c?.label ?? '', c?.techniqueId ?? '', r.modelId, r.status, r.latencyMs, r.tokensIn, r.tokensOut, r.costUsd, stageVerdict(stage, r.contestantId) ?? '', r.errorMsg ?? '', r.text]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return rows.join('\n');
}

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Accordion dos cenarios: no maximo UM aberto por vez (null = todos fechados).
  const [openStage, setOpenStage] = useState<number | null>(null);
  // Lista <details> dos cenarios: controlada para o clique no heatmap poder
  // força-la aberta. null = default (aberta so quando a run termina).
  const [listOpen, setListOpen] = useState<boolean | null>(null);
  // Progresso agregado dos duelos (evento `duel.progress`) — NUNCA passa pelo
  // reducer: o evento nem stageIndex tem. Fica local e alimenta o FinalsPanel.
  const [duelProgress, setDuelProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
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
        // `stage.gabarito` tem stageIndex -1 (sem UI propria) e `duel.progress`
        // nem stageIndex tem.
        if (event.type === 'stage.gabarito') return;
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

  // Clique numa celula do heatmap: abre o cenario correspondente e rola ate o
  // card. A lista pode estar recolhida durante a run — força aberta ANTES do
  // scroll (o rAF espera o details renderizar aberto).
  function openStageFromHeatmap(idx: number) {
    setOpenStage(idx);
    setListOpen(true);
    requestAnimationFrame(() => {
      document.getElementById(`stage-${idx}`)?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  const contestants = useMemo(() => (record ? normalizeContestants(record) : []), [record]);
  const byId = useMemo(
    () => new Map<string, Contestant>(contestants.map((c) => [c.id, c])),
    [contestants],
  );
  // Etapas densas (sem buracos) e ordenadas — base de toda a UI de resultados.
  const stages = useMemo(() => (record ? denseStages(record.stages) : []), [record]);

  // Cenarios do pacote de export: spec de cada etapa, dedup por question
  // (seeds podem repetir a mesma pergunta; o gabarito viaja no spec).
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

  // Prompt do pacote: o do CAMPEAO (maior judge-score entre nao-controle);
  // sem campeao com prompt, cai para o prompt base da run.
  const packPrompt = useMemo(() => {
    if (!record) return null;
    const scores = record.judgeScoreByContestant;
    const champion = scores
      ? contestants
          .filter((c) => !c.isOriginal && c.systemPrompt?.trim() && scores[c.id] !== undefined)
          .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))[0]
      : undefined;
    if (champion && champion.systemPrompt && champion.systemPrompt.trim()) {
      return { text: champion.systemPrompt, source: 'champion' as const, label: champion.label };
    }
    const base = record.config.basePrompt?.trim();
    if (base) return { text: base, source: 'base' as const, label: 'Prompt base' };
    return null;
  }, [record, contestants]);

  if (error) return <div className="screen center-screen"><div className="banner banner-error">{error}</div></div>;
  if (!record) return <div className="screen center-screen"><div className="loading-note">Carregando…</div></div>;

  const mode = runMode(record);
  const isSingle = mode !== 'compare';
  const isRunning = record.status === 'running';
  const totalStages = record.config.stages;
  const doneStages = stages.filter((s) => s.judge || s.error).length;
  // Bloco "Final": mesma condicao de nulidade do FinalsPanel (evita o rotulo orfao).
  const hasFinals = Boolean(record.finalists?.length) || stages.some((s) => s.duels);
  // Pacote de cenarios: SO variation terminada e com gabaritos. Compare nao
  // exporta (seus contestants sao modelos, sem systemPrompt proprio); treino
  // exporta pela TrainingView.
  const canExportPack =
    record.status === 'finished' && mode === 'variation' && packRefCount > 0 && Boolean(packPrompt);

  function exportScenarioPack() {
    if (!record || !packPrompt) return;
    downloadScenarioPack(
      buildScenarioPack({ theme: record.config.theme, prompt: packPrompt, scenarios: packScenarios }),
    );
  }

  return (
    <div className="screen runview">
      <div className="card rv-head">
        <div className="run-header-main">
          <div className="run-title-row">
            <h1 className="run-title">Run <code>{record.id.slice(0, 8)}</code></h1>
            <span className={`pill pill-${record.status}`}>{record.status}</span>
            {isRunning && <span className="live-pill"><span className="dot" />AO VIVO</span>}
          </div>
          <div className="run-theme">{trunc(record.config.theme, 140)}</div>
          {record.sessionId && (
            <Link className="session-link" to={`/training/${record.sessionId}`}>
              ← sessão de treino{record.iteration != null ? ` · rodada ${record.iteration + 1}` : ''}
            </Link>
          )}
        </div>

        <div className="rv-stats">
          <div className="rv-stat">
            <span className="rv-stat-label">cenários</span>
            {doneStages}/{totalStages}
          </div>
          <div className="rv-stat">
            <span className="rv-stat-label">custo</span>
            {formatUsd(record.totalCostUsd)}
          </div>
          <div className="export-row">
            <button type="button" className="export-btn" onClick={() => download(`run-${record.id}.json`, JSON.stringify(record, null, 2), 'application/json')}>JSON</button>
            <button type="button" className="export-btn" onClick={() => download(`run-${record.id}.csv`, runToCsv(record, byId), 'text/csv;charset=utf-8')}>CSV</button>
            {canExportPack && (
              <button type="button" className="export-btn" onClick={exportScenarioPack}>Pacote</button>
            )}
          </div>
        </div>
      </div>

      {record.status === 'error' && record.error && (
        <div className="banner banner-error"><strong>A run falhou:</strong> {record.error}</div>
      )}
      {record.status === 'aborted' && (
        <div className="banner banner-neutral">Run interrompida — o servidor reiniciou enquanto ela rodava.</div>
      )}

      <div className="section-label">Resultados</div>
      <ScoreHeatmap record={record} ranked={!isRunning} onStageClick={openStageFromHeatmap} />

      {hasFinals && (
        <>
          <div className="section-label">Final</div>
          <FinalsPanel record={record} progress={duelProgress} />
        </>
      )}

      {/* Enquanto roda, a tela e SO o heatmap: o drill-down por cenario fica
          recolhido por default (aberto so quando a run termina), mas o usuario
          e o clique no heatmap mandam (estado controlado, sincronizado no toggle). */}
      <details
        className="stage-list"
        open={listOpen ?? !isRunning}
        onToggle={(e) => setListOpen(e.currentTarget.open)}
      >
        <summary className="section-label">Cenários{stages.length ? ` (${stages.length})` : ''}</summary>
        {stages.length === 0 && (
          <div className="card" style={{ color: 'var(--text-3)' }}>Aguardando o primeiro cenário…</div>
        )}
        {stages.map((stage) => (
          <StageCard
            key={stage.index}
            stage={stage}
            byId={byId}
            contestants={contestants}
            open={openStage === stage.index}
            onToggle={() => toggleStage(stage.index)}
          />
        ))}
      </details>

      {isSingle && contestants.length > 0 && (
        <>
          <div className="section-label">Variantes</div>
          <details className="card variants-card">
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
              {contestants.length} variantes
              {contestants[0]?.modelId ? ` · ${contestants[0].modelId}` : ''}
            </summary>
            <div style={{ marginTop: 14 }}>
              {contestants.map((c) => (
                <div className="contestant-row" key={c.id}>
                  <div className="contestant-head">
                    <span className="contestant-label">
                      {c.label}
                      {c.isOriginal && <span className="control-tag">base</span>}
                      {c.techniqueId && <span className="tech-tag">{c.techniqueId}</span>}
                    </span>
                  </div>
                  {c.systemPrompt && <pre className="context-pre contestant-prompt">{c.systemPrompt}</pre>}
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

interface StageCardProps {
  stage: StageRecord;
  byId: Map<string, Contestant>;
  /** Contestants na ordem da run — desempate estavel da lista de respostas. */
  contestants: Contestant[];
  open: boolean;
  onToggle: () => void;
}

// Um cenario do accordion: cabecalho "01 · pergunta" e, aberto, o enunciado
// completo + as respostas ordenadas por veredito.
function StageCard({ stage, byId, contestants, open, onToggle }: StageCardProps) {
  const orderOf = new Map<string, number>(contestants.map((c, i) => [c.id, i] as [string, number]));
  const sortedResponses = stage.responses.slice().sort((a, b) => {
    const va = stageVerdict(stage, a.contestantId);
    const vb = stageVerdict(stage, b.contestantId);
    const oa = va ? VERDICT_ORDER[va] : 3;
    const ob = vb ? VERDICT_ORDER[vb] : 3;
    if (oa !== ob) return oa - ob;
    return (orderOf.get(a.contestantId) ?? 0) - (orderOf.get(b.contestantId) ?? 0);
  });

  const numLabel = String(stage.index + 1).padStart(2, '0');
  const snippet = stage.spec ? trunc(stage.spec.question, 90) : stage.error ? 'Cenário pulado' : 'Gerando cenário…';

  return (
    <div className="stage-card" id={`stage-${stage.index}`}>
      <button className="stage-head" onClick={onToggle}>
        <span className="stage-head-left">
          <span className="stage-num">{numLabel}</span>
          <span className="stage-snippet">{snippet}</span>
        </span>
        <span className="stage-head-right">
          {stage.error && <span className="stage-badge b-neutral">pulado</span>}
          <span className={`stage-caret ${open ? 'open' : ''}`}>▶</span>
        </span>
      </button>

      {open && (
        <div className="stage-body">
          {stage.error && (
            <div className="banner banner-neutral" style={{ marginTop: 16, marginBottom: 0 }}>
              <strong>Cenário pulado:</strong> {stage.error}
            </div>
          )}

          {stage.spec && (
            <>
              <div className="stage-block">
                <div className="label-mini">Pergunta</div>
                <div className="q-text">{stage.spec.question}</div>
              </div>
              <div className="stage-block">
                <div className="label-mini">Contexto</div>
                <pre className="context-pre">{stage.spec.productContext}</pre>
              </div>
              {stage.spec.rubric?.trim() && (
                <div className="stage-block">
                  <div className="label-mini">Rubrica</div>
                  <pre className="context-pre">{stage.spec.rubric}</pre>
                </div>
              )}
              {stage.spec.reference?.trim() && (
                <div className="stage-block">
                  <div className="label-mini">Gabarito</div>
                  <pre className="context-pre">{stage.spec.reference}</pre>
                </div>
              )}
            </>
          )}

          {sortedResponses.length > 0 && (
            <div className="answers">
              {sortedResponses.map((r) => {
                const v = stageVerdict(stage, r.contestantId);
                const meta = v ? VERDICT_META[v] : undefined;
                const explanation = stage.referenceJudge?.explanationByContestant?.[r.contestantId];
                return (
                  <div className="answer-card" key={r.contestantId}>
                    <div className="answer-head">
                      <span className="answer-model">{byId.get(r.contestantId)?.label ?? r.modelId}</span>
                      {meta && <span className={`verdict-pill ${meta.cls}`}>{meta.label}</span>}
                    </div>
                    <div className="answer-meta">
                      {formatMs(r.latencyMs)} · {r.tokensIn}→{r.tokensOut} tok · {formatUsd(r.costUsd)}
                      {r.status === 'error' && <span className="err"> · ERRO: {r.errorMsg}</span>}
                    </div>
                    {explanation && <div className="answer-note">{explanation}</div>}
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
