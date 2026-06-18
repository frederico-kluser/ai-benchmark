import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import type { CompetitorResponse, JudgeResult, StageSpec } from './types.js';

const judgeSchema = z.object({
  ranking: z.array(z.string().min(1)).min(1),
});

const SYSTEM_PROMPT = `Voce e um juiz imparcial avaliando respostas de modelos de IA.
Voce recebe a pergunta original, o contexto de produto que cada modelo recebeu, e uma lista de respostas anonimizadas (rotuladas com letras A, B, C, ...).

Sua tarefa: ranquear as respostas da MELHOR para a PIOR, considerando aderencia ao contexto, corretude, completude e clareza.
NAO prefira respostas mais longas: avalie pelo conteudo e pela utilidade, nunca pelo tamanho.

Saida ESTRITAMENTE JSON: {"ranking": ["A", "C", "B", ...]} contendo TODAS as letras recebidas, sem empates, sem comentarios. Sem markdown.`;

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
  /** 2 = avalia em duas ordens embaralhadas e faz a media (anti-vies de posicao). */
  passes?: 1 | 2;
}

interface JudgePass {
  rankedContestantIds: string[];
  blindMap: Record<string, string>;
  rawJudgeText: string;
}

/** Uma passada de julgamento sobre >= 2 respostas validas (embaralhamento proprio). */
async function judgeOnce(
  apiKey: string,
  stage: StageSpec,
  okResponses: CompetitorResponse[],
  judgeModelId: string,
  timeoutMs: number,
): Promise<JudgePass> {
  const shuffled = shuffle(okResponses);
  const blindMap: Record<string, string> = {};
  const blocks: string[] = [];
  shuffled.forEach((r, i) => {
    const letter = letterFor(i);
    blindMap[letter] = r.contestantId;
    blocks.push(`### Resposta ${letter}\n${r.text}`);
  });

  const userPrompt = `PERGUNTA DO USUARIO:
${stage.question}

CONTEXTO DE PRODUTO FORNECIDO AOS MODELOS:
${stage.productContext}

RESPOSTAS A SEREM RANQUEADAS:
${blocks.join('\n\n')}

Devolva apenas: {"ranking": ${JSON.stringify(Object.keys(blindMap))} ordenado da melhor para a pior}.`;

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(result.text));
  } catch (err) {
    throw new Error(
      `Judge retornou JSON invalido: ${(err as Error).message}. Texto: ${result.text.slice(0, 300)}`,
    );
  }

  const validated = judgeSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Judge schema invalido: ${validated.error.message}`);
  }

  const letters = validated.data.ranking
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l in blindMap);
  for (const l of Object.keys(blindMap)) {
    if (!letters.includes(l)) letters.push(l);
  }

  return {
    rankedContestantIds: letters.map((l) => blindMap[l]),
    blindMap,
    rawJudgeText: result.text,
  };
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
      rawJudgeText: '(only 1 valid response, auto-ranked)',
    };
  }

  const first = await judgeOnce(apiKey, stage, okResponses, judgeModelId, timeoutMs);
  if (passes === 1) {
    return { rankedContestantIds: first.rankedContestantIds, blindMap: first.blindMap, rawJudgeText: first.rawJudgeText };
  }

  // 2a passada com novo embaralhamento; combina por posicao media.
  const second = await judgeOnce(apiKey, stage, okResponses, judgeModelId, timeoutMs);
  const ids = okResponses.map((r) => r.contestantId);
  const rankIn = (ranking: string[], id: string) => {
    const i = ranking.indexOf(id);
    return i < 0 ? ranking.length : i;
  };
  const avg = (id: string) =>
    (rankIn(first.rankedContestantIds, id) + rankIn(second.rankedContestantIds, id)) / 2;
  const merged = [...ids].sort(
    (a, b) =>
      avg(a) - avg(b) ||
      rankIn(first.rankedContestantIds, a) - rankIn(first.rankedContestantIds, b),
  );

  return {
    rankedContestantIds: merged,
    blindMap: first.blindMap, // letras da 1a passada (exibicao "(era X)")
    rawJudgeText: `# passada 1\n${first.rawJudgeText}\n\n# passada 2\n${second.rawJudgeText}`,
  };
}
