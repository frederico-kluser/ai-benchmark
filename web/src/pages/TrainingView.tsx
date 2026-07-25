import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RunRecord, SessionRecord, StageSpec } from '../api';
import {
  cacheSession,
  fetchSession,
  openSessionStream,
  fetchRun,
  getLiveRun,
  subscribeRunLive,
  getConcurrency,
  savePrompt,
  buildScenarioPack,
  downloadScenarioPack,
} from '../api';
import { useTheme } from '../theme';
import { useProcessing } from '../processing';
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

/** Classificacao Copeland (duelos) de uma rodada — vem agregada no record
 *  (`standings`), na ordem em que o orchestrator ranqueou. */
function CopelandBoard({ record, dark }: { record: RunRecord; dark: boolean }) {
  const rows = record.standings ?? [];
  if (!rows.length) return null;
  // Mesma estetica do quadro de medalhas, com grade propria (pontos/V-E-D/winrate).
  const grid = { gridTemplateColumns: '54px minmax(0, 1fr) 70px 120px 80px' };
  return (
    <div className="card medal-board">
      <div className="medal-row medal-head" style={grid}>
        <div>Col.</div>
        <div>Variante</div>
        <div title="Pontos Copeland: vitória 1, empate 0.5">Pontos</div>
        <div title="Vitórias – Empates – Derrotas">V–E–D</div>
        <div title="Taxa de vitória (empate conta metade)">WinRate</div>
      </div>
      {rows.map((row, idx) => (
        <div className="medal-row" key={row.id} style={grid}>
          <div>
            <span className="place-badge" style={{ background: rankColor(idx + 1, rows.length, dark).solid }}>
              {idx + 1}º
            </span>
          </div>
          <div className="medal-model">
            {row.label}
            {row.isControl && <span className="control-tag">controle</span>}
          </div>
          <div className="medal-count">{row.points}</div>
          <div className="medal-count">
            {row.wins}–{row.ties}–{row.losses}
          </div>
          <div className="medal-count">{Math.round(row.winRate * 100)}%</div>
        </div>
      ))}
    </div>
  );
}

const VERDICT_CELL: Record<string, { glyph: string; bg: string; color: string }> = {  resolve: { glyph: '✓', bg: 'var(--ok-soft)', color: 'var(--ok)' },
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

/** Heatmap de progressao: variante x rodada; celula = colocacao, campea com 🏆.
 *  `holdoutAt` marca a coluna da run de holdout (iteracao N+1 vira "H"). */
function ProgressionHeatmap({ rounds, dark, holdoutAt }: { rounds: RunRecord[]; dark: boolean; holdoutAt?: number }) {
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
            <div
              className="heat-col"
              key={pr.iteration}
              title={pr.iteration === holdoutAt ? 'Rodada de holdout (gate final)' : undefined}
            >
              {pr.iteration === holdoutAt ? 'H' : `R${pr.iteration + 1}`}
            </div>
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
                  <div
                    className="heat-cell-wrap"
                    key={pr.iteration}
                    title={`${pr.iteration === holdoutAt ? 'Holdout' : `Rodada ${pr.iteration + 1}`}: não participou`}
                  >
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
                  title={`${v.label}: ${pos + 1}º ${pr.iteration === holdoutAt ? 'no holdout' : `na rodada ${pr.iteration + 1}`}${win ? ' (campeã)' : ''}`}
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

/** Estudio final: escolher qualquer variante de qualquer rodada, diff vs.
 *  original, copiar e salvar na biblioteca local. */
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
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    const tag = selRound.iteration === holdoutAt ? 'holdout' : `it. ${selRound.iteration + 1}`;
    setSaveName(`Prompt ${selContestant?.label ?? selCid ?? 'variante'} · ${tag}`);
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
          techniqueId: selContestant?.techniqueId,
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
              setSelRunId(rid);
              const r = data.find((d) => d.runId === rid);
              setSelCid(r?.standings[0]?.contestantId);
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-secondary" onClick={openSaveForm} disabled={!selPrompt || saved}>
            {saved ? 'Salvo ✓' : 'Salvar na biblioteca'}
          </button>
          <button type="button" className="btn-secondary" onClick={copy} disabled={!selPrompt}>
            {copied ? 'Copiado!' : 'Copiar prompt'}
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

/** Gates finais do treino (suporte a decisao, nunca bloqueantes): holdout,
 *  significancia estatistica e convergencia antecipada. Chegam ao vivo pelos
 *  eventos session.holdout / session.converged e no fetch final da sessao. */
function GateCards({ session }: { session: SessionRecord }) {
  const holdout = session.holdout;
  const sig = session.significance;
  const converged = session.convergedAtIteration;
  if (!holdout && sig === undefined && converged == null) return null;
  const minGain = session.config.minGain ?? 1.0;
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 30 }}>
      {converged != null && (
        <div className="banner banner-neutral" style={{ marginBottom: 0 }}>
          Convergiu na iteração {converged + 1} — o vencedor não superou a margem mínima
          (minGain {minGain} pp); treino encerrado antes do planejado.
        </div>
      )}
      {holdout && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Gate de holdout (n={holdout.n})</span>
          <span style={{ color: 'var(--text-2)' }}>
            controle {holdout.controlScore.toFixed(1)} vs campeão {holdout.championScore.toFixed(1)} (ganho{' '}
            {signed(holdout.gain)} pp)
          </span>
          {holdout.regressed && <span className="pill pill-error">REGRESSOU</span>}
        </div>
      )}
      {sig !== undefined && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Significância</span>
          {sig === null ? (
            <span style={{ color: 'var(--text-2)' }}>amostra insuficiente (n&lt;5)</span>
          ) : (
            <span style={{ color: 'var(--text-2)' }}>
              Δ médio {signed(sig.meanDiffPp)} pp · IC95% [{sig.ci95Pp[0].toFixed(1)},{' '}
              {sig.ci95Pp[1].toFixed(1)}] · {sig.pValue < 0.001 ? 'p<0.001' : `p=${sig.pValue.toFixed(3)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Exportacao do pacote JSON de cenarios+gabaritos (seed importavel em runs
 *  futuras). Cenarios coletados das runs da sessao, com dedup por pergunta. */
function ScenarioPackExport({ session }: { session: SessionRecord }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'champion' | 'base'>('champion');
  const [scenarios, setScenarios] = useState<StageSpec[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastBest = session.bestPromptByIteration[session.bestPromptByIteration.length - 1];
  const championOk = Boolean(lastBest?.systemPrompt);
  const effectiveSource = championOk ? source : 'base';

  // Ao abrir, coleta os cenarios de todas as runs da sessao: dedup por pergunta
  // preferindo a versao COM gabarito; fallback = cenarios pinados da sessao.
  useEffect(() => {
    if (!open || scenarios) return;
    let cancelled = false;
    setBusy(true);
    (async () => {
      const byQuestion = new Map<string, StageSpec>();
      for (const rid of session.runIds) {
        try {
          const run = await fetchRun(rid);
          for (const st of denseStages(run.stages)) {
            const spec = st.spec;
            if (!spec?.question) continue;
            const prev = byQuestion.get(spec.question);
            if (!prev || (!prev.reference && spec.reference)) byQuestion.set(spec.question, spec);
          }
        } catch {
          // Run perdida no cache: segue com as demais.
        }
      }
      let list = [...byQuestion.values()];
      if (!list.length && session.pinnedStages?.length) {
        list = session.pinnedStages.filter((s) => s.question);
      }
      if (!cancelled) {
        setScenarios(list);
        setBusy(false);
      }
    })().catch(() => {
      if (!cancelled) {
        setError('Falha ao coletar os cenários das runs.');
        setBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, scenarios, session]);

  const withRef = (scenarios ?? []).filter((s) => s.reference).length;

  function download() {
    if (!scenarios?.length) return;
    const prompt =
      effectiveSource === 'champion' && lastBest
        ? { text: lastBest.systemPrompt, source: 'champion' as const, label: `Campeão da iteração ${lastBest.iteration + 1}` }
        : { text: session.config.basePrompt ?? '', source: 'base' as const, label: 'Prompt base' };
    downloadScenarioPack(buildScenarioPack({ theme: session.config.theme, prompt, scenarios }));
  }

  return (
    <div style={{ marginBottom: 30 }}>
      <button type="button" className="btn-secondary" onClick={() => setOpen((o) => !o)}>
        {open ? 'Fechar pacote' : 'Baixar pacote (JSON)'}
      </button>
      {open && (
        <div className="card" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: championOk ? 'pointer' : 'not-allowed' }}>
              <input
                type="radio"
                name="pack-prompt"
                checked={effectiveSource === 'champion'}
                disabled={!championOk}
                onChange={() => setSource('champion')}
              />
              Campeão (recomendado)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="pack-prompt" checked={effectiveSource === 'base'} onChange={() => setSource('base')} />
              Prompt base
            </label>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {busy
              ? 'Coletando cenários das runs…'
              : scenarios
                ? `${scenarios.length} cenários (${withRef} com gabarito) serão exportados.`
                : 'Nenhum cenário disponível.'}
          </div>
          {error && <div className="banner banner-error" style={{ marginBottom: 0 }}>{error}</div>}
          <div>
            <button
              type="button"
              className="btn-primary"
              style={{ fontSize: 14, padding: '10px 18px' }}
              onClick={download}
              disabled={busy || !scenarios?.length}
            >
              Baixar
            </button>
          </div>
        </div>
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
  const [promotions, setPromotions] = useState<{ iteration: number; championId: string; gain: number }[]>([]);
  const { setIsProcessing } = useProcessing();

  useEffect(() => {
    setIsProcessing(
      session?.status === 'running' || analyzing || (fanout?.active ?? 0) > 0,
    );
  }, [session?.status, analyzing, fanout, setIsProcessing]);

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
        if (event.type === 'iteration.promoted') {
          setPromotions((prev) =>
            prev.some((p) => p.iteration === event.iteration)
              ? prev
              : [...prev, { iteration: event.iteration, championId: event.championId, gain: event.gain }],
          );
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
  // A run de holdout e marcada com iteracao == planned ("rodada H"): em toda
  // lista de rodadas ela vira "Holdout", nunca "Rodada N+1".
  const holdoutAt = planned > 0 ? planned : undefined;
  const isHoldoutIter = (it: number | null | undefined) => it != null && it === holdoutAt;
  const best = session.bestPromptByIteration.length
    ? session.bestPromptByIteration.reduce((a, b) => (b.score >= a.score ? b : a))
    : undefined;
  const originalPrompt = session.config.basePrompt ?? '';
  const hasRounds = rounds.length > 0;
  // Rodada mais recente com classificacao Copeland agregada (pode ser o holdout).
  const copelandRecord = [...rounds].reverse().find((r) => (r.standings?.length ?? 0) > 0);
  const holdoutRound = holdoutAt !== undefined ? rounds.find((r) => r.iteration === holdoutAt) : undefined;
  const anyFinished = rounds.some((r) => r.status === 'finished');

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

      {/* Log de promocoes (evento iteration.promoted, ao vivo) */}
      {promotions.length > 0 && (
        <div className="card" style={{ marginBottom: 24, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {promotions.map((p) => (
            <div key={p.iteration} className="muted" style={{ fontSize: 13 }}>
              It. {p.iteration + 1}: <code className="mono-id">{p.championId}</code> promovido (+{p.gain.toFixed(1)} pp)
            </div>
          ))}
        </div>
      )}

      {isRunning && <FanOutBar fanout={fanout} liveRun={liveRun} />}

      {/* Rodada em andamento — quadro de medalhas + heatmap + streaming ao vivo */}
      {isRunning && (
        <>
          <div className="section-label">
            {isHoldoutIter(liveRun?.iteration ?? done) ? 'Holdout' : `Rodada ${(liveRun?.iteration ?? done) + 1}`} — ao vivo
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

      {/* Classificacao Copeland da rodada mais recente que a tiver (duelos) */}
      {copelandRecord && (
        <>
          <div className="section-label">
            Classificação (duelos Copeland)
            <span className="section-label-note">
              {' · '}
              {isHoldoutIter(copelandRecord.iteration) ? 'holdout' : `rodada ${(copelandRecord.iteration ?? 0) + 1}`}
            </span>
          </div>
          <div style={{ marginBottom: 30 }}>
            <CopelandBoard record={copelandRecord} dark={dark} />
          </div>
        </>
      )}

      {/* Gates finais: holdout, significancia, convergencia antecipada */}
      <GateCards session={session} />

      {/* Evolução entre rodadas (colocação por rodada, campeã com troféu) */}
      {rounds.length > 0 && (
        <>
          <div className="section-label">Evolução por rodada (colocação — 🏆 = campeã que evoluiu)</div>
          <ProgressionHeatmap rounds={rounds} dark={dark} holdoutAt={holdoutAt} />
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
            sessionId={session.id}
            holdoutAt={holdoutAt}
          />
        </>
      )}

      {/* Pacote JSON de cenarios+gabaritos (seed importavel em runs futuras) */}
      {anyFinished && (
        <>
          <div className="section-label">Exportar cenários (pacote JSON)</div>
          <ScenarioPackExport session={session} />
        </>
      )}

      {/* Lista compacta de rodadas para drill-down */}
      <div className="section-label">Rodadas</div>
      <div className="rounds-list">
        {session.bestPromptByIteration.length === 0 && !liveRun && (
          <div className="card" style={{ color: 'var(--text-3)' }}>Iniciando…</div>
        )}
        {holdoutRound && (
          <div className="iteration-row" key="holdout">
            <div className="iteration-head">
              <div className="iteration-title">
                Holdout
                <span className="pill pill-training">gate final</span>
                <span className="iteration-meta">controle (base) vs campeão final</span>
              </div>
              <div className="iteration-links">
                <Link to={`/runs/${holdoutRound.id}`}>abrir run →</Link>
              </div>
            </div>
          </div>
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
