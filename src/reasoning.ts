// Esforço de raciocínio. O OpenRouter normaliza tudo num único objeto
// `reasoning` cujos campos `effort` e `max_tokens` são MUTUAMENTE EXCLUSIVOS
// (mandar os dois = HTTP 400), e a escala de esforço tem SETE degraus:
// none < minimal < low < medium < high < xhigh < max.
//
// Cada modelo declara em `/models` o que aceita (ver `ModelReasoningMeta`):
//   supported_efforts  allowlist em ordem decrescente; AUSENTE = sem restrição
//   default_effort     o degrau usado quando não mandamos nada
//   mandatory          true = raciocínio NÃO pode ser desligado ('none' é rejeitado)
// Medido em 2026-07-26: 214 de 345 modelos têm raciocínio, 83 declaram allowlist,
// e apenas 7 aceitam budget por `max_tokens` — por isso o caminho canônico aqui
// é sempre `effort`, nunca budget.

import type { ModelReasoningMeta, ReasoningLevel } from './types.js';

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Intensidade ordinal de cada degrau — base do encaixe na allowlist do modelo. */
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Nosso nível -> nome do `effort` no OpenRouter ('off' vira o degrau 'none'). */
export function effortName(level: ReasoningLevel): string {
  return level === 'off' ? 'none' : level;
}

/**
 * Encaixa o esforço pedido no que o modelo REALMENTE aceita. Sem allowlist
 * (`supported_efforts` ausente) o pedido passa direto. Com allowlist, escolhe o
 * degrau de menor distância ordinal e, em empate, o MAIS BARATO — pedir 'max'
 * num modelo que só tem ['xhigh','high'] deve virar 'xhigh', não erro.
 */
export function fitEffort(level: ReasoningLevel, meta?: ModelReasoningMeta): string {
  const alvo = effortName(level);
  const allow = meta?.supportedEfforts;
  if (!allow || allow.length === 0) return alvo;
  if (allow.includes(alvo)) return alvo;
  const rAlvo = EFFORT_RANK[alvo] ?? 3;
  let melhor = allow[allow.length - 1];
  let melhorDist = Infinity;
  for (const cand of allow) {
    const r = EFFORT_RANK[cand];
    if (r === undefined) continue;
    const dist = Math.abs(r - rAlvo);
    if (dist < melhorDist || (dist === melhorDist && r < (EFFORT_RANK[melhor] ?? 99))) {
      melhor = cand;
      melhorDist = dist;
    }
  }
  return melhor;
}

export function coerceLevel(level: unknown, fallback: ReasoningLevel = 'off'): ReasoningLevel {
  return (REASONING_LEVELS as readonly unknown[]).includes(level)
    ? (level as ReasoningLevel)
    : fallback;
}

/**
 * Aplica o esforço ao body da chamada de chat, respeitando o que o modelo aceita.
 * - `off` num modelo com `mandatory` NÃO manda nada (o provedor rejeita 'none';
 *   raciocínio ali é obrigatório e fica no default dele).
 * - `off` no resto desliga explicitamente.
 * - qualquer outro nível manda `{ effort }` encaixado na allowlist. Nunca manda
 *   `max_tokens` junto — os dois campos são mutuamente exclusivos.
 */
export function applyReasoning(
  body: Record<string, unknown>,
  level: ReasoningLevel,
  meta?: ModelReasoningMeta,
): void {
  if (level === 'off') {
    if (meta?.mandatory) return;
    body.reasoning = { enabled: false };
    return;
  }
  body.reasoning = { effort: fitEffort(level, meta) };
}
