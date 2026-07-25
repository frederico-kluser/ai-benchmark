// Deduplicacao de cenarios portada do prompt-arena (server/studio/embedDedup.mjs),
// sem a camada de embeddings (o original a tinha OFF por default): 1a passe exata
// pelo prompt normalizado (barata, O(n)) + ROUGE-L (F1 do LCS de tokens) com
// clustering guloso. Sem rede — roda igual no backend e no navegador.

/** Normaliza um prompt para comparacao: lowercase, troca tudo que nao e
 * letra/numero/espaco por espaco, colapsa espacos, trim. */
export function normPrompt(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normPrompt(s).split(' ').filter(Boolean);
}

/** Comprimento da maior subsequencia comum (LCS) entre dois arrays de tokens —
 * programacao dinamica otimizada em espaco (duas linhas de DP). */
function lcsLen(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** ROUGE-L F1 em [0,1] entre dois textos (normalizados e tokenizados por espaco).
 * Strings vazias (apos normalizacao) → 0. */
export function rougeL(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const l = lcsLen(ta, tb);
  const prec = l / tb.length;
  const rec = l / ta.length;
  return prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
}

export interface DedupeResult<T> {
  kept: T[];
  dropped: T[];
  /** 'none' = nada dropado; 'exact' = so a passe exata dropou; 'rouge-l' = a rouge dropou. */
  method: 'none' | 'exact' | 'rouge-l';
}

function rubricOf(item: { question: string }): string {
  const r = (item as { rubric?: unknown }).rubric;
  return typeof r === 'string' ? r : '';
}

/** Regra de keep do cluster: prefere quem tem rubric nao-vazia (sinal de treino
 * mais rico); desempata pela question mais longa. */
function isBetterKeep<T extends { question: string }>(candidate: T, current: T): boolean {
  const candRubric = rubricOf(candidate).trim().length > 0;
  const curRubric = rubricOf(current).trim().length > 0;
  if (candRubric !== curRubric) return candRubric;
  return candidate.question.length > current.question.length;
}

/**
 * Deduplica uma lista de cenarios ({ question }): 1a passe exata por
 * `normPrompt(question)`; depois clustering guloso — cada item e comparado por
 * ROUGE-L ao representante de cada cluster; >= threshold entra no cluster (e
 * pode virar o representante/keep), senao vira cluster novo.
 */
export function dedupeAdvanced<T extends { question: string }>(
  list: T[],
  opts?: { rougeThreshold?: number },
): DedupeResult<T> {
  const threshold = opts?.rougeThreshold ?? 0.7;
  const items = list.filter(Boolean);
  if (items.length <= 1) return { kept: items, dropped: [], method: 'none' };

  // 1a passe: duplicatas exatas pelo prompt normalizado.
  const seen = new Set<string>();
  const unique: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    const key = normPrompt(item.question);
    if (seen.has(key)) {
      dropped.push(item);
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  // 2a passe: clustering guloso por ROUGE-L contra o representante do cluster.
  const clusters: { rep: T; members: T[] }[] = [];
  for (const item of unique) {
    let placed: { rep: T; members: T[] } | undefined;
    for (const c of clusters) {
      if (rougeL(item.question, c.rep.question) >= threshold) {
        placed = c;
        break;
      }
    }
    if (placed) {
      placed.members.push(item);
      if (isBetterKeep(item, placed.rep)) placed.rep = item;
    } else {
      clusters.push({ rep: item, members: [item] });
    }
  }

  const kept = clusters.map((c) => c.rep);
  const keepSet = new Set<T>(kept);
  for (const item of unique) {
    if (!keepSet.has(item)) dropped.push(item);
  }

  const method = dropped.length === 0 ? 'none' : kept.length === unique.length ? 'exact' : 'rouge-l';
  return { kept, dropped, method };
}
