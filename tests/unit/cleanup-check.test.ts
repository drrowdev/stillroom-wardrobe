// BG2c (plan rev4 §5): the clean-up check on synthetic 256x320 frames. It is a gross-change filter: the "accepted"
// cases for kept interior clutter and a similar-colour substitution are the documented blind spots, asserted as such so
// the limitation stays visible. No case here is activation evidence.
import { describe, expect, it } from 'vitest';
import { CLEANUP, cleanupCheck, FIDELITY, morph } from '../../src/images/fidelity';

type Rgb = readonly [number, number, number];
type Box = { left: number; top: number; right: number; bottom: number };
const { width: W, height: H } = FIDELITY;
const N = W * H;
const BG: Rgb = [0xf6, 0xf3, 0xed];
const NAVY: Rgb = [30, 45, 90];
const RED: Rgb = [150, 40, 40];
const inBox = (b: Box, x: number, y: number) => x >= b.left && x < b.right && y >= b.top && y < b.bottom;
function frame(paint: (x: number, y: number) => Rgb | null): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(N * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const colour = paint(x, y) ?? BG, at = (y * W + x) * 4;
    pixels[at] = colour[0]; pixels[at + 1] = colour[1]; pixels[at + 2] = colour[2]; pixels[at + 3] = 255;
  }
  return pixels;
}
function mask(on: (x: number, y: number) => boolean): Uint8Array {
  const out = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = on(x, y) ? 1 : 0;
  return out;
}
const GARMENT: Box = { left: 53, top: 60, right: 203, bottom: 260 };
// A little texture, so SSIM windows carry structure.
const textured = (colour: Rgb) => (x: number, y: number): Rgb => ((x >> 2) + (y >> 2)) % 2 ? colour : [colour[0] + 12, colour[1] + 12, colour[2] + 12];
const garment = (b: Box = GARMENT, colour: Rgb = NAVY) => (x: number, y: number) => inBox(b, x, y) ? textured(colour)(x, y) : null;
const R = mask((x, y) => inBox(GARMENT, x, y));
const H0 = frame(garment());
const verdict = (h2: Uint8ClampedArray, h0 = H0, r = R) => cleanupCheck(h0, r, h2);

describe('clean-up check: accepts and reports', () => {
  it('accepts an unchanged garment with fixed buffers and every metric', () => {
    const result = verdict(H0.slice());
    expect(result.accepted).toBe(true);
    expect(result.metrics).toMatchObject({ ringDeltaE: 0, ringP95: 0, containment: 1, retention: 1, largestShare: 1,
      meanDeltaE: 0, p95DeltaE: 0 });
    expect(result.metrics.ssim).toBeCloseTo(1, 6);
    // Two Lab Float32Array(3N), five Uint8Array(N), a Float32Array(N), two Int32Array(N): 41 B per pixel, about 3.36 MB.
    expect(result.metrics.workingBytes).toBe(N * (12 + 12 + 5 + 4 + 4 + 4));
    expect(result.metrics.workingBytes).toBeLessThan(3.4e6);
  });

  it('excludes background-dominated and edge windows from SSIM', () => {
    const result = verdict(H0.slice());
    const all = Math.floor((W - 8) / 4 + 1) * Math.floor((H - 8) / 4 + 1);
    expect(result.metrics.windows).toBeGreaterThanOrEqual(CLEANUP.minimumWindows);
    expect(result.metrics.windows).toBeLessThan(all);
    // K is the eroded interior, so the admitted windows lie inside the garment box.
    expect(result.metrics.windows).toBeLessThanOrEqual(Math.floor((150 - 8) / 4 + 1) * Math.floor((200 - 8) / 4 + 1));
  });

  it('accepts removed hangers and a removed large neighbour that were inside R', () => {
    const neighbour: Box = { left: 203, top: 80, right: 250, bottom: 240 };
    const hanger: Box = { left: 120, top: 30, right: 136, bottom: 60 };
    const wide = mask((x, y) => inBox(GARMENT, x, y) || inBox(neighbour, x, y) || inBox(hanger, x, y));
    const cluttered = frame((x, y) => inBox(neighbour, x, y) ? RED : inBox(hanger, x, y) ? [90, 90, 90] : garment()(x, y));
    const result = verdict(H0.slice(), cluttered, wide);
    expect(result).toMatchObject({ accepted: true });
    expect(result.metrics.retention).toBeLessThan(1);
  });

  it('documented blind spot: clutter kept inside R is accepted', () => {
    const hanger: Box = { left: 120, top: 70, right: 136, bottom: 90 };
    const kept = frame((x, y) => inBox(hanger, x, y) ? [90, 90, 90] : garment()(x, y));
    expect(verdict(kept, kept)).toMatchObject({ accepted: true });
  });

  it('documented blind spot: a similar-colour substitute in the same place is accepted', () => {
    // A differently shaped garment (a notch cut into the shoulder) in the same colours passes: not identity proof.
    const notch: Box = { left: 53, top: 60, right: 90, bottom: 90 };
    const substitute = frame((x, y) => inBox(notch, x, y) ? null : garment()(x, y));
    expect(verdict(substitute)).toMatchObject({ accepted: true });
  });

  it('accepts a target that keeps at least 20 % of a larger R, and rejects one that keeps less', () => {
    const big: Box = { left: 20, top: 20, right: 236, bottom: 300 };
    const wide = mask((x, y) => inBox(big, x, y));
    const rArea = 216 * 280;
    const keeps = (side: number): Box => ({ left: 128 - side / 2, top: 160 - side / 2, right: 128 + side / 2, bottom: 160 + side / 2 });
    const kept = keeps(124); // 15,376 px, 25 % of R
    const accepted = verdict(frame(garment(kept)), frame(garment(big)), wide);
    expect(accepted).toMatchObject({ accepted: true });
    expect(accepted.metrics.retention).toBeCloseTo(124 * 124 / rArea, 6);
    expect(accepted.metrics.retention).toBeLessThan(0.5);
    const lost = verdict(frame(garment(keeps(100))), frame(garment(big)), wide);
    expect(lost).toMatchObject({ accepted: false, reason: 'retention' });
  });

  it('accepts a garment with a hole', () => {
    const hole: Box = { left: 110, top: 130, right: 146, bottom: 170 };
    const holed = frame((x, y) => inBox(hole, x, y) ? null : garment()(x, y));
    expect(verdict(holed, holed)).toMatchObject({ accepted: true });
  });
});

describe('clean-up check: every reason fails closed', () => {
  it('size', () => {
    expect(cleanupCheck(new Uint8ClampedArray(4), R, H0)).toMatchObject({ accepted: false, reason: 'size' });
    expect(cleanupCheck(H0, new Uint8Array(N - 1), H0)).toMatchObject({ accepted: false, reason: 'size' });
  });

  it('background: a non-plain or wrong-colour perimeter', () => {
    const noisy = frame((x, y) => (x < 6 || y < 6 || x >= W - 6 || y >= H - 6) && (x + y) % 3 === 0 ? [120, 110, 100] : garment()(x, y));
    expect(verdict(noisy)).toMatchObject({ accepted: false, reason: 'background' });
    const grey = frame((x, y) => garment()(x, y) ?? [200, 200, 200]);
    expect(verdict(grey)).toMatchObject({ accepted: false, reason: 'background' });
  });

  it('emptyMask, tinyMask, and a cream garment that the mask cannot see', () => {
    expect(verdict(frame(() => null))).toMatchObject({ accepted: false, reason: 'emptyMask' });
    expect(verdict(frame(garment({ left: 120, top: 150, right: 140, bottom: 170 })))).toMatchObject({ accepted: false, reason: 'tinyMask' });
    const cream = frame((x, y) => inBox(GARMENT, x, y) ? [242, 238, 228] : null);
    expect(verdict(cream, cream).accepted).toBe(false);
  });

  it('ambiguousMask: the result touches all four edges', () => {
    const cross = frame((x, y) => (x >= 124 && x < 132) || (y >= 156 && y < 164) ? NAVY : garment()(x, y));
    expect(verdict(cross)).toMatchObject({ accepted: false, reason: 'ambiguousMask' });
  });

  it('pieces: a result split in two, and more components than the cap', () => {
    const left: Box = { left: 40, top: 60, right: 120, bottom: 260 }, right: Box = { left: 136, top: 60, right: 216, bottom: 260 };
    const wide = mask((x, y) => x >= 36 && x < 220 && y >= 56 && y < 264);
    const split = frame((x, y) => garment(left)(x, y) ?? garment(right)(x, y));
    expect(verdict(split, frame(garment({ left: 40, top: 60, right: 216, bottom: 260 })), wide))
      .toMatchObject({ accepted: false, reason: 'pieces' });
    const dots = frame((x, y) => x >= 10 && x < 246 && y >= 10 && y < 310 && x % 2 === 0 && y % 2 === 0 ? NAVY : null);
    expect(verdict(dots, dots, mask(() => true))).toMatchObject({ accepted: false, reason: 'pieces' });
  });

  it('containment: a zoom or shift draws content outside BG1 region', () => {
    const shifted = frame(garment({ left: 83, top: 60, right: 233, bottom: 260 }));
    expect(verdict(shifted)).toMatchObject({ accepted: false, reason: 'containment' });
    const zoomed = frame(garment({ left: 33, top: 35, right: 223, bottom: 285 }));
    expect(verdict(zoomed)).toMatchObject({ accepted: false, reason: 'containment' });
  });

  it('centre: the kept garment is off centre', () => {
    const offBox: Box = { left: 12, top: 60, right: 90, bottom: 260 };
    const wide = mask((x, y) => inBox(offBox, x, y) || inBox(GARMENT, x, y));
    const off = frame(garment(offBox));
    const result = verdict(off, frame((x, y) => garment(offBox)(x, y) ?? garment()(x, y)), wide);
    expect(result).toMatchObject({ accepted: false, reason: 'centre' });
    expect(result.metrics.centroid!.x).toBeLessThan(0.25);
  });

  it('support: narrow straps leave no interior to compare', () => {
    const strap = (x: number, y: number) => (y >= 60 && y < 62 && x >= 53 && x < 203) || (y >= 60 && y < 260 && x >= 53 && x < 203 && x % 12 < 2);
    const straps = frame((x, y) => strap(x, y) ? NAVY : null);
    expect(verdict(straps, straps, mask(strap))).toMatchObject({ accepted: false, reason: 'support' });
  });

  it('colour: a hue shift over the supported interior', () => {
    expect(verdict(frame(garment(GARMENT, [90, 30, 45])))).toMatchObject({ accepted: false, reason: 'colour' });
  });

  it('structure: an inverted fine pattern with a small colour difference', () => {
    const A: Rgb = [50, 50, 50], B: Rgb = [62, 62, 62];
    const check = (invert: boolean) => frame((x, y) => inBox(GARMENT, x, y) ? ((x + y) % 2 === (invert ? 1 : 0) ? A : B) : null);
    const result = verdict(check(true), check(false));
    expect(result).toMatchObject({ accepted: false, reason: 'structure' });
    expect(result.metrics.meanDeltaE).toBeLessThanOrEqual(CLEANUP.maximumMeanDeltaE);
  });

  it('nonFinite is a defensive guard: byte inputs cannot produce NaN, and none of the cases above reports it', () => {
    for (const h2 of [H0, frame(() => null), frame(() => [0, 0, 0])]) expect((verdict(h2) as { reason?: string }).reason).not.toBe('nonFinite');
  });
});

describe('square morphology at the frame border', () => {
  const size = 8, tmp = new Uint8Array(size * size), out = new Uint8Array(size * size);
  it('dilation never wraps or invents content past the border', () => {
    const src = new Uint8Array(size * size);
    src[0] = 1;
    morph(src, out, tmp, size, size, 1, false);
    expect([...out].map((value, index) => value ? index : -1).filter((index) => index >= 0)).toEqual([0, 1, 8, 9]);
  });
  it('erosion counts outside pixels as background, so a full frame loses its border band', () => {
    morph(new Uint8Array(size * size).fill(1), out, tmp, size, size, 2, true);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      expect(out[y * size + x], `${x},${y}`).toBe(x >= 2 && x < size - 2 && y >= 2 && y < size - 2 ? 1 : 0);
    }
  });
});
