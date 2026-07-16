import type { RunRecord } from './types.js';

// ---------------------------------------------------------------------------
// Quadro de medalhas OLIMPICO de uma run de treino.
//
// A metrica do treino NAO e por pontos: cada etapa/cenario julgado e uma
// "prova" e a variante ganha uma medalha conforme a POSICAO no consenso dos
// juizes (0 = ouro, 1 = prata, 2 = bronze, ...). A colocacao da rodada sai do
// quadro de medalhas ordenado no estilo olimpico: mais OUROS -> mais PRATAS ->
// mais BRONZES -> demais colocacoes (tira-teima). Como fallback deterministico
// (vetores de medalha 100% iguais) usamos a qualidade ternaria e o comprimento
// do prompt (regularizacao anti-overfitting), evitando empate tecnico.
//
// Fonte unica: importado tanto pela engine (trainer.pickWinner) quanto pela UI
// (runShared.medalStandings). Espelho de `web/src/engine/medals.ts`.
// ---------------------------------------------------------------------------

/** Ordinal do veredito ternario: nao < parcial < resolve. */
export const VERDICT_ORDINAL: Record<string, number> = { nao: 0, parcial: 1, resolve: 2 };

/** Qualidade ternaria de UM contestant numa etapa (resolve=2, parcial=1, nao=0). */
export function stageQuality(judge: RunRecord['stages'][number]['judge'], cid: string): number {
  const v = judge?.verdictByContestant?.[cid];
  if (v) return VERDICT_ORDINAL[v] ?? 0;
  // compat record antigo (so binario): aceitavel ~ resolve.
  return judge?.acceptableByContestant?.[cid] ? 2 : 0;
}

export interface MedalRow {
  contestantId: string;
  /** Histograma de posicoes: medals[0]=ouro, [1]=prata, [2]=bronze, [k]=(k+1)o lugar. */
  medals: number[];
  golds: number;
  silvers: number;
  bronzes: number;
  /** Numero de etapas em que a variante foi ranqueada (participou da "prova"). */
  ranked: number;
  /** Soma ternaria (resolve=2/parcial=1/nao=0) — tira-teima do quadro. */
  quality: number;
  /** Comprimento do system prompt — tira-teima final (prefere prompts enxutos). */
  promptLen: number;
}

/**
 * Compara dois vetores de medalha no estilo quadro olimpico: lexicografico
 * DECRESCENTE (mais ouros primeiro; empate -> mais pratas; -> mais bronzes; ...).
 * Retorna < 0 se `a` fica na frente de `b`.
 */
export function compareMedalVectors(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Quadro de medalhas de uma run, ordenado (1o = campea da rodada). Etapas sem
 * juiz/inconclusivas nao contam; posicoes vem do consenso `rankedContestantIds`.
 */
export function computeMedals(record: RunRecord): MedalRow[] {
  const contestants = record.contestants ?? [];
  const rows: MedalRow[] = contestants.map((c) => {
    const medals: number[] = [];
    let quality = 0;
    let ranked = 0;
    for (const s of record.stages) {
      if (!s || !s.judge || s.judge.inconclusive) continue;
      const pos = (s.judge.rankedContestantIds ?? []).indexOf(c.id);
      if (pos >= 0) {
        medals[pos] = (medals[pos] ?? 0) + 1;
        ranked++;
      }
      quality += stageQuality(s.judge, c.id);
    }
    // Densifica o histograma (preenche buracos com 0) para exibicao/comparacao.
    for (let i = 0; i < medals.length; i++) if (medals[i] === undefined) medals[i] = 0;
    return {
      contestantId: c.id,
      medals,
      golds: medals[0] ?? 0,
      silvers: medals[1] ?? 0,
      bronzes: medals[2] ?? 0,
      ranked,
      quality,
      promptLen: (c.systemPrompt ?? '').length,
    };
  });
  return rows.sort((a, b) => {
    const m = compareMedalVectors(a.medals, b.medals);
    if (m !== 0) return m;
    if (b.quality !== a.quality) return b.quality - a.quality;
    if (a.promptLen !== b.promptLen) return a.promptLen - b.promptLen;
    return a.contestantId.localeCompare(b.contestantId);
  });
}
