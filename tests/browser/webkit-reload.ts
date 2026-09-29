import type { Page } from '@playwright/test';

const PRIMARY = 'page.reload: WebKit encountered an internal error';
const wrapped = new WeakSet<Page>();

// Only Playwright's own report of this failure qualifies: the exact first line, optionally followed by its call log.
// A timeout, or any other error that merely mentions the phrase, is not this failure.
export function isWebKitInternalReloadError(error: unknown) {
  if (!(error instanceof Error) || error.name === 'TimeoutError') return false;
  const [first, ...rest] = error.message.replace(/\r\n/g, '\n').split('\n');
  if (first !== PRIMARY) return false;
  const tail = rest.filter((line) => line.trim() !== '');
  if (tail.length === 0) return true;
  return tail[0] === 'Call log:' && tail.slice(1).every((line) => /^\s+- /.test(line) && !line.includes(PRIMARY));
}

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
      if (page.isClosed() || !isWebKitInternalReloadError(error)) throw error;
      return reload(options);
    }
  };
}