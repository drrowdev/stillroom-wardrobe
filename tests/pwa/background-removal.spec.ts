import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { messages } from '../../src/i18n';
import { modelAssets, modelCacheName } from '../../src/images/background/model-assets';
import { checkDeployedAssets } from '../../scripts/check-deployed-assets.mjs';
import { startDistServer } from '../../scripts/serve-dist.mjs';
import { aiFixture } from '../browser/ai-photo-first-support';
import { observeEgress, segmentationProblems, type Traffic } from '../browser/background-egress';
import { signIn } from '../browser/mock-backend';
import { builds } from './builds';
import { controlled, expectOnlyShell, serve, type DistServer } from './helpers';

// Background removal in the production build (ADR24, BG1): the real emitted model and runtime, the generated
// headers, the service worker and Cache Storage. Assertions are text: request paths, byte counts, digests and
// sampled pixel values. Removal is always on in production; there is no test hook in this bundle.
const FILL = [246, 243, 237];
const GREY = [217, 217, 217];
const modelPaths = modelAssets.map((file) => file.path).sort();
// Byte counts come from the server; the egress classification (every request in the browser context, including
// the service worker's) comes from background-egress.ts.
const modelRequests = (server: DistServer) => server.requests.filter((entry) => entry.pathname.startsWith('/models/') || /\.(?:onnx|wasm)$/.test(entry.pathname));
function expectApprovedEgress(traffic: Traffic, server: DistServer, analyses: number) {
  expect(traffic.unexpected).toEqual([]);
  expect(segmentationProblems(traffic)).toEqual([]);
  expect([...new Set(traffic.segmentation.map((entry) => entry.pathname))].sort()).toEqual(modelPaths);
  expect(traffic.tagging.map((entry) => entry.method)).toEqual(Array.from({ length: analyses }, () => 'POST'));
  expect(server.requests.filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD')).toEqual([]);
}

async function shirt(page: Page): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 800 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d9d9d9'; context.fillRect(0, 0, 640, 800);
    context.fillStyle = '#1f3a93';
    context.beginPath();
    for (const [x, y] of [[230, 140], [410, 140], [560, 250], [500, 330], [450, 290], [450, 680], [190, 680], [190, 290], [140, 330], [80, 250]]) context.lineTo(x!, y!);
    context.closePath(); context.fill();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
}
async function choose(page: Page, bytes: Buffer) {
  await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: bytes });
}
// The corner of the prepared photo, read from its decoded pixels (the production CSP does not allow fetching the
// Blob URL, so the loaded image element is drawn instead).
function corner(page: Page) {
  return page.locator('.capture-photo img').evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: image.naturalWidth, height: image.naturalHeight });
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(4, 4, 1, 1).data.slice(0, 3)];
  });
}
const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]!) <= 12);
// The fixture upload receiver answers CORS for the app origin named by PLAYWRIGHT_PORT; point it at this server.
function fixture(page: Page, target: DistServer) {
  process.env.PLAYWRIGHT_PORT = new URL(target.url).port;
  return aiFixture(page, 'en', true, undefined, false, undefined, target.url);
}
async function openAdd(page: Page) {
  await page.getByRole('button', { name: messages['wardrobe.add'].en, exact: true }).first().click();
  await expect(page.locator('.background-note')).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  const discard = page.getByRole('button', { name: messages['common.discard'].en, exact: true });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await expect(page.locator('#email')).toBeVisible();
}

test.describe('production background removal', () => {
  let server: DistServer;
  const port = process.env.PLAYWRIGHT_PORT;
  test.afterEach(async () => {
    await server?.close();
    if (port === undefined) delete process.env.PLAYWRIGHT_PORT; else process.env.PLAYWRIGHT_PORT = port;
  });

  test('offline, a cached model still removes the background', async ({ page, context }) => {
    test.setTimeout(120_000);
    server = await serve('a');
    await fixture(page, server);
    await controlled(page);
    await openAdd(page);
    const photo = await shirt(page);
    await choose(page, photo);
    await expect(page.locator('.capture-photo img')).toBeVisible({ timeout: 60_000 });
    expect(near(await corner(page), FILL)).toBe(true);
    await signOut(page);
    // A new page load: nothing is held in memory, so the bytes must come from Cache Storage.
    await page.reload();
    const before = modelRequests(server).length;
    // Another owner (the fixture issues one token per owner); the route may reopen Add item.
    await signIn(page, 'b');
    await expect(page.locator('#wardrobe-title, #capture-title').first()).toBeVisible();
    if (await page.locator('#wardrobe-title').isVisible()) await page.getByRole('button', { name: messages['wardrobe.add'].sv, exact: true }).first().click();
    await expect(page.locator('.background-note')).toBeVisible();
    await context.setOffline(true);
    await choose(page, photo);
    await expect(page.locator('.capture-photo img')).toBeVisible({ timeout: 60_000 });
    expect(near(await corner(page), FILL)).toBe(true);
    expect(modelRequests(server)).toHaveLength(before);
    await context.setOffline(false);
  });

  // These three run full model inference in their own browsers. On two CI workers they competed for CPU: the inventory
  // test overran its limit (run 36324111399), and the throttled download, running beside the other two, took the whole
  // 3 min instead of about 45 s (runs 36351156967 attempts 1 and 2, passing alone on retry in 37 s). So they run one
  // after the other in one worker. 'default' rather than 'serial' mode: a failure does not skip the others, and a retry
  // reruns only the test that failed.
  test.describe('full inference, one at a time', () => {
    test.describe.configure({ mode: 'default' });

    test('a throttled first download falls back for that photo, then serves the next photo without a new download', async ({ page }) => {
      test.setTimeout(180_000);
      // About 31 s for the ~19 MB of binaries: longer than the 25 s a photo waits.
      server = await startDistServer({ root: builds.a, throttle: { bytesPerSecond: 600_000 } });
      const began = performance.now();
      const phase = (name: string) => { console.log(`throttled download: ${name} after ${Math.round(performance.now() - began)} ms`); };
      const egress = await observeEgress(page.context(), server.url);
      const api = await fixture(page, server);
      await controlled(page);
      await openAdd(page);
      const photo = await shirt(page);
      await choose(page, photo);
      await expect(page.locator('.capture-photo img')).toBeVisible({ timeout: 60_000 });
      expect(near(await corner(page), GREY)).toBe(true);
      phase('fallback shown');
      await expect.poll(() => api.inputs.length).toBe(1);
      // The download continues in the background and is verified into the model cache.
      await expect.poll(() => page.evaluate(async (name) => (await (await caches.open(name)).keys()).length, modelCacheName), { timeout: 90_000 }).toBe(2);
      phase('model cached');
      const downloaded = modelRequests(server).length;
      expect(modelRequests(server).map((entry) => entry.pathname).sort()).toEqual(modelPaths);

      await choose(page, photo);
      await expect.poll(async () => near(await corner(page), FILL), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => api.inputs.length).toBe(2);
      phase('second photo removed');
      expect(modelRequests(server)).toHaveLength(downloaded);
      expectApprovedEgress(await egress.read(), server, 2);
      const total = modelRequests(server).reduce((sum, entry) => sum + entry.bytes, 0);
      expect(total).toBe(modelAssets.reduce((sum, file) => sum + file.bytes, 0));
    });

    test('the build serves the exact inventory, nothing loads before a photo, and logout keeps only the shell and verified model caches', async ({ page }) => {
      test.setTimeout(120_000);
      server = await serve('a');
      // Receipt check against the production server: exact bytes, digests and headers, no redirects.
      // The script accepts only an https origin; its requests are sent to the local production server.
      const deployed = await checkDeployedAssets('https://pages.example.test', modelAssets,
        (url, init) => fetch(new URL(url.pathname, server.url), init));
      expect(deployed.map((entry) => ({ path: entry.path, status: entry.status, problems: entry.problems }))).toEqual(
        modelAssets.map((file) => ({ path: file.path, status: 200, problems: [] })));
      for (const file of modelAssets) {
        const response = await fetch(`${server.url}${file.path}`, { redirect: 'manual' });
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
        expect(response.headers.get('cache-control'), file.path).toMatch(/\bimmutable\b/);
        expect(response.headers.get('x-content-type-options'), file.path).toBe('nosniff');
        if (file.path.endsWith('.wasm')) expect(response.headers.get('content-type')).toBe('application/wasm');
      }
      server.requests.length = 0;

      const egress = await observeEgress(page.context(), server.url);
      const api = await fixture(page, server);
      expect(await controlled(page)).toHaveLength(1);
      await openAdd(page);
      expect(modelRequests(server)).toEqual([]);
      expect(await page.evaluate((name) => caches.has(name), modelCacheName)).toBe(false);

      await choose(page, await shirt(page));
      await expect(page.locator('.capture-photo img')).toBeVisible({ timeout: 60_000 });
      expect(near(await corner(page), FILL)).toBe(true);
      await expect.poll(() => api.inputs.length).toBe(1);
      // Each binary is fetched once, directly from the network (the worker never serves or stores it).
      expect(modelRequests(server).map((entry) => entry.pathname).sort()).toEqual(modelPaths);
      expect(modelRequests(server).every((entry) => entry.bytes === modelAssets.find((file) => file.path === entry.pathname)!.bytes)).toBe(true);
      expectApprovedEgress(await egress.read(), server, 1);

      await signOut(page);
      await expectOnlyShell(page, 'a', ['user-a@example.test', 'fictional-test-password'], true);
    });

    test('a corrupted cached model is replaced by a verified download', async ({ page }) => {
      test.setTimeout(120_000);
      server = await serve('a');
      await fixture(page, server);
      await controlled(page);
      const model = modelAssets.find((file) => file.role === 'model')!;
      await page.evaluate(async ({ name, path }) => {
        await (await caches.open(name)).put(path, new Response(new Uint8Array(16), { headers: { 'content-type': 'application/octet-stream' } }));
      }, { name: modelCacheName, path: model.path });
      await openAdd(page);
      await choose(page, await shirt(page));
      await expect(page.locator('.capture-photo img')).toBeVisible({ timeout: 60_000 });
      expect(near(await corner(page), FILL)).toBe(true);
      expect(modelRequests(server).map((entry) => entry.pathname).sort()).toEqual(modelPaths);
      await signOut(page);
      await expectOnlyShell(page, 'a', [], true);
    });
  });
});
