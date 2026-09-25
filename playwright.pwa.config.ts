import { defineConfig, devices } from '@playwright/test';

// Production shell contracts: fixture builds served by scripts/serve-dist.mjs, with the service worker
// allowed. Separate from playwright.config.ts so the dev-server projects never build or register it.
export default defineConfig({
  testDir: './tests/pwa',
  // Playwright empties its output directory; keep it away from the captures the browser projects left in test-results.
  outputDir: './test-results/pwa-output',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['./tests/pwa/executed-reporter.ts']],
  globalSetup: './tests/pwa/global-setup.ts',
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'pwa-prod', use: { ...devices['Desktop Chrome'] } },
  ],
});
