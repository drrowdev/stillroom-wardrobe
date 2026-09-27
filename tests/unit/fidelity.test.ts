// BG2b (M1): the heuristic on synthetic 256x320 frames. It rejects some large changes and fails closed when unsure;
// the "passes" cases for small local changes are the documented blind spots, not fidelity.
import { describe, expect, it } from 'vitest';
import { compareEnhancement, deltaE2000, FIDELITY } from '../../src/images/fidelity';

type Rgb = readonly [number, number, number];
const { width: W, height: H } = FIDELITY;
const BG: Rgb = [0xf6, 0xf3, 0xed];
function frame(paint: (x: number, y: number) => Rgb | null): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const colour = paint(x, y) ?? BG, at = (y * W + x) * 4;
    pixels[at] = colour[0]; pixels[at + 1] = colour[1]; pixels[at + 2] = colour[2]; pixels[at + 3] = 255;
  }
  return pixels;
}
const rect = (colour: Rgb, dx = 0, dy = 0, box = { left: 53, top: 60, right: 203, bottom: 260 }) =>
  (x: number, y: number): Rgb | null =>
    x >= box.left + dx && x < box.right + dx && y >= box.top + dy && y < box.bottom + dy ? colour : null;
const NAVY: Rgb = [30, 45, 90];
const garment = frame(rect(NAVY));

describe('CIEDE2000', () => {
  it('matches the Sharma, Wu and Dalal reference pairs', () => {
    expect(deltaE2000(50, 2.6772, -79.7751, 50, 0, -82.7485)).toBeCloseTo(2.0425, 4);
    expect(deltaE2000(50, -1, 2, 50, 0, 0)).toBeCloseTo(2.3669, 4);
    expect(deltaE2000(50, 2.5, 0, 73, 25, -18)).toBeCloseTo(27.1492, 4);
    expect(deltaE2000(2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514)).toBeCloseTo(0.9082, 4);
    expect(deltaE2000(60, 0, 0, 60, 0, 0)).toBe(0);
  });
});

describe('heuristic rejection of some large changes', () => {
  it('accepts an unchanged photo and reports its linear working memory', () => {
    const verdict = compareEnhancement(garment, garment.slice());
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics).toMatchObject({ iou: 1, meanDeltaE: 0, p95DeltaE: 0, ssim: 1 });
    // Seven typed arrays over 81,920 pixels: 3,112,960 B. The plan's 2.8 MB estimate left out the ΔE buffer.
    expect(verdict.metrics.workingBytes).toBe(W * H * (12 + 12 + 1 + 1 + 4 + 4 + 4));
    expect(verdict.metrics.workingBytes).toBeLessThan(3.2e6);
  });

  it('rejects a global hue shift and a silhouette change', () => {
    expect(compareEnhancement(garment, frame(rect([90, 30, 45])))).toMatchObject({ accepted: false, reason: 'colour' });
    expect(compareEnhancement(garment, frame(rect(NAVY, 0, 0, { left: 53, top: 60, right: 203, bottom: 180 }))))
      .toMatchObject({ accepted: false, reason: 'overlap' });
  });

  it('tolerates a 2 px shift and rejects an 8 px one (no alignment search)', () => {
    expect(compareEnhancement(garment, frame(rect(NAVY, 2, 0))).accepted).toBe(true);
    expect(compareEnhancement(garment, frame(rect(NAVY, 8, 0)))).toMatchObject({ accepted: false, reason: 'overlap' });
  });

  it('keeps a pattern that did not change and rejects one that did', () => {
    const stripes = (phase: number) => (x: number, y: number): Rgb | null =>
      rect(NAVY)(x, y) && ((y + phase) >> 3) % 2 ? [200, 40, 40] : rect(NAVY)(x, y);
    const striped = frame(stripes(0));
    expect(compareEnhancement(striped, striped.slice()).accepted).toBe(true);
    const moved = compareEnhancement(striped, frame(stripes(8)));
    expect(moved.accepted).toBe(false);
  });

  it('accepts a soft shadow outside the garment that stays near the background', () => {
    const shadow = frame((x, y) => rect(NAVY)(x, y) ?? (x >= 203 && x < 209 && y >= 66 && y < 266 ? [240, 237, 230] : null));
    expect(compareEnhancement(garment, shadow).accepted).toBe(true);
  });

  it('documents its blind spots: a small colour patch or logo change passes', () => {
    const patch = frame((x, y) => (x >= 120 && x < 130 && y >= 140 && y < 150 ? [200, 170, 40] : rect(NAVY)(x, y)));
    expect(compareEnhancement(garment, patch).accepted).toBe(true);
    const logo = (colour: Rgb) => frame((x, y) => (x >= 110 && x < 146 && y >= 90 && y < 102 ? colour : rect(NAVY)(x, y)));
    expect(compareEnhancement(logo([240, 240, 240]), logo([230, 60, 60])).accepted).toBe(true);
  });

  it('fails closed on white or cream garments against the cream background', () => {
    expect(compareEnhancement(frame(rect([250, 248, 243])), frame(rect([250, 248, 243]))))
      .toMatchObject({ accepted: false, reason: 'emptyMask' });
    expect(compareEnhancement(frame(rect([236, 230, 218])), frame(rect([236, 230, 218])))).toMatchObject({ accepted: false });
  });

  it('fails closed on empty, tiny or ambiguous masks, no SSIM window and the wrong size', () => {
    const empty = frame(() => null);
    expect(compareEnhancement(empty, empty)).toMatchObject({ accepted: false, reason: 'emptyMask' });
    const tiny = frame(rect(NAVY, 0, 0, { left: 100, top: 100, right: 120, bottom: 120 }));
    expect(compareEnhancement(tiny, tiny)).toMatchObject({ accepted: false, reason: 'tinyMask' });
    const full = frame(() => NAVY);
    expect(compareEnhancement(full, full)).toMatchObject({ accepted: false, reason: 'ambiguousMask' });
    const bar = frame(rect(NAVY, 0, 0, { left: 0, top: 150, right: 256, bottom: 157 }));
    expect(compareEnhancement(bar, bar)).toMatchObject({ accepted: false, reason: 'nonFinite' });
    expect(compareEnhancement(new Uint8ClampedArray(16), garment)).toMatchObject({ accepted: false, reason: 'size' });
  });
});
