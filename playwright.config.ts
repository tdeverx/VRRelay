// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['line']],
  outputDir: 'tmp/playwright-results',
  use: {
    baseURL: 'http://127.0.0.1:18200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' }
  },
  webServer: {
    command: 'node script/browser-fixture.mjs',
    url: 'http://127.0.0.1:18200/api/v1/health',
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] }
    }
  ]
});
