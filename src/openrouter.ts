import type { OpenRouterModel } from './types.js';

// Permite apontar para um gateway compativel com a OpenRouter (proxy
// corporativo, mock de teste). Default: API publica da OpenRouter.
const OPENROUTER_BASE =
  process.env.OPENROUTER_BASE_URL?.replace(/\/+$/, '') ?? 'https://openrouter.ai/api/v1';
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function defaultHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.OPENROUTER_APP_URL ?? 'http://localhost:3000',
    'X-Title': process.env.OPENROUTER_APP_TITLE ?? 'Benchmark Arena',
  };
}

// cache por key (sufixo curto) pra nao misturar contas
const modelsCache = new Map<string, { fetchedAt: number; data: OpenRouterModel[] }>();

function cacheKey(apiKey: string): string {
  return apiKey.slice(-12);
}

/**
 * Traduz uma resposta de erro da OpenRouter para uma mensagem clara em PT-BR.
 * 401/403 = key invalida/expirada/sem permissao; 402 = sem credito; 429 = rate limit.
 */
function describeOpenRouterError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return `OpenRouter recusou a key (HTTP ${status}): a key e invalida, expirou ou nao tem permissao. Reconfigure em Configuracoes.${snippet ? ` Detalhe: ${snippet}` : ''}`;
  }
  if (status === 402) {
    return `OpenRouter sem credito (HTTP 402): adicione creditos na sua conta.${snippet ? ` Detalhe: ${snippet}` : ''}`;
  }
  if (status === 429) {
    return `OpenRouter rate limit (HTTP 429): aguarde e tente novamente.${snippet ? ` Detalhe: ${snippet}` : ''}`;
  }
  return `OpenRouter falhou (HTTP ${status})${snippet ? `: ${snippet}` : ''}`;
}

function parsePrice(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function listModels(apiKey: string, force = false): Promise<OpenRouterModel[]> {
  const ck = cacheKey(apiKey);
  const cached = modelsCache.get(ck);
  if (!force && cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    method: 'GET',
    headers: defaultHeaders(apiKey),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter /models falhou: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: unknown[] };
  const raw = Array.isArray(json.data) ? json.data : [];

  const data: OpenRouterModel[] = raw.map((m) => {
    const item = m as Record<string, unknown>;
    const pricing = (item.pricing ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? ''),
      name: String(item.name ?? item.id ?? ''),
      contextLength:
        typeof item.context_length === 'number' ? (item.context_length as number) : undefined,
      pricing: {
        prompt: parsePrice(pricing.prompt),
        completion: parsePrice(pricing.completion),
      },
      raw: item,
    };
  });

  modelsCache.set(ck, { fetchedAt: Date.now(), data });
  return data;
}

export async function getModel(apiKey: string, id: string): Promise<OpenRouterModel | undefined> {
  const all = await listModels(apiKey);
  return all.find((m) => m.id === id);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  raw: unknown;
}

export interface ChatCompletionParams {
  apiKey: string;
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseFormatJson?: boolean;
}

export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  const {
    apiKey,
    modelId,
    messages,
    temperature = 0,
    maxTokens,
    timeoutMs = 60_000,
    signal: externalSignal,
    responseFormatJson,
  } = params;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature,
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }
  if (responseFormatJson) {
    body.response_format = { type: 'json_object' };
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: defaultHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(describeOpenRouterError(res.status, errText));
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content ?? '';
    const tokensIn = json.usage?.prompt_tokens ?? 0;
    const tokensOut = json.usage?.completion_tokens ?? 0;

    return { text, tokensIn, tokensOut, latencyMs, raw: json };
  } finally {
    clearTimeout(timeoutHandle);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

export function computeCost(
  tokensIn: number,
  tokensOut: number,
  model: OpenRouterModel | undefined,
): number {
  if (!model) return 0;
  return tokensIn * model.pricing.prompt + tokensOut * model.pricing.completion;
}

export interface ChatStreamParams extends ChatCompletionParams {
  onDelta?: (delta: string, fullText: string) => void;
}

export async function chatCompletionStream(
  params: ChatStreamParams,
): Promise<ChatCompletionResult> {
  const {
    apiKey,
    modelId,
    messages,
    temperature = 0,
    maxTokens,
    timeoutMs = 60_000,
    signal: externalSignal,
    responseFormatJson,
    onDelta,
  } = params;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature,
    stream: true,
    usage: { include: true },
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
  if (responseFormatJson) body.response_format = { type: 'json_object' };

  const startedAt = Date.now();
  let fullText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let lastRaw: unknown = null;

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: defaultHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(describeOpenRouterError(res.status, errText));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE lines separadas por \n. OpenRouter usa data: <json>\n\n
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          lastRaw = chunk;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            onDelta?.(delta, fullText);
          }
          if (chunk.usage) {
            if (typeof chunk.usage.prompt_tokens === 'number') tokensIn = chunk.usage.prompt_tokens;
            if (typeof chunk.usage.completion_tokens === 'number')
              tokensOut = chunk.usage.completion_tokens;
          }
        } catch {
          // chunk JSON invalido, ignora
        }
      }
    }

    const latencyMs = Date.now() - startedAt;
    return { text: fullText, tokensIn, tokensOut, latencyMs, raw: lastRaw };
  } finally {
    clearTimeout(timeoutHandle);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

export interface KeyInfo {
  /** Rotulo/nome da key configurado no OpenRouter. */
  label?: string;
  /** Gasto acumulado da key, em USD. */
  usageUsd?: number;
  /** Limite de credito da key (null = sem limite/ilimitado). */
  limitUsd?: number | null;
  /** Credito restante (null = sem limite). */
  limitRemainingUsd?: number | null;
  /** Se a key esta no tier gratuito. */
  isFreeTier?: boolean;
}

export type ValidateKeyResult = ({ ok: true } & KeyInfo) | { ok: false; error: string };

function asNumberOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/**
 * Valida a key contra o endpoint AUTENTICADO `GET /api/v1/key`.
 *
 * IMPORTANTE: `/models` e publico (responde 200 sem qualquer Authorization),
 * entao validar por la marcava QUALQUER key como valida — inclusive uma
 * invalida — e a run so falhava (401) la na frente, no datagen. `/key` exige
 * o header de autenticacao e retorna metadados da propria key.
 */
export async function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  const key = (apiKey ?? '').trim();
  if (key.length < 20) {
    return { ok: false, error: 'Key vazia ou muito curta. Cole a key completa do OpenRouter.' };
  }

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE}/key`, {
      method: 'GET',
      headers: defaultHeaders(key),
    });
  } catch (err) {
    return { ok: false, error: `Falha de rede ao validar a key: ${(err as Error).message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error:
        'OpenRouter recusou a key. Verifique se copiou a key inteira (sk-or-...) e se ela esta ativa e com credito.',
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: describeOpenRouterError(res.status, body) };
  }

  const json = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  const d = json.data ?? {};
  return {
    ok: true,
    label: typeof d.label === 'string' ? d.label : undefined,
    usageUsd: typeof d.usage === 'number' ? d.usage : undefined,
    limitUsd: asNumberOrNull(d.limit),
    limitRemainingUsd: asNumberOrNull(d.limit_remaining),
    isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : undefined,
  };
}
