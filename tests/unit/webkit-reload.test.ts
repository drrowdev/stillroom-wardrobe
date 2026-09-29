import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { isWebKitInternalReloadError, retryWebKitInternalReload } from '../browser/webkit-reload';

const internal = 'page.reload: WebKit encountered an internal error';
const callLog = `${internal}\nCall log:\n  - waiting for navigation until "load"\n`;
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

describe('WebKit internal reload error', () => {
  it('recognises only Playwright\'s exact report, with or without its call log', () => {
    expect(isWebKitInternalReloadError(failure(internal))).toBe(true);
    expect(isWebKitInternalReloadError(failure(callLog))).toBe(true);
    expect(isWebKitInternalReloadError(failure(callLog.replace(/\n/g, '\r\n')))).toBe(true);
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
});

describe('retryWebKitInternalReload', () => {
  it('retries the exact WebKit failure once with the same options', async () => {
    const { page, calls } = fakePage('webkit', [failure(callLog), 'ok']);
    retryWebKitInternalReload(page);
    await expect(page.reload({ waitUntil: 'load' })).resolves.toBeNull();
    expect(calls).toEqual([{ waitUntil: 'load' }, { waitUntil: 'load' }]);
  });

  it('propagates a second-attempt failure without a third try', async () => {
    const second = failure(callLog);
    const { page, calls } = fakePage('webkit', [failure(callLog), second]);
    retryWebKitInternalReload(page);
    await expect(page.reload()).rejects.toBe(second);
    expect(calls).toHaveLength(2);
  });

  it('does not retry other errors, timeouts or a closed page', async () => {
    for (const [error, closed] of [
      [failure('page.reload: Timeout 30000ms exceeded.\nCall log:\n  - WebKit encountered an internal error'), false],
      [failure(callLog, 'TimeoutError'), false],
      [failure('page.reload: net::ERR_ABORTED'), false],
      [failure(callLog), true],
    ] as const) {
      const { page, calls } = fakePage('webkit', [error], closed);
      retryWebKitInternalReload(page);
      await expect(page.reload()).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    }
  });

  it('leaves Chromium and other engines untouched', async () => {
    for (const browser of ['chromium', 'firefox']) {
      const { page, calls } = fakePage(browser, [failure(callLog)]);
      const original = page.reload;
      retryWebKitInternalReload(page);
      expect(page.reload).toBe(original);
      await expect(page.reload()).rejects.toThrow(internal);
      expect(calls).toHaveLength(1);
    }
  });

  it('wraps a page only once, so repeated setup still allows a single retry', async () => {
    const { page, calls } = fakePage('webkit', [failure(callLog), failure(callLog), 'ok']);
    retryWebKitInternalReload(page);
    const once = page.reload;
    retryWebKitInternalReload(page);
    expect(page.reload).toBe(once);
    await expect(page.reload()).rejects.toThrow(internal);
    expect(calls).toHaveLength(2);
  });
});