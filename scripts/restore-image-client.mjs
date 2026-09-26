// Node side of the restore photo steps: starts scripts/restore-image-worker.mjs and gives the shared restore engine the
// same three steps the browser uses (RestorePhotoDeps). Every check of the results stays in Node, in planRestorePhoto.
// Only bounded photo bytes cross to the worker; it gets no credentials, a minimal environment and a temporary folder that
// is removed afterwards. A worker that cannot start, stops or does not answer in time makes every later step
// 'unavailable' and is reported by `failure()`.
import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromiumPath } from './restore-image-page.mjs';
import { MAX_BASE64 } from './restore-image-worker.mjs';

const WORKER = fileURLToPath(new URL('./restore-image-worker.mjs', import.meta.url));
// The same module instance the restore engine loads, so `instanceof` works across the two.
const jpegModule = () => import(pathToFileURL(realpathSync(fileURLToPath(new URL('../src/images/jpeg.ts', import.meta.url)))).href);

const KEEP = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'ComSpec', 'PATHEXT', 'SystemDrive', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'PLAYWRIGHT_BROWSERS_PATH', 'LANG', 'XDG_RUNTIME_DIR'];
/** Only what Node and Chromium need to start; no app, Supabase or Node option variables. */
export function workerEnvironment(env, temporary) {
  const result = {};
  for (const name of KEEP) if (typeof env[name] === 'string') result[name] = env[name];
  return { ...result, TMP: temporary, TEMP: temporary, TMPDIR: temporary };
}

export class ImageWorkerError extends Error {
  constructor(code) { super(code); this.name = 'ImageWorkerError'; this.code = code; }
}

const hex = /^[0-9a-f]{64}$/;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
const size = value => Number.isSafeInteger(value) && value >= 1 && value <= 1600;
const CODES = new Set(['unsupported', 'tooLarge', 'invalid', 'unavailable']);
function blobOf(text, limit) {
  if (typeof text !== 'string' || text.length > MAX_BASE64 || !base64.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length > 0 && bytes.length <= limit ? new Blob([bytes], { type: 'image/jpeg' }) : null;
}

/**
 * Starts the worker. `options.fork` and `options.chromiumPath` are for tests. Returns `{ deps, failure, close }`.
 */
export async function startImageWorker(options = {}) {
  const { readyTimeout = 120_000, callTimeout = 30_000, closeTimeout = 10_000, env = process.env } = options;
  const { ImagePreparationError, JPEG_LIMITS } = await jpegModule();
  if (!await (options.chromiumPath ?? chromiumPath)()) throw new ImageWorkerError('missing');
  const temporary = await mkdtemp(join(tmpdir(), 'stillroom-restore-'));
  const child = (options.fork ?? fork)(WORKER, ['--serve'], {
    env: workerEnvironment(env, temporary), execArgv: [], serialization: 'json', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  // The worker's own diagnostics are discarded: they could contain local paths.
  child.stderr?.resume();
  let failed = null, exited = false, closing = false;
  const pending = new Map();
  let next = 1;
  const fail = (code) => {
    if (!closing) failed ??= code;
    for (const { reject } of pending.values()) reject(new ImagePreparationError('unavailable'));
    pending.clear();
    if (!exited) child.kill('SIGKILL');
  };
  const exitedPromise = new Promise(resolve => {
    const done = () => { exited = true; fail('stopped'); resolve(); };
    child.once('exit', done);
    child.once('error', done);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail('timeout'); reject(new ImageWorkerError('timeout')); }, readyTimeout);
    const onMessage = (message) => {
      if (message?.type === 'ready') { clearTimeout(timer); child.off('message', onMessage); resolve(); }
      else if (message?.type === 'failed') {
        clearTimeout(timer); fail(message.code);
        reject(new ImageWorkerError(['missing', 'sandbox', 'launch', 'build', 'page'].includes(message.code) ? message.code : 'page'));
      }
    };
    child.on('message', onMessage);
    exitedPromise.then(() => { clearTimeout(timer); reject(new ImageWorkerError(failed === 'stopped' ? 'launch' : failed ?? 'launch')); });
  }).catch(async (error) => { await cleanup(); throw error; });
  child.on('message', (message) => {
    const entry = typeof message?.id === 'number' ? pending.get(message.id) : undefined;
    if (message?.type !== 'result' || !entry) { fail('protocol'); return; }
    pending.delete(message.id);
    entry.resolve(message.outcome);
  });

  async function cleanup() {
    closing = true;
    if (!exited) {
      child.disconnect?.();
      const timer = setTimeout(() => child.kill('SIGKILL'), closeTimeout);
      await exitedPromise;
      clearTimeout(timer);
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  async function request(step, args, signal) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (failed) throw new ImagePreparationError('unavailable');
    const id = next++;
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); fail('timeout'); reject(new ImagePreparationError('unavailable')); }, callTimeout);
      const onAbort = () => { clearTimeout(timer); pending.delete(id); reject(new DOMException('Cancelled', 'AbortError')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: value => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); },
        reject: error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); },
      });
      child.send({ type: 'call', id, step, args }, error => { if (error) fail('stopped'); });
    });
    if (typeof outcome !== 'object' || outcome === null) { fail('protocol'); throw new ImagePreparationError('unavailable'); }
    if (outcome.ok === false) throw new ImagePreparationError(CODES.has(outcome.code) ? outcome.code : 'invalid');
    if (outcome.ok !== true || typeof outcome.value !== 'object' || outcome.value === null) { fail('protocol'); throw new ImagePreparationError('unavailable'); }
    return outcome.value;
  }
  const encode = async (blob) => {
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > JPEG_LIMITS.mainBytes) throw new ImagePreparationError('invalid');
    return Buffer.from(await blob.arrayBuffer()).toString('base64');
  };
  const malformed = () => { fail('protocol'); throw new ImagePreparationError('unavailable'); };

  const deps = {
    decodedSize: async (blob, signal) => {
      const value = await request('decodedSize', [await encode(blob)], signal);
      if (![value.width, value.height].every(side => Number.isSafeInteger(side) && side >= 1 && side <= 65_535)) malformed();
      return { width: value.width, height: value.height };
    },
    reencode: async (blob, signal) => {
      const value = await request('reencode', [await encode(blob)], signal);
      const main = blobOf(value.main, JPEG_LIMITS.mainBytes), thumb = blobOf(value.thumb, JPEG_LIMITS.thumbBytes);
      if (!main || !thumb || !size(value.width) || !size(value.height) || !hex.test(value.mainSha256) || !hex.test(value.thumbSha256)) malformed();
      return { main, thumb, width: value.width, height: value.height, mainSha256: value.mainSha256, thumbSha256: value.thumbSha256 };
    },
    thumbnail: async (main, width, height, signal) => {
      if (!size(width) || !size(height)) throw new ImagePreparationError('invalid');
      const value = await request('thumbnail', [await encode(main), width, height], signal);
      const blob = blobOf(value.blob, JPEG_LIMITS.thumbBytes);
      if (!blob || !hex.test(value.sha256) || !size(value.width) || !size(value.height)) malformed();
      return { blob, sha256: value.sha256, width: value.width, height: value.height };
    },
  };
  return { deps, failure: () => failed, close: cleanup };
}
