import { describe, expect, it } from 'vitest';
import { FRAME_PADDING, framePlan, maskBox, type FramePlan } from '../../src/images/background/frame';
import { MASK_SIDE } from '../../src/images/background/mask';

// A mask with alpha 1 inside the half-open box [x0, x1) × [y0, y1) in mask pixels.
const box = (x0: number, y0: number, x1: number, y1: number, value = 1) => {
  const alpha = new Float32Array(MASK_SIDE * MASK_SIDE);
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) alpha[y * MASK_SIDE + x] = value;
  return alpha;
};
const plan = (value: FramePlan | null): FramePlan => {
  expect(value).not.toBeNull();
  return value!;
};
// The frame is 4:5, the garment is never cut off, never upscaled, and centred to the pixel.
const expectFramed = (frame: FramePlan) => {
  const { canvas, dest, source } = frame;
  expect(canvas.width * 5).toBe(canvas.height * 4);
  expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(1600);
  expect(dest.x).toBeGreaterThanOrEqual(0);
  expect(dest.y).toBeGreaterThanOrEqual(0);
  expect(dest.x + dest.width).toBeLessThanOrEqual(canvas.width);
  expect(dest.y + dest.height).toBeLessThanOrEqual(canvas.height);
  expect(dest.width).toBeLessThanOrEqual(source.width);
  expect(dest.height).toBeLessThanOrEqual(source.height);
  expect(Math.abs(dest.width / dest.height - source.width / source.height)).toBeLessThan(0.02 * source.width / source.height + 0.01);
  expect(Math.abs(canvas.width - dest.width - 2 * dest.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(canvas.height - dest.height - 2 * dest.y)).toBeLessThanOrEqual(1);
  // At least 8 % padding on both axes, and about 8 % on the limiting one.
  const padX = dest.x / canvas.width, padY = dest.y / canvas.height;
  expect(padX).toBeGreaterThanOrEqual(FRAME_PADDING - 0.005);
  expect(padY).toBeGreaterThanOrEqual(FRAME_PADDING - 0.005);
  expect(Math.min(padX, padY)).toBeLessThanOrEqual(FRAME_PADDING + 0.01);
};

describe('maskBox', () => {
  it('finds the kept box and ignores rows or columns with fewer than 3 kept pixels', () => {
    const alpha = box(100, 80, 200, 260);
    alpha[5 * MASK_SIDE + 5] = 1; alpha[5 * MASK_SIDE + 6] = 1;
    alpha[300 * MASK_SIDE + 310] = 1;
    expect(maskBox(alpha)).toEqual({ x0: 100, y0: 80, x1: 200, y1: 260 });
  });

  it('counts only alpha of 0.5 or more', () => {
    const alpha = box(0, 0, MASK_SIDE, MASK_SIDE, 0.49);
    alpha.set(box(50, 60, 150, 200).subarray(0), 0);
    expect(maskBox(box(50, 60, 150, 200, 0.49))).toBeNull();
    expect(maskBox(box(50, 60, 150, 200, 0.5))).toEqual({ x0: 50, y0: 60, x1: 150, y1: 200 });
  });

  it('returns null for an empty mask, a wrong length, or a box under 2 % of the mask', () => {
    expect(maskBox(new Float32Array(MASK_SIDE * MASK_SIDE))).toBeNull();
    expect(maskBox(new Float32Array(10))).toBeNull();
    // 45 × 45 = 2025 < 2 % of 102 400 (2048); 46 × 45 = 2070 is enough.
    expect(maskBox(box(10, 10, 55, 55))).toBeNull();
    expect(maskBox(box(10, 10, 56, 55))).not.toBeNull();
  });
});

describe('framePlan', () => {
  it('centres an off-centre garment on a 4:5 canvas with 8 % padding', () => {
    const frame = plan(framePlan(box(0, 0, 160, MASK_SIDE), 640, 800));
    expect(frame.source).toEqual({ x: 0, y: 0, width: 322, height: 800 });
    expect(frame.canvas).toEqual({ width: 764, height: 955 });
    expect(frame.dest).toEqual({ x: 221, y: 77, width: 322, height: 800 });
    expectFramed(frame);
  });

  it('adds one mask pixel of margin, clamped to the working canvas', () => {
    const frame = plan(framePlan(box(100, 100, 220, 260), 1280, 1600));
    expect(frame.source).toEqual({ x: 396, y: 495, width: 488, height: 810 });
    expectFramed(frame);
    const edge = plan(framePlan(box(0, 0, MASK_SIDE, MASK_SIDE), 1280, 1600));
    expect(edge.source).toEqual({ x: 0, y: 0, width: 1280, height: 1600 });
    expectFramed(edge);
  });

  it('never upscales a small garment', () => {
    const frame = plan(framePlan(box(140, 140, 190, 190), 640, 640));
    expect(frame.dest.width).toBe(frame.source.width);
    expect(frame.dest.height).toBe(frame.source.height);
    expect(frame.canvas.width).toBeLessThan(640);
    expectFramed(frame);
  });

  it('scales a large garment down to fit 1280 × 1600', () => {
    const frame = plan(framePlan(box(0, 0, MASK_SIDE, MASK_SIDE), 1280, 1600));
    expect(frame.canvas).toEqual({ width: 1280, height: 1600 });
    expect(frame.dest.width).toBeLessThan(frame.source.width);
    expectFramed(frame);
  });

  it('keeps a very wide garment (a scarf) whole: width limits the frame', () => {
    const frame = plan(framePlan(box(0, 150, MASK_SIDE, 170), 1600, 1600));
    expect(frame.source.width).toBe(1600);
    expect(frame.canvas).toEqual({ width: 1280, height: 1600 });
    expect(frame.dest.width).toBe(Math.round(1600 * 1280 * 0.84 / 1600));
    expect(frame.dest.x / frame.canvas.width).toBeCloseTo(FRAME_PADDING, 2);
    expect(frame.dest.y / frame.canvas.height).toBeGreaterThan(0.4);
    expectFramed(frame);
  });

  it('keeps a very tall garment (a long dress) whole: height limits the frame', () => {
    const frame = plan(framePlan(box(150, 0, 175, MASK_SIDE), 1280, 1600));
    expect(frame.source.height).toBe(1600);
    expect(frame.canvas).toEqual({ width: 1280, height: 1600 });
    expect(frame.dest.height).toBe(Math.round(1600 * 0.84));
    expect(frame.dest.y / frame.canvas.height).toBeCloseTo(FRAME_PADDING, 2);
    expect(frame.dest.x / frame.canvas.width).toBeGreaterThan(0.4);
    expectFramed(frame);
  });

  it('maps a non-square working canvas with separate x and y scales', () => {
    const frame = plan(framePlan(box(160, 0, MASK_SIDE, 160), 800, 640));
    expect(frame.source).toEqual({ x: 397, y: 0, width: 403, height: 322 });
    expectFramed(frame);
  });

  it('returns null when the box is too small to trust, so the unframed cut-out is kept', () => {
    expect(framePlan(box(10, 10, 55, 55), 640, 800)).toBeNull();
    expect(framePlan(new Float32Array(MASK_SIDE * MASK_SIDE), 640, 800)).toBeNull();
    expect(framePlan(box(0, 0, 160, MASK_SIDE), 0, 800)).toBeNull();
  });

  it('is deterministic', () => {
    const alpha = box(37, 51, 233, 289);
    expect(framePlan(alpha, 1111, 1487)).toEqual(framePlan(alpha.slice(), 1111, 1487));
  });
});
