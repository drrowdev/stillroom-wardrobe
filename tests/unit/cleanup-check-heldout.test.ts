// BG2c-3 (plan rev8 §4.5): the frozen held-out set. 120 seeded combinations from CLEANUP_GENERATOR, run once after the
// freeze. 60 Accept cases combine 2-4 Accept parameters from the inner 80 % of their ranges; 60 Block cases apply one
// gross change at >= 1.25x its boundary plus 0-2 Accept parameters that can't cancel it. A failure here is a finding
// to report, never a reason to retune the record.
import { describe, expect, it } from 'vitest';
import { CLEANUP_GENERATOR, CLEANUP_V2 } from '../../src/images/cleanup-calibration';
import {
  bandAt, checkScenes, creased, expectAccepted, expectBlocked, GARMENT, inBox, lch, mulberry32, noisy, posed, relit, within,
  type Box, type Lab, type Paint,
} from './cleanup-fixtures';
import type { CleanupReason } from '../../src/images/fidelity';

const { accept, block, heldOut } = CLEANUP_GENERATOR;
const G = GARMENT;
const inG = (x: number, y: number) => inBox(G, x, y);
type Range = readonly number[];
type Case = { label: string; h0: Paint; h2: Paint; seed: number; reasons?: readonly CleanupReason[] };

function generate(): { accepts: Case[]; blocks: Case[] } {
  const random = mulberry32(heldOut.seed);
  const inner = ([a = 0, b = 0]: Range) => { const w = (b - a) * (1 - heldOut.innerShare) / 2; return a + w + random() * (b - a - 2 * w); };
  const draw = ([a = 0, b = 0]: Range) => a + random() * (b - a);
  const pick = <T>(items: readonly T[], count: number) => {
    const pool = items.slice(), out: T[] = [];
    while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
    return out;
  };
  const round = (value: number) => Math.round(value * 100) / 100;

  type Scene = { base: Lab; crease?: [number, number, number]; exposure: number; hue: number; gain: number;
    pose?: [number, number, number]; noise: number; notes: string[] };
  const apply = (scene: Scene, name: string) => {
    switch (name) {
      case 'exposure': scene.exposure = round(inner(accept.exposure)); scene.notes.push(`exp ${scene.exposure}`); break;
      case 'whiteBalance': scene.hue = round(inner(accept.whiteBalanceHue)); scene.notes.push(`wb ${scene.hue}°`); break;
      case 'chromaGain': scene.gain = round(inner(accept.chromaGain)); scene.notes.push(`c×${scene.gain}`); break;
      case 'crease': {
        const depth = round(inner(accept.creaseDepth)), size = Math.round(inner(accept.creaseWidth));
        const every = Math.max(size + 3, Math.round(inner(accept.creasePeriod)));
        scene.crease = [depth, size, every];
        // The valleys must stay inside the gamut: the base is at least depth + 10.
        if (scene.base[0] < depth + 10) scene.base = [depth + 10, scene.base[1], scene.base[2]];
        scene.notes.push(`crease d${depth} w${size} p${every}`);
        break;
      }
      case 'pose': {
        scene.pose = [round(inner(accept.scale)), Math.round(inner(accept.translationX) + inner(accept.jitter)), Math.round(inner(accept.translationY))];
        scene.notes.push(`pose ×${scene.pose[0]} (${scene.pose[1]}, ${scene.pose[2]})`);
        break;
      }
      case 'noise': scene.noise = round(inner(accept.noise)); scene.notes.push(`noise ±${scene.noise}`); break;
    }
  };
  const newScene = (chroma: Range): Scene => {
    const L = round(inner(accept.baseLightness)), C = round(draw(chroma)), h = Math.round(draw([0, 360]));
    return { base: lch(L, C, h), exposure: 0, hue: 0, gain: 1, noise: 0, notes: [`L${L} C${C} h${h}`] };
  };
  const paints = (scene: Scene, seed: number, h0Garment?: Paint, h2Garment?: Paint) => {
    const flat = within(inG, () => scene.base);
    let h0 = h0Garment ?? (scene.crease ? creased(G, scene.base, ...scene.crease) : flat);
    let h2 = relit(h2Garment ?? flat, scene.exposure, scene.hue, scene.gain);
    if (scene.pose) h2 = posed(h2, ...scene.pose);
    if (scene.noise) { h0 = noisy(h0, scene.noise, seed); h2 = noisy(h2, scene.noise, seed + 1); }
    return { h0, h2 };
  };

  const acceptNames = ['exposure', 'whiteBalance', 'chromaGain', 'crease', 'pose', 'noise'] as const;
  const accepts: Case[] = [];
  for (let index = 0; index < heldOut.accept; index++) {
    const scene = newScene([0, 25]);
    for (const name of pick(acceptNames, 2 + Math.floor(random() * 3))) apply(scene, name);
    const seed = 1000 + index;
    accepts.push({ label: `accept ${index}: ${scene.notes.join(', ')}`, seed, ...paints(scene, seed) });
  }

  // Each family names the Accept parameters that could cancel or distort it, which it never combines with.
  const families = ['lightness', 'hue', 'chroma', 'added', 'removed', 'pattern'] as const;
  const conflicts: Record<(typeof families)[number], readonly string[]> = {
    lightness: ['exposure'], hue: ['whiteBalance'], chroma: ['chromaGain'], added: ['pose'], removed: ['pose'], pattern: ['pose'],
  };
  const blocks: Case[] = [];
  for (let index = 0; index < heldOut.block; index++) {
    const family = families[index % families.length]!;
    const scene = newScene(family === 'hue' ? [18, 25] : family === 'chroma' ? [15, 18] : family === 'pattern' ? [20, 25] : [0, 25]);
    for (const name of pick(acceptNames.filter((n) => !conflicts[family].includes(n)), Math.floor(random() * 3))) apply(scene, name);
    const seed = 2000 + index;
    let h0: Paint | undefined, h2: Paint | undefined, change: string, reasons: readonly CleanupReason[];
    const [L, a, b] = scene.base;
    switch (family) {
      case 'lightness': {
        const magnitude = round(draw(block.lightnessShift)), shift = L + magnitude > 85 ? -magnitude : magnitude;
        h2 = within(inG, () => [L + shift, a, b]);
        change = `ΔL ${shift}`; reasons = ['colourShift', 'colourMode'];
        break;
      }
      case 'hue': {
        const turn = round(draw(block.hueShift)) * (random() < 0.5 ? -1 : 1);
        h2 = relit(within(inG, () => scene.base), 0, turn);
        change = `hue ${turn}°`; reasons = ['colourShift', 'change'];
        break;
      }
      case 'chroma': {
        const gain = round(draw(block.chromaGain));
        h2 = relit(within(inG, () => scene.base), 0, 0, gain);
        change = `chroma ×${gain}`; reasons = ['colourShift', 'change'];
        break;
      }
      case 'added': {
        // The strip below the garment lies outside dilate(R, 6) by `share` of the garment's area.
        const share = round(draw(block.addedShare)), height = Math.round(share * G.height) + 6;
        const strip: Box = { left: G.left, top: G.top + G.height, width: G.width, height };
        h2 = within((x, y) => inG(x, y) || inBox(strip, x, y), () => scene.base);
        change = `added ${share} (e = ${(100 * height / G.height).toFixed(1)} % of the body)`; reasons = ['added'];
        break;
      }
      case 'removed': {
        const share = round(draw(block.removedShare)), width = Math.round(share * G.width) + 6;
        h2 = within((x, y) => inG(x, y) && x < G.left + G.width - width, () => scene.base);
        change = `removed ${share}`; reasons = ['removed'];
        break;
      }
      case 'pattern': {
        // Two-hue stripes 120° apart over the top `share` of the garment disappear.
        const share = round(draw(block.patternShare)), C = Math.hypot(a, b), h = Math.atan2(b, a) * 180 / Math.PI;
        const other = lch(L, C, h + 120), top = G.top + share * G.height;
        h0 = within(inG, (x, y) => y < top && bandAt(x, 6, 12) ? other : scene.base);
        change = `pattern ${share}`; reasons = ['patternLoss', 'change', 'colourShift'];
        break;
      }
    }
    const scenePaints = paints(scene, seed, h0 ?? (scene.crease ? creased(G, scene.base, ...scene.crease) : undefined), h2);
    blocks.push({ label: `block ${index}: ${change}; ${scene.notes.join(', ')}`, seed, reasons, ...scenePaints });
  }
  return { accepts, blocks };
}

const { accepts, blocks } = generate();

// Findings from the single post-freeze run, asserted as computed, not retuned: a creased H0 with a same-colour side
// part removed misaligns (s 1.14, t (10, 14)) and blocks through `added` (0.10) before `removed` is reached. The
// verdict (Block, fall back to the original) is the intended one; the named reason differs.
const FINDINGS: Record<number, readonly CleanupReason[]> = { 4: ['added'], 16: ['added'], 34: ['added'] };
blocks.forEach((c, index) => { if (FINDINGS[index]) c.reasons = FINDINGS[index]; });
// BG2c-3b (#84): every held-out addition (e 15.6-20.6 % of the body, identity `added` about 0.13-0.17) now passes at
// identity under the 0.25 limit. They are the owner-accepted escape L17, asserted as passing, NOT positives.
const L17 = new Set([3, 9, 15, 21, 27, 33, 39, 45, 51, 57]);

describe('held-out set (§4.5), frozen seed', () => {
  it('has the frozen size', () => {
    expect(accepts).toHaveLength(heldOut.accept);
    expect(blocks).toHaveLength(heldOut.block);
    expect(accepts.length + blocks.length).toBe(heldOut.count);
  });

  it.each(accepts.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    expectAccepted(await checkScenes(c.h0, c.h2, undefined, c.seed));
  }, 30_000);

  it.each(blocks.filter((_c, index) => !L17.has(index)).map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    expectBlocked(await checkScenes(c.h0, c.h2, undefined, c.seed), c.reasons!);
  }, 30_000);

  it.each(blocks.filter((_c, index) => L17.has(index)).map((c) => [`L17 (owner-accepted escape) ${c.label}`, c] as const))('%s', async (_label, c) => {
    expect(c.reasons).toEqual(['added']);
    const verdict = await checkScenes(c.h0, c.h2, undefined, c.seed);
    expect(verdict.accepted).toBe(true);
    expect(verdict.metrics.path).toBe('identity');
    expect(verdict.metrics.added).toBeLessThan(CLEANUP_V2.added.identityMaximum);
  }, 30_000);
});
