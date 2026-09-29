// BG2c (plan rev4 §4.1, §13): H0 is built from the frame canvas, app-re-encoded, admitted by isPhotoInputJpeg, and every
// failure except an abort gives null so H1 is kept. A canvas shim stands in for the browser encoder.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { framePlan, REFERENCE_HEIGHT, REFERENCE_WIDTH } from '../../src/images/background/frame';
import { MASK_SIDE } from '../../src/images/background/mask';
import { cleanupSource, prepareSegmentedSource } from '../../src/images/process-jpeg';
import { ORIGINAL_EDIT } from '../../src/images/crop';
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

// The preparation boundary (#120 review): any H0 failure, including allocating or sizing its canvas, keeps H1 and the
// preparation succeeds; an abort still rejects it. The failure is armed when the BG1 mask canvas is filled, so the next
// canvas the code allocates or sizes is H0's frame canvas.
describe('prepareSegmentedSource with clean-up', () => {
  type Failure = 'none' | 'allocate' | 'size' | 'abort';
  const controller = { current: new AbortController() };
  let armed = false;
  let allocations = 0;
  function installPreparation(failure: Failure) {
    armed = false;
    allocations = 0;
    controller.current = new AbortController();
    const context = (shim: { width: number; height: number }) => ({
      fillRect: () => undefined, setTransform: () => undefined, drawImage: () => undefined,
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
      putImageData: () => { if (failure !== 'none') armed = true; void shim; },
    });
    vi.stubGlobal('document', {
      createElement: () => {
        allocations += 1;
        if (armed && failure === 'allocate') { armed = false; throw new RangeError('canvas allocation failed'); }
        let width = 0, height = 0;
        const shim = {
          get width() { return width; },
          set width(value: number) {
            if (armed && failure === 'size' && value > 1) { armed = false; throw new RangeError('canvas too large'); }
            width = value;
          },
          get height() { return height; },
          set height(value: number) { height = value; },
          getContext: () => context(shim),
          toBlob: (done: (blob: Blob | null) => void) => {
            if (armed && failure === 'abort') controller.current.abort();
            queueMicrotask(() => done(jpeg(shim as unknown as Shim)));
          },
        };
        return shim;
      },
    });
    vi.stubGlobal('createImageBitmap', async () => ({ width: size.width, height: size.height, close: () => undefined }));
    vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  }
  const segmenter = { open: async () => ({ run: async () => alpha, close: () => undefined }) };
  const prepare = (wantCleanup: boolean) => prepareSegmentedSource(
    new Blob([new Uint8Array(16)], { type: 'image/jpeg' }),
    async () => ({ blob: new Blob([new Uint8Array(16)], { type: 'image/jpeg' }), width: size.width, height: size.height, orientation: 1 }),
    ORIGINAL_EDIT, controller.current.signal, segmenter, false, wantCleanup,
  );

  it('builds H0 alongside H1 when nothing fails', async () => {
    installPreparation('none');
    const result = await prepare(true);
    expect(result.framed).toBe(true);
    expect(result.cleanup).not.toBeNull();
    expect(result.photo.mainSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['allocate', 'size'] as const)('keeps H1 and succeeds when H0 canvas %s fails', async (failure) => {
    installPreparation(failure);
    const result = await prepare(true);
    expect(armed).toBe(false); // The failure really fired.
    expect(result.cleanup).toBeNull();
    expect(result.framed).toBe(true);
    expect(result.photo.main.size).toBeGreaterThan(0);
    expect(result.photo.mainSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not allocate an H0 canvas unless clean-up is asked for', async () => {
    installPreparation('none');
    await prepare(false);
    const without = allocations;
    installPreparation('none');
    await prepare(true);
    expect(allocations).toBe(without + 2);
  });

  it('still rejects the preparation when it is aborted while H0 is built', async () => {
    installPreparation('abort');
    await expect(prepare(true)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
