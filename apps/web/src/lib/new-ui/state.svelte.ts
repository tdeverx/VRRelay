import { goto } from '$app/navigation';

export type UiVersion = 'legacy' | 'new';
export type ThemePreference = 'system' | 'light' | 'dark';

export const UI_VERSION_KEY = 'vrrelay.ui-version';
export const THEME_KEY = 'vrrelay.theme';

export function isNewPath(pathname: string): boolean {
  return (
    pathname === '/new' ||
    pathname.startsWith('/new/') ||
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    pathname === '/portal' ||
    pathname.startsWith('/portal/')
  );
}

export function equivalentPath(pathname: string, version: UiVersion): string {
  const bare = pathname.startsWith('/dashboard')
    ? pathname.slice('/dashboard'.length) || '/'
    : pathname.startsWith('/new')
      ? pathname.slice('/new'.length) || '/'
      : pathname;
  return version === 'new' ? `/new${bare === '/' ? '' : bare}` : bare;
}

export function adminRoute(pathname: string, suffix = ''): string {
  const prefix =
    pathname === '/dashboard' || pathname.startsWith('/dashboard/') ? '/dashboard' : '/new';
  return `${prefix}${suffix}`;
}

export function applyRouteTheme(pathname: string): void {
  const root = document.documentElement;
  if (!isNewPath(pathname)) {
    root.removeAttribute('data-ui');
    root.classList.add('dark');
    return;
  }
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

export async function switchUi(pathname: string, version: UiVersion): Promise<void> {
  sessionStorage.setItem(UI_VERSION_KEY, version);
  await goto(equivalentPath(pathname, version));
}
