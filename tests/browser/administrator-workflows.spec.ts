// SPDX-License-Identifier: GPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const administratorPassword = 'VRRelay-browser-test-password';

async function authenticate(page: Page): Promise<void> {
  const setupResponse = await page.request.get('/api/v1/setup');
  expect(setupResponse.ok()).toBe(true);
  const setup = (await setupResponse.json()) as { configured: boolean };
  await page.goto(setup.configured ? '/login' : '/setup');

  if (new URL(page.url()).pathname === '/setup') {
    await page.getByLabel('Administrator password').fill(administratorPassword);
    await page.getByLabel('Confirm password').fill(administratorPassword);
    await page.getByRole('button', { name: 'Create administrator' }).click();
    await page.waitForURL(/\/login$/);
  }

  if (new URL(page.url()).pathname === '/login') {
    await page.getByLabel('Administrator password').fill(administratorPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
}

async function expectNoSeriousAccessibilityViolations(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const scan = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        return scan.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical'
        );
      },
      { message: 'expected no serious or critical WCAG A/AA violations' }
    )
    .toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test('initializes, authenticates, and exposes responsive navigation', async ({
  page,
  isMobile
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await authenticate(page);
  await expectNoSeriousAccessibilityViolations(page);

  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  } else {
    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand navigation' }).click();
    await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  }

  expect(pageErrors).toEqual([]);
});

test('creates and revokes a scoped token, then signs out', async ({ page, isMobile }, testInfo) => {
  const pageErrors: Error[] = [];
  const tokenName = `Browser verification ${testInfo.project.name} retry ${testInfo.retry}`;
  page.on('pageerror', (error) => pageErrors.push(error));

  await authenticate(page);
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Runtime and maintenance' })).toBeVisible();
  await expect(page.getByText('Read-only deployment configuration')).toBeVisible();
  await expect(page.getByLabel('Dashboard/API listener')).toBeDisabled();

  await page.getByLabel('Token name').fill(tokenName);
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText('Copy this token now')).toBeVisible();
  const tokenEntry = page.locator('.token-list article').filter({ hasText: tokenName }).first();
  await expect(tokenEntry).toBeVisible();
  await tokenEntry.getByRole('button', { name: `Revoke ${tokenName}` }).click();
  await expect(tokenEntry.getByText('Revoked', { exact: true })).toBeVisible();

  await expectNoSeriousAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('filters Jellyfin shows and selects a season and episode', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await authenticate(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const fixtureProvider = page.locator('.provider').filter({ hasText: 'Browser fixture' });
  const providersResponse = await page.request.get('/api/v1/providers');
  expect(providersResponse.ok()).toBe(true);
  const providers = (await providersResponse.json()) as { items: Array<{ name: string }> };
  if (!providers.items.some((provider) => provider.name === 'Browser fixture')) {
    await page.getByLabel('Connection name').fill('Browser fixture');
    await page.getByLabel('Jellyfin URL').fill('http://127.0.0.1:18202');
    await page.getByLabel('Username').fill('browser-user');
    await page.getByLabel('Password').fill('browser-password');
    await page.getByRole('button', { name: 'Connect and validate' }).click();
  }
  await expect(fixtureProvider).toBeVisible();

  await page.goto('/relay/new');
  await expect(page.getByRole('heading', { name: 'New relay' })).toBeVisible();
  await page.getByRole('radio', { name: 'Shows' }).click();
  await page.getByRole('button', { name: /Browser Series/ }).click();

  await page.getByLabel('Season').click();
  await page.getByRole('option', { name: 'Season 1' }).click();
  await page.getByLabel('Episode').click();
  await page.getByRole('option', { name: 'S1E2 · The Browser Episode' }).click();

  await expect(page.getByLabel('Episode')).toContainText('S1E2 · The Browser Episode');
  await expect(
    page.locator('.summary dd').filter({ hasText: 'The Browser Episode' })
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
