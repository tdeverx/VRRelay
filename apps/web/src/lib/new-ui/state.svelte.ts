export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_KEY = 'vrrelay.theme';

export function adminRoute(_pathname: string, suffix = ''): string {
  return `/dashboard${suffix}`;
}

export function applyRouteTheme(_pathname: string): void {
  const root = document.documentElement;
  root.dataset.ui = 'new';
  applyTheme(readThemePreference());
}

export function readThemePreference(): ThemePreference {
  const value = localStorage.getItem(THEME_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(THEME_KEY, preference);
  applyTheme(preference);
}
