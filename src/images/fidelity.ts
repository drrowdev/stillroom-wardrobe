// BG2b (M1): heuristic rejection of some large changes between the prepared photo (H1) and its enhanced version (H2).
// It is NOT a fidelity guarantee: small logos, text, stitching and localised colour changes can pass unnoticed. Both
// inputs are RGBA pixels of the same 4:5 frame, already resampled by the caller to FIDELITY.width x FIDELITY.height;
// there is no alignment search. Every doubtful case (empty, tiny or ambiguous mask, low overlap, non-finite metric,
// no SSIM window) fails closed, so the caller keeps H1.

export const FIDELITY = Object.freeze({
  width: 256,
  height: 320,
  /** The BG2a canvas background, #f6f3ed. */
  background: Object.freeze([0xf6, 0xf3, 0xed] as const),
  /** A pixel is garment when its CIEDE2000 distance from the background is above this. */
  backgroundDeltaE: 6,
  minimumMaskFraction: 0.02,
  minimumIoU: 0.9,
  maximumMeanDeltaE: 5,
  maximumP95DeltaE: 15,
  minimumSsim: 0.6,
  ssimWindow: 8,
  ssimStride: 4,
});

export type FidelityReason = 'size' | 'emptyMask' | 'tinyMask' | 'ambiguousMask' | 'overlap' | 'colour' | 'structure' | 'nonFinite';
export type FidelityMetrics = { iou: number; meanDeltaE: number; p95DeltaE: number; ssim: number; windows: number; workingBytes: number };
export type FidelityVerdict = { accepted: true; metrics: FidelityMetrics }
  | { accepted: false; reason: FidelityReason; metrics: Partial<FidelityMetrics> };

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

/**
 * Compares H1 and H2. Linear memory only: typed arrays sized from the fixed frame, unreachable once it returns or throws.
 * `workingBytes` reports what this function allocated, for the memory budget.
 */
export function compareEnhancement(before: Uint8ClampedArray, after: Uint8ClampedArray): FidelityVerdict {
  const { width, height } = FIDELITY, pixels = width * height;
  if (before.length !== pixels * 4 || after.length !== pixels * 4) return { accepted: false, reason: 'size', metrics: {} };
  const labA = new Float32Array(pixels * 3), labB = new Float32Array(pixels * 3);
  const maskA = new Uint8Array(pixels), maskB = new Uint8Array(pixels);
  const lumaA = new Float32Array(pixels), lumaB = new Float32Array(pixels);
  const deltas = new Float32Array(pixels);
  const workingBytes = labA.byteLength + labB.byteLength + maskA.byteLength + maskB.byteLength
    + lumaA.byteLength + lumaB.byteLength + deltas.byteLength;
  const bg = new Float32Array(3);
  labOf(FIDELITY.background[0], FIDELITY.background[1], FIDELITY.background[2], bg, 0);
  let areaA = 0, areaB = 0, both = 0, either = 0;
  let minX: number = width, minY: number = height, maxX = -1, maxY = -1;
  const edges = [[0, 0, 0, 0], [0, 0, 0, 0]];
  for (let index = 0; index < pixels; index++) {
    const p = index * 4, l = index * 3;
    labOf(before[p]!, before[p + 1]!, before[p + 2]!, labA, l);
    labOf(after[p]!, after[p + 1]!, after[p + 2]!, labB, l);
    lumaA[index] = 0.2126 * before[p]! + 0.7152 * before[p + 1]! + 0.0722 * before[p + 2]!;
    lumaB[index] = 0.2126 * after[p]! + 0.7152 * after[p + 1]! + 0.0722 * after[p + 2]!;
    const a = deltaE2000(labA[l]!, labA[l + 1]!, labA[l + 2]!, bg[0]!, bg[1]!, bg[2]!) > FIDELITY.backgroundDeltaE ? 1 : 0;
    const b = deltaE2000(labB[l]!, labB[l + 1]!, labB[l + 2]!, bg[0]!, bg[1]!, bg[2]!) > FIDELITY.backgroundDeltaE ? 1 : 0;
    maskA[index] = a; maskB[index] = b;
    areaA += a; areaB += b;
    const x = index % width, y = (index - x) / width;
    for (const [mask, edge] of [[a, edges[0]!], [b, edges[1]!]] as const) {
      if (!mask) continue;
      if (y === 0) edge[0] = 1;
      if (y === height - 1) edge[1] = 1;
      if (x === 0) edge[2] = 1;
      if (x === width - 1) edge[3] = 1;
    }
    if (a && b) {
      both++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (a || b) either++;
  }
  if (areaA === 0 || areaB === 0) return { accepted: false, reason: 'emptyMask', metrics: { workingBytes } };
  if (areaA < pixels * FIDELITY.minimumMaskFraction || areaB < pixels * FIDELITY.minimumMaskFraction) {
    return { accepted: false, reason: 'tinyMask', metrics: { workingBytes } };
  }
  if (edges.some(edge => edge.every(Boolean))) return { accepted: false, reason: 'ambiguousMask', metrics: { workingBytes } };
  const iou = both / either;
  if (!Number.isFinite(iou)) return { accepted: false, reason: 'nonFinite', metrics: { workingBytes } };
  if (iou < FIDELITY.minimumIoU) return { accepted: false, reason: 'overlap', metrics: { iou, workingBytes } };

  let count = 0, sum = 0;
  for (let index = 0; index < pixels; index++) {
    if (!maskA[index] || !maskB[index]) continue;
    const l = index * 3;
    const value = deltaE2000(labA[l]!, labA[l + 1]!, labA[l + 2]!, labB[l]!, labB[l + 1]!, labB[l + 2]!);
    deltas[count++] = value;
    sum += value;
  }
  const sorted = deltas.subarray(0, count).sort();
  const meanDeltaE = sum / count, p95DeltaE = sorted[Math.min(count - 1, Math.floor(0.95 * count))]!;

  const size = FIDELITY.ssimWindow, stride = FIDELITY.ssimStride, n = size * size;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let windows = 0, ssimSum = 0;
  for (let top = minY; top + size - 1 <= maxY; top += stride) {
    for (let left = minX; left + size - 1 <= maxX; left += stride) {
      let ma = 0, mb = 0;
      for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
        ma += lumaA[y * width + x]!; mb += lumaB[y * width + x]!;
      }
      ma /= n; mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
        const da = lumaA[y * width + x]! - ma, db = lumaB[y * width + x]! - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= n - 1; vb /= n - 1; cov /= n - 1;
      ssimSum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      windows++;
    }
  }
  const ssim = windows ? ssimSum / windows : Number.NaN;
  const metrics = { iou, meanDeltaE, p95DeltaE, ssim, windows, workingBytes };
  if (![meanDeltaE, p95DeltaE, ssim].every(Number.isFinite) || windows === 0) return { accepted: false, reason: 'nonFinite', metrics };
  if (meanDeltaE > FIDELITY.maximumMeanDeltaE || p95DeltaE > FIDELITY.maximumP95DeltaE) return { accepted: false, reason: 'colour', metrics };
  if (ssim < FIDELITY.minimumSsim) return { accepted: false, reason: 'structure', metrics };
  return { accepted: true, metrics };
}
