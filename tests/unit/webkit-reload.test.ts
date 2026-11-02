import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { RELOAD_RETRY_DISCLOSURE, isWebKitInternalReloadError, retryWebKitInternalReload } from '../browser/webkit-reload';

const internal = 'page.reload: WebKit encountered an internal error';
const callLog = `${internal}\nCall log:\n  - waiting for navigation until "load"\n`;
// Playwright 1.63 formatCallLog: the whole call log is wrapped in one ANSI dim sequence.
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const dimmed = `${internal}\nCall log:\n${dim('  - waiting for navigation until "load"\n  - navigated to "http://127.0.0.1:4173/"')}\n`;
const failure = (message: string, name = 'Error') => Object.assign(new Error(message), { name });

function fakePage(browser: string, outcomes: (Error | 'ok')[], closed = false) {
  const calls: unknown[] = [];
  const page = {
    context: () => ({ browser: () => ({ browserType: () => ({ name: () => browser }) }) }),
    isClosed: () => closed,
    reload: async (options?: unknown) => {
      calls.push(options);
      const next = outcomes.shift();
      if (next === undefined) throw new Error('unexpected extra reload');
      if (next !== 'ok') throw next;
      return null;
    },
  };
  return { page: page as unknown as Page, calls };
}
function wrap(page: Page) {
  const disclosures: string[] = [];
  retryWebKitInternalReload(page, (disclosure) => { disclosures.push(disclosure); });
  return disclosures;
}

describe('WebKit internal reload error', () => {
  it('recognises only Playwright\'s exact report, with or without its call log', () => {
    expect(isWebKitInternalReloadError(failure(internal))).toBe(true);
    expect(isWebKitInternalReloadError(failure(callLog))).toBe(true);
    expect(isWebKitInternalReloadError(failure(callLog.replace(/\n/g, '\r\n')))).toBe(true);
  });

  it('recognises the real Playwright 1.63 report, whose call log is dimmed with ANSI codes', () => {
    expect(isWebKitInternalReloadError(failure(dimmed))).toBe(true);
    expect(isWebKitInternalReloadError(failure(dimmed.replace(/\n/g, '\r\n')))).toBe(true);
    expect(isWebKitInternalReloadError(failure(`${internal}\nCall log:\n${dim('  - waiting for navigation until "load"')}\n`))).toBe(true);
  });

  it('refuses timeouts, other primary errors and diagnostics that merely mention the phrase', () => {
    for (const message of [
      'page.reload: Timeout 30000ms exceeded.\nCall log:\n  - waiting for navigation until "load"\n  - WebKit encountered an internal error',
      `page.goto: WebKit encountered an internal error`,
      `Error: ${internal}`,
      `${internal} while loading`,
      `page.reload: Target page, context or browser has been closed\n${internal}`,
      `${internal}\nsomething else happened`,
      `${internal}\nCall log:\n  - ${internal}`,
      `\n${internal}`,
    ]) expect(isWebKitInternalReloadError(failure(message)), message).toBe(false);
    expect(isWebKitInternalReloadError(failure(callLog, 'TimeoutError'))).toBe(false);
    expect(isWebKitInternalReloadError(internal)).toBe(false);
    expect(isWebKitInternalReloadError({ message: internal })).toBe(false);
  });

  it('still refuses every non-qualifying case when the call log is dimmed', () => {
    for (const message of [
      `page.reload: Timeout 30000ms exceeded.\nCall log:\n${dim('  - waiting for navigation until "load"\n  - WebKit encountered an internal error')}\n`,
      `page.goto: WebKit encountered an internal error\nCall log:\n${dim('  - navigating to "/"')}\n`,
      `${internal}\nCall log:\n${dim(`  - ${internal}`)}\n`,
      `${internal}\nCall log:\n${dim('  - waiting for navigation until "load"\nsomething else happened')}\n`,
      `${internal}\n${dim('something else happened')}\n`,
      `${dim(internal)}\nCall log:\n${dim('  - waiting for navigation until "load"')}\n`,
      `\x1b[31m${internal}\x1b[39m`,
    ]) expect(isWebKitInternalReloadError(failure(message)), JSON.stringify(message)).toBe(false);
    expect(isWebKitInternalReloadError(failure(dimmed, 'TimeoutError'))).toBe(false);
  });
});

describe('retryWebKitInternalReload', () => {
  it('retries the exact WebKit failure once with the identical options and discloses the retry', async () => {
    const { page, calls } = fakePage('webkit', [failure(dimmed), 'ok']);
    const disclosures = wrap(page);
    const options = { waitUntil: 'load' as const };
    await expect(page.reload(options)).resolves.toBeNull();
    expect(calls).toEqual([options, options]);
    expect(calls[0]).toBe(options);
    expect(calls[1]).toBe(options);
    expect(disclosures).toEqual([RELOAD_RETRY_DISCLOSURE]);
  });

  it('discloses only fixed text, never the URL or call log', async () => {
    const { page } = fakePage('webkit', [failure(dimmed), 'ok']);
    const disclosures = wrap(page);
    await page.reload();
    expect(RELOAD_RETRY_DISCLOSURE).toBe('page.reload: WebKit encountered an internal error; retried once');
    for (const leaked of ['http', '127.0.0.1', 'Call log', 'waiting', '\x1b', '\n']) expect(disclosures[0]).not.toContain(leaked);
  });

  it('propagates a second-attempt failure without a third try, after disclosing the attempt', async () => {
    const second = failure(dimmed);
    const { page, calls } = fakePage('webkit', [failure(dimmed), second]);
    const disclosures = wrap(page);
    await expect(page.reload()).rejects.toBe(second);
    expect(calls).toHaveLength(2);
    expect(disclosures).toEqual([RELOAD_RETRY_DISCLOSURE]);
  });

  it('gives each reload call its own single retry', async () => {
    const { page, calls } = fakePage('webkit', [failure(callLog), 'ok', failure(dimmed), 'ok', failure(dimmed), failure(dimmed)]);
    const disclosures = wrap(page);
    await expect(page.reload()).resolves.toBeNull();
    await expect(page.reload()).resolves.toBeNull();
    await expect(page.reload()).rejects.toThrow(internal);
    expect(calls).toHaveLength(6);
    expect(disclosures).toHaveLength(3);
  });

  it('does not retry or disclose other errors, timeouts or a closed page', async () => {
    for (const [error, closed] of [
      [failure('page.reload: Timeout 30000ms exceeded.\nCall log:\n  - WebKit encountered an internal error'), false],
      [failure(callLog, 'TimeoutError'), false],
      [failure(dimmed, 'TimeoutError'), false],
      [failure('page.reload: net::ERR_ABORTED'), false],
      [failure(callLog), true],
    ] as const) {
      const { page, calls } = fakePage('webkit', [error], closed);
      const disclosures = wrap(page);
      await expect(page.reload()).rejects.toBe(error);
      expect(calls).toHaveLength(1);
      expect(disclosures).toEqual([]);
    }
  });

  it('leaves Chromium and other engines untouched', async () => {
    for (const browser of ['chromium', 'firefox']) {
      const { page, calls } = fakePage(browser, [failure(dimmed)]);
      const original = page.reload;
      const disclosures = wrap(page);
      expect(page.reload).toBe(original);
      await expect(page.reload()).rejects.toThrow(internal);
      expect(calls).toHaveLength(1);
      expect(disclosures).toEqual([]);
    }
  });

  it('wraps a page only once, so repeated setup still allows a single retry per call', async () => {
    const { page, calls } = fakePage('webkit', [failure(callLog), failure(callLog), 'ok']);
    const first = wrap(page);
    const once = page.reload;
    const second = wrap(page);
    expect(page.reload).toBe(once);
    await expect(page.reload()).rejects.toThrow(internal);
    expect(calls).toHaveLength(2);
    expect(first).toEqual([RELOAD_RETRY_DISCLOSURE]);
    expect(second).toEqual([]);
  });
});
