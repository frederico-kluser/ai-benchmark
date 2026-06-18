import { z } from 'zod';
import { chatCompletion } from './openrouter';
import type {
  CompetitorResponse,
  EvaluationVerdict,
  StageEvaluation,
  StageSpec,
} from './types';

const evalSchema = z.object({
  best: z.string().min(1),
  bestReasons: z.string().min(1),
  verdicts: z
    .array(
      z.object({
        label: z.string().min(1),
        acceptable: z.boolean(),
        justification: z.string().min(1),
      }),
    )
    .min(1),
});

const SYSTEM_PROMPT = `Voce e um avaliador de qualidade de respostas de IA para uso REAL em producao.
Recebe a pergunta do usuario, o contexto de produto fornecido aos modelos, e respostas anonimizadas (rotuladas A, B, C, ...).

Sua tarefa tem DUAS partes:
1) Escolher a MELHOR resposta e explicar objetivamente POR QUE ela venceu (motivos do vencedor): corretude, aderencia ao contexto/politicas, completude, seguranca e clareza.
2) Para CADA resposta, dar um veredito de ACEITABILIDADE para o trabalho:
   - "acceptable": true  -> da pra usar em producao sem causar erro ou dano, MESMO que nao seja a ideal/melhor (resolve a necessidade do usuario de forma correta e segura).
   - "acceptable": false -> NAO da pra usar: erro factual, viola o contexto/politica, informacao de seguranca incorreta, ou incompleta a ponto de nao servir.
   "Aceitavel" NAO significa "perfeita"; significa "utilizavel sem causar dano/erro". Seja criterioso e justifique em 1-2 frases.

Saida ESTRITAMENTE em JSON valido, sem markdown, sem comentarios:
{"best":"<letra>","bestReasons":"<por que venceu>","verdicts":[{"label":"<letra>","acceptable":<bool>,"justification":"<curto>"}, ... TODAS as letras recebidas]}`;

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

export interface EvaluateStageParams {
  apiKey: string;
  stage: StageSpec;
  responses: CompetitorResponse[];
  /** Reutiliza o mesmo modelo do juiz (papel de avaliacao). */
  evaluatorModelId: string;
  timeoutMs?: number;
}

export async function evaluateStage(params: EvaluateStageParams): Promise<StageEvaluation> {
  const { apiKey, stage, responses, evaluatorModelId, timeoutMs = 90_000 } = params;

  const okResponses = responses.filter((r) => r.status === 'ok' && r.text.trim().length > 0);
  // respostas com erro/vazias sao automaticamente NAO aceitaveis (sem gastar LLM)
  const failedVerdicts: EvaluationVerdict[] = responses
    .filter((r) => !(r.status === 'ok' && r.text.trim().length > 0))
    .map((r) => ({
      contestantId: r.contestantId,
      acceptable: false,
      justification: r.errorMsg
        ? `Resposta com erro: ${r.errorMsg}`
        : 'Sem resposta (vazia).',
    }));

  if (okResponses.length === 0) {
    return {
      bestContestantId: '',
      bestReasons: '',
      verdicts: failedVerdicts,
      blindMap: {},
      raw: '',
      inconclusive: true,
    };
  }

  const shuffled = shuffle(okResponses);
  const blindMap: Record<string, string> = {};
  const blocks: string[] = [];
  shuffled.forEach((r, idx) => {
    const letter = letterFor(idx);
    blindMap[letter] = r.contestantId;
    blocks.push(`### Resposta ${letter}\n${r.text}`);
  });

  const userPrompt = `PERGUNTA DO USUARIO:
${stage.question}

CONTEXTO DE PRODUTO FORNECIDO AOS MODELOS:
${stage.productContext}

RESPOSTAS A AVALIAR:
${blocks.join('\n\n')}

Devolva o JSON com "best", "bestReasons" e "verdicts" para TODAS as letras: ${JSON.stringify(
    Object.keys(blindMap),
  )}.`;

  const result = await chatCompletion({
    apiKey,
    modelId: evaluatorModelId,
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
      `Avaliacao retornou JSON invalido: ${(err as Error).message}. Texto: ${result.text.slice(0, 300)}`,
    );
  }

  const validated = evalSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Avaliacao schema invalido: ${validated.error.message}`);
  }

  const bestLetter = validated.data.best.trim().toUpperCase();
  const bestContestantId = blindMap[bestLetter] ?? Object.values(blindMap)[0] ?? '';

  const seen = new Set<string>();
  const verdicts: EvaluationVerdict[] = [];
  for (const v of validated.data.verdicts) {
    const letter = v.label.trim().toUpperCase();
    const contestantId = blindMap[letter];
    if (!contestantId || seen.has(contestantId)) continue;
    seen.add(contestantId);
    verdicts.push({ contestantId, acceptable: v.acceptable, justification: v.justification });
  }
  // garante veredito para toda resposta OK que o modelo tenha omitido
  for (const letter of Object.keys(blindMap)) {
    const contestantId = blindMap[letter];
    if (!seen.has(contestantId)) {
      seen.add(contestantId);
      verdicts.push({
        contestantId,
        acceptable: contestantId === bestContestantId,
        justification: 'Sem veredito explicito do avaliador.',
      });
    }
  }

  return {
    bestContestantId,
    bestReasons: validated.data.bestReasons,
    verdicts: [...verdicts, ...failedVerdicts],
    blindMap,
    raw: result.text,
  };
}
