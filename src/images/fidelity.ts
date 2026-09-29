// The shared pieces of the BG2c clean-up check (plan rev4 §5): the fixed comparison frame, CIEDE2000 and the sRGB to
// CIELAB conversion. The BG2b enhance-v1 comparison (`compareEnhancement`) was removed in BG2c-2 once the client moved to
// `cleanupCheck`. Callers resample every input to FIDELITY.width x FIDELITY.height; there is no alignment search.
import { labelComponents, MAX_COMPONENTS } from './background/frame';

export const FIDELITY = Object.freeze({
  width: 256,
  height: 320,
  /** The BG2a canvas background, #f6f3ed. */
  background: Object.freeze([0xf6, 0xf3, 0xed] as const),
  ssimWindow: 8,
  ssimStride: 4,
});

const LINEAR = (() => {
  const table = new Float32Array(256);
  for (let value = 0; value < 256; value++) {
    const c = value / 255;
    table[value] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

// IEC 61966-2-1 sRGB -> linear -> XYZ (D65) -> CIELAB.
function labOf(r: number, g: number, b: number, out: Float32Array, at: number): void {
  const lr = LINEAR[r]!, lg = LINEAR[g]!, lb = LINEAR[b]!;
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  out[at] = 116 * fy - 16;
  out[at + 1] = 500 * (fx - fy);
  out[at + 2] = 200 * (fy - fz);
}

/** CIEDE2000 (Sharma, Wu and Dalal 2005) with kL = kC = kH = 1. */
export function deltaE2000(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2);
  const dL = l2 - l1, dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * rad / 2);
  const lBar = (l1 + l2) / 2, cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hBar = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
    else hBar = (hp1 + hp2) / 2;
  }
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad)
    + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar, sh = 1 + 0.015 * cpBar * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

// BG2c (plan rev4 §5): the clean-up check. A GROSS-CHANGE FILTER, not identity or fidelity proof. It can reject a
// non-plain perimeter, content drawn outside BG1's region, a result that mostly vanished or split, a garment moved off
// centre, and large colour or structure changes where the result overlaps the original garment region. It cannot detect
// a stock-like or wrong-but-similar garment in the same place and colours, clutter kept inside R, small logo, text or
// stitching changes, or occlusion "repairs". Passing it is never activation evidence; every threshold is provisional.
export const CLEANUP = Object.freeze({
  ring: 4,
  maximumBackgroundDeltaE: 8,
  maximumRingP95: 4,
  garmentDeltaE: 6,
  minimumMaskFraction: 0.02,
  largestShare: 0.85,
  containmentRadius: 4,
  minimumContainment: 0.95,
  minimumRetention: 0.2,
  centre: Object.freeze([0.25, 0.75] as const),
  referenceErosion: 2,
  resultErosion: 1,
  minimumSupportShare: 0.25,
  maximumMeanDeltaE: 5,
  maximumP95DeltaE: 15,
  minimumWindowPixels: 48,
  minimumWindows: 16,
  minimumSsim: 0.6,
});

export type CleanupReason = 'size' | 'background' | 'emptyMask' | 'tinyMask' | 'ambiguousMask' | 'pieces' | 'containment'
  | 'retention' | 'centre' | 'support' | 'colour' | 'structure' | 'nonFinite';
export type CleanupMetrics = {
  ringDeltaE: number; ringP95: number; containment: number; retention: number; largestShare: number;
  centroid: { x: number; y: number }; support: number; meanDeltaE: number; p95DeltaE: number; ssim: number; windows: number;
  workingBytes: number;
};
export type CleanupVerdict = { accepted: true; metrics: CleanupMetrics }
  | { accepted: false; reason: CleanupReason; metrics: Partial<CleanupMetrics> };

/**
 * Square (Chebyshev radius r) dilation or erosion as separable row then column passes with running counts, O(N) per
 * pass. Pixels outside the frame count as 0 for both: dilation never invents content at the border, and erosion
 * removes an edge-touching region's border band.
 */
export function morph(src: Uint8Array, dst: Uint8Array, tmp: Uint8Array, width: number, height: number, r: number, erode: boolean): void {
  const full = 2 * r + 1;
  const decide = (count: number) => (erode ? count === full : count > 0) ? 1 : 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(r, width); x += 1) count += src[row + x]!;
    for (let x = 0; x < width; x += 1) {
      if (x + r < width) count += src[row + x + r]!;
      if (x - r - 1 >= 0) count -= src[row + x - r - 1]!;
      tmp[row + x] = decide(count);
    }
  }
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y += 1) count += tmp[y * width + x]!;
    for (let y = 0; y < height; y += 1) {
      if (y + r < height) count += tmp[(y + r) * width + x]!;
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * width + x]!;
      dst[y * width + x] = decide(count);
    }
  }
}

const luma = (rgba: Uint8ClampedArray, index: number) => 0.2126 * rgba[index * 4]! + 0.7152 * rgba[index * 4 + 1]! + 0.0722 * rgba[index * 4 + 2]!;

function median(values: Float32Array, count: number): number {
  const sorted = values.subarray(0, count).sort();
  return count % 2 ? sorted[(count - 1) / 2]! : (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2;
}

/**
 * Compares H0 (the app-prepared clean-up input), R (BG1's region on the same grid) and H2 (the result). All three are
 * already resampled by the caller to FIDELITY.width x FIDELITY.height (RGBA for the photos, 0|1 for R). Fixed typed
 * buffers only, allocated once per call and unreachable when it returns or throws; `workingBytes` reports them.
 */
export function cleanupCheck(h0: Uint8ClampedArray, reference: Uint8Array, h2: Uint8ClampedArray): CleanupVerdict {
  const { width, height } = FIDELITY, pixels = width * height;
  if (h0.length !== pixels * 4 || h2.length !== pixels * 4 || reference.length !== pixels) return { accepted: false, reason: 'size', metrics: {} };
  const labA = new Float32Array(pixels * 3), labB = new Float32Array(pixels * 3);
  const m2 = new Uint8Array(pixels), dilatedR = new Uint8Array(pixels), erodedR = new Uint8Array(pixels);
  const erodedM2 = new Uint8Array(pixels), kept = new Uint8Array(pixels);
  const scratch = new Float32Array(pixels), queue = new Int32Array(pixels), labels = new Int32Array(pixels);
  const workingBytes = labA.byteLength + labB.byteLength + m2.byteLength + dilatedR.byteLength + erodedR.byteLength
    + erodedM2.byteLength + kept.byteLength + scratch.byteLength + queue.byteLength + labels.byteLength;
  for (let index = 0; index < pixels; index++) {
    const p = index * 4, l = index * 3;
    labOf(h0[p]!, h0[p + 1]!, h0[p + 2]!, labA, l);
    labOf(h2[p]!, h2[p + 1]!, h2[p + 2]!, labB, l);
  }

  // §5.2 Background: the per-channel median Lab of the result's outer ring, and how even that ring is.
  const ring = CLEANUP.ring;
  const inRing = (index: number) => {
    const x = index % width, y = (index - x) / width;
    return x < ring || y < ring || x >= width - ring || y >= height - ring;
  };
  const b = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    let ringCount = 0;
    for (let index = 0; index < pixels; index++) if (inRing(index)) scratch[ringCount++] = labB[index * 3 + channel]!;
    b[channel] = median(scratch, ringCount);
  }
  const paper = new Float32Array(3);
  labOf(FIDELITY.background[0], FIDELITY.background[1], FIDELITY.background[2], paper, 0);
  const ringDeltaE = deltaE2000(b[0]!, b[1]!, b[2]!, paper[0]!, paper[1]!, paper[2]!);
  let count = 0;
  for (let index = 0; index < pixels; index++) {
    if (!inRing(index)) continue;
    const l = index * 3;
    scratch[count++] = deltaE2000(labB[l]!, labB[l + 1]!, labB[l + 2]!, b[0]!, b[1]!, b[2]!);
  }
  const ringP95 = scratch.subarray(0, count).sort()[Math.min(count - 1, Math.floor(0.95 * count))]!;
  if (![ringDeltaE, ringP95].every(Number.isFinite)) return { accepted: false, reason: 'nonFinite', metrics: { workingBytes } };
  if (ringDeltaE > CLEANUP.maximumBackgroundDeltaE || ringP95 > CLEANUP.maximumRingP95) {
    return { accepted: false, reason: 'background', metrics: { ringDeltaE, ringP95, workingBytes } };
  }

  // §5.3 The result's garment mask and its sanity.
  let areaM2 = 0, areaR = 0;
  const edges = [0, 0, 0, 0];
  for (let index = 0; index < pixels; index++) {
    const l = index * 3;
    const on = deltaE2000(labB[l]!, labB[l + 1]!, labB[l + 2]!, b[0]!, b[1]!, b[2]!) > CLEANUP.garmentDeltaE ? 1 : 0;
    m2[index] = on;
    areaM2 += on;
    areaR += reference[index] ? 1 : 0;
    if (!on) continue;
    const x = index % width, y = (index - x) / width;
    if (y === 0) edges[0] = 1;
    if (y === height - 1) edges[1] = 1;
    if (x === 0) edges[2] = 1;
    if (x === width - 1) edges[3] = 1;
  }
  const base = { ringDeltaE, ringP95, workingBytes };
  if (areaM2 === 0) return { accepted: false, reason: 'emptyMask', metrics: base };
  if (areaM2 < pixels * CLEANUP.minimumMaskFraction) return { accepted: false, reason: 'tinyMask', metrics: base };
  if (edges.every(Boolean)) return { accepted: false, reason: 'ambiguousMask', metrics: base };
  const found = labelComponents(m2, width, height, labels, queue);
  if (found.overflow || found.count > MAX_COMPONENTS) return { accepted: false, reason: 'pieces', metrics: base };
  let largest = 0;
  for (let index = 1; index < found.count; index++) if (found.areas[index]! > found.areas[largest]!) largest = index;
  const largestShare = found.areas[largest]! / areaM2;
  if (largestShare < CLEANUP.largestShare) return { accepted: false, reason: 'pieces', metrics: { ...base, largestShare } };

  // §5.4 Containment, gross retention and centre. R is an upper bound and a loose floor, never the target.
  morph(reference, dilatedR, kept, width, height, CLEANUP.containmentRadius, false);
  let inside = 0, retained = 0, sumX = 0, sumY = 0;
  for (let index = 0; index < pixels; index++) {
    if (!m2[index]) continue;
    if (dilatedR[index]) inside++;
    if (reference[index]) retained++;
    if (labels[index] === largest + 1) {
      const x = index % width;
      sumX += x; sumY += (index - x) / width;
    }
  }
  const containment = inside / areaM2;
  const retention = areaR ? retained / areaR : 0;
  const centroid = { x: (sumX / found.areas[largest]! + 0.5) / width, y: (sumY / found.areas[largest]! + 0.5) / height };
  const placed = { ...base, largestShare, containment, retention, centroid };
  if (![containment, retention, centroid.x, centroid.y].every(Number.isFinite)) return { accepted: false, reason: 'nonFinite', metrics: placed };
  if (containment < CLEANUP.minimumContainment) return { accepted: false, reason: 'containment', metrics: placed };
  if (areaR === 0 || retained < CLEANUP.minimumRetention * areaR || retained < CLEANUP.minimumMaskFraction * pixels) {
    return { accepted: false, reason: 'retention', metrics: placed };
  }
  const [low, high] = CLEANUP.centre;
  if (centroid.x < low || centroid.x >= high || centroid.y < low || centroid.y >= high) {
    return { accepted: false, reason: 'centre', metrics: placed };
  }

  // §5.5 K: the kept garment's interior that was also inside BG1's region, minus 1 px of the result's own edge.
  morph(reference, erodedR, kept, width, height, CLEANUP.referenceErosion, true);
  morph(m2, erodedM2, kept, width, height, CLEANUP.resultErosion, true);
  let support = 0, sum = 0;
  count = 0;
  for (let index = 0; index < pixels; index++) {
    const on = m2[index]! & erodedR[index]! & erodedM2[index]!;
    kept[index] = on;
    if (!on) continue;
    support++;
    const l = index * 3;
    const value = deltaE2000(labA[l]!, labA[l + 1]!, labA[l + 2]!, labB[l]!, labB[l + 1]!, labB[l + 2]!);
    scratch[count++] = value;
    sum += value;
  }
  const supported = { ...placed, support };
  if (support < CLEANUP.minimumMaskFraction * pixels || support < CLEANUP.minimumSupportShare * areaM2) {
    return { accepted: false, reason: 'support', metrics: supported };
  }
  const meanDeltaE = sum / count;
  const p95DeltaE = scratch.subarray(0, count).sort()[Math.min(count - 1, Math.floor(0.95 * count))]!;

  const size = FIDELITY.ssimWindow, stride = FIDELITY.ssimStride, n = size * size;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let windows = 0, ssimSum = 0;
  for (let top = 0; top + size <= height; top += stride) {
    for (let left = 0; left + size <= width; left += stride) {
      let admitted = 0;
      for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) admitted += kept[y * width + x]!;
      if (admitted < CLEANUP.minimumWindowPixels) continue;
      let ma = 0, mb = 0;
      for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
        ma += luma(h0, y * width + x); mb += luma(h2, y * width + x);
      }
      ma /= n; mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
        const da = luma(h0, y * width + x) - ma, db = luma(h2, y * width + x) - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= n - 1; vb /= n - 1; cov /= n - 1;
      ssimSum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      windows++;
    }
  }
  const ssim = windows ? ssimSum / windows : Number.NaN;
  const metrics = { ...supported, meanDeltaE, p95DeltaE, ssim, windows };
  if (windows < CLEANUP.minimumWindows) return { accepted: false, reason: 'support', metrics };
  if (![meanDeltaE, p95DeltaE, ssim].every(Number.isFinite)) return { accepted: false, reason: 'nonFinite', metrics };
  if (meanDeltaE > CLEANUP.maximumMeanDeltaE || p95DeltaE > CLEANUP.maximumP95DeltaE) return { accepted: false, reason: 'colour', metrics };
  if (ssim < CLEANUP.minimumSsim) return { accepted: false, reason: 'structure', metrics };
  return { accepted: true, metrics };
}
