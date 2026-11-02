import type { Page } from '@playwright/test';

const PRIMARY = 'page.reload: WebKit encountered an internal error';
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const wrapped = new WeakSet<Page>();

export const RELOAD_RETRY_ANNOTATION = 'webkit-reload-retry';
// Fixed text only: no URL, call log, headers or user data.
export const RELOAD_RETRY_DISCLOSURE = `${PRIMARY}; retried once`;
export type ReloadRetryReporter = (disclosure: string) => void | Promise<void>;

// Only Playwright's own report of this failure qualifies: the exact first line, optionally followed by its call log.
// A timeout, or any other error that merely mentions the phrase, is not this failure. Playwright 1.63 dims the call
// log with ANSI codes, which are ignored after the first line; the first line itself must match exactly.
export function isWebKitInternalReloadError(error: unknown) {
  if (!(error instanceof Error) || error.name === 'TimeoutError') return false;
  const [first, ...rest] = error.message.replace(/\r\n/g, '\n').split('\n');
  if (first !== PRIMARY) return false;
  const tail = rest.map((line) => line.replace(SGR, '')).filter((line) => line.trim() !== '');
  if (tail.length === 0) return true;
  return tail[0] === 'Call log:' && tail.slice(1).every((line) => /^\s+- /.test(line) && !line.includes(PRIMARY));
}

async function annotate(disclosure: string) {
  process.stderr.write(`${disclosure}\n`);
  const { test } = await import('@playwright/test');
  test.info().annotations.push({ type: RELOAD_RETRY_ANNOTATION, description: disclosure });
}

// WebKit on the CI runners occasionally rejects page.reload() with this internal error (CI runs 36303519054,
// 36473606093 and the CI1 K2 runs). This mitigates the engine error; it does not fix it. Budget: at most one retry
// per page.reload() call, with the same options. Every retry is disclosed as a test annotation and one stderr line,
// a second failure propagates, and the test's assertions after the reload run unchanged.
export function retryWebKitInternalReload(page: Page, report: ReloadRetryReporter = annotate) {
  if (wrapped.has(page) || page.context().browser()?.browserType().name() !== 'webkit') return;
  wrapped.add(page);
  const reload = page.reload.bind(page);
  page.reload = async (options) => {
    try {
      return await reload(options);
    } catch (error) {
      if (page.isClosed() || !isWebKitInternalReloadError(error)) throw error;
      await report(RELOAD_RETRY_DISCLOSURE);
      return reload(options);
    }
  };
}
