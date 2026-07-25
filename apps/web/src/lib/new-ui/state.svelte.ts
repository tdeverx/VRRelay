export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_KEY = 'vrrelay.theme';

export function adminRoute(_pathname: string, suffix = ''): string {
  return `/dashboard${suffix}`;
}

export function loginRoute(returnTo: string): string {
  return `/dashboard/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function safeDashboardReturnTo(value: string | null): string {
  if (
    !value ||
    (value !== '/dashboard' && !value.startsWith('/dashboard/')) ||
    value.startsWith('//')
  )
    return '/dashboard';
  let target: URL;
  try {
    target = new URL(value, 'https://vrrelay.invalid');
  } catch {
    return '/dashboard';
  }
  if (
    target.origin !== 'https://vrrelay.invalid' ||
    target.pathname === '/dashboard/login' ||
    target.pathname.startsWith('/dashboard/login/') ||
    (target.pathname !== '/dashboard' && !target.pathname.startsWith('/dashboard/'))
  )
    return '/dashboard';
  return `${target.pathname}${target.search}${target.hash}`;
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
  document
    .getElementById('vrrelay-theme-color')
    ?.setAttribute('content', dark ? '#06111b' : '#f7fafc');
  document.dispatchEvent(new CustomEvent('vrrelay:theme', { detail: dark ? 'dark' : 'light' }));
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(THEME_KEY, preference);
  applyTheme(preference);
}
