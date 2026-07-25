// Níveis de raciocínio (reasoning effort) portados do prompt-arena.
// O OpenRouter aceita `reasoning: { max_tokens }` no body da chamada de chat;
// aqui ficam os budgets por nível e o helper que aplica isso ao body.

import type { ReasoningLevel } from './types';

export const REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const;

export const REASONING_BUDGETS: Record<Exclude<ReasoningLevel, 'off'>, number> = {
  low: 1024,
  medium: 2048,
  high: 4096,
  max: 16384,
};

// O OpenRouter exige max_tokens > reasoning.max_tokens — margem mínima para a
// resposta não vir vazia depois do raciocínio consumir o orçamento.
export const ANSWER_HEADROOM = 2048;

export function coerceLevel(level: unknown, fallback: ReasoningLevel = 'off'): ReasoningLevel {
  return (REASONING_LEVELS as readonly unknown[]).includes(level)
    ? (level as ReasoningLevel)
    : fallback;
}

// Aplica o nível ao body da chamada de chat. `off` desliga o raciocínio
// explicitamente; os demais níveis setam o budget e garantem headroom de
// resposta no max_tokens (subindo-o se o valor atual não cobrir).
export function applyReasoning(body: Record<string, unknown>, level: ReasoningLevel): void {
  if (level === 'off') {
    body.reasoning = { enabled: false };
    return;
  }
  const budget = REASONING_BUDGETS[level];
  body.reasoning = { max_tokens: budget };
  const atual = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
  body.max_tokens = Math.max(atual, budget + ANSWER_HEADROOM);
}
