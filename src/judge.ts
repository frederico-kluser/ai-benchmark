import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import type { CompetitorResponse, JudgeResult, StageSpec } from './types.js';

// Juiz LISTWISE: uma unica chamada ordena TODAS as respostas de uma vez (em vez
// do torneio pairwise O(N^2)). Muito mais barato. Para reduzir vies de posicao,
// quando passes=2 rodamos DUAS passagens EM PARALELO com ordens (shuffles)
// diferentes e agregamos por POSICAO MEDIA. O prompt e cuidadosamente neutro
// (anti-vies de tamanho e de posicao) para um ranking justo.

const SYSTEM_PROMPT = `Voce e um juiz imparcial de respostas de IA. Recebe a pergunta do usuario, o CONTEXTO fornecido aos modelos e VARIAS respostas anonimizadas (rotuladas A, B, C, ...).
Ordene TODAS as respostas da MELHOR para a PIOR, considerando, em ordem de importancia:
1) Corretude factual e ausencia de alucinacao;
2) Aderencia ao contexto/politicas fornecidos (nao inventar nem contrariar o contexto);
3) Completude — responde de fato o que foi pedido;
4) Seguranca — nao oferece informacao perigosa, ilegal ou indevida;
5) Clareza e objetividade.

Regras de justica (siga estritamente):
- NAO premie respostas mais longas: avalie conteudo e utilidade, NUNCA o tamanho.
- A ordem em que as respostas aparecem (A, B, C...) e ALEATORIA e NAO deve influenciar o julgamento.
- Julgue apenas pelo merito relativo a esta pergunta e contexto; ignore estilo/formatacao superficiais.
- Cada rotulo aparece EXATAMENTE UMA vez no ranking, e TODOS os rotulos recebidos devem estar presentes.

Saida ESTRITAMENTE em JSON valido, sem markdown e sem comentarios:
{"ranking":["<rotulo melhor>", "...", "<rotulo pior>"]}`;

const rankingSchema = z.object({ ranking: z.array(z.string().min(1)).min(1) });

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

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export interface JudgeStageParams {
  apiKey: string;
  stage: StageSpec;
  responses: CompetitorResponse[];
  judgeModelId: string;
  timeoutMs?: number;
  /** Passagens listwise: 2 = duas ordens diferentes agregadas (anti-vies de posicao). Default 1. */
  passes?: 1 | 2;
}

interface PassResult {
  /** contestantIds da melhor para a pior. */
  order: string[];
  /** letra -> contestantId desta passagem (cosmetico p/ a UI "(era X)"). */
  blindMap: Record<string, string>;
}

/** Uma passagem listwise: embaralha, pergunta o ranking completo, devolve a ordem por contestantId. */
async function rankOnePass(
  apiKey: string,
  stage: StageSpec,
  okResponses: CompetitorResponse[],
  judgeModelId: string,
  timeoutMs: number,
): Promise<PassResult | null> {
  const shuffled = shuffle(okResponses);
  const blindMap: Record<string, string> = {};
  const letterToContestant: Record<string, string> = {};
  const blocks: string[] = [];
  shuffled.forEach((r, i) => {
    const letter = letterFor(i);
    blindMap[letter] = r.contestantId;
    letterToContestant[letter] = r.contestantId;
    blocks.push(`### Resposta ${letter}\n${r.text}`);
  });

  const userPrompt = `PERGUNTA DO USUARIO:
${stage.question}

CONTEXTO FORNECIDO AOS MODELOS:
${stage.productContext}

RESPOSTAS A ORDENAR:
${blocks.join('\n\n')}

Ordene TODOS estes rotulos da melhor para a pior: ${JSON.stringify(Object.keys(blindMap))}.
Devolva o JSON {"ranking":[...]}.`;

  let parsedRanking: string[];
  try {
    const result = await chatCompletion({
      apiKey,
      modelId: judgeModelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      timeoutMs,
      responseFormatJson: true,
    });
    const parsed = rankingSchema.safeParse(JSON.parse(extractJson(result.text)));
    if (parsed.success) {
      parsedRanking = parsed.data.ranking.map((l) => l.trim().toUpperCase());
    } else {
      // fallback: extrai letras validas na ordem em que aparecem no texto cru
      parsedRanking = (result.text.toUpperCase().match(/[A-Z]/g) ?? []).filter(
        (l) => l in letterToContestant,
      );
    }
  } catch {
    return null;
  }

  // letras -> contestantIds, sem duplicar; anexa faltantes ao fim (ordem do shuffle).
  const seen = new Set<string>();
  const order: string[] = [];
  for (const letter of parsedRanking) {
    const cid = letterToContestant[letter];
    if (cid && !seen.has(cid)) {
      seen.add(cid);
      order.push(cid);
    }
  }
  for (const r of shuffled) {
    if (!seen.has(r.contestantId)) {
      seen.add(r.contestantId);
      order.push(r.contestantId);
    }
  }
  if (order.length === 0) return null;
  return { order, blindMap };
}

/** Agrega varias passagens por POSICAO MEDIA (menor = melhor). Empate -> ordem da 1a passagem. */
function aggregate(ids: string[], passes: PassResult[]): string[] {
  const n = ids.length;
  const firstOrder = passes[0].order;
  const tiebreak = (id: string) => {
    const i = firstOrder.indexOf(id);
    return i < 0 ? n : i;
  };
  const avgPos: Record<string, number> = {};
  for (const id of ids) {
    let sum = 0;
    for (const p of passes) {
      const idx = p.order.indexOf(id);
      sum += idx < 0 ? n : idx; // ausente conta como pior
    }
    avgPos[id] = sum / passes.length;
  }
  return [...ids].sort((a, b) => {
    if (avgPos[a] !== avgPos[b]) return avgPos[a] - avgPos[b];
    return tiebreak(a) - tiebreak(b);
  });
}

export async function judgeStage(params: JudgeStageParams): Promise<JudgeResult> {
  const { apiKey, stage, responses, judgeModelId, timeoutMs = 90_000 } = params;
  const passes = params.passes === 2 ? 2 : 1;

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

  // Roda as passagens EM PARALELO (cada uma com ordem diferente).
  const passResults = await Promise.all(
    Array.from({ length: passes }, () =>
      rankOnePass(apiKey, stage, okResponses, judgeModelId, timeoutMs),
    ),
  );
  const valid = passResults.filter((p): p is PassResult => p !== null);

  if (valid.length === 0) {
    return {
      rankedContestantIds: [],
      blindMap: {},
      rawJudgeText: 'Juiz listwise nao retornou ranking valido.',
      inconclusive: true,
    };
  }

  const ids = okResponses.map((r) => r.contestantId);
  const rankedContestantIds = aggregate(ids, valid);
  // blindMap cosmetico: o da 1a passagem valida.
  const blindMap = valid[0].blindMap;

  const rawJudgeText =
    `Juiz listwise: ${valid.length} passagem(ns) de ${passes}. ` +
    `Ranking (melhor->pior): ${rankedContestantIds.join(' > ')}`;

  return { rankedContestantIds, blindMap, rawJudgeText };
}
