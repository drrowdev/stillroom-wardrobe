import { defineConfig, devices } from '@playwright/test';

// Performance budgets (I25, R21): one production build served by scripts/serve-dist.mjs, measured serially
// in cold browser contexts. Separate from the dev-server and pwa-prod configs so nothing else competes for the CPU.
export default defineConfig({
  testDir: './tests/performance',
  outputDir: './test-results/performance-output',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 240_000,
  reporter: [['list'], ['./tests/pwa/executed-reporter.ts', { required: ['performance.spec.ts'] }]],
  globalSetup: './tests/performance/global-setup.ts',
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'performance', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
});
