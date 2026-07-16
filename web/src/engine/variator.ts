import { z } from 'zod';
import { chatCompletion } from './openrouter';
import { getTechnique } from './techniques';
import type { Contestant, ManualVariant, PromptTechnique } from './types';

const variantSchema = z.object({ systemPrompt: z.string().min(1) });

const SYSTEM_PROMPT = `Voce e um engenheiro de prompts senior. Recebe um PROMPT BASE (ou apenas um TEMA, se nao houver base) e uma TECNICA a aplicar.
Sua tarefa: produzir um NOVO system prompt aplicando a tecnica, preservando a intencao, o escopo e as restricoes do prompt base.
NAO responda a tarefa do usuario; apenas reescreva o system prompt.
Saida ESTRITAMENTE em JSON valido, sem markdown, sem comentarios: {"systemPrompt":"<novo system prompt completo>"}`;

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

export interface GenerateContestantsParams {
  apiKey: string;
  /** O unico modelo sob teste (eixo contestant). */
  modelId: string;
  theme: string;
  /** Base de derivacao das variantes (variation: base do usuario; treino i>0: vencedora). */
  basePrompt?: string;
  /** Prompt original do usuario, rodado como controle quando includeOriginal. */
  originalPrompt?: string;
  /** Melhor da iteracao anterior, re-testado verbatim (treino i>0). */
  carryPrompt?: string;
  carryLabel?: string;
  carryParentId?: string;
  includeOriginal: boolean;
  techniqueIds?: string[];
  manualVariants?: ManualVariant[];
  /** Liga/desliga a geracao por LLM. Off => usa manualVariants/base verbatim. */
  promptOptimization: boolean;
  /** Meta-modelo que reescreve os prompts. */
  optimizerModelId: string;
  /** Aprendizados da iteracao anterior (treino) injetados na geracao. */
  analysisHint?: string;
  timeoutMs?: number;
}

async function generateOneVariant(
  p: GenerateContestantsParams,
  technique: PromptTechnique,
): Promise<string | null> {
  const baseBlock = p.basePrompt?.trim()
    ? `PROMPT BASE:\n${p.basePrompt.trim()}`
    : `TEMA (sem prompt base — crie um system prompt do zero para este tema):\n${p.theme}`;
  const hintBlock = p.analysisHint?.trim()
    ? `\n\nAPRENDIZADOS DA ITERACAO ANTERIOR (enderece estas fraquezas):\n${p.analysisHint.trim()}`
    : '';

  const userPrompt = `${baseBlock}

TECNICA A APLICAR — ${technique.name}:
${technique.metaInstruction}${hintBlock}

Devolva o JSON {"systemPrompt":"..."}.`;

  try {
    const result = await chatCompletion({
      apiKey: p.apiKey,
      modelId: p.optimizerModelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      timeoutMs: p.timeoutMs ?? 90_000,
      responseFormatJson: true,
    });
    const parsed = variantSchema.safeParse(JSON.parse(extractJson(result.text)));
    if (!parsed.success) {
      console.warn(`[variator] tecnica ${technique.id}: JSON invalido`);
      return null;
    }
    const sp = parsed.data.systemPrompt.trim();
    return sp.length > 0 ? sp : null;
  } catch (err) {
    console.warn(`[variator] tecnica ${technique.id} falhou: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve a lista de contestants de uma run de variacao/treino:
 * (controle original) + (carry da vencedora anterior) + (variantes geradas/manuais).
 * Garante ids unicos. Pode retornar menos do que o pedido se variantes falharem —
 * o chamador deve exigir >= 2 contestants.
 */
export async function generateContestants(
  p: GenerateContestantsParams,
): Promise<Contestant[]> {
  const contestants: Contestant[] = [];

  // 1) Controle: o prompt original do usuario (sempre, quando fornecido e pedido).
  const original = (p.originalPrompt ?? p.basePrompt)?.trim();
  if (p.includeOriginal && original) {
    contestants.push({
      id: 'original',
      label: 'Original (controle)',
      modelId: p.modelId,
      systemPrompt: original,
      isOriginal: true,
    });
  }

  // 2) Carry: a melhor da iteracao anterior, re-testada verbatim (treino i>0).
  if (p.carryPrompt?.trim()) {
    contestants.push({
      id: 'carry',
      label: p.carryLabel ?? 'Melhor anterior',
      modelId: p.modelId,
      systemPrompt: p.carryPrompt.trim(),
      parentContestantId: p.carryParentId,
    });
  }

  // 3) Variantes.
  if (!p.promptOptimization) {
    // Toggle OFF: variantes manuais verbatim (sem LLM).
    (p.manualVariants ?? []).forEach((v, i) => {
      const sp = v.systemPrompt.trim();
      if (!sp) return;
      contestants.push({
        id: `m${i}`,
        label: v.label?.trim() || `Variante ${i + 1}`,
        modelId: p.modelId,
        systemPrompt: sp,
      });
    });
    return contestants;
  }

  // Toggle ON: gera uma variante por tecnica selecionada (em paralelo).
  const techniques = (p.techniqueIds ?? [])
    .map((id) => getTechnique(id))
    .filter((t): t is PromptTechnique => Boolean(t));

  const results = await Promise.all(techniques.map((t) => generateOneVariant(p, t)));
  results.forEach((systemPrompt, i) => {
    if (!systemPrompt) return;
    const t = techniques[i];
    contestants.push({
      id: `v${i}`,
      label: t.name,
      modelId: p.modelId,
      systemPrompt,
      techniqueId: t.id,
      parentContestantId: p.carryParentId,
    });
  });

  return contestants;
}

// ---------------------------------------------------------------------------
// Geracao de PROMPT BASE a partir de uma descricao de tarefa (opcional no
// assistente). O prompt gerado preenche o campo do prompt base — que sempre
// roda como CONTROLE/original no treino.
// ---------------------------------------------------------------------------

export interface GenerateBasePromptParams {
  apiKey: string;
  /** Modelo que redige o prompt (reusa o gerador/optimizer do assistente). */
  modelId: string;
  /** O que o usuario descreveu que a tarefa precisa fazer. */
  taskDescription: string;
  /** Contexto/tema extra opcional. */
  theme?: string;
  timeoutMs?: number;
}

const BASE_PROMPT_SYSTEM = `Voce e um engenheiro de prompts senior. Recebe a DESCRICAO de uma tarefa e produz um SYSTEM PROMPT completo e reutilizavel para um assistente que executa essa tarefa.
NAO responda a tarefa; escreva APENAS o system prompt (instrucoes para o assistente), pronto para uso, claro e conciso.
Saida ESTRITAMENTE em JSON valido, sem markdown, sem comentarios: {"systemPrompt":"<system prompt completo>"}`;

/**
 * Gera um system prompt base a partir de uma descricao em linguagem natural.
 * Lanca erro (mensagem PT-BR) se o modelo nao devolver um prompt valido.
 */
export async function generateBasePrompt(p: GenerateBasePromptParams): Promise<string> {
  const themeBlock = p.theme?.trim() ? `\n\nCONTEXTO/TEMA:\n${p.theme.trim()}` : '';
  const userPrompt = `DESCRICAO DA TAREFA:\n${p.taskDescription.trim()}${themeBlock}\n\nDevolva o JSON {"systemPrompt":"..."}.`;

  const result = await chatCompletion({
    apiKey: p.apiKey,
    modelId: p.modelId,
    messages: [
      { role: 'system', content: BASE_PROMPT_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    timeoutMs: p.timeoutMs ?? 90_000,
    responseFormatJson: true,
  });

  let parsed;
  try {
    parsed = variantSchema.safeParse(JSON.parse(extractJson(result.text)));
  } catch {
    throw new Error('Nao consegui interpretar a resposta do modelo como JSON. Tente novamente.');
  }
  if (!parsed.success) {
    throw new Error('O modelo nao devolveu um system prompt valido. Tente novamente.');
  }
  const sp = parsed.data.systemPrompt.trim();
  if (!sp) throw new Error('O modelo devolveu um system prompt vazio.');
  return sp;
}
