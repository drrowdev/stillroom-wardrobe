import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { CLEANUP_NOTICE_REVISION } from '../../src/domain/enhancement';
import { messages, type Language } from '../../src/i18n';
import type { BackgroundTestHook } from '../../src/images/background/test-hook';
import { aiFixture } from './ai-photo-first-support';
import { enhanceServerNow, owners, type EnhanceReply, type EnhanceReplyValue, type EnhanceSetup } from './mock-backend';

// BG2b-2 photo enhancement in both photo flows, against the mocked backend; since BG2c-2 the "clean up photo" step:
// a new photo is reviewed in the crop editor before anything is sent, H0 (the accepted crop's original pixels) is sent
// and H1 (the cut-out) stays the fallback. Every assertion is text: request counts,
// SHA-256 digests of the bytes analysed, sent and saved, visible copy and axe results. No image is looked at by the
// test author or the model; captures are written to ignored buffers for the coordinator's review.
type Fixture = Awaited<ReturnType<typeof aiFixture>>;
const text = (key: keyof typeof messages, language: Language = 'en') => messages[key][language];
const engineOnly = () => test.skip(test.info().project.name === 'mobile', 'Behaviour is covered by the chromium and webkit-photo projects.');

async function hook(page: Page, value: BackgroundTestHook) {
  await page.addInitScript((initial) => { window.__stillroomBackground = { log: [], ...initial }; }, { enabled: true, ...value });
  // Playwright's WebKit route interception reports an empty body for Blob uploads, so on that engine the mocked
  // provider would see no photo. Only the enhance-photo request is re-sent with the same bytes as an ArrayBuffer.
  if (test.info().project.name === 'webkit-photo') {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/functions/v1/enhance-photo') && init?.body instanceof Blob) {
          return original(input, { ...init, body: await init.body.arrayBuffer() });
        }
        return original(input, init);
      };
    });
  }
}
const removals = (page: Page) => page.evaluate(() => (window.__stillroomBackground?.log ?? []).length);
async function syntheticPhoto(page: Page, shade = '#1f3a93'): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (fill) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 800 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d9d9d9'; context.fillRect(0, 0, 640, 800);
    context.fillStyle = fill; context.fillRect(60, 160, 220, 480);
    context.fillStyle = '#d12c2c'; context.fillRect(380, 300, 180, 200);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, shade));
}
// A stand-in for the provider: the sent photo (H0) redrawn at exactly 1024 x 1280 by the page's own JPEG encoder, with
// everything but the dark, not-red garment painted #F6F3ED. So it passes the shared admission profile and the clean-up
// check like a faithful clean-up would: a plain background, the grey backdrop and the red neighbour removed.
async function redraw(page: Page, bytes: Buffer, width = 1024, height = 1280): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async ([data, w, h]) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }));
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const image = context.getImageData(0, 0, w, h), px = image.data;
    for (let at = 0; at < px.length; at += 4) {
      const [r, g, b] = [px[at]!, px[at + 1]!, px[at + 2]!];
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < 150 && r <= Math.max(g, b)) continue;
      px[at] = 0xf6; px[at + 1] = 0xf3; px[at + 2] = 0xed;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/jpeg', 0.9));
    // The app's own encoder clean-up (served by the dev server), as a provider result that passes admission unchanged.
    const jpeg = '/src/images/jpeg.ts';
    const { stripEncoderMetadata } = await import(/* @vite-ignore */ jpeg) as { stripEncoderMetadata: (value: Uint8Array) => Uint8Array };
    return [...stripEncoderMetadata(new Uint8Array(await blob.arrayBuffer()))];
  }, [[...bytes], width, height] as const));
}
const enhanced = (page: Page, over: Partial<EnhanceReplyValue> = {}): EnhanceReply => async (bytes) => ({ status: 200, image: await redraw(page, bytes), ...over });
const held = (reply: EnhanceReply) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wrapped: EnhanceReply = async (bytes, owner, requestId) => {
    const value = typeof reply === 'function' ? await reply(bytes, owner, requestId) : reply;
    return { ...value, hold: gate };
  };
  return { reply: wrapped, release: () => release() };
};

type Start = { language?: Language; setup?: Partial<EnhanceSetup>; consent?: boolean; background?: BackgroundTestHook; lost?: 'reservation' };
async function start(page: Page, options: Start = {}) {
  await hook(page, options.background ?? { mask: 'left' });
  const api = await aiFixture(page, options.language ?? 'en', true, options.lost);
  api.enhanceControl.setup[owners.a] = { activated: true, ...options.setup };
  api.enhanceControl.consent[owners.a] = options.consent === false ? null : CLEANUP_NOTICE_REVISION;
  return api;
}
const flows = {
  add: { photo: '.capture-photo img', edit: '#edit-photo', scope: '' },
  replace: { photo: '.image-change .capture-photo img', edit: '#image-change-edit', scope: '.image-change' },
} as const;
type Flow = keyof typeof flows;
async function openFlow(page: Page, api: Fixture, flow: Flow, language: Language = 'en') {
  if (flow === 'add') {
    await page.getByRole('button', { name: text('wardrobe.add', language), exact: true }).first().click();
    await expect(page.locator('.capture-photo')).toBeVisible();
    return null;
  }
  const saved = api.seedSavedItem();
  await page.reload();
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
  await page.locator('.detail-name details').evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
  await page.getByRole('button', { name: text('imageChange.replace', language), exact: true }).click();
  await expect(page.locator('.image-change .background-note')).toBeVisible();
  return saved;
}
async function choose(page: Page, flow: Flow, bytes: Buffer) {
  await page.locator(`${flows[flow].scope} input[type=file]`.trim()).first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: bytes });
}
// The pre-upload review (BG2c R1): the crop editor with the review hint, before anything is sent.
const reviewHint = (page: Page) => page.locator('#crop-review-hint');
async function inReview(page: Page, language: Language = 'en') {
  await expect(reviewHint(page)).toHaveText(text('enhance.reviewHint', language), { timeout: 45_000 });
  await expect(page.locator('section.crop-editor')).toHaveAttribute('aria-describedby', 'crop-review-hint');
}
/** Waits for the review and taps Done without changing the crop. */
async function accept(page: Page, language: Language = 'en') {
  await inReview(page, language);
  await page.locator('#apply-crop').click();
}
// For one render after a commit the <img> can still point at the provisional preview, whose blob URL the next effect
// revokes; a read in that gap fails to load. The digest is taken from the settled preview, the one that stays loaded.
async function shown(page: Page, flow: Flow): Promise<string> {
  let digest = '';
  await expect.poll(async () => {
    digest = await page.locator(flows[flow].photo).evaluate(async (image: HTMLImageElement) => {
      try {
        const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer());
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
      } catch { return ''; }
    });
    return digest;
  }, { timeout: 10_000 }).not.toBe('');
  return digest;
}
const analyses = (api: Fixture) => api.inputs.length;
const sent = (api: Fixture) => api.enhanceControl.requests;
const label = (page: Page, language: Language = 'en') => page.locator('.enhancement-label', { hasText: text('enhance.edited', language) });
const revertButton = (page: Page, language: Language = 'en') => page.getByRole('button', { name: text('enhance.revert', language), exact: true });
const line = (page: Page, key: 'enhance.fallback' | 'enhance.allowance' | 'enhance.ambiguous', language: Language = 'en') =>
  page.locator('.background-status[role=status]', { hasText: text(key, language) });
async function noViolations(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
async function saveFlow(page: Page, flow: Flow) {
  if (flow === 'add') {
    await expect(page.locator('#item-category')).not.toHaveValue('');
    await page.locator('#item-title').fill('Enhanced overshirt');
    await page.getByRole('button', { name: text('capture.save'), exact: true }).click();
    await expect(page.locator('#wardrobe-title')).toBeVisible();
  } else {
    await page.locator('.image-change').getByRole('button', { name: text('imageChange.save'), exact: true }).click();
    await expect(page.locator('#detail-title')).toBeVisible();
    await expect(page.locator('.image-change')).toHaveCount(0);
  }
}
const currentImage = (api: Fixture, itemId?: string) => api.images.filter((row) => row.state === 'ready' && (!itemId || row.item_id === itemId)).at(-1);

// Coordinate-basis evidence (BG2c-2 review): a 640 x 800 photo of four 160 px vertical bands, A to D from left to right.
// Every check reads decoded pixels and names the bands found, so the sent H0 can be compared with what the editor shows.
const BANDS = { A: [198, 40, 40], B: [31, 58, 147], C: [46, 125, 50], D: [249, 168, 37] } as const;
async function bandPhoto(page: Page): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (bands) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 800 });
    const context = canvas.getContext('2d')!;
    Object.values(bands).forEach(([r, g, b], index) => { context.fillStyle = `rgb(${r},${g},${b})`; context.fillRect(index * 160, 0, 160, 800); });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, BANDS));
}
type BandReading = { width: number; height: number; row: string[]; column: string[] };
/** The bands met along the middle row (left to right) and middle column (top to bottom), each run named once. */
async function bandsOf(page: Page, bytes: Buffer | number[]): Promise<BandReading> {
  return page.evaluate(async ([data, bands]) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const name = (fx: number, fy: number) => {
      const x = Math.min(canvas.width - 3, Math.max(0, Math.round(fx * canvas.width) - 1));
      const y = Math.min(canvas.height - 3, Math.max(0, Math.round(fy * canvas.height) - 1));
      const px = context.getImageData(x, y, 3, 3).data, mean = [0, 0, 0];
      for (let at = 0; at < px.length; at += 4) for (let c = 0; c < 3; c += 1) mean[c]! += px[at + c]! / 9;
      const found = Object.entries(bands).find(([, rgb]) => Math.hypot(...rgb.map((value, c) => value - mean[c]!)) < 60);
      return found?.[0] ?? null;
    };
    const walk = (point: (step: number) => [number, number]) => {
      const names: string[] = [];
      for (let step = 1; step < 40; step += 1) {
        const band = name(...point(step / 40));
        if (band && band !== names.at(-1)) names.push(band);
      }
      return names;
    };
    return { width: canvas.width, height: canvas.height, row: walk((f) => [f, 0.5]), column: walk((f) => [0.5, f]) };
  }, [[...bytes], BANDS] as const);
}
/** The crop editor's own source image: the whole photo whose coordinates every edit uses. */
async function editorSource(page: Page): Promise<BandReading> {
  const bytes = await page.locator('section.crop-editor .crop-stage img').evaluate(async (image: HTMLImageElement) =>
    [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())]);
  return bandsOf(page, bytes);
}
async function setCrop(page: Page, values: Partial<Record<'x' | 'y' | 'width' | 'height', string>>) {
  await page.locator('.crop-exact').evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  for (const field of ['width', 'height', 'x', 'y'] as const) {
    if (values[field] !== undefined) await page.locator(`#crop-${field}`).fill(values[field]);
  }
}
/** Records each H0 the provider receives, and answers like a faithful clean-up. */
const recording = (page: Page, into: Buffer[]): EnhanceReply => async (bytes) => {
  into.push(Buffer.from(bytes));
  return { status: 200, image: await redraw(page, bytes) };
};

// Reads every Cache Storage entry and every IndexedDB value in the page and returns the SHA-256 of each binary found.
const storedDigests = (page: Page) => page.evaluate(async () => {
  const digests: string[] = [];
  const hex = async (buffer: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
    (value) => value.toString(16).padStart(2, '0')).join('');
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response) digests.push(await hex(await response.arrayBuffer()));
    }
  }
  const visit = async (value: unknown, depth: number): Promise<void> => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (value instanceof Blob) { digests.push(await hex(await value.arrayBuffer())); return; }
    if (value instanceof ArrayBuffer) { digests.push(await hex(value)); return; }
    if (ArrayBuffer.isView(value)) { digests.push(await hex(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)); return; }
    for (const entry of Object.values(value as Record<string, unknown>)) await visit(entry, depth + 1);
  };
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(info.name!);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        for (const value of values) await visit(value, 0);
      }
    } finally { db.close(); }
  }
  return digests;
});

for (const flow of ['add', 'replace'] as const) {
  test(`${flow}: review, then an unchanged Done sends H0 once; the cleaned-up photo is analysed once and labelled, and the cut-out comes back with one new analysis`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page));
    const saved = await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await inReview(page);
    // Nothing is sent or analysed while the crop is being reviewed.
    await page.waitForTimeout(300);
    expect(sent(api)).toHaveLength(0);
    expect(analyses(api)).toBe(0);
    await noViolations(page);
    await page.locator('#apply-crop').click();
    await expect(label(page)).toBeVisible({ timeout: 45_000 });
    await expect(reviewHint(page)).toHaveCount(0);
    await expect.poll(() => analyses(api)).toBe(1);
    expect(sent(api)).toHaveLength(1);
    const h0 = sent(api)[0]!.sha256;
    const h2 = await shown(page, flow);
    expect(h2).not.toBe(h0);
    expect(api.inputs[0]!.sha256).toBe(h2);
    await expect(revertButton(page)).toHaveAccessibleDescription(text('enhance.revertHelp'));
    await noViolations(page);
    await revertButton(page).click();
    await expect.poll(() => analyses(api)).toBe(2);
    // H1, the cut-out, is analysed and shown: never H0, which was only sent.
    const h1 = api.inputs[1]!.sha256;
    expect([h0, h2]).not.toContain(h1);
    expect(await shown(page, flow)).toBe(h1);
    await expect(label(page)).toHaveCount(0);
    await expect(line(page, 'enhance.fallback')).toHaveCount(0);
    await noViolations(page);
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(1);
    expect(analyses(api)).toBe(2);
    expect(await removals(page)).toBe(1);
    // The request carried only the photo: no probe headers (the fixture throws on them) and one request ID.
    expect(sent(api)[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    if (saved) expect(currentImage(api, String(saved.item.id))!.id).toBe(saved.image.id);
  });

  test(`${flow}: a changed crop in the review is prepared again and sent once`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page));
    await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await inReview(page);
    await page.locator('#crop-rotate').click();
    await page.locator('#apply-crop').click();
    await expect(label(page)).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => analyses(api)).toBe(1);
    expect(sent(api)).toHaveLength(1);
    expect(await removals(page)).toBe(2);
    expect(api.inputs[0]!.sha256).toBe(await shown(page, flow));
  });

  test(`${flow}: after a changed crop is accepted in the review, a later edit still crops the whole photo and H0 holds only the region shown`, async ({ page }) => {
    engineOnly();
    test.slow();
    const api = await start(page, { background: { mask: 'centre' } });
    const h0: Buffer[] = [];
    api.enhanceControl.replies.push(recording(page, h0), recording(page, h0));
    await openFlow(page, api, flow);
    await choose(page, flow, await bandPhoto(page));
    await inReview(page);
    expect((await editorSource(page)).row).toEqual(['A', 'B', 'C', 'D']);
    await setCrop(page, { x: '25', y: '0', width: '50', height: '100' });
    await page.locator('#apply-crop').click();
    await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
    expect(h0).toHaveLength(1);
    expect((await bandsOf(page, h0[0]!)).row).toEqual(['B', 'C']);
    await page.locator(flows[flow].edit).click();
    await expect(page.locator('section.crop-editor')).toBeVisible();
    // The editor shows the whole upright photo again, with the accepted crop at the same place on it.
    const source = await editorSource(page);
    expect(source.row).toEqual(['A', 'B', 'C', 'D']);
    expect(source.height).toBeGreaterThan(source.width);
    await expect(page.locator('#crop-x')).toHaveValue('25');
    await expect(page.locator('#crop-width')).toHaveValue('50');
    // The right half of the accepted crop is band C alone; nothing from D, outside it, may be sent.
    await setCrop(page, { x: '50', width: '25' });
    await page.locator('#apply-crop').click();
    await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(2);
    expect(h0).toHaveLength(2);
    const second = await bandsOf(page, h0[1]!);
    expect(second.row).toEqual(['C']);
    expect(second.column).toEqual(['C']);
  });

  test(`${flow}: a rotation accepted in the review is applied once, and a later crop of the rotated photo sends only that region`, async ({ page }) => {
    engineOnly();
    test.slow();
    const api = await start(page, { background: { mask: 'centre' } });
    const h0: Buffer[] = [];
    api.enhanceControl.replies.push(recording(page, h0), recording(page, h0));
    await openFlow(page, api, flow);
    await choose(page, flow, await bandPhoto(page));
    await inReview(page);
    await page.locator('#crop-rotate').click();
    await page.locator('#apply-crop').click();
    await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
    expect(h0).toHaveLength(1);
    // A quarter turn lays the bands across: one band per row, all four down the middle.
    const turned = await bandsOf(page, h0[0]!);
    expect(turned.row).toHaveLength(1);
    expect([...turned.column].sort()).toEqual(['A', 'B', 'C', 'D']);
    await page.locator(flows[flow].edit).click();
    await expect(page.locator('section.crop-editor')).toBeVisible();
    // The source is still the upright photo; the editor turns it once for display.
    const source = await editorSource(page);
    expect(source.row).toEqual(['A', 'B', 'C', 'D']);
    expect(source.height).toBeGreaterThan(source.width);
    // The top half of the turned photo shown in the editor holds its first two bands, and only those are sent.
    await setCrop(page, { x: '0', y: '0', width: '100', height: '50' });
    await page.locator('#apply-crop').click();
    await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(2);
    expect(h0).toHaveLength(2);
    const half = await bandsOf(page, h0[1]!);
    expect(half.row).toHaveLength(1);
    expect(half.column).toEqual(turned.column.slice(0, 2));
  });

  test(`${flow}: Cancel while an accepted changed crop is still being prepared keeps the first pass, with nothing sent`, async ({ page }) => {
    engineOnly();
    const api = await start(page, { background: { mask: 'centre' } });
    api.enhanceControl.replies.push(enhanced(page));
    await openFlow(page, api, flow);
    await choose(page, flow, await bandPhoto(page));
    await inReview(page);
    await setCrop(page, { x: '25', width: '50' });
    await page.evaluate(() => { window.__stillroomBackground!.runDelayMs = 60_000; });
    await page.locator('#apply-crop').click();
    await expect(page.locator('section.crop-editor')).toHaveAttribute('aria-busy', 'true');
    await page.locator('#crop-cancel').click();
    await expect(page.locator('section.crop-editor')).toHaveCount(0);
    await expect.poll(() => analyses(api)).toBe(1);
    expect(await shown(page, flow)).toBe(api.inputs[0]!.sha256);
    const kept = await page.locator(flows[flow].photo).evaluate(async (image: HTMLImageElement) =>
      [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())]);
    expect((await bandsOf(page, kept)).row).toEqual(['A', 'B', 'C', 'D']);
    await expect(label(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(0);
    expect(analyses(api)).toBe(1);
    await page.locator(flows[flow].edit).click();
    expect((await editorSource(page)).row).toEqual(['A', 'B', 'C', 'D']);
    await expect(page.locator('#crop-width')).toHaveValue('100');
  });

  for (const after of ['Done', 'Cancel', 'Use original'] as const) {
    test(`${flow}: a failed accepted crop keeps the review open; then ${after} works and a later edit still has the whole photo`, async ({ page }) => {
      engineOnly();
      test.slow();
      const api = await start(page, { background: { mask: 'centre' } });
      const h0: Buffer[] = [];
      api.enhanceControl.replies.push(recording(page, h0), recording(page, h0));
      await openFlow(page, api, flow);
      await choose(page, flow, await bandPhoto(page));
      await inReview(page);
      await setCrop(page, { x: '25', width: '50' });
      // The accepted crop's preparation fails: the encoder returns nothing.
      await page.evaluate(() => {
        const native = HTMLCanvasElement.prototype.toBlob;
        Object.assign(window, { nativeToBlob: native });
        HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
      });
      await page.locator('#apply-crop').click();
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 45_000 });
      await expect(reviewHint(page)).toBeVisible();
      await expect(page.locator('#apply-crop')).toBeEnabled();
      expect(sent(api)).toHaveLength(0);
      expect(analyses(api)).toBe(0);
      await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = (window as unknown as { nativeToBlob: typeof HTMLCanvasElement.prototype.toBlob }).nativeToBlob; });
      if (after === 'Done') {
        await page.locator('#apply-crop').click();
        await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
        expect(h0).toHaveLength(1);
        expect((await bandsOf(page, h0[0]!)).row).toEqual(['B', 'C']);
      } else {
        await page.locator(after === 'Cancel' ? '#crop-cancel' : '#background-original').click();
        await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
        await page.waitForTimeout(300);
        expect(sent(api)).toHaveLength(0);
      }
      await expect(page.locator('section.crop-editor')).toHaveCount(0);
      // A later edit still crops the whole photo from the original file.
      await page.locator(flows[flow].edit).click();
      expect((await editorSource(page)).row).toEqual(['A', 'B', 'C', 'D']);
      await setCrop(page, { x: '50', y: '0', width: '25', height: '100' });
      await page.locator('#apply-crop').click();
      await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(2);
      await expect(page.locator('section.crop-editor')).toHaveCount(0);
      if (after !== 'Use original') expect((await bandsOf(page, h0.at(-1)!)).row).toEqual(['C']);
      else expect(sent(api)).toHaveLength(0);
    });
  }

  test(`${flow}: Cancel in the review keeps the new photo's cut-out with one analysis and sends nothing`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page));
    const saved = await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await inReview(page);
    await page.locator('#crop-cancel').click();
    await expect(reviewHint(page)).toHaveCount(0);
    await expect.poll(() => analyses(api)).toBe(1);
    expect(await shown(page, flow)).toBe(api.inputs[0]!.sha256);
    await expect(label(page)).toHaveCount(0);
    await expect(line(page, 'enhance.fallback')).toHaveCount(0);
    await noViolations(page);
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(0);
    expect(analyses(api)).toBe(1);
    await saveFlow(page, flow);
    await expect.poll(() => currentImage(api, saved ? String(saved.item.id) : undefined)?.main_sha256).toBe(api.inputs[0]!.sha256);
  });

  test(`${flow}: "Use original background" in the review sends nothing and analyses the original once`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await inReview(page);
    await page.locator('#background-original').click();
    await expect(reviewHint(page)).toHaveCount(0);
    await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(0);
    expect(analyses(api)).toBe(1);
    await expect(label(page)).toHaveCount(0);
    await expect(line(page, 'enhance.fallback')).toHaveCount(0);
  });

  test(`${flow}: two garments in the crop send nothing and say to crop to one`, async ({ page }) => {
    engineOnly();
    const api = await start(page, { background: { mask: 'two' } });
    await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await expect(line(page, 'enhance.ambiguous')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => analyses(api)).toBe(1);
    await expect(reviewHint(page)).toHaveCount(0);
    await noViolations(page);
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(0);
    expect(analyses(api)).toBe(1);
  });

  test(`${flow}: a later edit of the cleaned-up photo, cancelled or with an unchanged Done, keeps it with no new request or analysis`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page));
    await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await accept(page);
    await expect(label(page)).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => analyses(api)).toBe(1);
    const accepted = await shown(page, flow), reads = api.enhanceControl.statusReads;
    for (const button of ['#crop-cancel', '#apply-crop']) {
      await page.locator(flows[flow].edit).click();
      await expect(page.locator('section.crop-editor')).toBeVisible();
      // A later edit is not a review: no hint, and Done with an unchanged crop is a cancel.
      await expect(reviewHint(page)).toHaveCount(0);
      await page.locator(button).click();
      await expect(page.locator('section.crop-editor')).toHaveCount(0);
      await expect(label(page)).toBeVisible();
      expect(await shown(page, flow)).toBe(accepted);
    }
    await page.waitForTimeout(500);
    expect(sent(api)).toHaveLength(1);
    expect(analyses(api)).toBe(1);
    expect(api.enhanceControl.statusReads).toBe(reads);
    expect(await removals(page)).toBe(1);
  });

  test(`${flow}: an enhanced analysed Save stores the enhanced bytes, and nothing of them is cached after sign-out`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page));
    const saved = await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await accept(page);
    await expect(label(page)).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => analyses(api)).toBe(1);
    const h2 = await shown(page, flow);
    await saveFlow(page, flow);
    await expect.poll(() => currentImage(api, saved ? String(saved.item.id) : undefined)?.main_sha256).toBe(h2);
    expect(analyses(api)).toBe(1);
    expect(sent(api)).toHaveLength(1);
    await page.getByRole('button', { name: text('account.menu') }).click();
    await page.getByRole('button', { name: text('auth.signOut'), exact: true }).click();
    await expect(page.locator('#email')).toBeVisible();
    const digests = await storedDigests(page);
    expect(digests).not.toContain(h2);
    expect(digests).not.toContain(sent(api)[0]!.sha256);
  });

  test(`${flow}: cancelling a changed crop while it is being enhanced keeps the accepted photo, which is then saved`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(enhanced(page));
    const saved = await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await accept(page);
    await expect(label(page)).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => analyses(api)).toBe(1);
    const accepted = await shown(page, flow);
    const second = held(enhanced(page));
    api.enhanceControl.replies.push(second.reply);
    await page.locator(flows[flow].edit).click();
    await page.locator('#crop-rotate').click();
    await page.locator('#apply-crop').click();
    const cancel = page.locator('#enhance-cancel-crop');
    await expect(cancel).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(text('enhance.working'), { exact: true })).toBeVisible();
    expect(sent(api)).toHaveLength(2);
    await cancel.click();
    await expect(page.getByText(text('enhance.working'), { exact: true })).toHaveCount(0);
    await expect(label(page)).toBeVisible();
    expect(await shown(page, flow)).toBe(accepted);
    second.release();
    await page.waitForTimeout(1_000);
    expect(await shown(page, flow)).toBe(accepted);
    expect(analyses(api)).toBe(1);
    await saveFlow(page, flow);
    await expect.poll(() => currentImage(api, saved ? String(saved.item.id) : undefined)?.main_sha256).toBe(accepted);
    expect(analyses(api)).toBe(1);
  });

  test(`${flow}: "Skip" keeps the cut-out for one analysis, and a late result is never shown or analysed`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    const late = held(enhanced(page));
    api.enhanceControl.replies.push(late.reply);
    await openFlow(page, api, flow);
    await choose(page, flow, await syntheticPhoto(page));
    await accept(page);
    const skip = page.getByRole('button', { name: text('enhance.skip'), exact: true });
    await expect(skip).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[role=status]', { hasText: text('enhance.working') })).toBeVisible();
    expect(analyses(api)).toBe(0);
    await noViolations(page);
    await skip.click();
    await expect.poll(() => analyses(api)).toBe(1);
    expect(api.inputs[0]!.sha256).not.toBe(sent(api)[0]!.sha256);
    late.release();
    await page.waitForTimeout(1_500);
    expect(analyses(api)).toBe(1);
    await expect(label(page)).toHaveCount(0);
    await expect(line(page, 'enhance.fallback')).toHaveCount(0);
    expect(await shown(page, flow)).toBe(api.inputs[0]!.sha256);
  });
}

// Each row: the reply, the line shown and whether the failure counts toward the 10-minute pause.
const fallbacks: Array<[string, (page: Page) => EnhanceReply, 'enhance.fallback' | 'enhance.allowance']> = [
  ['FAILED', () => ({ status: 502, body: { code: 'FAILED' } }), 'enhance.fallback'],
  ['TIMEOUT', () => ({ status: 504, body: { code: 'TIMEOUT' } }), 'enhance.fallback'],
  ['ALLOWANCE', () => ({ status: 429, body: { code: 'ALLOWANCE' } }), 'enhance.allowance'],
  ['OUTPUT_REJECTED', () => ({ status: 502, body: { code: 'OUTPUT_REJECTED' } }), 'enhance.fallback'],
  ['a digest that does not match the bytes', (page) => enhanced(page, { sha256: 'f'.repeat(64) }), 'enhance.fallback'],
  ['an image of the wrong size', (page) => async (bytes) => ({ status: 200, image: await redraw(page, bytes, 1000, 1250) }), 'enhance.fallback'],
  ['evidence too close to expiry', (page) => async (bytes) => ({ status: 200, image: await redraw(page, bytes), usableUntilMs: enhanceServerNow({ serverOffsetMs: 0 }) + 30_000 }), 'enhance.fallback'],
];
for (const [name, reply, key] of fallbacks) {
  test(`add: ${name} keeps the cut-out, analyses it once and says so`, async ({ page }) => {
    engineOnly();
    const api = await start(page);
    api.enhanceControl.replies.push(reply(page));
    await openFlow(page, api, 'add');
    await choose(page, 'add', await syntheticPhoto(page));
    await accept(page);
    await expect(line(page, key)).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => analyses(api)).toBe(1);
    expect(sent(api)).toHaveLength(1);
    // The cut-out (H1) is analysed and shown; H0 was only sent.
    expect(api.inputs[0]!.sha256).not.toBe(sent(api)[0]!.sha256);
    expect(await shown(page, 'add')).toBe(api.inputs[0]!.sha256);
    await expect(label(page)).toHaveCount(0);
    await expect(revertButton(page)).toHaveCount(0);
  });
}
test('replace: a failed enhancement keeps the cut-out and says so', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push({ status: 502, body: { code: 'FAILED' } });
  await openFlow(page, api, 'replace');
  await choose(page, 'replace', await syntheticPhoto(page));
  await accept(page);
  await expect(line(page, 'enhance.fallback')).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => analyses(api)).toBe(1);
  expect(api.inputs[0]!.sha256).not.toBe(sent(api)[0]!.sha256);
  expect(await shown(page, 'replace')).toBe(api.inputs[0]!.sha256);
});

const notSent: Array<[string, Start, (api: Fixture) => void, boolean]> = [
  ['not consented', { consent: false }, () => {}, false],
  ['not activated', { setup: { activated: false } }, () => {}, false],
  ['paused because the provider is unavailable', { setup: { providerAvailable: false } }, () => {}, true],
  ['a failed status read with no earlier observation', {}, (api) => { api.enhanceControl.statusFaults.push('fail'); }, true],
  ['a backend without enhancement', {}, (api) => { api.enhanceControl.missing = true; }, false],
];
for (const [name, options, arrange, fallback] of notSent) {
  test(`add: ${name} sends nothing${fallback ? ' and shows the fallback line' : ' and shows no line'}`, async ({ page }) => {
    engineOnly();
    const api = await start(page, options);
    arrange(api);
    await openFlow(page, api, 'add');
    await choose(page, 'add', await syntheticPhoto(page));
    await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
    await page.waitForTimeout(300);
    expect(sent(api)).toHaveLength(0);
    await expect(line(page, 'enhance.fallback')).toHaveCount(fallback ? 1 : 0);
    await expect(label(page)).toHaveCount(0);
  });
}

test('add: "Use original background" and a failed removal never read status or send the photo', async ({ page }) => {
  engineOnly();
  const api = await start(page, { background: { mask: 'left', runDelayMs: 2_500 } });
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  const original = page.locator('#background-original');
  await expect(original).toBeEnabled({ timeout: 15_000 });
  await original.click();
  await expect.poll(() => analyses(api)).toBe(1);
  await page.waitForTimeout(500);
  expect(sent(api)).toHaveLength(0);
  expect(api.enhanceControl.statusReads).toBe(0);
});

test('add: a verified "off" hides the line after a failed read; once enhancement was seen ready, a failed read shows it', async ({ page }) => {
  engineOnly();
  test.slow();
  const api = await start(page, { consent: false });
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
  api.enhanceControl.statusFaults.push('fail');
  await choose(page, 'add', await syntheticPhoto(page, '#224422'));
  await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(2);
  await expect(line(page, 'enhance.fallback')).toHaveCount(0);
  // Ready: one request, which fails.
  api.enhanceControl.consent[owners.a] = CLEANUP_NOTICE_REVISION;
  api.enhanceControl.replies.push({ status: 502, body: { code: 'FAILED' } });
  await choose(page, 'add', await syntheticPhoto(page, '#442222'));
  await accept(page);
  await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(3);
  expect(sent(api)).toHaveLength(1);
  api.enhanceControl.statusFaults.push('fail');
  await choose(page, 'add', await syntheticPhoto(page, '#222244'));
  await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(4);
  await expect(line(page, 'enhance.fallback')).toBeVisible();
  expect(sent(api)).toHaveLength(1);
});

test('add: evidence that lapses on an unsaved draft goes back to the cut-out with one new analysis', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  // 62 s of evidence less the 60 s margin: the enhanced photo may be kept for about 2 s.
  api.enhanceControl.replies.push(async (bytes) => ({ status: 200, image: await redraw(page, bytes), usableUntilMs: enhanceServerNow({ serverOffsetMs: 0 }) + 64_000 }));
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await accept(page);
  await expect(label(page)).toBeVisible({ timeout: 45_000 });
  await expect(line(page, 'enhance.fallback')).toBeVisible({ timeout: 15_000 });
  await expect(label(page)).toHaveCount(0);
  await expect.poll(() => analyses(api)).toBe(2);
  expect(api.inputs[1]!.sha256).not.toBe(sent(api)[0]!.sha256);
  expect(await shown(page, 'add')).toBe(api.inputs[1]!.sha256);
  expect(sent(api)).toHaveLength(1);
});

test('add: a skewed device clock does not change the evidence deadline', async ({ page }) => {
  engineOnly();
  // The fixture server runs two hours ahead of the device; its usable-until is on the server clock.
  const api = await start(page, { setup: { serverOffsetMs: 7_200_000 } });
  api.enhanceControl.replies.push(async (bytes) => ({ status: 200, image: await redraw(page, bytes),
    usableUntilMs: enhanceServerNow({ serverOffsetMs: 7_200_000 }) + 3_600_000 }));
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await accept(page);
  await expect(label(page)).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await expect(label(page)).toBeVisible();
  expect(analyses(api)).toBe(1);
});

test('add: evidence that lapses while Save is uploading does not revert, and the enhanced photo is saved', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push(async (bytes) => ({ status: 200, image: await redraw(page, bytes), usableUntilMs: enhanceServerNow({ serverOffsetMs: 0 }) + 66_000 }));
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await accept(page);
  await expect(label(page)).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => analyses(api)).toBe(1);
  const h2 = await shown(page, 'add');
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let uploads = 0;
  await page.route('http://127.0.0.1:54321/storage/v1/object/**', async (route) => {
    if (route.request().method() === 'POST' && uploads++ === 0) await gate;
    await route.fallback();
  });
  // The analysis has filled the draft (its category) before Save.
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await page.locator('#item-title').fill('Enhanced overshirt');
  await page.getByRole('button', { name: text('capture.save'), exact: true }).click();
  await expect.poll(() => uploads).toBeGreaterThan(0);
  await page.waitForTimeout(6_000);
  release();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect.poll(() => currentImage(api)?.main_sha256).toBe(h2);
  expect(analyses(api)).toBe(1);
});

test('add: a lost reservation reply freezes the enhanced photo past its deadline, and Retry completes it after server expiry', async ({ page }) => {
  engineOnly();
  test.slow();
  const api = await start(page, { lost: 'reservation' });
  // 70 s of evidence less the 60 s margin: about 10 s before an unreserved draft would go back to the cut-out.
  api.enhanceControl.replies.push(async (bytes) => ({ status: 200, image: await redraw(page, bytes), usableUntilMs: enhanceServerNow({ serverOffsetMs: 0 }) + 70_000 }));
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await accept(page);
  await expect(label(page)).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => analyses(api)).toBe(1);
  const h2 = await shown(page, 'add');
  // The analysis has filled the draft (its category) before Save.
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await page.locator('#item-title').fill('Enhanced overshirt');
  await page.getByRole('button', { name: text('capture.save'), exact: true }).click();
  const retry = page.getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeVisible();
  const reservations = () => api.requests.filter((call) => call.path.endsWith('/reserve_analyzed_item_save')).length;
  expect(reservations()).toBe(1);
  // The reservation exists on the server, so the local deadline passes without a revert or a new analysis.
  await page.waitForTimeout(12_000);
  await expect(label(page)).toBeVisible();
  await expect(line(page, 'enhance.fallback')).toHaveCount(0);
  expect(await shown(page, 'add')).toBe(h2);
  expect(analyses(api)).toBe(1);
  // The server's evidence has expired too; the replayed reservation is not admitted again, so it still completes.
  for (const output of api.enhanceControl.outputs) output.usableUntilMs = 0;
  await retry.click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect.poll(() => currentImage(api)?.main_sha256).toBe(h2);
  expect(reservations()).toBe(2);
  expect(analyses(api)).toBe(1);
  expect(sent(api)).toHaveLength(1);
});

test('add: "Enhancement expired" before any reservation goes back to the cut-out with one new analysis, which is then saved', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push(enhanced(page));
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await accept(page);
  await expect(label(page)).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => analyses(api)).toBe(1);
  const h0 = sent(api)[0]!.sha256, h2 = api.inputs[0]!.sha256, items = api.items.length;
  // The device still holds usable evidence, but the server's has expired: the admission refuses the new photo.
  for (const output of api.enhanceControl.outputs) output.usableUntilMs = 0;
  // The analysis has filled the draft (its category) before Save.
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await page.locator('#item-title').fill('Enhanced overshirt');
  await page.getByRole('button', { name: text('capture.save'), exact: true }).click();
  await expect(line(page, 'enhance.fallback')).toBeVisible();
  await expect(label(page)).toHaveCount(0);
  await expect.poll(() => analyses(api)).toBe(2);
  // The cut-out (H1) comes back: neither the cleaned-up photo nor H0, which was only sent.
  const h1 = api.inputs[1]!.sha256;
  expect([h0, h2]).not.toContain(h1);
  expect(await shown(page, 'add')).toBe(h1);
  expect(api.items).toHaveLength(items);
  expect(api.images.filter((row) => row.owner_id === owners.a && row.state === 'pending')).toHaveLength(0);
  await noViolations(page);
  await saveFlow(page, 'add');
  await expect.poll(() => currentImage(api)?.main_sha256).toBe(h1);
  expect(sent(api)).toHaveLength(1);
  expect(analyses(api)).toBe(2);
});

test('add: a Save whose request never arrived, retried after the server evidence expired, goes back to the cut-out once', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  api.enhanceControl.replies.push(enhanced(page));
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await accept(page);
  await expect(label(page)).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => analyses(api)).toBe(1);
  const h0 = sent(api)[0]!.sha256, h2 = api.inputs[0]!.sha256, items = api.items.length;
  // The first reservation request fails on the way, so its outcome is unknown and the attempt stays frozen for Retry.
  let dropped = 0;
  await page.route('**/rest/v1/rpc/reserve_analyzed_item_save', async (route) => {
    if (route.request().method() === 'POST' && dropped++ === 0) { await route.abort('failed'); return; }
    await route.fallback();
  });
  // The analysis has filled the draft (its category) before Save.
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await page.locator('#item-title').fill('Enhanced overshirt');
  await page.getByRole('button', { name: text('capture.save'), exact: true }).click();
  const retry = page.getByRole('button', { name: text('common.retry'), exact: true });
  await expect(retry).toBeVisible();
  await expect(label(page)).toBeVisible();
  for (const output of api.enhanceControl.outputs) output.usableUntilMs = 0;
  await retry.click();
  // The definitive refusal shows the attempt was never reserved: it is cleared and H1 comes back with one new analysis.
  await expect(line(page, 'enhance.fallback')).toBeVisible();
  await expect(label(page)).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect.poll(() => analyses(api)).toBe(2);
  const h1 = api.inputs[1]!.sha256;
  expect([h0, h2]).not.toContain(h1);
  expect(await shown(page, 'add')).toBe(h1);
  expect(api.items).toHaveLength(items);
  await page.waitForTimeout(500);
  expect(analyses(api)).toBe(2);
  await saveFlow(page, 'add');
  await expect.poll(() => currentImage(api)?.main_sha256).toBe(h1);
  expect(sent(api)).toHaveLength(1);
});

test('item details show "Photo edited with AI" only for an image with that provenance', async ({ page }) => {
  engineOnly();
  const api = await start(page);
  const edited = api.seedSavedItem('a', 'Edited shirt'), plain = api.seedSavedItem('a', 'Plain shirt');
  api.provenance.push({ image_id: edited.image.id, kind: 'ai_edited', origin: 'recorded' });
  await page.reload();
  await page.locator(`a[href="#/items/${edited.item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue('Edited shirt');
  await expect(page.locator('.detail-edited')).toHaveText(text('detail.aiEdited'));
  await noViolations(page);
  await page.goto('/#/');
  await page.locator(`a[href="#/items/${plain.item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue('Plain shirt');
  await page.waitForTimeout(300);
  await expect(page.locator('.detail-edited')).toHaveCount(0);
});

test('item details: a failed provenance read says so with Retry, and a replaced photo never shows the old label', async ({ page }) => {
  engineOnly();
  const api = await start(page, { consent: false });
  const saved = api.seedSavedItem('a', 'Edited shirt');
  api.provenance.push({ image_id: saved.image.id, kind: 'ai_edited', origin: 'recorded' });
  let failing = 1, release = () => {};
  let hold: Promise<void> | null = null;
  await page.route('**/rest/v1/rpc/image_provenance_v1', async (route) => {
    if (failing > 0) { failing--; await route.abort('failed'); return; }
    if (hold) await hold;
    await route.fallback();
  });
  await page.reload();
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue('Edited shirt');
  const unavailable = page.locator('.detail-edited', { hasText: text('detail.aiEditedUnavailable') });
  await expect(unavailable).toBeVisible();
  await expect(label(page)).toHaveCount(0);
  await noViolations(page);
  await unavailable.getByRole('button', { name: text('common.retry'), exact: true }).click();
  await expect(page.locator('.detail-edited')).toHaveText(text('detail.aiEdited'));
  // The replacement photo has no provenance: while its read is held nothing is shown, and afterwards still nothing.
  await page.locator('.detail-name details').evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
  await page.getByRole('button', { name: text('imageChange.replace'), exact: true }).click();
  await expect(page.locator('.image-change .background-note')).toBeVisible();
  await choose(page, 'replace', await syntheticPhoto(page));
  await expect.poll(() => analyses(api), { timeout: 45_000 }).toBe(1);
  hold = new Promise<void>((resolve) => { release = resolve; });
  await saveFlow(page, 'replace');
  await expect.poll(() => currentImage(api, String(saved.item.id))?.id).not.toBe(saved.image.id);
  await page.waitForTimeout(300);
  await expect(page.locator('.detail-edited')).toHaveCount(0);
  release();
  await page.waitForTimeout(500);
  await expect(page.locator('.detail-edited')).toHaveCount(0);
  expect(sent(api)).toHaveLength(0);
});

test.describe('Settings', () => {
  const card = (page: Page) => page.locator('section[aria-labelledby=enhance-heading]');
  async function settings(page: Page, options: Start, language: Language = 'en') {
    const api = await start(page, { ...options, language });
    await page.goto('/#/settings');
    await expect(page.locator('#settings-title')).toBeVisible();
    await expect.poll(() => api.enhanceControl.statusReads).toBeGreaterThan(0);
    return api;
  }
  test('is hidden while enhancement is not activated and not turned on', async ({ page }) => {
    engineOnly();
    await settings(page, { consent: false, setup: { activated: false } });
    await page.waitForTimeout(300);
    await expect(page.locator('#enhance-heading')).toHaveCount(0);
    await expect(page.locator('#enhance-turn-on')).toHaveCount(0);
  });
  test('can be turned on with the full notice and turned off again', async ({ page }) => {
    engineOnly();
    const api = await settings(page, { consent: false });
    await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.disabled'));
    await expect(card(page)).toContainText(text('enhanceC.offSummary'));
    await card(page).getByText(text('aiC.details'), { exact: true }).click();
    for (const key of ['enhanceC.noticeSent', 'enhanceC.noticeRedraw', 'enhanceC.noticeProcessing', 'enhanceC.noticeCharges'] as const) await expect(card(page)).toContainText(text(key));
    await noViolations(page);
    await page.locator('#enhance-turn-on').click();
    await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.enabled'));
    expect(api.enhanceControl.consentWrites.map((entry) => entry.body)).toEqual([{ p_enabled: true, p_notice_revision: CLEANUP_NOTICE_REVISION }]);
    await expect(page.locator('#enhance-turn-on')).toHaveCount(0);
    await page.locator('#enhance-turn-off').click();
    await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.disabled'));
    expect(api.enhanceControl.consentWrites.at(-1)!.body).toEqual({ p_enabled: false, p_notice_revision: null });
  });
  for (const [name, setup] of [['paused', { providerAvailable: false }], ['no longer activated', { activated: false }]] as const) {
    test(`keeps Turn off available while ${name}`, async ({ page }) => {
      engineOnly();
      await settings(page, { setup });
      await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.paused'));
      await expect(card(page)).toContainText(text('enhanceC.pausedText'));
      await expect(page.locator('#enhance-turn-off')).toBeEnabled();
      await expect(page.locator('#enhance-turn-on')).toHaveCount(0);
      await noViolations(page);
    });
  }
  test('an uncertain write is shown as checking until a read settles it', async ({ page }) => {
    engineOnly();
    const api = await settings(page, {});
    await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.enabled'));
    api.enhanceControl.consentFaults.push('lost');
    api.enhanceControl.statusFaults.push('fail');
    await page.locator('#enhance-turn-off').click();
    await expect(card(page)).toContainText(text('stylist.unresolved'));
    await expect(page.locator('#enhance-turn-on')).toHaveCount(0);
    await noViolations(page);
    await card(page).getByRole('button', { name: text('common.retry'), exact: true }).click();
    await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.disabled'));
  });
});

// Bounded synthetic captures for the coordinator's visual review, written to ignored buffers only.
const directory = path.resolve('test-results/bg2b-visual');
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
  expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
  expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  await mkdir(directory, { recursive: true });
  const file = await open(path.join(directory, `${name}.png`), 'w');
  try { await file.writeFile(png); } finally { await file.close(); }
}
const scenes = [
  { scene: 'enhancing', language: 'en', project: 'mobile', suffix: 'en-mobile' },
  { scene: 'enhanced', language: 'en', project: 'chromium', suffix: 'en-desktop' },
  { scene: 'fallback', language: 'sv', project: 'mobile', suffix: 'sv-mobile' },
  { scene: 'reverted', language: 'en', project: 'mobile', suffix: 'en-mobile' },
  { scene: 'enhanced', language: 'fi', project: 'mobile', suffix: 'fi-mobile' },
] as const satisfies ReadonlyArray<{ scene: string; language: Language; project: string; suffix: string }>;
for (const selected of scenes) {
  test(`capture: ${selected.scene} (${selected.suffix})`, async ({ page }) => {
    test.skip(test.info().project.name !== selected.project, 'One project per capture.');
    // Finnish long copy at 320 px: the label, the revert button and its help together.
    if (selected.language === 'fi') await page.setViewportSize({ width: 320, height: 700 });
    const api = await start(page, { language: selected.language });
    const pending = held(enhanced(page));
    api.enhanceControl.replies.push(selected.scene === 'fallback' ? { status: 502, body: { code: 'FAILED' } }
      : selected.scene === 'enhancing' ? pending.reply : enhanced(page));
    await openFlow(page, api, 'add', selected.language);
    await choose(page, 'add', await syntheticPhoto(page));
    await accept(page, selected.language);
    if (selected.scene === 'enhancing') await expect(page.getByRole('button', { name: text('enhance.skip', selected.language), exact: true })).toBeVisible({ timeout: 45_000 });
    else if (selected.scene === 'fallback') await expect(line(page, 'enhance.fallback', selected.language)).toBeVisible({ timeout: 45_000 });
    else {
      await expect(label(page, selected.language)).toBeVisible({ timeout: 45_000 });
      await expect.poll(() => analyses(api)).toBe(1);
    }
    if (selected.scene === 'reverted') {
      await revertButton(page, selected.language).click();
      await expect.poll(() => analyses(api)).toBe(2);
      await expect(label(page, selected.language)).toHaveCount(0);
    }
    await noViolations(page);
    await capture(page, `${selected.scene}-${selected.suffix}`);
    pending.release();
  });
}
// BG2c-2: the pre-upload review with its hint, and the ambiguous-crop line.
test('capture: review (en-mobile)', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'One project per capture.');
  const api = await start(page);
  await openFlow(page, api, 'add');
  await choose(page, 'add', await syntheticPhoto(page));
  await inReview(page);
  expect(sent(api)).toHaveLength(0);
  await noViolations(page);
  await capture(page, 'review-en-mobile');
});
test('capture: ambiguous (fi-mobile)', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'One project per capture.');
  await page.setViewportSize({ width: 320, height: 700 });
  const api = await start(page, { language: 'fi', background: { mask: 'two' } });
  await openFlow(page, api, 'add', 'fi');
  await choose(page, 'add', await syntheticPhoto(page));
  await expect(line(page, 'enhance.ambiguous', 'fi')).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => analyses(api)).toBe(1);
  expect(sent(api)).toHaveLength(0);
  await noViolations(page);
  await capture(page, 'ambiguous-fi-mobile');
});
test('capture: settings (fi-mobile)', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'One project per capture.');
  const api = await start(page, { language: 'fi', consent: false });
  await page.goto('/#/settings');
  await expect(page.locator('#enhance-heading')).toHaveText(text('enhanceC.disabled', 'fi'));
  await page.locator('section[aria-labelledby=enhance-heading]').getByText(text('aiC.details', 'fi'), { exact: true }).click();
  await page.locator('#enhance-heading').scrollIntoViewIfNeeded();
  expect(api.enhanceControl.requests).toHaveLength(0);
  await noViolations(page);
  await capture(page, 'settings-fi-mobile');
});
