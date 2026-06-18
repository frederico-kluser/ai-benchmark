import { EventEmitter } from 'node:events';
import type { RunEvent, SessionEvent } from './types.js';

class Bus extends EventEmitter {}

const runBuses = new Map<string, Bus>();
const sessionBuses = new Map<string, Bus>();

function getOrCreate(map: Map<string, Bus>, key: string): Bus {
  let bus = map.get(key);
  if (!bus) {
    bus = new Bus();
    bus.setMaxListeners(50);
    map.set(key, bus);
  }
  return bus;
}

export function getBus(runId: string): Bus {
  return getOrCreate(runBuses, runId);
}

export function emitEvent(event: RunEvent): void {
  const bus = getBus(event.runId);
  bus.emit('event', event);
  if (event.type === 'run.finished' || event.type === 'run.error') {
    // mantemos o bus por um curto periodo para SSE consumir o ultimo evento
    setTimeout(() => runBuses.delete(event.runId), 5_000);
  }
}

export function subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
  const bus = getBus(runId);
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

// ---------------------------------------------------------------------------
// Barramento de sessao de treino (encadeia varias runs sob um sessionId)
// ---------------------------------------------------------------------------

export function getSessionBus(sessionId: string): Bus {
  return getOrCreate(sessionBuses, sessionId);
}

export function emitSessionEvent(event: SessionEvent): void {
  const bus = getSessionBus(event.sessionId);
  bus.emit('event', event);
  if (event.type === 'session.finished' || event.type === 'session.error') {
    setTimeout(() => sessionBuses.delete(event.sessionId), 5_000);
  }
}

export function subscribeSession(
  sessionId: string,
  listener: (e: SessionEvent) => void,
): () => void {
  const bus = getSessionBus(sessionId);
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
