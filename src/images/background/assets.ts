import { modelAsset, modelCacheName, type ModelAsset } from './model-assets';
import { BackgroundRemovalError, type BackgroundFailure } from './mask';
import { testHook } from './test-hook';

// The public model and runtime, downloaded once on first use and verified by size and SHA-256 (ADR24). Neither is
// private: Cache Storage keeps them across logout. Only the in-memory state is per owner and cleared with the
// owner scope, so a failed download on a slow link is not repeated for every photo (bounded retry: one attempt per
// signed-in owner per page load).
export type AssetBytes = { wasm: ArrayBuffer; model: ArrayBuffer };
export type AssetStatus = 'idle' | 'downloading' | 'ready' | 'failed';
type Owner = { signal: AbortSignal };

const limits = { stallMs: 20_000, totalMs: 600_000, waitMs: 25_000 };
type State = { owner: Owner | null; status: AssetStatus; failure?: BackgroundFailure; bytes?: AssetBytes;
  promise?: Promise<AssetBytes>; controller?: AbortController };
let state: State = { owner: null, status: 'idle' };
const listeners = new Set<() => void>();

function publish(next: State) {
  state = next;
  for (const listener of [...listeners]) listener();
}
export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const assetStatus = (owner: Owner): AssetStatus => state.owner === owner ? state.status : 'idle';

function bind(owner: Owner) {
  if (state.owner === owner && !owner.signal.aborted) return;
  state.controller?.abort();
  publish({ owner, status: 'idle' });
  owner.signal.addEventListener('abort', () => {
    if (state.owner !== owner) return;
    state.controller?.abort();
    publish({ owner: null, status: 'idle' });
  }, { once: true });
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
const matches = async (asset: ModelAsset, bytes: ArrayBuffer) => bytes.byteLength === asset.bytes && await sha256(bytes) === asset.sha256;

async function openCache(): Promise<Cache | null> {
  try { return typeof caches === 'undefined' ? null : await caches.open(modelCacheName); } catch { return null; }
}
async function fromCache(cache: Cache | null, asset: ModelAsset): Promise<ArrayBuffer | null> {
  if (!cache) return null;
  try {
    const cached = await cache.match(asset.path);
    if (!cached) return null;
    const bytes = await cached.arrayBuffer();
    if (await matches(asset, bytes)) return bytes;
    await cache.delete(asset.path);
  } catch { /* An unreadable cache is the same as an empty one. */ }
  return null;
}

async function download(asset: ModelAsset, signal: AbortSignal): Promise<ArrayBuffer> {
  const { stallMs, totalMs } = { ...limits, ...testHook()?.limits };
  const controller = new AbortController();
  let reason: 'stall' | 'total' | null = null;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const total = setTimeout(() => { reason = 'total'; controller.abort(); }, totalMs);
  let stall = setTimeout(() => { reason = 'stall'; controller.abort(); }, stallMs);
  const progress = () => { clearTimeout(stall); stall = setTimeout(() => { reason = 'stall'; controller.abort(); }, stallMs); };
  try {
    // Same origin, no credentials needed and no redirect accepted: the bytes must come from the inventory path.
    const response = await fetch(asset.path, { signal: controller.signal, redirect: 'error', credentials: 'omit' });
    if (response.status !== 200 || !response.body) throw new BackgroundRemovalError('download');
    const reader = response.body.getReader();
    const bytes = new Uint8Array(asset.bytes);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      progress();
      if (offset + value.length > asset.bytes) { await reader.cancel(); throw new BackgroundRemovalError('integrity'); }
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== asset.bytes || !await matches(asset, bytes.buffer)) throw new BackgroundRemovalError('integrity');
    return bytes.buffer;
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof BackgroundRemovalError) throw error;
    throw new BackgroundRemovalError(reason ? 'timeout' : typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'download');
  } finally {
    clearTimeout(total); clearTimeout(stall);
    signal.removeEventListener('abort', abort);
  }
}

async function load(signal: AbortSignal): Promise<AssetBytes> {
  const cache = await openCache();
  const read = async (asset: ModelAsset) => {
    const cached = await fromCache(cache, asset);
    if (cached) return cached;
    const bytes = await download(asset, signal);
    try { await cache?.put(asset.path, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* Memory only. */ }
    return bytes;
  };
  // One after the other, so a slow link spends its bandwidth on one file at a time.
  const wasm = await read(modelAsset('runtime'));
  const model = await read(modelAsset('model'));
  return { wasm, model };
}

function start(owner: Owner) {
  const controller = new AbortController();
  const promise = load(AbortSignal.any([controller.signal, owner.signal]));
  publish({ owner, status: 'downloading', promise, controller });
  promise.then((bytes) => {
    if (state.promise === promise) publish({ owner, status: 'ready', bytes });
  }, (error: unknown) => {
    if (state.promise !== promise) return;
    const failure = error instanceof BackgroundRemovalError ? error.code : 'download';
    // Offline is not a failed attempt: the next photo may try again once the device is back online.
    publish(failure === 'offline' ? { owner, status: 'idle' } : { owner, status: 'failed', failure });
  });
}

/**
 * The verified bytes for `owner`, waiting at most the per-photo limit. A photo that waits too long falls back to
 * its original background while the download continues for the next photo.
 */
export async function modelBytes(owner: Owner, signal: AbortSignal): Promise<AssetBytes> {
  bind(owner);
  if (state.status === 'ready') return state.bytes!;
  if (state.status === 'failed') throw new BackgroundRemovalError(state.failure ?? 'download');
  if (state.status === 'idle') start(owner);
  const promise = state.promise!;
  const { waitMs } = { ...limits, ...testHook()?.limits };
  return new Promise<AssetBytes>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { finish(); reject(new BackgroundRemovalError('timeout')); }, waitMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    promise.then((bytes) => { finish(); resolve(bytes); }, (error: unknown) => {
      finish();
      reject(error instanceof BackgroundRemovalError ? error : new BackgroundRemovalError('download'));
    });
  });
}
