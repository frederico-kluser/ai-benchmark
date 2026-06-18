import type { OpenRouterModel } from './types';

// Permite apontar para um gateway compativel com a OpenRouter (proxy
// corporativo, mock de teste). Default: API publica da OpenRouter.
// Client-side: chama o OpenRouter direto do navegador (CORS liberado).
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const APP_ORIGIN =
  typeof window !== 'undefined' ? window.location.origin : 'https://ai-benchmark';
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function defaultHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': APP_ORIGIN,
    'X-Title': 'Benchmark Arena',
  };
}

// cache por key (sufixo curto) pra nao misturar contas
const modelsCache = new Map<string, { fetchedAt: number; data: OpenRouterModel[] }>();

function cacheKey(apiKey: string): string {
  return apiKey.slice(-12);
}

// ---------------------------------------------------------------------------
// Determinismo POR MODELO. Reasoning models (gpt-5*, serie o*) REJEITAM
// temperature != 1 (HTTP 400 -> resposta vazia, foi o bug do gpt-5-nano).
// Decidimos quais parametros de amostragem enviar pelo `supported_parameters`
// do OpenRouter (fonte de verdade, ja em cache via listModels); sem isso,
// caimos numa heuristica por nome. So enviamos temperature/seed a quem
// suporta — buscando o MAXIMO de determinismo que cada modelo permite.
// ---------------------------------------------------------------------------
const DETERMINISTIC_SEED = 1234;

function cachedModel(apiKey: string, modelId: string): OpenRouterModel | undefined {
  return modelsCache.get(cacheKey(apiKey))?.data.find((m) => m.id === modelId);
}

function looksLikeReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes('gpt-5-chat')) return false; // a variante chat aceita temperature
  // OpenAI serie o (o1..o4) e GPT-5 reasoning rejeitam temperature != 1.
  return /(^|\/)(o[1-4]([.\-]|$)|gpt-5|gpt-oss)/.test(id);
}

/**
 * Monta os parametros de amostragem com determinismo na medida que cada modelo
 * permite. So inclui temperature/seed quando o modelo os suporta — senao
 * reasoning models respondem vazio. `desiredTemperature` (default 0) e usado
 * apenas onde temperature e aceita.
 */
function deterministicSampling(
  apiKey: string,
  modelId: string,
  desiredTemperature: number,
): { temperature?: number; seed?: number } {
  const supported = cachedModel(apiKey, modelId)?.supportedParameters;
  if (supported && supported.length > 0) {
    const out: { temperature?: number; seed?: number } = {};
    if (supported.includes('temperature')) out.temperature = desiredTemperature;
    if (supported.includes('seed')) out.seed = DETERMINISTIC_SEED;
    return out;
  }
  // sem metadados de suporte: omite temperature em reasoning (seed desconhecido).
  return looksLikeReasoning(modelId) ? {} : { temperature: desiredTemperature };
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

// ---------------------------------------------------------------------------
// Limitador GLOBAL de concorrencia (adaptativo, AIMD) + retry com backoff.
// TODA chamada de geracao passa por guardedFetch (chatCompletion/Stream), entao
// datagen, competidores, juiz, avaliador, optimizer e variator compartilham UM
// unico semaforo. O limite CRESCE no sucesso (quando ha pressao) e RECUA pela
// metade quando o OpenRouter devolve 429 — converge para o maximo que o
// provedor aguenta, "brigando" para rodar no teto sem derrubar com 429.
// Teto via env OPENROUTER_MAX_CONCURRENCY (default 32).
// ---------------------------------------------------------------------------
const MAX_CONCURRENCY = 32;
const MIN_CONCURRENCY = 1;
const MAX_RETRIES = 6;

let concurrencyLimit = Math.min(8, MAX_CONCURRENCY);
let activeCalls = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCalls < concurrencyLimit) {
    activeCalls += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  activeCalls -= 1;
  while (waiters.length > 0 && activeCalls < concurrencyLimit) {
    const next = waiters.shift()!;
    activeCalls += 1;
    next();
  }
}

// Cresce so quando ha pressao (saturado ou com fila), ate o teto.
function noteSuccess(): void {
  if (concurrencyLimit < MAX_CONCURRENCY && (activeCalls >= concurrencyLimit || waiters.length > 0)) {
    concurrencyLimit += 1;
  }
}

function noteRateLimit(): void {
  concurrencyLimit = Math.max(MIN_CONCURRENCY, Math.floor(concurrencyLimit / 2));
}

/** Limite atual de concorrencia (para logs/telemetria). */
export function currentConcurrency(): { limit: number; active: number; queued: number } {
  return { limit: concurrencyLimit, active: activeCalls, queued: waiters.length };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250); // jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GuardedResponse {
  res: Response;
  startedAt: number;
  /** Libera o slot do limitador; passe ok=true se a leitura do corpo concluiu. */
  finish: (ok: boolean) => void;
}

/**
 * fetch sob o limitador global, com timeout/abort por tentativa e retry com
 * backoff em 429/5xx/rede. Em 429 reduz o limite (AIMD). Retorna a Response OK
 * SEGURANDO o slot — o chamador DEVE chamar finish() apos ler o corpo.
 */
async function guardedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<GuardedResponse> {
  let attempt = 0;
  for (;;) {
    await acquireSlot();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    };

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      cleanup();
      releaseSlot();
      // abort (timeout/externo) nao repete; erro de rede repete com backoff.
      if (controller.signal.aborted || attempt >= MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      attempt += 1;
      continue;
    }

    if (!res.ok) {
      const status = res.status;
      if (isRetryableStatus(status) && attempt < MAX_RETRIES && !externalSignal?.aborted) {
        if (status === 429) noteRateLimit();
        await res.body?.cancel().catch(() => undefined);
        cleanup();
        releaseSlot();
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      const errText = await res.text().catch(() => '');
      cleanup();
      releaseSlot();
      throw new Error(describeOpenRouterError(status, errText));
    }

    // OK: segura o slot ate o chamador terminar de ler o corpo.
    return {
      res,
      startedAt,
      finish: (ok: boolean) => {
        if (ok) noteSuccess();
        cleanup();
        releaseSlot();
      },
    };
  }
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
      supportedParameters: Array.isArray(item.supported_parameters)
        ? (item.supported_parameters as unknown[]).map((p) => String(p))
        : undefined,
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

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    ...deterministicSampling(apiKey, modelId, temperature),
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }
  if (responseFormatJson) {
    body.response_format = { type: 'json_object' };
  }

  const { res, startedAt, finish } = await guardedFetch(
    `${OPENROUTER_BASE}/chat/completions`,
    { method: 'POST', headers: defaultHeaders(apiKey), body: JSON.stringify(body) },
    timeoutMs,
    externalSignal,
  );

  let ok = false;
  try {
    const latencyMs = Date.now() - startedAt;
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: string | number };
    };

    const text = json.choices?.[0]?.message?.content ?? '';
    // OpenRouter as vezes devolve 200 com um corpo de erro (ex.: provider
    // rejeitou um parametro). Sem isto a falha viraria "resposta vazia" muda.
    if (!text && json.error) {
      throw new Error(`OpenRouter: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    const tokensIn = json.usage?.prompt_tokens ?? 0;
    const tokensOut = json.usage?.completion_tokens ?? 0;

    ok = true;
    return { text, tokensIn, tokensOut, latencyMs, raw: json };
  } finally {
    finish(ok);
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

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    ...deterministicSampling(apiKey, modelId, temperature),
    stream: true,
    usage: { include: true },
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
  if (responseFormatJson) body.response_format = { type: 'json_object' };

  const { res, startedAt, finish } = await guardedFetch(
    `${OPENROUTER_BASE}/chat/completions`,
    { method: 'POST', headers: defaultHeaders(apiKey), body: JSON.stringify(body) },
    timeoutMs,
    externalSignal,
  );

  let ok = false;
  let fullText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let lastRaw: unknown = null;
  let streamError: string | null = null;

  try {
    if (!res.body) throw new Error('OpenRouter retornou stream sem corpo de resposta.');
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
            error?: { message?: string };
          };
          lastRaw = chunk;
          if (chunk.error && !streamError) {
            streamError = chunk.error.message ?? JSON.stringify(chunk.error);
          }
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

    // Resposta vazia + erro in-band (provider rejeitou parametro etc.): falha alto.
    if (!fullText && streamError) throw new Error(`OpenRouter: ${streamError}`);

    const latencyMs = Date.now() - startedAt;
    ok = true;
    return { text: fullText, tokensIn, tokensOut, latencyMs, raw: lastRaw };
  } finally {
    finish(ok);
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
