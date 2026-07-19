// SPDX-License-Identifier: GPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const administratorPassword = 'VRRelay-browser-test-password';
let authenticationCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'] = [];
let authenticationCsrf = '';
let administratorProviderId = '';
let administratorProviderName = '';

async function authenticateNew(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Recovery administration' })).toBeVisible();
}

async function expectAccessible(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    scan.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    )
  ).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const setupResponse = await request.get('/api/v1/setup');
  expect(setupResponse.ok()).toBe(true);
  const setup = (await setupResponse.json()) as { configured: boolean };
  if (!setup.configured) {
    const initializeResponse = await request.post('/api/v1/setup', {
      data: { password: administratorPassword }
    });
    expect(initializeResponse.ok()).toBe(true);
  }

  const loginResponse = await request.post('/api/v1/auth/login', {
    data: { method: 'recovery', password: administratorPassword }
  });
  expect(loginResponse.ok()).toBe(true);
  authenticationCsrf = ((await loginResponse.json()) as { csrfToken: string }).csrfToken;
  authenticationCookies = (await request.storageState()).cookies;

  const providersResponse = await request.get('/api/v1/providers');
  expect(providersResponse.ok()).toBe(true);
  const existingProvider = (
    (await providersResponse.json()) as { items: Array<{ id: string; name: string }> }
  ).items.find((provider) => provider.name === 'Browser Jellyfin');
  if (existingProvider) {
    administratorProviderId = existingProvider.id;
    administratorProviderName = existingProvider.name;
    return;
  }

  administratorProviderName = 'Browser Jellyfin';
  const providerResponse = await request.post('/api/v1/providers', {
    headers: { 'X-CSRF-Token': authenticationCsrf },
    data: {
      type: 'jellyfin',
      name: administratorProviderName,
      baseUrl: 'http://127.0.0.1:18202',
      authMode: 'user_token',
      username: 'browser-user',
      password: 'browser-password',
      allowPublicHttp: true
    }
  });
  expect(providerResponse.ok()).toBe(true);
  administratorProviderId = ((await providerResponse.json()) as { id: string }).id;
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(authenticationCookies);
  await page.addInitScript(
    (csrf) => sessionStorage.setItem('vrrelay.csrf', csrf),
    authenticationCsrf
  );
});

test('persists theme preference and follows system changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await authenticateNew(page);
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'new');
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('vrrelay.theme'))).toBe('dark');

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('matches loading skeletons to each destination without layout overflow', async ({
  page,
  isMobile
}, testInfo) => {
  await page.route('**/api/v1/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  const routes = [
    ['/dashboard', 'media'],
    ['/dashboard/live', 'table'],
    ['/dashboard/sessions', 'cards'],
    ['/dashboard/settings/people', 'people'],
    ['/dashboard/settings/connections', 'form'],
    ['/dashboard/settings/profiles', 'table'],
    ['/dashboard/system/nodes', 'metrics'],
    ['/dashboard/system/services', 'cards'],
    ['/dashboard/system/work', 'cards'],
    ['/dashboard/system/diagnostics', 'metrics'],
    ['/dashboard/relay/new', 'form']
  ] as const;

  for (const [route, variant] of routes) {
    await page.goto(route);
    const skeleton = page.locator(`[data-loading-variant="${variant}"]`).first();
    await expect(skeleton, `${route} should use the ${variant} skeleton`).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      `${route} skeleton should not overflow horizontally`
    ).toBe(false);
    if (!isMobile && route === '/dashboard/settings/connections') {
      await page.screenshot({ path: testInfo.outputPath('settings-skeleton.png'), fullPage: true });
    }
    await expect(skeleton).toBeHidden({ timeout: 10_000 });
  }
});

test('renders every administrator route accessibly at review breakpoints', async ({
  page,
  isMobile
}) => {
  await authenticateNew(page);
  const routes = [
    '/dashboard',
    '/dashboard/live',
    '/dashboard/relay/new',
    '/dashboard/sessions',
    '/dashboard/system/nodes',
    '/dashboard/system/services',
    '/dashboard/system/work',
    '/dashboard/system/diagnostics',
    '/dashboard/settings/people',
    '/dashboard/settings/connections',
    '/dashboard/settings/profiles',
    '/dashboard/settings/profiles/new',
    '/dashboard/settings/network',
    '/dashboard/settings/runtime',
    '/dashboard/settings/api'
  ];

  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator('main#new-main-content')).toBeVisible();
    await expectAccessible(page);
    if (isMobile) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow, `${route} should not overflow horizontally`).toBe(false);
    } else {
      for (const width of [320, 375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        );
        expect(overflow, `${route} should fit at ${width}px`).toBe(false);
      }
    }
  }
});

test('keeps setup redirects inside the dashboard namespace', async ({ page }) => {
  await authenticateNew(page);
  await page.goto('/dashboard/setup');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Recovery administration' })).toBeVisible();
});

test('validates local placement and keeps the relay wizard on the working route', async ({
  page
}) => {
  test.slow();
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/v1/nodes');
        const body = (await response.json()) as {
          items: Array<{ id: string; capabilities: { providerIds: string[] } }>;
        };
        return body.items.find((node) => node.id === 'standalone')?.capabilities.providerIds;
      },
      { timeout: 25_000 }
    )
    .toContain(administratorProviderId);

  await page.goto('/dashboard/relay/new');
  await page.getByRole('button', { name: /Browser Jellyfin|Provider/ }).click();
  await page.getByRole('option', { name: administratorProviderName, exact: true }).click();
  const movie = page.locator('[data-slot="card"]').filter({ hasText: 'Browser Movie' });
  await movie.getByRole('button', { name: 'Select source' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('radio', { name: 'Local', exact: true }).click();

  await expect(page).toHaveURL(/\/dashboard\/relay\/new$/);
  await expect(page.getByText('VRRelay node', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review' }).last()).toBeVisible();
});

test('serves one role-aware dashboard for recovery and Jellyfin users', async ({
  context,
  page
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const freshSettingsPage = await context.newPage();
  await freshSettingsPage.goto('/dashboard/settings/connections');
  await expect(freshSettingsPage).toHaveURL(/\/dashboard\/settings\/connections$/);
  await expect(freshSettingsPage.getByRole('heading', { name: 'Connections' })).toBeVisible();
  await expect(
    freshSettingsPage.getByText(administratorProviderName, { exact: true })
  ).toBeVisible();
  expect(
    await freshSettingsPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))
  ).toBeTruthy();

  if ((await freshSettingsPage.getByText('Per-user login').count()) === 0) {
    await freshSettingsPage.getByLabel('Connection name').fill('User Jellyfin');
    await freshSettingsPage.getByLabel('Jellyfin URL').fill('http://127.0.0.1:18202');
    await freshSettingsPage.getByRole('switch', { name: 'Allow public HTTP' }).click();
    await freshSettingsPage.getByRole('button', { name: 'Add endpoint' }).click();
  }
  await expect(freshSettingsPage.getByText('Per-user login')).toBeVisible();
  expect(
    await freshSettingsPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))
  ).toBeTruthy();
  await freshSettingsPage.close();

  const signInStatusResponse = await page.request.get('/api/v1/auth/configuration/status');
  expect(signInStatusResponse.ok()).toBe(true);
  expect(await signInStatusResponse.json()).toMatchObject({ configured: true });

  const logoutResponse = await page.request.post('/api/v1/auth/logout', {
    headers: { 'X-CSRF-Token': authenticationCsrf }
  });
  expect(logoutResponse.ok()).toBe(true);
  await page.goto('/dashboard/login');
  await expect(page.getByRole('button', { name: 'Recovery owner' })).toHaveCount(0);
  await page.getByLabel('Password').fill(administratorPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recovery administration' })).toBeVisible();
  const recoveryCsrf = await page.evaluate(() => sessionStorage.getItem('vrrelay.csrf'));
  expect(recoveryCsrf).toBeTruthy();
  const recoveryLogoutResponse = await page.request.post('/api/v1/auth/logout', {
    headers: { 'X-CSRF-Token': recoveryCsrf! }
  });
  expect(recoveryLogoutResponse.ok()).toBe(true);
  await page.goto('/dashboard/login');
  await page.getByLabel('Username').fill('browser-user');
  await page.getByLabel('Password').fill('browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  const freshUserPage = await context.newPage();
  await freshUserPage.goto('/dashboard');
  expect(await freshUserPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))).toBeTruthy();
  await expect(
    freshUserPage.getByRole('heading', { name: 'Choose something to relay' })
  ).toBeVisible();
  const discovery = freshUserPage.locator('main section').first();
  await expect(discovery.locator('[data-slot="card"]')).toHaveCount(0);
  await freshUserPage.getByLabel('Search movies and shows').fill('Browser');
  await freshUserPage.getByRole('button', { name: 'Search', exact: true }).click();
  const movie = freshUserPage.locator('[data-slot="card"]').filter({ hasText: 'Browser Movie' });
  const series = freshUserPage.locator('[data-slot="card"]').filter({ hasText: 'Browser Series' });
  await expect(movie).toBeVisible();
  await expect(series).toBeVisible();
  await expect(discovery.getByText('The Browser Episode')).toHaveCount(0);
  await expect(movie.getByRole('img', { name: 'Browser Movie poster' })).toBeVisible();
  const movieBounds = await movie.boundingBox();
  const movieImageBounds = await movie
    .getByRole('img', { name: 'Browser Movie poster' })
    .boundingBox();
  expect(movieBounds).not.toBeNull();
  expect(movieImageBounds).not.toBeNull();
  expect(Math.abs(movieBounds!.y - movieImageBounds!.y)).toBeLessThan(1);
  await series.getByRole('button', { name: 'Choose episode' }).click();
  const episodeDialog = freshUserPage.getByRole('dialog');
  await expect(episodeDialog).toBeVisible();
  await expect(freshUserPage.getByText('Season 1', { exact: true }).first()).toBeVisible();
  const episode = episodeDialog
    .locator('[data-slot="card"]')
    .filter({ hasText: 'The Browser Episode' });
  await expect(episode).toBeVisible();
  await expect(
    episode.getByRole('img', { name: 'The Browser Episode episode image' })
  ).toBeVisible();
  await expect(episode.getByText('A browser-test episode with a full description.')).toBeVisible();
  const episodeBounds = await episode.boundingBox();
  const episodeImageBounds = await episode
    .getByRole('img', { name: 'The Browser Episode episode image' })
    .boundingBox();
  expect(episodeBounds).not.toBeNull();
  expect(episodeImageBounds).not.toBeNull();
  expect(Math.abs(episodeBounds!.y - episodeImageBounds!.y)).toBeLessThan(1);
  await episode.getByRole('button', { name: 'Create link' }).click();
  await expect(episodeDialog).toBeHidden();
  await expect(freshUserPage.getByText('Relay link created and copied.')).toBeVisible();
  await freshUserPage.goto('/dashboard/sessions');
  await expect(freshUserPage.getByRole('heading', { name: 'Your sessions' })).toBeVisible();
  await expect(freshUserPage.getByText('The Browser Episode').last()).toBeVisible();
  expect(await freshUserPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))).toBeTruthy();
  await expectAccessible(freshUserPage);

  await freshUserPage.goto('/');
  await expect(freshUserPage).toHaveURL(/\/dashboard$/);
});
