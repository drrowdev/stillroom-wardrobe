import { expect, type Locator, type Page, type Request } from '@playwright/test';

const open = new WeakMap<Page, Set<Request>>();

// Records this page's unfinished requests, so a test can wait until the screen's reads have settled.
export function trackRequests(page: Page) {
  const pending = new Set<Request>();
  open.set(page, pending);
  page.on('request', (request) => { pending.add(request); });
  page.on('requestfinished', (request) => { pending.delete(request); });
  page.on('requestfailed', (request) => { pending.delete(request); });
}

// The Settings cards load their status after the page appears, and each one that arrives can move the cards below it.
// Waits until no request is open, no card is busy and the target has stayed in place between two checks.
export async function settled(page: Page, target: Locator) {
  const pending = open.get(page);
  if (!pending) throw new Error('Call trackRequests(page) before the page loads.');
  let previous = '';
  await expect.poll(async () => {
    const box = JSON.stringify(await target.boundingBox());
    const busy = pending.size + await page.locator('.settings-page [aria-busy="true"]').count();
    const still = busy === 0 && box !== 'null' && box === previous;
    previous = box;
    return still;
  }, { intervals: [150], timeout: 15_000 }).toBe(true);
}
