// BG2c-3 (plan rev8 §5.2): fixture margins. Test code only; production never imports this. Production gates are tested
// separately at their exact boundaries. Accept fixtures must sit inside every gate's pass band; Block fixtures must
// fail for a named reason with at least one of the named gates beyond its fail band.
import { CLEANUP_V2 } from '../../src/images/cleanup-calibration';
import { FIDELITY, type CleanupMetrics, type CleanupReason } from '../../src/images/fidelity';

const V = CLEANUP_V2, N = FIDELITY.width * FIDELITY.height;

/** m = max(1, ceil(0.1k)) for count gates. */
export const countMargin = (k: number) => Math.max(1, Math.ceil(0.1 * k));
/** Upper-bounded ratio T (fail iff x >= T). */
export const upper = { pass: (x: number, T: number) => x <= 0.9 * T, fail: (x: number, T: number) => x >= 1.1 * T };
/** Lower-bounded ratio T (fail iff x < T). */
export const lower = {
  pass: (x: number, T: number) => x >= T + 0.1 * (1 - T),
  fail: (x: number, T: number) => x <= T - 0.1 * (1 - T),
};
/** Two-sided [a, b] (fail iff outside). */
export const twoSided = {
  pass: (x: number, a: number, b: number) => x >= a + 0.1 * (b - a) && x <= b - 0.1 * (b - a),
  fail: (x: number, a: number, b: number) => x < a - 0.1 * (b - a) || x > b + 0.1 * (b - a),
};
/** Lower-bounded count k (fail iff n < k). */
export const lowerCount = { pass: (n: number, k: number) => n >= k + countMargin(k), fail: (n: number, k: number) => n <= k - countMargin(k) };
/** Upper-bounded count k (fail iff n >= k); none in v2, kept for later. */
export const upperCount = { pass: (n: number, k: number) => n <= k - countMargin(k), fail: (n: number, k: number) => n >= k + countMargin(k) };
/** colourMode distance G (fail iff G > 12). */
export const modeDistance = { pass: (g: number) => g <= 0.9 * V.colourMode.maximum, fail: (g: number) => g >= 1.1 * V.colourMode.maximum };
/** colourMode mode share X, multiplicative (disclosed §5.2 choice). */
export const modeShare = { pass: (w: number) => w >= 1.1 * V.colourMode.share, fail: (w: number) => w <= 0.9 * V.colourMode.share };

const minimumSupport = Math.ceil(V.minimumMaskFraction * N);
/** BG2c-3b: the `added` limit of the path the metrics came from (identity 0.25; aligned 0.21 at s >= 1, else 0.07). */
export const addedLimit = (m: CleanupMetrics) => (m.path === 'identity' ? V.added.identityMaximum
  : m.scale! >= 1 ? V.added.alignedMaximum : V.added.maximum);
const cs = V.colourShift;

/** The gates an Accept fixture must clear with margin; returns the names of those it doesn't. */
export function passViolations(m: CleanupMetrics): string[] {
  const out: string[] = [];
  const need = (name: string, ok: boolean) => { if (!ok) out.push(name); };
  need('added', upper.pass(m.added!, addedLimit(m)));
  need('retention', lower.pass(m.retention!, V.retention.minimum));
  need('supportCount', lowerCount.pass(m.support!, minimumSupport));
  need('supportShare', lower.pass(m.support! / m.resultArea!, V.support.minimumShare));
  need('fitted', lowerCount.pass(m.fitted!, V.fit.minimumPixels));
  need('deltaL', twoSided.pass(m.deltaL!, -cs.lightness, cs.lightness));
  if (!m.fallbackC) need('chroma', twoSided.pass(m.chroma!, cs.minimumChroma, cs.maximumChroma));
  if (!m.fallbackTheta) need('hue', twoSided.pass(m.hue!, -cs.hue, cs.hue));
  need('colourMode', modeDistance.pass(m.modeDistance!));
  need('removed', upper.pass(m.removed!, V.removed.maximum));
  need('change', upper.pass(m.changeShare!, V.change.maximum));
  need('patternLoss', upper.pass(m.patternLoss!, V.patternLoss.maximum));
  return out;
}

/** Whether the named gate's metric lies beyond its fail band. */
export function beyondFail(m: CleanupMetrics, gate: CleanupReason): boolean {
  switch (gate) {
    case 'added': return upper.fail(m.added!, addedLimit(m));
    case 'removed': return upper.fail(m.removed!, V.removed.maximum);
    case 'change': return upper.fail(m.changeShare!, V.change.maximum);
    case 'patternLoss': return upper.fail(m.patternLoss!, V.patternLoss.maximum);
    case 'colourMode': return modeDistance.fail(m.modeDistance!);
    case 'retention': return lower.fail(m.retention!, V.retention.minimum);
    case 'clipped': return lowerCount.fail(m.fitted!, V.fit.minimumPixels);
    case 'support': return lowerCount.fail(m.support!, minimumSupport) || lower.fail(m.support! / m.resultArea!, V.support.minimumShare);
    case 'colourShift':
      return twoSided.fail(m.deltaL!, -cs.lightness, cs.lightness)
        || (!m.fallbackC && twoSided.fail(m.chroma!, cs.minimumChroma, cs.maximumChroma))
        || (!m.fallbackTheta && twoSided.fail(m.hue!, -cs.hue, cs.hue));
    default: return true;
  }
}
