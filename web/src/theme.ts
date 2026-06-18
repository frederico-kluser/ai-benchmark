import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'bench-theme';

export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore (private mode etc.) */
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Current theme, provided by the app shell so color math can react to toggles. */
export const ThemeContext = createContext<Theme>('light');

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
