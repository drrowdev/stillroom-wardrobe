// BG2c-3 (plan rev8 §4.2, §4.4): Block fixtures must fail for the named reason with that gate beyond its §5.2 fail band.
// Disclosed false rejects (F1, F2, and L11, the retired positive) are asserted as failing; F3 passes since BG2c-3b. X14 (the rev4 stage
// negatives) is in cleanup-check.test.ts; the chromatic Block cases X2, X3, red X9/X15 and chromatic X16 are in
// cleanup-check-colour.test.ts.
import { describe, expect, it } from 'vitest';
import {
  bandAt, checkScenes, creased, criticStripe, expectBlocked, fromRgb, GARMENT, greenTealCheck, grey, inBox, lch, maskOf, noisy,
  posed, relit, solid, within, type Box, type Lab, type Paint,
} from './cleanup-fixtures';

const G = GARMENT;
const navy = lch(30, 30, 270);
const inG = (x: number, y: number) => inBox(G, x, y);
const rows = (y: number) => y >= 72 && y < 248;
const minus = (outer: Box, cut: Box, colour: Lab): Paint => (x, y) => inBox(outer, x, y) && !inBox(cut, x, y) ? colour : null;
const plus = (boxes: Box[], colour: (x: number, y: number) => Lab): Paint => (x, y) => boxes.some((b) => inBox(b, x, y)) ? colour(x, y) : null;
const sparkle = (base: number, lit: number, size = 3) => within(inG, (x, y) => rows(y) && bandAt(x, size, 16) ? grey(lit) : grey(base));

describe('Block fixtures fail with margin (§4.2)', () => {
  it('X1 the critic\'s grey 64 → 100 fails colourShift', async () => {
    expectBlocked(await checkScenes(solid(G, fromRgb(64, 64, 64)), solid(G, fromRgb(100, 100, 100))), ['colourShift']);
  }, 30_000);

  it('X4 a partial chromatic recolour of 30 % fails colourShift or change', async () => {
    const recolour = within(inG, (x) => x < G.left + 0.3 * G.width ? lch(40, 45, 30) : navy);
    expectBlocked(await checkScenes(solid(G, navy), recolour), ['colourShift', 'change']);
  }, 30_000);

  it('X5 dark/light stripes disappear or appear, and a chromatic print appears over 35 %', async () => {
    const stripes = within(inG, (x) => bandAt(x, 8, 16) ? grey(10) : grey(75));
    expectBlocked(await checkScenes(stripes, solid(G, grey(75))), ['change', 'colourMode']);
    expectBlocked(await checkScenes(solid(G, grey(75)), stripes), ['colourShift', 'change', 'colourMode']);
    const print = within(inG, (_x, y) => (y - G.top) < 0.35 * G.height ? lch(45, 45, 30) : navy);
    expectBlocked(await checkScenes(solid(G, navy), print), ['colourShift', 'change']);
  }, 60_000);

  // X6 and X8 pass since BG2c-3b (identity `added` 0.25) and are asserted as the owner-accepted escape L17 in
  // cleanup-check-accept.test.ts. X7 still fails: its identity pass fails a gate, and the aligned pass keeps 0.07.
  it('X7 the addition plus a genuine ×1.1 pose change fails added', async () => {
    const add: Box = { left: G.left + G.width, top: 110, width: 30, height: 100 };
    expectBlocked(await checkScenes(solid(G, navy), posed(plus([G, add], () => navy), 1.1)), ['added']);
  }, 30_000);


  describe('X9 a same-colour sleeve (12 %) removed fails removed', () => {
    const sleeve: Box = { left: G.left + G.width - 30, top: G.top, width: 30, height: 100 };
    it.each([
      ['as is', 0, 0], ['relit +11', 11, 0], ['relit -8', -8, 0], ['with a 6° white-balance shift', 0, 6],
    ] as const)('%s', async (_label, dL, hue) => {
      const colour = lch(40, 25, 270);
      expectBlocked(await checkScenes(solid(G, colour), relit(minus(G, sleeve, colour), dL, hue)), ['removed']);
    }, 30_000);
    it('with sleeve and body either side of a bin edge (8-bit greys 47.64 / 48.04 and 40.32 / 47.64)', async () => {
      // 47.9, 48.1, 40.0 and 47.99 are not reachable in 8-bit sRGB; these are the nearest greys on the intended sides.
      for (const [part, body] of [[113, 114], [95, 113]] as const) {
        const scene: Paint = (x, y) => inBox(sleeve, x, y) ? fromRgb(part, part, part) : inG(x, y) ? fromRgb(body, body, body) : null;
        expectBlocked(await checkScenes(scene, minus(G, sleeve, fromRgb(body, body, body))), ['removed']);
      }
    }, 30_000);
    it('a creased sleeve', async () => {
      const scene: Paint = (x, y) => inBox(sleeve, x, y) && bandAt(x, 3, 8, sleeve.left) ? grey(30) : inG(x, y) ? grey(55) : null;
      expectBlocked(await checkScenes(scene, minus(G, sleeve, grey(55))), ['removed']);
    }, 30_000);
  });

  it('X10 a top turned into a trousers silhouette in the same colour fails added or removed', async () => {
    const torso: Box = { left: 88, top: 70, width: 80, height: 180 }, arms: Box = { left: 60, top: 70, width: 136, height: 60 };
    const legL: Box = { left: 80, top: 70, width: 40, height: 220 }, legR: Box = { left: 136, top: 70, width: 40, height: 220 };
    const reference = maskOf((x, y) => inBox(torso, x, y) || inBox(arms, x, y));
    expectBlocked(await checkScenes(plus([torso, arms], () => navy), plus([legL, legR, { left: 80, top: 70, width: 96, height: 40 }], () => navy), reference),
      ['added', 'removed']);
  }, 30_000);

  it('X11 a person or mannequin around the garment fails added', async () => {
    const head: Box = { left: 104, top: 20, width: 48, height: 50 }, armL: Box = { left: 30, top: 80, width: 30, height: 140 };
    const armR: Box = { left: 196, top: 80, width: 30, height: 140 };
    const person: Paint = (x, y) => inG(x, y) ? navy : inBox(head, x, y) || inBox(armL, x, y) || inBox(armR, x, y) ? lch(70, 20, 60) : null;
    expectBlocked(await checkScenes(solid(G, navy), person), ['added']);
  }, 30_000);

  it('X12 zoomed ×1.6 fails added', async () => {
    expectBlocked(await checkScenes(solid(G, navy), posed(solid(G, navy), 1.6)), ['added']);
  }, 30_000);

  it('X13 a flat 255 blow-out fails clipped', async () => {
    expectBlocked(await checkScenes(solid(G, fromRgb(220, 120, 90)), solid(G, fromRgb(255, 140, 105))), ['clipped']);
  }, 30_000);

  it('X15 the critic\'s same-colour strap removed (L40, L60, relit +11, and a creased body flattened)', async () => {
    const body: Box = { left: 78, top: 100, width: 100, height: 80 }, strap: Box = { left: 120, top: 180, width: 16, height: 80 };
    const reference = maskOf((x, y) => inBox(body, x, y) || inBox(strap, x, y));
    for (const L of [40, 60]) {
      expectBlocked(await checkScenes(plus([body, strap], () => grey(L)), solid(body, grey(L)), reference), ['removed']);
    }
    expectBlocked(await checkScenes(plus([body, strap], () => grey(40)), solid(body, grey(51)), reference), ['removed']);
    const creasedBody = plus([body, strap], (x, y) => inBox(body, x, y) && bandAt(x, 3, 12, body.left) ? grey(25) : grey(55));
    expectBlocked(await checkScenes(creasedBody, solid(body, grey(55)), reference), ['removed']);
  }, 60_000);

  it('X16 a narrow 16×200 and 20×200 belt 27.1 → 42.4, also with ±2 noise, fails colourShift', async () => {
    for (const width of [16, 20]) {
      const belt: Box = { left: 120, top: 60, width, height: 200 }, reference = maskOf((x, y) => inBox(belt, x, y));
      expectBlocked(await checkScenes(solid(belt, grey(27.1)), solid(belt, grey(42.4)), reference), ['colourShift']);
      // L10: noise lowers the envelope ΔL to about 13.3, inside the fail band; colourMode measures it from the mode.
      expectBlocked(await checkScenes(noisy(solid(belt, grey(27.1)), 2, 5), noisy(solid(belt, grey(42.4)), 2, 6), reference),
        ['colourShift', 'colourMode']);
    }
  }, 60_000);

  it('X17 NEW1: 27.1 with +25 highlights → 52.1, 47.1 and 57.1, with ±2 noise, and X1 with highlights → 42.4', async () => {
    for (const target of [52.1, 47.1, 57.1]) expectBlocked(await checkScenes(sparkle(27.1, 52.1), solid(G, grey(target))), ['colourMode', 'colourShift']);
    expectBlocked(await checkScenes(noisy(sparkle(27.1, 52.1), 2, 8), noisy(solid(G, grey(52.1)), 2, 9)), ['colourMode', 'colourShift']);
    expectBlocked(await checkScenes(sparkle(27.1, 52.1), solid(G, grey(42.4))), ['colourMode', 'colourShift']);
  }, 60_000);

  it('X18 NEW2: 27.1 with ±2, ±4 and ±6 texture → 42.4 and → 45.4', async () => {
    for (const amplitude of [2, 4, 6]) for (const target of [42.4, 45.4]) {
      expectBlocked(await checkScenes(noisy(solid(G, grey(27.1)), amplitude, 13), solid(G, grey(target))), ['colourMode', 'colourShift']);
    }
  }, 60_000);

  it('X19 EQUIV: L15 with 1 px +45 highlights every 16 → uniform 60 fails colourMode', async () => {
    expectBlocked(await checkScenes(sparkle(15, 60, 1), solid(G, grey(60))), ['colourMode']);
  }, 30_000);

  it('X20 the critic\'s chromatic stripe → the border colour, with ±2 noise, and → border +5 L* / +5° fails patternLoss', async () => {
    expectBlocked(await checkScenes(criticStripe(), solid(G, lch(50, 30, 30))), ['patternLoss']);
    expectBlocked(await checkScenes(noisy(criticStripe(), 2, 14), noisy(solid(G, lch(50, 30, 30)), 2, 15)), ['patternLoss']);
    expectBlocked(await checkScenes(criticStripe(), solid(G, lch(55, 30, 35))), ['patternLoss']);
  }, 60_000);

  it('X21 red/blue stripes (8, 12 and 24 px) → all red, and → the mean mix', async () => {
    for (const every of [8, 12, 24]) {
      const stripes = within(inG, (x) => bandAt(x, every / 2, every) ? lch(40, 40, 30) : lch(40, 40, 280));
      expectBlocked(await checkScenes(stripes, solid(G, lch(40, 40, 30))), ['colourShift', 'patternLoss', 'change']);
      expectBlocked(await checkScenes(stripes, solid(G, lch(40, 20, 335))), ['colourShift', 'patternLoss', 'change']);
    }
  }, 60_000);

  it('X22 the green/teal check → the mid colour, also with ±2 noise', async () => {
    expectBlocked(await checkScenes(greenTealCheck(), solid(G, lch(50, 35, 175))), ['colourShift', 'patternLoss', 'change']);
    expectBlocked(await checkScenes(noisy(greenTealCheck(), 2, 16), noisy(solid(G, lch(50, 35, 175)), 2, 17)), ['colourShift', 'patternLoss', 'change']);
  }, 60_000);
});

// rev8b: recentred parts. The result is shifted so its bounding box is centred again, as a clean-up that removes or adds
// a part would frame it. Areas are reported as a share of the 136×180 body (24,480 px), separately from the gate
// statistics, whose denominators are the gate's own (§5.2). Each must fail BOTH the identity and the aligned path.
// BG2c-3b: the recentred sleeve addition passes at identity (L17), and a recentred removal that is also enlarged by
// ×1.10-1.15 passes at identity (L18); both are owner-accepted escapes asserted in cleanup-check-accept.test.ts.
describe('rev8b recentred removals fail both paths with margin', () => {
  const BODY = G.width * G.height;
  const shifted = (paint: Paint, dx: number, dy: number): Paint => (x, y) => paint(x - dx, y - dy);
  const part = (label: string, box: Box) => `${label} ${box.width}×${box.height} (${(100 * box.width * box.height / BODY).toFixed(1)} % of the 24,480 px body)`;
  const strip = (w: number): Box => ({ left: G.left + G.width - w, top: G.top, width: w, height: G.height });
  const bottom = (h: number): Box => ({ left: G.left, top: G.top + G.height - h, width: G.width, height: h });
  const sleeve = (w: number): Box => ({ left: G.left + G.width - w, top: G.top, width: w, height: 100 });
  const cases: [string, Paint, Paint][] = [
    ...[18, 22].map((w): [string, Paint, Paint] => [part('side strip removed', strip(w)), solid(G, navy), shifted(minus(G, strip(w), navy), w / 2, 0)]),
    ...[26, 30].map((h): [string, Paint, Paint] => [part('bottom strip removed', bottom(h)), solid(G, navy), shifted(minus(G, bottom(h), navy), 0, h / 2)]),
    [part('sleeve removed', sleeve(30)), solid(G, navy), minus(G, sleeve(30), navy)],
  ];
  it.each(cases)('%s', async (_label, h0, h2) => {
    expectBlocked(await checkScenes(h0, h2), ['added', 'removed']);
  }, 30_000);
  it(`disclosed boundary: ${part('sleeve removed', sleeve(24))} fails both paths, aligned removed 0.0766 inside the 0.077 fail band`, async () => {
    const verdict = await checkScenes(solid(G, navy), minus(G, sleeve(24), navy));
    expect(verdict.accepted).toBe(false);
    expect((verdict as { reason: string }).reason).toBe('removed');
    expect(verdict.metrics).toMatchObject({ path: 'aligned', identityReason: 'removed' });
    expect(verdict.metrics.removed).toBeCloseTo(0.0766, 4);
  }, 30_000);
});

// BG2c-3b (#84): gross additions. e is the added area as a share of the 136×180 body (24,480 px); the gate statistic
// is the share of the result mask M2 outside R (identity, zero slack: e/(1+e) for a part attached outside R) or outside
// dilate(R, 6) after alignment. Each fails the identity pass (0.25) and the aligned pass (0.07), which decides beyond
// its 0.077 fail band. An attached part of 33.3 % gives identity exactly 0.25 and is printed in §4.3a, not asserted.
describe('BG2c-3b gross additions fail both paths with margin', () => {
  const BODY = G.width * G.height;
  const right = (w: number, h: number, top = G.top): Box => ({ left: G.left + G.width, top, width: w, height: h });
  const cases: [string, Box[]][] = [
    ['an attached second garment 50×170 on the right', [right(50, 170, G.top + 5)]],
    ['an attached second garment 56×180 on the right', [right(56, 180)]],
    ['56×180 on the right and 136×40 below', [right(56, 180), { left: G.left, top: G.top + G.height, width: G.width, height: 40 }]],
    ['50×180 on each side', [right(50, 180), { left: G.left - 50, top: G.top, width: 50, height: 180 }]],
  ];
  it.each(cases.map(([label, parts]) => {
    const e = parts.reduce((sum, b) => sum + b.width * b.height, 0) / BODY;
    return [`${label}: e = ${(100 * e).toFixed(1)} % of the body, identity added ${(e / (1 + e)).toFixed(3)}`, parts] as const;
  }))('%s', async (_label, parts) => {
    const verdict = await checkScenes(solid(G, navy), plus([G, ...parts], () => navy));
    expectBlocked(verdict, ['added']);
    expect(verdict.metrics.identityReason).toBe('added');
  }, 30_000);
});

describe('Disclosed false rejects are asserted as failing (§4.4)', () => {
  const failsFor = async (h0: Paint, h2: Paint, reasons: string[], reference?: Uint8Array) => {
    const verdict = await checkScenes(h0, h2, reference);
    expect(verdict.accepted).toBe(false);
    expect(reasons).toContain((verdict as { reason: string }).reason);
    return verdict;
  };

  it('F1 a same-colour neighbour that BG1 merged into R, removed', async () => {
    const neighbour: Box = { left: G.left + G.width, top: 90, width: 40, height: 150 };
    await failsFor(plus([G, neighbour], () => navy), solid(G, navy), ['removed'], maskOf((x, y) => inG(x, y) || inBox(neighbour, x, y)));
  }, 30_000);

  it('F2 a 60 px re-centre, beyond the 40 px bound (the garment reaches the ring, so it fails background)', async () => {
    await failsFor(solid(G, navy), posed(solid(G, navy), 1, 60, 0), ['background', 'added', 'centre']);
  }, 30_000);

  it('L11 the retired positive: d45 w15 p16 crease removal at L60 (colourMode) and L85 (disclosed: added)', async () => {
    const l60 = await failsFor(creased(G, grey(60), 45, 15, 16), solid(G, grey(60)), ['colourMode']);
    expect(l60.metrics.modeDistance).toBeGreaterThan(40);
    // The plan names colourMode for both; at L85 the check misaligns first (s 1.15) and fails `added`. Either way it
    // falls back to the original, which is the documented L11 outcome.
    await failsFor(creased(G, grey(85), 45, 15, 16), solid(G, grey(85)), ['added', 'colourMode']);
  }, 30_000);
});
