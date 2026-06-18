// Versão BROWSER da persistência (substitui o filesystem do Node por IndexedDB).
// O orchestrator/trainer chamam saveRun/saveSession; a UI lê via load/list.
// Mesma assinatura do storage do backend, então o engine portado roda sem mudança.

import { idbPut, idbGet, idbGetAll } from '../idb';
import { normalizeRunRecord } from './normalize';
import type { RunRecord, SessionRecord } from './types';

function runSummary(r: RunRecord) {
  const cfg = r.config as { theme?: string; stages?: number; competitorModelIds?: string[]; mode?: string };
  const n = r.contestants?.length ?? cfg?.competitorModelIds?.length ?? 0;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode ?? cfg?.mode ?? 'compare',
    theme: cfg?.theme ?? '',
    stages: cfg?.stages ?? r.stages?.length ?? 0,
    contestants: n,
    competitors: n,
    totalCostUsd: r.totalCostUsd ?? 0,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    sessionId: r.sessionId,
    iteration: r.iteration,
  };
}

function sessionSummary(s: SessionRecord) {
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

export async function saveRun(record: RunRecord): Promise<void> {
  await Promise.all([
    idbPut('runs', record as unknown as { id: string }),
    idbPut('runSummaries', runSummary(record)),
  ]);
}

export async function saveSession(record: SessionRecord): Promise<void> {
  await Promise.all([
    idbPut('sessions', record as unknown as { id: string }),
    idbPut('sessionSummaries', sessionSummary(record)),
  ]);
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  const raw = await idbGet<RunRecord>('runs', id);
  return raw ? normalizeRunRecord(raw) : null;
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  return (await idbGet<SessionRecord>('sessions', id)) ?? null;
}

export async function listRuns<T = unknown>(): Promise<T[]> {
  return idbGetAll<T>('runSummaries');
}

export async function listSessions<T = unknown>(): Promise<T[]> {
  return idbGetAll<T>('sessionSummaries');
}
