import { createContext, useContext } from 'react';

/**
 * Tema do app. `system` segue o SO; light/dark fixam a escolha.
 * O modo efetivo vira a classe `dark` no <html> — é o gancho que o
 * `@custom-variant dark (&:is(.dark *))` do Tailwind v4 lê.
 */
export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'bench-theme';

export function getStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage indisponível (modo privado etc.) */
  }
  return 'system';
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? systemTheme() : theme;
}

/** Escreve a classe no <html> e devolve o modo efetivo. */
export function applyTheme(theme: Theme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  return resolved;
}

export interface ThemeApi {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

export const ThemeContext = createContext<ThemeApi>({
  theme: 'system',
  resolved: 'dark',
  setTheme: () => {},
});

export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}
