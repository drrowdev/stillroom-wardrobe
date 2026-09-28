// BG2c (plan rev4 §4.1, §13): H0 is built from the frame canvas, app-re-encoded, admitted by isPhotoInputJpeg, and every
// failure except an abort gives null so H1 is kept. A canvas shim stands in for the browser encoder.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { framePlan, REFERENCE_HEIGHT, REFERENCE_WIDTH } from '../../src/images/background/frame';
import { MASK_SIDE } from '../../src/images/background/mask';
import { cleanupSource } from '../../src/images/process-jpeg';
import { ENHANCE_LIMITS } from '../../src/domain/enhancement';
import { fitDimensions } from '../../src/images/jpeg';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';

type Shim = { width: number; height: number; drawn: unknown[][]; getContext: () => unknown; toBlob: (done: (blob: Blob | null) => void) => void };
type Encoder = (canvas: Shim) => Blob | null;

const alpha = (() => {
  const out = new Float32Array(MASK_SIDE * MASK_SIDE);
  for (let y = 60; y < 260; y++) for (let x = 90; x < 230; x++) out[y * MASK_SIDE + x] = 1;
  return out;
})();
const size = { width: 1280, height: 1600 };
const plan = framePlan(alpha, size.width, size.height)!;
const edit = { crop: null, rotation: 0 } as never;
const working = {} as HTMLCanvasElement;

let created: Shim[] = [];
function install(encoder: Encoder) {
  created = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const shim: Shim = {
        width: 0, height: 0, drawn: [],
        getContext: () => ({
          fillRect: () => undefined, setTransform: () => undefined,
          drawImage: (...args: unknown[]) => { shim.drawn.push(args); },
        }),
        toBlob: (done) => queueMicrotask(() => done(encoder(shim))),
      };
      created.push(shim);
      return shim;
    },
  });
}
const jpeg = (canvas: Shim) => new Blob([flatJpeg({ width: canvas.width, height: canvas.height })], { type: 'image/jpeg' });
const oversized = () => new Blob([new Uint8Array(ENHANCE_LIMITS.imageBytes + 1)], { type: 'image/jpeg' });

afterEach(() => { vi.unstubAllGlobals(); });

describe('cleanupSource (H0 and R)', () => {
  it('builds a checked 4:5 H0 of the original pixels in the BG2a frame, with R and the geometry', async () => {
    install(jpeg);
    const result = await cleanupSource(working, alpha, size, plan, edit);
    expect(result).not.toBeNull();
    expect(result!.width * 5).toBe(result!.height * 4);
    expect(Math.max(result!.width, result!.height)).toBeLessThanOrEqual(ENHANCE_LIMITS.imageMaxSide);
    expect(result!.main.size).toBeLessThanOrEqual(ENHANCE_LIMITS.imageBytes);
    expect(result!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.reference).toHaveLength(REFERENCE_WIDTH * REFERENCE_HEIGHT);
    expect(result!.geometry).toEqual({ edit, source: plan.source, dest: plan.dest, canvas: plan.canvas });
    // The frame canvas gets the unmasked working pixels source -> dest, exactly as H1's frame.
    const { source, dest } = plan;
    expect(created[0]!.drawn).toEqual([[working, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height]]);
    expect(created.every((canvas) => canvas.width === 1 && canvas.height === 1)).toBe(true);
  });

  it('gives null when the encoder returns nothing', async () => {
    install(() => null);
    await expect(cleanupSource(working, alpha, size, plan, edit)).resolves.toBeNull();
  });

  it('gives null when every attempt stays over the enhancement byte limit', async () => {
    install(oversized);
    await expect(cleanupSource(working, alpha, size, plan, edit)).resolves.toBeNull();
  });

  it('gives null when a downscale leaves a size that is not exactly 4:5', async () => {
    // Walk the encoder's own 0.85 downscale steps from this frame to the first side whose width rounds off 4:5.
    let side = plan.canvas.height;
    while (fitDimensions(plan.canvas.width, plan.canvas.height, side).width * 5 === side * 4) side = Math.floor(side * 0.85);
    expect(side).toBeGreaterThanOrEqual(800);
    const sides: number[] = [];
    install((canvas) => { sides.push(canvas.height); return canvas.height > side ? oversized() : jpeg(canvas); });
    await expect(cleanupSource(working, alpha, size, plan, edit)).resolves.toBeNull();
    expect(sides.at(-1)).toBe(side);
  });

  it('gives null when the bytes are not an admitted photo input (progressive)', async () => {
    install((canvas) => new Blob([flatJpeg({ width: canvas.width, height: canvas.height, mode: 'progressive' })], { type: 'image/jpeg' }));
    await expect(cleanupSource(working, alpha, size, plan, edit)).resolves.toBeNull();
  });

  it('rethrows an abort instead of returning null', async () => {
    const controller = new AbortController();
    install((canvas) => { controller.abort(); return jpeg(canvas); });
    await expect(cleanupSource(working, alpha, size, plan, edit, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
