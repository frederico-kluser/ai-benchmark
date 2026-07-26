import { idbGet, idbGetAll, idbPut, idbPutMany } from './idb';
import type { LgpdData } from './lgpd';
import lgpdData from './data/lgpd-compliance.json';
import { startRun } from './engine/orchestrator';
import { startTraining } from './engine/trainer';
import { generateContestants, generateBasePrompt as engineGenerateBasePrompt } from './engine/variator';
import { listModels, validateKey as engineValidateKey, currentConcurrency } from './engine/openrouter';
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
import {
  savePrompt as engineSavePrompt,
  updatePrompt as engineUpdatePrompt,
  getPrompt as engineGetPrompt,
  listPrompts as engineListPrompts,
  deletePrompt as engineDeletePrompt,
} from './engine/promptStore';
import { parseScenarioPack } from './engine/scenarioPack';
import { parseArenaConfig, type ArenaConfigFile } from './engine/configFile';

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: { prompt: number; completion: number };
  /** `supported_parameters` do OpenRouter — usado p/ determinismo por modelo. */
  supportedParameters?: string[];
}

export type RunMode = 'compare' | 'variation' | 'training';

/** Nivel de esforco de raciocinio: off = desligado; low..max = budgets crescentes. */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** Reasoning por papel da run; papel ausente = desligado. */
export interface ReasoningConfig {
  competitor?: ReasoningLevel;
  judge?: ReasoningLevel;
  rewriter?: ReasoningLevel;
  datagen?: ReasoningLevel;
}

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
  /** Override de temperatura deste contestant (compare-llms). Default 0. */
  temperature?: number;
  /** Nivel de reasoning deste contestant (compare-llms; identidade = tripla modelo/temp/reasoning). */
  reasoningLevel?: ReasoningLevel;
}

/** Tecnica exposta por GET /techniques (sem o meta-prompt). */
export interface Technique {
  id: string;
  name: string;
  /** Nivel de confianca da evidencia: alta/media/baixa. */
  confidence?: 'alta' | 'media' | 'baixa';
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
  // evolucao de prompts / compare-llms:
  /** Reasoning (esforco) por papel: competitor/judge/rewriter/datagen. */
  reasoning?: ReasoningConfig;
  /** Modelo que gera os gabaritos (respostas de referencia). Default = 1o juiz. */
  referenceModelId?: string;
  /** Julgamento por referencia (pointwise vs gabarito + duelos). */
  referenceJudging?: boolean;
  /** Descricao detalhada do que testar — guia o datagen. */
  scenarioBrief?: string;
  /** Cenarios importados de pacote JSON (seed). */
  scenarioSeed?: StageSpec[];
  /** compare-llms: variantes de config {modelo, temp, reasoning}. */
  competitorConfigs?: { modelId: string; temperature?: number; reasoningLevel?: ReasoningLevel }[];
  /** training: margem minima de ganho (pp) p/ promover; sem ganho = convergiu. Default 1.0. */
  minGain?: number;
  /** training: liga duelos pairwise (Copeland). */
  duels?: boolean;
  /** training: top-K do bracket de duelos (0 = round-robin completo). Default 5. */
  duelTopK?: number;
  /** training: fracao de cenarios p/ holdout (clamp [0, 0.5]). Default 0.2. */
  holdoutRatio?: number;
  /** training: variantes recebem licoes das falhas do campeao (GEPA). */
  feedbackDriven?: boolean;
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
  /** Gabarito: resposta de referencia ideal (juiz pointwise + duelos). */
  reference?: string;
  /** Proveniencia da etapa: gerada pela IA ou importada de pacote JSON. */
  origin?: 'ai' | 'import';
}

/** Veredito ternario: resolve / parcial / nao. */
export type Verdict = 'resolve' | 'parcial' | 'nao';

export interface JudgeVerdict {
  contestantId: string;
  /** Veredito ternario: resolve / parcial / nao. */
  verdict: Verdict;
  /** Justificativa gerada ANTES da classificacao (estilo G-Eval). */
  motivo: string;
  /** @deprecated compat: records antigos guardavam so o binario. */
  acceptable?: boolean;
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
  /** Aceitavel por contestant = maioria dos juizes (derivado do ternario). */
  acceptableByContestant: Record<string, boolean>;
  /** Veredito ternario agregado por contestant (consenso). Ausente em records antigos. */
  verdictByContestant?: Record<string, Verdict>;
  /** Resultado individual de cada juiz. */
  judges: SingleJudgeResult[];
  blindMap: Record<string, string>;
  rawJudgeText: string;
  inconclusive?: boolean;
}

/** Julgamento pointwise contra o gabarito (`StageSpec.reference`). Base do judge-score. */
export interface ReferenceJudgeResult {
  /** Veredito ternario por contestant (consenso entre juizes, quando ha mais de um). */
  verdictByContestant: Record<string, Verdict>;
  /** Explicacao curta (1 frase) por contestant. */
  explanationByContestant: Record<string, string>;
  judgeModelId: string;
  inconclusive?: boolean;
}

/** Resultado de UM duelo pairwise (2 ordens; desacordo entre ordens = empate). */
export interface DuelOutcome {
  a: string;
  b: string;
  order1: { winner: 'a' | 'b' | 'tie'; explanation: string };
  order2: { winner: 'a' | 'b' | 'tie'; explanation: string };
  /** Resultado combinado das 2 ordens. */
  outcome: 'a' | 'b' | 'tie';
}

/** Duelos round-robin da etapa (bracket top-K): placar Copeland, placements fracionarios em empate. */
export interface StageDuels {
  /** Placement final por contestant (1 = melhor; fracionario em empate). */
  placementByContestant: Record<string, number>;
  /** ContestantIds ordenados do melhor ao pior placement. */
  order: string[];
  /** Pontos Copeland por contestant (vitoria 1, empate 0.5). */
  points: Record<string, number>;
  duels: DuelOutcome[];
  /** Tamanho do bracket usado (0 = round-robin completo). */
  topK: number;
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
  /** Julgamento pointwise contra o gabarito (quando a etapa tem `reference`). */
  referenceJudge?: ReferenceJudgeResult;
  /** Duelos pairwise (Copeland) da etapa (quando duelos ligados). */
  duels?: StageDuels;
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
  /** Judge-score agregado por contestant: (resolve + 0.5*parcial) / total * 100. */
  judgeScoreByContestant?: Record<string, number>;
  /** Classificacao final agregada (Copeland dos duelos / pontos do placar). */
  standings?: {
    id: string;
    label: string;
    isControl: boolean;
    points: number;
    wins: number;
    ties: number;
    losses: number;
    winRate: number;
  }[];
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
        reasoningLevel: cfg.reasoning?.rewriter,
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

/**
 * Gera um system prompt base a partir de uma descricao de tarefa (client-side).
 * Preenche o campo do prompt base no assistente — que roda como controle.
 */
export async function generateBasePrompt(
  taskDescription: string,
  modelId: string,
  theme?: string,
): Promise<string> {
  return engineGenerateBasePrompt({ apiKey: getStoredKey(), modelId, taskDescription, theme });
}

// -------------- Telemetria / subscricao ao vivo (cockpit de treino) --------------

/** Estado atual do limitador global de concorrencia (barra de paralelismo). */
export function getConcurrency(): { limit: number; active: number; queued: number } {
  return currentConcurrency();
}

/** Record vivo (em memoria) de um run — semeia a iteracao corrente na cockpit. */
export function getLiveRun(id: string): RunRecord | undefined {
  return getRunRecord(id) as unknown as RunRecord | undefined;
}

/**
 * Assina os eventos de um run vivo (sem snapshot inicial). A cockpit de treino
 * assina a iteracao corrente e NAO perde o `run.started` mesmo assinando antes
 * de ele emitir (diferente de openRunStream, que exige o record ja em memoria).
 */
export function subscribeRunLive(id: string, onEvent: (e: any) => void): () => void {
  return subscribeRun(id, onEvent as any);
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
  /** Retrocompat: no de OUROS da vencedora (antes era pontos aditivos do placar). */
  score: number;
  /** Quadro de medalhas da vencedora: [0]=ouro,[1]=prata,[2]=bronze,... */
  medals?: number[];
  golds?: number;
  silvers?: number;
  bronzes?: number;
}

export interface SessionRecord {
  id: string;
  status: RunRecord['status'];
  config: RunConfig;
  runIds: string[];
  /** Cenarios congelados apos a iteracao 0 (benchmark pinado). */
  pinnedStages?: StageSpec[];
  bestPromptByIteration: SessionIterationSummary[];
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Gate de holdout: re-score campeao vs controle nos cenarios reservados. */
  holdout?: {
    n: number;
    controlScore: number;
    championScore: number;
    gain: number;
    regressed: boolean;
  };
  /** Significancia estatistica (bootstrap pareado). null = amostra insuficiente. */
  significance?: {
    n: number;
    meanDiffPp: number;
    ci95Pp: [number, number];
    pValue: number;
  } | null;
  /** Iteracao em que o treino convergiu (ganho < minGain), quando parou antes do fim. */
  convergedAtIteration?: number;
}

/** Prompt versionado da biblioteca local no IndexedDB (nova versao a cada promocao). */
export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
  version: number;
  /** Versoes anteriores (a versao corrente esta em `text`/`version`). */
  history: { version: number; text: string; savedAt: string; note?: string }[];
  /** Proveniencia do prompt. */
  origin?: {
    kind: 'training' | 'variation' | 'manual';
    sessionId?: string;
    runId?: string;
    techniqueId?: string;
    iteration?: number;
  };
  createdAt: string;
  updatedAt: string;
}

/** Pacote JSON de cenarios+gabaritos exportado ao fim da run (importavel como seed). */
export interface ScenarioPack {
  format: 'ai-benchmark-pack@1';
  theme: string;
  exportedAt: string;
  /** Prompt escolhido na exportacao (campeao ou base). */
  prompt: { text: string; source: 'champion' | 'base'; label?: string };
  scenarios: (StageSpec & { id: string })[];
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

// -------------- Biblioteca de prompts (IndexedDB, client-only) --------------

// Client-side-first: estes wrappers delegam direto ao engine (promptStore,
// store 'prompts' do IndexedDB) — não há backend envolvido. O versionamento é
// por TEXTO: mudar o texto cria versão nova no history; renomear não versiona.

export async function savePrompt(input: {
  name: string;
  text: string;
  origin?: SavedPrompt['origin'];
  note?: string;
}): Promise<SavedPrompt> {
  return engineSavePrompt(input);
}

export async function updatePrompt(
  id: string,
  input: { text?: string; name?: string; note?: string },
): Promise<SavedPrompt | undefined> {
  return engineUpdatePrompt(id, input);
}

export async function getPrompt(id: string): Promise<SavedPrompt | undefined> {
  return engineGetPrompt(id);
}

export async function listPrompts(): Promise<SavedPrompt[]> {
  return engineListPrompts();
}

export async function deletePrompt(id: string): Promise<void> {
  return engineDeletePrompt(id);
}

// -------------- Pacotes de cenários (export/import JSON) --------------

// Re-exportados do engine para a UI consumir só pela porta única (api.ts).
export { buildScenarioPack, parseScenarioPack, SCENARIO_PACK_FORMAT } from './engine/scenarioPack';

/** Baixa o pacote de cenários como arquivo JSON (Blob + <a download> temporário). */
export function downloadScenarioPack(pack: ScenarioPack): void {
  const slug =
    pack.theme
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pack';
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `arena-pack-${slug}-${ymd}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Lê um arquivo de pacote de cenários (input type=file). Nunca lança:
 * JSON inválido ou pacote malformado viram `{ ok: false, error }` em PT-BR.
 */
export async function readScenarioPackFile(
  file: File,
): Promise<{ ok: true; pack: ScenarioPack } | { ok: false; error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'Arquivo não é um JSON válido' };
  }
  return parseScenarioPack(json);
}

// -------------- Arquivo de configuração do assistente (arena-config@1) --------------

// Re-exportados do engine para a UI consumir só pela porta única (api.ts).
// ATENÇÃO: `export { ... } from '...'` NÃO cria binding local neste módulo —
// por isso parseArenaConfig/ArenaConfigFile também são importados no topo,
// para uso em readArenaConfigFile.
export { parseArenaConfig, arenaConfigSummary, ARENA_CONFIG_FORMAT } from './engine/configFile';
export type { ArenaConfigFile, ArenaConfigScenario } from './engine/configFile';

/**
 * Lê um arquivo de configuração do assistente Nova Run (input type=file).
 * Nunca lança: JSON inválido ou config malformada viram `{ ok: false, error }`
 * em PT-BR, para a UI exibir num banner.
 */
export async function readArenaConfigFile(
  file: File,
): Promise<{ ok: true; config: ArenaConfigFile } | { ok: false; error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'Arquivo não é um JSON válido' };
  }
  return parseArenaConfig(json);
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
