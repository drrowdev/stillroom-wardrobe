import type { Page } from '@playwright/test';

const INTERNAL_ERROR = 'WebKit encountered an internal error';
const wrapped = new WeakSet<Page>();

// WebKit on the CI runners occasionally rejects page.reload() with this internal error (CI runs 36303519054 and
// 36473606093). Only that error is retried, and only once; the test's assertions after the reload run unchanged.
export function retryWebKitInternalReload(page: Page) {
  if (wrapped.has(page) || page.context().browser()?.browserType().name() !== 'webkit') return;
  wrapped.add(page);
  const reload = page.reload.bind(page);
  page.reload = async (options) => {
    try {
      return await reload(options);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(INTERNAL_ERROR) || page.isClosed()) throw error;
      return reload(options);
    }
  };
}
