import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 5181);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid browser test port.');

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    {
      name: 'webkit-photo',
      testMatch: ['image-processing.spec.ts', 'slice.spec.ts'],
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --mode browser-test --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_fixture_only',
      VITE_APP_VERSION: 'browser-fixture',
    },
  },
});
