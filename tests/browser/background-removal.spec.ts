import { expect, test, type Page, type Request, type Response, type TestInfo } from '@playwright/test';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { locales, messages, type Language } from '../../src/i18n/all';
import type { BackgroundTestHook } from '../../src/images/background/test-hook';
import { modelAssetBytes, modelAssets } from '../../src/images/background/model-assets';
import { aiFixture, editItem, openPhotoMenu } from './ai-photo-first-support';
import { observeEgress, segmentationProblems } from './background-egress';
import { mockBackend, signIn } from './mock-backend';
import { openAccountMenu } from './shell-support';

// Automatic on-device background removal (ADR24, BG1). Every assertion is text: outcomes, counts, request paths
// and sampled pixel values read in the page. No image is looked at by the test author or the model.
type Fixture = Awaited<ReturnType<typeof aiFixture>>;
type Entry = Record<string, number | string>;
type DiagnosticStage = 'wardrobe-ready' | 'card-opened' | 'editor-ready' | 'finished';
type DiagnosticTime = { elapsedMs: number; remainingBudgetEstimateMs: number };
type DiagnosticEvent = DiagnosticTime & {
  endpoint: 'collection-items' | 'detail-items' | 'item-images' | 'profile' | 'auth-user' | 'auth-token'
    | 'other-fixture' | 'app-entry' | 'editor-module';
  method: 'GET' | 'POST' | 'OPTIONS' | 'other';
  lifecycle: 'requested' | 'responded' | 'finished' | 'failed';
  status: 'none' | 'success' | 'client-error' | 'server-error' | 'other';
};
type DiagnosticSnapshot = DiagnosticTime & {
  stage: DiagnosticStage; itemRows?: number; imageRows?: number;
  route?: 'wardrobe' | 'detail' | 'other'; heading?: boolean; loading?: boolean; empty?: boolean; itemLink?: boolean;
  detailLoading?: boolean; lazyLoading?: boolean; loadError?: boolean; edit?: boolean; input?: boolean;
  login?: boolean; locked?: boolean; waiting?: boolean; captureError?: boolean; pageClosed?: boolean; sampleCompletedElapsedMs?: number;
  sampleState: 'pending' | 'complete' | 'failed' | 'timed-out';
};
const replacementDiagnostics = new WeakMap<Page, ReturnType<typeof replacementDiagnostic>>();
test.beforeEach(({ page }, info) => {
  if (!info.title.startsWith('replace:') || info.project.name === 'mobile') return;
  replacementDiagnostics.set(page, replacementDiagnostic(page, info));
});
function replacementDiagnostic(page: Page, info: TestInfo, sample?: () => Promise<{ heading: boolean }>) {
  const events: DiagnosticEvent[] = [];
  const snapshots: DiagnosticSnapshot[] = [], pending: Promise<void>[] = [];
  const started = performance.now(), app = new URL(info.project.use.baseURL!).origin;
  let truncated = 0, finalized = false, api: Fixture | undefined;
  // This clock starts after Playwright's page fixture, not at the test's actual deadline.
  const timing = (): DiagnosticTime => {
    const elapsedMs = Math.round(performance.now() - started);
    return { elapsedMs, remainingBudgetEstimateMs: Math.max(0, info.timeout - elapsedMs) };
  };
  const requestEvent = (request: Request, lifecycle: DiagnosticEvent['lifecycle'], status = 0) => {
    const url = new URL(request.url());
    const endpoint = url.origin === app
      ? url.pathname === '/src/main.tsx' || request.isNavigationRequest() ? 'app-entry'
        : url.pathname === '/src/features/wardrobe/item-editor.tsx' ? 'editor-module' : null
      : url.origin !== 'http://127.0.0.1:54321' ? null
        : url.pathname === '/rest/v1/items' ? url.searchParams.has('id') ? 'detail-items' : 'collection-items'
          : url.pathname === '/rest/v1/item_images' ? 'item-images'
            : url.pathname === '/rest/v1/profiles' ? 'profile'
              : url.pathname === '/auth/v1/user' ? 'auth-user'
                : url.pathname === '/auth/v1/token' ? 'auth-token' : 'other-fixture';
    if (!endpoint) return;
    const method = request.method();
    if (events.length === 40) { events.shift(); truncated++; }
    events.push({ ...timing(), endpoint, method: method === 'GET' || method === 'POST' || method === 'OPTIONS' ? method : 'other', lifecycle,
      status: status === 0 ? 'none' : status >= 200 && status < 300 ? 'success'
        : status >= 400 && status < 500 ? 'client-error' : status >= 500 && status < 600 ? 'server-error' : 'other' });
  };
  const requested = (request: Request) => requestEvent(request, 'requested');
  const responded = (response: Response) => requestEvent(response.request(), 'responded', response.status());
  const finished = (request: Request) => requestEvent(request, 'finished');
  const failed = (request: Request) => requestEvent(request, 'failed');
  page.on('request', requested); page.on('response', responded);
  page.on('requestfinished', finished); page.on('requestfailed', failed);
  return {
    capture(stage: DiagnosticStage, fixture?: Fixture) {
      if (finalized) return;
      api = fixture ?? api;
      if (snapshots.length === 10) { truncated++; return; }
      const snapshot: DiagnosticSnapshot = { ...timing(), stage, sampleState: 'pending', itemRows: api?.items.length, imageRows: api?.images.length };
      snapshots.push(snapshot);
      pending.push((sample ? sample() : page.evaluate(() => {
        const visible = (selector: string) => Array.from(document.querySelectorAll(selector))
          .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
        return {
          route: location.hash.startsWith('#/items/') ? 'detail' as const
            : location.hash === '' || location.hash === '#/' ? 'wardrobe' as const : 'other' as const,
          heading: visible('#wardrobe-title'), loading: visible('.item-grid[aria-busy=true]'), empty: visible('.empty-wardrobe'),
          itemLink: visible('.item-detail-link'), detailLoading: visible('.detail-page > p[role=status]'),
          lazyLoading: visible('.chunk-loading'), loadError: visible('.notice-error,.chunk-error'),
          edit: visible('#detail-edit'), input: visible('#detail-title'), login: visible('#email'),
          locked: visible('.entry-card > .stack'), waiting: visible('#waiting-title'),
        };
      })).then(state => {
        if (!finalized) Object.assign(snapshot, state, { sampleState: 'complete', sampleCompletedElapsedMs: timing().elapsedMs });
      }, () => {
        if (finalized) return;
        snapshot.sampleState = 'failed'; snapshot.captureError = true;
        snapshot.pageClosed = page.isClosed(); snapshot.sampleCompletedElapsedMs = timing().elapsedMs;
      }));
    },
    async finish() {
      page.off('request', requested); page.off('response', responded);
      page.off('requestfinished', finished); page.off('requestfailed', failed);
      const finalize = () => {
        finalized = true;
        const unsettledSamples = snapshots.filter(snapshot => snapshot.sampleState === 'pending').length;
        for (const snapshot of snapshots) if (snapshot.sampleState === 'pending') snapshot.sampleState = 'timed-out';
        const unsuccessful = info.status !== 'passed' && info.status !== 'skipped';
        return {
          budgetOrigin: 'diagnostic-start-estimate', ...timing(), truncated,
          retainedNetworkEvents: events.length, retainedSnapshots: snapshots.length,
          unavailableSnapshots: snapshots.filter(snapshot => snapshot.captureError).length,
          sampleTimedOut: unsettledSamples > 0, unsettledSamples,
          ...(unsuccessful || unsettledSamples > 0 ? { events: events.map(event => ({ ...event })), snapshots: snapshots.map(snapshot => ({ ...snapshot })) } : {}),
        };
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let report: ReturnType<typeof finalize>;
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); }),
        ]);
      } finally {
        clearTimeout(timer);
        report = finalize();
        console.log('Replacement startup diagnostic', JSON.stringify(report));
      }
      return report;
    },
  };
}
test.afterEach(async ({ page }) => {
  const diagnostic = replacementDiagnostics.get(page);
  if (!diagnostic) return;
  diagnostic.capture('finished');
  try { await diagnostic.finish(); } finally { replacementDiagnostics.delete(page); }
});
test('diagnostic collector: replacement teardown bounds stalled samples and seals late results', async ({ page }, info) => {
  let resolveSample!: (state: { heading: boolean }) => void;
  const stalled = replacementDiagnostic(page, info, () => new Promise(resolve => { resolveSample = resolve; }));
  stalled.capture('finished');
  const report = await stalled.finish();
  expect(report).toMatchObject({ sampleTimedOut: true, unsettledSamples: 1, retainedSnapshots: 1, unavailableSnapshots: 0 });
  expect(report.snapshots?.[0]).toMatchObject({ sampleState: 'timed-out' });
  expect(report.snapshots?.[0]).not.toHaveProperty('heading');
  const sealed = JSON.stringify(report);
  resolveSample({ heading: true });
  await Promise.resolve();
  expect(JSON.stringify(report)).toBe(sealed);
  const ready = replacementDiagnostic(page, info, () => Promise.resolve({ heading: true }));
  ready.capture('finished');
  expect(await ready.finish()).toMatchObject({ sampleTimedOut: false, unsettledSamples: 0, unavailableSnapshots: 0, retainedSnapshots: 1 });
  const rejected = replacementDiagnostic(page, info, () => Promise.reject(new Error('Synthetic diagnostic sample failure.')));
  rejected.capture('finished');
  expect(await rejected.finish()).toMatchObject({ sampleTimedOut: false, unsettledSamples: 0, unavailableSnapshots: 1 });
});
const text = (key: keyof typeof messages, language: Language = 'en') => messages[key][language];
const FILL = [246, 243, 237];

async function hook(page: Page, value: BackgroundTestHook) {
  await page.addInitScript((initial) => { window.__stillroomBackground = { log: [], ...initial }; }, { enabled: true, ...value });
}
const patch = (page: Page, value: Partial<BackgroundTestHook>) => page.evaluate((next) => { Object.assign(window.__stillroomBackground!, next); }, value);
const log = (page: Page) => page.evaluate(() => (window.__stillroomBackground?.log ?? []) as Entry[]);
// Egress: every request in the context is recorded and classified (see background-egress.ts). `segmentation()`
// fails on any unexpected request or any segmentation request that is not a credential-free GET, then returns the
// segmentation paths. App scripts, the worker chunk and the tagging requests are classified separately.
const appOrigin = () => new URL(test.info().project.use.baseURL!).origin;
async function watch(page: Page) {
  const observer = await observeEgress(page.context(), appOrigin());
  return {
    read: observer.read,
    async segmentation() {
      const traffic = await observer.read();
      expect(traffic.unexpected).toEqual([]);
      expect(segmentationProblems(traffic)).toEqual([]);
      return traffic.segmentation.map((entry) => entry.pathname);
    },
  };
}
const inventoryPaths = modelAssets.map((file) => file.path).sort();

// A synthetic flat "garment" on a light backdrop. `split` puts a navy block on the left and a red block on the
// right, so the fixture 'left' mask visibly removes the red one.
async function syntheticPhoto(page: Page, kind: 'split' | 'shirt' = 'split'): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (shape) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 800 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d9d9d9'; context.fillRect(0, 0, 640, 800);
    if (shape === 'split') {
      context.fillStyle = '#1f3a93'; context.fillRect(60, 160, 220, 480);
      context.fillStyle = '#d12c2c'; context.fillRect(380, 300, 180, 200);
    } else {
      context.fillStyle = '#1f3a93';
      context.beginPath();
      for (const [x, y] of [[230, 140], [410, 140], [560, 250], [500, 330], [450, 290], [450, 680], [190, 680], [190, 290], [140, 330], [80, 250]]) context.lineTo(x!, y!);
      context.closePath(); context.fill();
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, kind));
}
async function choose(page: Page, bytes: Buffer, scope = '') {
  await page.locator(`${scope} input[type=file]`.trim()).first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: bytes });
}
async function openAdd(page: Page, language: Language = 'en') {
  await page.getByRole('button', { name: text('wardrobe.add', language), exact: true }).first().click();
  await expect(page.locator('.capture-photo')).toBeVisible();
}
const settled = async (page: Page, count: number, timeout = 30_000) => { await expect.poll(async () => (await log(page)).length, { timeout }).toBe(count); };
const analyses = (api: Fixture) => api.inputs.length;
// Mean RGB at fractional points of an <img>'s own decoded pixels (not its on-screen rendering).
function sample(page: Page, selector: string, points: Array<[number, number]>) {
  return page.locator(selector).evaluate(async (image: HTMLImageElement, at) => {
    const bitmap = await createImageBitmap(await (await fetch(image.src)).blob());
    const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return at.map(([x, y]) => [...context.getImageData(Math.floor(x * bitmap.width), Math.floor(y * bitmap.height), 1, 1).data.slice(0, 3)]);
  }, points);
}
const near = (actual: number[] | undefined, expected: number[], tolerance = 12) => {
  expect(actual).toBeDefined();
  actual!.forEach((value, index) => expect(Math.abs(value - expected[index]!), `${actual!.join(',')} vs ${expected.join(',')}`).toBeLessThanOrEqual(tolerance));
};
const RED = [209, 44, 44], NAVY = [31, 58, 147];
// The box of pixels that differ from the neutral fill, read from an <img>'s own decoded pixels, as numbers only.
function contentBox(page: Page, selector: string) {
  return page.locator(selector).evaluate(async (image: HTMLImageElement, fill) => {
    const bitmap = await createImageBitmap(await (await fetch(image.src)).blob());
    const { width, height } = bitmap;
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        if (Math.max(...[0, 1, 2].map((channel) => Math.abs(data[at + channel]! - fill[channel]!))) <= 16) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { width, height, left: x0 / width, right: (width - 1 - x1) / width, top: y0 / height, bottom: (height - 1 - y1) / height };
  }, FILL);
}

// The mobile project runs the same Chromium engine; it keeps the disclosure, layout and capture checks, and the
// behaviour tests run once on desktop Chromium (and on WebKit through the webkit-photo project).
const engineOnly = () => test.skip(test.info().project.name === 'mobile', 'Behaviour is covered by the chromium and webkit-photo projects.');
const sizeText = (language: Language) => new Intl.NumberFormat(locales[language], { style: 'unit', unit: 'megabyte', maximumFractionDigits: 0 })
  .format(Math.round(modelAssetBytes / 1_000_000));
test('the one-time download is disclosed before a photo is chosen, and nothing downloads yet', async ({ page }) => {
  await hook(page, { mask: 'centre' });
  const requests = await watch(page);
  const api = await aiFixture(page, 'en');
  await openAdd(page);
  await expect(page.locator('.background-note')).toHaveText(text('photo.bgLocal').replace('{size}', sizeText('en')));
  expect(await requests.segmentation()).toEqual([]);
  expect(analyses(api)).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const language of ['fi', 'sv'] satisfies Language[]) {
  test(`the disclosure reads naturally in ${language}`, async ({ page }) => {
    await hook(page, { mask: 'centre' });
    await aiFixture(page, language);
    await openAdd(page, language);
    await expect(page.locator('.background-note')).toHaveText(text('photo.bgLocal', language).replace('{size}', sizeText(language)));
  });
}

test('without the test opt-in the photo flow never loads segmentation assets', async ({ page }) => {
  const requests = await watch(page);
  const api = await aiFixture(page);
  await openAdd(page);
  await expect(page.locator('.background-note')).toHaveCount(0);
  await choose(page, await syntheticPhoto(page));
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await expect.poll(() => analyses(api)).toBe(1);
  expect(await requests.segmentation()).toEqual([]);
  await expect(page.locator('#background-original')).toHaveCount(0);
});

test.describe('cold runtime start', () => {
// Both start the runtime from cold, which is slow on the WebKit runner; run them one after the other.
test.describe.configure({ mode: 'default' });
test('removal settles before the single analysis; the cut-out replaces the background; the original costs a new analysis', async ({ page }) => {
  engineOnly();
  test.slow();
  await hook(page, { mask: 'left' });
  const requests = await watch(page);
  const api = await aiFixture(page);
  await openAdd(page);
  expect(await requests.segmentation()).toEqual([]);
  const photo = await syntheticPhoto(page);
  await choose(page, photo);
  await settled(page, 1, 75_000);
  // The kept left half (322 × 800 working pixels) is framed on a 4:5 canvas (BG2a).
  expect((await log(page))[0]).toMatchObject({ outcome: 'removed', framed: 1, width: 764, height: 955 });
  const coverage = Number((await log(page))[0]!.coverage);
  expect(coverage).toBeGreaterThan(0.4);
  expect(coverage).toBeLessThan(0.6);
  await expect.poll(() => analyses(api)).toBe(1);
  // Each approved asset once, same origin; the only tagging request is the one analysis.
  expect((await requests.segmentation()).sort()).toEqual(inventoryPaths);
  expect((await requests.read()).tagging.map((entry) => entry.method)).toEqual(['POST']);
  const [left, right] = await sample(page, '.capture-photo img', [[0.5, 0.5], [0.73, 0.5]]);
  near(left, NAVY);
  near(right, FILL);
  // The analysed bytes are the cut-out that is shown, never the intermediate original.
  const shown = await page.locator('.capture-photo img').evaluate(async (image: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  });
  expect(api.inputs[0]!.sha256).toBe(shown);

  const original = page.locator('#background-original');
  await openPhotoMenu(page);
  await expect(original).toHaveAccessibleName(text('photo.bgUseOriginal'));
  await expect(original).toHaveAccessibleDescription(text('photo.reanalyse'));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await original.click();
  await expect.poll(() => analyses(api)).toBe(2);
  await expect(original).toHaveCount(0);
  const [kept] = await sample(page, '.capture-photo img', [[0.73, 0.5]]);
  near(kept, RED);
  expect(api.inputs[1]!.sha256).not.toBe(api.inputs[0]!.sha256);
  // No new download for the second preparation, and removal was not run again.
  expect((await requests.segmentation()).sort()).toEqual(inventoryPaths);
  expect(await log(page)).toHaveLength(1);
});

test('the real model finds a synthetic garment on a plain backdrop', async ({ page }) => {
  engineOnly();
  test.setTimeout(120_000);
  await hook(page, { mask: 'model' });
  const api = await aiFixture(page);
  await openAdd(page);
  await choose(page, await syntheticPhoto(page, 'shirt'));
  await settled(page, 1, 90_000);
  const [entry] = await log(page);
  expect(entry).toMatchObject({ outcome: 'removed' });
  expect(Number(entry!.coverage)).toBeGreaterThan(0.1);
  expect(Number(entry!.coverage)).toBeLessThan(0.7);
  await expect.poll(() => analyses(api)).toBe(1);
  const [garment, corner] = await sample(page, '.capture-photo img', [[0.5, 0.6], [0.04, 0.04]]);
  near(garment, NAVY, 20);
  near(corner, FILL, 20);
});
});

const failures: Array<[string, BackgroundTestHook, string]> = [
  ['a model start-up failure', { fault: 'load' }, 'init'],
  ['an inference failure', { fault: 'run' }, 'run'],
  ['a constant mask', { mask: 'constant' }, 'degenerate'],
  ['a NaN mask', { mask: 'nan' }, 'degenerate'],
  ['a wrongly shaped output', { mask: 'shape' }, 'degenerate'],
  ['an empty mask', { mask: 'empty' }, 'degenerate'],
  ['a worker that never starts', { fault: 'hang-start', limits: { startMs: 400 } }, 'timeout'],
  ['a session that never loads', { fault: 'hang-load', limits: { loadMs: 400 } }, 'timeout'],
  ['an inference that never answers', { fault: 'hang-run', limits: { runMs: 400 } }, 'timeout'],
];
for (const [name, value, reason] of failures) {
  test(`${name} keeps the original photo and analyses it once`, async ({ page }) => {
    engineOnly();
    await hook(page, value);
    const api = await aiFixture(page);
    await openAdd(page);
    const photo = await syntheticPhoto(page);
    await choose(page, photo);
    await settled(page, 1);
    expect((await log(page))[0]).toEqual({ outcome: 'failed', reason });
    await expect(page.locator('.background-status[role=status]')).toHaveText(text('photo.bgFailed'));
    await expect.poll(() => analyses(api)).toBe(1);
    const [right] = await sample(page, '.capture-photo img', [[0.73, 0.5]]);
    near(right, RED);
    // The worker was ended from outside; the next photo gets a fresh one and succeeds.
    await patch(page, { fault: undefined, mask: 'left', limits: {} });
    await choose(page, photo);
    await settled(page, 2);
    expect((await log(page))[1]).toMatchObject({ outcome: 'removed' });
    await expect.poll(() => analyses(api)).toBe(2);
  });
}

test('"Use original background" works while removal runs, and a late result is never published or analysed', async ({ page }) => {
  engineOnly();
  await hook(page, { mask: 'left' });
  const api = await aiFixture(page);
  await openAdd(page);
  // UX2: the fields appear with the first photo, so the removal under test runs for a second photo chosen from them.
  await choose(page, await syntheticPhoto(page));
  await settled(page, 1);
  await expect.poll(() => analyses(api)).toBe(1);
  await patch(page, { runDelayMs: 2_500 });
  await choose(page, await syntheticPhoto(page));
  const original = page.locator('#background-original');
  await expect(original).toBeEnabled({ timeout: 15_000 });
  // New photo and crop controls are held while removal runs; field editing is not.
  await expect(page.locator('#choose-photo')).toBeDisabled();
  await page.locator('#item-title').fill('Typed during removal');
  await original.click();
  await settled(page, 2);
  expect((await log(page))[1]).toEqual({ outcome: 'original', reason: 'cancelled' });
  await expect.poll(() => analyses(api)).toBe(2);
  await page.waitForTimeout(3_000);
  expect(analyses(api)).toBe(2);
  expect(await log(page)).toHaveLength(2);
  const [right] = await sample(page, '.capture-photo img', [[0.73, 0.5]]);
  near(right, RED);
  await expect(page.locator('#item-title')).toHaveValue('Typed during removal');
});

for (const late of ['success', 'failure'] as const) {
  for (const exit of ['discard', 'sign-out', 'other-tab sign-out'] as const) {
    test(`a late ${late} after ${exit} is dropped without an analysis`, async ({ page, context }) => {
      engineOnly();
      await hook(page, { mask: 'left', runDelayMs: 2_000, ...late === 'failure' ? { fault: 'run' } : {} });
      const api = await aiFixture(page);
      const second = exit === 'other-tab sign-out' ? await context.newPage() : null;
      if (second) {
        await mockBackend(second, { initialLanguage: 'en' });
        await second.goto('/'); await signIn(second);
        await expect(second.locator('#wardrobe-title')).toBeVisible();
      }
      await openAdd(page);
      await choose(page, await syntheticPhoto(page));
      await expect(page.locator('#background-original')).toBeEnabled({ timeout: 15_000 });
      if (exit === 'discard') {
        await page.locator('.back-button').click();
        await page.getByRole('button', { name: text('common.discard'), exact: true }).click();
        await expect(page.locator('#wardrobe-title')).toBeVisible();
      } else if (exit === 'sign-out') {
        await openAccountMenu(page, 'en');
        await page.locator('.account-popover').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
        const discard = page.getByRole('button', { name: text('common.discard'), exact: true });
        if (await discard.isVisible().catch(() => false)) await discard.click();
        await expect(page.locator('#email')).toBeVisible();
      } else {
        // Another tab signs out; this tab follows the broadcast while removal is still running.
        await openAccountMenu(second!, 'en');
        await second!.locator('.account-popover').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
        await expect(page.locator('#email')).toBeVisible();
      }
      await page.waitForTimeout(3_000);
      expect(analyses(api)).toBe(0);
      expect((await log(page)).filter((entry) => entry.outcome === 'removed')).toEqual([]);
      if (exit !== 'discard') {
        // The next account starts clean: a new photo downloads nothing from the old attempt's state and works.
        await patch(page, { fault: undefined, runDelayMs: 0 });
        await signIn(page, 'b');
        // The route may return to Add item; either way the old photo and removal state are gone.
        await expect(page.locator('#wardrobe-title, #capture-title').first()).toBeVisible();
        await expect(page.locator('.capture-photo img')).toHaveCount(0);
        await expect(page.locator('#background-original')).toHaveCount(0);
      }
      await second?.close();
    });
  }
}

test('a failed download is not repeated for the next photo, and a new sign-in may try once more', async ({ page }) => {
  engineOnly();
  await hook(page, { mask: 'left' });
  const requests = await watch(page);
  let refuse = true;
  await page.route('**/models/*.onnx', async (route) => { if (refuse) await route.abort('failed'); else await route.fallback(); });
  const api = await aiFixture(page);
  await openAdd(page);
  const photo = await syntheticPhoto(page);
  await choose(page, photo);
  await settled(page, 1);
  expect((await log(page))[0]).toEqual({ outcome: 'failed', reason: 'download' });
  await expect.poll(() => analyses(api)).toBe(1);
  const afterFirst = (await requests.segmentation()).length;
  await choose(page, photo);
  await settled(page, 2);
  expect((await log(page))[1]).toEqual({ outcome: 'failed', reason: 'download' });
  await expect.poll(() => analyses(api)).toBe(2);
  expect(await requests.segmentation()).toHaveLength(afterFirst);
  // Signing out clears the in-memory failure; the next signed-in owner gets one new attempt.
  refuse = false;
  await openAccountMenu(page, 'en');
  await page.locator('.account-popover').getByRole('button', { name: text('auth.signOut'), exact: true }).click();
  const discard = page.getByRole('button', { name: text('common.discard'), exact: true });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  // A different owner signs in (the fixture issues one token per owner). That owner has not consented to
  // tagging, so the new attempt is counted by the removal log alone.
  await signIn(page, 'b');
  await expect(page.locator('#wardrobe-title, #capture-title').first()).toBeVisible();
  if (await page.locator('#wardrobe-title').isVisible()) await openAdd(page, 'sv');
  await expect(page.locator('.capture-photo img')).toHaveCount(0);
  await choose(page, photo);
  await settled(page, 3);
  expect((await log(page))[2]).toMatchObject({ outcome: 'removed' });
  expect(analyses(api)).toBe(2);
});

test('the egress check reports unexpected requests and credentialed or non-GET segmentation requests', async ({ page, browserName }) => {
  engineOnly();
  test.skip(browserName !== 'chromium', 'Request headers, including cookies, are read on Chromium.');
  const requests = await watch(page);
  await aiFixture(page);
  await page.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/models/unapproved.onnx', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/telemetry?**', (route) => route.fulfill({ status: 404, body: '' }));
  const [first, second] = inventoryPaths;
  await page.route(`**${first}?**`, (route) => route.fulfill({ status: 404, body: '' }));
  await page.evaluate(async ([post, credentialed]) => {
    await Promise.allSettled([
      fetch('/models/unapproved.onnx'),
      fetch('/telemetry?pixels=0a1b2c'),
      fetch(`${post!}?variant=1`),
      fetch('https://cdn.example.test/ort-wasm-simd-threaded.wasm', { mode: 'no-cors' }),
      fetch(post!, { method: 'POST', body: 'x' }),
      fetch(credentialed!, { credentials: 'include' }),
    ]);
  }, [first, second]);
  const traffic = await requests.read();
  expect(traffic.unexpected.map((entry) => entry.url).sort()).toEqual([`${appOrigin()}/models/unapproved.onnx`,
    `${appOrigin()}/telemetry?pixels=0a1b2c`, `${appOrigin()}${first}?variant=1`, 'https://cdn.example.test/ort-wasm-simd-threaded.wasm'].sort());
  expect(traffic.app.map((entry) => entry.pathname)).not.toContain('/telemetry');
  expect(segmentationProblems(traffic).sort()).toEqual([`${first}: body`, `${first}: credentials`, `${first}: method POST`, `${second}: credentials`].sort());
});

test('a browser without WebAssembly SIMD keeps the original photo without downloading anything', async ({ page }) => {
  engineOnly();
  await page.addInitScript(() => { WebAssembly.validate = () => false; });
  await hook(page, { mask: 'left' });
  const requests = await watch(page);
  const api = await aiFixture(page);
  await openAdd(page);
  await choose(page, await syntheticPhoto(page));
  await settled(page, 1);
  expect((await log(page))[0]).toEqual({ outcome: 'failed', reason: 'unsupported' });
  await expect.poll(() => analyses(api)).toBe(1);
  near((await sample(page, '.capture-photo img', [[0.73, 0.5]]))[0], RED);
  expect(await requests.segmentation()).toEqual([]);
});

test('a worker that cannot be created keeps the original photo and analyses it once', async ({ page }) => {
  engineOnly();
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (options?.name === 'background') throw new DOMException('Blocked', 'SecurityError');
        super(url, options);
      }
    };
  });
  await hook(page, { mask: 'left' });
  const api = await aiFixture(page);
  await openAdd(page);
  await choose(page, await syntheticPhoto(page));
  await settled(page, 1);
  expect((await log(page))[0]).toEqual({ outcome: 'failed', reason: 'init' });
  await expect(page.locator('.background-status[role=status]')).toHaveText(text('photo.bgFailed'));
  await expect.poll(() => analyses(api)).toBe(1);
  near((await sample(page, '.capture-photo img', [[0.73, 0.5]]))[0], RED);
});

// Both photo flows, for the cancel and repeated-press regressions.
const flows = {
  add: { photo: '.capture-photo img', edit: '#edit-photo', scope: '' },
  replace: { photo: '.image-change .capture-photo img', edit: '#image-change-edit', scope: '.image-change' },
} as const;
type Saved = ReturnType<Fixture['seedSavedItem']>;
/** The saved garment exists before the first navigation, so the app's own first wardrobe read lists it. */
async function savedFixture(page: Page) {
  const prepared: Saved[] = [];
  const api = await aiFixture(page, 'en', true, undefined, false, undefined, '/', (backend) => { prepared.push(backend.seedSavedItem()); });
  const saved = prepared[0];
  if (!saved) throw new Error('Saved item fixture was not prepared.');
  return { api, saved, before: { item: structuredClone(saved.item), image: structuredClone(saved.image), images: api.images.length } };
}
async function openFlow(page: Page, flow: keyof typeof flows) {
  if (flow === 'add') { const api = await aiFixture(page); await openAdd(page); return { api, unchanged: null }; }
  const { api, saved, before } = await savedFixture(page);
  replacementDiagnostics.get(page)?.capture('wardrobe-ready', api);
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  replacementDiagnostics.get(page)?.capture('card-opened');
  await editItem(page);
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
  replacementDiagnostics.get(page)?.capture('editor-ready');
  await page.locator('.detail-name details').evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
  await page.locator('#detail-cancel-edit').click();
  await openPhotoMenu(page);
  await page.getByRole('button', { name: text('imageChange.replace'), exact: true }).click();
  await expect(page.locator('.image-change .background-note')).toBeVisible();
  return { api, unchanged: () => {
    expect(saved.item).toEqual(before.item);
    expect(saved.image).toEqual(before.image);
    expect(api.images).toHaveLength(before.images);
  } };
}
for (const flow of ['add', 'replace'] as const) {
  const selectors = flows[flow];
  test(`${flow}: cancelling a crop while removal runs returns to the removed photo, and its original is disclosed as a new analysis`, async ({ page }) => {
    engineOnly();
    await hook(page, { mask: 'left' });
    const { api, unchanged } = await openFlow(page, flow);
    await choose(page, await syntheticPhoto(page), selectors.scope);
    await settled(page, 1);
    await expect.poll(() => analyses(api)).toBe(1);
    await patch(page, { runDelayMs: 60_000 });
    await openPhotoMenu(page);
    await page.locator(selectors.edit).click();
    await page.locator('#crop-rotate').click();
    await page.locator('#apply-crop').click();
    await expect(page.locator('#apply-crop')).toBeDisabled();
    await page.waitForTimeout(500);
    await page.locator('#crop-cancel').click();
    const original = page.locator('#background-original');
    await openPhotoMenu(page);
    await expect(original).toBeEnabled();
    await expect(original).toHaveAccessibleDescription(text('photo.reanalyse'));
    near((await sample(page, selectors.photo, [[0.73, 0.5]]))[0], FILL);
    expect(analyses(api)).toBe(1);
    await patch(page, { runDelayMs: 0 });
    await original.click();
    await expect.poll(() => analyses(api)).toBe(2);
    await expect(original).toHaveCount(0);
    near((await sample(page, selectors.photo, [[0.73, 0.5]]))[0], RED);
    // The cancelled removal never settled or published anything.
    expect(await log(page)).toHaveLength(1);
    unchanged?.();
  });

  test(`${flow}: pressing "Use original background" twice during removal settles once and keeps crop editing`, async ({ page }) => {
    engineOnly();
    await hook(page, { mask: 'left', runDelayMs: 2_500 });
    const { api, unchanged } = await openFlow(page, flow);
    await choose(page, await syntheticPhoto(page), selectors.scope);
    const original = page.locator('#background-original');
    await expect(original).toBeEnabled({ timeout: 15_000 });
    await original.dblclick();
    await settled(page, 1);
    expect((await log(page))[0]).toEqual({ outcome: 'original', reason: 'cancelled' });
    await expect.poll(() => analyses(api)).toBe(1);
    await expect(original).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(analyses(api)).toBe(1);
    near((await sample(page, selectors.photo, [[0.73, 0.5]]))[0], RED);
    await openPhotoMenu(page);
    await page.locator(selectors.edit).click();
    await expect(page.locator('.crop-stage img')).toBeVisible();
    near((await sample(page, '.crop-stage img', [[0.73, 0.5]]))[0], RED);
    unchanged?.();
  });
}

test('the cut-out is centred on a 4:5 canvas with 8 % padding; the original background is not framed', async ({ page }) => {
  engineOnly();
  await hook(page, { mask: 'left' });
  const api = await aiFixture(page);
  await openAdd(page);
  await choose(page, await syntheticPhoto(page));
  await settled(page, 1);
  const framed = await contentBox(page, '.capture-photo img');
  expect(Math.abs(framed.width * 5 - framed.height * 4)).toBeLessThanOrEqual(5);
  // Strictly centred within 2 %; the height limits the frame, so top and bottom are about 8 %.
  expect(Math.abs(framed.left - framed.right)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(framed.top - framed.bottom)).toBeLessThanOrEqual(0.02);
  expect(framed.top).toBeGreaterThan(0.065);
  expect(framed.top).toBeLessThan(0.095);
  expect(framed.left).toBeGreaterThan(0.08);
  await expect.poll(() => analyses(api)).toBe(1);
  await openPhotoMenu(page);
  await page.locator('#background-original').click();
  await expect.poll(() => analyses(api)).toBe(2);
  await expect(page.locator('#background-original')).toHaveCount(0);
  const original = await contentBox(page, '.capture-photo img');
  expect([original.width, original.height]).toEqual([640, 800]);
  // The backdrop fills the whole original, edge to edge.
  expect([original.left, original.right, original.top, original.bottom]).toEqual([0, 0, 0, 0]);
  expect(await log(page)).toHaveLength(1);
});

test('Add item: crop editing uses the unsegmented photo, and re-preparing removes the background again', async ({ page }) => {
  engineOnly();
  await hook(page, { mask: 'left' });
  const api = await aiFixture(page);
  await openAdd(page);
  await choose(page, await syntheticPhoto(page));
  await settled(page, 1);
  near((await sample(page, '.capture-photo img', [[0.73, 0.5]]))[0], FILL);
  await openPhotoMenu(page);
  await page.locator('#edit-photo').click();
  // The red block the mask removed is still there to crop around.
  near((await sample(page, '.crop-stage img', [[0.73, 0.5]]))[0], RED);
  await page.locator('#crop-rotate').click();
  await page.locator('#apply-crop').click();
  await settled(page, 2);
  // Rotated to 800 × 640, the kept left half (403 × 640) is framed again on a 4:5 canvas.
  expect((await log(page))[1]).toMatchObject({ outcome: 'removed', framed: 1, width: 612, height: 765 });
  await expect.poll(() => analyses(api)).toBe(2);
  await openPhotoMenu(page);
  await page.locator('#edit-photo').click();
  near((await sample(page, '.crop-stage img', [[0.73, 0.5]]))[0], RED);
});

// The first collection GET request of the saved items list, whatever happens to it: its own response is awaited, and
// a failed request or a non-success status is reported, never replaced by a later successful retry.
const itemsOrigin = 'http://127.0.0.1:54321';
function firstItemsCollectionRead(page: Page) {
  let first: Request | undefined;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!first && url.origin === itemsOrigin && url.pathname === '/rest/v1/items' && !url.searchParams.has('id') && request.method() === 'GET') first = request;
  });
  return async () => {
    await expect.poll(() => first !== undefined).toBe(true);
    const response = await first!.response();
    if (!response) return { responded: false as const, status: 0, ids: [] as string[] };
    const body = response.ok() ? await response.json() as Array<{ id: string }> : [];
    return { responded: true as const, status: response.status(), ids: body.map((row) => row.id) };
  };
}
test('first-read observer: an initial 503 followed by a successful retry, or no response, is not a first-read success', async ({ page }) => {
  const known = 'c329a000-0000-4000-8000-000000000001';
  await page.goto('about:blank');
  let calls = 0;
  const accepted: Array<Promise<{ id: string }[]>> = [];
  page.on('response', (response) => {
    if (response.url().startsWith(`${itemsOrigin}/rest/v1/items`) && response.ok()) accepted.push(response.json());
  });
  await page.route(`${itemsOrigin}/rest/v1/items**`, async (route) => {
    calls++;
    const headers = { 'access-control-allow-origin': '*' };
    if (calls === 1) await route.fulfill({ status: 503, headers, json: { message: 'unavailable' } });
    else if (calls === 2) await route.fulfill({ status: 200, headers, json: [{ id: known }] });
    else await route.abort();
  });
  const read = firstItemsCollectionRead(page);
  const fetchItems = () => page.evaluate((origin) => fetch(`${origin}/rest/v1/items?select=id`).then((reply) => reply.status, () => 0), itemsOrigin);
  expect(await fetchItems()).toBe(503);
  expect(await fetchItems()).toBe(200);
  // The superseded observer kept only successful responses, so it accepted the retry as if it were the first read.
  await expect.poll(() => accepted.length).toBe(1);
  expect((await accepted[0]!).map((row) => row.id)).toContain(known);
  const result = await read();
  expect(result).toEqual({ responded: true, status: 503, ids: [] });
  expect(result.ids).not.toContain(known);

  const lost = await page.context().newPage();
  await lost.route(`${itemsOrigin}/rest/v1/items**`, (route) => route.abort());
  const lostRead = firstItemsCollectionRead(lost);
  await lost.goto('about:blank');
  await lost.evaluate((origin) => fetch(`${origin}/rest/v1/items?select=id`).then(() => 0, () => 0), itemsOrigin);
  expect(await lostRead()).toEqual({ responded: false, status: 0, ids: [] });
  await lost.close();
});

test('Replace photo: the saved item is in the first wardrobe read, so setup needs no reload', async ({ page }) => {
  let documents = 0;
  page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  const read = firstItemsCollectionRead(page);
  const { saved } = await savedFixture(page);
  const first = await read();
  expect(first.responded, 'the first collection read must receive a response').toBe(true);
  expect(first.status).toBe(200);
  expect(first.ids).toContain(saved.item.id);
  await expect(page.locator(`a[href="#/items/${saved.item.id}"]`)).toBeVisible();
  expect(documents).toBe(1);
});
test('Replace photo: the saved item is unchanged until Save, crop editing uses the unsegmented photo, and discard keeps the stored image', async ({ page }) => {
  engineOnly();
  await hook(page, { mask: 'left' });
  const { saved, before: { item, image, images }, api } = await savedFixture(page);
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await editItem(page);
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
  await page.locator('.detail-name details').evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
  await page.locator('#detail-cancel-edit').click();
  await openPhotoMenu(page);
  await page.getByRole('button', { name: text('imageChange.replace'), exact: true }).click();
  await expect(page.locator('.image-change .background-note')).toBeVisible();
  await choose(page, await syntheticPhoto(page), '.image-change');
  await settled(page, 1);
  expect((await log(page))[0]).toMatchObject({ outcome: 'removed' });
  await expect.poll(() => analyses(api)).toBe(1);
  near((await sample(page, '.image-change .capture-photo img', [[0.73, 0.5]]))[0], FILL);
  await openPhotoMenu(page);
  await page.locator('#image-change-edit').click();
  near((await sample(page, '.crop-stage img', [[0.73, 0.5]]))[0], RED);
  await page.locator('#crop-rotate').click();
  await page.locator('#apply-crop').click();
  await settled(page, 2);
  await expect.poll(() => analyses(api)).toBe(2);
  expect(saved.item).toEqual(item);
  expect(saved.image).toEqual(image);
  expect(api.images).toHaveLength(images);
  await page.locator('.image-change').getByRole('button', { name: text('common.cancel'), exact: true }).click();
  const discard = page.getByRole('button', { name: text('common.discard'), exact: true });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await expect(page.locator('#detail-edit')).toBeVisible();
  expect(saved.item).toEqual(item);
  expect(saved.image).toEqual(image);
  expect(api.images).toHaveLength(images);
});

// Bounded synthetic captures for the coordinator's visual review. Written to ignored buffers only; never opened
// by the test author or the model.
const directory = path.resolve('test-results/bg1-visual');
const scenes = [
  { scene: 'removed', language: 'en', project: 'chromium', suffix: 'en-desktop', value: { mask: 'left' } },
  { scene: 'working', language: 'sv', project: 'mobile', suffix: 'sv-mobile', value: { mask: 'left', runDelayMs: 60_000 } },
  { scene: 'fallback', language: 'fi', project: 'mobile', suffix: 'fi-mobile', value: { fault: 'run' } },
] as const satisfies ReadonlyArray<{ scene: string; language: Language; project: string; suffix: string; value: BackgroundTestHook }>;
for (const selected of scenes) {
  test(`capture: ${selected.scene} (${selected.suffix})`, async ({ page }) => {
    test.skip(test.info().project.name !== selected.project, 'One project per capture.');
    await hook(page, selected.value);
    await aiFixture(page, selected.language);
    await openAdd(page, selected.language);
    await choose(page, await syntheticPhoto(page));
    if (selected.scene === 'working') await expect(page.locator('#background-original')).toBeEnabled({ timeout: 15_000 });
    else await settled(page, 1);
    if (selected.scene === 'fallback') await expect(page.locator('.background-status[role=status]')).toHaveText(text('photo.bgFailed', selected.language));
    if (selected.scene === 'removed') { await openPhotoMenu(page); await expect(page.locator('#background-original')).toBeVisible(); }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
    expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    await mkdir(directory, { recursive: true });
    const file = await open(path.join(directory, `${selected.scene}-${selected.suffix}.png`), 'w');
    try { await file.writeFile(png); } finally { await file.close(); }
  });
}
