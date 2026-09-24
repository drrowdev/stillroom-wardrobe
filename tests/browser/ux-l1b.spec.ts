import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { languages, locales, messages, translate, type Language, type MessageKey } from '../../src/i18n';
import { aiFixture, addAiPhoto } from './ai-photo-first-support';

type Api = Awaited<ReturnType<typeof aiFixture>>;
type Values = { x: number; y: number; width: number; height: number };
type Corner = 'nw' | 'ne' | 'sw' | 'se';
const corners: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
const decimal = /^\d+(?:\.\d+)?$/;
const text = (key: MessageKey, language: Language = 'en') => messages[key][language];
const analyses = (api: Api) => api.calls.filter((call) => call.route.endsWith('/analyze-clothing')).length;
const libraryWrites = (api: Api) => api.items.length + api.images.length + api.files.size + api.uploadWire.posts
  + api.requests.filter((call) => /(?:reserve_(?:analyzed_)?item_save|reserve_image_change|\/finalize-[\w-]+)$/.test(call.path)).length;
const west = (corner: Corner) => corner === 'nw' || corner === 'sw';
const north = (corner: Corner) => corner === 'nw' || corner === 'ne';

// Every request that leaves the app origin: the mock Supabase and analysis endpoints live on another origin.
function backendRequests(page: Page, info: TestInfo) {
  const origin = new URL(info.project.use.baseURL!).origin;
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) seen.push(`${request.method()} ${url.pathname}`);
  });
  return seen;
}
async function syntheticPhoto(page: Page, width: number, height: number) {
  return Buffer.from(await page.evaluate(async ({ width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!;
    ['rgb(240,30,30)', 'rgb(30,210,50)', 'rgb(30,70,230)', 'rgb(230,200,20)'].forEach((colour, index) => {
      context.fillStyle = colour;
      context.fillRect(index % 2 * width / 2, Math.floor(index / 2) * height / 2, width / 2, height / 2);
    });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { width, height }));
}
// A settled Add draft: the analysis filled the form, so later requests can only come from the editor.
async function ready(page: Page, language: Language = 'en', size?: { width: number; height: number }) {
  const api = await aiFixture(page, language);
  if (size) {
    const buffer = await syntheticPhoto(page, size.width, size.height);
    await page.getByRole('button', { name: text('wardrobe.add', language), exact: true }).first().click();
    await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer });
    await expect(page.locator('.capture-photo img')).toBeVisible();
  } else await addAiPhoto(page, api, language);
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await expect(page.locator('#analysis-status')).toHaveCount(0);
  await expect(page.locator('#edit-photo')).toBeEnabled();
  return api;
}
async function openEditor(page: Page) {
  await page.locator('#edit-photo').click();
  await expect(page.locator('#crop-rectangle')).toBeVisible();
  await page.locator('.crop-stage').scrollIntoViewIfNeeded();
}
async function stage(page: Page) {
  await page.locator('.crop-stage').scrollIntoViewIfNeeded();
  return (await page.locator('.crop-stage').boundingBox())!;
}
const raw = (page: Page) => page.evaluate(() => Object.fromEntries(['x', 'y', 'width', 'height']
  .map((field) => [field, (document.getElementById(`crop-${field}`) as HTMLInputElement).value])) as Record<keyof Values, string>);
async function values(page: Page): Promise<Values> {
  const current = await raw(page);
  return { x: Number(current.x), y: Number(current.y), width: Number(current.width), height: Number(current.height) };
}
async function ordinary(page: Page) {
  const current = await raw(page);
  for (const value of Object.values(current)) expect(value).toMatch(decimal);
  const numbers = await values(page);
  expect(numbers.x + numbers.width).toBeLessThanOrEqual(100.01);
  expect(numbers.y + numbers.height).toBeLessThanOrEqual(100.01);
  return numbers;
}
async function openExact(page: Page) {
  const details = page.locator('details.crop-exact');
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) await details.locator('summary').click();
  await expect(page.locator('#crop-width')).toBeVisible();
}
async function setExact(page: Page, next: Partial<Record<keyof Values, string>>) {
  await openExact(page);
  for (const field of ['width', 'height', 'x', 'y'] as const) if (next[field] !== undefined) await page.locator(`#crop-${field}`).fill(next[field]!);
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, release = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  if (release) await page.mouse.up();
}
// Boxes are viewport-relative: scroll first (the whole stage for anything inside it) so later measurements agree.
async function centre(page: Page, selector: string) {
  const target = page.locator(selector).first();
  const inside = await target.evaluate((element) => element.closest('.crop-stage') !== null);
  await (inside ? page.locator('.crop-stage') : target).scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
const handle = (corner: Corner) => `.crop-handle[data-corner="${corner}"]`;
// Moves the corner's edges to stage fractions: the pointer travels the edge displacement from its actual grab point.
async function dragEdgeTo(page: Page, corner: Corner, fx: number, fy: number) {
  const box = await stage(page), current = await values(page), grab = await centre(page, handle(corner));
  const edgeX = west(corner) ? current.x : current.x + current.width, edgeY = north(corner) ? current.y : current.y + current.height;
  await drag(page, grab, { x: grab.x + (fx * 100 - edgeX) / 100 * box.width, y: grab.y + (fy * 100 - edgeY) / 100 * box.height });
}
async function hit(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y)?.closest('.crop-handle,#crop-rectangle');
    return target ? (target as HTMLElement).dataset.corner ?? 'frame' : null;
  }, { x, y });
}
// All four handles are hit-testable at their centres, pairwise disjoint and inside the stage.
async function handlesUsable(page: Page) {
  await expect(page.locator('.crop-handle')).toHaveCount(4);
  const layout = await page.evaluate(() => ({
    stage: document.querySelector('.crop-stage')!.getBoundingClientRect().toJSON() as DOMRect,
    handles: [...document.querySelectorAll<HTMLElement>('.crop-handle')].map((element) => ({
      corner: element.dataset.corner!, rect: element.getBoundingClientRect().toJSON() as DOMRect })),
  }));
  for (const { corner, rect } of layout.handles) {
    expect(await hit(page, rect.x + rect.width / 2, rect.y + rect.height / 2), corner).toBe(corner);
    expect(rect.left >= layout.stage.left - 0.5 && rect.right <= layout.stage.right + 0.5
      && rect.top >= layout.stage.top - 0.5 && rect.bottom <= layout.stage.bottom + 0.5, `${corner} inside`).toBe(true);
  }
  for (const [index, a] of layout.handles.entries()) for (const b of layout.handles.slice(index + 1)) {
    expect(a.rect.right <= b.rect.left || b.rect.right <= a.rect.left || a.rect.bottom <= b.rect.top || b.rect.bottom <= a.rect.top,
      `${a.corner}/${b.corner} disjoint`).toBe(true);
  }
}
const handleMinimum = (page: Page, pixels: number) => page.evaluate(async (pixels) => {
  const cropPath = '/src/images/crop.ts';
  return (await import(cropPath) as typeof import('../../src/images/crop')).handleMinimum(pixels);
}, pixels);
async function previewSha256(page: Page) {
  return page.locator('.capture-photo img').evaluate(async (element: HTMLImageElement) => {
    const hash = await crypto.subtle.digest('SHA-256', await (await fetch(element.src)).arrayBuffer());
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  });
}
async function pointerId(page: Page) {
  await page.evaluate(() => {
    window.addEventListener('pointerdown', (event) => { (window as unknown as { cropPointer: number }).cropPointer = event.pointerId; }, { capture: true });
  });
}
// Synthetic pointer events with an explicit type, for engines where a real touch device is not emulated.
async function syntheticDrag(page: Page, selector: string, dx: number, dy: number, pointerType: 'touch' | 'pen' = 'touch') {
  await page.evaluate(({ selector, dx, dy, pointerType }) => {
    const target = document.querySelector<HTMLElement>(selector)!, rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const init = (clientX: number, clientY: number) => ({ pointerId: 7, pointerType, isPrimary: true, bubbles: true, cancelable: true, clientX, clientY, buttons: 1 });
    target.dispatchEvent(new PointerEvent('pointerdown', init(x, y)));
    for (let step = 1; step <= 5; step++) window.dispatchEvent(new PointerEvent('pointermove', init(x + dx * step / 5, y + dy * step / 5)));
    window.dispatchEvent(new PointerEvent('pointerup', { ...init(x + dx, y + dy), buttons: 0 }));
  }, { selector, dx, dy, pointerType });
}
// A real touch sequence through the Chromium input pipeline (chromium-engine projects only).
async function cdpTouch(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
        touchPoints: point(from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}
const chromiumEngine = (info: TestInfo) => info.project.name !== 'webkit-photo';
function expectedStatus(language: Language, turns: number, current: Values) {
  const number = new Intl.NumberFormat(locales[language], { maximumFractionDigits: 1 });
  const orientation = turns ? translate(language, 'photo.orientationTurned', { degrees: number.format(turns * 90) })
    : translate(language, 'photo.orientationOriginal');
  return translate(language, 'photo.cropStatus', { orientation, x: number.format(current.x), y: number.format(current.y),
    width: number.format(current.width), height: number.format(current.height) });
}
async function statusLog(page: Page) {
  await page.evaluate(() => {
    const target = document.getElementById('crop-status')!, log: string[] = [target.textContent ?? ''];
    (window as unknown as { cropStatus: string[] }).cropStatus = log;
    new MutationObserver(() => { const next = target.textContent ?? ''; if (next !== log.at(-1)) log.push(next); })
      .observe(target, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => [...(window as unknown as { cropStatus: string[] }).cropStatus]);
}

const changed: MessageKey[] = ['photo.cropHelp', 'photo.cropRectangle', 'photo.applyCrop', 'photo.cancelCrop', 'photo.pendingCrop', 'photo.cropStatus'];
const added: MessageKey[] = ['photo.cropExact', 'photo.rotateHint', 'photo.orientationOriginal', 'photo.orientationTurned'];
const removed = ['photo.crop', 'photo.fit', 'photo.rotateLeft', 'photo.rotateRight', 'photo.cropAspect', 'photo.cropFree', 'photo.cropOriginal', 'photo.cropRatio'];
const banned = [/gpt-/i, /\bUSD\b/, /micro/i, /revision/i, /verified/i, /provenance/i, /Check analysis status/i,
  /Request a new analysis/i, /\bClear /, /\bReset /];

test('UX L1b T1 crop copy exists in every language with matching placeholders; removed keys are gone', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of [...changed, ...added]) {
    for (const language of languages) {
      expect(messages[key][language], `${key} ${language}`).toBeTruthy();
      expect(placeholders(messages[key][language]), `${key} ${language}`).toEqual(placeholders(messages[key].en));
      for (const pattern of banned) expect(messages[key][language], `${key} ${language}`).not.toMatch(pattern);
    }
  }
  for (const language of languages) {
    const help = messages['photo.cropHelp'][language];
    expect(help.length).toBeLessThanOrEqual(80);
    expect(help.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
  }
  for (const key of removed) expect(Object.hasOwn(messages, key), key).toBe(false);
});

test('UX L1b T2 a real pointer moves, resizes and clamps the frame without backend requests', async ({ page }, info) => {
  const api = await ready(page);
  await openEditor(page);
  const requests = backendRequests(page, info), before = analyses(api);
  await handlesUsable(page);
  await dragEdgeTo(page, 'se', 0.5, 0.5);
  let current = await ordinary(page);
  expect(Math.abs(current.width - 50)).toBeLessThanOrEqual(2);
  expect(Math.abs(current.height - 50)).toBeLessThanOrEqual(2);
  const box = await stage(page), from = await centre(page, '#crop-rectangle');
  await drag(page, from, { x: from.x + box.width * 0.25, y: from.y });
  const moved = await ordinary(page);
  expect(Math.abs(moved.x - 25)).toBeLessThanOrEqual(2);
  expect(moved.width).toBeCloseTo(current.width, 5);
  const viewport = page.viewportSize()!;
  for (const corner of corners) {
    await setExact(page, { width: '80', height: '80', x: '10', y: '10' });
    const grab = await centre(page, handle(corner));
    const far = { x: west(corner) ? 1 : viewport.width - 1, y: north(corner) ? 1 : viewport.height - 1 };
    const area = await stage(page);
    expect(far.x < area.x || far.x > area.x + area.width || far.y < area.y || far.y > area.y + area.height).toBe(true);
    await drag(page, grab, far);
    current = await ordinary(page);
    expect(current).toEqual({ x: west(corner) ? 0 : 10, y: north(corner) ? 0 : 10, width: 90, height: 90 });
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2, { steps: 3 });
    expect(await values(page)).toEqual(current);
  }
  for (const corner of corners) {
    await page.locator('#crop-reset').click();
    const area = await stage(page), grab = await centre(page, handle(corner));
    const minimum = { width: await handleMinimum(page, area.width) * 100, height: await handleMinimum(page, area.height) * 100 };
    await drag(page, grab, { x: west(corner) ? area.x + area.width - 2 : area.x + 2, y: north(corner) ? area.y + area.height - 2 : area.y + 2 });
    current = await ordinary(page);
    expect(current.width).toBeCloseTo(minimum.width, 6);
    expect(current.height).toBeCloseTo(minimum.height, 6);
    expect(west(corner) ? current.x + current.width : current.x).toBeCloseTo(west(corner) ? 100 : 0, 6);
    expect(north(corner) ? current.y + current.height : current.y).toBeCloseTo(north(corner) ? 100 : 0, 6);
    await handlesUsable(page);
  }
  expect(requests).toEqual([]);
  expect(analyses(api)).toBe(before);
});

test('UX L1b T3 tolerated overruns stay ordinary decimals under drags and keys', async ({ page }) => {
  await ready(page);
  await openEditor(page);
  const oldNudge = (crop: Values, dx: number, dy: number) => page.evaluate(async ({ crop, dx, dy }) => {
    const cropPath = '/src/images/crop.ts';
    const { cropValues } = await import(cropPath) as typeof import('../../src/images/crop');
    const start = { x: crop.x / 100, y: crop.y / 100, width: crop.width / 100, height: crop.height / 100 };
    return cropValues({ ...start, x: Math.max(0, Math.min(1 - start.width, start.x + dx)), y: Math.max(0, Math.min(1 - start.height, start.y + dy)) });
  }, { crop, dx, dy });
  for (const overrun of ['width', 'height'] as const) {
    const exact = overrun === 'width' ? { width: '100.000000005', height: '50', x: '0', y: '0' } : { width: '50', height: '100.000000005', x: '0', y: '0' };
    await setExact(page, exact);
    await expect(page.locator('#apply-crop')).toBeEnabled();
    const from = await centre(page, '#crop-rectangle'), box = await stage(page);
    for (const direction of [1, -1]) {
      await drag(page, from, { x: from.x + direction * box.width * 0.2, y: from.y + direction * box.height * 0.2 });
      const current = await ordinary(page);
      expect(current.x).toBeGreaterThanOrEqual(0);
      expect(current.y).toBeGreaterThanOrEqual(0);
    }
    for (const corner of corners) {
      await setExact(page, exact);
      const grab = await centre(page, handle(corner));
      await drag(page, grab, { x: grab.x + (west(corner) ? 30 : -30), y: grab.y + (north(corner) ? 30 : -30) });
      const current = await ordinary(page);
      expect(current.x).toBeGreaterThanOrEqual(0);
      expect(current.y).toBeGreaterThanOrEqual(0);
    }
    for (const key of ['ArrowRight', 'ArrowDown', 'Shift+ArrowRight', 'Shift+ArrowDown']) {
      await setExact(page, exact);
      const start = { x: 0, y: 0, width: Number(exact.width), height: Number(exact.height) };
      const step = key.startsWith('Shift') ? 0.1 : 0.01, horizontal = key.endsWith('Right');
      const movable = horizontal ? overrun === 'height' : overrun === 'width';
      await page.locator('#crop-rectangle').focus();
      await page.keyboard.press(key);
      expect(await raw(page)).toEqual(movable ? await oldNudge(start, horizontal ? step : 0, horizontal ? 0 : step) : exact);
    }
  }
});

test('UX L1b T4 a small exact crop hides the handles without changing its values', async ({ page }) => {
  await ready(page);
  await openEditor(page);
  await setExact(page, { width: '5', height: '5', x: '10', y: '10' });
  await expect(page.locator('.crop-handle')).toHaveCount(0);
  expect(await raw(page)).toEqual({ x: '10', y: '10', width: '5', height: '5' });
  const from = await centre(page, '#crop-rectangle');
  await drag(page, from, { x: from.x + 20, y: from.y + 20 });
  const current = await ordinary(page);
  expect(current.x).toBeGreaterThan(10);
  expect(current.y).toBeGreaterThan(10);
  expect(await raw(page)).toMatchObject({ width: '5', height: '5' });
  await page.locator('#crop-reset').click();
  expect(await raw(page)).toEqual({ x: '0', y: '0', width: '100', height: '100' });
  await handlesUsable(page);
});

test('UX L1b T5 pointer cancel reverts, lost capture commits, and missing capture still ends the drag', async ({ page }) => {
  await ready(page);
  await openEditor(page);
  await pointerId(page);
  const start = await raw(page);
  const grab = await centre(page, handle('se'));
  await drag(page, grab, { x: grab.x - 60, y: grab.y - 60 }, false);
  await expect.poll(() => raw(page)).not.toEqual(start);
  await page.evaluate(() => {
    const id = (window as unknown as { cropPointer: number }).cropPointer;
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, isPrimary: true, bubbles: true }));
  });
  expect(await raw(page)).toEqual(start);
  await page.mouse.move(grab.x - 120, grab.y - 120, { steps: 3 });
  expect(await raw(page)).toEqual(start);
  await page.mouse.up();

  await drag(page, grab, { x: grab.x - 60, y: grab.y - 60 }, false);
  await expect.poll(() => raw(page)).not.toEqual(start);
  const last = await raw(page);
  expect(await page.evaluate(() => {
    const id = (window as unknown as { cropPointer: number }).cropPointer;
    const target = document.querySelector('.crop-handle[data-corner="se"]')!;
    const captured = target.hasPointerCapture(id);
    target.addEventListener('lostpointercapture', () => { (window as unknown as { cropLost: boolean }).cropLost = true; }, { once: true });
    target.releasePointerCapture(id);
    return captured;
  })).toBe(true);
  // WebKit fires lostpointercapture with the next pointer event; a move to the same point cannot change the values.
  await page.mouse.move(grab.x - 60, grab.y - 60);
  await expect.poll(() => page.evaluate(() => (window as unknown as { cropLost?: boolean }).cropLost === true)).toBe(true);
  expect(await raw(page)).toEqual(last);
  await page.mouse.move(grab.x - 120, grab.y - 120, { steps: 3 });
  expect(await raw(page)).toEqual(last);
  await page.mouse.up();

  await page.locator('#crop-reset').click();
  await page.evaluate(() => {
    const native = Element.prototype.setPointerCapture;
    (window as unknown as { restoreCapture: () => void }).restoreCapture = () => { Element.prototype.setPointerCapture = native; };
    Element.prototype.setPointerCapture = () => { throw new DOMException('Capture unavailable', 'NotFoundError'); };
  });
  try {
    const next = await centre(page, handle('se')), area = await stage(page);
    await drag(page, next, { x: next.x - 60, y: area.y + area.height + 30 }, false);
    await expect.poll(() => raw(page)).not.toEqual({ x: '0', y: '0', width: '100', height: '100' });
    const during = await raw(page);
    await page.mouse.up();
    await page.mouse.move(next.x - 150, next.y - 150, { steps: 3 });
    expect(await raw(page)).toEqual(during);
  } finally { await page.evaluate(() => (window as unknown as { restoreCapture: () => void }).restoreCapture()); }
});

test('UX L1b T6 touch pointers drag the frame and handles like the mouse', async ({ page }, info) => {
  await ready(page);
  await openEditor(page);
  await setExact(page, { width: '50', height: '50', x: '0', y: '0' });
  const box = await stage(page);
  await syntheticDrag(page, '#crop-rectangle', box.width * 0.25, box.height * 0.25);
  let current = await ordinary(page);
  expect(Math.abs(current.x - 25)).toBeLessThanOrEqual(1);
  expect(Math.abs(current.y - 25)).toBeLessThanOrEqual(1);
  expect(current.width).toBe(50);
  await syntheticDrag(page, handle('se'), -box.width * 0.1, -box.height * 0.1);
  current = await ordinary(page);
  expect(Math.abs(current.width - 40)).toBeLessThanOrEqual(1);
  expect(Math.abs(current.height - 40)).toBeLessThanOrEqual(1);
  if (chromiumEngine(info)) {
    await setExact(page, { width: '100', height: '100', x: '0', y: '0' });
    const area = await stage(page), scroll = await page.evaluate(() => scrollY), grab = await centre(page, handle('se'));
    await cdpTouch(page, grab, { x: grab.x - area.width * 0.3, y: grab.y - area.height * 0.3 });
    current = await ordinary(page);
    expect(current.width).toBeLessThan(90);
    expect(current.height).toBeLessThan(90);
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
  }
});

test('UX L1b T7 a tall photo fits the screen and the page still scrolls where the frame cannot move', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page, 'en', { width: 80, height: 240 });
  await openEditor(page);
  const box = await stage(page);
  expect(box.height).toBeLessThanOrEqual(0.7 * 568 + 1);
  const touch = (selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).touchAction);
  expect(await touch('#crop-rectangle')).toBe('auto');
  await expect(page.locator('.crop-handle')).toHaveCount(4);
  for (const corner of corners) expect(await touch(handle(corner))).toBe('none');
  await setExact(page, { width: '50', height: '100', x: '0', y: '0' });
  expect(await touch('#crop-rectangle')).toBe('pan-y');
  await setExact(page, { width: '100', height: '50', x: '0', y: '0' });
  expect(await touch('#crop-rectangle')).toBe('pan-x');
  await setExact(page, { width: '50', height: '50', x: '0', y: '0' });
  expect(await touch('#crop-rectangle')).toBe('none');
  await setExact(page, { width: '100', height: '100', x: '0', y: '0' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.crop-stage').scrollIntoViewIfNeeded();
  const frame = await centre(page, '#crop-rectangle'), scroll = await page.evaluate(() => scrollY);
  await page.mouse.move(frame.x, frame.y);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scroll);
  await page.evaluate(() => {
    window.addEventListener('keydown', (event) => { (window as unknown as { prevented: boolean }).prevented = event.defaultPrevented; });
  });
  const prevented = () => page.evaluate(() => (window as unknown as { prevented: boolean }).prevented);
  await page.locator('#crop-rectangle').focus();
  await page.keyboard.press('ArrowDown');
  expect(await prevented()).toBe(false);
  await setExact(page, { width: '50' });
  await page.locator('#crop-rectangle').focus();
  await page.keyboard.press('ArrowRight');
  expect(await prevented()).toBe(true);
  if (chromiumEngine(info)) {
    await setExact(page, { width: '100', height: '100', x: '0', y: '0' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.crop-stage').scrollIntoViewIfNeeded();
    const full = await centre(page, '#crop-rectangle'), top = await page.evaluate(() => scrollY), kept = await raw(page);
    await cdpTouch(page, full, { x: full.x, y: full.y - 150 });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(top);
    expect(await raw(page)).toEqual(kept);
    await setExact(page, { width: '50', height: '50', x: '0', y: '0' });
    await page.locator('.crop-stage').scrollIntoViewIfNeeded();
    const body = await centre(page, '#crop-rectangle'), still = await page.evaluate(() => scrollY);
    await cdpTouch(page, body, { x: body.x + 20, y: body.y + 40 });
    const moved = await ordinary(page);
    expect(moved.x > 0 || moved.y > 0).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(still);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#crop-help').scrollIntoViewIfNeeded();
    const help = await centre(page, '#crop-help'), atHelp = await page.evaluate(() => scrollY);
    await cdpTouch(page, help, { x: help.x, y: Math.max(1, help.y - 150) });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(atHelp);
  }
});

test('UX L1b T8 keyboard order, arrow moves, the disclosure and invalid values', async ({ page }) => {
  await ready(page);
  const src = await page.locator('.capture-photo img').getAttribute('src');
  await openEditor(page);
  const focused = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    return element.id || element.tagName.toLowerCase();
  });
  const order = async (expected: string[]) => {
    await page.locator('#crop-editor-title').focus();
    for (const id of expected) { await page.keyboard.press('Tab'); expect(await focused()).toBe(id); }
  };
  await order(['crop-rectangle', 'crop-rotate', 'crop-reset', 'summary', 'apply-crop', 'crop-cancel']);
  await openExact(page);
  await order(['crop-rectangle', 'crop-rotate', 'crop-reset', 'summary', 'crop-x', 'crop-y', 'crop-width', 'crop-height', 'apply-crop', 'crop-cancel']);
  await setExact(page, { width: '50', height: '100', x: '0', y: '0' });
  await page.locator('#crop-rectangle').focus();
  await page.keyboard.press('ArrowRight');
  expect((await raw(page)).x).toBe('1');
  await page.keyboard.press('Shift+ArrowRight');
  expect((await raw(page)).x).toBe('11');
  for (let press = 0; press < 8; press++) await page.keyboard.press('Shift+ArrowRight');
  expect((await raw(page)).x).toBe('50');
  const summary = page.locator('details.crop-exact > summary');
  await summary.click();
  expect(await page.locator('details.crop-exact').evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  await summary.focus();
  await page.keyboard.press('Enter');
  expect(await page.locator('details.crop-exact').evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
  await page.locator('#crop-width').fill('0');
  await expect(page.locator('#apply-crop')).toBeDisabled();
  await expect(page.locator('#crop-status')).toBeVisible();
  await expect(page.locator('#crop-status')).toHaveText(text('photo.cropInvalid'));
  await summary.click();
  await expect(page.locator('#crop-status')).toBeVisible();
  await page.locator('#crop-cancel').click();
  await expect(page.locator('#edit-photo')).toBeFocused();
  await expect(page.locator('.capture-photo img')).toHaveAttribute('src', src!);
  await openEditor(page);
  await setExact(page, { width: '60' });
  await page.locator('#apply-crop').click();
  await expect(page.locator('#edit-photo')).toBeFocused();
});

for (const language of languages) {
  test(`UX L1b T9 status announces the settled frame and orientation in ${language}`, async ({ page }) => {
    await ready(page, language);
    await openEditor(page);
    await expect(page.locator('#crop-rotate')).toHaveAccessibleDescription(text('photo.rotateHint', language));
    const log = await statusLog(page);
    const full = { x: 0, y: 0, width: 100, height: 100 };
    expect((await log()).at(-1)).toBe(expectedStatus(language, 0, full));
    let count = (await log()).length;
    const grab = await centre(page, handle('se'));
    await drag(page, grab, { x: grab.x - 80, y: grab.y - 60 }, false);
    expect(await log()).toHaveLength(count);
    await page.mouse.up();
    await expect.poll(async () => (await log()).length).toBe(count + 1);
    expect((await log()).at(-1)).toBe(expectedStatus(language, 0, await values(page)));
    count += 1;
    await page.locator('#crop-rotate').click();
    await expect.poll(async () => (await log()).length).toBe(count + 1);
    expect((await log()).at(-1)).toBe(expectedStatus(language, 1, full));
    await page.locator('#crop-rotate').click();
    await expect.poll(async () => (await log()).length).toBe(count + 2);
    expect((await log()).at(-1)).toBe(expectedStatus(language, 2, full));
    await page.locator('#crop-reset').click();
    await expect.poll(async () => (await log()).length).toBe(count + 3);
    expect((await log()).at(-1)).toBe(expectedStatus(language, 0, full));
    await setExact(page, { width: '50' });
    await expect.poll(async () => (await log()).at(-1)).toBe(expectedStatus(language, 0, { ...full, width: 50 }));
    count = (await log()).length;
    await page.locator('#crop-rectangle').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await log()).length).toBe(count + 1);
    expect((await log()).at(-1)).toBe(expectedStatus(language, 0, { ...full, x: 1, width: 50 }));
  });
}

test('UX L1b T10 editing sends nothing; an unchanged Done sends nothing; a changed Done analyzes once', async ({ page }, info) => {
  const api = await ready(page);
  await page.locator('#item-title').fill('Retained manual title');
  const src = await page.locator('.capture-photo img').getAttribute('src');
  const requests = backendRequests(page, info);
  await openEditor(page);
  const area = await stage(page);
  await drag(page, await centre(page, handle('se')), { x: area.x + area.width * 0.6, y: area.y + area.height * 0.6 });
  await drag(page, await centre(page, '#crop-rectangle'), { x: area.x + area.width * 0.4, y: area.y + area.height * 0.4 });
  await page.locator('#crop-rectangle').focus();
  for (const key of ['ArrowLeft', 'ArrowUp', 'Shift+ArrowRight', 'Shift+ArrowDown']) await page.keyboard.press(key);
  await page.locator('#crop-rotate').click();
  await page.locator('#crop-reset').click();
  await setExact(page, { width: '70' });
  await page.locator('#crop-cancel').click();
  await expect(page.locator('#edit-photo')).toBeFocused();
  expect(requests).toEqual([]);
  expect(analyses(api)).toBe(1);
  await openEditor(page);
  await page.locator('#apply-crop').click();
  await expect(page.locator('.crop-editor')).toHaveCount(0);
  await expect(page.locator('.capture-photo img')).toHaveAttribute('src', src!);
  expect(requests).toEqual([]);
  await openEditor(page);
  await page.locator('#crop-rotate').click();
  await page.locator('#apply-crop').click();
  await expect.poll(() => analyses(api)).toBe(2);
  await expect(page.locator('#item-category')).not.toHaveValue('');
  await expect(page.locator('#analysis-status')).toHaveCount(0);
  const latest = (api.calls.filter((call) => call.route.endsWith('/analyze-clothing')).at(-1)!.body as { requestId: string }).requestId;
  expect(api.results.get(latest)!.generation).toBe(2);
  await expect(page.locator('#item-title')).toHaveValue('Retained manual title');
  await page.waitForTimeout(500);
  expect(analyses(api)).toBe(2);
  expect(libraryWrites(api)).toBe(0);
});

test('UX L1b T11 with AI off a changed Done prepares a new photo and makes no analysis request', async ({ page }) => {
  const api = await aiFixture(page, 'en', false);
  await addAiPhoto(page, api);
  await expect(page.locator('#analysis-status')).toContainText(text('aiC.off'));
  const before = await previewSha256(page);
  await openEditor(page);
  await setExact(page, { width: '50' });
  await page.locator('#apply-crop').click();
  await expect(page.locator('#edit-photo')).toBeFocused();
  await expect.poll(() => previewSha256(page)).not.toBe(before);
  expect(analyses(api)).toBe(0);
  await page.locator('#item-title').fill('Manual photo');
  await page.locator('#item-category').selectOption('top');
  await expect(page.getByRole('button', { name: text('capture.save'), exact: true })).toBeEnabled();
  expect(libraryWrites(api)).toBe(0);
});

test('UX L1b T12 Replace shows the editor in place of the photo actions and returns focus', async ({ page }) => {
  const api = await aiFixture(page);
  const { item, image } = api.seedSavedItem();
  await page.reload();
  await page.locator(`a[href="#/items/${item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue(item.title);
  await page.locator('.detail-name details').evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
  const before = structuredClone(item), oldImage = structuredClone(image);
  await page.getByRole('button', { name: text('imageChange.replace'), exact: true }).click();
  await expect(page.locator('.image-change .photo-actions').getByRole('button', { name: text('capture.library'), exact: true })).toBeEnabled();
  await page.locator('.image-change input[type=file]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: api.fixture });
  await expect.poll(() => api.inputs.length).toBe(1);
  await expect(page.locator('#image-change-edit')).toBeEnabled();
  await page.locator('#image-change-edit').click();
  await expect(page.locator('.image-change .photo-actions')).toHaveCount(0);
  expect(await page.locator('.image-change .photo-panel').evaluate((panel) => panel.firstElementChild?.classList.contains('crop-editor'))).toBe(true);
  await page.locator('#crop-cancel').click();
  await expect(page.locator('#image-change-edit')).toBeFocused();
  await page.locator('#image-change-edit').click();
  await page.locator('#crop-rotate').click();
  await page.locator('#apply-crop').click();
  await expect.poll(() => api.inputs.length).toBe(2);
  await expect(page.locator('#image-change-edit')).toBeFocused();
  expect(api.requests.some((call) => call.path.endsWith('/reserve_image_change'))).toBe(false);
  expect(item).toEqual(before); expect(image).toEqual(oldImage);
});

test('UX L1b T13 the Add photo actions are one tidy group', async ({ page }) => {
  await ready(page);
  const group = page.locator('.photo-actions');
  await expect(group).toHaveCount(1);
  expect(await group.evaluate((element) => [...element.children].map((child) => child.id || child.textContent?.trim())))
    .toEqual(['choose-photo', text('capture.camera'), 'edit-photo']);
  const layout = () => group.evaluate((element) => ({
    boxes: [...element.children].map((child) => child.getBoundingClientRect().toJSON() as DOMRect),
    fits: document.documentElement.scrollWidth <= innerWidth,
  }));
  await page.setViewportSize({ width: 1280, height: 900 });
  let current = await layout();
  expect(new Set(current.boxes.map((box) => Math.round(box.top))).size).toBe(1);
  expect(current.fits).toBe(true);
  await page.setViewportSize({ width: 320, height: 800 });
  current = await layout();
  expect(current.fits).toBe(true);
  for (const [index, a] of current.boxes.entries()) for (const b of current.boxes.slice(index + 1)) {
    expect(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5).toBe(true);
  }
  await page.locator('#edit-photo').click();
  await expect(page.locator('.photo-actions')).toHaveCount(0);
  expect(await page.locator('.photo-panel').evaluate((panel) => panel.firstElementChild?.classList.contains('crop-editor'))).toBe(true);
});

for (const language of languages) {
  test(`UX L1b T14 crop editor accessibility at 1280, 320 and 200% text in ${language}`, async ({ page }) => {
    test.slow();
    await ready(page, language);
    await openEditor(page);
    const check = async () => {
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const heights = await page.locator('.crop-editor button, .crop-editor summary, .crop-editor input').evaluateAll((elements) => elements
        .filter((element) => element.getClientRects().length).map((element) => element.getBoundingClientRect().height));
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    };
    for (const open of [false, true]) {
      if (open) await openExact(page);
      for (const width of [1280, 320]) { await page.setViewportSize({ width, height: 900 }); await check(); }
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await check();
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    }
    expect(await page.locator('#crop-help').evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    const frame = page.locator('#crop-rectangle');
    await expect(frame).toHaveAccessibleName(text('photo.cropRectangle', language));
    expect((await frame.getAttribute('aria-describedby'))!.split(' ')).toContain('crop-help');
    for (const corner of corners) {
      const element = page.locator(handle(corner));
      await expect(element).toHaveAttribute('aria-hidden', 'true');
      expect(await element.evaluate((node: HTMLElement) => node.tabIndex < 0 && !node.hasAttribute('tabindex'))).toBe(true);
    }
    await expect(page.locator('#crop-cancel')).toHaveAccessibleName(text('photo.cancelCrop', language));
    expect(text('photo.cancelCrop', language)).not.toBe(text('common.cancel', language));
    await expect(page.getByRole('button', { name: text('common.cancel', language), exact: true })).toHaveCount(1);
  });
}

test.describe('bounded UX L1b visual evidence', () => {
  test.describe.configure({ retries: 0 });
  for (const selected of [{ project: 'chromium', language: 'en', width: 1280, suffix: 'en-desktop' },
    { project: 'mobile', language: 'fi', width: 320, suffix: 'fi-mobile' }] as const) {
    test(`T15 crop editor and photo actions ${selected.suffix} retain functional assertions in every project`, async ({ page }, testInfo: TestInfo) => {
      const language: Language = selected.language;
      const write = testInfo.project.name === selected.project;
      await page.setViewportSize({ width: selected.width, height: 900 });
      await ready(page, language);
      const directory = path.resolve('test-results/ux-l1b-visual');
      if (write) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      }
      const capture = async (name: 'crop' | 'crop-exact' | 'photo-actions') => {
        expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(await page.evaluate(({ expectedLanguage, width }) => {
          const privatePattern = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
            .filter((field) => field.getClientRects().length).map((field) => field.value).join('\n');
          return location.hostname === '127.0.0.1' && document.documentElement.lang === expectedLanguage && innerWidth === width
            && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('input[type=password],#email,#password')
            && !privatePattern.test(document.body.innerText) && !privatePattern.test(fields);
        }, { expectedLanguage: language, width: selected.width })).toBe(true);
        if (!write) return;
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png', scale: 'css' });
        expect(png.byteLength > 0 && png.byteLength <= 1048576).toBe(true);
        expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && png.readUInt32BE(16) === selected.width).toBe(true);
        const file = await open(path.join(directory, `${name}-${selected.suffix}.png`), 'wx');
        try { await file.writeFile(png); } finally { await file.close(); }
      };
      await expect(page.locator('.photo-actions')).toHaveCount(1);
      await capture('photo-actions');
      await openEditor(page);
      await setExact(page, { width: '70', height: '70', x: '15', y: '15' });
      await page.locator('details.crop-exact > summary').click();
      await expect(page.locator('#crop-width')).toBeHidden();
      await expect(page.locator('.crop-handle')).toHaveCount(4);
      await capture('crop');
      await openExact(page);
      await capture('crop-exact');
      await page.locator('#crop-cancel').click();
      await expect(page.locator('#edit-photo')).toBeFocused();
    });
  }
});
