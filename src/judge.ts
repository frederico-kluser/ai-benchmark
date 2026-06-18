import { chatCompletion } from './openrouter.js';
import type { CompetitorResponse, JudgeResult, StageSpec } from './types.js';

// Juiz por TORNEIO round-robin: em vez de ranquear todas as respostas de uma vez
// (listwise), rodamos UMA instancia do juiz por CONFRONTO (par de respostas). Cada
// instancia devolve apenas o vencedor (output minimo). As vitorias sao agregadas
// (placar de Copeland) e viram o ranking final. Confrontos pairwise sao mais
// confiaveis que o listwise quando as respostas sao parecidas (caso do modo variacao).

const SYSTEM_PROMPT_PAIR = `Voce e um juiz imparcial. Recebe a pergunta do usuario, o contexto fornecido aos modelos, e DUAS respostas anonimizadas: A e B.
Escolha a MELHOR considerando aderencia ao contexto, corretude, completude e clareza.
NAO prefira respostas mais longas: avalie pelo conteudo e pela utilidade, nunca pelo tamanho.
Responda APENAS com a letra A ou B. Sem explicacao, sem pontuacao, sem markdown.`;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function letterFor(index: number): string {
  return String.fromCharCode(65 + index);
}

function parseAB(text: string): 'A' | 'B' | null {
  const t = (text ?? '').trim().toUpperCase();
  if (t.startsWith('A')) return 'A';
  if (t.startsWith('B')) return 'B';
  const m = t.match(/[AB]/);
  return m ? (m[0] as 'A' | 'B') : null;
}

/** Roda `fn` sobre `items` com no maximo `limit` em paralelo. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface MatchResult {
  a: string; // contestantId
  b: string; // contestantId
  winner: string | null; // contestantId vencedor, ou null (empate/inconclusivo)
}

/**
 * Agregacao PURA dos confrontos em um ranking (placar de Copeland: nº de vitorias).
 * Empate em vitorias -> desempate por confronto direto (head-to-head) -> ordem estavel.
 */
export function rankFromMatchups(ids: string[], matches: MatchResult[]): string[] {
  const wins: Record<string, number> = {};
  const h2h: Record<string, Record<string, number>> = {};
  for (const id of ids) {
    wins[id] = 0;
    h2h[id] = {};
  }
  for (const m of matches) {
    if (m.winner === m.a) {
      wins[m.a] = (wins[m.a] ?? 0) + 1;
      h2h[m.a][m.b] = (h2h[m.a][m.b] ?? 0) + 1;
    } else if (m.winner === m.b) {
      wins[m.b] = (wins[m.b] ?? 0) + 1;
      h2h[m.b][m.a] = (h2h[m.b][m.a] ?? 0) + 1;
    }
  }
  return [...ids].sort((x, y) => {
    if (wins[y] !== wins[x]) return wins[y] - wins[x];
    const xy = h2h[x]?.[y] ?? 0;
    const yx = h2h[y]?.[x] ?? 0;
    if (xy !== yx) return yx - xy; // quem venceu o confronto direto vem antes
    return ids.indexOf(x) - ids.indexOf(y);
  });
}

export interface JudgeStageParams {
  apiKey: string;
  stage: StageSpec;
  responses: CompetitorResponse[];
  judgeModelId: string;
  timeoutMs?: number;
  /** Passes por confronto: 2 = avalia nas duas ordens; so conta vitoria se consistente (anti-vies de posicao). */
  passes?: 1 | 2;
  /** Confrontos simultaneos. */
  concurrency?: number;
}

async function judgeOneOrder(
  apiKey: string,
  stage: StageSpec,
  first: CompetitorResponse,
  second: CompetitorResponse,
  judgeModelId: string,
  timeoutMs: number,
): Promise<'first' | 'second' | null> {
  const userPrompt = `PERGUNTA DO USUARIO:
${stage.question}

CONTEXTO FORNECIDO AOS MODELOS:
${stage.productContext}

### Resposta A
${first.text}

### Resposta B
${second.text}

Qual resposta e melhor? Responda APENAS com A ou B.`;

  const result = await chatCompletion({
    apiKey,
    modelId: judgeModelId,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_PAIR },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    maxTokens: 8,
    timeoutMs,
  });
  const ab = parseAB(result.text);
  return ab === 'A' ? 'first' : ab === 'B' ? 'second' : null;
}

/** Um confronto entre dois contestants -> contestantId vencedor (ou null). */
async function judgePair(
  apiKey: string,
  stage: StageSpec,
  ra: CompetitorResponse,
  rb: CompetitorResponse,
  judgeModelId: string,
  timeoutMs: number,
  passes: 1 | 2,
): Promise<string | null> {
  // randomiza qual resposta aparece como "A" (reduz vies de posicao)
  const flip = Math.random() < 0.5;
  const first = flip ? rb : ra;
  const second = flip ? ra : rb;

  const o1 = await judgeOneOrder(apiKey, stage, first, second, judgeModelId, timeoutMs);
  const winner1 = o1 === 'first' ? first.contestantId : o1 === 'second' ? second.contestantId : null;
  if (passes !== 2) return winner1;

  // 2a ordem (invertida): so conta vitoria se as duas ordens concordarem
  const o2 = await judgeOneOrder(apiKey, stage, second, first, judgeModelId, timeoutMs);
  const winner2 = o2 === 'first' ? second.contestantId : o2 === 'second' ? first.contestantId : null;
  return winner1 && winner2 && winner1 === winner2 ? winner1 : null;
}

export async function judgeStage(params: JudgeStageParams): Promise<JudgeResult> {
  const { apiKey, stage, responses, judgeModelId, timeoutMs = 90_000 } = params;
  const passes = params.passes === 2 ? 2 : 1;
  const concurrency = Math.max(1, params.concurrency ?? 6);

  const okResponses = responses.filter((r) => r.status === 'ok' && r.text.trim().length > 0);

  if (okResponses.length === 0) {
    return { rankedContestantIds: [], blindMap: {}, rawJudgeText: '', inconclusive: true };
  }
  if (okResponses.length === 1) {
    const only = okResponses[0];
    return {
      rankedContestantIds: [only.contestantId],
      blindMap: { A: only.contestantId },
      rawJudgeText: '(1 resposta valida, auto-vencedora)',
    };
  }

  // blindMap cosmetico (letras estaveis para a UI exibir "(era X)")
  const blindMap: Record<string, string> = {};
  shuffle(okResponses).forEach((r, i) => {
    blindMap[letterFor(i)] = r.contestantId;
  });

  // todos os confrontos (round-robin)
  const pairs: [CompetitorResponse, CompetitorResponse][] = [];
  for (let i = 0; i < okResponses.length; i++) {
    for (let j = i + 1; j < okResponses.length; j++) {
      pairs.push([okResponses[i], okResponses[j]]);
    }
  }

  const winners = await mapLimit(pairs, concurrency, ([ra, rb]) =>
    judgePair(apiKey, stage, ra, rb, judgeModelId, timeoutMs, passes),
  );
  const matches: MatchResult[] = pairs.map(([ra, rb], k) => ({
    a: ra.contestantId,
    b: rb.contestantId,
    winner: winners[k],
  }));

  const ids = okResponses.map((r) => r.contestantId);
  const rankedContestantIds = rankFromMatchups(ids, matches);

  const winCount: Record<string, number> = {};
  for (const id of ids) winCount[id] = 0;
  for (const m of matches) if (m.winner) winCount[m.winner] = (winCount[m.winner] ?? 0) + 1;
  const rawJudgeText =
    `Torneio round-robin: ${pairs.length} confronto(s), ${passes} passe(s)/confronto. ` +
    `Vitorias: ${rankedContestantIds.map((id) => `${id}=${winCount[id] ?? 0}`).join(', ')}`;

  return { rankedContestantIds, blindMap, rawJudgeText };
}
