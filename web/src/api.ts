import { idbGet, idbGetAll, idbPut, idbPutMany } from './idb';
import type { LgpdData } from './lgpd';
import lgpdData from './data/lgpd-compliance.json';
import { startRun } from './engine/orchestrator';
import { startTraining } from './engine/trainer';
import { generateContestants } from './engine/variator';
import { listModels, validateKey as engineValidateKey } from './engine/openrouter';
import { listTechniques } from './engine/techniques';
import {
  subscribeRun,
  getRunRecord,
  cacheRunRecord,
  subscribeSession,
  getSessionRecord,
  cacheSessionRecord,
} from './engine/events';
import { loadRun, loadSession, listRuns as engineListRuns, listSessions as engineListSessions } from './engine/storage';

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: { prompt: number; completion: number };
  /** `supported_parameters` do OpenRouter — usado p/ determinismo por modelo. */
  supportedParameters?: string[];
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
  /** Perfil de conformidade LGPD (consultivo; gravado no record). Ausente = "livre". */
  compliance?: { area: string; includeRessalvas: boolean };
  /** Etapas fornecidas pelo usuario (JSON); pulam o datagen e fixam `stages`. */
  customStages?: StageSpec[];
  // meta:
  datagenModelId: string;
  /** Um ou mais juizes — rodam em paralelo. */
  judgeModelIds: string[];
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
  /** Criterio de corretude da etapa; injetado no juiz como rubrica ancorada. */
  rubric?: string;
}

export interface JudgeVerdict {
  contestantId: string;
  acceptable: boolean;
  /** Motivo curtissimo (<= 1 frase). */
  motivo: string;
}

export interface SingleJudgeResult {
  judgeModelId: string;
  rankedContestantIds: string[];
  verdicts: JudgeVerdict[];
  blindMap: Record<string, string>;
  inconclusive?: boolean;
}

export interface JudgeResult {
  /** Consenso entre juizes (posicao media): melhor -> pior. */
  rankedContestantIds: string[];
  /** Aceitavel por contestant = maioria dos juizes. */
  acceptableByContestant: Record<string, boolean>;
  /** Resultado individual de cada juiz. */
  judges: SingleJudgeResult[];
  blindMap: Record<string, string>;
  rawJudgeText: string;
  inconclusive?: boolean;
}

/** @deprecated Avaliador fundido no juiz; mantido p/ ler records antigos. */
export interface EvaluationVerdict {
  contestantId: string;
  acceptable: boolean;
  justification: string;
}

/** @deprecated Avaliador fundido no juiz; mantido p/ ler records antigos. */
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
  /** @deprecated Avaliador fundido no juiz. Presente so em records antigos. */
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
  // Client-side: valida direto contra o OpenRouter (GET /key).
  const r = await engineValidateKey(key);
  if (r.ok) {
    return {
      ok: true,
      label: r.label,
      usageUsd: r.usageUsd,
      limitUsd: r.limitUsd,
      limitRemainingUsd: r.limitRemainingUsd,
      isFreeTier: r.isFreeTier,
    };
  }
  return { ok: false, error: r.error };
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  // Client-side: catálogo direto do OpenRouter (/models é público; usa a key p/ conta).
  return (await listModels(getStoredKey())) as unknown as OpenRouterModel[];
}

export async function createRun(config: RunConfig): Promise<string> {
  // Client-side: o run roda na própria aba (engine). Para variação, as variantes
  // são geradas via "optimizer" antes do loop (igual ao prepare do backend).
  const apiKey = getStoredKey();
  const cfg = config as Record<string, any>;
  const opts: Record<string, unknown> = {};
  if (cfg.mode === 'variation') {
    const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
    const promptOptimization = cfg.promptOptimization !== false;
    opts.prepare = () =>
      generateContestants({
        apiKey,
        modelId: cfg.contestantModelId,
        theme: cfg.theme,
        basePrompt: cfg.basePrompt,
        originalPrompt: cfg.basePrompt,
        includeOriginal: Boolean(cfg.basePrompt && String(cfg.basePrompt).trim()),
        techniqueIds: cfg.techniqueIds,
        manualVariants: cfg.manualVariants,
        promptOptimization,
        optimizerModelId,
        timeoutMs: cfg.timeoutMs,
      });
  }
  const { runId, record } = startRun(config as never, apiKey, opts as never);
  cacheRunRecord(record);
  return runId;
}

export async function fetchTechniques(): Promise<Technique[]> {
  return listTechniques() as unknown as Technique[];
}

export async function fetchLgpd(): Promise<LgpdData> {
  // Client-side: a base de conhecimento LGPD é empacotada no bundle.
  return lgpdData as unknown as LgpdData;
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
  // Client-side: a sessão de treino roda na própria aba (engine trainer).
  const { sessionId, record } = await startTraining(config as never, getStoredKey());
  cacheSessionRecord(record);
  return sessionId;
}

export async function fetchSession(id: string): Promise<SessionRecord> {
  const live = getSessionRecord(id);
  if (live) {
    void cacheSession(live as unknown as SessionRecord);
    return live as unknown as SessionRecord;
  }
  const rec = await loadSession(id);
  if (rec) return rec as unknown as SessionRecord;
  throw new Error('Sessão não encontrada');
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
  return await engineListSessions<SessionSummary>();
}

export function openSessionStream(
  id: string,
  onEvent: (e: any) => void,
  _onError?: (err: Event) => void,
): () => void {
  // Client-side: assina o barramento em memória da sessão (sem SSE).
  const live = getSessionRecord(id);
  if (live) {
    onEvent({ type: 'snapshot', record: live });
    if (['finished', 'error', 'aborted'].includes(live.status)) return () => undefined;
    return subscribeSession(id, onEvent);
  }
  let active = true;
  void loadSession(id).then((rec) => {
    if (active && rec) onEvent({ type: 'snapshot', record: rec });
  });
  return () => {
    active = false;
  };
}

// -------------- Cache local (IndexedDB) --------------

function summaryFromRecord(r: RunRecord): RunSummary {
  const n = r.contestants?.length ?? r.config?.competitorModelIds?.length ?? 0;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode ?? r.config?.mode ?? 'compare',
    theme: r.config?.theme ?? '',
    stages: r.config?.stages ?? r.stages?.length ?? 0,
    contestants: n,
    competitors: n,
    totalCostUsd: r.totalCostUsd ?? 0,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    sessionId: r.sessionId,
    iteration: r.iteration,
  };
}

function summaryFromSession(s: SessionRecord): SessionSummary {
  return {
    id: s.id,
    status: s.status,
    theme: s.config?.theme ?? '',
    iterationsPlanned: s.config?.iterations ?? 0,
    iterationsDone: s.bestPromptByIteration?.length ?? 0,
    totalCostUsd: s.totalCostUsd ?? 0,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
  };
}

/** Persiste uma run completa no cache local (chamado ao carregar/finalizar). */
export async function cacheRun(r: RunRecord): Promise<void> {
  if (!r?.id) return;
  await Promise.all([idbPut('runs', r), idbPut('runSummaries', summaryFromRecord(r))]);
}

/** Persiste uma sessão completa no cache local. */
export async function cacheSession(s: SessionRecord): Promise<void> {
  if (!s?.id) return;
  await Promise.all([idbPut('sessions', s), idbPut('sessionSummaries', summaryFromSession(s))]);
}

export async function fetchRuns(): Promise<RunSummary[]> {
  return await engineListRuns<RunSummary>();
}

export async function fetchRun(id: string): Promise<RunRecord> {
  const live = getRunRecord(id);
  if (live) {
    void cacheRun(live as unknown as RunRecord);
    return live as unknown as RunRecord;
  }
  const rec = await loadRun(id);
  if (rec) return rec as unknown as RunRecord;
  throw new Error('Run nao encontrada');
}

const TERMINAL_RUN_STATUSES = ['finished', 'error', 'aborted'];

export function openRunStream(
  id: string,
  onEvent: (e: any) => void,
  _onError?: (err: Event) => void,
): () => void {
  // Client-side: assina o barramento em memória do run (sem SSE). Snapshot
  // imediato do record vivo + eventos subsequentes; se já terminou, snapshot +
  // evento terminal a partir do IndexedDB.
  const live = getRunRecord(id);
  if (live) {
    onEvent({ type: 'snapshot', record: live });
    if (TERMINAL_RUN_STATUSES.includes(live.status)) return () => undefined;
    return subscribeRun(id, onEvent);
  }
  let active = true;
  void loadRun(id).then((rec) => {
    if (!active || !rec) return;
    onEvent({ type: 'snapshot', record: rec });
    if (rec.status === 'error') {
      onEvent({ type: 'run.error', runId: id, error: rec.error ?? 'Run terminou com erro.' });
    } else if (TERMINAL_RUN_STATUSES.includes(rec.status)) {
      onEvent({ type: 'run.finished', runId: id, record: rec });
    }
  });
  return () => {
    active = false;
  };
}
