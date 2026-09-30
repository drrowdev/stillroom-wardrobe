import { expect, test, type Page } from '@playwright/test';

// BG2c-3 (plan rev8b §2): the clean-up check runs in a module worker, so the page stays responsive. On the posed
// synthetic fixture (identity fails, so both the identity and the aligned pass run) this asserts the total time
// unthrottled, the largest gap between MessageChannel ticks on the main thread while the check runs (Chromium x1 and
// x4), and that Skip or the timeout (an abort) terminates the worker and rejects at once. x4 totals are not asserted:
// CDP CPU throttling does not reach dedicated workers, so they are extrapolated as 4 x unthrottled (2.7-4.4 s). On
// WebKit only completion and abort are asserted: headless WebKit's MessageChannel ticks at about 33 Hz even on an idle
// page, so it can't measure main-thread gaps. The first check warms the worker module up in the dev server and is
// reported, not asserted. It runs only in the isolated cleanup-timing projects (one worker, serial, no retries). The
// fixture is generated in the page; no image leaves it. Real-device timing is pending (O13).
const TOTAL_MS = 1500;
const GAP_MS = 50;
const RUNS = 3;

type Run = { total: number; gap: number; ticks: number; accepted: boolean; path: string | undefined };
type Timing = { warmUp: Run; runs: Run[]; probed: Run[]; abortName: string; abortMs: number; afterAbort: boolean };

async function measure(page: Page, runs: number): Promise<Timing> {
  return page.evaluate(async ([count]) => {
    const modulePath = '/src/features/wardrobe/enhancement-runtime.ts';
    const { cleanupCheck } = await import(modulePath) as typeof import('../../src/features/wardrobe/enhancement-runtime');
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


    const input = () => [h0.slice(), reference, h2.slice()] as const;
    // Main-thread probe: a MessageChannel ping-pong records the largest gap between ticks while the check runs. The probe
    // keeps a core busy, so totals are measured on separate runs without it.
    const run = async (probe: boolean) => {
      const channel = new MessageChannel();
      let gap = 0, ticks = 0, last = performance.now(), running = true;
      channel.port1.onmessage = () => {
        const now = performance.now();
        gap = Math.max(gap, now - last); last = now; ticks++;
        if (running) channel.port2.postMessage(0);
      };
      if (probe) channel.port2.postMessage(0);
      const started = performance.now();
      const [a, r, b] = input();
      const verdict = await cleanupCheck(a, r, b, { signal: new AbortController().signal });
      const total = performance.now() - started;
      running = false;
      gap = Math.max(gap, performance.now() - last);
      channel.port1.close();
      return { total, gap: probe ? gap : Number.NaN, ticks, accepted: verdict.accepted, path: verdict.metrics.path };
    };
    const warmUp = await run(false);
    const results = [], probed = [];
    for (let i = 0; i < count; i++) results.push(await run(false));
    for (let i = 0; i < count; i++) probed.push(await run(true));

    // Skip or the timeout mid-check: the worker is terminated and the check rejects with the signal's reason at once.
    const controller = new AbortController();
    const [a, r, b] = input();
    const pending = cleanupCheck(a, r, b, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const abortedAt = performance.now();
    controller.abort(new DOMException('Skipped', 'AbortError'));
    let abortName = 'resolved';
    try { await pending; } catch (error) { abortName = (error as Error).name; }
    const abortMs = performance.now() - abortedAt;
    const [c, d, e] = input();
    const afterAbort = (await cleanupCheck(c, d, e, { signal: new AbortController().signal })).metrics.path !== undefined;
    return { warmUp, runs: results, probed, abortName, abortMs, afterAbort };
  }, [runs] as const);
}

function report(label: string, timing: Timing) {
  const round = (run: Run) => ({ ...run, total: Math.round(run.total), gap: Math.round(run.gap) });
  const summary = JSON.stringify({ ...timing, warmUp: round(timing.warmUp), runs: timing.runs.map(round), probed: timing.probed.map(round), abortMs: Math.round(timing.abortMs) });
  console.log(`cleanup-timing ${label}: ${summary}`);
  test.info().annotations.push({ type: 'cleanup-timing', description: `${label}: ${summary}` });
}

function expectCompleted(timing: Timing) {
  for (const run of [timing.warmUp, ...timing.runs, ...timing.probed]) expect(run.path).toBe('aligned');
  expect(timing.abortName).toBe('AbortError');
  expect(timing.abortMs).toBeLessThanOrEqual(GAP_MS);
  expect(timing.afterAbort).toBe(true);
}

test.describe('clean-up check timing in the worker (rev8b §2)', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('Chromium unthrottled: total and main-thread gaps', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Main-thread gaps are measured on Chromium only.');
    const timing = await measure(page, RUNS);
    report('chromium x1', timing);
    expectCompleted(timing);
    for (const run of timing.runs) expect(run.total).toBeLessThanOrEqual(TOTAL_MS);
    for (const run of timing.probed) expect(run.gap).toBeLessThanOrEqual(GAP_MS);
  });

  test('Chromium x4 throttled: main-thread gaps (totals are extrapolated, not asserted)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP CPU throttling is Chromium-only.');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const timing = await measure(page, RUNS);
    report('chromium x4', timing);
    expectCompleted(timing);
    for (const run of timing.probed) expect(run.gap).toBeLessThanOrEqual(GAP_MS);
  });

  test('WebKit unthrottled: total, completion and abort', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'The WebKit run covers completion and abort.');
    const timing = await measure(page, RUNS);
    report('webkit x1', timing);
    expectCompleted(timing);
    for (const run of timing.runs) expect(run.total).toBeLessThanOrEqual(TOTAL_MS);
  });
});
