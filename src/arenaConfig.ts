// Traducao `arena-config@1` -> `RunConfig`.
//
// Ate agora essa traducao nao existia como codigo reusavel: eram dois saltos
// por React (`applyArenaConfig` -> estado do componente -> `submit()` em
// web/src/pages/NewRun.tsx). O CLI precisa dela, e escreve-la aqui e melhor do
// que duplicar — a tela pode passar a chamar esta funcao e apagar a logica.
//
// O `arena-config@1` descreve o ESTADO DO ASSISTENTE (esforco POR MODELO,
// modelos por papel, toggles), enquanto o `RunConfig` e o contrato do motor
// (esforco POR PAPEL). As regras nao-obvias da conversao estao comentadas
// abaixo, cada uma marcando o que se perde se ela for esquecida.

import { parseRunConfig } from './runConfigSchema.js';
import type { ArenaConfigFile } from './configFile.js';
import type { ReasoningConfig, RunConfig, StageSpec } from './types.js';

/** Defaults da UI, aplicados quando o arquivo omite o campo. */
export interface ArenaConfigDefaults {
  stages?: number;
  iterations?: number;
  finalists?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  concurrency?: number;
}

const DEFAULTS: Required<ArenaConfigDefaults> = {
  stages: 5,
  iterations: 3,
  finalists: 3,
  maxOutputTokens: 500,
  timeoutMs: 60_000,
  concurrency: 8,
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export type ArenaConfigToRunConfigResult =
  | { ok: true; config: RunConfig }
  | { ok: false; error: string };

export function arenaConfigToRunConfig(
  file: ArenaConfigFile,
  overrides: ArenaConfigDefaults = {},
): ArenaConfigToRunConfigResult {
  const d = { ...DEFAULTS, ...overrides };
  const maxOutputTokens = Math.max(50, file.limits?.maxOutputTokens ?? d.maxOutputTokens);

  // Cenarios pinados viram `scenarioSeed` — sem o `id` (o motor re-rotula) e
  // herdando `maxTokens` do limite global quando o arquivo nao especifica.
  const scenarioSeed: StageSpec[] = (file.scenarios ?? []).map((s) => ({
    question: s.question,
    productContext: s.productContext ?? '',
    maxTokens: s.maxTokens && s.maxTokens > 0 ? s.maxTokens : maxOutputTokens,
    ...(s.rubric ? { rubric: s.rubric } : {}),
    ...(s.reference ? { reference: s.reference } : {}),
    origin: 'import' as const,
  }));

  // `stages` nunca pode ser menor que o numero de cenarios pinados, senao parte
  // da curadoria do usuario ficaria de fora (o motor so completa o que falta).
  const stages = clamp(Math.max(file.stages ?? d.stages, scenarioSeed.length), 1, 50);

  // Esforco POR PAPEL. ⚠️ O juiz cai para o esforco do modelo de REFERENCIA
  // quando nao tem o proprio: no motor, juiz e gabarito compartilham
  // `reasoning.judge`, entao sem esse fallback o ajuste do gabarito sumiria.
  const reasoning: ReasoningConfig = {};
  if (file.effort?.competitor) reasoning.competitor = file.effort.competitor;
  const judgeEffort = file.effort?.judge;
  if (judgeEffort) reasoning.judge = judgeEffort;
  if (file.effort?.datagen) reasoning.datagen = file.effort.datagen;
  if (file.effort?.rewriter) reasoning.rewriter = file.effort.rewriter;

  // `duels`/`finalists` moram na raiz, mas arquivos antigos os punham dentro de
  // `training` — a raiz vence.
  const duelsOn = file.duels ?? file.training?.duels ?? true;
  const finalists = clamp(Math.round(file.finalists ?? file.training?.finalists ?? d.finalists), 0, 12);
  const semFinais = !duelsOn || finalists === 0;

  // `referenceJudging` vai SEMPRE explicito: o default muda por modo/eixo, e
  // deixa-lo implicito faria o arquivo significar coisas diferentes por modo.
  const referenceJudging =
    file.judging?.reference ??
    (file.mode !== 'compare' || Boolean(file.models.competitorConfigs?.length));

  const common = {
    theme: file.theme.trim(),
    stages,
    datagenModelId: file.models.datagen,
    judgeModelIds: file.models.judges,
    concurrency: clamp(Math.round(file.limits?.concurrency ?? d.concurrency), 1, 32),
    timeoutMs: clamp(Math.round(file.limits?.timeoutMs ?? d.timeoutMs), 1_000, 300_000),
    maxOutputTokens,
    referenceJudging,
    finalists,
    judgePasses: (file.judging?.passes === 2 ? 2 : 1) as 1 | 2,
    ...(semFinais ? { duels: false } : {}),
    ...(scenarioSeed.length ? { scenarioSeed } : {}),
    ...(file.scenarioBrief?.trim() ? { scenarioBrief: file.scenarioBrief.trim() } : {}),
    ...(file.models.reference ? { referenceModelId: file.models.reference } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    ...(file.compliance ? { compliance: file.compliance } : {}),
  };

  let candidate: Record<string, unknown>;

  if (file.mode === 'compare') {
    if (file.models.competitorConfigs?.length) {
      // Eixo configs: NAO enviar competitorModelIds — a identidade do
      // concorrente e a tripla modelo/temperatura/reasoning.
      candidate = {
        mode: 'compare',
        ...common,
        competitorConfigs: file.models.competitorConfigs.map((c) => ({
          modelId: c.model,
          ...(c.temperature !== undefined ? { temperature: clamp(c.temperature, 0, 2) } : {}),
          ...(c.reasoning ? { reasoningLevel: c.reasoning } : {}),
        })),
      };
    } else {
      candidate = { mode: 'compare', ...common, competitorModelIds: file.models.competitors ?? [] };
    }
  } else {
    const optimize = file.variation?.optimize !== false;
    const manualVariants = (file.variation?.manualVariants ?? []).filter((v) =>
      v.systemPrompt.trim(),
    );
    candidate = {
      mode: file.mode,
      ...common,
      contestantModelId: file.models.contestant ?? '',
      ...(file.prompt?.text?.trim() ? { basePrompt: file.prompt.text.trim() } : {}),
      promptOptimization: optimize,
      ...(optimize ? { techniqueIds: file.variation?.techniques ?? [] } : { manualVariants }),
      ...(optimize && file.models.rewriter ? { optimizerModelId: file.models.rewriter } : {}),
      ...(file.mode === 'training'
        ? {
            iterations: clamp(Math.round(file.training?.iterations ?? d.iterations), 2, 10),
            minGain: clamp(file.training?.minGain ?? 1, 0, 100),
            holdoutRatio: clamp(file.training?.holdoutRatio ?? 0.2, 0, 0.5),
            feedbackDriven: file.training?.feedbackDriven !== false,
          }
        : {}),
    };
  }

  // Passa pelo MESMO schema que o servidor usa — bounds, XOR do compare e a
  // regra de juiz-nao-compete valem igual para arquivo e para formulario.
  const parsed = parseRunConfig(candidate);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, config: parsed.config };
}
