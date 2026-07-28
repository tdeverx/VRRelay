// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext } from '@playwright/test';

const administratorPassword = 'VRRelay-browser-test-password';
let authenticationCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'] = [];
let authenticationCsrf = '';

test.beforeAll(async ({ request }) => {
  const setupResponse = await request.get('/api/v1/setup');
  expect(setupResponse.ok()).toBe(true);
  if (!((await setupResponse.json()) as { configured: boolean }).configured) {
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
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(authenticationCookies);
  await page.addInitScript(
    (csrf) => sessionStorage.setItem('vrrelay.csrf', csrf),
    authenticationCsrf
  );
});

test('configures Jellyfin and creates a relay from a personal search result', async ({ page }) => {
  await page.goto('/dashboard/settings/connections');

  if ((await page.getByText('Per-user login').count()) === 0) {
    await page.getByLabel('Connection name').fill('User Jellyfin');
    await page.getByLabel('Jellyfin URL').fill('http://127.0.0.1:18202');
    await page.getByRole('switch', { name: 'Allow public HTTP' }).click();
    await page.getByRole('button', { name: 'Add endpoint' }).click();
  }

  await expect(page.getByText('Per-user login')).toBeVisible();
  await page.getByRole('button', { name: 'Save user access' }).click();
  await expect(page.getByText('Interactive sign-in configuration saved.')).toBeVisible();

  const logoutResponse = await page.request.post('/api/v1/auth/logout', {
    headers: { 'X-CSRF-Token': authenticationCsrf }
  });
  expect(logoutResponse.ok()).toBe(true);

  await page.goto('/dashboard/login');
  await page.getByLabel('Username').fill('browser-user');
  await page.getByLabel('Password').fill('browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByLabel('Search movies and shows').fill('Browser');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  const results = page.getByTestId('catalog-search-results');
  await expect(results.getByText('Browser Empty Movie')).toBeVisible();
  await expect(results.getByText('Browser Empty Series')).toBeVisible();

  const series = results.locator('[data-slot="card"]').filter({ hasText: 'Browser Series' });
  await series.getByRole('button', { name: 'Choose episode' }).click();

  const episodeDialog = page.getByRole('dialog', { name: 'Browser Series' });
  const episode = episodeDialog
    .locator('[data-slot="card"]')
    .filter({ hasText: 'The Browser Episode' });
  await episode.getByRole('button', { name: 'Create link' }).click();

  const createdDialog = page.getByRole('dialog', { name: 'Relay link created' });
  await expect(createdDialog.getByLabel('Playback URL')).toHaveValue(/^https?:\/\//);
});
