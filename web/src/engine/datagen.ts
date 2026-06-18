import { z } from 'zod';
import { chatCompletion } from './openrouter';
import type { StageSpec } from './types';

const stageSchema = z.object({
  question: z.string().min(1),
  productContext: z.string().min(1),
  maxTokens: z.number().int().positive().max(8000),
});

const SYSTEM_PROMPT = `Voce e um gerador de cenarios de benchmark para LLMs.
Voce recebe um TEMA, o indice da etapa atual (1-based) e o total de etapas.
Sua tarefa: produzir UM cenario realista representando uma interacao em que um usuario faz uma pergunta a um sistema de IA de produto, e esse sistema possui um CONTEXTO DE PRODUTO para responder.

Regras:
- Saida ESTRITAMENTE em JSON valido (sem markdown, sem comentarios).
- Campos obrigatorios: "question" (a pergunta do usuario), "productContext" (texto que sera passado como system prompt aos competidores; pode incluir politicas, dados de produto, manuais, FAQs, restricoes), "maxTokens" (inteiro 200..2000 sugerindo o teto razoavel de tokens da resposta).
- A etapa deve ser auto-contida: nao referencie etapas anteriores.
- Varie o tipo de tarefa entre etapas (extracao, raciocinio, comparacao, criatividade controlada, recusa, etc.) coerente com o tema.
- Idioma: portugues, salvo se o tema exigir outro.`;

export interface DatagenParams {
  apiKey: string;
  theme: string;
  stageIndex: number; // 0-based
  totalStages: number;
  modelId: string;
  timeoutMs?: number;
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

export async function generateStage(params: DatagenParams): Promise<StageSpec> {
  const { apiKey, theme, stageIndex, totalStages, modelId, timeoutMs } = params;

  const userPrompt = `TEMA: ${theme}
ETAPA: ${stageIndex + 1} de ${totalStages}

Gere o cenario desta etapa em JSON conforme as regras.`;

  const result = await chatCompletion({
    apiKey,
    modelId,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    timeoutMs: timeoutMs ?? 90_000,
    responseFormatJson: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(result.text));
  } catch (err) {
    throw new Error(
      `Datagen retornou JSON invalido: ${(err as Error).message}. Texto: ${result.text.slice(0, 300)}`,
    );
  }

  const validated = stageSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Datagen schema invalido: ${validated.error.message}`);
  }

  return validated.data;
}
