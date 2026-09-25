import { manifestPath, parsePrecacheManifest, routeRequest, shellCacheName, shellCachePrefix, shellPath, splitShellUrls,
  type PrecacheManifest } from './pwa/shell-policy';

// Static app-shell worker. It caches only this release's verified public files and never sees private data:
// it answers only `/` navigations and the exact files in its own verified list; everything else goes to the
// network without the worker taking part.
type ExtendableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & { request: Request; respondWith(response: Promise<Response> | Response): void };
type MessageEvent = ExtendableEvent & { data: unknown };
type WorkerScope = {
  location: Location;
  registration: { unregister(): Promise<boolean> };
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};
const worker = self as unknown as WorkerScope;

// Replaced at build time. The release ID covers the shell files and this worker's own code, so every
// worker release has its own cache; the URL list is the manifest's, checked again at install.
const buildId: string = '__STILLROOM_BUILD_ID__';
const manifestSha256: string = '__STILLROOM_MANIFEST_SHA256__';
const shellUrls: string[] = splitShellUrls('__STILLROOM_SHELL_URLS__');
const files: ReadonlySet<string> = new Set(shellUrls);
const cacheName = shellCacheName(buildId);
const stagingName = `${cacheName}-staging`;
const origin = worker.location.origin;
// Public, build-wide response headers kept with each cached file, so a cached shell keeps its CSP.
const keptHeaders = ['Content-Type', 'Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'Permissions-Policy'];

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function fetchExact(path: string, cache: RequestCache): Promise<Response> {
  const response = await fetch(new URL(path, origin), { cache, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status !== 200 || response.type !== 'basic') throw new Error('Shell file unavailable');
  return response;
}
// True when `name` holds exactly the manifest's files with the expected bytes.
async function complete(name: string, manifest: PrecacheManifest): Promise<boolean> {
  if (!await caches.has(name)) return false;
  const cache = await caches.open(name);
  if ((await cache.keys()).length !== manifest.files.length) return false;
  for (const file of manifest.files) {
    const response = await cache.match(new URL(file.url, origin));
    if (!response) return false;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) return false;
  }
  return true;
}
async function install(): Promise<void> {
  const manifestBytes = await (await fetchExact(manifestPath, 'no-store')).arrayBuffer();
  if (await sha256(manifestBytes) !== manifestSha256) throw new Error('Shell manifest mismatch');
  const manifest: PrecacheManifest = parsePrecacheManifest(JSON.parse(new TextDecoder().decode(manifestBytes)), buildId);
  if (manifest.files.map((file) => file.url).join(',') !== shellUrls.join(',')) throw new Error('Shell manifest mismatch');
  if (await complete(cacheName, manifest)) return;
  // Every file is fetched and verified before anything is stored, so a deploy landing mid-install fails the install.
  const verified: Array<{ url: string; response: Response }> = [];
  for (const file of manifest.files) {
    const response = await fetchExact(file.url, 'reload');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error('Shell file mismatch');
    const headers = new Headers();
    for (const name of keptHeaders) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    verified.push({ url: file.url, response: new Response(bytes, { status: 200, headers }) });
  }
  // Written to a staging cache first and committed only once all of it is stored. Only caches named for this
  // release are touched here; the active worker's cache has another name and is removed only on activation.
  try {
    await caches.delete(stagingName);
    const staging = await caches.open(stagingName);
    for (const { url, response } of verified) await staging.put(new URL(url, origin), response);
    if (!await complete(stagingName, manifest)) throw new Error('Shell staging incomplete');
    // An incomplete cache under this release's name is a failed earlier install: no worker ever served it.
    await caches.delete(cacheName);
    const final = await caches.open(cacheName);
    for (const request of await staging.keys()) await final.put(request, (await staging.match(request))!);
    if (!await complete(cacheName, manifest)) throw new Error('Shell commit incomplete');
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  } finally {
    await caches.delete(stagingName);
  }
}
async function activate(): Promise<void> {
  await worker.clients.claim();
  for (const name of await caches.keys()) {
    if (name.startsWith(shellCachePrefix) && name !== cacheName) await caches.delete(name);
  }
}
// The controlling release always answers with its own verified shell, so a page never mixes two builds.
// Without that shell it fails closed and steps aside: no other release's HTML runs under this worker, and
// the next attempt loads from the network uncontrolled.
async function navigation(event: FetchEvent): Promise<Response> {
  const cached = await caches.match(new URL(shellPath, origin), { cacheName });
  if (cached) return cached;
  event.waitUntil(worker.registration.unregister());
  return Response.error();
}
async function shellFile(request: Request): Promise<Response> {
  return await caches.match(new URL(request.url), { cacheName }) ?? Response.error();
}

worker.addEventListener('install', (event) => { event.waitUntil(install()); });
worker.addEventListener('activate', (event) => { event.waitUntil(activate()); });
// A normal update waits until the user chooses Reload, or until every tab of the old version has closed.
worker.addEventListener('message', (event) => {
  const data = event.data;
  if (data && typeof data === 'object' && (data as { type?: unknown }).type === 'SKIP_WAITING') event.waitUntil(worker.skipWaiting());
});
worker.addEventListener('fetch', (event) => {
  const request = event.request;
  const route = routeRequest(request, origin, files);
  if (route === 'shell') event.respondWith(navigation(event));
  else if (route === 'file') event.respondWith(shellFile(request));
});