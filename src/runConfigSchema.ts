// Schema Zod do RunConfig — a ESPECIFICACAO REAL de uma run.
//
// Morava dentro de `routes.ts` (acoplado ao Express) mas nao tem nada de HTTP:
// sao os limites de cada campo, o XOR do compare, a regra de que juiz nao
// compete e o preprocess de `customStages`. O CLI precisa validar exatamente
// igual ao servidor — uma segunda copia derivaria no primeiro ajuste de limite.

import { z } from 'zod';
import { sanitizeLlmVariants, MIN_LLM_VARIANTS, MAX_LLM_VARIANTS } from './llmVariants.js';
import type { RunConfig } from './types.js';

// Nivel de esforco de raciocinio (ReasoningLevel de types.ts / REASONING_LEVELS
// de reasoning.ts), repetido aqui como literal para o enum do Zod.
const reasoningLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Schema Zod de StageSpec (types.ts), compartilhado por customStages e
// scenarioSeed. Em customStages o preprocess preenche maxTokens ausente
// (herda maxOutputTokens); em scenarioSeed o item ja deve trazer maxTokens.
const stageSpecSchema = z.object({
  question: z.string().min(1),
  productContext: z.string().min(1),
  rubric: z.string().optional(),
  // maxTokens omitido pelo usuario e preenchido no preprocess (herda maxOutputTokens).
  maxTokens: z.number().int().positive().max(16_000),
  // Gabarito (resposta de referencia ideal) p/ julgamento pointwise + duelos.
  reference: z.string().max(32_000).optional(),
  // Proveniencia da etapa: gerada pela IA ou importada de pacote JSON.
  origin: z.enum(['ai', 'import']).optional(),
});

const baseFields = {
  theme: z.string().min(1),
  stages: z.number().int().min(1).max(50),
  datagenModelId: z.string().min(1),
  // Um ou mais juizes (rodam em paralelo). Aceita tambem o legado judgeModelId
  // (string) via preprocess do runConfigSchema.
  judgeModelIds: z.array(z.string().min(1)).min(1),
  concurrency: z.number().int().min(1).max(32).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  // maxOutputTokens livre (teto generoso): a UI virou input livre — o teto
  // real e a janela do modelo; o OpenRouter rejeita o que exceder.
  maxOutputTokens: z.number().int().min(50).max(1_000_000).optional(),
  promptOptimization: z.boolean().optional(),
  optimizerModelId: z.string().min(1).optional(),
  judgePasses: z.union([z.literal(1), z.literal(2)]).optional(),
  // Perfil de conformidade LGPD escolhido no assistente (CONSULTIVO: gravado
  // para transparência/rastreabilidade, não força roteamento). Ausente = "livre".
  compliance: z.object({ area: z.string().min(1), includeRessalvas: z.boolean() }).optional(),
  // Etapas fornecidas pelo usuario (JSON): pulam o datagen. Quando presentes,
  // `stages` e forcado ao tamanho desta lista (ver preprocess do runConfigSchema).
  customStages: z.array(stageSpecSchema).min(1).max(50).optional(),
  // Esforco de raciocinio por papel (competitor/judge/rewriter/datagen);
  // papel ausente = default do pipeline.
  reasoning: z
    .object({
      competitor: reasoningLevelSchema.optional(),
      judge: reasoningLevelSchema.optional(),
      rewriter: reasoningLevelSchema.optional(),
      datagen: reasoningLevelSchema.optional(),
    })
    .optional(),
  // Modelo que gera os gabaritos (respostas de referencia). Default = 1o juiz.
  referenceModelId: z.string().min(1).optional(),
  // Julgamento por referencia (pointwise vs gabarito + duelos).
  referenceJudging: z.boolean().optional(),
  // Descricao detalhada do que testar — guia o datagen na geracao de cenarios.
  scenarioBrief: z.string().max(4000).optional(),
  // Cenarios importados de pacote JSON (seed); o datagen complementa ate `stages`.
  scenarioSeed: z.array(stageSpecSchema).max(50).optional(),
  // Nº de finalistas (melhores por judge-score) que disputam os duelos. 0 = sem finais.
  finalists: z.number().int().min(0).max(12).optional(),
  // Liga/desliga a fase de finais (duelos Copeland entre os finalistas).
  duels: z.boolean().optional(),
  // Teto de gasto em USD para a run/sessao inteira. Ausente = sem limite.
  budgetUsd: z.number().positive().optional(),
  // Teto de preco POR REQUISICAO repassado ao OpenRouter (`provider.max_price`).
  // ATENCAO A UNIDADE: aqui e USD por MILHAO de tokens, enquanto o catalogo
  // (`/models.pricing`) e USD por token. Ver toPerMTok/toPerToken em estimate.ts.
  maxPricePerMTok: z
    .object({
      prompt: z.number().positive().optional(),
      completion: z.number().positive().optional(),
    })
    .optional(),
};

const manualVariantSchema = z.object({
  label: z.string().min(1),
  systemPrompt: z.string().min(1),
});

const singleModelFields = {
  contestantModelId: z.string().min(1),
  basePrompt: z.string().optional(),
  techniqueIds: z.array(z.string().min(1)).optional(),
  manualVariants: z.array(manualVariantSchema).optional(),
  // Temperatura do modelo sob teste, aplicada a TODAS as variantes. Ausente = 0.
  temperature: z.number().min(0).max(2).optional(),
};

const compareObj = z.object({
  mode: z.literal('compare'),
  // >= 2 competidores, todos distintos (eixo classico). Opcional porque
  // competitorConfigs e a alternativa — o superRefine impede ambos/nenhum.
  competitorModelIds: z.array(z.string().min(1)).min(2).optional(),
  // compare-llms: variantes de config {modelo, temperatura, reasoning} no eixo
  // de contestants (identidade = tripla; o mesmo modelo pode competir 2x com
  // configs diferentes). O superRefine roda sanitizeLlmVariants sobre a lista.
  competitorConfigs: z
    .array(
      z.object({
        modelId: z.string().min(1),
        temperature: z.number().min(0).max(2).optional(),
        reasoningLevel: reasoningLevelSchema.optional(),
      }),
    )
    .min(MIN_LLM_VARIANTS)
    .max(MAX_LLM_VARIANTS)
    .optional(),
  ...baseFields,
});
const variationObj = z.object({
  mode: z.literal('variation'),
  ...singleModelFields,
  ...baseFields,
});
const trainingObj = z.object({
  mode: z.literal('training'),
  ...singleModelFields,
  iterations: z.number().int().min(2).max(10),
  // Margem minima de ganho (pp) sobre o campeao para promover; sem ganho = convergiu.
  minGain: z.number().min(0).max(100).optional(),
  // Fracao de cenarios reservada p/ holdout (re-score campeao vs controle).
  holdoutRatio: z.number().min(0).max(0.5).optional(),
  // Reflection estilo GEPA: variantes recebem licoes das falhas do campeao.
  feedbackDriven: z.boolean().optional(),
  ...baseFields,
});

export const runConfigSchema = z
  .preprocess(
    (val) => {
      if (!val || typeof val !== 'object') return val;
      const obj = { ...(val as Record<string, unknown>) };
      // compat: payloads antigos sem `mode` sao tratados como compare.
      if (obj.mode === undefined) obj.mode = 'compare';
      // compat: judgeModelId (string, legado) -> judgeModelIds (array).
      if (obj.judgeModelIds === undefined && typeof obj.judgeModelId === 'string') {
        obj.judgeModelIds = [obj.judgeModelId];
      }
      // Etapas manuais ditam a contagem: `stages` = nº de etapas fornecidas.
      // maxTokens ausente/invalido herda maxOutputTokens (ou 1000) — o competidor
      // faz Math.min(maxOutputTokens, stage.maxTokens) e undefined viraria NaN.
      if (Array.isArray(obj.customStages) && obj.customStages.length > 0) {
        obj.stages = obj.customStages.length;
        const fallback =
          typeof obj.maxOutputTokens === 'number' && obj.maxOutputTokens > 0
            ? obj.maxOutputTokens
            : 1000;
        obj.customStages = obj.customStages.map((s) => {
          if (s && typeof s === 'object') {
            const mt = (s as Record<string, unknown>).maxTokens;
            if (typeof mt !== 'number' || mt <= 0) {
              return { ...(s as Record<string, unknown>), maxTokens: fallback };
            }
          }
          return s;
        });
      }
      return obj;
    },
    z.discriminatedUnion('mode', [compareObj, variationObj, trainingObj]),
  )
  .superRefine((cfg, ctx) => {
    // Gerador e juiz PODEM repetir o mesmo modelo (repeticao permitida).
    if (cfg.mode === 'compare') {
      // Eixo de competidores: competitorModelIds (classico) OU competitorConfigs
      // (compare-llms) — nunca ambos, nunca nenhum (>= 2 competidores efetivos).
      if (cfg.competitorModelIds && cfg.competitorConfigs) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitorConfigs'],
          message: 'Use competitorConfigs OU competitorModelIds, nao ambos.',
        });
      }
      if (!cfg.competitorModelIds && !cfg.competitorConfigs) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitorModelIds'],
          message: 'Informe ao menos 2 competidores (competitorModelIds ou competitorConfigs).',
        });
      }
      // Modelos efetivos no eixo: das ids simples e/ou das configs. Em configs o
      // MESMO modelo pode repetir (identidade = tripla modelo/temperatura/reasoning).
      const competitorIds = cfg.competitorModelIds ?? [];
      const configModelIds = (cfg.competitorConfigs ?? []).map((c) => c.modelId);
      const effectiveModelIds = [...competitorIds, ...configModelIds];
      if (cfg.competitorModelIds) {
        const dup = competitorIds.find((id, i) => competitorIds.indexOf(id) !== i);
        if (dup) {
          ctx.addIssue({
            code: 'custom',
            path: ['competitorModelIds'],
            message: `Competidor repetido: "${dup}". Cada competidor deve ser unico.`,
          });
        }
      }
      if (cfg.competitorConfigs) {
        // Dedup pela tripla + limites 2-12 + itens validos (o erro ja vem em PT-BR).
        const { error } = sanitizeLlmVariants(cfg.competitorConfigs);
        if (error) {
          ctx.addIssue({ code: 'custom', path: ['competitorConfigs'], message: error });
        }
      }
      if (effectiveModelIds.includes(cfg.datagenModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['datagenModelId'],
          message: 'O gerador de cenarios nao pode ser tambem um competidor.',
        });
      }
      const judgeAsCompetitor = cfg.judgeModelIds.find((id) => effectiveModelIds.includes(id));
      if (judgeAsCompetitor) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgeModelIds'],
          message: `O juiz "${judgeAsCompetitor}" nao pode ser tambem um competidor.`,
        });
      }
    } else {
      // variation | training: anti vies de auto-preferencia do juiz.
      if (cfg.judgeModelIds.includes(cfg.contestantModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgeModelIds'],
          message: 'Nenhum juiz pode ser o mesmo modelo sob teste (vies de auto-preferencia).',
        });
      }
      const optimize = cfg.promptOptimization !== false;
      const baseCount = cfg.basePrompt && cfg.basePrompt.trim() ? 1 : 0;
      if (optimize) {
        const techCount = cfg.techniqueIds?.length ?? 0;
        if (techCount + baseCount < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['techniqueIds'],
            message:
              'Selecione ao menos 2 tecnicas (ou 1 tecnica + prompt base) para ter contestants suficientes.',
          });
        }
      } else {
        const manualCount = (cfg.manualVariants ?? []).filter((v) => v.systemPrompt.trim()).length;
        if (manualCount + baseCount < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['manualVariants'],
            message:
              'Com otimizacao desligada, forneca ao menos 2 variantes (ou 1 variante + prompt base).',
          });
        }
      }
    }
  });

export type ParseRunConfigResult =
  | { ok: true; config: RunConfig }
  | { ok: false; error: string; details: z.core.$ZodFlattenedError<unknown> };

/**
 * Valida um RunConfig e devolve o erro ja ACHATADO em uma mensagem PT-BR — o
 * CLI nao deveria precisar importar o encanamento de erros do zod so para
 * imprimir "o que esta errado".
 */
export function parseRunConfig(input: unknown): ParseRunConfigResult {
  const parsed = runConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data as RunConfig };

  const flat = parsed.error.flatten();
  const campos = Object.entries(flat.fieldErrors)
    .map(([campo, msgs]) => `${campo}: ${(msgs ?? []).join('; ')}`)
    .join(' | ');
  const gerais = flat.formErrors.join('; ');
  const error = [gerais, campos].filter(Boolean).join(' | ') || 'Config invalida.';
  return { ok: false, error, details: flat };
}
