// SPDX-License-Identifier: GPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const administratorPassword = 'VRRelay-browser-test-password';
let authenticationCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'] = [];
let authenticationCsrf = '';

async function authenticateNew(page: Page): Promise<void> {
  await page.goto('/new');
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
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

async function openNewNavigation(page: Page, isMobile: boolean): Promise<void> {
  await page
    .getByRole('button', { name: isMobile ? 'Open navigation' : 'Expand navigation' })
    .click();
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
    data: { password: administratorPassword }
  });
  expect(loginResponse.ok()).toBe(true);
  authenticationCsrf = ((await loginResponse.json()) as { csrfToken: string }).csrfToken;
  authenticationCookies = (await request.storageState()).cookies;
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(authenticationCookies);
  await page.addInitScript(
    (csrf) => sessionStorage.setItem('vrrelay.csrf', csrf),
    authenticationCsrf
  );
});

test('switches between interfaces without losing authentication', async ({ page, isMobile }) => {
  await authenticateNew(page);
  expect(await page.evaluate(() => sessionStorage.getItem('vrrelay.ui-version'))).not.toBe(
    'legacy'
  );

  await openNewNavigation(page, isMobile);
  await page.getByRole('switch', { name: 'Use legacy interface' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('vrrelay.ui-version'))).toBe('legacy');

  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Try new UI' }).click();
  await expect(page).toHaveURL(/\/new$/);
  expect(await page.evaluate(() => sessionStorage.getItem('vrrelay.ui-version'))).toBe('new');
});

test('persists theme preference and follows system changes', async ({ page, isMobile }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await authenticateNew(page);
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'new');
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  await openNewNavigation(page, isMobile);
  await page.locator('#theme-choice').click();
  await page.getByRole('option', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('vrrelay.theme'))).toBe('dark');

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await openNewNavigation(page, isMobile);
  await page.locator('#theme-choice').click();
  await page.getByRole('option', { name: 'System' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('renders every Luma administrator route accessibly at review breakpoints', async ({
  page,
  isMobile
}) => {
  await authenticateNew(page);
  const routes = [
    '/new',
    '/new/library',
    '/new/live',
    '/new/relay/new',
    '/new/cluster',
    '/new/profiles',
    '/new/profiles/new',
    '/new/compatibility',
    '/new/system',
    '/new/settings'
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

test('keeps setup redirects inside the new namespace', async ({ page }) => {
  await authenticateNew(page);
  await page.goto('/new/setup');
  await expect(page).toHaveURL(/\/new\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('keeps the UI preview choice scoped to a browser session', async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('The browser test base URL is required.');
  const firstContext = await browser.newContext({ baseURL });
  const firstPage = await firstContext.newPage();
  await firstPage.goto('/new/login');
  await firstPage.evaluate(() => sessionStorage.setItem('vrrelay.ui-version', 'legacy'));
  await firstContext.close();

  const nextContext = await browser.newContext({ baseURL });
  const nextPage = await nextContext.newPage();
  await nextPage.goto('/new/login');
  expect(await nextPage.evaluate(() => sessionStorage.getItem('vrrelay.ui-version'))).toBeNull();
  await nextContext.close();
});

test('serves the dashboard namespace and a per-user Jellyfin relay portal', async ({
  context,
  page
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const freshSettingsPage = await context.newPage();
  await freshSettingsPage.goto('/dashboard/settings');
  await expect(freshSettingsPage).toHaveURL(/\/dashboard\/settings$/);
  await expect(freshSettingsPage.getByRole('heading', { name: 'Settings' })).toBeVisible();
  expect(
    await freshSettingsPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))
  ).toBeTruthy();

  await freshSettingsPage.getByLabel('Connection name').fill('User Jellyfin');
  await freshSettingsPage.getByLabel('Jellyfin URL').fill('http://127.0.0.1:18202');
  await freshSettingsPage.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(freshSettingsPage.getByText('Per-user login')).toBeVisible();
  await expect(
    freshSettingsPage.getByText('Jellyfin endpoint added and user portal enabled.')
  ).toBeVisible();
  expect(
    await freshSettingsPage.evaluate(() => sessionStorage.getItem('vrrelay.csrf'))
  ).toBeTruthy();
  await freshSettingsPage.close();

  const portalStatusResponse = await page.request.get('/api/v1/portal/status');
  expect(portalStatusResponse.ok()).toBe(true);
  expect(await portalStatusResponse.json()).toMatchObject({ configured: true });

  await page.goto('/portal/login');
  await page.getByLabel('Username').fill('browser-user');
  await page.getByLabel('Password').fill('browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/portal$/);

  const freshPortalPage = await context.newPage();
  await freshPortalPage.goto('/portal');
  expect(
    await freshPortalPage.evaluate(() => sessionStorage.getItem('vrrelay.portal-csrf'))
  ).toBeTruthy();
  await expect(
    freshPortalPage.locator('[data-slot="card"]').filter({ hasText: 'The Browser Episode' })
  ).toBeVisible();
  await freshPortalPage.getByLabel('Search your library').fill('Browser Episode');
  await freshPortalPage.getByRole('button', { name: 'Search', exact: true }).click();
  const episode = freshPortalPage
    .locator('[data-slot="card"]')
    .filter({ hasText: 'The Browser Episode' });
  await expect(episode).toBeVisible();
  await episode.getByRole('button', { name: 'Create link' }).click();
  await expect(freshPortalPage.getByRole('heading', { name: 'Your relay links' })).toBeVisible();
  await expect(freshPortalPage.getByText('The Browser Episode').last()).toBeVisible();
  expect(
    await freshPortalPage.evaluate(() => sessionStorage.getItem('vrrelay.portal-csrf'))
  ).toBeTruthy();
  await expectAccessible(freshPortalPage);

  await freshPortalPage.goto('/');
  await expect(freshPortalPage).toHaveURL(/\/portal$/);
});
