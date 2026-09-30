// BG2c-3 (plan rev8 §4, "chroma and hue fixtures prove themselves before the freeze"): the Accept and Block fixtures
// that exercise c, θ and the scaled-chroma palette query. These ran green on the frozen CLEANUP_V2 before any remeasure.
import { describe, it } from 'vitest';
import {
  bandAt, checkScenes, creased, expectAccepted, expectBlocked, fromRgb, gained, GARMENT, grey, inBox, lch, maskOf, noisy,
  relit, solid, within, type Box, type Lab, type Paint,
} from './cleanup-fixtures';

const G = GARMENT;
const navy = lch(30, 30, 270), red = lch(45, 40, 30);
const inG = (x: number, y: number) => inBox(G, x, y);
const SATURATED = [['red', 35], ['blue', 285], ['green', 140]] as const;

describe('cleanupCheck v2: chroma and hue Accept fixtures', () => {
  it.each([
    ['grey', grey(50)], ['navy', navy], ['red', red],
  ] as const)('A2 exposure ±8 and linear gains ×1.2 / ×0.85 pass on %s', async (_name, colour) => {
    for (const dL of [8, -8]) expectAccepted(await checkScenes(solid(G, colour), relit(solid(G, colour), dL)));
    for (const gain of [1.2, 0.85]) expectAccepted(await checkScenes(solid(G, colour), gained(solid(G, colour), gain)));
  }, 60_000);

  it('A3 white balance ±5° and chroma ×0.9 / ×1.15 pass', async () => {
    for (const hue of [5, -5]) expectAccepted(await checkScenes(solid(G, red), relit(solid(G, red), 0, hue)));
    for (const gain of [0.9, 1.15]) expectAccepted(await checkScenes(solid(G, red), relit(solid(G, red), 0, 0, gain)));
    expectAccepted(await checkScenes(solid(G, navy), relit(solid(G, navy), 0, 5, 1.15)));
  }, 60_000);

  it.each(SATURATED)('A15 saturated %s creases (valley chroma scaled with L*, 4° drift) pass', async (_name, hue) => {
    const base = lch(60, 50, hue);
    const valley = (dark: Lab) => lch(dark[0], 50 * dark[0] / 60, hue + 4);
    for (const [depth, size, every] of [[30, 9, 12], [30, 3, 12], [30, 15, 24]] as const) {
      expectAccepted(await checkScenes(creased(G, base, depth, size, every, valley), solid(G, base)));
    }
  }, 60_000);

  it.each(SATURATED)('A15 saturated %s creases with ±2 noise, +6 exposure and 5° white balance pass', async (_name, hue) => {
    const scene = creased(G, lch(60, 50, hue), 30, 9, 12, (dark) => lch(dark[0], 25, hue));
    expectAccepted(await checkScenes(noisy(scene, 2, 11), noisy(solid(G, lch(66, 50, hue + 5)), 2, 12)));
  }, 60_000);

  it.each(SATURATED)('A15 highlights on a saturated %s garment (C15 +10°, and C5) pass', async (_name, hue) => {
    const lit = (chroma: number, drift: number) => within(inG, (x, y) => y >= 72 && y < 248 && bandAt(x, 3, 16)
      ? lch(65, chroma, hue + drift) : lch(40, 40, hue));
    expectAccepted(await checkScenes(lit(15, 10), solid(G, lch(40, 40, hue))));
    expectAccepted(await checkScenes(lit(5, 0), solid(G, lch(40, 40, hue))));
  }, 60_000);
});

describe('cleanupCheck v2: chroma and hue Block fixtures', () => {
  it('X2 the critic\'s blue (30,45,90) → (49,71,135) fails colourShift', async () => {
    expectBlocked(await checkScenes(solid(G, fromRgb(30, 45, 90)), solid(G, fromRgb(49, 71, 135))), ['colourShift']);
  }, 30_000);

  it('X3 navy → red, grey → green and a 15° hue shift fail colourShift', async () => {
    expectBlocked(await checkScenes(solid(G, navy), solid(G, lch(40, 50, 30))), ['colourShift']);
    expectBlocked(await checkScenes(solid(G, grey(50)), solid(G, lch(50, 40, 140))), ['colourShift']);
    expectBlocked(await checkScenes(solid(G, red), relit(solid(G, red), 0, 15)), ['colourShift']);
  }, 60_000);

  it('X9 a creased red sleeve (12 %) removed fails removed', async () => {
    const sleeve: Box = { left: G.left + G.width - 30, top: G.top, width: 30, height: 100 };
    const base = lch(45, 40, 30);
    const scene = creased(G, base, 30, 9, 12, (dark) => lch(dark[0], 40 * dark[0] / 45, 30));
    const result: Paint = (x, y) => inBox(G, x, y) && !inBox(sleeve, x, y) ? base : null;
    expectBlocked(await checkScenes(scene, result), ['removed']);
  }, 30_000);

  it('X15 the critic\'s red strap removed fails removed', async () => {
    const body: Box = { left: 78, top: 100, width: 100, height: 80 }, strap: Box = { left: 120, top: 180, width: 16, height: 80 };
    const colour = lch(40, 40, 30);
    const reference = maskOf((x, y) => inBox(body, x, y) || inBox(strap, x, y));
    expectBlocked(await checkScenes((x, y) => inBox(body, x, y) || inBox(strap, x, y) ? colour : null, solid(body, colour), reference),
      ['removed']);
  }, 30_000);

  it('X16 a chromatic narrow strap navy → red fails colourShift', async () => {
    const belt: Box = { left: 120, top: 60, width: 16, height: 200 };
    const reference = maskOf((x, y) => inBox(belt, x, y));
    expectBlocked(await checkScenes(solid(belt, navy), solid(belt, lch(40, 50, 30)), reference), ['colourShift']);
  }, 30_000);
});
