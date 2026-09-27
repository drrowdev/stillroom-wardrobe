import { modelBytes } from './assets';
import { BackgroundRemovalError, MASK_SIDE } from './mask';
import { testHook } from './test-hook';
import type { WorkerReply, WorkerRequest } from './segment-worker';

// One segmentation at a time, in a worker that is created for the photo and terminated afterwards. The watchdog
// runs on the main thread, so a hung worker start, WASM start-up, session creation or inference is always ended
// from outside.
export type SegmentJob = { run: (pixels: ImageData, signal?: AbortSignal) => Promise<Float32Array>; close: () => void };
export type Segmenter = { open: (signal?: AbortSignal) => Promise<SegmentJob> };

const deadlines = { startMs: 10_000, loadMs: 20_000, runMs: 20_000 };
let previous: Promise<void> = Promise.resolve();
let nextId = 1;

const aborted = () => new DOMException('Aborted', 'AbortError');
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

// The runtime build needs WebAssembly SIMD. This is the smallest module using a SIMD instruction (as in
// wasm-feature-detect); it is validated locally before anything is downloaded.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export function removalSupported(): boolean {
  try {
    return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function control() {
  const hook = testHook();
  return hook ? { mask: hook.mask, fault: hook.fault, runDelayMs: hook.runDelayMs } : undefined;
}

class Job implements SegmentJob {
  private waiting: { id: number; resolve: (reply: WorkerReply) => void; reject: (error: unknown) => void } | null = null;
  private closed = false;
  constructor(private worker: Worker, private done: () => void) {
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      const waiting = this.waiting;
      if (!waiting || this.closed) return;
      // A reply for an earlier, abandoned step is ignored.
      if (data.type !== 'ready' && data.id !== waiting.id) return;
      if (data.type === 'ready' && waiting.id !== 0) return;
      this.waiting = null;
      waiting.resolve(data);
    };
    worker.onerror = (event) => { event.preventDefault(); this.fail(new BackgroundRemovalError('init')); };
    worker.onmessageerror = () => this.fail(new BackgroundRemovalError('run'));
  }
  private fail(error: unknown) {
    const waiting = this.waiting;
    this.waiting = null;
    this.close();
    waiting?.reject(error);
  }
  wait(id: number, ms: number, signal: AbortSignal | undefined, post?: () => void): Promise<WorkerReply> {
    if (this.closed) return Promise.reject(new BackgroundRemovalError('init'));
    return new Promise<WorkerReply>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { finish(); this.fail(aborted()); };
      const timer = setTimeout(() => { finish(); this.fail(new BackgroundRemovalError('timeout')); }, ms);
      this.waiting = { id, resolve: (reply) => { finish(); resolve(reply); }, reject: (error) => { finish(); reject(error); } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      post?.();
    });
  }
  async run(pixels: ImageData, signal?: AbortSignal): Promise<Float32Array> {
    if (pixels.width !== MASK_SIDE || pixels.height !== MASK_SIDE) throw new BackgroundRemovalError('degenerate');
    const id = nextId++;
    const buffer = pixels.data.slice().buffer;
    const reply = await this.wait(id, { ...deadlines, ...testHook()?.limits }.runMs, signal, () => {
      this.worker.postMessage({ type: 'run', id, pixels: buffer, test: control() } satisfies WorkerRequest, [buffer]);
    });
    if (reply.type === 'result') return new Float32Array(reply.alpha);
    throw new BackgroundRemovalError(reply.type === 'error' && reply.stage === 'degenerate' ? 'degenerate' : 'run');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.done();
  }
}

/** A segmenter bound to one owner scope: its asset state is cleared on logout or a different signed-in user. */
export function backgroundSegmenter(owner: { signal: AbortSignal }): Segmenter {
  return {
    async open(signal) {
      if (!removalSupported()) throw new BackgroundRemovalError('unsupported');
      const outer = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal;
      // Single flight through cleanup: the next photo starts only after the previous worker has been terminated.
      const before = previous;
      let release!: () => void;
      previous = new Promise<void>((resolve) => { release = resolve; });
      let job: Job | null = null;
      try {
        await before;
        if (outer.aborted) throw aborted();
        const bytes = await modelBytes(owner, outer);
        const limits = { ...deadlines, ...testHook()?.limits };
        let worker: Worker;
        try {
          worker = new Worker(new URL('./segment-worker.ts', import.meta.url), { type: 'module', name: 'background' });
        } catch {
          throw new BackgroundRemovalError('init');
        }
        job = new Job(worker, release);
        const current = job;
        const hang = testHook()?.fault === 'hang-start';
        const ready = await current.wait(hang ? -1 : 0, limits.startMs, outer);
        if (ready.type !== 'ready') throw new BackgroundRemovalError('init');
        const id = nextId++;
        // Copies: the verified bytes stay available for the next photo.
        const wasm = bytes.wasm.slice(0), model = bytes.model.slice(0);
        const loaded = await current.wait(id, limits.loadMs, outer, () => {
          worker.postMessage({ type: 'load', id, wasm, model, test: control() } satisfies WorkerRequest, [wasm, model]);
        });
        if (loaded.type !== 'loaded') throw new BackgroundRemovalError('init');
        return current;
      } catch (error) {
        if (job) job.close(); else release();
        // Anything but a genuine abort keeps the original photo instead of rejecting it.
        if (isAbort(error) || error instanceof BackgroundRemovalError) throw error;
        throw new BackgroundRemovalError('init');
      }
    },
  };
}
