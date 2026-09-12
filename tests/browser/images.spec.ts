import { chromium, expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { CORNER_COLOURS, ORIENTATION_CORNERS } from '../fixtures/jpeg-helpers';
import { mockBackend, owners, signIn } from './mock-backend';
import { manualEntry } from './ai-photo-first-support';

type Format = 'png' | 'webp' | 'jpeg';

// Image bytes stay inside the test process/browser; only assertions reach the text reporter.
async function nativeFixture({ format, alpha = false, width = 120, height = 80 }: { format: Format; alpha?: boolean; width?: number; height?: number }) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d')!;
    ['rgb(240,30,30)', 'rgb(30,210,50)', 'rgb(30,70,230)', 'rgb(230,200,20)'].forEach((colour, index) => {
      if (alpha && index === 0) return;
      context.fillStyle = colour;
      context.fillRect(index % 2 * width / 2, Math.floor(index / 2) * height / 2, width / 2, height / 2);
    });
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Fixture encoding failed')), `image/${format}`, 1));
    return [...new Uint8Array(await blob.arrayBuffer())];
  } finally { canvas.width = 1; canvas.height = 1; }
}

async function fixture(page: Page, format: Format, alpha = false, size = { width: 120, height: 80 }): Promise<number[]> {
  let bytes = await page.evaluate(nativeFixture, { format, alpha, ...size });
  if (format === 'webp') {
    const isWebp = (value: number[]) => String.fromCharCode(...value.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...value.slice(8, 12)) === 'WEBP';
    if (!isWebp(bytes)) {
      const browser = await chromium.launch();
      try {
        const generator = await browser.newPage();
        bytes = await generator.evaluate(nativeFixture, { format, alpha, ...size });
      } finally { await browser.close(); }
    }
    expect(isWebp(bytes), 'Native fixture must be actual RIFF/WEBP, never a PNG fallback').toBe(true);
  }
  return bytes;
}

function cornersMatch(actual: number[][], expected: readonly number[]) {
  return actual.every((pixel, index) => pixel.every((channel, component) =>
    Math.abs(channel - CORNER_COLOURS[expected[index]!]![component]!) < 35));
}

for (const format of ['png', 'webp'] as const) {
  test(`I07 native ${format === 'png' ? 'PNG' : 'WebP'} orientation normalization preserves pixels and privacy`, async ({ page }) => {
    await page.goto('/');
    const bytes = await fixture(page, format);
    const results = await page.evaluate(async ({ bytes, format }) => {
      const imagePath = '/src/images/process-image.ts', helperPath = '/tests/fixtures/image-helpers.ts';
      const jpegHelperPath = '/tests/fixtures/jpeg-helpers.ts', validatorPath = '/src/images/validate.ts';
      const { prepareImage } = await import(imagePath) as typeof import('../../src/images/process-image');
      const { withExif, pngStructure, fixtureFailure } = await import(helperPath) as typeof import('../fixtures/image-helpers');
      const { summarizeJpeg } = await import(jpegHelperPath) as typeof import('../fixtures/jpeg-helpers');
      const { validateImage } = await import(validatorPath) as typeof import('../../src/images/validate');
      const nativeBitmap = globalThis.createImageBitmap;
      const results = [];
      const baseline = [];
      const raw = new Blob([new Uint8Array(bytes)]);
      const rawStructure = format === 'png' ? await pngStructure(raw) : null;
      let structure = rawStructure, phase = 'raw-validation', fallback = false, orientation = 0;
      try {
        const rawAdmission = await validateImage(raw);
        for (fallback of [false, true]) {
          Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: fallback ? undefined : nativeBitmap });
          phase = 'raw-prepare'; orientation = 0; structure = rawStructure;
          const rawPhoto = await prepareImage(raw);
          phase = 'raw-output';
          baseline.push({ fallback, orientation: rawAdmission.orientation, main: await summarizeJpeg(rawPhoto.main) });
          for (orientation = 1; orientation <= 8; orientation++) {
            phase = 'injection';
            const source = await withExif(raw, format, orientation);
            structure = format === 'png' ? await pngStructure(source) : null;
            phase = 'injected-validation';
            const admitted = await validateImage(source);
            if (admitted.orientation !== orientation || structure && structure.exifCount !== 1) throw new Error('Fixture orientation mismatch');
            phase = 'injected-prepare';
            const photo = await prepareImage(source);
            phase = 'injected-output';
            results.push({
              fallback, orientation, raw: [admitted.width, admitted.height],
              main: await summarizeJpeg(photo.main), thumb: await summarizeJpeg(photo.thumb),
              hashes: [photo.mainSha256, photo.thumbSha256],
            });
          }
        }
      } catch (error) {
        return { ok: false as const, failure: { format, fallback, orientation, phase, ...fixtureFailure(error), rawStructure, structure } };
      } finally { Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: nativeBitmap }); }
      return { ok: true as const, results, baseline, rawStructure, injectedStructure: structure };
    }, { bytes, format });
    if (!results.ok) throw new Error(JSON.stringify(results.failure));
    console.log(JSON.stringify({ format, phase: 'raw-and-injected-complete', rawStructure: results.rawStructure, injectedStructure: results.injectedStructure }));
    expect(results.baseline).toHaveLength(2);
    for (const result of results.baseline) {
      expect(result.orientation).toBe(1);
      expect([result.main.width, result.main.height]).toEqual([120, 80]);
      expect(cornersMatch(result.main.corners, [0, 1, 2, 3]), 'Raw generated source pixels').toBe(true);
    }
    expect(results.results).toHaveLength(16);
    for (const result of results.results) {
      expect(result.raw).toEqual([120, 80]);
      for (const [index, output] of [result.main, result.thumb].entries()) {
        expect([output.width, output.height]).toEqual(result.orientation >= 5 ? [80, 120] : [120, 80]);
        expect(cornersMatch(output.corners, ORIENTATION_CORNERS[result.orientation - 1]!), 'Independent asymmetric corner pixels').toBe(true);
        expect(output.size).toBeLessThanOrEqual(index ? 61440 : 512000);
        expect(output.hash).toBe(result.hashes[index]);
        expect(output.type).toBe('image/jpeg');
        expect(output.hasPrivateText || output.hasFilename || output.markers.some((marker) => [0xe1, 0xe2, 0xed, 0xfe].includes(marker))).toBe(false);
      }
    }
  });
}

test('I07 native crop and rotation compose once', async ({ page }) => {
  await page.goto('/');
  const png = await fixture(page, 'png'), webp = await fixture(page, 'webp'), jpeg = await fixture(page, 'jpeg');
  const results = await page.evaluate(async ({ png, webp, jpeg }) => {
    const imagePath = '/src/images/process-image.ts', helperPath = '/tests/fixtures/image-helpers.ts', jpegPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareImage } = await import(imagePath) as typeof import('../../src/images/process-image');
    const { withExif, pngStructure, fixtureFailure } = await import(helperPath) as typeof import('../fixtures/image-helpers');
    const { addPrivateMetadata, summarizeJpeg } = await import(jpegPath) as typeof import('../fixtures/jpeg-helpers');
    const validatorPath = '/src/images/validate.ts';
    const { validateImage } = await import(validatorPath) as typeof import('../../src/images/validate');
    const native = globalThis.createImageBitmap;
    const results = [];
    let format: Format = 'png', fallback = false, phase = 'raw-validation', orientation = 0;
    type Structure = Awaited<ReturnType<typeof pngStructure>> | null;
    let rawStructure: Structure = null, structure: Structure = null;
    try {
      for (fallback of [false, true]) {
        Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: fallback ? undefined : native });
        for (format of ['png', 'webp', 'jpeg'] as const) {
          const blob = new Blob([new Uint8Array({ png, webp, jpeg }[format])]);
          phase = 'raw-validation'; orientation = 0;
          rawStructure = format === 'png' ? await pngStructure(blob) : null;
          structure = rawStructure;
          if (format !== 'jpeg') await validateImage(blob);
          phase = 'raw-prepare';
          await prepareImage(blob);
          phase = 'injection'; orientation = 6;
          const source = format === 'jpeg' ? await addPrivateMetadata(blob, 6) : await withExif(blob, format, 6);
          structure = format === 'png' ? await pngStructure(source) : null;
          phase = 'injected-validation';
          if (format !== 'jpeg') {
            const admitted = await validateImage(source);
            if (admitted.orientation !== orientation || structure && structure.exifCount !== 1) throw new Error('Fixture orientation mismatch');
          }
          phase = 'injected-prepare';
          const photo = await prepareImage(source, undefined, { turns: 1, crop: { x: 0, y: 0, width: 0.5, height: 1 } });
          phase = 'injected-output';
          results.push({ format, fallback, main: await summarizeJpeg(photo.main), thumb: await summarizeJpeg(photo.thumb) });
        }
      }
    } catch (error) {
      return { ok: false as const, failure: { format, fallback, orientation, phase, ...fixtureFailure(error), rawStructure, structure } };
    } finally { Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: native }); }
    return { ok: true as const, results };
  }, { png, webp, jpeg });
  if (!results.ok) throw new Error(JSON.stringify(results.failure));
  for (const result of results.results) for (const output of [result.main, result.thumb]) {
    expect([output.width, output.height]).toEqual([60, 80]);
    expect(cornersMatch(output.corners, [3, 3, 1, 1]), `${result.format} composed once`).toBe(true);
    expect(output.hasPrivateText).toBe(false);
  }
});

test('I07 default JPEG is byte-identical and transparency uses the warm neutral background', async ({ page }) => {
  await page.goto('/');
  const jpeg = await fixture(page, 'jpeg'), png = await fixture(page, 'png', true), webp = await fixture(page, 'webp', true);
  const result = await page.evaluate(async ({ jpeg, png, webp }) => {
    const path = '/src/images/process-image.ts', jpegPath = '/src/images/process-jpeg.ts', helpersPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareImage } = await import(path) as typeof import('../../src/images/process-image');
    const { prepareJpeg } = await import(jpegPath) as typeof import('../../src/images/process-jpeg');
    const { summarizeJpeg } = await import(helpersPath) as typeof import('../fixtures/jpeg-helpers');
    const source = new File([new Uint8Array(jpeg)], 'synthetic.heic', { type: 'application/octet-stream' });
    const baseline = await prepareJpeg(source);
    const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
    const nativeTransform = CanvasRenderingContext2D.prototype.setTransform;
    let transformed = false;
    const argumentCounts: number[] = [];
    CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
      argumentCounts.push(args.length); return Reflect.apply(nativeDraw, this, args);
    };
    CanvasRenderingContext2D.prototype.setTransform = function (...args: unknown[]) {
      transformed = true; return Reflect.apply(nativeTransform, this, args);
    };
    let actual;
    try { actual = await prepareImage(source); }
    finally { CanvasRenderingContext2D.prototype.drawImage = nativeDraw; CanvasRenderingContext2D.prototype.setTransform = nativeTransform; }
    const same = await Promise.all((['main', 'thumb'] as const).map(async (key) => {
      const a = new Uint8Array(await baseline[key].arrayBuffer()), b = new Uint8Array(await actual[key].arrayBuffer());
      return a.length === b.length && a.every((byte, index) => b[index] === byte);
    }));
    const alpha = [];
    for (const bytes of [png, webp]) {
      const photo = await prepareImage(new Blob([new Uint8Array(bytes)]));
      alpha.push(await summarizeJpeg(photo.main));
    }
    return { same, hashes: baseline.mainSha256 === actual.mainSha256 && baseline.thumbSha256 === actual.thumbSha256, transformed, argumentCounts, alpha };
  }, { jpeg, png, webp });
  expect(result.same).toEqual([true, true]);
  expect(result.hashes && !result.transformed).toBe(true);
  expect(result.argumentCounts).toEqual([5, 5]);
  for (const output of result.alpha) {
    expect([output.width, output.height]).toEqual([120, 80]);
    expect(output.corners[0]!.every((channel, index) => Math.abs(channel - [246, 243, 237][index]!) < 10)).toBe(true);
  }
});

async function setup(page: Page, language: Language = 'en', failCommitOnce = false, size = { width: 120, height: 80 }) {
  const api = await mockBackend(page, { initialLanguage: language, failCommitOnce });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
  const bytes = await fixture(page, 'png', false, size);
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await expect(page.locator('#edit-photo')).toBeEnabled();
  await manualEntry(page);
  return api;
}

for (const size of [{ width: 3200, height: 1214 }, { width: 1600, height: 530 }]) {
  test(`I07 Original ratio and edge nudges apply ordinary decimals for ${size.width}x${size.height}`, async ({ page }) => {
    await setup(page, 'en', false, size);
    await page.locator('#item-title').fill('Synthetic ratio garment');
    await page.locator('#item-category').selectOption('top');
    const previewSize = await page.locator('.capture-photo img').evaluate((image: HTMLImageElement) =>
      ({ width: image.naturalWidth, height: image.naturalHeight }));
    expect(previewSize).toEqual({ width: 1600, height: size.height === 1214 ? 607 : 530 });
    await page.locator('#edit-photo').click();
    await page.locator('#crop-aspect').selectOption('original');
    await expect(page.locator('#crop-x')).toHaveValue('0');
    await expect(page.locator('#crop-y')).toHaveValue('0');
    await expect(page.locator('#apply-crop')).toBeEnabled();
    await page.locator('#apply-crop').click();
    await expect(page.locator('#edit-photo')).toBeFocused();
    for (const field of ['width', 'height']) {
      await page.locator('#edit-photo').click();
      await page.locator(`#crop-${field}`).fill('99.99999999999999');
      await page.locator('#crop-rectangle').focus();
      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Shift+ArrowRight', 'Shift+ArrowDown']) {
        await page.keyboard.press(key);
        expect(await page.locator('.crop-fields input').evaluateAll((inputs) =>
          inputs.every((input) => /^\d+(?:\.\d+)?$/.test((input as HTMLInputElement).value)))).toBe(true);
        await expect(page.locator('#apply-crop')).toBeEnabled();
      }
      await page.locator('#apply-crop').click();
      await expect(page.locator('#edit-photo')).toBeFocused();
      await expect(page.locator('button[type="submit"]')).toBeEnabled();
    }
    await page.locator('#edit-photo').click();
    await page.getByRole('button', { name: messages['photo.rotateRight'].en, exact: true }).click();
    await page.locator('#crop-aspect').selectOption('original');
    const crop = await page.locator('.crop-fields input').evaluateAll((inputs) =>
      inputs.map((input) => Number((input as HTMLInputElement).value) / 100));
    expect(crop[2]! * previewSize.height / (crop[3]! * previewSize.width)).toBeCloseTo(previewSize.width / previewSize.height, 9);
    expect(crop[2]! < 1 || crop[3]! < 1).toBe(true);
    await expect(page.locator('#apply-crop')).toBeEnabled();
    await page.locator('#apply-crop').click();
    await expect(page.locator('#edit-photo')).toBeFocused();
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
  });
}

test('I07 accepted crop alone enters immutable Save and retry', async ({ page }) => {
  const api = await setup(page, 'en', true);
  await page.locator('#item-title').fill('Synthetic cropped garment');
  await page.locator('#item-category').selectOption('top');
  await page.locator('#edit-photo').click();
  await page.locator('#crop-width').fill('50');
  await page.locator('#crop-rectangle').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#crop-x')).toHaveValue('1');
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await page.locator('#apply-crop').click();
  await expect(page.locator('.crop-editor')).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await expect(page.locator('#edit-photo')).toBeFocused();
  const accepted = await page.locator('.capture-photo img').evaluate(async (element: HTMLImageElement) => {
    const blob = await (await fetch(element.src)).blob();
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return { hash: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), width: element.naturalWidth };
  });
  expect(accepted.width).toBe(61);
  expect(api.items.length === 0 && api.images.length === 0 && api.files.size === 0).toBe(true);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  const saved = { ...api.images[0] }, item = { ...api.items[0] };
  expect(saved.main_sha256).toBe(accepted.hash);
  await expect(page.locator('#edit-photo')).toBeDisabled();
  const hashes = [...api.files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]);
  await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect(page.locator('.item-caption h2')).toHaveText('Synthetic cropped garment');
  expect(api.items).toEqual([item]);
  expect(api.images).toEqual([{ ...saved, state: 'ready' }]);
  expect([...api.files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])).toEqual(hashes);
});

test('I07 cancel, reset, fit, language and owner cleanup retain only accepted drafts', async ({ page }) => {
  const api = await setup(page);
  const initial = await page.locator('.capture-photo img').getAttribute('src');
  await page.locator('#item-title').fill('Oma synthetic text');
  await page.locator('#edit-photo').click();
  await expect(page.locator('.photo-panel img')).toHaveCount(1);
  await expect(page.locator('.capture-photo, #edit-photo')).toHaveCount(0);
  await page.locator('#crop-width').fill('');
  await expect(page.locator('#apply-crop')).toBeDisabled();
  await page.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#crop-editor-title')).toBeFocused();
  await page.getByRole('button', { name: messages['photo.cancelCrop'].en }).click();
  await expect(page.locator('.capture-photo img')).toHaveAttribute('src', initial!);
  await expect(page.locator('#edit-photo')).toBeFocused();
  await page.locator('#edit-photo').click();
  await page.getByRole('button', { name: messages['photo.rotateRight'].en }).click();
  await page.locator('#crop-aspect').selectOption('1');
  await page.getByRole('button', { name: messages['photo.fit'].en }).click();
  await expect(page.locator('#crop-width')).toHaveValue('100');
  await page.getByRole('button', { name: messages['photo.reset'].en }).click();
  await page.locator('#crop-width').fill('50');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await expect(page.locator('#crop-width')).toHaveValue('50');
  await expect(page.locator('#item-title')).toHaveValue('Oma synthetic text');
  await expect(page.locator('#apply-crop')).toHaveText(messages['photo.applyCrop'].fi);
  await page.getByRole('button', { name: messages['auth.signOut'].fi, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.locator('#capture-title')).toBeVisible();
  await expect(page.locator('#item-title')).toHaveValue('');
  await expect(page.locator('#edit-photo')).toHaveCount(0);
  expect(api.items.length === 0 && api.images.length === 0 && api.files.size === 0).toBe(true);
});

test('I07 crop accessibility supports three languages, keyboard, narrow and enlarged text', async ({ page }) => {
  await setup(page);
  await page.locator('#edit-photo').click();
  for (const language of ['en', 'fi', 'sv'] as const) {
    if (language !== 'en') {
      await page.getByRole('button', { name: messages['account.menu'][language === 'fi' ? 'en' : 'fi'] }).click();
      await page.getByRole('button', { name: language === 'fi' ? 'Suomi' : 'Svenska', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await page.getByRole('button', { name: messages['account.menu'][language] }).click();
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await page.locator('#crop-width').fill('50');
    await page.locator('#crop-height').fill('50');
    await page.locator('#crop-rectangle').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#crop-x')).toHaveValue(String((['en', 'fi', 'sv'].indexOf(language) + 1)));
    await expect(page.getByRole('button', { name: messages['photo.rotateRight'][language], exact: true }))
      .toHaveText(messages['photo.rotateRight'][language]);
    expect(await page.locator('.crop-fields .field').evaluateAll((fields) => {
      const boxes = fields.map((field) => field.getBoundingClientRect());
      return boxes.every((box, index) => box.left === boxes[0]!.left && (!index || box.top > boxes[index - 1]!.bottom));
    })).toBe(true);
    expect(await page.evaluate(() => {
      if (document.documentElement.scrollWidth <= innerWidth) return [];
      return [...document.querySelectorAll('.capture-page *')].map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, className: element.className, left: rect.left, right: rect.right, width: rect.width };
      }).filter((rect) => rect.left >= 0 && rect.right > innerWidth + 1 && rect.width > 0);
    }), 'Narrow enlarged-text layout').toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.crop-editor button, .crop-editor input, .crop-editor select').evaluateAll((elements) =>
      elements.every((element) => element.getBoundingClientRect().height >= 44))).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('I07 rejects structural inputs before decode and mismatched native dimensions before encode', async ({ page }) => {
  await page.goto('/');
  const bytes = await fixture(page, 'png');
  const result = await page.evaluate(async (bytes) => {
    const imagePath = '/src/images/process-image.ts', helperPath = '/tests/fixtures/image-helpers.ts';
    const { prepareImage } = await import(imagePath) as typeof import('../../src/images/process-image');
    const { pngChunk, tiff, withExif } = await import(helperPath) as typeof import('../fixtures/image-helpers');
    const original = new Blob([new Uint8Array(bytes)]);
    const rotated = await withExif(original, 'png', 6);
    const malformed = new Blob([original.slice(0, -12), pngChunk('eXIf', tiff(9)), original.slice(-12)]);
    const animated = new Blob([original.slice(0, -12), pngChunk('acTL'), original.slice(-12)]);
    const native = globalThis.createImageBitmap;
    const nativeCreate = document.createElement.bind(document);
    let decoded = 0, closed = 0, canvases = 0;
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => {
      decoded++;
      return { width: 80, height: 120, close: () => closed++ };
    } });
    document.createElement = ((...args: Parameters<typeof nativeCreate>) => {
      if (args[0] === 'canvas') canvases++;
      return nativeCreate(...args);
    }) as typeof document.createElement;
    const results = [];
    try {
      for (const source of [malformed, animated, new Blob(['<svg/>']), rotated]) {
        try { await prepareImage(source); results.push({ code: 'accepted', stage: '' }); }
        catch (error) {
          const problem = error as { code?: string; stage?: string };
          results.push({ code: problem.code, stage: problem.stage });
        }
      }
      return { results, decoded, closed, canvases };
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: native });
      document.createElement = nativeCreate;
    }
  }, bytes);
  expect(result).toEqual({
    results: [{ code: 'invalid', stage: 'source' }, { code: 'unsupported', stage: 'source' },
      { code: 'unsupported', stage: 'source' }, { code: 'unsupported', stage: 'decode' }],
    decoded: 1, closed: 1, canvases: 0,
  });
});

type HeldDecode = { opened: number; closed: number; active: number; peak: number; release: () => void };
type ProbeWindow = Window & typeof globalThis & { i07Decode: HeldDecode };

test('I07 replacement serializes full-source lifetimes and ignores late cancelled pixels', async ({ page }) => {
  await setup(page);
  await page.locator('#item-title').fill('Preserved while replacing');
  const bytes = await fixture(page, 'png');
  await page.evaluate(() => {
    const native = globalThis.createImageBitmap;
    const probe: HeldDecode = { opened: 0, closed: 0, active: 0, peak: 0, release: () => {} };
    (window as ProbeWindow).i07Decode = probe;
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      const bitmap = await native(source, options);
      probe.opened++; probe.active++; probe.peak = Math.max(probe.peak, probe.active);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { probe.closed++; probe.active--; close(); };
      if (probe.opened === 1) await new Promise<void>((resolve) => { probe.release = resolve; });
      return bitmap;
    } });
  });
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: 'old.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).i07Decode.opened)).toBe(1);
  await input.setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  expect(await page.evaluate(() => (window as ProbeWindow).i07Decode.opened)).toBe(1);
  await page.evaluate(() => (window as ProbeWindow).i07Decode.release());
  await expect(page.locator('#edit-photo')).toBeEnabled();
  await expect(page.locator('#item-title')).toHaveValue('Preserved while replacing');
  expect(await page.evaluate(() => {
    const { opened, closed, active, peak } = (window as ProbeWindow).i07Decode;
    return { opened, closed, active, peak };
  })).toEqual({ opened: 2, closed: 2, active: 0, peak: 1 });
});

test('I07 logout prevents a held preparation publishing into another owner', async ({ page }) => {
  const api = await setup(page);
  const bytes = await fixture(page, 'png');
  await page.evaluate(() => {
    const native = globalThis.createImageBitmap;
    const probe: HeldDecode = { opened: 0, closed: 0, active: 0, peak: 0, release: () => {} };
    (window as ProbeWindow).i07Decode = probe;
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      const bitmap = await native(source, options);
      probe.opened++;
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { probe.closed++; close(); };
      await new Promise<void>((resolve) => { probe.release = resolve; });
      return bitmap;
    } });
  });
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).i07Decode.opened)).toBe(1);
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await page.evaluate(() => (window as ProbeWindow).i07Decode.release());
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).i07Decode.closed)).toBe(1);
  await signIn(page, 'b');
  await expect(page.locator('#capture-title')).toBeVisible();
  await expect(page.locator('.capture-photo img')).toHaveCount(0);
  await expect(page.locator('#edit-photo')).toHaveCount(0);
  expect(api.items.length === 0 && api.images.length === 0 && api.files.size === 0).toBe(true);
});

test('I07 synthetic crop visual evidence retains functional assertions in every project', async ({ page }, testInfo) => {
  const api = await setup(page);
  await page.locator('#item-title').fill('Synthetic green garment');
  await page.locator('#item-category').selectOption('top');
  await page.locator('#edit-photo').click();
  await page.locator('#crop-width').fill('80');
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  const directory = path.resolve('test-results/i07-visual');
  const captures = [
    { language: 'en', width: 1280, file: 'crop-en-desktop.png' },
    { language: 'fi', width: 320, file: 'crop-fi-mobile.png' },
  ] as const;
  for (const capture of captures) {
    if (capture.language === 'fi') {
      await page.getByRole('button', { name: messages['account.menu'].en }).click();
      await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
      await page.getByRole('button', { name: messages['account.menu'].fi }).click();
    }
    await page.setViewportSize({ width: capture.width, height: 900 });
    await expect(page.locator('.photo-panel img')).toHaveCount(1);
    await expect(page.locator('#edit-photo, .capture-photo')).toHaveCount(0);
    expect(await page.locator('.crop-fields .field').evaluateAll((fields) => {
      const boxes = fields.map((field) => field.getBoundingClientRect());
      const apply = document.querySelector('#apply-crop')!.getBoundingClientRect();
      return apply.top >= boxes[3]!.bottom + 12 && (innerWidth === 1280
        ? boxes[0]!.top === boxes[1]!.top && boxes[2]!.top === boxes[3]!.top && boxes[2]!.top > boxes[0]!.bottom
        : boxes.every((box, index) => !index || box.top > boxes[index - 1]!.bottom));
    }), 'Coherent crop grid and action spacing').toBe(true);
    expect(api.profiles[owners.a]?.ui_language === capture.language && api.items.length === 0
      && api.images.length === 0 && api.files.size === 0).toBe(true);
    expect(await page.evaluate(({ origin, language }) => {
      const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
      const values = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')]
        .filter(visible).map((element) => element.value).join('\n');
      const credentialLike = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      const image = document.querySelector<HTMLImageElement>('.crop-stage img');
      return location.origin === origin && location.hostname === '127.0.0.1' && location.hash === '#/items/new'
        && document.documentElement.lang === language && Boolean(document.querySelector('#capture-title'))
        && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
        && document.querySelector<HTMLInputElement>('#item-title')?.value === 'Synthetic green garment'
        && image?.src.startsWith('blob:') === true && image.naturalWidth === 120 && image.naturalHeight === 80
        && !document.querySelector('input[type="password"], #email, #password')
        && !credentialLike.test(document.body.innerText) && !credentialLike.test(values);
    }, { origin, language: capture.language }), 'Synthetic capture guard').toBe(true);
    await expect(page.locator('#crop-width')).toHaveValue('80');
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (testInfo.project.name === 'chromium') {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, capture.file), fullPage: true });
    }
  }
  if (testInfo.project.name === 'chromium') {
    expect((await readdir(directory)).sort()).toEqual(captures.map((capture) => capture.file).sort());
    for (const capture of captures) {
      const filename = path.join(directory, capture.file), stat = await lstat(filename);
      expect(stat.isFile() && stat.size > 24 && stat.size <= 1024 * 1024).toBe(true);
      const handle = await open(filename, 'r');
      try {
        const bytes = Buffer.alloc(24);
        const { bytesRead } = await handle.read(bytes, 0, 24, 0);
        expect(bytesRead === 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === capture.width).toBe(true);
      } finally { await handle.close(); }
    }
  }
});

test('I29a manual Save retries semantically reordered provenance without duplicate uploads', async ({ page }) => {
  const api = await setup(page, 'en', true);
  await page.locator('#item-title').fill('Synthetic provenance garment');
  await page.locator('#item-category').selectOption('top');
  const acceptedHash = await page.locator('.capture-photo img').evaluate(async (element: HTMLImageElement) => {
    const bytes = await (await fetch(element.src)).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  });
  expect(api.items.length === 0 && api.images.length === 0 && api.files.size === 0).toBe(true);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert').locator('p')).toHaveText([messages['error.unavailable'].en, messages['capture.retryNote'].en]);
  expect(api.items).toHaveLength(1);
  expect(api.images).toHaveLength(1);
  expect(api.items[0]).toMatchObject({
    owner_id: owners.a, title: 'Synthetic provenance garment', category: 'top', currency: 'EUR',
  });
  expect(api.items[0]!.field_provenance).toEqual({
    title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 },
  });
  const image = { ...api.images[0] };
  expect(image).toMatchObject({ owner_id: owners.a, item_id: api.items[0]!.id, state: 'pending', main_sha256: acceptedHash });
  expect(api.files.size).toBe(2);
  for (const variant of ['main', 'thumb']) {
    const bytes = api.files.get(String(image[`${variant}_path`]))!;
    expect(bytes.length).toBe(image[`${variant}_bytes`]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(image[`${variant}_sha256`]);
  }
  const files = new Map([...api.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const payloadBytes = api.uploadWire.payloadBytes;
  expect(api.uploadWire.posts).toBe(2);
  const originalMap = JSON.stringify(api.items[0]!.field_provenance);
  api.items[0]!.field_provenance = {
    category: { revision: 1, kind: 'user' }, title: { revision: 1, kind: 'user' },
  };
  expect(JSON.stringify(api.items[0]!.field_provenance) === originalMap).toBe(false);
  const item = structuredClone(api.items[0]);
  await expect(page.locator('#item-title')).toHaveAttribute('readonly', '');
  await expect(page.locator('#item-category')).toBeDisabled();
  await expect(page.locator('#edit-photo')).toBeDisabled();
  await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
  await expect(page.locator('.item-caption h2')).toHaveText('Synthetic provenance garment');
  await expect(page.locator('#capture-title')).toHaveCount(0);
  expect(api.items).toEqual([item]);
  expect(api.images).toEqual([{ ...image, state: 'ready' }]);
  expect(api.files.size).toBe(2);
  expect([...files].every(([name, bytes]) => api.files.get(name)?.equals(bytes))).toBe(true);
  expect(api.uploadWire.posts).toBe(2);
  expect(api.uploadWire.payloadBytes).toBe(payloadBytes);
  expect(api.requests.filter((request) => request.method === 'POST' && request.path === '/rest/v1/rpc/reserve_item_save')).toHaveLength(2);
  expect(api.requests.filter((request) => request.method === 'POST' && request.path === '/rest/v1/rpc/finalize_item_save')).toHaveLength(2);
  expect(api.requests.some((request) => request.method === 'POST'
    && ['/rest/v1/items', '/rest/v1/item_images', '/rest/v1/rpc/commit_image'].includes(request.path))).toBe(false);
});

for (const mismatch of [
  { name: 'kind', entry: { kind: 'unknown', revision: 1 } },
  { name: 'revision', entry: { kind: 'user', revision: 2 } },
]) {
  test(`I29a manual Save rejects a stored provenance ${mismatch.name} mismatch before image retry`, async ({ page }) => {
    const api = await setup(page, 'en', true);
    await page.locator('#item-title').fill('Synthetic unsaved garment');
    await page.locator('#item-category').selectOption('top');
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole('alert').locator('p')).toHaveText([messages['error.unavailable'].en, messages['capture.retryNote'].en]);
    expect(api.items).toHaveLength(1);
    expect(api.images).toHaveLength(1);
    expect(api.items[0]!.field_provenance).toEqual({
      title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 },
    });
    expect(api.images[0]!.state).toBe('pending');
    expect(api.files.size).toBe(2);
    expect(api.uploadWire.posts).toBe(2);
    expect(api.requests.filter((request) => request.method === 'POST' && request.path === '/rest/v1/rpc/finalize_item_save')).toHaveLength(1);
    api.items[0]!.field_provenance = {
      title: { ...mismatch.entry }, category: { kind: 'user', revision: 1 },
    };
    const item = structuredClone(api.items[0]), image = { ...api.images[0] };
    const files = new Map([...api.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const payloadBytes = api.uploadWire.payloadBytes, requestCount = api.requests.length;
    await page.getByRole('button', { name: messages['common.retry'].en, exact: true }).click();
    await expect(page.getByRole('alert').locator('p')).toHaveText([messages['error.conflict'].en, messages['capture.retryNote'].en]);
    await expect(page.locator('#capture-title')).toBeVisible();
    await expect(page.locator('.item-caption h2')).toHaveCount(0);
    await expect(page.locator('#item-title')).toHaveValue('Synthetic unsaved garment');
    await expect(page.locator('#item-title')).toHaveAttribute('readonly', '');
    await expect(page.locator('#item-category')).toBeDisabled();
    await expect(page.locator('#edit-photo')).toBeDisabled();
    await expect(page.locator('.capture-photo img')).toBeVisible();
    expect(api.items).toEqual([item]);
    expect(api.images).toEqual([image]);
    expect(api.files.size).toBe(2);
    expect([...files].every(([name, bytes]) => api.files.get(name)?.equals(bytes))).toBe(true);
    expect(api.uploadWire.posts).toBe(2);
    expect(api.uploadWire.payloadBytes).toBe(payloadBytes);
    expect(api.requests.slice(requestCount).filter((request) => request.method !== 'OPTIONS')
      .map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/rest/v1/rpc/reserve_item_save' },
    ]);
  });
}
