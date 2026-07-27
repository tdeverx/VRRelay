// SPDX-License-Identifier: GPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page
} from '@playwright/test';

const administratorPassword = 'VRRelay-browser-test-password';
let authenticationCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'] = [];
let authenticationCsrf = '';
let administratorProviderName = '';
const pageErrors = new WeakMap<BrowserContext, string[]>();
let browserClientSequence = 10;

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
});

test.beforeEach(async ({ context, page }) => {
  const errors: string[] = [];
  const capture = (candidate: Page) =>
    candidate.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  pageErrors.set(context, errors);
  context.pages().forEach(capture);
  context.on('page', capture);
  browserClientSequence += 1;
  await context.setExtraHTTPHeaders({
    'X-Forwarded-For': `198.51.100.${browserClientSequence}`
  });
  await context.addCookies(authenticationCookies);
  await page.addInitScript(
    (csrf) => sessionStorage.setItem('vrrelay.csrf', csrf),
    authenticationCsrf
  );
});

test.afterEach(async ({ context }) => {
  expect(pageErrors.get(context) ?? [], 'browser pages should not emit uncaught errors').toEqual(
    []
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
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#06111b');
  expect(
    await page.locator('html').evaluate((element) => getComputedStyle(element).colorScheme)
  ).toBe('dark');
  expect(await page.evaluate(() => localStorage.getItem('vrrelay.theme'))).toBe('dark');

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f7fafc');
  expect(
    await page.locator('html').evaluate((element) => getComputedStyle(element).colorScheme)
  ).toBe('light');
});

test('matches administrator loading skeletons to representative destinations without layout overflow', async ({
  page
}, testInfo) => {
  testInfo.setTimeout(60_000);
  let apiRequests = Promise.resolve();
  let releaseApiRequests: (() => void) | undefined;
  const holdApiRequests = () => {
    apiRequests = new Promise<void>((resolve) => {
      releaseApiRequests = resolve;
    });
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/me' || path === '/api/v1/health' || path === '/api/v1/setup') {
      await route.continue();
      return;
    }
    await apiRequests;
    await route.continue();
  });

  const routes = [
    ['/dashboard/live', 'table'],
    ['/dashboard/sessions', 'cards'],
    ['/dashboard/settings/people', 'people'],
    ['/dashboard/settings/retention', 'form'],
    ['/dashboard/system/diagnostics', 'metrics']
  ] as const;

  for (const [route, variant] of routes) {
    holdApiRequests();
    await page.goto(route);
    const skeleton = page.locator(`[data-loading-variant="${variant}"]`).first();
    try {
      await expect(skeleton, `${route} should use the ${variant} skeleton`).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        `${route} skeleton should not overflow horizontally`
      ).toBe(false);
    } finally {
      releaseApiRequests?.();
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
    '/dashboard/sessions',
    '/dashboard/system/nodes',
    '/dashboard/system/services',
    '/dashboard/system/work',
    '/dashboard/system/diagnostics',
    '/dashboard/settings/people',
    '/dashboard/settings/retention',
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

test('uses route-specific browser titles', async ({ page }) => {
  await page.goto('/dashboard/system/diagnostics');
  await expect(page).toHaveTitle('Diagnostics · VRRelay');
  await page.goto('/dashboard/settings/api');
  await expect(page).toHaveTitle('API Access · VRRelay');
  await page.goto('/dashboard/settings/retention');
  await expect(page).toHaveTitle('Retention · VRRelay');
});

test('preserves safe return destinations and rejects external redirects', async ({ page }) => {
  await page.goto('/dashboard/login?returnTo=%2Fdashboard%2Fsystem%2Fdiagnostics%3Ffrom%3Dlogin');
  await expect(page).toHaveURL(/\/dashboard\/system\/diagnostics\?from=login$/);

  await page.goto(
    '/dashboard/login?returnTo=https%3A%2F%2Fattacker.example%2Fdashboard%2Fsystem%2Fnodes'
  );
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/dashboard/login?returnTo=%2Fdashboard.evil%2Fsystem%2Fnodes');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('keeps useful diagnostics visible when readiness is degraded', async ({ page }) => {
  await page.route('**/api/v1/ready', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'degraded',
        version: 'browser-test',
        now: '2026-07-25T00:00:00.000Z',
        workers: { active: 0, limit: 4, queued: 0 },
        dependencies: [
          {
            category: 'repository',
            kind: 'postgres',
            healthy: false,
            checkedAt: '2026-07-25T00:00:00.000Z',
            restartRequired: false
          }
        ],
        restartRequired: false
      })
    });
  });

  await page.goto('/dashboard/system/diagnostics');
  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(page.getByText('Dependency health', { exact: true })).toBeVisible();
  await expect(page.getByText('postgres', { exact: true })).toBeVisible();
  await expect(page.getByText('unhealthy', { exact: true })).toBeVisible();
});

test('does not mutate sign-in settings when opening an unrelated settings section', async ({
  page
}) => {
  const updates: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/v1/auth/configuration'
    )
      updates.push(request.url());
  });

  await page.goto('/dashboard/settings/network');
  await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible();
  await expect.poll(() => updates).toEqual([]);
});

test('validates and confirms backend activation through the dashboard', async ({ page }) => {
  await page.goto('/dashboard/system/services');
  const activateBackend = page
    .locator('#new-main-content')
    .getByRole('button', { name: 'Activate backend' });
  await page.getByRole('button', { name: 'Validate backend' }).click();
  await expect(page.getByText('Backend validation succeeded.')).toBeVisible();
  await activateBackend.click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation.getByRole('heading', { name: 'Activate this backend?' })).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(activateBackend).toBeEnabled();
  await activateBackend.click();
  await confirmation.getByRole('button', { name: 'Activate backend' }).click();
  await expect(page.getByText('Backend activated.')).toBeVisible();
});

test('requires confirmation and records expiry for personal access tokens', async ({
  page
}, testInfo) => {
  const tokenName = `Browser token ${testInfo.project.name}`;
  await page.goto('/dashboard/settings/api');
  await page.getByLabel('Token name').fill(tokenName);
  await page.getByLabel('Expiry').fill('2099-01-01T12:00');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText('Copy this token now')).toBeVisible();

  const tokenRow = page.locator('[data-testid^="personal-token-"]').filter({ hasText: tokenName });
  await expect(tokenRow.getByText(/^Expires /)).toBeVisible();
  await tokenRow.getByRole('button', { name: 'Revoke' }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(
    confirmation.getByRole('heading', { name: 'Revoke personal access token?' })
  ).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(tokenRow.getByRole('button', { name: 'Revoke' })).toBeVisible();
  await tokenRow.getByRole('button', { name: 'Revoke' }).click();
  await confirmation.getByRole('button', { name: 'Revoke token' }).click();
  await expect(tokenRow.getByText('revoked', { exact: true })).toBeVisible();
});

test('closes mobile navigation after following a destination', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile sheet behavior is covered by the mobile project');
  await authenticateNew(page);
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  await toggle.click();
  const mobileSidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
  await expect(mobileSidebar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mobileSidebar).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await mobileSidebar.getByRole('link', { name: 'Live', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/live$/);
  await expect(mobileSidebar).toBeHidden();
});

test('restores the desktop sidebar preference after reload', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop collapse persistence is covered by the desktop project');
  await authenticateNew(page);
  const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  const initialState = await sidebar.getAttribute('data-state');
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(sidebar).not.toHaveAttribute('data-state', initialState ?? '');
  const changedState = await sidebar.getAttribute('data-state');
  await page.reload();
  await expect(wrapper).toBeVisible();
  await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
    'data-state',
    changedState ?? ''
  );
});

test('serves one role-aware dashboard for recovery and Jellyfin users', async ({
  context,
  page
}) => {
  const freshSettingsPage = await context.newPage();
  await freshSettingsPage.addInitScript(
    (csrf) => sessionStorage.setItem('vrrelay.csrf', csrf),
    authenticationCsrf
  );
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
  const playbackReporting = freshSettingsPage.getByRole('switch', {
    name: 'Save playback activity to Jellyfin'
  });
  const reportingWasEnabled = await playbackReporting.isChecked();
  await playbackReporting.click();
  await freshSettingsPage.getByRole('button', { name: 'Save user access' }).click();
  await expect(
    freshSettingsPage.getByText('Interactive sign-in configuration saved.')
  ).toBeVisible();
  if (reportingWasEnabled) await expect(playbackReporting).not.toBeChecked();
  else await expect(playbackReporting).toBeChecked();
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
  const jellyfinCsrf = await page.evaluate(() => sessionStorage.getItem('vrrelay.csrf'));
  expect(jellyfinCsrf).toBeTruthy();

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('Clipboard write denied by browser fixture', 'NotAllowedError');
        }
      }
    });
  });
  const freshUserPage = await context.newPage();
  await freshUserPage.addInitScript(
    (csrf) => sessionStorage.setItem('vrrelay.csrf', csrf),
    jellyfinCsrf!
  );
  await freshUserPage.goto('/dashboard');
  expect(await freshUserPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))).toBeTruthy();
  await expect(
    freshUserPage.getByRole('heading', { name: 'Choose something to relay' })
  ).toBeVisible();
  const continueRow = freshUserPage.getByTestId('catalog-row-continue-watching');
  const nextRow = freshUserPage.getByTestId('catalog-row-up-next');
  const recentRow = freshUserPage.getByTestId('catalog-row-recently-added');
  await expect(continueRow.getByText('Browser Movie', { exact: true })).toBeVisible();
  await expect(continueRow.getByText('30m watched', { exact: true })).toBeVisible();
  await expect(nextRow.getByText('The Browser Episode', { exact: true })).toBeVisible();
  await expect(recentRow.getByText('Browser Movie', { exact: true })).toBeVisible();
  await freshUserPage.getByLabel('Search movies and shows').fill('Browser');
  await freshUserPage.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(continueRow).toHaveCount(0);
  await expect(nextRow).toHaveCount(0);
  await expect(recentRow).toHaveCount(0);
  const searchResults = freshUserPage.getByTestId('catalog-search-results');
  const movie = searchResults.locator('[data-slot="card"]').filter({ hasText: 'Browser Movie' });
  const series = searchResults.locator('[data-slot="card"]').filter({ hasText: 'Browser Series' });
  await expect(movie).toBeVisible();
  await expect(series).toBeVisible();
  await expect(searchResults.getByText('The Browser Episode')).toHaveCount(0);
  await expect(searchResults.getByText('Browser Empty Movie')).toHaveCount(0);
  await expect(searchResults.getByText('Browser Empty Series')).toHaveCount(0);
  await expect(movie.getByRole('img', { name: 'Browser Movie poster' })).toBeVisible();
  const movieBounds = await movie.boundingBox();
  const movieImageBounds = await movie
    .getByRole('img', { name: 'Browser Movie poster' })
    .boundingBox();
  expect(movieBounds).not.toBeNull();
  expect(movieImageBounds).not.toBeNull();
  expect(Math.abs(movieBounds!.y - movieImageBounds!.y)).toBeLessThanOrEqual(8);
  await series.getByRole('button', { name: 'Choose episode' }).click();
  const episodeDialog = freshUserPage.getByRole('dialog', { name: 'Browser Series' });
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
  expect(Math.abs(episodeBounds!.y - episodeImageBounds!.y)).toBeLessThanOrEqual(8);
  await episode.getByRole('button', { name: 'Create link' }).click();
  await expect(episodeDialog).toBeHidden();
  const createdDialog = freshUserPage.getByRole('dialog', { name: 'Relay link created' });
  await expect(createdDialog.getByRole('heading', { name: 'Relay link created' })).toBeVisible();
  await expect(
    freshUserPage.getByText('Relay link created. Copy it from the open dialog.')
  ).toBeVisible();
  await expect(createdDialog.getByLabel('Playback URL')).toHaveValue(/^https?:\/\//);
  await freshUserPage.goto('/dashboard/sessions');
  await expect(freshUserPage.getByRole('heading', { name: 'Your sessions' })).toBeVisible();
  const createdSession = freshUserPage
    .locator('[data-slot="card"]')
    .filter({ hasText: 'The Browser Episode' })
    .last();
  await expect(createdSession).toBeVisible();
  await createdSession.getByRole('button', { name: 'Delete The Browser Episode' }).click();
  const deleteConfirmation = freshUserPage.getByRole('alertdialog');
  await expect(
    deleteConfirmation.getByRole('heading', { name: 'Delete playback session?' })
  ).toBeVisible();
  await deleteConfirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(createdSession).toBeVisible();
  const deleteButton = createdSession.getByRole('button', {
    name: 'Delete The Browser Episode'
  });
  await expect(deleteButton).toBeFocused();
  await deleteButton.click();
  await deleteConfirmation.getByRole('button', { name: 'Delete session' }).click();
  await expect(createdSession).toHaveCount(0);
  expect(await freshUserPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))).toBeTruthy();
  await expectAccessible(freshUserPage);

  await freshUserPage.goto('/');
  await expect(freshUserPage).toHaveURL(/\/dashboard$/);
});
