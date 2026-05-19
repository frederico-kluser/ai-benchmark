import { EventEmitter } from 'node:events';
import type { RunEvent } from './types.js';

class RunBus extends EventEmitter {}

const buses = new Map<string, RunBus>();

export function getBus(runId: string): RunBus {
  let bus = buses.get(runId);
  if (!bus) {
    bus = new RunBus();
    bus.setMaxListeners(50);
    buses.set(runId, bus);
  }
  return bus;
}

export function emitEvent(event: RunEvent): void {
  const bus = getBus(event.runId);
  bus.emit('event', event);
  if (event.type === 'run.finished' || event.type === 'run.error') {
    // mantemos o bus por um curto periodo para SSE consumir o ultimo evento
    setTimeout(() => buses.delete(event.runId), 5_000);
  }
}

export function subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
  const bus = getBus(runId);
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
