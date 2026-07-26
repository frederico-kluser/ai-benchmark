// Utilitarios de visualizacao de run compartilhados entre RunView (por run) e
// TrainingView (cockpit de treino). A UNICA visualizacao de progresso/resultado
// e o heatmap (cenario x variante); o bloco de finais so aparece no fim.
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import type { RunRecord, StageRecord, Verdict } from '../api';
import { normalizeContestants } from '../api';
import { useTheme } from '../theme';

// Veredito ternario -> rotulo + classe CSS (ok/partial/bad).
export const VERDICT_META: Record<Verdict, { label: string; cls: string }> = {
  resolve: { label: 'resolve', cls: 'ok' },
  parcial: { label: 'parcial', cls: 'partial' },
  nao: { label: 'não resolve', cls: 'bad' },
};

/** Glifo de cada veredito no heatmap (pendente = ponto). */
const VERDICT_GLYPH: Record<Verdict, string> = {
  resolve: '✓',
  parcial: '◐',
  nao: '✕',
};

/** Veredito de um item, com retrocompat ao binario antigo (acceptable). */
export function verdictOf(v?: { verdict?: Verdict; acceptable?: boolean }): Verdict | undefined {
  if (!v) return undefined;
  if (v.verdict) return v.verdict;
  if (typeof v.acceptable === 'boolean') return v.acceptable ? 'resolve' : 'nao';
  return undefined;
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Etapas sem buracos (array pode ficar esparso/fora de ordem sob execucao
// paralela) e ordenadas por index. Toda a UI de resultados usa isto — sem o
// filtro, `stages.map(s => s.index)` quebra em buracos (foi o bug do heatmap).
export function denseStages(stages: StageRecord[]): StageRecord[] {
  return stages.filter((s): s is StageRecord => Boolean(s)).slice().sort((a, b) => a.index - b.index);
}

export interface RankColor {
  solid: string;
  soft: string;
  text: string;
}

// Verde (melhor) -> vermelho (pior), em HSL. `pos` é 1-based.
export function rankColor(pos: number, total: number, dark: boolean): RankColor {
  const tl = dark ? 72 : 34;
  const sa = dark ? 0.22 : 0.15;
  if (total <= 1 || pos < 1) {
    return { solid: 'hsl(145 60% 42%)', soft: `hsl(145 70% 50% / ${sa})`, text: `hsl(145 55% ${tl}%)` };
  }
  const frac = (pos - 1) / (total - 1);
  const hue = Math.round(145 - (145 - 6) * frac);
  return { solid: `hsl(${hue} 62% 44%)`, soft: `hsl(${hue} 75% 50% / ${sa})`, text: `hsl(${hue} 58% ${tl}%)` };
}

// ---------------------------------------------------------------------------
// Heatmap de vereditos: cenario x variante. E a unica visualizacao durante a
// execucao — nada de numero que sobe e desce, so glifos que se preenchem.
// ---------------------------------------------------------------------------

/** Uma linha do heatmap: uma variante/modelo e como ela foi em cada cenário. */
export interface HeatRow {
  contestantId: string;
  label: string;
  isControl: boolean;
  isFinalist: boolean;
  /** Veredito por índice de cenário (denso, alinhado com `stages`). */
  verdicts: (Verdict | undefined)[];
  resolve: number;
  parcial: number;
  nao: number;
  judged: number;
  /** (resolve + 0,5·parcial) / judged × 100. `null` enquanto nada foi julgado. */
  score: number | null;
}

/** Veredito de um contestant numa etapa (gabarito > juiz > avaliador antigo). */
function verdictInStage(stage: StageRecord, contestantId: string): Verdict | undefined {
  const ref = stage.referenceJudge?.verdictByContestant?.[contestantId];
  if (ref) return ref;
  const doJuiz = verdictOf({
    verdict: stage.judge?.verdictByContestant?.[contestantId],
    acceptable: stage.judge?.acceptableByContestant?.[contestantId],
  });
  if (doJuiz) return doJuiz;
  // Retrocompat: records antigos guardavam o binario no avaliador separado.
  return verdictOf(stage.evaluation?.verdicts.find((v) => v.contestantId === contestantId));
}

/** Deriva as linhas do heatmap. Ordem = ordem de `record.contestants` (ESTÁVEL). */
export function heatRows(record: RunRecord): { rows: HeatRow[]; stages: StageRecord[] } {
  const stages = denseStages(record.stages);
  const contestants = normalizeContestants(record);
  const finalistas = new Set(record.finalists ?? []);
  // Controle = ancora da run: o prompt original ou o 'carry' do treino. Sem
  // fallback para o 1o contestant — em compare ninguem e "base".
  const controlId = contestants.find((c) => c.isOriginal || c.id === 'carry')?.id;
  const rows = contestants.map((c) => {
    const verdicts = stages.map((s) => verdictInStage(s, c.id));
    let resolve = 0;
    let parcial = 0;
    let nao = 0;
    for (const v of verdicts) {
      if (v === 'resolve') resolve++;
      else if (v === 'parcial') parcial++;
      else if (v === 'nao') nao++;
    }
    const judged = resolve + parcial + nao;
    return {
      contestantId: c.id,
      label: c.label,
      isControl: c.id === controlId,
      isFinalist: finalistas.has(c.id),
      verdicts,
      resolve,
      parcial,
      nao,
      judged,
      score: judged ? ((resolve + 0.5 * parcial) / judged) * 100 : null,
    };
  });
  return { rows, stages };
}

interface ScoreHeatmapProps {
  record: RunRecord;
  /** Ordena por score desc (só use quando a run terminou). Default false. */
  ranked?: boolean;
  /** Clique numa célula/coluna abre o cenário correspondente (recebe o index da etapa). */
  onStageClick?: (index: number) => void;
}

/**
 * A ÚNICA visualização de progresso/resultado: linhas = variantes (ordem
 * estável), colunas = cenários, célula = ✓ (resolve) / ◐ (parcial) / ✕ (não) /
 * · (pendente). Coluna final = score 0–100 + contagem `n✓ n◐ n✕`.
 */
export function ScoreHeatmap({ record, ranked = false, onStageClick }: ScoreHeatmapProps) {
  const { rows, stages } = useMemo(() => heatRows(record), [record]);
  // Interatividade opcional: célula/coluna só vira "botão" (foco, teclado)
  // quando há onStageClick — sem handler, continua um div inerte.
  const clickProps = (index: number) =>
    onStageClick
      ? {
          role: 'button' as const,
          tabIndex: 0,
          onClick: () => onStageClick(index),
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onStageClick(index);
            }
          },
        }
      : {};
  // Ordenacao so quando pedida (fim da run): sort e estavel, entao empate
  // preserva a ordem de `contestants`.
  const linhas = useMemo(
    () => (ranked ? [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : rows),
    [rows, ranked],
  );

  if (!linhas.length || !stages.length) {
    return (
      <div className="hm">
        <div className="hm-legend">Aguardando os primeiros resultados…</div>
      </div>
    );
  }

  return (
    <div className="hm">
      <div className="hm-legend">✓ resolve · ◐ parcial · ✕ não resolve · · pendente</div>
      <div className="hm-scroll">
        <div className="hm-row hm-head">
          <div className="hm-name" />
          {stages.map((s, i) => (
            <div
              className={`hm-col${onStageClick ? ' hm-clickable' : ''}`}
              key={s.index}
              title={onStageClick ? `Cenário ${i + 1} — clique para abrir` : undefined}
              {...clickProps(s.index)}
            >
              {i + 1}
            </div>
          ))}
          <div className="hm-score-head" title="(resolve + ½·parcial) ÷ julgados × 100">score</div>
        </div>
        {linhas.map((row) => (
          <div className="hm-row" key={row.contestantId}>
            <div className="hm-name" title={row.label}>
              <span className="hm-name-text">{row.label}</span>
              {row.isControl && <span className="control-tag">base</span>}
              {row.isFinalist && <span className="finalist-tag">final</span>}
            </div>
            {stages.map((s, i) => {
              const v = row.verdicts[i];
              return (
                <div
                  className={`hm-cell ${v ? VERDICT_META[v].cls : 'none'}${onStageClick ? ' hm-clickable' : ''}`}
                  key={s.index}
                  title={`Cenário ${i + 1}: ${v ? VERDICT_META[v].label : 'pendente'}${onStageClick ? ' — clique para abrir' : ''}`}
                  {...clickProps(s.index)}
                >
                  {v ? VERDICT_GLYPH[v] : '·'}
                </div>
              );
            })}
            <div className="hm-score">
              {row.score === null ? '—' : row.score.toFixed(0)}
              <span className="hm-counts">{row.resolve}✓ {row.parcial}◐ {row.nao}✕</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finais: os N melhores por judge-score duelam entre si em todos os cenarios.
// Podio (Copeland) + confrontos agregados por par.
// ---------------------------------------------------------------------------

/** Linha do pódio: stats de duelo quando ja houve duelo, senao o judge-score. */
interface FinalsRow {
  id: string;
  label: string;
  points?: number;
  wins?: number;
  ties?: number;
  losses?: number;
  score?: number;
}

/** Confronto agregado de um par de finalistas em TODOS os cenários. */
interface PairSummary {
  key: string;
  labelA: string;
  labelB: string;
  winsA: number;
  winsB: number;
  total: number;
}

interface FinalsPanelProps {
  record: RunRecord;
  /** Progresso agregado dos duelos (evento `duel.progress`). */
  progress?: { done: number; total: number } | null;
}

/**
 * Bloco "Final": os N finalistas (top judge-score) e o resultado dos duelos
 * entre eles — pódio com pontos Copeland e V–E–D, e um accordion enxuto com os
 * confrontos.
 */
export function FinalsPanel({ record, progress }: FinalsPanelProps) {
  const theme = useTheme();
  const dark = theme === 'dark';
  const stagesComDuelos = useMemo(
    () => denseStages(record.stages).filter((s) => s.duels),
    [record],
  );
  const finalistIds = useMemo(() => record.finalists ?? [], [record]);

  const rows = useMemo<FinalsRow[]>(() => {
    const labelOf = (id: string) => record.contestants?.find((c) => c.id === id)?.label ?? id;
    const finalistas = new Set(finalistIds);
    const standings = (record.standings ?? []).filter((s) => !finalistas.size || finalistas.has(s.id));
    if (standings.length) {
      return standings.map((s) => ({
        id: s.id,
        label: s.label,
        points: s.points,
        wins: s.wins,
        ties: s.ties,
        losses: s.losses,
      }));
    }
    // Ainda sem Copeland (duelos rodando): pódio provisório por judge-score.
    return finalistIds.map((id) => ({
      id,
      label: labelOf(id),
      score: record.judgeScoreByContestant?.[id] ?? 0,
    }));
  }, [record, finalistIds]);

  const pares = useMemo<PairSummary[]>(() => {
    const labelOf = (id: string) => record.contestants?.find((c) => c.id === id)?.label ?? id;
    const acc = new Map<string, PairSummary>();
    for (const s of stagesComDuelos) {
      for (const d of s.duels!.duels) {
        // Chave por par NAO-ordenado: agrega os dois sentidos num confronto so.
        const [a, b] = d.a < d.b ? [d.a, d.b] : [d.b, d.a];
        const key = `${a}|${b}`;
        let p = acc.get(key);
        if (!p) {
          p = { key, labelA: labelOf(a), labelB: labelOf(b), winsA: 0, winsB: 0, total: 0 };
          acc.set(key, p);
        }
        p.total++;
        const vencedor = d.outcome === 'a' ? d.a : d.outcome === 'b' ? d.b : undefined;
        if (vencedor === a) p.winsA++;
        else if (vencedor === b) p.winsB++;
      }
    }
    return [...acc.values()];
  }, [record, stagesComDuelos]);

  if (!finalistIds.length && !stagesComDuelos.length) return null;

  return (
    <div className="finals">
      {progress && progress.done < progress.total && (
        <div className="finals-progress">Duelos {progress.done}/{progress.total}</div>
      )}
      {rows.map((r, i) => (
        <div className="finals-row" key={r.id}>
          <span className="place-badge" style={{ background: rankColor(i + 1, rows.length, dark).solid }}>
            {i + 1}º
          </span>
          <span className="finals-label" title={r.label}>{r.label}</span>
          {typeof r.points === 'number' ? (
            <>
              <span className="finals-stat">{r.points} pts</span>
              <span className="finals-stat">{r.wins}–{r.ties}–{r.losses}</span>
            </>
          ) : (
            <span className="finals-stat" title="judge-score">{(r.score ?? 0).toFixed(0)}</span>
          )}
        </div>
      ))}
      {pares.length > 0 && (
        <details className="finals-details">
          <summary>Confrontos</summary>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
            {pares.map((p) => (
              <div key={p.key}>
                {p.labelA} × {p.labelB} —{' '}
                {p.winsA === p.winsB
                  ? `empate (${p.winsA}–${p.winsB} de ${p.total})`
                  : `venceu ${p.winsA > p.winsB ? p.labelA : p.labelB} (${Math.max(p.winsA, p.winsB)} de ${p.total})`}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reducer client-side: dobra os eventos granulares (chegam FORA de ordem sob
// execucao paralela) sobre o RunRecord vivo. Usado por RunView e pela cockpit.
// ---------------------------------------------------------------------------

export function applyEvent(prev: RunRecord, event: any): RunRecord {
  const next: RunRecord = {
    ...prev,
    stages: prev.stages.map((s) => ({ ...s, responses: [...s.responses] })),
  };
  switch (event.type) {
    case 'run.started':
      return event.record;
    case 'variants.generated':
      return { ...next, contestants: event.contestants };
    case 'stage.generating': {
      // Coloca POR INDICE (nao push): sob execucao paralela os eventos chegam
      // fora de ordem; o push desalinhava o array (era o bug do heatmap/resumo).
      if (!next.stages[event.stageIndex]) {
        next.stages[event.stageIndex] = {
          index: event.stageIndex,
          responses: [],
          startedAt: new Date().toISOString(),
        };
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
      s.finishedAt = new Date().toISOString();
      return next;
    }
    case 'competitor.finished': {
      const s = next.stages[event.stageIndex];
      if (s) {
        const idx = s.responses.findIndex((r) => r.contestantId === event.response.contestantId);
        if (idx >= 0) s.responses[idx] = event.response;
        else s.responses.push(event.response);
        next.totalCostUsd = (next.totalCostUsd ?? 0) + event.response.costUsd;
      }
      return next;
    }
    case 'finals.started': {
      // Finalistas escolhidos (top-N por judge-score) — o heatmap marca "final".
      // Guarda TAMBEM os scores que vem no evento: `judgeScoreByContestant` so
      // chega no `run.finished`, entao sem isto o podio provisorio ficaria "0"
      // durante toda a fase de duelos (a mais longa da run).
      const finalists = event.finalists as { id: string; label: string; score: number }[];
      const scores = { ...(next.judgeScoreByContestant ?? {}) };
      for (const f of finalists) scores[f.id] = f.score;
      return { ...next, finalists: finalists.map((f) => f.id), judgeScoreByContestant: scores };
    }
    case 'stage.dueled': {
      // Duelos (Copeland) da etapa — rodam DEPOIS de todas as etapas, na fase
      // de finais. Por indice, como os demais handlers: sob execucao paralela
      // os eventos chegam fora de ordem e push desalinharia o array.
      const s = next.stages[event.stageIndex];
      if (s) s.duels = event.duels;
      return next;
    }
    case 'stage.gabarito':
    case 'duel.progress':
      // Progresso AGREGADO: `stage.gabarito` vem com stageIndex -1 (NUNCA
      // indexar `stages` com ele) e `duel.progress` nem stageIndex tem. O
      // record nao muda — as paginas guardam esse progresso em estado proprio.
      // Retorna `prev` (sem copia) p/ evitar re-render inutil.
      return prev;
    case 'stage.judged': {
      const s = next.stages[event.stageIndex];
      if (s) {
        s.judge = event.judge;
        s.finishedAt = new Date().toISOString();
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
