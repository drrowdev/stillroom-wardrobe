// BG2c (plan rev4 §4.2–§4.3): R on the frame grid, 4-connected components and the on-device ambiguity rule.
import { describe, expect, it } from 'vitest';
import {
  ambiguousReference, framePlan, labelComponents, MAX_COMPONENTS, REFERENCE_HEIGHT, REFERENCE_WIDTH, referenceMask, type FramePlan,
} from '../../src/images/background/frame';
import { MASK_SIDE } from '../../src/images/background/mask';

const box = (x0: number, y0: number, x1: number, y1: number, alpha = new Float32Array(MASK_SIDE * MASK_SIDE), value = 1) => {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) alpha[y * MASK_SIDE + x] = value;
  return alpha;
};
const N = REFERENCE_WIDTH * REFERENCE_HEIGHT;
const grid = (on: (x: number, y: number) => boolean) => {
  const out = new Uint8Array(N);
  for (let y = 0; y < REFERENCE_HEIGHT; y++) for (let x = 0; x < REFERENCE_WIDTH; x++) out[y * REFERENCE_WIDTH + x] = on(x, y) ? 1 : 0;
  return out;
};
const count = (mask: Uint8Array) => mask.reduce((sum, value) => sum + value, 0);

describe('referenceMask', () => {
  it('maps a known alpha through the frame plan onto the 256 x 320 grid, with nothing outside dest', () => {
    const alpha = box(100, 80, 220, 240);
    const plan = framePlan(alpha, 1280, 1280)!;
    const r = referenceMask(alpha, 1280, 1280, plan)!;
    expect(r).toHaveLength(N);
    const cellW = plan.canvas.width / REFERENCE_WIDTH, cellH = plan.canvas.height / REFERENCE_HEIGHT;
    const maskInFrame = (mx: number, my: number) => ({
      x: plan.dest.x + (mx * 1280 / MASK_SIDE - plan.source.x) * plan.dest.width / plan.source.width,
      y: plan.dest.y + (my * 1280 / MASK_SIDE - plan.source.y) * plan.dest.height / plan.source.height,
    });
    const topLeft = maskInFrame(100, 80), bottomRight = maskInFrame(220, 240);
    for (let gy = 0; gy < REFERENCE_HEIGHT; gy++) for (let gx = 0; gx < REFERENCE_WIDTH; gx++) {
      const x0 = gx * cellW, x1 = (gx + 1) * cellW, y0 = gy * cellH, y1 = (gy + 1) * cellH;
      const inside = x0 >= topLeft.x && x1 <= bottomRight.x && y0 >= topLeft.y && y1 <= bottomRight.y;
      const outside = x1 <= topLeft.x || x0 >= bottomRight.x || y1 <= topLeft.y || y0 >= bottomRight.y;
      if (inside) expect(r[gy * REFERENCE_WIDTH + gx], `${gx},${gy}`).toBe(1);
      if (outside) expect(r[gy * REFERENCE_WIDTH + gx], `${gx},${gy}`).toBe(0);
    }
  });

  it('keeps cells outside dest at 0 even when the mask is full there', () => {
    const alpha = box(0, 0, MASK_SIDE, MASK_SIDE);
    const plan: FramePlan = { source: { x: 0, y: 0, width: 1000, height: 1000 }, canvas: { width: 1280, height: 1600 },
      dest: { x: 140, y: 300, width: 1000, height: 1000 } };
    const r = referenceMask(alpha, 1000, 1000, plan)!;
    const cellW = 1280 / REFERENCE_WIDTH, cellH = 1600 / REFERENCE_HEIGHT;
    for (let gy = 0; gy < REFERENCE_HEIGHT; gy++) for (let gx = 0; gx < REFERENCE_WIDTH; gx++) {
      const x1 = (gx + 1) * cellW, y1 = (gy + 1) * cellH, x0 = gx * cellW, y0 = gy * cellH;
      if (x1 <= 140 || x0 >= 1140 || y1 <= 300 || y0 >= 1300) expect(r[gy * REFERENCE_WIDTH + gx]).toBe(0);
    }
    expect(count(r)).toBeGreaterThan(0);
  });

  it('does not depend on the working size (downscale invariance)', () => {
    const alpha = box(60, 40, 200, 280);
    const big = referenceMask(alpha, 1280, 1600, framePlan(alpha, 1280, 1600)!)!;
    const small = referenceMask(alpha, 640, 800, framePlan(alpha, 640, 800)!)!;
    let differ = 0;
    for (let index = 0; index < N; index++) differ += big[index] !== small[index] ? 1 : 0;
    expect(differ / count(big)).toBeLessThan(0.02);
  });

  it('refuses a wrong alpha length or a degenerate plan', () => {
    const plan = framePlan(box(60, 40, 200, 280), 800, 1000)!;
    expect(referenceMask(new Float32Array(10), 800, 1000, plan)).toBeNull();
    expect(referenceMask(box(60, 40, 200, 280), 0, 1000, plan)).toBeNull();
    expect(referenceMask(box(60, 40, 200, 280), 800, 1000, { ...plan, dest: { ...plan.dest, width: 0 } })).toBeNull();
  });
});

describe('components and the ambiguity rule', () => {
  it('labels 4-connected regions only (diagonals are separate)', () => {
    const mask = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 1, 0]);
    const found = labelComponents(mask, 3, 3, new Int32Array(9), new Int32Array(9));
    // 1 0 1 / 0 1 0 / 1 1 0: the two top corners touch the centre only diagonally; the centre joins the bottom row.
    expect(found.count).toBe(3);
    expect([...found.areas].sort()).toEqual([1, 1, 3]);
  });

  it('stops above the component cap', () => {
    const dots = grid((x, y) => x % 2 === 0 && y % 2 === 0);
    expect(labelComponents(dots, REFERENCE_WIDTH, REFERENCE_HEIGHT, new Int32Array(N), new Int32Array(N)))
      .toMatchObject({ count: MAX_COMPONENTS, overflow: true });
  });

  it('one region is not ambiguous; two comparable separate regions are; a small detached strap is not', () => {
    expect(ambiguousReference(grid((x, y) => x >= 60 && x < 196 && y >= 60 && y < 260))).toBe(false);
    expect(ambiguousReference(grid((x, y) => y >= 60 && y < 260 && ((x >= 20 && x < 110) || (x >= 140 && x < 220))))).toBe(true);
    expect(ambiguousReference(grid((x, y) => (x >= 60 && x < 196 && y >= 60 && y < 260) || (x >= 210 && x < 220 && y >= 60 && y < 160))))
      .toBe(false);
  });

  it('touching neighbours merge into one region and are NOT detected (disclosed)', () => {
    expect(ambiguousReference(grid((x, y) => y >= 60 && y < 260 && x >= 20 && x < 220))).toBe(false);
  });

  it('treats an empty or wrong-sized R as not available', () => {
    expect(ambiguousReference(new Uint8Array(N))).toBe(true);
    expect(ambiguousReference(new Uint8Array(10))).toBe(true);
  });
});
