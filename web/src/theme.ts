import { createContext, useContext } from 'react';

export type Theme = 'dark';

const THEME_KEY = 'bench-theme';

export function getStoredTheme(): Theme {
  return 'dark';
}

export function persistTheme(_theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, 'dark');
  } catch {
    /* ignore (private mode etc.) */
  }
}

export function applyTheme(_theme: Theme): void {
  document.documentElement.setAttribute('data-theme', 'dark');
}

/** Tema único do app: sempre escuro. */
export const ThemeContext = createContext<Theme>('dark');

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
