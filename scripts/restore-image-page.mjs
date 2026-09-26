// The isolated Chromium page the Node restore CLI uses for photo steps (see scripts/restore-image-worker.mjs).
// The page runs only src/images/restore-worker-entry.ts, built in memory with no Vite config, env files or public folder.
// Isolation is by the browser, not the operating system: every request is intercepted before navigation and only the two
// exact page URLs are served; WebSockets are closed; a Content Security Policy allows no connections; service workers are
// blocked; the context keeps nothing on disk, and no traces or screenshots are made. Photo bytes and results cross as
// base64 only.
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PAGE_ORIGIN = 'https://restore.invalid';
export const PAGE_URL = `${PAGE_ORIGIN}/`;
export const SCRIPT_URL = `${PAGE_ORIGIN}/restore-images.js`;
export const PAGE_CSP = `default-src 'none'; script-src ${SCRIPT_URL}; connect-src 'none'; img-src blob:; worker-src 'none'; `
  + `frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const HTML = `<!doctype html><meta charset="utf-8"><title>restore</title><script type="module" src="${SCRIPT_URL}"></script>`;

const repository = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const ENTRY = join(repository, 'src', 'images', 'restore-worker-entry.ts');

export class ImagePageError extends Error {
  constructor(code) { super(code); this.name = 'ImagePageError'; this.code = code; }
}

/**
 * Builds the page script in memory. No config file, env files (so nothing from an ambient .env reaches the bundle) or
 * public folder; nothing is written and Vite's own logging is silent. Any failure becomes one fixed error.
 */
export async function buildImageBundle() {
  const { build } = await import('vite');
  const silent = { info() {}, warn() {}, warnOnce() {}, error() {}, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false };
  let result;
  try {
    result = await build({
      configFile: false, envFile: false, envDir: false, publicDir: false, root: repository, mode: 'production',
      logLevel: 'silent', clearScreen: false, customLogger: silent, plugins: [],
      build: {
        write: false, copyPublicDir: false, emptyOutDir: false, reportCompressedSize: false, minify: false, sourcemap: false,
        modulePreload: false, target: 'es2022',
        rolldownOptions: { input: ENTRY, output: { format: 'es', entryFileNames: 'restore-images.js', codeSplitting: false } },
      },
    });
  } catch { throw new ImagePageError('build'); }
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(entry => entry.output ?? []);
  const chunks = outputs.filter(entry => entry.type === 'chunk');
  if (chunks.length !== 1 || outputs.length !== 1 || chunks[0].fileName !== 'restore-images.js') throw new ImagePageError('build');
  return chunks[0].code;
}

/** The locked Playwright Chromium, or null when it has not been installed. Never a system browser. */
export async function chromiumPath() {
  const { chromium } = await import('@playwright/test');
  const path = chromium.executablePath();
  return path && existsSync(path) ? path : null;
}

export async function launchImageBrowser({ timeout = 30_000, env } = {}) {
  const { chromium } = await import('@playwright/test');
  if (!await chromiumPath()) throw new ImagePageError('missing');
  try {
    return await chromium.launch({
      // The full Chromium build in its new headless mode, so the binary started is exactly the one chromiumPath() checked.
      headless: true, channel: 'chromium', chromiumSandbox: true, timeout, env,
      // No name resolves: the page's two URLs are served by interception, never from the network.
      args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--disable-sync', '--no-first-run',
        '--disable-component-update', '--disable-default-apps', '--disable-extensions'],
    });
  } catch (error) {
    // Chromium refuses to run without its sandbox where the system doesn't allow one (for example Ubuntu 23.10 and later
    // with AppArmor's user-namespace restriction). The sandbox is never turned off; this only names the reason.
    throw new ImagePageError(/No usable sandbox/i.test(String(error?.message ?? '')) ? 'sandbox' : 'launch');
  }
}

/**
 * Opens the page in a fresh context. `onRequest`, for tests, sees every request the page attempts. Returns the page, its
 * context and `call(name, ...args)`, which runs one of the page's three photo steps.
 */
export async function openImagePage(browser, code, { onRequest } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, javaScriptEnabled: true,
    bypassCSP: false, permissions: [], offline: false });
  try {
    await context.routeWebSocket(/.*/, socket => { socket.close({ code: 1008, reason: 'blocked' }); });
    await context.route(() => true, async route => {
      const request = route.request();
      onRequest?.({ url: request.url(), method: request.method() });
      const url = request.url(), method = request.method();
      if (method === 'GET' && url === PAGE_URL && request.isNavigationRequest()) {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML,
          headers: { 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store' } });
      } else if (method === 'GET' && url === SCRIPT_URL && request.resourceType() === 'script') {
        await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: code, headers: { 'Cache-Control': 'no-store' } });
      } else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => typeof globalThis.stillroomRestoreImages === 'object', undefined, { timeout: 30_000 });
    const call = (name, ...args) => page.evaluate(([step, values]) => globalThis.stillroomRestoreImages[step](...values), [name, args]);
    return { page, context, call };
  } catch (error) {
    await context.close().catch(() => {});
    throw error instanceof ImagePageError ? error : new ImagePageError('page');
  }
}
