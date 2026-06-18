import { createContext, useContext } from 'react';
import type { RunMode } from './api';

// Há 3 tutoriais, um por modo. Cada um dispara automaticamente na primeira vez
// que o usuário entra na tab daquele modo, e fica acessível pelo botão "?".
export type HelpTutorial = RunMode; // 'compare' | 'variation' | 'training'

export interface HelpApi {
  open: (t: HelpTutorial) => void;
}

export const HelpContext = createContext<HelpApi>({ open: () => {} });

export function useHelp(): HelpApi {
  return useContext(HelpContext);
}

const FIRST_OPEN_KEY = 'bench-first-open';
const SEEN_PREFIX = 'bench-tutorial-seen:';

/** Registra (uma única vez) quando o usuário abriu o app pela primeira vez. */
export function markFirstOpen(): void {
  try {
    if (!localStorage.getItem(FIRST_OPEN_KEY)) {
      localStorage.setItem(FIRST_OPEN_KEY, new Date().toISOString());
    }
  } catch {
    /* localStorage indisponível */
  }
}

export function getFirstOpen(): string | null {
  try {
    return localStorage.getItem(FIRST_OPEN_KEY);
  } catch {
    return null;
  }
}

export function tutorialSeen(t: HelpTutorial): boolean {
  try {
    return localStorage.getItem(SEEN_PREFIX + t) === '1';
  } catch {
    return true; // sem storage: não força o tutorial
  }
}

export function markTutorialSeen(t: HelpTutorial): void {
  try {
    localStorage.setItem(SEEN_PREFIX + t, '1');
  } catch {
    /* ignore */
  }
}
