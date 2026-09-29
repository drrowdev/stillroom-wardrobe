/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { alphaFromOutput, MASK_SIDE, toInputTensor } from './mask';
import type { BackgroundTestHook } from './test-hook';

// Runs u2netp on 320×320 pixels. It receives verified bytes from the main thread and never fetches anything itself.
type TestControl = Pick<BackgroundTestHook, 'mask' | 'fault' | 'runDelayMs'>;
export type WorkerRequest =
  | { type: 'load'; id: number; wasm: ArrayBuffer; model: ArrayBuffer; test?: TestControl }
  | { type: 'run'; id: number; pixels: ArrayBuffer; test?: TestControl };
export type WorkerReply =
  | { type: 'ready' }
  | { type: 'loaded'; id: number }
  | { type: 'result'; id: number; alpha: ArrayBuffer }
  | { type: 'error'; id: number; stage: 'init' | 'run' | 'degenerate' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let session: ort.InferenceSession | null = null;
const reply = (message: WorkerReply, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
const testing = import.meta.env.MODE === 'browser-test';
const never = () => new Promise<never>(() => undefined);

// Fixture masks for browser tests, pushed through the same output validation as the model's answer.
function synthetic(mask: NonNullable<TestControl['mask']>): { dims: number[]; data: Float32Array } {
  const side = MASK_SIDE;
  if (mask === 'shape') return { dims: [1, 1, side, side / 2], data: new Float32Array(side * side / 2) };
  const data = new Float32Array(side * side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const dx = (x - side / 2) / (side * 0.3), dy = (y - side / 2) / (side * 0.4);
      data[y * side + x] = mask === 'constant' ? 0.5 : mask === 'nan' && x === 3 ? Number.NaN
        : mask === 'empty' ? (x === 0 && y === 0 ? 1 : 0)
          : mask === 'left' ? (x < side / 2 ? 1 : 0)
            : mask === 'two' ? ((x >= side * 0.1 && x < side * 0.4 || x >= side * 0.6 && x < side * 0.9) && y >= side * 0.2 && y < side * 0.8 ? 1 : 0)
              : (dx * dx + dy * dy <= 1 ? 1 : 0);
    }
  }
  return { dims: [1, 1, side, side], data };
}

async function load(data: Extract<WorkerRequest, { type: 'load' }>) {
  const test = testing ? data.test : undefined;
  if (test?.fault === 'hang-load') await never();
  if (test?.fault === 'load') throw new Error('fixture');
  ort.env.wasm.wasmBinary = data.wasm;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  session = await ort.InferenceSession.create(new Uint8Array(data.model), { executionProviders: ['wasm'] });
}

async function run(data: Extract<WorkerRequest, { type: 'run' }>): Promise<Float32Array> {
  const test = testing ? data.test : undefined;
  if (test?.fault === 'hang-run') await never();
  if (test?.runDelayMs) await new Promise((resolve) => setTimeout(resolve, test.runDelayMs));
  if (test?.fault === 'run') throw new Error('fixture');
  const input = new ort.Tensor('float32', toInputTensor(new Uint8ClampedArray(data.pixels)), [1, 3, MASK_SIDE, MASK_SIDE]);
  let output: ort.InferenceSession.OnnxValueMapType | null = null;
  try {
    output = await session!.run({ [session!.inputNames[0]!]: input });
    if (test?.mask && test.mask !== 'model') {
      const fake = synthetic(test.mask);
      return alphaFromOutput('float32', fake.dims, fake.data);
    }
    const first = output[session!.outputNames[0]!];
    return alphaFromOutput(first?.type, first?.dims ?? [], first?.data);
  } finally {
    input.dispose();
    for (const value of Object.values(output ?? {})) value.dispose();
  }
}

scope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'load') {
    try {
      await load(data);
      reply({ type: 'loaded', id: data.id });
    } catch {
      reply({ type: 'error', id: data.id, stage: 'init' });
    }
    return;
  }
  if (!session) { reply({ type: 'error', id: data.id, stage: 'init' }); return; }
  try {
    const alpha = await run(data);
    reply({ type: 'result', id: data.id, alpha: alpha.buffer as ArrayBuffer }, [alpha.buffer as ArrayBuffer]);
  } catch (error) {
    reply({ type: 'error', id: data.id, stage: error instanceof Error && error.name === 'BackgroundRemovalError' ? 'degenerate' : 'run' });
  }
};

reply({ type: 'ready' });
