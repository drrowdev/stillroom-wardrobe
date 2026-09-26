import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolveSourceSpecifier } from '../../scripts/src-loader.mjs';
import { ImageWorkerError, startImageWorker, workerEnvironment } from '../../scripts/restore-image-client.mjs';
import { validRequest } from '../../scripts/restore-image-worker.mjs';
import { ImagePreparationError } from '../../src/images/jpeg';

const posixFiles = new Set(['/repo/src/data/restore.ts', '/repo/src/images/index.ts', '/repo/src/data/other.ts', '/repo/scripts/x.ts']);
const posix = (specifier: string, parent: string, links: Record<string, string> = {}) =>
  resolveSourceSpecifier(specifier, `file://${parent}`, '/repo/src', (path: string) => posixFiles.has(path.replaceAll('\\', '/')),
    (path: string) => links[path.replaceAll('\\', '/')] ?? path.replaceAll('\\', '/'));

describe('source loader', () => {
  it.skipIf(process.platform === 'win32')('maps only extensionless relative imports from src to src, trying .ts then index.ts', () => {
    expect(posix('./other', '/repo/src/data/restore.ts')).toBe('file:///repo/src/data/other.ts');
    expect(posix('../images', '/repo/src/data/restore.ts')).toBe('file:///repo/src/images/index.ts');
    expect(posix('./other.ts', '/repo/src/data/restore.ts')).toBeNull();
    expect(posix('./other.js', '/repo/src/data/restore.ts')).toBeNull();
    expect(posix('@supabase/supabase-js', '/repo/src/data/restore.ts')).toBeNull();
    expect(posix('node:fs', '/repo/src/data/restore.ts')).toBeNull();
    expect(posix('/repo/src/data/other', '/repo/src/data/restore.ts')).toBeNull();
    expect(posix('../../scripts/x', '/repo/src/data/restore.ts')).toBeNull();
    expect(posix('./x', '/repo/scripts/y.mjs')).toBeNull();
    expect(posix('./missing', '/repo/src/data/restore.ts')).toBeNull();
    // A link that leaves src is not followed.
    expect(posix('./other', '/repo/src/data/restore.ts', { '/repo/src/data/other.ts': '/elsewhere/other.ts' })).toBeNull();
    expect(resolveSourceSpecifier('./other', 'data:text/javascript,1', '/repo/src', () => true, (path: string) => path)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('works with Windows paths, drive letters and case', () => {
    const files = new Set(['C:\\repo\\src\\data\\other.ts', 'C:\\repo\\src\\images\\index.ts']);
    const win = (specifier: string, parent: string) => resolveSourceSpecifier(specifier, parent, 'C:\\repo\\src',
      (path: string) => files.has(path), (path: string) => path);
    expect(win('./other', 'file:///C:/repo/src/data/restore.ts')).toBe('file:///C:/repo/src/data/other.ts');
    expect(win('../images', 'file:///C:/repo/src/data/restore.ts')).toBe('file:///C:/repo/src/images/index.ts');
    expect(win('../../scripts/x', 'file:///C:/repo/src/data/restore.ts')).toBeNull();
    expect(win('./other', 'file:///D:/repo/src/data/restore.ts')).toBeNull();
    expect(win('./other', 'file:///C:/repo/srcx/data/restore.ts')).toBeNull();
  });

  it('loads the whole restore engine in plain Node, the way restore-own does', () => {
    const script = fileURLToPath(new URL('../../scripts/restore-own.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check-load'], { encoding: 'utf8', timeout: 60_000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

class FakeChild extends EventEmitter {
  sent: unknown[] = [];
  killed = false;
  stderr = { resume: () => {} };
  answer: (message: { id: number; step: string }) => unknown = () => undefined;
  send(message: { id: number; step: string }, callback?: (error?: Error) => void) {
    this.sent.push(message);
    callback?.();
    const reply = this.answer(message);
    if (reply !== undefined) queueMicrotask(() => this.emit('message', reply));
    return true;
  }
  kill() { this.killed = true; queueMicrotask(() => this.emit('exit', null, 'SIGKILL')); return true; }
  disconnect() { queueMicrotask(() => this.emit('exit', 0, null)); }
}
async function started(child: FakeChild, options: Record<string, unknown> = {}) {
  const env: Record<string, string> = { PATH: '/bin', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_canary', NODE_OPTIONS: '--inspect', HOME: '/home/x' };
  const fork = vi.fn(() => { queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; });
  const worker = await startImageWorker({ fork, chromiumPath: async () => '/chromium', env, callTimeout: 200, ...options });
  return { worker, fork };
}
const jpegBlob = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });

describe('restore photo worker client', () => {
  it('gives the worker only a minimal environment and no credentials or Node options', async () => {
    expect(workerEnvironment({ PATH: '/bin', SUPABASE_PUBLISHABLE_KEY: 'k', VITE_SUPABASE_URL: 'u', NODE_OPTIONS: '-r x', HOME: '/h' }, '/tmp/x'))
      .toEqual({ PATH: '/bin', HOME: '/h', TMP: '/tmp/x', TEMP: '/tmp/x', TMPDIR: '/tmp/x' });
    const child = new FakeChild();
    const { worker, fork } = await started(child);
    const [, args, options] = fork.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; execArgv: string[] }];
    expect(args).toEqual(['--serve']);
    expect(options.execArgv).toEqual([]);
    expect(Object.keys(options.env).sort()).toEqual(['HOME', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
    await worker.close();
    expect(worker.failure()).toBeNull();
  });

  it('refuses before starting anything when Chromium is not installed', async () => {
    const fork = vi.fn();
    const error = await startImageWorker({ fork, chromiumPath: async () => null }).catch((caught: unknown) => caught);
    expect(error instanceof ImageWorkerError && error.code).toBe('missing');
    expect(fork).not.toHaveBeenCalled();
  });

  it('reports a launch failure and a worker that never becomes ready, and stops it', async () => {
    const failing = new FakeChild();
    const fork = vi.fn(() => { queueMicrotask(() => failing.emit('message', { type: 'failed', code: 'launch' })); return failing; });
    const error = await startImageWorker({ fork, chromiumPath: async () => '/c' }).catch((caught: unknown) => caught);
    expect(error instanceof ImageWorkerError && error.code).toBe('launch');
    expect(failing.killed).toBe(true);
    const silent = new FakeChild();
    const hung = await startImageWorker({ fork: () => silent, chromiumPath: async () => '/c', readyTimeout: 50 }).catch((caught: unknown) => caught);
    expect(hung instanceof ImageWorkerError && hung.code).toBe('timeout');
    expect(silent.killed).toBe(true);
  });

  it('turns a hang, a crash or a malformed answer into an unavailable step and a recorded failure', async () => {
    const hanging = new FakeChild();
    const { worker } = await started(hanging);
    const error = await worker.deps.decodedSize(jpegBlob()).catch((caught: unknown) => caught);
    expect(error instanceof ImagePreparationError && error.code).toBe('unavailable');
    expect(worker.failure()).toBe('timeout');
    expect(hanging.killed).toBe(true);
    await worker.close();

    const crashing = new FakeChild();
    const second = await started(crashing);
    crashing.answer = () => { queueMicrotask(() => crashing.emit('exit', 1, null)); return undefined; };
    const crash = await second.worker.deps.decodedSize(jpegBlob()).catch((caught: unknown) => caught);
    expect(crash instanceof ImagePreparationError && crash.code).toBe('unavailable');
    expect(second.worker.failure()).toBe('stopped');
    await second.worker.close();

    const lying = new FakeChild();
    lying.answer = ({ id }) => ({ type: 'result', id, outcome: { ok: true, value: { width: 0, height: 99_999 } } });
    const third = await started(lying);
    await expect(third.worker.deps.decodedSize(jpegBlob())).rejects.toBeInstanceOf(ImagePreparationError);
    expect(third.worker.failure()).toBe('protocol');
    await third.worker.close();
  });

  it('passes a decode refusal through as the engine\'s own error, without marking the worker failed', async () => {
    const child = new FakeChild();
    child.answer = ({ id }) => ({ type: 'result', id, outcome: { ok: false, code: 'invalid' } });
    const { worker } = await started(child);
    const error = await worker.deps.decodedSize(jpegBlob()).catch((caught: unknown) => caught);
    expect(error instanceof ImagePreparationError && error.code).toBe('invalid');
    expect(worker.failure()).toBeNull();
    child.answer = ({ id }) => ({ type: 'result', id, outcome: { ok: true, value: { width: 4, height: 3 } } });
    expect(await worker.deps.decodedSize(jpegBlob())).toEqual({ width: 4, height: 3 });
    await worker.close();
  });

  it('accepts only bounded, well-formed requests in the worker', () => {
    expect(validRequest({ type: 'call', id: 1, step: 'decodedSize', args: ['/9j/'] })).toBe(true);
    expect(validRequest({ type: 'call', id: 1, step: 'thumbnail', args: ['/9j/', 4, 3] })).toBe(true);
    expect(validRequest({ type: 'call', id: 1, step: 'eval', args: ['x'] })).toBe(false);
    expect(validRequest({ type: 'call', id: 1, step: 'decodedSize', args: ['not base64!'] })).toBe(false);
    expect(validRequest({ type: 'call', id: 1, step: 'decodedSize', args: ['/9j/', 'extra'] })).toBe(false);
    expect(validRequest({ type: 'call', id: 1, step: 'thumbnail', args: ['/9j/', 0, 3] })).toBe(false);
    expect(validRequest({ type: 'call', id: -1, step: 'decodedSize', args: ['/9j/'] })).toBe(false);
  });
});
