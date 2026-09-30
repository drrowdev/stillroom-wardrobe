// The BG2c clean-up check, v2 (BG2c-3, plan rev8 §3): the fixed comparison frame, CIEDE2000, the sRGB to CIELAB
// conversion and `cleanupCheck`. Callers resample every input to FIDELITY.width x FIDELITY.height. Every threshold lives
// in the frozen CLEANUP_V2 record (./cleanup-calibration).
import { labelComponents, MAX_COMPONENTS } from './background/frame';
import { CLEANUP_CHECK_VERSION, CLEANUP_V2 } from './cleanup-calibration';

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

// IEC 61966-2-1 linear sRGB -> XYZ (D65) -> CIELAB.
function labFromLinear(lr: number, lg: number, lb: number, out: Float32Array, at: number): void {
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  out[at] = 116 * fy - 16;
  out[at + 1] = 500 * (fx - fy);
  out[at + 2] = 200 * (fy - fz);
}
function labOf(r: number, g: number, b: number, out: Float32Array, at: number): void {
  labFromLinear(LINEAR[r]!, LINEAR[g]!, LINEAR[b]!, out, at);
}

const RAD = Math.PI / 180;
/**
 * CIEDE2000 (Sharma, Wu and Dalal 2005) with weights kL and kC (kH = 1). With `dropLightness` the lightness term is
 * left out entirely (the §3.5 shading tolerance); RT still couples the chroma and hue terms.
 */
function ciede2000(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number, kL: number, kC: number, dropLightness: boolean): number {
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / RAD + 360) % 360);
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2);
  const dL = l2 - l1, dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * RAD / 2);
  const lBar = (l1 + l2) / 2, cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hBar = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
    else hBar = (hp1 + hp2) / 2;
  }
  const t = 1 - 0.17 * Math.cos((hBar - 30) * RAD) + 0.24 * Math.cos(2 * hBar * RAD)
    + 0.32 * Math.cos((3 * hBar + 6) * RAD) - 0.2 * Math.cos((4 * hBar - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar, sh = 1 + 0.015 * cpBar * t;
  const rt = -Math.sin(2 * dTheta * RAD) * rc;
  const lTerm = dropLightness ? 0 : (dL / (kL * sl)) ** 2;
  const cTerm = dC / (kC * sc), hTerm = dH / sh;
  return Math.sqrt(Math.max(0, lTerm + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm));
}

/** CIEDE2000 (Sharma, Wu and Dalal 2005) with kL = kC = kH = 1. */
export function deltaE2000(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  return ciede2000(l1, a1, b1, l2, a2, b2, 1, 1, false);
}

// BG2c-3 (plan rev8): the clean-up check v2. A GROSS-CHANGE FILTER tuned for usefulness (owner D1, #84), not identity or
// fidelity proof. It blocks a non-plain background, a clearly different colour beyond lighting, a large pattern change,
// and large added or removed parts; it accepts crease and highlight removal, lighting, pose and minor detail changes.
// The recorded limits (§4.3, §7) stay undetected. The owner's visual review of real results remains the real guard.
export type CleanupReason = 'size' | 'background' | 'emptyMask' | 'tinyMask' | 'ambiguousMask' | 'pieces' | 'centre'
  | 'added' | 'retention' | 'support' | 'clipped' | 'colourShift' | 'colourMode' | 'removed' | 'change' | 'patternLoss'
  | 'nonFinite';
export type CleanupMode = { level: number; share: number; chosen: boolean };
export type CleanupMetrics = {
  checkVersion: number; workingBytes: number;
  ringDeltaE?: number; ringP95?: number;
  // Unaligned (rev4) diagnostics, reported only.
  largestShare?: number; centroid?: { x: number; y: number }; containment?: number; unalignedRetention?: number;
  meanDeltaE?: number; p95DeltaE?: number; ssim?: number; windows?: number;
  // rev8b §1.1: which pass decided, and the identity pass's reason when the aligned pass ran.
  path?: 'identity' | 'aligned'; identityReason?: CleanupReason;
  /** BG2c-3b: the identity pass's gate values (zero slack), reported next to `identityReason` when the aligned pass decided. */
  identityAdded?: number; identityRemoved?: number;
  // §3.3 alignment and area gates.
  scale?: number; tx?: number; ty?: number; ncc?: number; alignmentFlat?: boolean; added?: number; addedIdentity?: number;
  invalid?: number; alignedCentroid?: { x: number; y: number }; retention?: number; resultArea?: number; removed?: number;
  paletteBins?: number;
  // §3.4 support and envelope.
  support?: number; fitted?: number; deltaL?: number; chroma?: number; hue?: number; fallbackC?: boolean; fallbackTheta?: boolean;
  // §3.4a lightness mode.
  modeDistance?: number; resultMedian?: number; median0?: number; medianChosen?: boolean; modeShare?: number; modes?: CleanupMode[];
  // §3.5 and §3.5a.
  changeShare?: number; residualP50?: number; residualP95?: number;
  patternLoss?: number; patternShare0?: number; patternUndefined2?: number;
};
export type CleanupVerdict = { accepted: true; metrics: CleanupMetrics }
  | { accepted: false; reason: CleanupReason; metrics: CleanupMetrics };
export type CleanupOptions = {
  /** Aborted by Skip, the stage timeout, an identity change or unmount; the check rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Monotonic milliseconds; defaults to performance.now. */
  now?: () => number;
  /** Gives the event loop a turn; defaults to `cleanupYield()`. */
  yieldNow?: () => Promise<void>;
  /** Unit tests only: skip the identity pass and return the aligned pass (rev8b §1.2, the either-path margin rule). */
  alignedOnly?: boolean;
};

type YieldScope = { scheduler?: { yield?: () => Promise<void> }; MessageChannel?: typeof MessageChannel };
/**
 * The §3.7 yield primitive: `scheduler.yield()` where it exists (Chromium), otherwise a MessageChannel round trip
 * (WebKit, iOS Safari, Firefox), which has no nested-setTimeout clamp. `setTimeout` is never used.
 */
export function cleanupYield(scope: YieldScope = globalThis as YieldScope): { kind: 'scheduler' | 'channel'; run: () => Promise<void> } {
  const scheduler = scope.scheduler;
  if (scheduler && typeof scheduler.yield === 'function') return { kind: 'scheduler', run: () => scheduler.yield!() };
  const Channel = scope.MessageChannel;
  if (!Channel) throw new Error('no yield primitive');
  return {
    kind: 'channel',
    run: () => new Promise<void>((resolve) => {
      const channel = new Channel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(0);
    }),
  };
}

const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');
/** Counts work; every `iterations` units it checks the signal and yields when at least `sliceMs` have passed. */
class Pacer {
  private work = 0;
  private last: number;
  constructor(private readonly signal: AbortSignal | undefined, private readonly now: () => number,
    private readonly yieldNow: () => Promise<void>) { this.last = now(); this.check(); }
  check(): void { if (this.signal?.aborted) throw abortError(this.signal); }
  step(units: number): Promise<void> | undefined {
    this.work += units;
    if (this.work < CLEANUP_V2.schedule.iterations) return undefined;
    this.work = 0;
    this.check();
    if (this.now() - this.last < CLEANUP_V2.schedule.sliceMs) return undefined;
    return this.yieldNow().then(() => { this.last = this.now(); this.check(); });
  }
}

/**
 * Square (Chebyshev radius r) dilation or erosion as separable row then column passes with running counts, O(N) per
 * pass. Only bit 0 of a source value counts, so flag bits above it are ignored. Pixels outside the frame count as 0 for
 * both: dilation never invents content at the border, and erosion removes an edge-touching region's border band.
 */
export function morph(src: Uint8Array, dst: Uint8Array, tmp: Uint8Array, width: number, height: number, r: number, erode: boolean): void {
  const full = 2 * r + 1;
  const decide = (count: number) => (erode ? count === full : count > 0) ? 1 : 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(r, width); x += 1) count += src[row + x]! & 1;
    for (let x = 0; x < width; x += 1) {
      if (x + r < width) count += src[row + x + r]! & 1;
      if (x - r - 1 >= 0) count -= src[row + x - r - 1]! & 1;
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
const percentile = (sorted: Float32Array, count: number, share: number) => sorted[Math.min(count - 1, Math.floor(share * count))]!;

/** The lower median of a histogram range: the centre of the first bin at which the cumulative count reaches ceil(n/2). */
function lowerMedian(histogram: Uint32Array, from: number, to: number, binWidth: number): number {
  let n = 0;
  for (let bin = from; bin <= to; bin++) n += histogram[bin]!;
  const half = Math.ceil(n / 2);
  let cumulative = 0;
  for (let bin = from; bin <= to; bin++) {
    cumulative += histogram[bin]!;
    if (cumulative >= half && cumulative > 0) return binWidth * bin + binWidth / 2;
  }
  return Number.NaN;
}

/** The §3.5a hue range of one pixel's occupancy bits (36 bins in two words), or -1 when no bin is occupied. */
function hueRange(low: number, high: number): number {
  if (low === 0 && (high & 0xf) === 0) return -1;
  let run = 0, best = 0;
  for (let step = 0; step < 72; step++) {
    const bin = step % 36;
    const occupied = bin < 32 ? (low >>> bin) & 1 : (high >>> (bin - 32)) & 1;
    run = occupied ? 0 : run + 1;
    if (run > best) best = run;
  }
  return 360 - CLEANUP_V2.patternLoss.hueBin * Math.min(best, 36) - CLEANUP_V2.patternLoss.hueBin;
}

/**
 * The production gate and qualifier rules of v2 as pure predicates over the measured values; `cleanupCheck` decides
 * with exactly these, so their exact boundaries are unit-tested here (§5.2). `true` means "fails" for gates, and
 * "qualifies", "defined", "occupied", "lost" or "falls back" for the others.
 */
export const CLEANUP_RULES = Object.freeze({
  added: (share: number, identity: boolean) => share >= (identity ? CLEANUP_V2.added.identityMaximum : CLEANUP_V2.added.maximum),
  retention: (retained: number, areaR: number, pixels: number) => areaR === 0 || retained < CLEANUP_V2.retention.minimum * areaR
    || retained < CLEANUP_V2.minimumMaskFraction * pixels,
  support: (support: number, resultArea: number, pixels: number) => support < CLEANUP_V2.minimumMaskFraction * pixels
    || support < CLEANUP_V2.support.minimumShare * resultArea,
  clipped: (fitted: number) => fitted < CLEANUP_V2.fit.minimumPixels,
  /** The chroma and hue estimators use their neutral values (c = 1, θ = 0) below 500 qualifying pixels; never a gate. */
  fallback: (qualifying: number) => qualifying < CLEANUP_V2.fit.qualifiers,
  colourShift: (deltaL: number, chroma: number, hue: number) => Math.abs(deltaL) > CLEANUP_V2.colourShift.lightness
    || chroma < CLEANUP_V2.colourShift.minimumChroma || chroma > CLEANUP_V2.colourShift.maximumChroma
    || Math.abs(hue) > CLEANUP_V2.colourShift.hue,
  modeQualifies: (count: number, support: number) => count >= CLEANUP_V2.colourMode.share * support,
  colourMode: (distance: number) => distance > CLEANUP_V2.colourMode.maximum,
  removed: (share: number) => share >= CLEANUP_V2.removed.maximum,
  change: (share: number) => share >= CLEANUP_V2.change.maximum,
  patternDefined: (count: number) => count >= CLEANUP_V2.patternLoss.minimumCount,
  occupied: (binCount: number, count: number) => binCount >= Math.max(CLEANUP_V2.patternLoss.occupiedCount,
    Math.ceil(CLEANUP_V2.patternLoss.occupiedShare * count)),
  lost: (range0: number, range2: number) => range0 >= CLEANUP_V2.patternLoss.lostFrom && range2 <= CLEANUP_V2.patternLoss.lostTo,
  patternLoss: (share: number) => share >= CLEANUP_V2.patternLoss.maximum,
});

/**
 * Compares H0 (the app-prepared clean-up input), R (BG1's region on the same grid) and H2 (the result). All three are
 * already resampled by the caller to FIDELITY.width x FIDELITY.height (RGBA for the photos, 0|1 for R). Fixed typed
 * buffers only, allocated once per call and unreachable when it returns or throws; `workingBytes` reports them (§3.8).
 * Cooperative (§3.7): it checks `signal` every 1,024 units of work and yields when 8 ms have passed.
 * Identity first (rev8b §1.1): every gate runs at T = identity with no slack in `added` and `removed`; if all pass, the
 * result is accepted with no transform search. Otherwise the rev8 aligned pass runs and its verdict is final.
 */
export async function cleanupCheck(h0: Uint8ClampedArray, reference: Uint8Array, h2: Uint8ClampedArray,
  options: CleanupOptions = {}): Promise<CleanupVerdict> {
  const { width, height } = FIDELITY, pixels = width * height, V = CLEANUP_V2;
  const checkVersion = CLEANUP_CHECK_VERSION;
  const pacer = new Pacer(options.signal, options.now ?? (() => performance.now()), options.yieldNow ?? cleanupYield().run);
  if (h0.length !== pixels * 4 || h2.length !== pixels * 4 || reference.length !== pixels) {
    return { accepted: false, reason: 'size', metrics: { checkVersion, workingBytes: 0 } };
  }
  const labA = new Float32Array(pixels * 3), labB = new Float32Array(pixels * 3);
  const m2 = new Uint8Array(pixels), dilatedR = new Uint8Array(pixels), erodedR = new Uint8Array(pixels);
  const erodedM2 = new Uint8Array(pixels), kept = new Uint8Array(pixels);
  const scratch = new Float32Array(pixels), queue = new Int32Array(pixels), labels = new Int32Array(pixels);
  const m2w = new Uint8Array(pixels), r6 = new Uint8Array(pixels), dm2w = new Uint8Array(pixels);
  const qw = width / V.alignment.block, qh = height / V.alignment.block;
  const g0q = new Float32Array(qw * qh), g2q = new Float32Array(qw * qh);
  const rm = V.removed;
  const palette = new Uint32Array(rm.lightnessBins * rm.abBins * rm.abBins);
  const lo0 = new Float32Array(pixels), hi0 = new Float32Array(pixels), loC0 = new Float32Array(pixels);
  const hiC0 = new Float32Array(pixels), mid2 = new Float32Array(pixels);
  const lineA = new Float32Array(Math.max(width, height)), lineB = new Float32Array(Math.max(width, height));
  const hist0 = new Uint32Array(V.colourMode.bins), hist2 = new Uint32Array(V.colourMode.bins);
  const levels = new Float32Array(V.colourMode.levels);
  const windowCount = new Uint16Array(pixels), binCount = new Uint16Array(pixels), range0 = new Uint16Array(pixels);
  const workingBytes = [labA, labB, m2, dilatedR, erodedR, erodedM2, kept, scratch, queue, labels, m2w, r6, dm2w, g0q, g2q,
    palette, lo0, hi0, loC0, hiC0, mid2, lineA, lineB, hist0, hist2, levels, windowCount, binCount, range0]
    .reduce((sum, buffer) => sum + buffer.byteLength, 0);
  // Views over buffers whose first use is over by the time these are written (§3.8).
  const rowTemp = new Float32Array(labels.buffer), grad2 = new Float32Array(labels.buffer);
  const maskLow = labels, maskHigh = queue;
  const pace = async (units: number) => { const pending = pacer.step(units); if (pending) await pending; };

  for (let index = 0; index < pixels; index++) {
    const p = index * 4, l = index * 3;
    labOf(h0[p]!, h0[p + 1]!, h0[p + 2]!, labA, l);
    labOf(h2[p]!, h2[p + 1]!, h2[p + 2]!, labB, l);
    if ((index & 1023) === 1023) await pace(1024);
  }

  // §3.2 Background: the per-channel median Lab of the result's outer ring, and how even that ring is.
  const ring = V.ring;
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
  const ringP95 = percentile(scratch.subarray(0, count).sort(), count, 0.95);
  const metrics: CleanupMetrics = { checkVersion, workingBytes, ringDeltaE, ringP95 };
  const fail = (reason: CleanupReason): CleanupVerdict => ({ accepted: false, reason, metrics });
  if (![ringDeltaE, ringP95].every(Number.isFinite)) return fail('nonFinite');
  if (ringDeltaE > V.maximumBackgroundDeltaE || ringP95 > V.maximumRingP95) return fail('background');
  await pace(1024);

  // The result's garment mask and its sanity.
  let areaM2 = 0, areaR = 0;
  const edges = [0, 0, 0, 0];
  for (let index = 0; index < pixels; index++) {
    const l = index * 3;
    const on = deltaE2000(labB[l]!, labB[l + 1]!, labB[l + 2]!, b[0]!, b[1]!, b[2]!) > V.garmentDeltaE ? 1 : 0;
    m2[index] = on;
    areaM2 += on;
    areaR += reference[index] ? 1 : 0;
    if ((index & 1023) === 1023) await pace(1024);
    if (!on) continue;
    const x = index % width, y = (index - x) / width;
    if (y === 0) edges[0] = 1;
    if (y === height - 1) edges[1] = 1;
    if (x === 0) edges[2] = 1;
    if (x === width - 1) edges[3] = 1;
  }
  if (areaM2 === 0) return fail('emptyMask');
  if (areaM2 < pixels * V.minimumMaskFraction) return fail('tinyMask');
  if (edges.every(Boolean)) return fail('ambiguousMask');
  const found = labelComponents(m2, width, height, labels, queue);
  if (found.overflow || found.count > MAX_COMPONENTS) return fail('pieces');
  let largest = 0;
  for (let index = 1; index < found.count; index++) if (found.areas[index]! > found.areas[largest]!) largest = index;
  const largestShare = found.areas[largest]! / areaM2;
  metrics.largestShare = largestShare;
  if (largestShare < V.largestShare) return fail('pieces');

  // Unaligned centre (gated) and the rev4 containment and retention (reported only).
  morph(reference, dilatedR, kept, width, height, V.containmentRadius, false);
  let inside = 0, retainedU = 0, sumX = 0, sumY = 0;
  for (let index = 0; index < pixels; index++) {
    if (!m2[index]) continue;
    if (dilatedR[index]) inside++;
    if (reference[index]) retainedU++;
    if (labels[index] === largest + 1) {
      const x = index % width;
      sumX += x; sumY += (index - x) / width;
    }
  }
  const centroid = { x: (sumX / found.areas[largest]! + 0.5) / width, y: (sumY / found.areas[largest]! + 0.5) / height };
  metrics.centroid = centroid;
  metrics.containment = inside / areaM2;
  metrics.unalignedRetention = areaR ? retainedU / areaR : 0;
  const low = V.centre[0]!, high = V.centre[1]!;
  if (![centroid.x, centroid.y].every(Number.isFinite)) return fail('nonFinite');
  if (centroid.x < low || centroid.x >= high || centroid.y < low || centroid.y >= high) return fail('centre');

  // The rev4 unaligned colour and structure diagnostics, reported only (§3.5).
  morph(reference, erodedR, kept, width, height, V.band.referenceErosion, true);
  morph(m2, erodedM2, kept, width, height, V.support.resultErosion, true);
  {
    let supportU = 0, sum = 0;
    count = 0;
    for (let index = 0; index < pixels; index++) {
      const on = m2[index]! & erodedR[index]! & erodedM2[index]!;
      kept[index] = on;
      if (!on) continue;
      supportU++;
      const l = index * 3;
      const value = deltaE2000(labA[l]!, labA[l + 1]!, labA[l + 2]!, labB[l]!, labB[l + 1]!, labB[l + 2]!);
      scratch[count++] = value;
      sum += value;
      if ((supportU & 1023) === 0) await pace(1024);
    }
    if (count) {
      metrics.meanDeltaE = sum / count;
      metrics.p95DeltaE = percentile(scratch.subarray(0, count).sort(), count, 0.95);
    }
    const size = FIDELITY.ssimWindow, stride = FIDELITY.ssimStride, n = size * size;
    const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
    let windows = 0, ssimSum = 0;
    for (let top = 0; top + size <= height; top += stride) {
      for (let left = 0; left + size <= width; left += stride) {
        let admitted = 0;
        for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) admitted += kept[y * width + x]!;
        if (admitted < 48) continue;
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
      await pace(width);
    }
    metrics.windows = windows;
    if (windows) metrics.ssim = ssimSum / windows;
  }

  // §3.1a The foreground-restricted local band. `support` decides which pixels a window may read; the window count
  // (in `queue`) decides the thin-support fallback to the raw value.
  const br = V.band.radius;
  const supportCount = async (support: Uint8Array) => {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let running = 0;
      for (let x = 0; x < Math.min(br, width); x++) running += support[row + x]! & 1;
      for (let x = 0; x < width; x++) {
        if (x + br < width) running += support[row + x + br]! & 1;
        if (x - br - 1 >= 0) running -= support[row + x - br - 1]! & 1;
        queue[row + x] = running;
      }
    }
    await pace(pixels);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) lineB[y] = queue[y * width + x]!;
      let running = 0;
      for (let y = 0; y < Math.min(br, height); y++) running += lineB[y]!;
      for (let y = 0; y < height; y++) {
        if (y + br < height) running += lineB[y + br]!;
        if (y - br - 1 >= 0) running -= lineB[y - br - 1]!;
        queue[y * width + x] = running;
      }
    }
    await pace(pixels);
  };
  // A sliding-window minimum or maximum (radius br, clipped at the ends) of lineA[0..n) into out[offset + k·stride],
  // with a monotonic deque of indices in lineB (at most 2·br + 1 live entries). Exact: it returns the same values as
  // a naive scan.
  const slide = (n: number, max: boolean, out: Float32Array, offset: number, stride: number) => {
    let head = 0, tail = 0;
    for (let k = 0; k < n + br; k++) {
      if (k < n) {
        const v = lineA[k]!;
        while (tail > head && (max ? lineA[lineB[tail - 1]!]! <= v : lineA[lineB[tail - 1]!]! >= v)) tail--;
        lineB[tail++] = k;
      }
      const at = k - br;
      if (at < 0) continue;
      while (lineB[head]! < at - br) head++;
      out[offset + at * stride] = lineA[lineB[head]!]!;
    }
  };
  const bandOf = async (value: (index: number) => number, support: Uint8Array, dst: Float32Array, max: boolean) => {
    const empty = max ? -Infinity : Infinity;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) lineA[x] = support[row + x]! & 1 ? value(row + x) : empty;
      slide(width, max, rowTemp, row, 1);
    }
    await pace(pixels * 3);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) lineA[y] = rowTemp[y * width + x]!;
      slide(height, max, rowTemp, x, width);
    }
    for (let index = 0; index < pixels; index++) {
      dst[index] = support[index]! & 1 && queue[index]! >= V.band.minimumSupport ? rowTemp[index]! : value(index);
    }
    await pace(pixels * 3);
  };
  const lightness0 = (index: number) => labA[index * 3]!;
  const chroma0 = (index: number) => Math.hypot(labA[index * 3 + 1]!, labA[index * 3 + 2]!);
  const lightness2 = (index: number) => labB[index * 3]!;
  await supportCount(erodedR);
  await bandOf(lightness0, erodedR, lo0, false);
  await bandOf(lightness0, erodedR, hi0, true);
  await bandOf(chroma0, erodedR, loC0, false);
  await bandOf(chroma0, erodedR, hiC0, true);
  await supportCount(m2);
  await bandOf(lightness2, m2, mid2, false);
  await bandOf(lightness2, m2, scratch, true);
  for (let index = 0; index < pixels; index++) mid2[index] = (mid2[index]! + scratch[index]!) / 2;

  // §3.3 Alignment from content: the gradient magnitude of the band midpoint (raw L* off the support), NCC over
  // dilate(R, 6). H0's background is real clutter, so H0 counts only there; H2's plain background carries no gradient.
  morph(reference, r6, kept, width, height, V.alignment.regionDilation, false);
  const signal0 = (index: number) => erodedR[index] ? (lo0[index]! + hi0[index]!) / 2 : labA[index * 3]!;
  const gradientInto = (get: (index: number) => number, w: number, h: number, dst: Float32Array) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const index = y * w + x;
      const gx = w < 2 ? 0 : x === 0 ? get(index + 1) - get(index) : x === w - 1 ? get(index) - get(index - 1) : (get(index + 1) - get(index - 1)) / 2;
      const gy = h < 2 ? 0 : y === 0 ? get(index + w) - get(index) : y === h - 1 ? get(index) - get(index - w) : (get(index + w) - get(index - w)) / 2;
      dst[index] = Math.hypot(gx, gy);
    }
  };
  const block = V.alignment.block, cx = width / 2, cy = height / 2;
  const blockMeans = (get: (index: number) => number, dst: Float32Array) => {
    for (let qy = 0; qy < qh; qy++) for (let qx = 0; qx < qw; qx++) {
      let sum = 0;
      for (let y = qy * block; y < (qy + 1) * block; y++) for (let x = qx * block; x < (qx + 1) * block; x++) sum += get(y * width + x);
      dst[qy * qw + qx] = sum / (block * block);
    }
  };
  blockMeans(signal0, scratch);
  gradientInto((index) => scratch[index]!, qw, qh, g0q);
  blockMeans((index) => mid2[index]!, scratch);
  gradientInto((index) => scratch[index]!, qw, qh, g2q);
  await pace(pixels);

  type Candidate = { ncc: number; s: number; tx: number; ty: number };
  const better = (next: Candidate, best: Candidate | null) => {
    if (best === null) return true;
    if (next.ncc !== best.ncc) return next.ncc > best.ncc;
    const tn = Math.hypot(next.tx, next.ty), tb = Math.hypot(best.tx, best.ty);
    if (tn !== tb) return tn < tb;
    return Math.abs(next.s - 1) < Math.abs(best.s - 1);
  };
  const ncc = (sa: number, sb: number, sab: number, saa: number, sbb: number, n: number) => {
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    const denominator = Math.sqrt(Math.max(0, va) * Math.max(0, vb));
    return n === 0 || !(denominator >= V.alignment.flatDenominator) ? -Infinity : (sab - sa * sb / n) / denominator;
  };
  const al = V.alignment;
  const scaleFrom = Math.round(al.minimumScale * 100), scaleTo = Math.round(al.maximumScale * 100);
  // rev8b §1.1: every gate after alignment, for one transform. `identity` evaluates T = identity with no slack in
  // `added` and `removed`; otherwise the rev8 transform and dilation 6. The stages above are shared by both passes.
  const placed = metrics;
  const evaluate = async (transform: Candidate, alignmentFlat: boolean | undefined, identity: boolean): Promise<CleanupVerdict> => {
    const { s, tx, ty } = transform;
    const metrics: CleanupMetrics = { ...placed, path: identity ? 'identity' : 'aligned' };
    const fail = (reason: CleanupReason): CleanupVerdict => ({ accepted: false, reason, metrics });
    Object.assign(metrics, { scale: s, tx, ty, ncc: transform.ncc, alignmentFlat });
    hist0.fill(0); hist2.fill(0); palette.fill(0);

    // §3.3 added: the share of M2 (counted in H2 pixels) that T maps out of the frame or outside dilate(R, 6); on the
    // identity pass, outside R itself (rev8b: no slack).
    let outside = 0, outsideIdentity = 0;
    for (let y = 0; y < height; y++) {
      const Y = Math.floor(cy + s * (y + 0.5 - cy) + ty);
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (!m2[index]) continue;
        if (!r6[index]) outsideIdentity++;
        const X = Math.floor(cx + s * (x + 0.5 - cx) + tx);
        if (X < 0 || X >= width || Y < 0 || Y >= height || !(identity ? reference : r6)[Y * width + X]) outside++;
      }
    }
    const added = outside / areaM2;
    metrics.added = added;
    metrics.addedIdentity = outsideIdentity / areaM2;

    // §3.1 The warp: H2' samples H2 at T^-1(q) bilinearly in linear RGB, straight to Float32 Lab (labB is overwritten; the
    // caller's RGBA is the source). m2w: bit 0 foreground, 2 invalid (out of frame), 4 clipped (>= linear 254).
    const clip = LINEAR[V.fit.resultClip]!;
    const linear = (index: number, channel: number) => LINEAR[h2[index * 4 + channel]!]!;
    let invalid = 0, areaM2w = 0;
    for (let y = 0; y < height; y++) {
      const py = cy + (y + 0.5 - ty - cy) / s;
      for (let x = 0; x < width; x++) {
        const index = y * width + x, l = index * 3;
        const px = cx + (x + 0.5 - tx - cx) / s;
        if (px < 0.5 || px > width - 0.5 || py < 0.5 || py > height - 0.5) {
          m2w[index] = 2; labB[l] = 0; labB[l + 1] = 0; labB[l + 2] = 0; invalid++;
          continue;
        }
        const fx0 = px - 0.5, fy0 = py - 0.5;
        const x0 = Math.min(width - 1, Math.floor(fx0)), y0 = Math.min(height - 1, Math.floor(fy0));
        const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        const fx = fx0 - x0, fy = fy0 - y0;
        const i00 = y0 * width + x0, i01 = y0 * width + x1, i10 = y1 * width + x0, i11 = y1 * width + x1;
        const mix = (channel: number) => (1 - fy) * ((1 - fx) * linear(i00, channel) + fx * linear(i01, channel))
          + fy * ((1 - fx) * linear(i10, channel) + fx * linear(i11, channel));
        const lr = mix(0), lg = mix(1), lb = mix(2);
        labFromLinear(lr, lg, lb, labB, l);
        const fg = deltaE2000(labB[l]!, labB[l + 1]!, labB[l + 2]!, b[0]!, b[1]!, b[2]!) > V.garmentDeltaE ? 1 : 0;
        m2w[index] = fg | (lr >= clip || lg >= clip || lb >= clip ? 4 : 0);
        areaM2w += fg;
      }
      await pace(width * 4);
    }
    metrics.invalid = invalid;
    metrics.resultArea = areaM2w;

    // §3.3 centre (aligned): the centroid of T(M2)'s largest component.
    for (let index = 0; index < pixels; index++) kept[index] = m2w[index]! & 1;
    let alignedCentroid = { x: Number.NaN, y: Number.NaN };
    if (areaM2w > 0) {
      const alignedParts = labelComponents(kept, width, height, labels, queue);
      if (!alignedParts.overflow && alignedParts.count > 0) {
        let top = 0;
        for (let index = 1; index < alignedParts.count; index++) if (alignedParts.areas[index]! > alignedParts.areas[top]!) top = index;
        let ax = 0, ay = 0;
        for (let index = 0; index < pixels; index++) {
          if (labels[index] !== top + 1) continue;
          const x = index % width;
          ax += x; ay += (index - x) / width;
        }
        alignedCentroid = { x: (ax / alignedParts.areas[top]! + 0.5) / width, y: (ay / alignedParts.areas[top]! + 0.5) / height };
      }
    }
    metrics.alignedCentroid = alignedCentroid;
    await pace(pixels);

    // §3.3 retention, then §3.4 K' = M2' ∩ erode(R, 2) ∩ erode(M2', 1), minus invalid pixels.
    let retained = 0;
    for (let index = 0; index < pixels; index++) if (m2w[index]! & 1 && reference[index]) retained++;
    const retention = areaR ? retained / areaR : 0;
    metrics.retention = retention;
    morph(m2w, erodedM2, kept, width, height, V.support.resultErosion, true);
    morph(m2w, dm2w, kept, width, height, rm.dilation, false);
    let support = 0;
    for (let index = 0; index < pixels; index++) {
      const on = m2w[index]! & 1 & erodedR[index]! & erodedM2[index]!;
      kept[index] = on;
      support += on;
    }
    metrics.support = support;
    await pace(pixels);

    // §3.4 The global lighting envelope, on K' pixels unclipped in both images.
    const fit = V.fit;
    const unclipped0 = (index: number) => {
      const p = index * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = h0[p + channel]!;
        if (value < fit.lowChannel || value > fit.highChannel) return false;
      }
      return true;
    };
    let fitted = 0;
    for (let index = 0; index < pixels; index++) {
      if (!kept[index] || m2w[index]! & 4 || !unclipped0(index)) continue;
      const l2 = labB[index * 3]!;
      scratch[fitted++] = l2 - Math.min(hi0[index]!, Math.max(lo0[index]!, l2));
    }
    metrics.fitted = fitted;
    const deltaL = fitted ? median(scratch, fitted) : Number.NaN;
    let chromaCount = 0, sa0 = 0, sb0 = 0, n0 = 0, sa2 = 0, sb2 = 0, n2 = 0;
    for (let index = 0; index < pixels; index++) {
      if (!kept[index] || m2w[index]! & 4 || !unclipped0(index)) continue;
      const l = index * 3;
      const c2 = Math.hypot(labB[l + 1]!, labB[l + 2]!), c0 = Math.hypot(labA[l + 1]!, labA[l + 2]!);
      const top = hiC0[index]!, bottom = loC0[index]!;
      if (Math.max(c2, top) >= fit.chromaFloor) scratch[chromaCount++] = c2 > top ? c2 / top : c2 < bottom ? c2 / Math.max(bottom, 1) : 1;
      if (c2 >= fit.hueChroma) { sa2 += labB[l + 1]!; sb2 += labB[l + 2]!; n2++; }
      if (c0 >= fit.hueChroma) { sa0 += labA[l + 1]!; sb0 += labA[l + 2]!; n0++; }
    }
    const fallbackC = CLEANUP_RULES.fallback(chromaCount);
    const fallbackTheta = CLEANUP_RULES.fallback(n0) || CLEANUP_RULES.fallback(n2);
    const chroma = fallbackC ? 1 : median(scratch, chromaCount);
    let hue = 0;
    if (!fallbackTheta) {
      hue = (Math.atan2(sb2, sa2) - Math.atan2(sb0, sa0)) / RAD;
      while (hue <= -180) hue += 360;
      while (hue > 180) hue -= 360;
    }
    Object.assign(metrics, { deltaL, chroma, hue, fallbackC, fallbackTheta });
    await pace(pixels);

    // §3.4a colourMode: H2''s garment median must sit within 12 L* of a substantial H0 level or H0's own median.
    const cm = V.colourMode;
    let modeDistance = Number.NaN;
    if (support > 0) {
      const binOf = (value: number) => Math.min(cm.bins - 1, Math.floor(10 * Math.min(100, Math.max(0, value))));
      for (let index = 0; index < pixels; index++) {
        if (!kept[index]) continue;
        hist0[binOf(labA[index * 3]!)]!++;
        hist2[binOf(labB[index * 3]!)]!++;
      }
      const halfWindow = Math.round(cm.window / cm.binWidth), stepBins = Math.round(cm.levelStep / cm.binWidth);
      const windowOf = (k: number) => [Math.max(0, stepBins * k - halfWindow), Math.min(cm.bins - 1, stepBins * k + halfWindow - 1)] as const;
      for (let k = 0; k < cm.levels; k++) {
        const [from, to] = windowOf(k);
        let total = 0;
        for (let bin = from; bin <= to; bin++) total += hist0[bin]!;
        levels[k] = total;
      }
      const m2Median = lowerMedian(hist2, 0, cm.bins - 1, cm.binWidth);
      const median0 = lowerMedian(hist0, 0, cm.bins - 1, cm.binWidth);
      const modes: CleanupMode[] = [];
      for (let k = 0; k < cm.levels; k++) {
        const here = levels[k]!, before = k > 0 ? levels[k - 1]! : -1, after = k + 1 < cm.levels ? levels[k + 1]! : -1;
        if (here < before || here < after || !CLEANUP_RULES.modeQualifies(here, support)) continue;
        const [from, to] = windowOf(k);
        modes.push({ level: lowerMedian(hist0, from, to, cm.binWidth), share: here / support, chosen: false });
      }
      modeDistance = Math.abs(m2Median - median0);
      let chosen = -1;
      for (const [index, mode] of modes.entries()) {
        const distance = Math.abs(m2Median - mode.level);
        if (distance < modeDistance) { modeDistance = distance; chosen = index; }
      }
      if (chosen >= 0) modes[chosen]!.chosen = true;
      let modeShare = 0;
      for (const mode of modes) if (Math.abs(m2Median - mode.level) <= cm.maximum && mode.share > modeShare) modeShare = mode.share;
      Object.assign(metrics, { modeDistance, resultMedian: m2Median, median0, medianChosen: chosen < 0, modeShare, modes });
    }

    // §3.3 removed: R pixels far from M2' (outside dilate(M2', 6); on the identity pass, outside M2' itself) whose raw H0
    // colour is a garment colour of K' (raw H0 Lab on both sides).
    let removedCount = 0, paletteBins = 0;
    if (support > 0) {
      const abBins = rm.abBins, lBins = rm.lightnessBins;
      const lBin = (value: number) => Math.min(lBins - 1, Math.max(0, Math.floor(value / rm.lightnessStep)));
      const abBin = (value: number) => Math.min(abBins - 1, Math.max(0, Math.floor((value + 128) / rm.abStep)));
      const at = (bl: number, ba: number, bb: number) => (bl * abBins + ba) * abBins + bb;
      for (let index = 0; index < pixels; index++) {
        if (!kept[index]) continue;
        const l = index * 3;
        palette[at(lBin(labA[l]!), abBin(labA[l + 1]!), abBin(labA[l + 2]!))]!++;
      }
      // The 3x3x3 neighbourhood sum as three separable passes, clamped at the edges.
      const sizes = [lBins, abBins, abBins], strides = [abBins * abBins, abBins, 1];
      for (let axis = 0; axis < 3; axis++) {
        const length = sizes[axis]!, stride = strides[axis]!;
        for (let start = 0; start < palette.length; start++) {
          if (Math.floor(start / stride) % length !== 0) continue;
          for (let k = 0; k < length; k++) lineA[k] = palette[start + k * stride]!;
          for (let k = 0; k < length; k++) {
            palette[start + k * stride] = lineA[k]! + (k > 0 ? lineA[k - 1]! : 0) + (k + 1 < length ? lineA[k + 1]! : 0);
          }
        }
      }
      const garment = rm.paletteShare * support;
      for (let bin = 0; bin < palette.length; bin++) if (palette[bin]! >= garment) paletteBins++;
      const coloured = (from: number, to: number, a: number, bValue: number) => {
        const ba = abBin(a), bb = abBin(bValue);
        for (let bl = from; bl <= to; bl++) if (palette[at(bl, ba, bb)]! >= garment) return true;
        return false;
      };
      for (let index = 0; index < pixels; index++) {
        if (!reference[index] || (identity ? m2w[index]! & 1 : dm2w[index])) continue;
        const l = index * 3, L = labA[l]!, a = labA[l + 1]!, bValue = labA[l + 2]!;
        const from = lBin(lo0[index]!), to = lBin(hi0[index]!);
        let hit = coloured(from, to, a, bValue);
        if (!hit && L >= rm.scaleMinimumLightness) {
          const scale = hi0[index]! / L;
          if (scale <= rm.maximumScale) hit = coloured(from, to, a * scale, bValue * scale);
        }
        if (hit) removedCount++;
      }
    }
    const removed = areaM2w ? removedCount / areaM2w : Number.NaN;
    Object.assign(metrics, { removed, paletteBins });
    await pace(pixels);

    // §3.5 change: r(p), the smallest shading-tolerant distance from H2'(p) to the corrected H0 in p's 3x3 neighbourhood.
    const ch = V.change;
    let changeShare = Number.NaN;
    if (support > 0) {
      const shiftL = Number.isFinite(deltaL) ? deltaL : 0;
      const cosT = Math.cos(hue * RAD) * chroma, sinT = Math.sin(hue * RAD) * chroma;
      let exceeded = 0, residuals = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = y * width + x;
          if (!kept[index]) continue;
          const l = index * 3, L2 = labB[l]!, a2 = labB[l + 1]!, b2 = labB[l + 2]!;
          let best = Infinity;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const q = ny * width + nx;
            if (!erodedR[q]) continue;
            const lq = q * 3, L1 = labA[lq]! + shiftL, a0 = labA[lq + 1]!, b0 = labA[lq + 2]!;
            const a1 = a0 * cosT - b0 * sinT, b1 = a0 * sinT + b0 * cosT;
            const distance = Math.abs(L1 - L2) <= ch.shadingTolerance
              ? ciede2000(L1, a1, b1, L2, a2, b2, 1, ch.chromaWeight, true)
              : ciede2000(L1, a1, b1, L2, a2, b2, ch.lightnessWeight, 1, false);
            if (distance < best) best = distance;
          }
          scratch[residuals++] = best;
          if (best >= ch.residual) exceeded++;
        }
        await pace(width * 9);
      }
      changeShare = exceeded / support;
      const sorted = scratch.subarray(0, residuals).sort();
      metrics.residualP50 = percentile(sorted, residuals, 0.5);
      metrics.residualP95 = percentile(sorted, residuals, 0.95);
    }
    metrics.changeShare = changeShare;

    // §3.5a patternLoss: local hue variety over K' (C* >= 12) that H0 shows and H2' has lost.
    const pl = V.patternLoss;
    let patternLoss = Number.NaN;
    if (support > 0) {
      const pr = pl.radius, none = 255;
      const hueBins = 360 / pl.hueBin;
      // The 17x17 window count of K' pixels whose hue bin (in scratch) is `bin`, or any bin when `bin` < 0.
      const windowSum = async (bin: number, dst: Uint16Array) => {
        for (let y = 0; y < height; y++) {
          const row = y * width;
          let running = 0;
          for (let x = 0; x < width + pr; x++) {
            if (x < width) {
              const v = scratch[row + x]!;
              if (bin < 0 ? v !== none : v === bin) running++;
            }
            const drop = x - 2 * pr - 1;
            if (drop >= 0) {
              const v = scratch[row + drop]!;
              if (bin < 0 ? v !== none : v === bin) running--;
            }
            if (x >= pr) dst[row + x - pr] = running;
          }
        }
        for (let x = 0; x < width; x++) {
          for (let y = 0; y < height; y++) lineB[y] = dst[y * width + x]!;
          let running = 0;
          for (let y = 0; y < height + pr; y++) {
            if (y < height) running += lineB[y]!;
            if (y - 2 * pr - 1 >= 0) running -= lineB[y - 2 * pr - 1]!;
            if (y >= pr) dst[(y - pr) * width + x] = running;
          }
        }
        await pace(pixels * 2);
      };
      // One image's per-pixel hue range into `ranges` (0xffff when undefined), from the Lab buffer `lab`. A bin with no
      // qualifying K' pixel anywhere can't be occupied in any window, so it is skipped.
      const rangesOf = async (lab: Float32Array, ranges: Uint16Array | null) => {
        let present = 0, presentHigh = 0;
        for (let index = 0; index < pixels; index++) {
          const l = index * 3, a = lab[l + 1]!, bValue = lab[l + 2]!;
          if (!kept[index] || Math.hypot(a, bValue) < pl.chroma) { scratch[index] = none; continue; }
          const degrees = (Math.atan2(bValue, a) / RAD + 360) % 360;
          const bin = Math.floor(degrees / pl.hueBin) % hueBins;
          scratch[index] = bin;
          if (bin < 32) present |= 1 << bin; else presentHigh |= 1 << (bin - 32);
        }
        await windowSum(-1, windowCount);
        maskLow.fill(0); maskHigh.fill(0);
        for (let bin = 0; bin < hueBins; bin++) {
          if (!(bin < 32 ? (present >>> bin) & 1 : (presentHigh >>> (bin - 32)) & 1)) continue;
          await windowSum(bin, binCount);
          const word = bin < 32 ? maskLow : maskHigh, bit = 1 << (bin % 32);
          for (let index = 0; index < pixels; index++) {
            if (!kept[index]) continue;
            const n = windowCount[index]!;
            if (CLEANUP_RULES.occupied(binCount[index]!, n)) word[index] = word[index]! | bit;
          }
        }
        let lost = 0, from = 0, undefinedCount = 0;
        for (let index = 0; index < pixels; index++) {
          if (!kept[index]) continue;
          const range = CLEANUP_RULES.patternDefined(windowCount[index]!) ? hueRange(maskLow[index]!, maskHigh[index]!) : -1;
          if (ranges) { ranges[index] = range < 0 ? 0xffff : range; if (range >= pl.lostFrom) from++; continue; }
          if (range < 0) { undefinedCount++; continue; }
          const before = range0[index]!;
          if (before !== 0xffff && CLEANUP_RULES.lost(before, range)) lost++;
        }
        return { lost, from, undefinedCount };
      };
      const first = await rangesOf(labA, range0);
      const second = await rangesOf(labB, null);
      patternLoss = second.lost / support;
      metrics.patternShare0 = first.from / support;
      metrics.patternUndefined2 = second.undefinedCount / support;
    }
    metrics.patternLoss = patternLoss;
    pacer.check();

    // §3.6 The first failure in the fixed order is the reason; every metric above is reported.
    let reason: CleanupReason | null = null;
    const judge = (name: CleanupReason, values: readonly number[], bad: () => boolean) => {
      if (reason) return;
      if (!values.every(Number.isFinite)) reason = 'nonFinite';
      else if (bad()) reason = name;
    };
    const rule = CLEANUP_RULES;
    judge('added', [added], () => rule.added(added, identity));
    judge('centre', [alignedCentroid.x, alignedCentroid.y], () => alignedCentroid.x < low || alignedCentroid.x >= high
      || alignedCentroid.y < low || alignedCentroid.y >= high);
    judge('retention', [retention], () => rule.retention(retained, areaR, pixels));
    judge('support', [support], () => rule.support(support, areaM2w, pixels));
    judge('clipped', [fitted], () => rule.clipped(fitted));
    judge('colourShift', [deltaL, chroma, hue], () => rule.colourShift(deltaL, chroma, hue));
    judge('colourMode', [modeDistance], () => rule.colourMode(modeDistance));
    judge('removed', [removed], () => rule.removed(removed));
    judge('change', [changeShare], () => rule.change(changeShare));
    judge('patternLoss', [patternLoss], () => rule.patternLoss(patternLoss));
    return reason ? fail(reason) : { accepted: true, metrics };
  };
  const atIdentity = options.alignedOnly ? null : await evaluate({ ncc: Number.NaN, s: 1, tx: 0, ty: 0 }, undefined, true);
  if (atIdentity?.accepted) return atIdentity;

  // The region cells (then pixels) as an ordered list in `queue`, free after the bands; per candidate, the sampled
  // column and row depend only on x and y, so they are tabulated in lineA and lineB (-1 when out of frame).
  let cells = 0;
  for (let qy = 0; qy < qh; qy++) for (let qx = 0; qx < qw; qx++) {
    if (r6[(qy * block + block / 2) * width + qx * block + block / 2]) queue[cells++] = qy * qw + qx;
  }
  let coarse: Candidate | null = null;
  for (let sc = scaleFrom; sc <= scaleTo; sc += Math.round(al.coarseScaleStep * 100)) {
    const s = sc / 100;
    for (let ty = -al.translation; ty <= al.translation; ty += al.coarseStep) {
      for (let qy = 0; qy < qh; qy++) {
        const iy = Math.floor((cy + (qy * block + block / 2 - ty - cy) / s) / block);
        lineB[qy] = iy >= 0 && iy < qh ? iy : -1;
      }
      for (let tx = -al.translation; tx <= al.translation; tx += al.coarseStep) {
        for (let qx = 0; qx < qw; qx++) {
          const ix = Math.floor((cx + (qx * block + block / 2 - tx - cx) / s) / block);
          lineA[qx] = ix >= 0 && ix < qw ? ix : -1;
        }
        let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
        for (let k = 0; k < cells; k++) {
          const cell = queue[k]!, qx = cell % qw, ix = lineA[qx]!, iy = lineB[(cell - qx) / qw]!;
          const a = g0q[cell]!, v = ix >= 0 && iy >= 0 ? g2q[iy * qw + ix]! : 0;
          sa += a; sb += v; sab += a * v; saa += a * a; sbb += v * v;
        }
        const next = { ncc: ncc(sa, sb, sab, saa, sbb, cells), s, tx, ty };
        if (next.ncc > -Infinity && better(next, coarse)) coarse = next;
        await pace(cells + qw);
      }
    }
  }
  let transform: Candidate = { ncc: Number.NaN, s: 1, tx: 0, ty: 0 };
  const alignmentFlat = coarse === null;
  if (coarse) {
    gradientInto(signal0, width, height, scratch);
    gradientInto((index) => mid2[index]!, width, height, grad2);
    let region = 0;
    for (let index = 0; index < pixels; index++) if (r6[index]) queue[region++] = index;
    await pace(pixels);
    let refined: Candidate | null = null;
    const center = Math.round(coarse.s * 100), refineStep = Math.round(al.refineScaleStep * 100), refineSpan = Math.round(al.refineScale * 100);
    for (let sc = Math.max(scaleFrom, center - refineSpan); sc <= Math.min(scaleTo, center + refineSpan); sc += refineStep) {
      const s = sc / 100;
      for (let ty = Math.max(-al.translation, coarse.ty - al.refineTranslation); ty <= Math.min(al.translation, coarse.ty + al.refineTranslation); ty++) {
        for (let y = 0; y < height; y++) {
          const iy = Math.floor(cy + (y + 0.5 - ty - cy) / s);
          lineB[y] = iy >= 0 && iy < height ? iy * width : -1;
        }
        for (let tx = Math.max(-al.translation, coarse.tx - al.refineTranslation); tx <= Math.min(al.translation, coarse.tx + al.refineTranslation); tx++) {
          for (let x = 0; x < width; x++) {
            const ix = Math.floor(cx + (x + 0.5 - tx - cx) / s);
            lineA[x] = ix >= 0 && ix < width ? ix : -1;
          }
          let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
          for (let k = 0; k < region; k++) {
            const index = queue[k]!, x = index % width, ix = lineA[x]!, row = lineB[(index - x) / width]!;
            const a = scratch[index]!, v = ix >= 0 && row >= 0 ? grad2[row + ix]! : 0;
            sa += a; sb += v; sab += a * v; saa += a * a; sbb += v * v;
            if ((k & 4095) === 4095) await pace(4096);
          }
          const next = { ncc: ncc(sa, sb, sab, saa, sbb, region), s, tx, ty };
          if (next.ncc > -Infinity && better(next, refined)) refined = next;
        }
      }
    }
    transform = refined ?? coarse;
  }
  const aligned = await evaluate(transform, alignmentFlat, false);
  if (atIdentity) {
    aligned.metrics.identityReason = (atIdentity as { reason: CleanupReason }).reason;
    aligned.metrics.identityAdded = atIdentity.metrics.added;
    aligned.metrics.identityRemoved = atIdentity.metrics.removed;
  }
  return aligned;
}
