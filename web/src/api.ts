export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: { prompt: number; completion: number };
}

export type RunMode = 'compare' | 'variation' | 'training';

export interface ManualVariant {
  label: string;
  systemPrompt: string;
}

export interface Contestant {
  id: string;
  label: string;
  modelId: string;
  systemPrompt?: string;
  techniqueId?: string;
  isOriginal?: boolean;
  parentContestantId?: string;
}

/** Tecnica exposta por GET /techniques (sem o meta-prompt). */
export interface Technique {
  id: string;
  name: string;
  good: string;
  bad: string;
}

export interface RunConfig {
  mode?: RunMode;
  theme: string;
  stages: number;
  // compare:
  competitorModelIds?: string[];
  // variation/training:
  contestantModelId?: string;
  basePrompt?: string;
  promptOptimization?: boolean;
  techniqueIds?: string[];
  manualVariants?: ManualVariant[];
  optimizerModelId?: string;
  judgePasses?: 1 | 2;
  iterations?: number;
  // meta:
  datagenModelId: string;
  judgeModelId: string;
  concurrency?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface CompetitorResponse {
  contestantId: string;
  modelId: string;
  text: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: 'ok' | 'error';
  errorMsg?: string;
}

export interface StageSpec {
  question: string;
  productContext: string;
  maxTokens: number;
}

export interface JudgeResult {
  rankedContestantIds: string[];
  blindMap: Record<string, string>;
  rawJudgeText: string;
  inconclusive?: boolean;
}

export interface EvaluationVerdict {
  contestantId: string;
  acceptable: boolean;
  justification: string;
}

export interface StageEvaluation {
  bestContestantId: string;
  bestReasons: string;
  verdicts: EvaluationVerdict[];
  blindMap: Record<string, string>;
  raw: string;
  inconclusive?: boolean;
}

export interface StageRecord {
  index: number;
  spec?: StageSpec;
  responses: CompetitorResponse[];
  live?: Record<string, CompetitorLiveState>;
  judge?: JudgeResult;
  /** Avaliacao qualitativa paralela: motivos do vencedor + aceitabilidade. */
  evaluation?: StageEvaluation;
  /** Preenchido quando a etapa falhou (datagen/imprevisto) e foi pulada. */
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface CompetitorLiveState {
  contestantId: string;
  modelId: string;
  label?: string;
  startedAt: number;
  chars: number;
  charsPerSec: number;
  preview: string;
  done: boolean;
}

export interface RunRecord {
  id: string;
  status: 'running' | 'finished' | 'error' | 'aborted';
  config: RunConfig;
  mode?: RunMode;
  contestants?: Contestant[];
  stages: StageRecord[];
  scoreboard: Record<string, number>;
  costByContestant?: Record<string, number>;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  sessionId?: string;
  iteration?: number;
  parentRunId?: string;
}

export interface RunSummary {
  id: string;
  status: RunRecord['status'];
  mode?: RunMode;
  theme: string;
  stages: number;
  contestants?: number;
  competitors: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  iteration?: number;
}

// -------------- Contestant helpers (retrocompat: 1 ponto de verdade) --------------

export function runMode(record: RunRecord): RunMode {
  return record.mode ?? record.config?.mode ?? 'compare';
}

/** Lista de contestants do record; deriva de competitorModelIds em runs antigas. */
export function normalizeContestants(record: RunRecord): Contestant[] {
  if (record.contestants && record.contestants.length) return record.contestants;
  const ids = record.config?.competitorModelIds ?? [];
  return ids.map((id) => ({ id, label: id, modelId: id }));
}

// -------------- API key (localStorage) --------------

const KEY_STORAGE = 'openrouter_api_key';

export function getStoredKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setStoredKey(key: string): void {
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

function authHeaders(): Record<string, string> {
  const key = getStoredKey();
  return key ? { 'x-openrouter-key': key } : {};
}

// -------------- Calls --------------

export interface ValidateKeyResponse {
  ok: boolean;
  error?: string;
  /** Metadados retornados por GET /api/v1/key quando a key e valida. */
  label?: string;
  usageUsd?: number;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  isFreeTier?: boolean;
}

export async function validateKey(key: string): Promise<ValidateKeyResponse> {
  try {
    const res = await fetch('/v1/benchmark/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrouter-key': key },
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as ValidateKeyResponse;
    if (!json.ok) console.error('[validateKey] invalida:', json.error);
    return json;
  } catch (err) {
    console.error('[validateKey] erro de rede:', err);
    throw err;
  }
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  const res = await fetch('/v1/benchmark/models', { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = res.status === 401
      ? 'Key invalida. Reconfigure a key OpenRouter.'
      : `Falha ao listar modelos (${res.status})`;
    console.error('[fetchModels]', msg, body);
    throw new Error(msg);
  }
  const json = (await res.json()) as { data: OpenRouterModel[] };
  return json.data;
}

export async function createRun(config: RunConfig): Promise<string> {
  const res = await fetch('/v1/benchmark/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    console.error('[createRun] falhou:', err);
    throw new Error(err.error ?? 'Falha ao criar run');
  }
  const json = (await res.json()) as { runId: string };
  return json.runId;
}

export async function fetchTechniques(): Promise<Technique[]> {
  const res = await fetch('/v1/benchmark/techniques');
  if (!res.ok) throw new Error('Falha ao listar técnicas');
  const json = (await res.json()) as { data: Technique[] };
  return json.data;
}

// -------------- Sessões de treino --------------

export interface SessionIterationSummary {
  iteration: number;
  runId: string;
  winnerContestantId: string;
  systemPrompt: string;
  score: number;
}

export interface SessionRecord {
  id: string;
  status: RunRecord['status'];
  config: RunConfig;
  runIds: string[];
  bestPromptByIteration: SessionIterationSummary[];
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export async function createSession(config: RunConfig): Promise<string> {
  const res = await fetch('/v1/benchmark/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    console.error('[createSession] falhou:', err);
    throw new Error(err.error ?? 'Falha ao criar sessão de treino');
  }
  const json = (await res.json()) as { sessionId: string };
  return json.sessionId;
}

export async function fetchSession(id: string): Promise<SessionRecord> {
  const res = await fetch(`/v1/benchmark/sessions/${id}`);
  if (!res.ok) throw new Error('Sessão não encontrada');
  return (await res.json()) as SessionRecord;
}

export interface SessionSummary {
  id: string;
  status: RunRecord['status'];
  theme: string;
  iterationsPlanned: number;
  iterationsDone: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/v1/benchmark/sessions');
  if (!res.ok) throw new Error('Falha ao listar sessões');
  const json = (await res.json()) as { data: SessionSummary[] };
  return json.data;
}

export function openSessionStream(
  id: string,
  onEvent: (e: any) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource(`/v1/benchmark/sessions/${id}/events`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      onEvent(event);
      const terminal =
        event.type === 'session.finished' ||
        event.type === 'session.error' ||
        (event.type === 'snapshot' &&
          ['finished', 'error', 'aborted'].includes(event.record?.status));
      if (terminal) close();
    } catch (err) {
      console.error('[session SSE parse]', err, msg.data);
    }
  };
  es.onerror = (err) => {
    if (closed) return;
    onError?.(err);
  };
  return close;
}

export async function fetchRuns(): Promise<RunSummary[]> {
  const res = await fetch('/v1/benchmark/runs');
  if (!res.ok) {
    console.error('[fetchRuns] falhou:', res.status);
    throw new Error('Falha ao listar runs');
  }
  const json = (await res.json()) as { data: RunSummary[] };
  return json.data;
}

export async function fetchRun(id: string): Promise<RunRecord> {
  const res = await fetch(`/v1/benchmark/runs/${id}`);
  if (!res.ok) {
    console.error('[fetchRun] falhou:', res.status);
    throw new Error('Run nao encontrada');
  }
  return (await res.json()) as RunRecord;
}

const TERMINAL_RUN_STATUSES = ['finished', 'error', 'aborted'];

export function openRunStream(
  id: string,
  onEvent: (e: any) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource(`/v1/benchmark/runs/${id}/events`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };

  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      // log estruturado no console do navegador (visibilidade no DevTools)
      const s =
        typeof event.stageIndex === 'number' ? `etapa ${event.stageIndex + 1}` : '';
      switch (event.type) {
        case 'snapshot':
          console.info('[bench] conectado ao stream', `(status: ${event.record?.status})`);
          break;
        case 'run.started':
          console.info('[bench] run iniciada');
          break;
        case 'stage.generating':
          console.info(`[bench] ${s}: gerando cenário…`);
          break;
        case 'stage.generated':
          // conteúdo COMPLETO de cada geração no console do Chrome
          console.groupCollapsed(`[bench] ${s}: cenário gerado`);
          console.info('pergunta:', event.spec?.question);
          console.info('contexto de produto:', event.spec?.productContext);
          console.info('maxTokens sugerido:', event.spec?.maxTokens);
          console.groupEnd();
          break;
        case 'stage.failed':
          console.warn(`[bench] ${s}: PULADA — ${event.error}`);
          break;
        case 'competitor.progress':
          console.debug(
            `[bench] ${s} ${event.contestantId ?? event.modelId}: ${event.chars} chars (${event.charsPerSec?.toFixed?.(0)} ch/s)`,
          );
          break;
        case 'competitor.finished':
          if (event.response?.status === 'error') {
            console.error(
              `[bench] ${s} ${event.response.contestantId ?? event.response.modelId}: ERRO — ${event.response.errorMsg}`,
            );
          } else {
            console.info(
              `[bench] ${s} ${event.response?.contestantId ?? event.response?.modelId}: ok (${event.response?.tokensOut} tok)`,
            );
          }
          break;
        case 'stage.judged': {
          const ev = event.evaluation;
          console.groupCollapsed(
            `[bench] ${s}: julgada${event.judge?.inconclusive ? ' (inconclusiva)' : ''}`,
          );
          console.info('ranking (melhor→pior):', event.judge?.rankedContestantIds);
          if (ev && !ev.inconclusive) {
            console.info('vencedor (avaliação):', ev.bestContestantId);
            console.info('motivos do vencedor:', ev.bestReasons);
            for (const v of ev.verdicts ?? []) {
              console.info(
                `${v.acceptable ? '✅ aceitável' : '❌ não aceitável'} — ${v.contestantId}: ${v.justification}`,
              );
            }
          } else if (ev?.inconclusive) {
            console.warn('avaliação inconclusiva:', ev.raw);
          }
          console.groupEnd();
          break;
        }
        case 'run.finished':
          console.info(`[bench] run finalizada (status: ${event.record?.status})`);
          break;
        case 'run.error':
          console.error('[bench] run.error:', event.error);
          break;
      }
      onEvent(event);

      // A run acabou: feche o EventSource. Sem isso o browser reconecta
      // infinitamente (o servidor da res.end() em runs terminais), gerando
      // a enxurrada de "[SSE connection error]" no console.
      const isTerminal =
        event.type === 'run.finished' ||
        event.type === 'run.error' ||
        (event.type === 'snapshot' &&
          TERMINAL_RUN_STATUSES.includes(event.record?.status));
      if (isTerminal) close();
    } catch (err) {
      console.error('[SSE parse error]', err, msg.data);
    }
  };
  es.onerror = (err) => {
    if (closed) return; // fechamento intencional pos-run, nao e erro
    console.error('[SSE connection error]', err);
    onError?.(err);
  };
  return close;
}
