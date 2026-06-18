import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeRunRecord } from './normalize.js';
import type { RunMode, RunRecord, SessionRecord } from './types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'runs');
const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'sessions');

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function fileFor(runId: string): string {
  return path.join(DATA_DIR, `${runId}.json`);
}

async function writeAtomic(target: string, data: string): Promise<void> {
  // tmp UNICO por escrita: duas escritas concorrentes nao podem mais
  // brigar pelo mesmo "<id>.json.tmp" (era a causa do ENOENT no rename,
  // que derrubava a run inteira quando varios competidores terminavam juntos).
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Serializa as escritas POR run. saveRun e chamado em paralelo (cada
// competidor salva ao terminar); sem fila as gravacoes se atropelam.
const saveQueues = new Map<string, Promise<unknown>>();

export async function saveRun(record: RunRecord): Promise<void> {
  await ensureDir();
  const target = fileFor(record.id);
  // snapshot sincrono: a fila persiste o estado na ordem das chamadas,
  // sem JSON corrompido por mutacao concorrente do record.
  const data = JSON.stringify(record, null, 2);

  const prev = saveQueues.get(record.id) ?? Promise.resolve();
  // segue a fila mesmo que a escrita anterior tenha falhado
  const job = prev.then(
    () => writeAtomic(target, data),
    () => writeAtomic(target, data),
  );
  saveQueues.set(record.id, job);
  try {
    await job;
  } finally {
    if (saveQueues.get(record.id) === job) saveQueues.delete(record.id);
  }
}

export async function loadRun(runId: string): Promise<RunRecord | null> {
  try {
    const data = await fs.readFile(fileFor(runId), 'utf-8');
    return normalizeRunRecord(JSON.parse(data));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface RunSummary {
  id: string;
  status: RunRecord['status'];
  mode: RunMode;
  theme: string;
  stages: number;
  /** Numero de contestants (modelos no compare; variantes no variation/training). */
  contestants: number;
  /** Alias retrocompativel de `contestants`. */
  competitors: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  iteration?: number;
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureDir();
  const files = await fs.readdir(DATA_DIR);
  const summaries: RunSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = await fs.readFile(path.join(DATA_DIR, f), 'utf-8');
      const r = normalizeRunRecord(JSON.parse(data));
      summaries.push({
        id: r.id,
        status: r.status,
        mode: r.mode,
        theme: r.config.theme,
        stages: r.config.stages,
        contestants: r.contestants.length,
        competitors: r.contestants.length,
        totalCostUsd: r.totalCostUsd,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        sessionId: r.sessionId,
        iteration: r.iteration,
      });
    } catch {
      // ignora arquivo corrompido
    }
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries;
}

export async function markOrphansAsAborted(): Promise<void> {
  const all = await listRuns();
  for (const s of all) {
    if (s.status === 'running') {
      const r = await loadRun(s.id);
      if (r && r.status === 'running') {
        r.status = 'aborted';
        r.finishedAt = new Date().toISOString();
        await saveRun(r);
      }
    }
  }
  // Sessoes de treino orfas (processo reiniciou no meio): tambem abortadas.
  const sessions = await listSessions();
  for (const s of sessions) {
    if (s.status === 'running') {
      const rec = await loadSession(s.id);
      if (rec && rec.status === 'running') {
        rec.status = 'aborted';
        rec.finishedAt = new Date().toISOString();
        await saveSession(rec);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sessoes de treino (data/sessions/<id>.json)
// ---------------------------------------------------------------------------

async function ensureSessionsDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionFileFor(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

const sessionSaveQueues = new Map<string, Promise<unknown>>();

export async function saveSession(record: SessionRecord): Promise<void> {
  await ensureSessionsDir();
  const target = sessionFileFor(record.id);
  const data = JSON.stringify(record, null, 2);
  const prev = sessionSaveQueues.get(record.id) ?? Promise.resolve();
  const job = prev.then(
    () => writeAtomic(target, data),
    () => writeAtomic(target, data),
  );
  sessionSaveQueues.set(record.id, job);
  try {
    await job;
  } finally {
    if (sessionSaveQueues.get(record.id) === job) sessionSaveQueues.delete(record.id);
  }
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  try {
    const data = await fs.readFile(sessionFileFor(id), 'utf-8');
    return JSON.parse(data) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface SessionSummary {
  id: string;
  status: SessionRecord['status'];
  theme: string;
  iterationsPlanned: number;
  iterationsDone: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureSessionsDir();
  const files = await fs.readdir(SESSIONS_DIR);
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = await fs.readFile(path.join(SESSIONS_DIR, f), 'utf-8');
      const r = JSON.parse(data) as SessionRecord;
      summaries.push({
        id: r.id,
        status: r.status,
        theme: r.config.theme,
        iterationsPlanned: r.config.iterations,
        iterationsDone: r.bestPromptByIteration?.length ?? 0,
        totalCostUsd: r.totalCostUsd,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      });
    } catch {
      // ignora arquivo corrompido
    }
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries;
}
