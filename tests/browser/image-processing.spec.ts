import { expect, test } from '@playwright/test';
import { CORNER_COLOURS, ORIENTATION_CORNERS } from '../fixtures/jpeg-helpers';
import type { summarizeJpeg } from '../fixtures/jpeg-helpers';

type Summary = Awaited<ReturnType<typeof summarizeJpeg>>;

function expectSanitized(image: Summary, maxSide: number, maxBytes: number): void {
  expect(image.type).toBe('image/jpeg');
  expect(image.size).toBeGreaterThan(0);
  expect(image.size).toBeLessThanOrEqual(maxBytes);
  expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(maxSide);
  expect(image.hasPrivateText).toBe(false);
  expect(image.hasFilename).toBe(false);
  expect(image.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(image.markers).toContain(0xda);
  expect(image.markers.at(-1)).toBe(0xd9);
  for (const marker of image.markers) {
    expect(marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)).toBe(false);
  }
}

test.beforeEach(async ({ page }) => {
  // Exercise the real Vite module without loading the app, auth, or mock backend.
  await page.route('**/__image-processing-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local JPEG test</title>' }),
  );
  await page.goto('/__image-processing-test');
});

for (const path of ['bitmap', 'fallback', 'unsupported-bitmap'] as const) {
  test(`all eight EXIF orientations and privacy metadata: ${path}`, async ({ page }) => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      await test.step(`orientation ${orientation}`, async () => {
        const result = await page.evaluate(async ({ orientation, path }) => {
          const modulePath = '/src/images/process-jpeg.ts';
          const helperPath = '/tests/fixtures/jpeg-helpers.ts';
          const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
          const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
          const jpeg = await helpers.addPrivateMetadata(await helpers.makeCanvasJpeg(), orientation, orientation % 2 === 0);
          const source = new File([jpeg], 'private-original-name.jpg', { type: 'application/octet-stream' });
          const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
          if (path !== 'bitmap') {
            Object.defineProperty(globalThis, 'createImageBitmap', {
              configurable: true,
              value: path === 'fallback' ? undefined : () => Promise.reject(new TypeError('unsupported options')),
            });
          }
          try {
            const prepared = await prepareJpeg(source);
            return {
              main: await helpers.summarizeJpeg(prepared.main),
              thumb: await helpers.summarizeJpeg(prepared.thumb),
              width: prepared.width, height: prepared.height,
              mainHash: prepared.mainSha256, thumbHash: prepared.thumbSha256,
              inputMarkers: helpers.listJpegMarkers(new Uint8Array(await source.arrayBuffer())),
            };
          } finally {
            if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
          }
        }, { orientation, path });
        expect(result.inputMarkers).toEqual(expect.arrayContaining([0xe1, 0xed, 0xfe]));
        const dimensions = orientation >= 5 ? [80, 120] : [120, 80];
        expect([result.width, result.height]).toEqual(dimensions);
        expect([result.main.width, result.main.height]).toEqual(dimensions);
        expect([result.thumb.width, result.thumb.height]).toEqual(dimensions);
        expectSanitized(result.main, 1600, 512_000);
        expectSanitized(result.thumb, 320, 61_440);
        expect(result.mainHash).toBe(result.main.hash);
        expect(result.thumbHash).toBe(result.thumb.hash);
        const order = ORIENTATION_CORNERS[orientation - 1]!;
        for (const image of [result.main, result.thumb]) {
          order.forEach((colour, corner) => {
            CORNER_COLOURS[colour]!.forEach((channel, index) => {
              expect(Math.abs(image.corners[corner]![index]! - channel)).toBeLessThan(20);
            });
          });
        }
      });
    }
  });
}

test('resizes without upscaling, preserving portrait and landscape aspect ratios', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const results = [];
    for (const [width, height] of [[2400, 1800], [1800, 2400], [31, 19], [1, 97]]) {
      const result = await prepareJpeg(await helpers.makeCanvasJpeg(width!, height!));
      results.push({
        input: [width!, height!],
        main: await helpers.summarizeJpeg(result.main),
        thumb: await helpers.summarizeJpeg(result.thumb),
        reported: [result.width, result.height],
      });
    }
    return results;
  });
  for (const { input, main, thumb, reported } of results) {
    expectSanitized(main, 1600, 512_000);
    expectSanitized(thumb, 320, 61_440);
    expect(reported).toEqual([main.width, main.height]);
    const [width, height] = input as [number, number];
    for (const image of [main, thumb]) {
      const side = image === main ? 1600 : 320;
      const scale = Math.min(1, side / Math.max(width, height));
      expect([image.width, image.height]).toEqual([
        Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)),
      ]);
    }
  }
});

test('dense synthetic pixels exercise quality and dimension reduction within both budgets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg(1600, 1600, true);
    const native = HTMLCanvasElement.prototype.toBlob;
    const attempts: { side: number; quality: number | undefined }[] = [];
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      attempts.push({ side: Math.max(this.width, this.height), quality: typeof quality === 'number' ? quality : undefined });
      native.call(this, callback, type, quality);
    };
    try {
      const result = await prepareJpeg(source);
      return {
        main: await helpers.summarizeJpeg(result.main),
        thumb: await helpers.summarizeJpeg(result.thumb), attempts,
      };
    } finally {
      HTMLCanvasElement.prototype.toBlob = native;
    }
  });
  expectSanitized(result.main, 1600, 512_000);
  expectSanitized(result.thumb, 320, 61_440);
  expect(result.main.width).toBeLessThan(1600);
  expect(result.main.width).toBeGreaterThanOrEqual(800);
  expect(result.main.width).toBe(result.main.height);
  expect(result.attempts.slice(0, 5).map((attempt) => attempt.quality)).toEqual([0.82, 0.75, 0.68, 0.61, 0.55]);
  expect(result.attempts[5]?.side).toBe(1360);
  expect(result.attempts.length).toBeLessThanOrEqual(60);
});

test('oversized headers are rejected before decoder or canvas allocation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const native = document.createElement.bind(document);
    const bitmap = globalThis.createImageBitmap;
    let canvases = 0;
    let decodes = 0;
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      if (tagName === 'canvas') canvases += 1;
      return native(tagName, options);
    } as typeof document.createElement;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: () => { decodes += 1; throw new Error('unexpected decode'); },
    });
    try {
      let code: unknown;
      try { await prepareJpeg(new Blob([helpers.jpegHeaderFixture(9000, 5000)])); }
      catch (error) { code = error instanceof Error && 'code' in error ? error.code : undefined; }
      return { canvases, decodes, code };
    } finally {
      document.createElement = native;
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: bitmap });
    }
  });
  expect(result).toEqual({ canvases: 0, decodes: 0, code: 'tooLarge' });
});

test('exhausted byte budgets stop at the floor and clear the canvas', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const sources = [await helpers.makeCanvasJpeg(1600, 1000), await helpers.makeCanvasJpeg(120, 80)];
    const native = HTMLCanvasElement.prototype.toBlob;
    const oversized = new Blob([new Uint8Array(512_001)], { type: 'image/jpeg' });
    const results = [];
    try {
      for (const source of sources) {
        const attempts: { width: number; height: number; quality: number | undefined }[] = [];
        const canvases = new Set<HTMLCanvasElement>();
        HTMLCanvasElement.prototype.toBlob = function (callback, _type, quality) {
          canvases.add(this);
          attempts.push({ width: this.width, height: this.height, quality: typeof quality === 'number' ? quality : undefined });
          callback(oversized);
        };
        let code: unknown;
        try { await prepareJpeg(source); }
        catch (error) { code = error instanceof Error && 'code' in error ? error.code : undefined; }
        results.push({ code, attempts, released: [...canvases].every((canvas) => canvas.width === 1 && canvas.height === 1) });
      }
    } finally {
      HTMLCanvasElement.prototype.toBlob = native;
    }
    return results;
  });
  expect(results[0]?.code).toBe('tooLarge');
  expect(results[0]?.attempts).toHaveLength(30);
  expect(results[0]?.attempts.at(-1)).toEqual({ width: 800, height: 500, quality: 0.55 });
  expect(results[1]?.code).toBe('tooLarge');
  expect(results[1]?.attempts).toHaveLength(5);
  expect(results[1]?.attempts.at(-1)).toEqual({ width: 120, height: 80, quality: 0.55 });
  expect(results.every((result) => result.released)).toBe(true);
});

test('bitmap resources close after success, encoder failure and late cancellation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const nativeBitmap = globalThis.createImageBitmap;
    const nativeEncode = HTMLCanvasElement.prototype.toBlob;
    const orientations: (ImageOrientation | undefined)[] = [];
    let opened = 0;
    let closed = 0;
    let hold: (() => void) | undefined;
    let decodeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { decodeStarted = resolve; });
    let delay = false;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: async (blob: ImageBitmapSource, options?: ImageBitmapOptions) => {
        orientations.push(options?.imageOrientation);
        const bitmap = await nativeBitmap(blob, options);
        opened += 1;
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => { closed += 1; close(); };
        if (!delay) return bitmap;
        const waiting = new Promise<ImageBitmap>((resolve) => { hold = () => resolve(bitmap); });
        decodeStarted?.();
        return waiting;
      },
    });
    try {
      await prepareJpeg(source);
      const afterSuccess = { opened, closed };
      HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
      let failure: unknown;
      try { await prepareJpeg(source); }
      catch (error) { failure = error instanceof Error && 'code' in error ? error.code : undefined; }
      const afterFailure = { opened, closed };
      HTMLCanvasElement.prototype.toBlob = nativeEncode;
      delay = true;
      const controller = new AbortController();
      const pending = prepareJpeg(source, controller.signal).catch((error: unknown) =>
        error instanceof DOMException ? error.name : 'unexpected',
      );
      await started;
      controller.abort(new Error('private cancellation text'));
      const aborted = await pending;
      hold?.();
      // Drain the native decode and its late-resource cleanup callback.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { afterSuccess, afterFailure, failure, aborted, opened, closed, orientations };
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: nativeBitmap });
      HTMLCanvasElement.prototype.toBlob = nativeEncode;
    }
  });
  expect(result.afterSuccess).toEqual({ opened: 1, closed: 1 });
  expect(result.afterFailure).toEqual({ opened: 2, closed: 2 });
  expect(result.failure).toBe('unavailable');
  expect(result.aborted).toBe('AbortError');
  expect(result.opened).toBe(3);
  expect(result.closed).toBe(3);
  expect(result.orientations).toEqual(['from-image', 'from-image', 'from-image']);
});

test('HTML fallback revokes every Blob URL on success, invalid decode and cancellation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const nativeBitmap = globalThis.createImageBitmap;
    const nativeCreate = URL.createObjectURL;
    const nativeRevoke = URL.revokeObjectURL;
    const created: string[] = [];
    const revoked: string[] = [];
    let controller: AbortController | undefined;
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: undefined });
    URL.createObjectURL = (blob) => {
      const url = nativeCreate(blob);
      created.push(url);
      controller?.abort();
      return url;
    };
    URL.revokeObjectURL = (url) => { revoked.push(url); nativeRevoke(url); };
    try {
      await prepareJpeg(source);
      let invalid: unknown;
      const corrupt = helpers.insertSegments(
        helpers.jpegHeaderFixture(), helpers.jpegSegment(0xdb, new Uint8Array([0xff])),
      );
      try { await prepareJpeg(new Blob([corrupt])); }
      catch (error) { invalid = error instanceof Error && 'code' in error ? error.code : undefined; }
      controller = new AbortController();
      let aborted: unknown;
      try { await prepareJpeg(source, controller.signal); }
      catch (error) { aborted = error instanceof DOMException ? error.name : 'unexpected'; }
      return { created, revoked, invalid, aborted };
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: nativeBitmap });
      URL.createObjectURL = nativeCreate;
      URL.revokeObjectURL = nativeRevoke;
    }
  });
  expect(result.created).toHaveLength(3);
  expect(result.revoked).toEqual(result.created);
  expect(result.invalid).toBe('invalid');
  expect(result.aborted).toBe('AbortError');
});

test('rejects metadata if an encoder unexpectedly returns it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const native = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      native.call(this, (blob) => {
        if (!blob) callback(null);
        else void helpers.addPrivateMetadata(blob, 1).then(callback);
      }, type, quality);
    };
    try {
      await prepareJpeg(source);
      return 'unexpected success';
    } catch (error) {
      return error instanceof Error && 'code' in error ? error.code : 'unexpected error';
    } finally {
      HTMLCanvasElement.prototype.toBlob = native;
    }
  });
  expect(result).toBe('invalid');
});
