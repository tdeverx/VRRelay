// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, URL } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const testTimeoutMs = process.env.CI ? 30_000 : 15_000;

export default defineConfig({
  resolve: {
    alias: {
      '@vrrelay/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@vrrelay/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url)
      ),
      '@vrrelay/application': fileURLToPath(
        new URL('./packages/application/src/index.ts', import.meta.url)
      ),
      '@vrrelay/adapters': fileURLToPath(
        new URL('./packages/adapters/src/index.ts', import.meta.url)
      )
    }
  },
  test: {
    testTimeout: testTimeoutMs,
    hookTimeout: testTimeoutMs,
    exclude: [...configDefaults.exclude, '**/dist/**', 'tests/browser/**']
  }
});
