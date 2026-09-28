import type { BrowserContext, Request } from '@playwright/test';
import { modelAssets } from '../../src/images/background/model-assets';
import { analysisPath } from './mock-backend';

// Egress for background removal (ADR24, BG1 amendment 1). Every request in the browser context is recorded, so
// requests from the page, its workers and the service worker are all included, and then sorted into:
// - segmentation: the exact approved model and runtime URLs (no query), which must be credential-free GETs without a body;
// - app: same-origin GETs without a body for an explicit list of shell routes, build assets and Vite dev-server modules;
// - tagging: the consented analysis request, counted against the fixture's analyses;
// - backend: other requests to the fictional Supabase origin (auth, data, storage);
// - unexpected: everything else, including other model-like paths and any other origin.
export const BACKEND_ORIGIN = 'http://127.0.0.1:54321';
export const PROBE_COOKIE = { name: 'stillroom-egress-probe', value: 'present' };
const inventory = new Set(modelAssets.map((file) => file.path));
const shellFiles = new Set(['/', '/manifest.webmanifest', '/service-worker.js', '/precache-manifest.json', '/icon.svg', '/icon-192.png',
  '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);
// Each rule matches the whole path and the whole query string; anything else is unexpected.
const appRules: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^\/assets\/[\w-]+-[\w-]{8}\.(?:js|css)$/, /^$/],
  [/^\/@vite\/client$|^\/@react-refresh$|^\/node_modules\/vite\/dist\/client\/env\.mjs$/, /^$/],
  [/^\/node_modules\/\.vite\/deps\/[\w@.-]+\.js$/, /^\?v=[0-9a-f]{8}$/],
  [/^\/src\/[\w/.-]+\.(?:ts|tsx|css)$/, /^$|^\?worker_file&type=module$/],
  [/^\/src\/[\w/.-]+\.json$/, /^\?import$/],
];
const appAsset = (pathname: string, search: string) =>
  (shellFiles.has(pathname) && search === '') || appRules.some(([route, query]) => route.test(pathname) && query.test(search));

export type Egress = { url: string; origin: string; pathname: string; search: string; method: string; body: boolean; cookie: boolean; authorization: boolean };
export type Traffic = { segmentation: Egress[]; app: Egress[]; tagging: Egress[]; backend: Egress[]; unexpected: Egress[] };

// Raw request headers (which include Cookie) are only needed for the segmentation checks. Chromium reports them only
// once a response arrives, so awaiting them for every request made read() wait on unrelated requests that never
// complete while the page is open, such as the browser's own service-worker update check: in CI the test then sat
// until its limit (runs 36360335271 and 36360189457). Other requests use their provisional headers, and a
// segmentation request whose raw headers don't arrive in time fails with its path instead of hanging.
const RAW_HEADERS_MS = 30_000;
async function describe(request: Request, appOrigin: string): Promise<Egress | null> {
  const url = new URL(request.url());
  if (url.protocol === 'blob:' || url.protocol === 'data:') return null;
  const segmentation = url.origin === appOrigin && inventory.has(url.pathname) && url.search === '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const headers = segmentation
    ? await Promise.race([
      request.allHeaders(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No raw request headers for ${url.pathname} within ${RAW_HEADERS_MS} ms`)), RAW_HEADERS_MS); }),
    ]).finally(() => clearTimeout(timer))
    : request.headers();
  return {
    url: url.href, origin: url.origin, pathname: url.pathname, search: url.search, method: request.method(), body: request.postDataBuffer() !== null,
    cookie: (headers.cookie ?? '').includes(PROBE_COOKIE.name), authorization: 'authorization' in headers,
  };
}

export function classify(entries: readonly Egress[], appOrigin: string): Traffic {
  const traffic: Traffic = { segmentation: [], app: [], tagging: [], backend: [], unexpected: [] };
  for (const entry of entries) {
    if (entry.origin === appOrigin && inventory.has(entry.pathname) && entry.search === '') traffic.segmentation.push(entry);
    else if (entry.origin === appOrigin && entry.method === 'GET' && !entry.body && appAsset(entry.pathname, entry.search)) traffic.app.push(entry);
    else if (entry.origin === BACKEND_ORIGIN && entry.pathname === analysisPath) traffic.tagging.push(entry);
    else if (entry.origin === BACKEND_ORIGIN) traffic.backend.push(entry);
    else traffic.unexpected.push(entry);
  }
  return traffic;
}

/** Problems with the segmentation requests themselves: only credential-free GETs without a body are allowed. */
export function segmentationProblems(traffic: Traffic): string[] {
  return traffic.segmentation.flatMap((entry) => [
    ...entry.method === 'GET' ? [] : [`${entry.pathname}: method ${entry.method}`],
    ...entry.body ? [`${entry.pathname}: body`] : [],
    ...entry.cookie || entry.authorization ? [`${entry.pathname}: credentials`] : [],
  ]);
}

/**
 * Records all requests in `context`. A probe cookie is set for the app host's /models/ path, so a segmentation
 * request that sent credentials would carry it. (Cookies ignore ports; the path keeps it off the fixture backend.) `read()` waits for the recorded headers and classifies everything seen so far.
 */
export async function observeEgress(context: BrowserContext, appOrigin: string) {
  await context.addCookies([{ ...PROBE_COOKIE, domain: new URL(appOrigin).hostname, path: '/models/' }]);
  const pending: Array<Promise<Egress | null>> = [];
  context.on('request', (request) => {
    const entry = describe(request, appOrigin);
    entry.catch(() => undefined);
    pending.push(entry);
  });
  return {
    async read(): Promise<Traffic> {
      const entries = (await Promise.all(pending)).filter((entry): entry is Egress => entry !== null);
      return classify(entries, appOrigin);
    },
  };
}
