// BG2c-3 (plan rev8 §4.1, §4.3, §4.3a): Accept fixtures must pass with every gate inside its §5.2 pass band. Limits
// (L1-L18) are asserted as accepted so the gaps stay visible; L13, L14, L16, L17 and L18 are owner-accepted escapes of
// #84 (option A; L16 on rev8b; L17 and L18 on BG2c-3b) (30 September 2026), NOT positives. §4.3a boundary cases are printed, never asserted. The chroma and hue Accept
// fixtures (A2, A3, A15) are in cleanup-check-colour.test.ts.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bandAt, checkScenes, creased, criticStripe, expectAccepted, fromRgb, GARMENT, greenTealCheck, grey, inBox, lch, maskOf, noisy,
  posed, relit, solid, within, type Box, type Lab, type Paint,
} from './cleanup-fixtures';

const G = GARMENT;
const navy = lch(30, 30, 270);
const inG = (x: number, y: number) => inBox(G, x, y);
const rows = (y: number) => y >= 72 && y < 248;
const centred = (w: number, h: number): Box => ({ left: 128 - w / 2, top: 160 - h / 2, width: w, height: h });
const overlay = (base: Paint, box: Box, colour: (x: number, y: number) => Lab | null): Paint =>
  (x, y) => inBox(box, x, y) ? colour(x, y) ?? base(x, y) : base(x, y);
const highlights = (base: number, lit: number) => within(inG, (x, y) => rows(y) && bandAt(x, 3, 16) ? grey(lit) : grey(base));
const tonesBy = (levels: readonly number[], shares: readonly number[], coordinate: (x: number, y: number) => number): Paint =>
  within(inG, (x, y) => {
    let u = coordinate(x, y), index = 0;
    while (index < shares.length - 1 && u >= shares[index]!) u -= shares[index++]!;
    return grey(levels[index]!);
  });

describe('Accept fixtures pass with margin (§4.1)', () => {
  it('A1 identical: plain, noisy and textured', async () => {
    expectAccepted(await checkScenes(solid(G, navy), solid(G, navy)));
    expectAccepted(await checkScenes(noisy(solid(G, navy), 2, 3), noisy(solid(G, navy), 2, 4)));
    const textured = within(inG, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? navy : lch(36, 30, 270));
    expectAccepted(await checkScenes(textured, textured));
  }, 60_000);

  it.each([40, 60, 85])('A4 neutral crease removal at L%i through the whole pipeline', async (base) => {
    // Depth-45 valleys wider than 3 px are printed with §4.3a instead: 8-bit sRGB puts the step at 45.01 L*, just over the
    // frozen shading tolerance of 45, so they sit on that boundary rather than inside a margin (build finding).
    for (const [depth, size, every] of [[30, 9, 12], [30, 3, 12], [30, 5, 24], [30, 15, 24], [45, 3, 12]] as const) {
      if (base - depth < 5) continue;
      expectAccepted(await checkScenes(creased(G, grey(base), depth, size, every), solid(G, grey(base))));
    }
  }, 120_000);

  it('A4 navy-hued crease removal, and the critic\'s L60 d30 w9 p12 with ±8 exposure and a 5° white-balance shift', async () => {
    const base = lch(60, 30, 270);
    const valley = (dark: Lab) => lch(dark[0], 30 * dark[0] / 60, 270);
    for (const [depth, size, every] of [[30, 9, 12], [30, 3, 12], [45, 3, 12], [30, 15, 24]] as const) {
      expectAccepted(await checkScenes(creased(G, base, depth, size, every, valley), solid(G, base)));
    }
    const critic = creased(G, grey(60), 30, 9, 12);
    for (const dL of [8, -8]) expectAccepted(await checkScenes(critic, relit(solid(G, grey(60)), dL)));
    const navyCritic = creased(G, base, 30, 9, 12, valley);
    expectAccepted(await checkScenes(navyCritic, relit(solid(G, base), 0, 5)));
  }, 120_000);

  it('A4 the critic\'s highlights (L40, +25, 3 px every 16) removed, also with ±8 exposure', async () => {
    for (const dL of [0, 8, -8]) expectAccepted(await checkScenes(highlights(40, 65), solid(G, grey(40 + dL))));
  }, 60_000);

  it('A4 soft folds (σ 4) and a ±20 L* side-lighting gradient removed', async () => {
    const folds = within(inG, (x) => { const d = ((x - G.left) % 24) - 12; return grey(60 - 30 * Math.exp(-(d * d) / 32)); });
    expectAccepted(await checkScenes(folds, solid(G, grey(60))));
    const side = within(inG, (x) => grey(55 + 20 * (x - (G.left + G.width / 2)) / (G.width / 2)));
    expectAccepted(await checkScenes(side, solid(G, grey(55))));
  }, 60_000);

  it('A5 a tidied silhouette: a ragged hem straightened', async () => {
    const ragged = within((x, y) => inG(x, y) && y < G.top + G.height - ((x >> 3) % 2 ? 4 : 0), () => navy);
    expectAccepted(await checkScenes(ragged, within((x, y) => inG(x, y) && y < G.top + G.height - 2, () => navy)));
  }, 30_000);

  it('A6 pose and re-frame: s 0.9 and 1.1, t (±24, ±16)', async () => {
    const scene = within(inG, (_x, y) => (y - G.top) < 40 ? lch(40, 30, 270) : navy);
    for (const [zoom, dx, dy] of [[1.1, 0, 0], [0.9, 0, 0], [1, 24, 16], [1, -24, -16], [0.9, 24, 16]] as const) {
      expectAccepted(await checkScenes(scene, posed(scene, zoom, dx, dy)));
    }
  }, 120_000);

  it('A7 a clean background from a differently textured H0 background', async () => {
    expectAccepted(await checkScenes(solid(G, navy), solid(G, navy), undefined, 99));
  }, 30_000);

  it('A8 rev8b: navy 124² kept from a clutter R of 216×280 passes at identity (disclosed: retention inside the margin band)', async () => {
    // Retention 0.254 clears the 0.2 gate but not the 0.28 pass margin; the aligned pass still fails (the rev8 A8
    // alignment defect), so this is asserted as accepted at identity, not as a with-margin Accept.
    const big: Box = { left: 20, top: 20, width: 216, height: 280 }, kept = centred(124, 124);
    const verdict = await checkScenes(solid(kept, navy), solid(kept, navy), maskOf((x, y) => inBox(big, x, y)));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.path).toBe('identity');
    expect(verdict.metrics.retention).toBeCloseTo(0.254, 3);
  }, 30_000);

  it('A8 clutter removed: the existing hangers-and-neighbour fixture, and a different-coloured asymmetric neighbour', async () => {
    // The v1 fixture: a textured navy 150×200 garment, a red neighbour and a grey hanger inside R, both removed.
    const body: Box = { left: 53, top: 60, width: 150, height: 200 }, side: Box = { left: 203, top: 80, width: 47, height: 160 };
    const hook: Box = { left: 120, top: 30, width: 16, height: 30 };
    const textured = (x: number, y: number) => ((x >> 2) + (y >> 2)) % 2 ? navy : lch(35, 30, 270);
    const v1 = await checkScenes((x, y) => inBox(side, x, y) ? lch(40, 45, 30) : inBox(hook, x, y) ? grey(38) : inBox(body, x, y) ? textured(x, y) : null,
      within((x, y) => inBox(body, x, y), textured), maskOf((x, y) => inBox(body, x, y) || inBox(side, x, y) || inBox(hook, x, y)));
    expectAccepted(v1);
    expect(v1.metrics.retention).toBeLessThan(1);
    const neighbour: Box = { left: G.left + G.width, top: 90, width: 50, height: 150 }, hanger: Box = { left: 120, top: 40, width: 16, height: 30 };
    const reference = maskOf((x, y) => inG(x, y) || inBox(neighbour, x, y) || inBox(hanger, x, y));
    const scene: Paint = (x, y) => inBox(neighbour, x, y) ? lch(45, 45, 30) : inBox(hanger, x, y) ? grey(35) : inG(x, y) ? navy : null;
    expectAccepted(await checkScenes(scene, solid(G, navy), reference));
  }, 60_000);

  it('A9 minor detail: a 40×30 print, a small logo, 3 px text strokes and fine texture removed', async () => {
    expectAccepted(await checkScenes(overlay(solid(G, grey(40)), centred(40, 30), () => grey(65)), solid(G, grey(40))));
    expectAccepted(await checkScenes(overlay(solid(G, navy), centred(20, 20), () => lch(45, 45, 30)), solid(G, navy)));
    const text = overlay(solid(G, navy), centred(60, 30), (_x, y) => (y - 145) % 6 < 3 ? grey(85) : null);
    expectAccepted(await checkScenes(text, solid(G, navy)));
    const texture = within(inG, (x, y) => ((x >> 1) + (y >> 1)) % 2 ? lch(34, 30, 270) : lch(26, 30, 270));
    expectAccepted(await checkScenes(texture, solid(G, navy)));
  }, 60_000);

  it('A10 small edge completion: 4 % of the area outside R + 6', async () => {
    const strip: Box = { left: G.left + G.width, top: 100, width: 14, height: 122 };
    const verdict = await checkScenes(solid(G, navy), (x, y) => inG(x, y) || inBox(strip, x, y) ? navy : null);
    expectAccepted(verdict);
    expect(verdict.metrics.added).toBeGreaterThan(0.03);
  }, 30_000);

  it('A11 identity preservation: a contaminated R with a different-coloured neighbour, printed H0 = H2', async () => {
    const neighbour: Box = { left: G.left + G.width, top: 80, width: 40, height: 160 };
    const printed = within(inG, (x, y) => ((x - G.left) % 20 < 10) !== ((y - G.top) % 20 < 10) ? navy : lch(55, 25, 90));
    const reference = maskOf((x, y) => inG(x, y) || inBox(neighbour, x, y));
    const verdict = await checkScenes((x, y) => inBox(neighbour, x, y) ? lch(45, 45, 30) : printed(x, y), printed, reference);
    expectAccepted(verdict);
    expect(verdict.metrics).toMatchObject({ scale: 1, tx: 0, ty: 0, added: 0, removed: 0 });
  }, 30_000);

  it('A12 combined, like the 5: exposure, white balance, creases, pose, a logo lost and a 1 px jitter', async () => {
    const base = lch(55, 30, 270);
    const scene = overlay(creased(G, base, 30, 3, 12, (dark) => lch(dark[0], 30 * dark[0] / 55, 270)), centred(20, 20), () => lch(45, 45, 30));
    expectAccepted(await checkScenes(scene, relit(posed(solid(G, base), 1.05, 1, 0), 5, 3)));
  }, 30_000);

  it('A13 a white garment near clipping (RGB 235 → 245 on a darker canvas edge would be invisible; see PR note)', async () => {
    // The unchanged rev4 mask stage (ΔE > 6 from the canvas) can't see a 245 grey on #F6F3ED, so the near-clipping
    // case is a light garment whose brightest channel moves from 235 to 245.
    expectAccepted(await checkScenes(solid(G, fromRgb(235, 200, 170)), solid(G, fromRgb(245, 210, 180))));
  }, 30_000);

  it('A14 unchanged multitone as blocks and 24 px stripes, unchanged and with ±8 exposure', async () => {
    const sets = [[[30, 50, 70], [0.45, 0.1, 0.45]], [[30, 50, 70], [1 / 3, 1 / 3, 1 / 3]], [[30, 70], [0.5, 0.5]], [[30, 70], [0.6, 0.4]]] as const;
    for (const [levels, shares] of sets) {
      const blocks = tonesBy(levels, shares, (_x, y) => (y - G.top) / G.height);
      const stripes = within(inG, (_x, y) => {
        const band = Math.floor((y - G.top) / 24), cycle = levels.length === 2 && shares[0] === 0.6 ? [0, 0, 0, 1, 1] : levels.map((_l, i) => i);
        return grey(levels[cycle[band % cycle.length]!]!);
      });
      for (const scene of [blocks, stripes]) for (const dL of [0, 8, -8]) expectAccepted(await checkScenes(scene, relit(scene, dL)));
    }
  }, 180_000);

  it('A16 a 40×40 (6.5 %) and a 50×50 (10.2 %) contrasting chromatic logo lost', async () => {
    // C30 rather than the sketch's C40, which lies outside sRGB and would clamp the whole base out of the fit.
    for (const size of [40, 50]) {
      expectAccepted(await checkScenes(overlay(solid(G, lch(45, 30, 250)), centred(size, size), () => lch(60, 40, 40)), solid(G, lch(45, 30, 250))));
    }
  }, 60_000);

  it('A17 two-hue patterns kept: the critic\'s stripe, the green/teal check, and the stripe with +8 L* and +5° white balance', async () => {
    const stripe = criticStripe();
    expectAccepted(await checkScenes(stripe, stripe));
    expectAccepted(await checkScenes(stripe, relit(stripe, 8, 5)));
    expectAccepted(await checkScenes(greenTealCheck(), greenTealCheck()));
  }, 60_000);
});

describe('Limits are asserted as accepted, so the gaps stay visible (§4.3)', () => {
  const accepted = async (h0: Paint, h2: Paint, reference?: Uint8Array) => expect((await checkScenes(h0, h2, reference)).accepted).toBe(true);

  it('L1 a same-outline, same-colour stock substitute', async () => {
    await accepted(within(inG, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? lch(33, 30, 270) : lch(27, 30, 270)), solid(G, navy));
  }, 30_000);

  it('L2 a same-colour neighbour kept inside a contaminated R', async () => {
    const neighbour: Box = { left: G.left + G.width, top: 90, width: 40, height: 150 };
    const both: Paint = (x, y) => inG(x, y) || inBox(neighbour, x, y) ? navy : null;
    await accepted(both, both, maskOf((x, y) => inG(x, y) || inBox(neighbour, x, y)));
  }, 30_000);

  it('L3 sparse stripes (6 of 24 px) and 2 px pinstripes flattened', async () => {
    await accepted(within(inG, (x) => bandAt(x, 6, 24) ? grey(40) : grey(80)), solid(G, grey(80)));
    await accepted(within(inG, (x) => bandAt(x, 2, 12) ? grey(85) : grey(40)), solid(G, grey(40)));
  }, 30_000);

  it('L4 a same-hue lightness change of 11 L*', async () => {
    await accepted(solid(G, lch(45, 30, 270)), solid(G, lch(56, 30, 270)));
  }, 30_000);

  it('L5 (owner-accepted, #84) a contrasting hood removed', async () => {
    const hood: Box = { left: G.left, top: G.top, width: G.width, height: 30 };
    await accepted((x, y) => inBox(hood, x, y) ? lch(50, 45, 30) : inG(x, y) ? navy : null, (x, y) => inG(x, y) && !inBox(hood, x, y) ? navy : null);
  }, 30_000);

  it('L6 an addition inside a contaminated R', async () => {
    const extra: Box = { left: G.left + G.width, top: 110, width: 30, height: 100 };
    await accepted(solid(G, navy), (x, y) => inG(x, y) || inBox(extra, x, y) ? navy : null, maskOf((x, y) => inG(x, y) || inBox(extra, x, y)));
  }, 30_000);

  it('L7 (owner-accepted, #84) a broad 45/10/45 neutral pattern turned into its median', async () => {
    await accepted(tonesBy([30, 50, 70], [0.45, 0.1, 0.45], (_x, y) => (y - G.top) / G.height), solid(G, grey(50)));
  }, 30_000);

  it('L12 a tonal chromatic stripe (hues within 30°) flattened', async () => {
    await accepted(within(inG, (x) => bandAt(x, 8, 16) ? lch(42, 40, 20) : lch(58, 40, 40)), solid(G, lch(50, 40, 30)));
  }, 30_000);

  it('L13 (OWNER-ACCEPTED ESCAPE, #84 option A, not a positive): tonal dark/light-blue stripes → plain mid-blue', async () => {
    const tonal = within(inG, (x) => { const band = Math.floor((x - G.left) / 12) % 4; return lch([30, 50, 70, 50][band]!, 30, 270); });
    const verdict = await checkScenes(tonal, solid(G, lch(50, 30, 270)));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.patternLoss).toBeLessThan(0.25);
  }, 30_000);

  it('L14 (OWNER-ACCEPTED ESCAPE, #84 option A, not a positive): a broad red/peach colour block → one intermediate colour', async () => {
    const block = within(inG, (x) => { const u = (x - G.left) / G.width; return u < 0.45 ? lch(40, 30, 0) : u < 0.55 ? lch(55, 30, 0) : lch(70, 30, 60); });
    const verdict = await checkScenes(block, solid(G, lch(55, 30, 30)));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.patternLoss).toBeLessThan(0.25);
  }, 30_000);

  it('L16 (OWNER-ACCEPTED ESCAPE, #84 ~10:15, not a positive): a 24×100 sleeve added and the result recentred by 12 px', async () => {
    // Added area 2,400 px = 9.8 % of the 136×180 body (24,480 px). That is not a gate statistic: `added` counts T(M2)
    // outside dilate(R, 6) as a share of M2, at identity (with R undilated, zero slack) and after alignment. Since
    // BG2c-3b it passes at identity (0.125 < 0.25); on rev8b it passed after alignment (0.066964).
    const sleeve: Box = { left: G.left + G.width - 12, top: 110, width: 24, height: 100 };
    const body: Box = { ...G, left: G.left - 12 };
    const verdict = await checkScenes(solid(G, navy), (x, y) => inBox(body, x, y) || inBox(sleeve, x, y) ? navy : null);
    const area = sleeve.width * sleeve.height / (G.width * G.height);
    console.info(`L16: added area ${(100 * area).toFixed(1)} % of the body; path ${verdict.metrics.path}, added ${verdict.metrics.added}`);
    expect(area).toBeCloseTo(0.098, 3);
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.path).toBe('identity');
    expect(verdict.metrics.added).toBeCloseTo(0.125, 5);
  }, 30_000);
});

// BG2c-3b (#84, 30 September 2026): `added` fails at 0.25 on the identity pass and at 0.21 on the aligned pass. e is
// the added or removed area as a share of the 136×180 body (24,480 px), reported separately from the gate statistic
// `added` (the share of the result mask M2 outside R at identity, zero slack, or outside dilate(R, 6) after alignment).
describe('L17 (OWNER-ACCEPTED ESCAPE, #84 BG2c-3b, not a positive): additions pass at identity or after alignment', () => {
  const BODY = G.width * G.height;
  const plus = (boxes: Box[]): Paint => (x, y) => boxes.some((b) => inBox(b, x, y)) ? navy : null;
  const shifted = (paint: Paint, dx: number, dy: number): Paint => (x, y) => paint(x - dx, y - dy);
  const sleeve: Box = { left: G.left + G.width, top: 110, width: 30, height: 100 };
  const hood: Box = { left: G.left + 43, top: G.top - 60, width: 50, height: 60 };
  const cases: [string, Box, Paint, number][] = [
    ['X6 (was Block) the critic\'s 30×100 addition', sleeve, plus([G, sleeve]), 0.109],
    ['X8 (was Block) a 50×60 hood added outside R', hood, plus([G, hood]), 0.109],
    ['rev8b recentred sleeve 30×100 added (was Block)', sleeve, shifted(plus([G, sleeve]), -15, 0), 0.153],
  ];
  it.each(cases.map(([label, box, h2, added]) => [`${label}: e = ${(100 * box.width * box.height / BODY).toFixed(1)} % of the body`, h2, added] as const))('%s', async (_label, h2, added) => {
    const verdict = await checkScenes(solid(G, navy), h2);
    expectAccepted(verdict);
    expect(verdict.metrics.path).toBe('identity');
    expect(verdict.metrics.added).toBeCloseTo(added, 3);
  }, 30_000);

  it('X7 (was Block) the 30×100 addition (e = 12.3 % of the body) with a ×1.1 pose: identity 0.266 fails, aligned 0.089 passes', async () => {
    const verdict = await checkScenes(solid(G, navy), posed(plus([G, sleeve]), 1.1));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics).toMatchObject({ path: 'aligned', identityReason: 'added' });
    expect(verdict.metrics.identityAdded).toBeCloseTo(0.2655, 4);
    expect(verdict.metrics.added).toBeCloseTo(0.0891, 4);
    expect(verdict.metrics.scale).toBeCloseTo(0.91, 2);
  }, 30_000);

  it('F3 (was a disclosed false reject) a 136×20 part BG1 missed, shown in H2 (e = 11.1 % of the body)', async () => {
    const missed: Box = { left: G.left, top: G.top + G.height, width: G.width, height: 20 };
    const verdict = await checkScenes(plus([G, missed]), plus([G, missed]));
    expectAccepted(verdict);
    expect(verdict.metrics.path).toBe('identity');
    expect(verdict.metrics.added).toBeCloseTo(0.1, 5);
  }, 30_000);
});

describe('L18 (OWNER-ACCEPTED ESCAPE, #84 BG2c-3b, not a positive): a strip removed and recentred, masked by rescale', () => {
  const BODY = G.width * G.height;
  const strip = (w: number): Box => ({ left: G.left + G.width - w, top: G.top, width: w, height: G.height });
  const cut = (w: number): Paint => (x, y) => inG(x, y) && !inBox(strip(w), x, y) ? navy : null;
  const shifted = (paint: Paint, dx: number, dy: number): Paint => (x, y) => paint(x - dx, y - dy);
  // [strip width, zoom, identity added, identity removed]; the reviewer's two cases first.
  const cases = [[18, 1.1, 0.0909, 0.0420], [22, 1.15, 0.1304, 0.0264], [18, 1.15, 0.1304, 0]] as const;
  it.each(cases.map(([w, zoom, added, removed]) => [`${w}×180 removed (e = ${(100 * w * 180 / BODY).toFixed(1)} % of the body), ×${zoom}`, w, zoom, added, removed] as const))('%s', async (_label, w, zoom, added, removed) => {
    const verdict = await checkScenes(solid(G, navy), posed(shifted(cut(w), w / 2, 0), zoom));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.path).toBe('identity');
    expect(verdict.metrics.added).toBeCloseTo(added, 4);
    expect(verdict.metrics.removed).toBeCloseTo(removed, 4);
  }, 30_000);

  // The rev8b recentred removals (were Block): identity fails `removed`; the aligned pass scales up by 1.14-1.15, so
  // `removed` is 0 and aligned `added` 0.081-0.100 is under 0.21. [label, removed box, dx, dy, identity removed, aligned added]
  const bottom = (h: number): Box => ({ left: G.left, top: G.top + G.height - h, width: G.width, height: h });
  const plain = [
    ['side strip 18×180', strip(18), 9, 0, 0.1525, 0.1],
    ['side strip 22×180', strip(22), 11, 0, 0.1930, 0.1],
    ['bottom strip 136×26', bottom(26), 0, 13, 0.1688, 0.0809],
    ['bottom strip 136×30', bottom(30), 0, 15, 0.2, 0.0882],
  ] as const;
  it.each(plain.map(([label, box, dx, dy, identityRemoved, added]) => [`${label} removed (e = ${(100 * box.width * box.height / BODY).toFixed(1)} % of the body), recentred`, box, dx, dy, identityRemoved, added] as const))('%s', async (_label, box, dx, dy, identityRemoved, added) => {
    const verdict = await checkScenes(solid(G, navy), shifted((x, y) => inG(x, y) && !inBox(box, x, y) ? navy : null, dx, dy));
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics).toMatchObject({ path: 'aligned', identityReason: 'removed', removed: 0 });
    expect(verdict.metrics.identityRemoved).toBeCloseTo(identityRemoved, 4);
    expect(verdict.metrics.added).toBeCloseTo(added, 4);
  }, 30_000);
});

describe('§4.3a disclosed boundary cases (printed, never asserted)', () => {
  it('prints NEW2 → 39.4 and the +11 exposure cases', async () => {
    const lines: string[] = [];
    const report = async (label: string, h0: Paint, h2: Paint) => {
      const v = await checkScenes(h0, h2);
      lines.push(`${label}: ${v.accepted ? 'pass' : `fail ${(v as { reason: string }).reason}`} ΔL ${v.metrics.deltaL?.toFixed(1)} G ${v.metrics.modeDistance?.toFixed(1)}`);
    };
    for (const amplitude of [2, 4, 6]) await report(`NEW2 27.1 ±${amplitude} → 39.4`, noisy(solid(G, grey(27.1)), amplitude, 7), solid(G, grey(39.4)));
    for (const base of [40, 60, 85]) await report(`creases d30 w9 p12 L${base} +11`, creased(G, grey(base), 30, 9, 12), solid(G, grey(base + 11)));
    await report('A4 highlights +11', highlights(40, 65), solid(G, grey(51)));
    const bottom: Box = { left: G.left, top: G.top + G.height, width: G.width, height: 60 };
    await report('BG2c-3b 136×60 attached below (e = 33.3 %, identity added exactly 0.25, aligned 0.225)', solid(G, navy), (x, y) => inG(x, y) || inBox(bottom, x, y) ? navy : null);
    const side: Box = { left: G.left + G.width, top: G.top + 5, width: 50, height: 170 };
    await report('BG2c-3b 50×170 attached on the right (e = 34.7 %, identity 0.258, aligned 0.227)', solid(G, navy), (x, y) => inG(x, y) || inBox(side, x, y) ? navy : null);
    for (const base of [60, 85]) {
      for (const [size, every] of [[9, 12], [5, 24], [15, 24]] as const) {
        await report(`${size === 5 ? 'build finding' : 'L15 (safe false reject, falls back to the original)'}: creases d45 w${size} p${every} L${base} (step 45.01 > tolerance 45)`, creased(G, grey(base), 45, size, every), solid(G, grey(base)));
      }
    }
    console.info(`§4.3a boundary cases (not asserted):\n${lines.join('\n')}`);
    if (process.env.CLEANUP_REPORT) appendFileSync(process.env.CLEANUP_REPORT, `${lines.join('\n')}\n`);
    expect(lines).toHaveLength(15);
  }, 120_000);
});
