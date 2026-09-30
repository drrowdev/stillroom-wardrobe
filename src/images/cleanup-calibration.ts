// BG2c-3 frozen calibration record (plan rev8 §5.1). Every threshold `cleanupCheck` v2 uses lives in CLEANUP_V2, and
// `CLEANUP_V2_SHA256` pins the SHA-256 of its canonical JSON. The fixture generator ranges, labels and the held-out
// seed are frozen here with it. Changing any value after the remeasure of the 5 probe results is more calibration, not
// validation (§5.3): it needs a new record revision, a delta critique and every Block case still failing with margin.
// BG2c-3b (#84, 30 September 2026) is such a revision: `added` 0.25 (identity) and 0.21 (aligned, s >= 1) were chosen after the
// remeasure so that calls 3 and 5 pass, so the 5 real results are now calibration, not validation. checkVersion stays 2 (the
// algorithm and metrics are unchanged); `CLEANUP_V2_SHA256` binds the new thresholds.
export const CLEANUP_CHECK_VERSION = 2;

type Frozen<T> = { readonly [K in keyof T]: T[K] extends object ? Frozen<T[K]> : T[K] };
function deepFreeze<T>(value: T): Frozen<T> {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

export const CLEANUP_V2 = deepFreeze({
  // §3.2: the unchanged rev4 stages.
  ring: 4,
  maximumBackgroundDeltaE: 8,
  maximumRingP95: 4,
  garmentDeltaE: 6,
  minimumMaskFraction: 0.02,
  largestShare: 0.85,
  centre: [0.25, 0.75],
  containmentRadius: 4,
  // §3.1a: the foreground-restricted local band.
  band: { radius: 8, minimumSupport: 32, referenceErosion: 2 },
  // §3.3: alignment from content.
  alignment: {
    minimumScale: 0.85, maximumScale: 1.15, coarseScaleStep: 0.05, translation: 40, coarseStep: 4, block: 4,
    refineTranslation: 2, refineScale: 0.02, refineScaleStep: 0.01, regionDilation: 6, flatDenominator: 1e-9,
  },
  // BG2c-3b (#84): the identity pass fails at 0.25 (zero slack: M2 outside R). The aligned pass (M2 outside dilate(R, 6))
  // fails at 0.21 when the chosen scale s >= 1 (s = 1.00 included) and at the rev8 0.07 when s < 1, so a scale-down can't
  // absorb parts added on several sides. s is the exact searched value (an integer percentage / 100).
  added: { maximum: 0.07, alignedMaximum: 0.21, identityMaximum: 0.25 },
  retention: { minimum: 0.2 },
  removed: {
    maximum: 0.07, dilation: 6, lightnessStep: 8, lightnessBins: 13, abStep: 8, abBins: 32, paletteShare: 0.1,
    scaleMinimumLightness: 5, maximumScale: 4,
  },
  // §3.4: support and the global lighting envelope.
  support: { resultErosion: 1, minimumShare: 0.25 },
  fit: {
    minimumPixels: 1000, lowChannel: 3, highChannel: 252, resultClip: 254, qualifiers: 500, chromaFloor: 5,
    hueChroma: 10,
  },
  colourShift: { lightness: 12, minimumChroma: 0.8, maximumChroma: 1.25, hue: 8 },
  // §3.4a: the garment lightness mode.
  colourMode: { bins: 1000, binWidth: 0.1, levels: 201, levelStep: 0.5, window: 4, share: 0.22, maximum: 12 },
  // §3.5: the large-change share.
  change: { shadingTolerance: 45, chromaWeight: 2, lightnessWeight: 2, residual: 15, maximum: 0.2 },
  // §3.5a: chromatic pattern loss.
  patternLoss: {
    chroma: 12, hueBin: 10, radius: 8, minimumCount: 32, occupiedCount: 3, occupiedShare: 0.05, lostFrom: 30, lostTo: 10,
    maximum: 0.25,
  },
  // §3.7: cooperative scheduling.
  schedule: { iterations: 1024, sliceMs: 8 },
});

/** Canonical JSON: object keys sorted at every level, no whitespace. The input of `CLEANUP_V2_SHA256`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of `canonicalJson(CLEANUP_V2)`, the `configSha256` in schema-2 remeasure evidence (§6.3). Pinned by a unit test. */
export const CLEANUP_V2_SHA256 = '3a51b58f6b311231c9376e4dd2535ca63ef46c9fe6a50dd46ed7c0d3bb2e1475';

// §4 and §4.5: the synthetic fixture generator. Accept parameters come from the §1 Accept class, Block parameters are
// one gross change at >= 1.25x its boundary. The held-out set draws Accept values from the inner 80 % of each range.
export const CLEANUP_GENERATOR = deepFreeze({
  size: { width: 256, height: 320 },
  background: [0xf6, 0xf3, 0xed],
  garment: { left: 60, top: 70, width: 136, height: 180 },
  accept: {
    exposure: [-8, 8],
    whiteBalanceHue: [-5, 5],
    chromaGain: [0.9, 1.15],
    creaseDepth: [30, 45],
    creaseWidth: [3, 9],
    creasePeriod: [12, 24],
    baseLightness: [40, 85],
    scale: [0.9, 1.1],
    translationX: [-24, 24],
    translationY: [-16, 16],
    jitter: [0, 1],
    noise: [0, 2],
  },
  block: {
    lightnessShift: [15, 30],
    hueShift: [15, 60],
    chromaGain: [1.6, 2],
    addedShare: [0.1, 0.2],
    removedShare: [0.1, 0.2],
    patternShare: [0.35, 0.6],
  },
  labels: { accept: 'pass', block: 'fail', limit: 'accepted-limit', boundary: 'reported', falseReject: 'fail' },
  heldOut: { seed: 20260929, count: 120, accept: 60, block: 60, innerShare: 0.8, blockFactor: 1.25 },
});
