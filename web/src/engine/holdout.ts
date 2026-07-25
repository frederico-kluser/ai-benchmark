// Split anti-overfit de holdout, portado do prompt-arena (`server/studio/holdout.mjs`).
// A fatia de holdout fica FORA da seleção: ao fim do treino o campeão final e o
// controle rodam nela de novo e uma regressão nela bloqueia a promoção.

/**
 * Mínimo de cenários em holdout para o re-score (e seu gate) significar algo.
 * Abaixo disso uma "regressão" é ruído: 1 cenário balança o judge-score em
 * ≥100/n pontos (n=2 → 50pp por cenário), o que no original chegou a recusar
 * vencedores reais. Casa com o piso n≥5 de `pairedSignificance` (`stats.ts`).
 */
export const MIN_HOLDOUT_SCENARIOS = 5;

/**
 * Divide a seleção pinada em fatias de treino + holdout.
 *
 * Split intercalado determinístico (a cada k-ésimo item → holdout) para que
 * AMBAS as fatias amostrem a seleção inteira, em vez de um bloco contíguo de
 * cabeça/cauda. Se o holdout resultante ficar abaixo de {@link MIN_HOLDOUT_SCENARIOS},
 * ele é descartado por inteiro — tudo treina, sem gate espúrio dominado por ruído.
 *
 * @param items        os cenários pinados da run
 * @param holdoutRatio fração a reservar (clamp em [0, 0.5]; 0 desliga o holdout)
 */
export function splitHoldout<T>(items: T[], holdoutRatio = 0.2): { train: T[]; holdout: T[] } {
  const list = Array.isArray(items) ? items : [];
  const ratio = Number.isFinite(holdoutRatio) ? Math.min(Math.max(holdoutRatio, 0), 0.5) : 0.2;

  const train: T[] = [];
  const holdout: T[] = [];
  const kSplit = ratio > 0 ? Math.max(2, Math.round(1 / ratio)) : 0;
  list.forEach((item, i) => {
    if (kSplit && i % kSplit === kSplit - 1) holdout.push(item);
    else train.push(item);
  });

  // Poucos demais para confiar ⇒ sem holdout: a seleção inteira treina.
  if (holdout.length < MIN_HOLDOUT_SCENARIOS) return { train: list.slice(), holdout: [] };
  return { train, holdout };
}
