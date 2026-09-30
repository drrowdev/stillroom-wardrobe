// BG2c-3 (plan rev8 §3, §5.1, §5.2): cleanupCheck v2 structure. The frozen record and its hash, the working-buffer
// total, the production gates at their exact boundaries, cooperative scheduling and abort, the unchanged rev4 stage
// negatives (X14) and the square morphology. The §4 fixture sets live in cleanup-check-*.test.ts.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, CLEANUP_CHECK_VERSION, CLEANUP_V2, CLEANUP_V2_SHA256 } from '../../src/images/cleanup-calibration';
import { CLEANUP_RULES, cleanupCheck, cleanupYield, FIDELITY, morph } from '../../src/images/fidelity';
import {
  checkScenes, GARMENT, GARMENT_MASK, grey, h0Of, h2Of, inBox, lch, maskOf, N, solid, W, H, within, type Box,
} from './cleanup-fixtures';

const navy = lch(30, 30, 270);
const G = GARMENT;
const NEXT_UP = (x: number) => x + Math.max(Number.EPSILON * Math.abs(x), Number.MIN_VALUE) * 2;
const NEXT_DOWN = (x: number) => x - Math.max(Number.EPSILON * Math.abs(x), Number.MIN_VALUE) * 2;

describe('the frozen calibration record', () => {
  it('pins CLEANUP_V2 by the SHA-256 of its canonical JSON, and is deeply frozen', () => {
    expect(CLEANUP_CHECK_VERSION).toBe(2);
    expect(createHash('sha256').update(canonicalJson(CLEANUP_V2)).digest('hex')).toBe(CLEANUP_V2_SHA256);
    expect(Object.isFrozen(CLEANUP_V2)).toBe(true);
    expect(Object.isFrozen(CLEANUP_V2.patternLoss)).toBe(true);
    expect(canonicalJson({ b: [1, { d: 2, c: 3 }], a: 'x' })).toBe('{"a":"x","b":[1,{"c":3,"d":2}]}');
  });

  it('reports version 2 and the §3.8 working-buffer total of 5,839,972 B (71.29 N)', async () => {
    const verdict = await checkScenes(solid(G, navy), solid(G, navy));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.checkVersion).toBe(2);
    expect(verdict.metrics.workingBytes).toBe(5_839_972);
    expect(FIDELITY.width * FIDELITY.height).toBe(81_920);
  }, 30_000);
});

describe('production gates at their exact boundaries (§5.2)', () => {
  const k = CLEANUP_V2.fit.minimumPixels, minSupport = Math.ceil(CLEANUP_V2.minimumMaskFraction * N);

  it('count gates: n = k - 1 fails and n = k passes', () => {
    expect(CLEANUP_RULES.clipped(k - 1)).toBe(true);
    expect(CLEANUP_RULES.clipped(k)).toBe(false);
    expect(minSupport).toBe(1_639);
    expect(CLEANUP_RULES.support(minSupport - 1, 0, N)).toBe(true);
    expect(CLEANUP_RULES.support(minSupport, 0, N)).toBe(false);
    // The retention floor of 2 % of N is a count gate too.
    expect(CLEANUP_RULES.retention(minSupport - 1, minSupport, N)).toBe(true);
    expect(CLEANUP_RULES.retention(minSupport, minSupport, N)).toBe(false);
    expect(CLEANUP_RULES.retention(0, 0, N)).toBe(true);
  });

  it('ratio gates: the exact threshold and its nearest neighbours', () => {
    // BG2c-3b (#84): `added` is 0.25 on the identity pass and 0.21 on the aligned pass.
    for (const [identity, T] of [[true, 0.25], [false, 0.21]] as const) {
      expect(CLEANUP_RULES.added(T, identity)).toBe(true);
      expect(CLEANUP_RULES.added(NEXT_DOWN(T), identity)).toBe(false);
      expect(CLEANUP_RULES.added(NEXT_UP(T), identity)).toBe(true);
    }
    expect(CLEANUP_RULES.added(0.22, false)).toBe(true);
    expect(CLEANUP_RULES.added(0.22, true)).toBe(false);
    for (const [gate, T] of [[CLEANUP_RULES.removed, 0.07], [CLEANUP_RULES.change, 0.2],
      [CLEANUP_RULES.patternLoss, 0.25]] as const) {
      expect(gate(T)).toBe(true);
      expect(gate(NEXT_DOWN(T))).toBe(false);
      expect(gate(NEXT_UP(T))).toBe(true);
    }
    // Retention: at least 0.20 of |R|; the share of M2' in support: at least 0.25.
    expect(CLEANUP_RULES.retention(20_000, 100_000, N)).toBe(false);
    expect(CLEANUP_RULES.retention(19_999, 100_000, N)).toBe(true);
    expect(CLEANUP_RULES.support(2_500, 10_000, N)).toBe(false);
    expect(CLEANUP_RULES.support(2_499, 10_000, N)).toBe(true);
  });

  it('colourShift: ±12 L*, c in [0.8, 1.25] and ±8° are inclusive bounds', () => {
    expect(CLEANUP_RULES.colourShift(12, 1, 0)).toBe(false);
    expect(CLEANUP_RULES.colourShift(-12, 1, 0)).toBe(false);
    expect(CLEANUP_RULES.colourShift(NEXT_UP(12), 1, 0)).toBe(true);
    expect(CLEANUP_RULES.colourShift(0, 0.8, 0)).toBe(false);
    expect(CLEANUP_RULES.colourShift(0, NEXT_DOWN(0.8), 0)).toBe(true);
    expect(CLEANUP_RULES.colourShift(0, 1.25, 0)).toBe(false);
    expect(CLEANUP_RULES.colourShift(0, NEXT_UP(1.25), 0)).toBe(true);
    expect(CLEANUP_RULES.colourShift(0, 1, -8)).toBe(false);
    expect(CLEANUP_RULES.colourShift(0, 1, NEXT_UP(8))).toBe(true);
  });

  it('colourMode: G = 12 passes and above fails; W = 0.22 qualifies and just below does not', () => {
    expect(CLEANUP_RULES.colourMode(12)).toBe(false);
    expect(CLEANUP_RULES.colourMode(NEXT_UP(12))).toBe(true);
    expect(CLEANUP_RULES.modeQualifies(2_200, 10_000)).toBe(true);
    expect(CLEANUP_RULES.modeQualifies(2_199, 10_000)).toBe(false);
  });

  it('estimator fallback: below 500 qualifying pixels the neutral value is used, never a rejection', () => {
    expect(CLEANUP_RULES.fallback(499)).toBe(true);
    expect(CLEANUP_RULES.fallback(500)).toBe(false);
  });

  it('patternLoss: the defined, occupied and lost boundaries', () => {
    expect(CLEANUP_RULES.patternDefined(31)).toBe(false);
    expect(CLEANUP_RULES.patternDefined(32)).toBe(true);
    // max(3, ceil(0.05 n)): 3 for n up to 60, then ceil(0.05 n).
    expect(CLEANUP_RULES.occupied(3, 32)).toBe(true);
    expect(CLEANUP_RULES.occupied(2, 32)).toBe(false);
    expect(CLEANUP_RULES.occupied(15, 289)).toBe(true);
    expect(CLEANUP_RULES.occupied(14, 289)).toBe(false);
    expect(CLEANUP_RULES.lost(30, 10)).toBe(true);
    expect(CLEANUP_RULES.lost(20, 10)).toBe(false);
    expect(CLEANUP_RULES.lost(30, 20)).toBe(false);
  });

  it('a neutral garment falls back to c = 1 and θ = 0 and still fails a gross lightness change', async () => {
    const verdict = await checkScenes(solid(G, grey(40)), solid(G, grey(60)));
    expect(verdict.metrics).toMatchObject({ fallbackC: true, fallbackTheta: true, chroma: 1, hue: 0 });
    expect(verdict).toMatchObject({ accepted: false, reason: 'colourShift' });
  }, 30_000);

  it('colourMode keeps an unchanged 45/10/45 multitone at G = 0 through H0\'s own median', async () => {
    const tones = within((x, y) => inBox(G, x, y), (_x, y) => { const u = (y - G.top) / G.height; return grey(u < 0.45 ? 30 : u < 0.55 ? 50 : 70); });
    const verdict = await checkScenes(tones, tones);
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.modeDistance).toBe(0);
    expect(verdict.metrics.medianChosen).toBe(true);
    expect(verdict.metrics.modes!.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe('cooperative scheduling and abort (§3.7)', () => {
  const h0 = h0Of(within((x, y) => inBox(G, x, y), (x) => (x >> 3) % 2 ? lch(40, 30, 30) : lch(60, 30, 200)));
  const h2 = h2Of(solid(G, lch(50, 30, 120)));

  it('the verdict and every metric are identical whether it always yields, never yields, or uses either primitive', async () => {
    const never = await cleanupCheck(h0, GARMENT_MASK, h2, { now: () => 0, yieldNow: async () => undefined });
    let clock = 0, yields = 0;
    const always = await cleanupCheck(h0, GARMENT_MASK, h2, { now: () => (clock += 100), yieldNow: async () => { yields++; } });
    expect(yields).toBeGreaterThan(100);
    expect(always).toEqual(never);
    const channel = cleanupYield({ MessageChannel });
    expect(channel.kind).toBe('channel');
    expect(await cleanupCheck(h0, GARMENT_MASK, h2, { now: () => (clock += 100), yieldNow: channel.run })).toEqual(never);
    const scheduler = cleanupYield({ scheduler: { yield: () => Promise.resolve() }, MessageChannel });
    expect(scheduler.kind).toBe('scheduler');
    expect(await cleanupCheck(h0, GARMENT_MASK, h2, { now: () => (clock += 100), yieldNow: scheduler.run })).toEqual(never);
    expect(never.accepted).toBe(false);
    expect(never.metrics.patternLoss).toBeGreaterThan(0.5);
  }, 60_000);

  it('picks scheduler.yield, else a MessageChannel, and never uses setTimeout', async () => {
    expect(() => cleanupYield({})).toThrow('no yield primitive');
    expect(cleanupYield({ scheduler: {}, MessageChannel }).kind).toBe('channel');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      let clock = 0;
      await cleanupCheck(h0, GARMENT_MASK, h2, { now: () => (clock += 100), yieldNow: cleanupYield({ MessageChannel }).run });
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  }, 30_000);

  it('rejects with the signal\'s reason when aborted before or during the check', async () => {
    const before = new AbortController();
    before.abort(new Error('skipped'));
    await expect(cleanupCheck(h0, GARMENT_MASK, h2, { signal: before.signal })).rejects.toThrow('skipped');
    const during = new AbortController();
    let clock = 0, yields = 0;
    const run = cleanupCheck(h0, GARMENT_MASK, h2, {
      signal: during.signal, now: () => (clock += 100),
      yieldNow: async () => { if (++yields === 20) during.abort(new Error('timed out')); },
    });
    await expect(run).rejects.toThrow('timed out');
    expect(yields).toBe(20);
  }, 30_000);
});

describe('rev4 stage negatives (X14), unchanged in v2', () => {
  const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });
  it('size', async () => {
    const h0 = h0Of(solid(G, navy));
    await expect(cleanupCheck(new Uint8ClampedArray(4), GARMENT_MASK, h0)).resolves.toMatchObject({ accepted: false, reason: 'size' });
    await expect(cleanupCheck(h0, new Uint8Array(N - 1), h0)).resolves.toMatchObject({ accepted: false, reason: 'size' });
  });

  it('background: a non-plain or wrong-colour perimeter', async () => {
    const ragged = (x: number, y: number) => (x < 6 || y < 6 || x >= W - 6 || y >= H - 6) && (x + y) % 3 === 0 ? grey(45) : inBox(G, x, y) ? navy : null;
    expect(await checkScenes(solid(G, navy), ragged)).toMatchObject({ accepted: false, reason: 'background' });
    expect(await checkScenes(solid(G, navy), (x, y) => inBox(G, x, y) ? navy : grey(80))).toMatchObject({ accepted: false, reason: 'background' });
  }, 30_000);

  it('emptyMask and tinyMask', async () => {
    expect(await checkScenes(solid(G, navy), () => null)).toMatchObject({ accepted: false, reason: 'emptyMask' });
    expect(await checkScenes(solid(G, navy), solid(box(120, 150, 20, 20), navy))).toMatchObject({ accepted: false, reason: 'tinyMask' });
  }, 30_000);

  it('ambiguousMask: the result touches all four edges', async () => {
    const cross = (x: number, y: number) => (x >= 124 && x < 132) || (y >= 156 && y < 164) || inBox(G, x, y) ? navy : null;
    expect(await checkScenes(solid(G, navy), cross)).toMatchObject({ accepted: false, reason: 'ambiguousMask' });
  }, 30_000);

  it('pieces: a result split in two', async () => {
    const left = box(40, 60, 80, 200), right = box(136, 60, 80, 200), whole = box(40, 60, 176, 200);
    const split = (x: number, y: number) => inBox(left, x, y) || inBox(right, x, y) ? navy : null;
    const reference = maskOf((x, y) => inBox(whole, x, y));
    expect(await checkScenes(solid(whole, navy), split, reference)).toMatchObject({ accepted: false, reason: 'pieces' });
  }, 30_000);

  it('centre: the kept garment is off centre', async () => {
    const off = box(12, 60, 78, 200);
    const reference = maskOf((x, y) => inBox(off, x, y) || inBox(G, x, y));
    const verdict = await checkScenes((x, y) => inBox(off, x, y) || inBox(G, x, y) ? navy : null, solid(off, navy), reference);
    expect(verdict).toMatchObject({ accepted: false, reason: 'centre' });
  }, 30_000);

  it('nonFinite is a defensive guard that byte inputs never reach', async () => {
    for (const result of [solid(G, navy), () => null, solid(G, grey(0))]) {
      expect(((await checkScenes(solid(G, navy), result)) as { reason?: string }).reason).not.toBe('nonFinite');
    }
  }, 30_000);
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
  it('reads bit 0 only, so flag bits above it are ignored', () => {
    const src = new Uint8Array(size * size).fill(4);
    src[27] = 5;
    morph(src, out, tmp, size, size, 0, false);
    expect([...out].reduce((sum, value) => sum + value, 0)).toBe(1);
  });
});
