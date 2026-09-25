import { expect, type Page } from '@playwright/test';

// The app marks this once every lazily loaded page is in memory, so later navigation works offline.
export async function codePreloaded(page: Page) {
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('chunks-preloaded').length), { timeout: 30_000 }).toBeGreaterThan(0);
}
