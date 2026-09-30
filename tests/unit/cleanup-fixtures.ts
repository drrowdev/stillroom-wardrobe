// BG2c-3 (plan rev8 §4): the synthetic fixture generator for the clean-up check. Scenes are painted in CIELAB and
// converted to 8-bit sRGB here (test code only). H0's background is seeded grey clutter (L* 60-80), as in the sketches;
// H2's background is the BG2a canvas colour. Every random draw comes from a seeded mulberry32, so fixtures are fixed.
import { CLEANUP_GENERATOR } from '../../src/images/cleanup-calibration';
import { expect } from 'vitest';
import { cleanupCheck, FIDELITY, type CleanupReason, type CleanupVerdict } from '../../src/images/fidelity';
import { beyondFail, passViolations } from './cleanup-margins';

export type Lab = readonly [number, number, number];
export type Paint = (x: number, y: number) => Lab | null;
export type Box = { left: number; top: number; width: number; height: number };
export const W = FIDELITY.width, H = FIDELITY.height, N = W * H;
export const CX = W / 2, CY = H / 2;
export const GARMENT: Box = { ...CLEANUP_GENERATOR.garment };

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CIELAB (D65) to 8-bit sRGB, rounded and clamped. */
export function srgb([L, a, b]: Lab): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27);
  const x = 0.95047 * inv(fx), y = L > 8 ? fy ** 3 : L / (24389 / 27), z = 1.08883 * inv(fz);
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const gamma = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(v * 255)));
  };
  return [gamma(lr), gamma(lg), gamma(lb)];
}
/** 8-bit sRGB to CIELAB (D65); `srgb(fromRgb(c))` returns c. */
export function fromRgb(r: number, g: number, b: number): Lab {
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export const lch = (L: number, C: number, h: number): Lab => [L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180)];
export const grey = (L: number): Lab => [L, 0, 0];
export const inBox = (box: Box, x: number, y: number) => x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
export const union = (...boxes: Box[]) => (x: number, y: number) => boxes.some((box) => inBox(box, x, y));

const BG = CLEANUP_GENERATOR.background;
/** Clutter for H0's background: seeded neutral L* 60-80 in 4 px blocks. */
function clutter(seed: number): (x: number, y: number) => Lab {
  const random = mulberry32(seed), cells = new Float32Array((W / 4) * (H / 4));
  for (let index = 0; index < cells.length; index++) cells[index] = 60 + 20 * random();
  return (x, y) => grey(cells[(y >> 2) * (W / 4) + (x >> 2)]!);
}
function raster(paint: Paint, background: (x: number, y: number) => Lab | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lab = paint(x, y) ?? background(x, y);
    const rgb: readonly [number, number, number] = lab ? srgb(lab) : [BG[0]!, BG[1]!, BG[2]!];
    const at = (y * W + x) * 4;
    out[at] = rgb[0]; out[at + 1] = rgb[1]; out[at + 2] = rgb[2]; out[at + 3] = 255;
  }
  return out;
}
/** H0: the garment on seeded clutter. */
export const h0Of = (paint: Paint, seed = 1) => raster(paint, clutter(seed));
/** H2: the result on the plain canvas colour. */
export const h2Of = (paint: Paint) => raster(paint, () => null);
export function maskOf(on: (x: number, y: number) => boolean): Uint8Array {
  const out = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = on(x, y) ? 1 : 0;
  return out;
}

/** Paint restricted to an outline. */
export const within = (on: (x: number, y: number) => boolean, colour: (x: number, y: number) => Lab): Paint =>
  (x, y) => on(x, y) ? colour(x, y) : null;
export const solid = (box: Box, colour: Lab): Paint => within((x, y) => inBox(box, x, y), () => colour);

/** Adds seeded uniform noise of amplitude `amplitude` to L*, a* and b* of every painted pixel. */
export function noisy(paint: Paint, amplitude: number, seed: number): Paint {
  const random = mulberry32(seed), table = new Float32Array(N * 3);
  for (let index = 0; index < table.length; index++) table[index] = (2 * random() - 1) * amplitude;
  return (x, y) => {
    const lab = paint(x, y);
    if (!lab) return null;
    const at = (y * W + x) * 3;
    return [lab[0] + table[at]!, lab[1] + table[at + 1]!, lab[2] + table[at + 2]!];
  };
}
/** A global lighting change: +dL, a hue rotation of `hue` degrees and a chroma gain. */
export function relit(paint: Paint, dL: number, hue = 0, gain = 1): Paint {
  const c = Math.cos(hue * Math.PI / 180) * gain, s = Math.sin(hue * Math.PI / 180) * gain;
  return (x, y) => {
    const lab = paint(x, y);
    return lab ? [lab[0] + dL, lab[1] * c - lab[2] * s, lab[1] * s + lab[2] * c] : null;
  };
}
/** A linear-RGB exposure gain, applied through sRGB. */
export function gained(paint: Paint, gain: number): Paint {
  return (x, y) => {
    const lab = paint(x, y);
    if (!lab) return null;
    const Y = lab[0] > 8 ? ((lab[0] + 16) / 116) ** 3 : lab[0] / (24389 / 27);
    const Y2 = Math.min(1, Y * gain);
    const L2 = Y2 > 216 / 24389 ? 116 * Math.cbrt(Y2) - 16 : Y2 * 24389 / 27;
    return [L2, lab[1], lab[2]];
  };
}
/**
 * The result shows the scene zoomed by `zoom` about the frame centre and shifted by (dx, dy), with nearest sampling:
 * H2(p) = scene(c + (p + 0.5 - c - d) / zoom).
 */
export function posed(paint: Paint, zoom: number, dx = 0, dy = 0): Paint {
  return (x, y) => {
    const sx = Math.floor(CX + (x + 0.5 - CX - dx) / zoom), sy = Math.floor(CY + (y + 0.5 - CY - dy) / zoom);
    return sx < 0 || sx >= W || sy < 0 || sy >= H ? null : paint(sx, sy);
  };
}
/** Vertical bands across the garment: `every` px apart from `from`, `size` px wide. */
export const bandAt = (x: number, size: number, every: number, from = GARMENT.left) => ((x - from) % every + every) % every < size;
/** The sketches' crease field: valleys of depth `depth` at the base colour, vertical, rows 72-247. */
export function creased(box: Box, base: Lab, depth: number, size: number, every: number, valley?: (lab: Lab) => Lab): Paint {
  return within((x, y) => inBox(box, x, y), (x, y) => {
    if (y < 72 || y >= 248 || !bandAt(x, size, every, box.left)) return base;
    const dark: Lab = [base[0] - depth, base[1], base[2]];
    return valley ? valley(dark) : dark;
  });
}

/** Runs the check on painted scenes with no yielding (the verdict doesn't depend on yielding; see the determinism test). */
export async function checkScenes(h0: Paint, h2: Paint, reference: Uint8Array = GARMENT_MASK, seed = 1) {
  return cleanupCheck(h0Of(h0, seed), reference, h2Of(h2), { yieldNow: async () => undefined, now: () => 0 });
}
export const GARMENT_MASK = maskOf((x, y) => inBox(GARMENT, x, y));
const describeMetrics = (v: CleanupVerdict) => JSON.stringify({ ...v.metrics, modes: undefined });
/** An Accept fixture: passes, with every gate inside its §5.2 pass band. */
export function expectAccepted(v: CleanupVerdict): void {
  expect(v.accepted, describeMetrics(v)).toBe(true);
  expect(passViolations(v.metrics), describeMetrics(v)).toEqual([]);
}
/** A Block fixture: fails for one of `reasons`, with one of them beyond its §5.2 fail band. */
export function expectBlocked(v: CleanupVerdict, reasons: readonly CleanupReason[]): void {
  expect(v.accepted, describeMetrics(v)).toBe(false);
  expect(reasons, describeMetrics(v)).toContain((v as { reason: CleanupReason }).reason);
  expect(reasons.some((reason) => beyondFail(v.metrics, reason)), describeMetrics(v)).toBe(true);
}

const inGarment = (x: number, y: number) => inBox(GARMENT, x, y);
/** The critic's chromatic stripe (period 41): red, border, peach, border at 17/4/17/3 px. */
export const criticStripe = (): Paint => within(inGarment, (x) => {
  const u = (x - GARMENT.left) % 41;
  return u < 17 ? lch(20, 30, 0) : u < 21 ? lch(50, 30, 30) : u < 38 ? lch(80, 30, 60) : lch(50, 30, 30);
});
/** The green/teal check: 16 px squares, 50° of hue apart, L45/55, C35. */
export const greenTealCheck = (): Paint => within(inGarment, (x, y) =>
  (((x - GARMENT.left) >> 4) + ((y - GARMENT.top) >> 4)) % 2 === 0 ? lch(45, 35, 150) : lch(55, 35, 200));
