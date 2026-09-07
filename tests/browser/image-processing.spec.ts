import { expect, test } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import { appendFile } from 'node:fs/promises';
import { CORNER_COLOURS, ORIENTATION_CORNERS } from '../fixtures/jpeg-helpers';
import type { summarizeJpeg } from '../fixtures/jpeg-helpers';

type Summary = Awaited<ReturnType<typeof summarizeJpeg>>;

// Runs wholly in the synthetic page: never install hooks in the application.
async function probeGeneratedJpeg({ width, height, dense = false }: {
  width: number; height: number; dense?: boolean;
}) {
  const modulePath = '/src/images/process-jpeg.ts';
  const jpegPath = '/src/images/jpeg.ts';
  const helperPath = '/tests/fixtures/jpeg-helpers.ts';
  const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
  const { assertSanitizedJpeg, stripEncoderMetadata, ImagePreparationError } =
    await import(jpegPath) as typeof import('../../src/images/jpeg');
  const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
  type Outcome = 'not-run' | 'ok' | 'error' | 'invalid' | 'unsupported' | 'tooLarge' | 'unavailable';
  const rejection = (error: unknown): Outcome =>
    error instanceof ImagePreparationError && ['invalid', 'unsupported', 'tooLarge', 'unavailable'].includes(error.code)
      ? error.code : 'error';
  function inventory(bytes?: Uint8Array) {
    const result = {
      scope: 'validated-prefix' as const, outcome: 'not-run' as 'not-run' | 'ok' | 'error',
      callbackErrored: false, total: 0, truncated: false,
      records: [] as { marker: number; kind: 'exif' | 'icc' | 'other'; length: number }[],
    };
    if (!bytes) return result;
    try {
      helpers.inspectJpegSegments(bytes, (segment) => {
        // A collector failure is not a walker rejection; the observer is total.
        try {
          result.total += 1;
          if (result.records.length < 64) {
            result.records.push({ marker: segment.marker, kind: segment.kind, length: segment.end - segment.start });
          } else result.truncated = true;
        } catch { result.callbackErrored = true; }
      });
      result.outcome = 'ok';
    } catch { result.outcome = 'error'; }
    return result;
  }
  async function checkOutput(blob?: Blob, dimensions?: { width: number; height: number }) {
    const outcomes = {
      read: 'not-run' as Outcome, normalization: 'not-run' as Outcome,
      strictValidation: 'not-run' as Outcome, replacement: 'not-run' as Outcome,
      summary: 'not-run' as Outcome,
    };
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    let normalized: Uint8Array<ArrayBuffer> | undefined;
    let replacement: Blob | undefined;
    let summary: Summary | undefined;
    if (blob) {
      try { bytes = new Uint8Array(await blob.arrayBuffer()); outcomes.read = 'ok'; }
      catch { outcomes.read = 'error'; }
    }
    const before = inventory(bytes);
    if (bytes) {
      try { normalized = stripEncoderMetadata(bytes); outcomes.normalization = 'ok'; }
      catch (error) { outcomes.normalization = rejection(error); }
    }
    const after = inventory(normalized);
    if (normalized && dimensions) {
      try {
        assertSanitizedJpeg(normalized, dimensions.width, dimensions.height);
        outcomes.strictValidation = 'ok';
      } catch (error) { outcomes.strictValidation = rejection(error); }
      if (outcomes.strictValidation === 'ok') {
        try { replacement = new Blob([normalized], { type: 'image/jpeg' }); outcomes.replacement = 'ok'; }
        catch { outcomes.replacement = 'error'; }
      }
    }
    if (replacement) {
      try { summary = await helpers.summarizeJpeg(replacement); outcomes.summary = 'ok'; }
      catch { outcomes.summary = 'error'; }
    }
    return { evidence: { outcomes, before, after }, summary };
  }
  let source: Blob | undefined;
  let native: Summary | undefined;
  let sourceCreation: Outcome;
  let nativeSummary: Outcome = 'not-run';
  try { source = await helpers.makeCanvasJpeg(width, height, dense); sourceCreation = 'ok'; }
  catch { sourceCreation = 'error'; }
  if (source) {
    try { native = await helpers.summarizeJpeg(source); nativeSummary = 'ok'; }
    catch { nativeSummary = 'error'; }
  }
  const sourceCheck = await checkOutput(source, { width, height });
  const prepare = { outcome: 'not-run' as Outcome, stage: 'not-run' as string, code: 'not-run' as Outcome };
  const nativeEncode = HTMLCanvasElement.prototype.toBlob;
  const outputs: { canvas: HTMLCanvasElement; blob: Blob | null; width: number; height: number }[] = [];
  const attempts: { side: number; quality: number | undefined }[] = [];
  let captureErrored = false;
  let prepared: import('../../src/images/process-jpeg').PreparedPhoto | undefined;
  if (source) {
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      const width = this.width;
      const height = this.height;
      attempts.push({ side: Math.max(width, height), quality: typeof quality === 'number' ? quality : undefined });
      nativeEncode.call(this, (blob) => {
        try {
          const index = outputs.findIndex((output) => output.canvas === this);
          const output = { canvas: this, blob, width, height };
          if (index >= 0) outputs[index] = output;
          else if (outputs.length < 2) outputs.push(output);
          else captureErrored = true;
        } catch { captureErrored = true; }
        callback(blob);
      }, type, quality);
    };
    try {
      prepared = await prepareJpeg(source);
      prepare.outcome = 'ok';
    } catch (error) {
      prepare.outcome = rejection(error);
      if (error instanceof ImagePreparationError) {
        prepare.code = rejection(error);
        prepare.stage = error.stage && ['source', 'decode', 'mainEncode', 'thumbEncode', 'outputCheck', 'hash'].includes(error.stage)
          ? error.stage : 'error';
      } else { prepare.stage = 'error'; prepare.code = 'error'; }
    } finally { HTMLCanvasElement.prototype.toBlob = nativeEncode; }
  }
  // These are independent rechecks of the actual last native output per canvas,
  // not observations of private verifyAndHash internals or inferred failing markers.
  const mainCheck = await checkOutput(outputs[0]?.blob ?? undefined, outputs[0]);
  const thumbCheck = await checkOutput(outputs[1]?.blob ?? undefined, outputs[1]);
  const summaries: { main?: Summary; thumb?: Summary } = {};
  const preparedSummary = { main: 'not-run' as Outcome, thumb: 'not-run' as Outcome };
  for (const variant of ['main', 'thumb'] as const) {
    if (!prepared) continue;
    try { summaries[variant] = await helpers.summarizeJpeg(prepared[variant]); preparedSummary[variant] = 'ok'; }
    catch { preparedSummary[variant] = 'error'; }
  }
  return {
    evidence: {
      sourceCreation, nativeSummary, source: sourceCheck.evidence, prepare, captureErrored,
      boundary: 'captured-output-independent-recheck' as const,
      main: mainCheck.evidence, thumb: thumbCheck.evidence, preparedSummary,
    },
    native, normalized: sourceCheck.summary, ...summaries, attempts,
    hashes: prepared ? [prepared.mainSha256, prepared.thumbSha256] : undefined,
    reported: prepared ? [prepared.width, prepared.height] : undefined,
  };
}

async function publishProbe(testInfo: TestInfo, label: string, browserVersion: string, evidence: unknown) {
  const text = JSON.stringify({ case: label, browserVersion, evidence });
  console.log(`synthetic-jpeg-probe ${text}`);
  await testInfo.attach('synthetic-jpeg-probe', { body: text, contentType: 'application/json' });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
}

function expectProbeSuccess(result: Awaited<ReturnType<typeof probeGeneratedJpeg>>) {
  expect(result.evidence.sourceCreation).toBe('ok');
  expect(result.evidence.nativeSummary).toBe('ok');
  expect(result.evidence.prepare.outcome).toBe('ok');
  expect(result.evidence.captureErrored).toBe(false);
  expect(result.evidence.preparedSummary).toEqual({ main: 'ok', thumb: 'ok' });
  for (const output of [result.evidence.source, result.evidence.main, result.evidence.thumb]) {
    expect(Object.values(output.outcomes)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    for (const inventory of [output.before, output.after]) {
      expect(inventory.outcome).toBe('ok');
      expect(inventory.callbackErrored).toBe(false);
    }
  }
}

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

test('fresh native four-colour JPEG baseline has independently checked outputs', async ({ page, browser }, testInfo) => {
  const probe = await page.evaluate(probeGeneratedJpeg, { width: 120, height: 80 });
  await publishProbe(testInfo, 'native-four-colour', browser.version(), probe.evidence);
  expectProbeSuccess(probe);
  const result = { ...probe, native: probe.native!, normalized: probe.normalized!, main: probe.main!, thumb: probe.thumb! };
  testInfo.annotations.push({ type: 'synthetic-native-markers', description: JSON.stringify(result.native.markers) });
  expect([result.native.width, result.native.height]).toEqual([120, 80]);
  expect(result.normalized.pixelHash).toBe(result.native.pixelHash);
  for (const image of [result.main, result.thumb]) {
    expectSanitized(image, image === result.main ? 1600 : 320, image === result.main ? 512_000 : 61_440);
    expect([image.width, image.height]).toEqual([120, 80]);
    CORNER_COLOURS.forEach((colour, corner) => colour.forEach((channel, index) => {
      expect(Math.abs(image.corners[corner]![index]! - channel)).toBeLessThan(20);
    }));
  }
  expect(result.hashes).toEqual([result.main.hash, result.thumb.hash]);
});

test('generated JPEG observer retains validated prefix without changing strict failure', async ({ page, browser }, testInfo) => {
  const result = await page.evaluate(async () => {
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { inspectJpegSegments, jpegHeaderFixture } =
      await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const bytes = jpegHeaderFixture();
    const ordinary = inspectJpegSegments(bytes);
    const explicitUndefined = inspectJpegSegments(bytes, undefined);
    const observed: typeof ordinary = [];
    const returned = inspectJpegSegments(bytes, (segment) => {
      observed.push({ ...segment });
      Object.assign(segment, { marker: 0, start: 0, end: 0, kind: 'exif' });
    });
    const prefix: typeof ordinary = [];
    const truncated = bytes.subarray(0, -1);
    const outcomes = [];
    for (const mode of ['default', 'undefined', 'observer'] as const) {
      try {
        if (mode === 'default') inspectJpegSegments(truncated);
        else inspectJpegSegments(truncated, mode === 'undefined' ? undefined : (segment) => { prefix.push({ ...segment }); });
        outcomes.push('unexpected-success');
      } catch (error) {
        outcomes.push(error instanceof Error && error.message === 'fixture truncated marker' ? 'strict-rejection' : 'error');
      }
    }
    const sentinel = new Error();
    let callbackFailure = 'unexpected-success';
    try { inspectJpegSegments(bytes, () => { throw sentinel; }); }
    catch (error) { callbackFailure = error === sentinel ? 'callback-error' : 'error'; }
    return {
      ordinary, explicitUndefined, observed, returned, prefix, outcomes, callbackFailure,
      evidence: {
        scope: 'validated-prefix', outcomes, callbackFailure,
        total: prefix.length, truncated: false,
        records: prefix.map(({ marker, kind, start, end }) => ({ marker, kind, length: end - start })),
      },
    };
  });
  await publishProbe(testInfo, 'generated-truncated-tail', browser.version(), result.evidence);
  expect(result.explicitUndefined).toEqual(result.ordinary);
  expect(result.observed).toEqual(result.ordinary);
  expect(result.returned).toEqual(result.ordinary);
  expect(result.outcomes).toEqual(['strict-rejection', 'strict-rejection', 'strict-rejection']);
  expect(result.prefix).toEqual(result.ordinary.slice(0, -1));
  expect(result.prefix).toHaveLength(2);
  expect(result.callbackFailure).toBe('callback-error');
});

test('fresh generated Exif normalization preserves every retained byte and decoded pixel', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const jpegPath = '/src/images/jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { assertSanitizedJpeg, stripEncoderMetadata } = await import(jpegPath) as typeof import('../../src/images/jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const native = new Uint8Array(await source.arrayBuffer());
    const absent = helpers.exifSegment(1);
    new DataView(absent.buffer).setUint16(20, 0x010e, true);
    const generated = helpers.insertSegments(native, absent, helpers.exifSegment(1), helpers.exifSegment(1, false));
    const segments = helpers.inspectJpegSegments(generated);
    const removed = segments.filter((segment) => segment.kind !== 'other');
    const retained: Uint8Array[] = [];
    let start = 0;
    for (const segment of removed) {
      retained.push(generated.subarray(start, segment.start));
      start = segment.end;
    }
    retained.push(generated.subarray(start));
    const expected = helpers.joinBytes(...retained);
    const result = stripEncoderMetadata(generated);
    const again = stripEncoderMetadata(result);
    assertSanitizedJpeg(result, 120, 80);
    return {
      native: await helpers.summarizeJpeg(source),
      before: await helpers.summarizeJpeg(new Blob([generated], { type: 'image/jpeg' })),
      after: await helpers.summarizeJpeg(new Blob([result], { type: 'image/jpeg' })),
      exact: result.length === expected.length && result.every((byte, index) => byte === expected[index]),
      delta: generated.length - result.length,
      expectedDelta: removed.reduce((size, segment) => size + segment.end - segment.start, 0),
      exifBefore: segments.filter((segment) => segment.kind === 'exif').length,
      exifAfter: helpers.inspectJpegSegments(result).filter((segment) => segment.kind === 'exif').length,
      idempotent: result.length === again.length && result.every((byte, index) => byte === again[index]),
    };
  });
  expect(result.exact).toBe(true);
  expect(result.delta).toBe(result.expectedDelta);
  expect(result.exifBefore).toBeGreaterThanOrEqual(3);
  expect(result.exifAfter).toBe(0);
  expect(result.idempotent).toBe(true);
  expectSanitized(result.after, 1600, 512_000);
  expect([result.after.width, result.after.height]).toEqual([120, 80]);
  expect(result.after.pixelHash).toBe(result.before.pixelHash);
  expect(result.after.pixelHash).toBe(result.native.pixelHash);
});

test('fresh encoder Exif is removed before final bytes are hashed without reencoding', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const native = HTMLCanvasElement.prototype.toBlob;
    const emitted: Uint8Array[] = [];
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      native.call(this, (blob) => {
        if (!blob) { callback(null); return; }
        void blob.arrayBuffer().then((buffer) => {
          const bytes = helpers.insertSegments(new Uint8Array(buffer), helpers.exifSegment(1));
          emitted.push(bytes);
          callback(new Blob([bytes], { type: 'image/jpeg' }));
        });
      }, type, quality);
    };
    try {
      const prepared = await prepareJpeg(source);
      const exact = [];
      for (const [index, blob] of [prepared.main, prepared.thumb].entries()) {
        const before = emitted[index]!;
        const after = new Uint8Array(await blob.arrayBuffer());
        const ranges = helpers.inspectJpegSegments(before).filter((segment) => segment.kind !== 'other');
        const expected = [];
        let start = 0;
        for (const range of ranges) {
          expected.push(before.subarray(start, range.start));
          start = range.end;
        }
        expected.push(before.subarray(start));
        const bytes = helpers.joinBytes(...expected);
        exact.push(bytes.length === after.length && bytes.every((byte, offset) => byte === after[offset]));
      }
      return { exact, calls: emitted.length, main: await helpers.summarizeJpeg(prepared.main),
        thumb: await helpers.summarizeJpeg(prepared.thumb), hashes: [prepared.mainSha256, prepared.thumbSha256] };
    } finally {
      HTMLCanvasElement.prototype.toBlob = native;
    }
  });
  expect(result.calls).toBe(2);
  expect(result.exact).toEqual([true, true]);
  expectSanitized(result.main, 1600, 512_000);
  expectSanitized(result.thumb, 320, 61_440);
  expect(result.hashes).toEqual([result.main.hash, result.thumb.hash]);
});

test('preparation failures expose only allowlisted stage and reason, never exception details', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg, ImagePreparationError } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const native = HTMLCanvasElement.prototype.toBlob;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const results = [];
    for (const stage of ['source', 'decode', 'mainEncode', 'thumbEncode', 'outputCheck', 'hash'] as const) {
      let calls = 0;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        calls += 1;
        if (stage === 'mainEncode' || (stage === 'thumbEncode' && calls === 2)) { callback(null); return; }
        native.call(this, (blob) => {
          if (!blob || stage !== 'outputCheck') { callback(blob); return; }
          void helpers.addPrivateMetadata(blob, 1).then(callback);
        }, type, quality);
      };
      if (stage === 'hash') crypto.subtle.digest = () => Promise.reject(new Error('PRIVATE_EXCEPTION_FIXTURE'));
      try {
        const file = stage === 'source' ? new Blob([helpers.jpegHeaderFixture().subarray(0, -2)])
          : stage === 'decode' ? new Blob([helpers.insertSegments(
            helpers.jpegHeaderFixture(), helpers.jpegSegment(0xdb, new Uint8Array([0xff])),
          )]) : source;
        await prepareJpeg(file);
        results.push({ unexpected: true });
      } catch (error) {
        if (!(error instanceof ImagePreparationError)) throw error;
        results.push({ stage: error.stage, reason: error.code, message: error.message, hasCause: 'cause' in error });
      } finally {
        HTMLCanvasElement.prototype.toBlob = native;
        crypto.subtle.digest = digest;
      }
    }
    return results;
  });
  const expected: import('../../src/images/jpeg').ImagePreparationDetails[] = [
    { stage: 'source', reason: 'invalid' }, { stage: 'decode', reason: 'invalid' },
    { stage: 'mainEncode', reason: 'unavailable' }, { stage: 'thumbEncode', reason: 'unavailable' },
    { stage: 'outputCheck', reason: 'invalid' }, { stage: 'hash', reason: 'invalid' },
  ];
  expect(results).toEqual(expected.map((details) => ({ ...details, message: details.reason, hasCause: false })));
});

test('cancelling main, thumbnail or hash work releases canvases and rejects late results', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const modulePath = '/src/images/process-jpeg.ts';
    const helperPath = '/tests/fixtures/jpeg-helpers.ts';
    const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
    const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
    const source = await helpers.makeCanvasJpeg();
    const nativeEncode = HTMLCanvasElement.prototype.toBlob;
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    const results = [];
    for (const phase of ['mainEncode', 'thumbEncode', 'hash']) {
      const controller = new AbortController();
      const canvases = new Set<HTMLCanvasElement>();
      let notify!: () => void;
      const started = new Promise<void>((resolve) => { notify = resolve; });
      let release!: () => void;
      let calls = 0;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        canvases.add(this);
        calls += 1;
        if ((phase === 'mainEncode' && calls === 1) || (phase === 'thumbEncode' && calls === 2)) {
          release = () => callback(source);
          notify();
        } else nativeEncode.call(this, callback, type, quality);
      };
      if (phase === 'hash') {
        crypto.subtle.digest = () => new Promise<ArrayBuffer>((resolve) => {
          release = () => resolve(new ArrayBuffer(32));
          notify();
        });
      }
      try {
        const pending = prepareJpeg(source, controller.signal).then(
          () => 'unexpected success',
          (error: unknown) => error instanceof DOMException ? error.name : 'unexpected error',
        );
        await started;
        controller.abort();
        const outcome = await pending;
        release();
        await Promise.resolve();
        results.push({ phase, outcome, count: canvases.size,
          released: [...canvases].every((canvas) => canvas.width === 1 && canvas.height === 1) });
      } finally {
        HTMLCanvasElement.prototype.toBlob = nativeEncode;
        crypto.subtle.digest = nativeDigest;
      }
    }
    return results;
  });
  expect(results).toEqual([
    { phase: 'mainEncode', outcome: 'AbortError', count: 1, released: true },
    { phase: 'thumbEncode', outcome: 'AbortError', count: 2, released: true },
    { phase: 'hash', outcome: 'AbortError', count: 2, released: true },
  ]);
});

for (const path of ['bitmap', 'fallback', 'unsupported-bitmap'] as const) {
  for (const littleEndian of [true, false]) {
  test(`all eight EXIF orientations and privacy metadata: ${path}, little-endian=${littleEndian}`, async ({ page }) => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      await test.step(`orientation ${orientation}, little-endian=${littleEndian}`, async () => {
        const result = await page.evaluate(async ({ orientation, path, littleEndian }) => {
          const modulePath = '/src/images/process-jpeg.ts';
          const helperPath = '/tests/fixtures/jpeg-helpers.ts';
          const { prepareJpeg } = await import(modulePath) as typeof import('../../src/images/process-jpeg');
          const helpers = await import(helperPath) as typeof import('../fixtures/jpeg-helpers');
          const jpeg = await helpers.addPrivateMetadata(await helpers.makeCanvasJpeg(), orientation, littleEndian);
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
              exifCount: helpers.inspectJpegSegments(new Uint8Array(await source.arrayBuffer())).filter((segment) => segment.kind === 'exif').length,
            };
          } finally {
            if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
          }
        }, { orientation, path, littleEndian });
        expect(result.exifCount).toBe(1);
        expect(result.inputMarkers.filter((marker) => marker === 0xe1)).toHaveLength(2);
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
}

test('resizes without upscaling, preserving portrait and landscape aspect ratios', async ({ page, browser }, testInfo) => {
  const results = [];
  for (const [width, height, label] of [
    [2400, 1800, 'resize-landscape'], [1800, 2400, 'resize-portrait'],
    [31, 19, 'resize-small'], [1, 97, 'resize-narrow'],
  ] as const) {
    const probe = await page.evaluate(probeGeneratedJpeg, { width, height });
    await publishProbe(testInfo, label, browser.version(), probe.evidence);
    results.push({ input: [width, height], probe });
  }
  for (const { probe } of results) expectProbeSuccess(probe);
  const summaries = results.map(({ input, probe }) => ({
    input, main: probe.main!, thumb: probe.thumb!, reported: probe.reported,
  }));
  for (const { input, main, thumb, reported } of summaries) {
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

test('dense native synthetic pixels meet both budgets without cross-engine reduction assumptions', async ({ page, browser }, testInfo) => {
  const probe = await page.evaluate(probeGeneratedJpeg, { width: 1600, height: 1600, dense: true });
  await publishProbe(testInfo, 'native-dense', browser.version(), probe.evidence);
  expectProbeSuccess(probe);
  const result = { ...probe, main: probe.main!, thumb: probe.thumb! };
  expectSanitized(result.main, 1600, 512_000);
  expectSanitized(result.thumb, 320, 61_440);
  expect(result.main.width).toBeLessThanOrEqual(1600);
  expect(result.main.width).toBeGreaterThanOrEqual(800);
  expect(result.main.width).toBe(result.main.height);
  expect(result.attempts[0]).toEqual({ side: 1600, quality: 0.82 });
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
  expect(results[0]?.attempts.slice(0, 5).map((attempt) => attempt.quality)).toEqual([0.82, 0.75, 0.68, 0.61, 0.55]);
  expect(results[0]?.attempts[5]?.width).toBe(1360);
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
