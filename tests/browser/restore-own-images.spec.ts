// The Node restore's photo page (scripts/restore-image-page.mjs): it can reach nothing on the network, its bundle carries
// no environment, and its photo steps give the same results as the same steps in the app. Chromium only: the page is
// always the locked Playwright Chromium.
import { createServer, type Server } from 'node:http';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser } from '@playwright/test';
import { buildImageBundle, launchImageBrowser, openImagePage, PAGE_URL, SCRIPT_URL } from '../../scripts/restore-image-page.mjs';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';

test.skip(() => test.info().project.name !== 'chromium', 'The restore CLI runs photo steps in Chromium only.');
test.describe.configure({ mode: 'serial' });

const appJpeg = readFileSync(fileURLToPath(new URL('../security/fixture.jpg', import.meta.url))).toString('base64');
const progressive = Buffer.from(flatJpeg({ width: 24, height: 16, colour: [90, 110, 150], mode: 'progressive' })).toString('base64');
const canary = 'stillroom-env-canary-7f3a';
const envFile = fileURLToPath(new URL('../../.env.production.local', import.meta.url));

let code = '';
let browser: Browser | undefined;
test.beforeAll(async () => {
  // An ambient env file and variable must not reach the bundle. Written only if absent, and always removed.
  const wrote = !existsSync(envFile);
  if (wrote) writeFileSync(envFile, `VITE_SUPABASE_URL=${canary}\nVITE_CANARY=${canary}\n`);
  process.env.VITE_CANARY = canary;
  try { code = await buildImageBundle(); } finally {
    delete process.env.VITE_CANARY;
    if (wrote) rmSync(envFile, { force: true });
  }
  browser = await launchImageBrowser();
});
test.afterAll(async () => { await browser?.close(); });

test('the bundle carries no environment, configuration or app code', () => {
  expect(code.length).toBeGreaterThan(1000);
  for (const text of [canary, 'import.meta.env', 'VITE_', 'supabase', 'localStorage', 'indexedDB', 'fetch(']) expect(code).not.toContain(text);
});

test('the page reaches nothing: direct-address HTTP, WebSocket, image and navigation attempts never arrive', async () => {
  const connections: string[] = [];
  const server: Server = createServer((request, response) => { connections.push(`http ${request.url}`); response.end('x'); });
  server.on('connection', () => connections.push('tcp'));
  server.on('upgrade', (request, socket) => { connections.push(`ws ${request.url}`); socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const requests: string[] = [];
  const { context, page } = await openImagePage(browser!, code, { onRequest: ({ url, method }: { url: string; method: string }) => requests.push(`${method} ${url}`) });
  try {
    const attempts = await page.evaluate(async (target) => {
      const results: string[] = [];
      try { await fetch(`http://${target}/fetch`); results.push('fetch reached'); } catch { results.push('fetch blocked'); }
      try { await fetch(`http://${target}/beacon`, { method: 'POST', body: 'x', mode: 'no-cors' }); results.push('post reached'); } catch { results.push('post blocked'); }
      results.push(await new Promise<string>((resolve) => {
        try {
          const socket = new WebSocket(`ws://${target}/socket`);
          socket.onopen = () => resolve('socket reached');
          socket.onerror = () => resolve('socket blocked');
          setTimeout(() => resolve('socket blocked'), 2000);
        } catch { resolve('socket blocked'); }
      }));
      results.push(await new Promise<string>((resolve) => {
        const image = new Image();
        image.onload = () => resolve('image reached');
        image.onerror = () => resolve('image blocked');
        image.src = `http://${target}/image.png`;
        setTimeout(() => resolve('image blocked'), 2000);
      }));
      navigator.sendBeacon?.(`http://${target}/send-beacon`, 'x');
      return results;
    }, `127.0.0.1:${port}`);
    expect(attempts).toEqual(['fetch blocked', 'post blocked', 'socket blocked', 'image blocked']);
    await page.goto(`http://127.0.0.1:${port}/navigate`).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(connections).toEqual([]);
    expect(requests.slice(0, 2)).toEqual([`GET ${PAGE_URL}`, `GET ${SCRIPT_URL}`]);
    expect(requests.slice(2).every(request => !request.endsWith(PAGE_URL) && !request.endsWith(SCRIPT_URL))).toBe(true);
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('the photo steps give the same bytes as the same steps in the app, for a kept and a re-encoded photo', async ({ page }) => {
  const isolated = await openImagePage(browser!, code);
  try {
    await page.goto('/');
    await page.evaluate(async (entry) => { await import(entry); }, '/src/images/restore-worker-entry.ts');
    const steps = async (call: (name: string, ...args: unknown[]) => Promise<unknown>) => ({
      kept: await call('decodedSize', appJpeg),
      keptThumb: await call('thumbnail', appJpeg, 2, 2),
      encoded: await call('reencode', progressive),
      refused: await call('decodedSize', Buffer.from('not a jpeg').toString('base64')),
    });
    const inApp = await steps((name, ...args) => page.evaluate(([step, values]) =>
      (globalThis as unknown as { stillroomRestoreImages: Record<string, (...a: unknown[]) => Promise<unknown>> }).stillroomRestoreImages[step as string]!(...(values as unknown[])),
    [name, args] as const));
    const inCli = await steps(isolated.call);
    expect(inCli).toEqual(inApp);
    expect(inCli.kept).toEqual({ ok: true, value: { width: 2, height: 2 } });
    expect(inCli.encoded).toMatchObject({ ok: true, value: { width: 24, height: 16 } });
    expect(inCli.refused).toMatchObject({ ok: false });
  } finally { await isolated.context.close(); }
});

// A real Chromium renderer that stops answering: the step times out, the worker is killed, and no process of that
// Chromium outlives it. Linux only, where the processes can be read from /proc and a renderer can be stopped.
const running = (pid: number) => { try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; } };

test('a hung Chromium step stops the worker and every Chromium process it started', async () => {
  test.skip(process.platform !== 'linux', 'Stops a real renderer and reads /proc: Linux only (CI).');
  test.setTimeout(90_000);
  const { startImageWorker } = await import('../../scripts/restore-image-client.mjs');
  let workerPid = 0;
  const worker = await startImageWorker({
    callTimeout: 5_000, closeTimeout: 5_000,
    fork: ((...args: Parameters<typeof fork>) => { const child = fork(...args); workerPid = child.pid ?? 0; return child; }) as typeof fork,
  });
  let tree: number[] = [];
  try {
    const { descendantsOf, hasFlag } = await import('../../scripts/ci-chromium-sandbox.mjs');
    const found = descendantsOf(workerPid);
    tree = found.map(entry => entry.pid);
    expect(found.some(entry => hasFlag(entry.command, '--no-sandbox'))).toBe(false);
    const renderers = found.filter(entry => hasFlag(entry.command, '--type=renderer')).map(entry => entry.pid);
    expect(renderers.length).toBeGreaterThan(0);
    // The renderer runs under Chromium's seccomp-bpf sandbox (mode 2), which is only applied when the sandbox is on.
    for (const pid of renderers) expect(readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/^Seccomp:\s+2$/m);
    for (const pid of renderers) process.kill(pid, 'SIGSTOP');
    await expect(worker.deps.decodedSize(new Blob([Buffer.from(appJpeg, 'base64')]), undefined)).rejects.toMatchObject({ code: 'unavailable' });
    expect(worker.failure()).toBe('timeout');
  } finally { await worker.close(); }
  expect(running(workerPid)).toBe(false);
  await expect.poll(() => tree.filter(running).length, { timeout: 20_000 }).toBe(0);
});