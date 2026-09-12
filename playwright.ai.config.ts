import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { validateSessionEnvironment } from './scripts/backend/local.mjs';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
validateSessionEnvironment(process.env);
const origin = process.env.I29_C_ANALYSIS_ORIGIN ?? '';
if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(origin) || Number(new URL(origin).port) > 65535) {
  throw new Error('C parent analysis origin is required.');
}
export default defineConfig({
  testDir: './tests/integration', testMatch: 'ai-photo-first.spec.ts',
  fullyParallel: false, forbidOnly: true, retries: 0, workers: 1, timeout: 110_000, reporter: 'dot',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' },
  webServer: {
    command: `"${process.execPath}" "${fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url))}" --host 127.0.0.1 --port 5173 --strictPort --mode browser-test`,
    url: 'http://127.0.0.1:5173', reuseExistingServer: false, stdout: 'ignore', stderr: 'ignore',
    env: { VITE_SUPABASE_URL: process.env.SUPABASE_URL!, VITE_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY!,
      VITE_APP_VERSION: 'local-ai-c-test', SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '',
      TEST_A_EMAIL: '', TEST_A_PASSWORD: '', TEST_B_EMAIL: '', TEST_B_PASSWORD: '',
      ALLOW_SECURITY_TESTS: '', I29_C_ANALYSIS_ORIGIN: '' },
  },
});
