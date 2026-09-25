// Shared by the build (vite.config.ts), the service worker and the tests. It must stay free of imports,
// so the worker bundle contains no shared chunk.
export const shellCachePrefix = 'stillroom-shell-';
export const workerPath = '/service-worker.js';
export const manifestPath = '/precache-manifest.json';
// Cloudflare Pages redirects /index.html to /, so the shell is stored and fetched as /.
export const shellPath = '/';

export type PrecacheEntry = { url: string; sha256: string; bytes: number };
export type PrecacheManifest = { version: 1; buildId: string; files: PrecacheEntry[] };

const assetFile = /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const iconFile = /^(?:icon(?:-[a-z0-9]+)*|apple-touch-icon)\.(?:png|svg)$/;

// The public app shell: the same bytes for every user, already public on the static host.
export function isShellArtifact(file: string): boolean {
  return file === 'index.html' || file === 'manifest.webmanifest' || assetFile.test(file) || iconFile.test(file);
}

// Files the host serves (or, for `_*` control files, never serves) that the worker never caches.
export function isExcludedArtifact(file: string): boolean {
  return file.startsWith('_') || file.endsWith('.map') || file === manifestPath.slice(1) || file === workerPath.slice(1);
}

export const shellCacheName = (buildId: string) => `${shellCachePrefix}${buildId}`;
export const artifactUrl = (file: string) => file === 'index.html' ? shellPath : `/${file}`;

const sha256Hex = /^[0-9a-f]{64}$/;
const buildIdHex = /^[0-9a-f]{20}$/;

export function parsePrecacheManifest(value: unknown, buildId: string): PrecacheManifest {
  const fail = (): never => { throw new Error('Invalid precache manifest'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).sort().join() !== 'buildId,files,version' || manifest.version !== 1
    || manifest.buildId !== buildId || !buildIdHex.test(buildId) || !Array.isArray(manifest.files) || manifest.files.length === 0) return fail();
  const seen = new Set<string>();
  const files = (manifest.files as unknown[]).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail();
    const file = entry as Record<string, unknown>;
    if (Object.keys(file).sort().join() !== 'bytes,sha256,url' || typeof file.url !== 'string' || !file.url.startsWith('/')
      || !(file.url === shellPath || file.url !== '/index.html' && isShellArtifact(file.url.slice(1))) || seen.has(file.url) || typeof file.sha256 !== 'string' || !sha256Hex.test(file.sha256)
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 1) return fail();
    seen.add(file.url);
    return { url: file.url, sha256: file.sha256, bytes: file.bytes };
  });
  if (!seen.has(shellPath)) return fail();
  return { version: 1, buildId, files };
}

// The app routes with the URL fragment, so `/` is its only document path. A navigation anywhere else
// (`/rest/`, `/auth/`, `/storage/`, `/functions/`, `/_headers`, a file) is never answered by the worker.
const destinations: ReadonlyArray<[RegExp, ReadonlySet<string>]> = [
  [/\.js$/, new Set(['script'])], [/\.css$/, new Set(['style'])], [/\.(?:png|svg)$/, new Set(['image'])],
  [/\.webmanifest$/, new Set(['manifest'])],
];
export type RoutedRequest = { method: string; url: string; mode: string; destination: string };

// Decides what the worker answers. `files` is this worker's own verified URL list. Anything that returns
// null is left to the network untouched: the worker does not call respondWith for it.
export function routeRequest(request: RoutedRequest, origin: string, files: ReadonlySet<string>): 'shell' | 'file' | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== origin) return null;
  if (request.mode === 'navigate') {
    return request.destination === 'document' && url.pathname === shellPath ? 'shell' : null;
  }
  if (url.search !== '' || url.pathname === shellPath || !files.has(url.pathname)) return null;
  const allowed = destinations.find(([pattern]) => pattern.test(url.pathname))?.[1];
  return allowed?.has(request.destination) ? 'file' : null;
}

// The verified URL list is stamped into the worker as comma-separated paths; shell URLs never contain commas.
export const joinShellUrls = (urls: readonly string[]) => urls.join(',');
export const splitShellUrls = (text: string) => text.split(',');
