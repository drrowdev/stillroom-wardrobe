import { expect, test, type Browser, type BrowserContext, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { checkDist, entryAssets } from '../../scripts/check-bundle-budget.mjs';
import { startDistServer, type DistServer } from '../../scripts/serve-dist.mjs';
import { mockBackend, signIn } from '../browser/mock-backend';
import { engineBundle, perfApp } from './global-setup';
import { startupTransfer, type Transfer } from './startup-transfer';

/**
 * Budgets (plan rev2 §3). They change only in a reviewed PR that says why, never per candidate.
 * The network is shaped by the test host, not by CDP: CDP emulation covers only the page target, so service-worker
 * (precache) fetches would bypass it. Every response waits 150 ms and all bodies share one 200,000 B/s link (1.6 Mbit/s).
 */
const network = { bytesPerSecond: 200_000, latencyMs: 150 };
const cpuRate = 4;
const budgets = {
  initialEncodedBytes: 250_000,
  // Coordinator decision on PR #63: the rev1 plan value (≤ 2.5 s). Rev2 had 2.0 s, which left 11% headroom on a slow runner.
  readyMs: 2_500,
  lcpMs: 2_500,
  cls: 0.1,
  engineMs: 200,
  thumbnailsBeforeScroll: 40,
  // 1.25 × the 464 ms baseline in docs/release-checks.md: the slower of two CI runs of the same tree, because
  // ubuntu-latest runner speed alone moved this median from 314 to 464 ms.
  wardrobeTilesMs: 580,
};
const runs = 5;

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };
const results: Record<string, unknown> = { network, cpuRate, runs, budgets };

// `server` is shaped for the sign-in shell; `plain` is unthrottled for the wardrobe and engine CPU measures.
let server: DistServer;
let plain: DistServer;
test.beforeAll(async () => {
  server = await startDistServer({ root: perfApp, throttle: network });
  plain = await startDistServer({ root: perfApp });
  const assets = entryAssets(await readFile(path.join(perfApp, 'index.html'), 'utf8'));
  const initial = (await checkDist(perfApp)).initial.map((file) => `/assets/${file}`);
  expectedInitial = [...new Set(['/', assets.entry, ...assets.preloads, ...initial, ...assets.styles])];
  expect(expectedInitial.length).toBeGreaterThan(3);
});
test.afterAll(async () => {
  await server.close();
  await plain.close();
  const directory = path.join('test-results', 'performance');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
});

function report(info: TestInfo, name: string, value: unknown) {
  results[name] = value;
  console.log(`PERF ${name} ${JSON.stringify(value)}`);
  void info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

// Readiness (the password field visible), LCP and CLS, recorded inside the page from the first byte.
const observe = () => {
  const state = { ready: null as number | null, lcp: 0, cls: 0 };
  (window as unknown as { __perf: typeof state }).__perf = state;
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.lcp = entry.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!entry.hadRecentInput) state.cls += entry.value;
  }).observe({ type: 'layout-shift', buffered: true });
  const check = () => {
    if (state.ready !== null) return;
    const field = document.getElementById('password');
    if (field && field.getClientRects().length && getComputedStyle(field).visibility !== 'hidden') state.ready = performance.now();
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true });
};

// CDP here only observes the page's transfer sizes and throttles its CPU; the network shaping is in the test host.
async function instrument(context: BrowserContext, page: Page): Promise<{ cdp: CDPSession; transfer: Transfer }> {
  const cdp = await context.newCDPSession(page);
  const transfer: Transfer = new Map();
  const urls = new Map<string, string>();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  cdp.on('Network.requestWillBeSent', (event) => { urls.set(event.requestId, event.request.url); });
  cdp.on('Network.loadingFinished', (event) => {
    const url = urls.get(event.requestId);
    if (url) transfer.set(new URL(url).pathname, (transfer.get(new URL(url).pathname) ?? 0) + event.encodedDataLength);
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  return { cdp, transfer };
}

type Sample = { readyMs: number; lcpMs: number; cls: number };
// Opens the app and returns readiness, LCP and CLS once the page has settled. A sample without a finite, positive
// readiness and LCP is a missing measurement and fails here, before anything is aggregated.
async function load(page: Page, url: string, label: string, requireLcp = true): Promise<Sample> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { __perf: { ready: number | null } }).__perf.ready !== null, undefined, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const raw = await page.evaluate(() => (window as unknown as { __perf: Sample & { ready: number; lcp: number } }).__perf);
  expect(Number.isFinite(raw.ready) && raw.ready > 0, `${label}: readiness observed (${raw.ready})`).toBe(true);
  if (requireLcp) expect(Number.isFinite(raw.lcp) && raw.lcp > 0, `${label}: LCP observed (${raw.lcp})`).toBe(true);
  expect(Number.isFinite(raw.cls) && raw.cls >= 0, `${label}: CLS observed (${raw.cls})`).toBe(true);
  return { readyMs: Math.round(raw.ready), lcpMs: Math.round(raw.lcp), cls: Number(raw.cls.toFixed(4)) };
}

async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
}

async function distBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await distBytes(target) : (await stat(target)).size;
  }
  return total;
}

// The first-install page must receive exactly what the build says it loads: the document, the entry script, its
// static imports (from the emitted import graph) and the stylesheets.
let expectedInitial: string[] = [];
const wireMs = (bytes: number) => (bytes / network.bytesPerSecond) * 1000;

type ShellRun = {
  firstInstall: Sample & { pageBytes: number; extraStartupBytes: number; precacheBytes: number; workerFetches: number; slowestWorkerFetch: { pathname: string; bytes: number; ms: number } };
  controlled: Sample & { networkBytes: number };
  offlineReadyMs: number;
};
async function shellRun(browser: Browser, index: number): Promise<ShellRun> {
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(observe);
    // First install: no worker yet, shaped network, throttled CPU, cache disabled.
    const first = await context.newPage();
    const { transfer } = await instrument(context, first);
    const mark = server.requests.length;
    const firstMetrics = await load(first, server.url, `run ${index} first install`);
    // The measurement window ends when the sample is taken; later page transfers are not part of startup.
    const windowTransfer: Transfer = new Map(transfer);
    for (const pathname of expectedInitial) {
      expect(windowTransfer.get(pathname) ?? 0, `run ${index}: ${pathname} transferred to the page`).toBeGreaterThan(0);
    }
    // Compression matches the host: each expected response arrives gzipped, as the bundle budget measures it.
    for (const pathname of expectedInitial) {
      const encoded = windowTransfer.get(pathname)!;
      const gzip = gzipSync(await readFile(path.join(perfApp, pathname === '/' ? 'index.html' : pathname.slice(1)))).length;
      expect(encoded, `${pathname} encoded ${encoded} B vs gzip body ${gzip} B`).toBeGreaterThanOrEqual(gzip);
      expect(encoded, `${pathname} encoded ${encoded} B vs gzip body ${gzip} B`).toBeLessThanOrEqual(gzip + 4_096);
    }
    // The budget total is every page transfer in the window, including dynamic imports and prefetches.
    const startup = startupTransfer(windowTransfer, expectedInitial);
    const pageBytes = startup.total;
    // The shaping really applied to the page: readiness cannot beat the wire time of what it received.
    const lowerBoundMs = wireMs(pageBytes) + 2 * network.latencyMs;
    expect(firstMetrics.readyMs, `run ${index}: readiness ${firstMetrics.readyMs} ms vs wire time ${Math.round(lowerBoundMs)} ms`)
      .toBeGreaterThanOrEqual(lowerBoundMs * 0.9);
    await controlled(first);
    const worker = server.requests.slice(mark).filter((entry) => entry.dest === 'empty');
    const precacheBytes = server.requests.slice(mark).filter((entry) => entry.dest === 'empty' || entry.dest === 'serviceworker')
      .reduce((sum, entry) => sum + entry.bytes, 0);
    // Calibration: worker-originated (precache) transfers are shaped too. Each finished no faster than its latency plus
    // its bytes' wire time, and at least one large one proves the bandwidth limit, not only the latency.
    expect(worker.length, `run ${index}: worker fetches observed`).toBeGreaterThan(0);
    for (const entry of worker) {
      expect(entry.end, `${entry.pathname} finished`).toBeGreaterThan(0);
      expect(entry.end - entry.start, `worker fetch ${entry.pathname} (${entry.bytes} B)`)
        .toBeGreaterThanOrEqual((network.latencyMs + wireMs(entry.bytes)) * 0.9);
    }
    const slowest = worker.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    expect(slowest.bytes, 'a large worker fetch calibrates the bandwidth').toBeGreaterThanOrEqual(32_768);
    await first.close();

    // Controlled: a second visit served by the worker, same shaping.
    const second = await context.newPage();
    await instrument(context, second);
    const secondMark = server.requests.length;
    const secondMetrics = await load(second, server.url, `run ${index} controlled`);
    expect(await second.evaluate(() => Boolean(navigator.serviceWorker.controller)), `run ${index}: controlled`).toBe(true);
    const networkBytes = server.requests.slice(secondMark).filter((entry) => entry.dest !== 'serviceworker').reduce((sum, entry) => sum + entry.bytes, 0);
    await second.close();

    // Offline reopen: readiness only.
    await context.setOffline(true);
    const third = await context.newPage();
    await instrument(context, third);
    const offline = await load(third, server.url, `run ${index} offline`, false);
    await context.setOffline(false);
    return {
      firstInstall: { ...firstMetrics, pageBytes, extraStartupBytes: pageBytes - startup.expected, precacheBytes, workerFetches: worker.length,
        slowestWorkerFetch: { pathname: slowest.pathname, bytes: slowest.bytes, ms: Math.round(slowest.end - slowest.start) } },
      controlled: { ...secondMetrics, networkBytes },
      offlineReadyMs: offline.readyMs,
    };
  } finally {
    await context.close();
  }
}
test('bundle budgets hold for the measured build', async ({ browserName }, info) => {
  expect(browserName).toBe('chromium');
  const bundle = await checkDist(perfApp);
  report(info, 'bundle', { initialJsGzip: bundle.initialJsGzip, initial: bundle.initial, largestLazyGzip: Math.max(...bundle.report.filter((row) => row.kind === 'lazy').map((row) => row.gzip)) });
  expect(bundle.violations).toEqual([]);
});

test('sign-in shell: first install, worker-controlled and offline reopen stay within budget', async ({ browser }, info) => {
  const all: ShellRun[] = [];
  for (let index = 0; index < runs; index++) all.push(await shellRun(browser, index));
  const whole = await distBytes(perfApp);
  const summary = {
    firstInstall: {
      readyMs: median(all.map((run) => run.firstInstall.readyMs)), lcpMs: median(all.map((run) => run.firstInstall.lcpMs)),
      clsMax: Math.max(...all.map((run) => run.firstInstall.cls)), pageBytes: median(all.map((run) => run.firstInstall.pageBytes)),
      precacheBytes: median(all.map((run) => run.firstInstall.precacheBytes)), distBytes: whole,
    },
    controlled: {
      readyMs: median(all.map((run) => run.controlled.readyMs)), lcpMs: median(all.map((run) => run.controlled.lcpMs)),
      clsMax: Math.max(...all.map((run) => run.controlled.cls)), networkBytes: median(all.map((run) => run.controlled.networkBytes)),
    },
    offlineReadyMs: median(all.map((run) => run.offlineReadyMs)),
    runs: all,
  };
  report(info, 'shell', summary);
  expect(summary.firstInstall.pageBytes, 'initial encoded transfer').toBeLessThanOrEqual(budgets.initialEncodedBytes);
  expect(summary.firstInstall.readyMs, 'first-install readiness').toBeLessThanOrEqual(budgets.readyMs);
  expect(summary.firstInstall.lcpMs, 'first-install LCP').toBeLessThanOrEqual(budgets.lcpMs);
  expect(summary.firstInstall.lcpMs, 'LCP was observed').toBeGreaterThan(0);
  expect(summary.firstInstall.clsMax, 'first-install CLS').toBeLessThanOrEqual(budgets.cls);
  // Precache traffic is reported; its only limit is the whole servable build.
  expect(summary.firstInstall.precacheBytes, 'precache traffic was observed').toBeGreaterThan(0);
  expect(summary.firstInstall.precacheBytes).toBeLessThanOrEqual(whole);
  expect(summary.controlled.readyMs, 'controlled readiness').toBeLessThanOrEqual(budgets.readyMs);
  expect(summary.controlled.lcpMs, 'controlled LCP').toBeLessThanOrEqual(budgets.lcpMs);
  expect(summary.controlled.clsMax, 'controlled CLS').toBeLessThanOrEqual(budgets.cls);
  expect(summary.controlled.networkBytes, 'the controlled shell comes from the worker cache').toBe(0);
  expect(summary.offlineReadyMs, 'offline readiness').toBeLessThanOrEqual(budgets.readyMs);
});

test('wardrobe at 500 owned items: first 40 tiles and at most 40 thumbnail requests before scrolling', async ({ browser }, info) => {
  const all: Array<{ tilesMs: number; firstPhotoMs: number; thumbnails: number }> = [];
  for (let index = 0; index < runs; index++) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      const api = await mockBackend(page, { initialLanguage: 'en' });
      for (let n = 0; n < 500; n++) api.seedSavedItem('a', `Owned ${String(n).padStart(3, '0')}`);
      let thumbnails = 0;
      page.on('request', (request) => { if (request.url().endsWith('/thumb.jpg')) thumbnails++; });
      await page.goto(plain.url);
      await expect(page.locator('#password')).toBeVisible();
      await instrument(context, page);
      const start = await page.evaluate(() => performance.now());
      await signIn(page);
      const tilesAt = await (await page.waitForFunction(() => document.querySelectorAll('.item-card').length >= 40 && performance.now(), undefined,
        { polling: 'raf', timeout: 60_000 })).jsonValue() as number;
      const photoAt = await (await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('.item-photo img');
        return Boolean(image?.complete && image.naturalWidth > 0) && performance.now();
      }, undefined, { polling: 'raf', timeout: 60_000 })).jsonValue() as number;
      await expect(page.locator('.item-card')).toHaveCount(40);
      await page.waitForTimeout(500);
      expect(thumbnails, `run ${index}: thumbnails requested`).toBeGreaterThan(0);
      all.push({ tilesMs: Math.round(tilesAt - start), firstPhotoMs: Math.round(photoAt - start), thumbnails });
    } finally {
      await context.close();
    }
  }
  const summary = { tilesMs: median(all.map((run) => run.tilesMs)), firstPhotoMs: median(all.map((run) => run.firstPhotoMs)),
    thumbnailsMax: Math.max(...all.map((run) => run.thumbnails)), runs: all };
  report(info, 'wardrobe', summary);
  expect(summary.thumbnailsMax).toBeLessThanOrEqual(budgets.thumbnailsBeforeScroll);
  expect(summary.tilesMs, 'time to the first 40 tiles').toBeLessThanOrEqual(budgets.wardrobeTilesMs);
});

test('the recommendation engine over 500 items stays under 200 ms per call at 4x CPU (a CI proxy for the phone gate)', async ({ browser }, info) => {
  const code = await readFile(engineBundle, 'utf8');
  const all: Array<{ firstMs: number; maxMs: number; slowest: string }> = [];
  for (let index = 0; index < runs; index++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent('<!doctype html><html lang="en"><title>engine</title></html>');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
      await page.addScriptTag({ content: code });
      const run = await page.evaluate(() => (window as unknown as { StillroomEngine: { timeAll(): { items: number; timings: Array<{ context: string; ms: number }> } } })
        .StillroomEngine.timeAll());
      expect(run.items).toBe(500);
      expect(run.timings.length).toBeGreaterThanOrEqual(23);
      const slowest = run.timings.reduce((a, b) => (b.ms > a.ms ? b : a));
      all.push({ firstMs: Math.round(run.timings[0]!.ms), maxMs: Math.round(slowest.ms), slowest: slowest.context });
    } finally {
      await context.close();
    }
  }
  const summary = { maxMs: median(all.map((run) => run.maxMs)), firstMs: median(all.map((run) => run.firstMs)), runs: all };
  report(info, 'engine', summary);
  expect(summary.maxMs, 'slowest context, median of runs').toBeLessThan(budgets.engineMs);
});
