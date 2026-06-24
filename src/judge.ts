import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import type {
  CompetitorResponse,
  JudgeResult,
  JudgeVerdict,
  SingleJudgeResult,
  StageSpec,
} from './types.js';

// Juiz LISTWISE e COMPACTO: uma unica chamada por juiz devolve (a) o RANKING de
// TODAS as respostas e (b) por resposta, ACEITAVEL (sim/nao) + um MOTIVO de <= 1
// frase. Sem texto verboso. Suporta MULTIPLOS juizes (rodam em paralelo, gateados
// pelo limitador global) — agregamos um CONSENSO de ranking (posicao media) e a
// aceitabilidade por MAIORIA. Cada juiz pode rodar 1 ou 2 passagens (shuffles
// diferentes) para reduzir vies de posicao; a aceitabilidade vem da 1a passagem
// (independe da ordem). O prompt e neutro (anti-vies de tamanho e de posicao).

const SYSTEM_PROMPT = `Voce e um juiz imparcial de respostas de IA. Recebe a pergunta do usuario, o CONTEXTO fornecido aos modelos e VARIAS respostas anonimizadas (rotuladas A, B, C, ...).

Quando um CRITERIO DE CORRETUDE (rubrica) for fornecido para a etapa, ele e a REFERENCIA PRINCIPAL do que e uma resposta correta: priorize-o acima do seu proprio palpite. Uma resposta que satisfaz a rubrica e aceitavel; uma que a viola (ou ignora um item exigido) NAO e, por mais bem escrita que seja.

Faca DUAS coisas:
1) "ranking": ordene TODAS as respostas da MELHOR para a PIOR, considerando, em ordem de importancia: (a) aderencia ao CRITERIO DE CORRETUDE (rubrica) da etapa, quando fornecido; (b) corretude factual e ausencia de alucinacao; (c) aderencia ao contexto/politicas fornecidos; (d) completude; (e) seguranca; (f) clareza.
2) "verdicts": para CADA resposta, diga se e ACEITAVEL para uso real ("acceptable": true/false) com um "motivo" de NO MAXIMO 1 frase curta.
   - acceptable=true: da pra usar sem causar erro/dano e satisfaz a rubrica (quando houver), MESMO que nao seja a melhor.
   - acceptable=false: erro factual, viola o contexto/politica/rubrica, inseguro, ou incompleto a ponto de nao servir.

Regras de justica (siga estritamente):
- NAO premie respostas mais longas: avalie conteudo e utilidade, NUNCA o tamanho.
- A ordem em que aparecem (A, B, C...) e ALEATORIA e NAO deve influenciar.
- Cada rotulo aparece EXATAMENTE UMA vez no ranking; inclua TODOS os rotulos.
- "motivo" curtissimo (1 frase no maximo).

Saida ESTRITAMENTE em JSON valido, sem markdown e sem comentarios:
{"ranking":["<melhor>","...","<pior>"],"verdicts":[{"label":"<letra>","acceptable":true,"motivo":"<= 1 frase"}, ... TODOS os rotulos]}`;

const judgeSchema = z.object({
  ranking: z.array(z.string().min(1)).min(1),
  verdicts: z
    .array(
      z.object({
        label: z.string().min(1),
        acceptable: z.boolean(),
        motivo: z.string().optional().default(''),
      }),
    )
    .optional()
    .default([]),
});

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
  /** Um ou mais juizes — rodam EM PARALELO (sem cap local; limitador global gateia). */
  judgeModelIds: string[];
  timeoutMs?: number;
  /** Passagens listwise POR JUIZ: 2 = duas ordens agregadas (anti-vies de posicao). Default 1. */
  passes?: 1 | 2;
}

interface PassResult {
  /** contestantIds da melhor para a pior. */
  order: string[];
  /** veredito (aceitavel + motivo) por contestantId. */
  verdicts: JudgeVerdict[];
  /** letra -> contestantId desta passagem (cosmetico p/ a UI "(era X)"). */
  blindMap: Record<string, string>;
}

/** Uma passagem de UM juiz: embaralha, pede ranking + vereditos, devolve por contestantId. */
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

  const labels = Object.keys(blindMap);
  const rubricBlock =
    stage.rubric && stage.rubric.trim()
      ? `\nCRITERIO DE CORRETUDE DESTA ETAPA (rubrica — use como referencia principal do que e correto):\n${stage.rubric.trim()}\n`
      : '';
  const userPrompt = `PERGUNTA DO USUARIO:
${stage.question}

CONTEXTO FORNECIDO AOS MODELOS:
${stage.productContext}
${rubricBlock}
RESPOSTAS A AVALIAR:
${blocks.join('\n\n')}

Em "ranking", ordene TODOS estes rotulos da melhor para a pior: ${JSON.stringify(labels)}.
Em "verdicts", de para CADA rotulo: "acceptable" (bool) e "motivo" (<= 1 frase).`;

  let parsedRanking: string[];
  let parsedVerdicts: { label: string; acceptable: boolean; motivo: string }[] = [];
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
    const parsed = judgeSchema.safeParse(JSON.parse(extractJson(result.text)));
    if (parsed.success) {
      parsedRanking = parsed.data.ranking.map((l) => l.trim().toUpperCase());
      parsedVerdicts = parsed.data.verdicts.map((v) => ({
        label: v.label.trim().toUpperCase(),
        acceptable: v.acceptable,
        motivo: v.motivo ?? '',
      }));
    } else {
      // fallback: extrai letras validas na ordem em que aparecem no texto cru
      parsedRanking = (result.text.toUpperCase().match(/[A-Z]/g) ?? []).filter(
        (l) => l in letterToContestant,
      );
    }
  } catch {
    return null;
  }

  // ranking: letras -> contestantIds, sem duplicar; anexa faltantes ao fim (ordem do shuffle).
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

  // verdicts por contestantId; default "aceitavel" p/ quem o juiz nao classificou.
  const verdictByCid: Record<string, JudgeVerdict> = {};
  for (const v of parsedVerdicts) {
    const cid = letterToContestant[v.label];
    if (cid && !(cid in verdictByCid)) {
      verdictByCid[cid] = { contestantId: cid, acceptable: v.acceptable, motivo: v.motivo };
    }
  }
  const verdicts: JudgeVerdict[] = okResponses.map(
    (r) =>
      verdictByCid[r.contestantId] ?? {
        contestantId: r.contestantId,
        acceptable: true,
        motivo: '',
      },
  );

  return { order, verdicts, blindMap };
}

/** Agrega varias ordenacoes por POSICAO MEDIA (menor = melhor). Empate -> 1a ordenacao. */
function aggregate(ids: string[], orders: string[][]): string[] {
  const n = ids.length;
  const firstOrder = orders[0] ?? [];
  const tiebreak = (id: string) => {
    const i = firstOrder.indexOf(id);
    return i < 0 ? n : i;
  };
  const avgPos: Record<string, number> = {};
  for (const id of ids) {
    let sum = 0;
    for (const o of orders) {
      const idx = o.indexOf(id);
      sum += idx < 0 ? n : idx; // ausente conta como pior
    }
    avgPos[id] = sum / orders.length;
  }
  return [...ids].sort((a, b) => {
    if (avgPos[a] !== avgPos[b]) return avgPos[a] - avgPos[b];
    return tiebreak(a) - tiebreak(b);
  });
}

/**
 * UM juiz: roda `passes` passagens EM PARALELO (anti-vies de posicao) e agrega o
 * ranking por posicao media; os vereditos vem da 1a passagem valida (a
 * aceitabilidade independe da ordem). Devolve null se nenhuma passagem produzir
 * ranking valido.
 */
async function runOneJudge(
  apiKey: string,
  stage: StageSpec,
  okResponses: CompetitorResponse[],
  judgeModelId: string,
  passes: number,
  timeoutMs: number,
): Promise<SingleJudgeResult | null> {
  const passResults = await Promise.all(
    Array.from({ length: passes }, () =>
      rankOnePass(apiKey, stage, okResponses, judgeModelId, timeoutMs),
    ),
  );
  const valid = passResults.filter((p): p is PassResult => p !== null);
  if (valid.length === 0) return null;

  const ids = okResponses.map((r) => r.contestantId);
  const rankedContestantIds = aggregate(
    ids,
    valid.map((p) => p.order),
  );
  return {
    judgeModelId,
    rankedContestantIds,
    verdicts: valid[0].verdicts,
    blindMap: valid[0].blindMap,
  };
}

export async function judgeStage(params: JudgeStageParams): Promise<JudgeResult> {
  const { apiKey, stage, responses, judgeModelIds, timeoutMs = 90_000 } = params;
  const passes = params.passes === 2 ? 2 : 1;
  // dedup: um mesmo juiz duas vezes distorceria a maioria e o placar aditivo.
  const judgeIds = [...new Set(judgeModelIds ?? [])];

  const okResponses = responses.filter((r) => r.status === 'ok' && r.text.trim().length > 0);
  // respostas com erro/vazias sao automaticamente NAO aceitaveis (sem gastar LLM).
  const failedIds = responses
    .filter((r) => !(r.status === 'ok' && r.text.trim().length > 0))
    .map((r) => r.contestantId);
  const autoFalse = (): Record<string, boolean> => {
    const acc: Record<string, boolean> = {};
    for (const id of failedIds) acc[id] = false;
    return acc;
  };

  if (okResponses.length === 0 || judgeIds.length === 0) {
    return {
      rankedContestantIds: [],
      acceptableByContestant: autoFalse(),
      judges: [],
      blindMap: {},
      rawJudgeText: judgeIds.length === 0 ? 'Nenhum juiz configurado.' : '',
      inconclusive: true,
    };
  }

  // Roda TODOS os juizes EM PARALELO — SEM cap local; o limitador global throttla.
  const results = await Promise.all(
    judgeIds.map((jid) => runOneJudge(apiKey, stage, okResponses, jid, passes, timeoutMs)),
  );
  const judges = results.filter((j): j is SingleJudgeResult => j !== null);

  if (judges.length === 0) {
    return {
      rankedContestantIds: [],
      acceptableByContestant: autoFalse(),
      judges: [],
      blindMap: {},
      rawJudgeText: 'Nenhum juiz retornou ranking valido.',
      inconclusive: true,
    };
  }

  const ids = okResponses.map((r) => r.contestantId);
  // Consenso de ranking: posicao media entre os juizes.
  const rankedContestantIds = aggregate(
    ids,
    judges.map((j) => j.rankedContestantIds),
  );

  // Aceitavel = MAIORIA dos juizes (>= metade; empate conta como aceitavel).
  const acceptableByContestant: Record<string, boolean> = {};
  for (const id of ids) {
    let yes = 0;
    let total = 0;
    for (const j of judges) {
      const v = j.verdicts.find((x) => x.contestantId === id);
      if (v) {
        total++;
        if (v.acceptable) yes++;
      }
    }
    acceptableByContestant[id] = total > 0 && yes * 2 >= total;
  }
  for (const id of failedIds) acceptableByContestant[id] = false;

  const rawJudgeText =
    `${judges.length} juiz(es)${passes === 2 ? ' x2 passagens' : ''}. ` +
    `Consenso (melhor->pior): ${rankedContestantIds.join(' > ')}`;

  return {
    rankedContestantIds,
    acceptableByContestant,
    judges,
    blindMap: judges[0].blindMap,
    rawJudgeText,
  };
}
