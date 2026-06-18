// Versão BROWSER do barramento de eventos (substitui o EventEmitter do Node).
// O orchestrator/trainer chamam emitEvent/emitSessionEvent; a UI assina via
// subscribeRun/subscribeSession. Também guardamos a referência do `record` vivo
// (o mesmo objeto que o orchestrator vai mutando) para servir o "snapshot"
// imediato a quem assina no meio da run — sem corrida e sem SSE.

import type { RunEvent, SessionEvent, RunRecord, SessionRecord } from './types';

type RunListener = (e: RunEvent) => void;
type SessionListener = (e: SessionEvent) => void;

const runSubs = new Map<string, Set<RunListener>>();
const sessionSubs = new Map<string, Set<SessionListener>>();
const runRecords = new Map<string, RunRecord>();
const sessionRecords = new Map<string, SessionRecord>();

export function emitEvent(event: RunEvent): void {
  const rec = (event as { record?: RunRecord }).record;
  if (rec) runRecords.set(event.runId, rec);
  const subs = runSubs.get(event.runId);
  if (subs) for (const cb of [...subs]) { try { cb(event); } catch { /* listener ruim não derruba a run */ } }
}

export function subscribeRun(runId: string, cb: RunListener): () => void {
  let set = runSubs.get(runId);
  if (!set) { set = new Set(); runSubs.set(runId, set); }
  set.add(cb);
  return () => { set!.delete(cb); if (set!.size === 0) runSubs.delete(runId); };
}

/** Registra o record vivo (chamado no createRun, antes de qualquer evento). */
export function cacheRunRecord(record: RunRecord): void {
  runRecords.set(record.id, record);
}
export function getRunRecord(runId: string): RunRecord | undefined {
  return runRecords.get(runId);
}

export function emitSessionEvent(event: SessionEvent): void {
  const rec = (event as { record?: SessionRecord }).record;
  if (rec) sessionRecords.set(event.sessionId, rec);
  const subs = sessionSubs.get(event.sessionId);
  if (subs) for (const cb of [...subs]) { try { cb(event); } catch { /* idem */ } }
}

export function subscribeSession(sessionId: string, cb: SessionListener): () => void {
  let set = sessionSubs.get(sessionId);
  if (!set) { set = new Set(); sessionSubs.set(sessionId, set); }
  set.add(cb);
  return () => { set!.delete(cb); if (set!.size === 0) sessionSubs.delete(sessionId); };
}

export function cacheSessionRecord(record: SessionRecord): void {
  sessionRecords.set(record.id, record);
}
export function getSessionRecord(sessionId: string): SessionRecord | undefined {
  return sessionRecords.get(sessionId);
}
