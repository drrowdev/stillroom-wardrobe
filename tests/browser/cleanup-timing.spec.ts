import { expect, test, type Page } from '@playwright/test';

// BG2c-3 (plan rev8 §3.7, §3.8): the cooperative clean-up check stays responsive on the worst-case synthetic fixture.
// Each run asserts the total time, the largest uninterrupted slice between yields, and that an abort after the first
// yield rejects within one slice. The fixture is generated in the page; no image leaves it. Real-device timing is
// pending (O13).
const TOTAL_MS = 1500;
const SLICE_MS = 50;

type Timing = { kind: string; total: number; slice: number; yields: number; accepted: boolean; abortMs: number; abortName: string };

async function measure(page: Page, removeSchedulerYield: boolean): Promise<Timing> {
  return page.evaluate(async ([removeYield]) => {
    const modulePath = '/src/images/fidelity.ts';
    const { cleanupCheck, cleanupYield } = await import(modulePath) as typeof import('../../src/images/fidelity');
    if (removeYield) {
      const proto = (globalThis as { Scheduler?: { prototype: { yield?: unknown } } }).Scheduler?.prototype;
      if (proto) delete proto.yield;
    }
    const W = 256, H = 320, N = W * H;
    // Worst case: a textured two-hue striped garment with creases on seeded clutter, and a result that is posed
    // (x1.05, shifted) on the plain background, so every stage runs to the end.
    let seed = 20260929;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const garment = (x: number, y: number) => x >= 60 && x < 196 && y >= 70 && y < 250;
    const stripe = (x: number, y: number): [number, number, number] => {
      const base: [number, number, number] = ((x - 60) % 16) < 8 ? [170, 50, 60] : [40, 140, 150];
      const crease = y >= 72 && y < 248 && ((x - 60) % 12) < 3 ? 0.55 : 1;
      return [base[0] * crease, base[1] * crease, base[2] * crease];
    };
    const h0 = new Uint8ClampedArray(N * 4), h2 = new Uint8ClampedArray(N * 4), reference = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const at = (y * W + x) * 4, index = y * W + x;
      const ring = x < 4 || y < 4 || x >= W - 4 || y >= H - 4;
      const clutter: [number, number, number] = ring ? [0xf6, 0xf3, 0xed] : [120 + 100 * random(), 110 + 100 * random(), 100 + 100 * random()];
      const c0 = garment(x, y) ? stripe(x, y) : clutter;
      h0[at] = c0[0]; h0[at + 1] = c0[1]; h0[at + 2] = c0[2]; h0[at + 3] = 255;
      reference[index] = garment(x, y) ? 1 : 0;
      const sx = Math.floor(128 + (x + 0.5 - 128 - 6) / 1.05), sy = Math.floor(160 + (y + 0.5 - 160 - 4) / 1.05);
      const c2 = garment(sx, sy) ? stripe(sx, 72) : [0xf6, 0xf3, 0xed];
      h2[at] = c2[0]!; h2[at + 1] = c2[1]!; h2[at + 2] = c2[2]!; h2[at + 3] = 255;
    }

    const primitive = cleanupYield();
    let slice = 0, yields = 0, sliceStart = 0;
    const yieldNow = async () => {
      slice = Math.max(slice, performance.now() - sliceStart);
      yields++;
      await primitive.run();
      sliceStart = performance.now();
    };
    sliceStart = performance.now();
    const started = sliceStart;
    const verdict = await cleanupCheck(h0, reference, h2, { yieldNow });
    slice = Math.max(slice, performance.now() - sliceStart);
    const total = performance.now() - started;

    // Abort right after the first yield: the check must reject within one slice.
    const controller = new AbortController();
    let abortedAt = 0;
    const abortingYield = async () => {
      await primitive.run();
      if (!abortedAt) { abortedAt = performance.now(); controller.abort(); }
    };
    let abortName = 'resolved';
    try { await cleanupCheck(h0, reference, h2, { signal: controller.signal, yieldNow: abortingYield }); } catch (error) { abortName = (error as Error).name; }
    const abortMs = performance.now() - abortedAt;
    return { kind: primitive.kind, total, slice, yields, accepted: verdict.accepted, abortMs, abortName } satisfies Timing;
  }, [removeSchedulerYield] as const);
}

function report(label: string, timing: Timing) {
  console.log(`cleanup-timing ${label}: ${JSON.stringify(timing)}`);
  test.info().annotations.push({ type: 'cleanup-timing', description: `${label}: ${JSON.stringify({ ...timing,
    total: Math.round(timing.total), slice: Math.round(timing.slice), abortMs: Math.round(timing.abortMs) })}` });
}

function expectBudget(timing: Timing, kind: string) {
  expect(timing.kind).toBe(kind);
  expect(timing.yields).toBeGreaterThan(0);
  expect(timing.total).toBeLessThanOrEqual(TOTAL_MS);
  expect(timing.slice).toBeLessThanOrEqual(SLICE_MS);
  expect(timing.abortName).toBe('AbortError');
  expect(timing.abortMs).toBeLessThanOrEqual(SLICE_MS);
}

test.describe('clean-up check timing (§3.7)', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('Chromium x4 throttled, on the scheduler.yield and the MessageChannel paths', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium' || test.info().project.name !== 'chromium', 'CDP CPU throttling is Chromium-only; WebKit runs unthrottled below.');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const scheduler = await measure(page, false);
    report('chromium x4 scheduler.yield', scheduler);
    expectBudget(scheduler, 'scheduler');
    const channel = await measure(page, true);
    report('chromium x4 MessageChannel', channel);
    expectBudget(channel, 'channel');
  });

  test('WebKit unthrottled, on the MessageChannel path', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'The WebKit run covers the MessageChannel path without scheduler.yield.');
    const timing = await measure(page, false);
    report('webkit MessageChannel', timing);
    expectBudget(timing, 'channel');
  });
});
