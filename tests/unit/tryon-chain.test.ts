// VTO-1: the deterministic garment chain, the fixed prompts and the manifest arithmetic (plan rev4 §4, §7.1).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  TRYON_DEPLOYMENT, TRYON_MANIFEST, TRYON_MAX_RESULTS, TRYON_MAX_STEPS, TRYON_MODEL, TRYON_NOTICE_REVISION, TRYON_ONE_PIECE_STEP_ORDER, TRYON_PARAMETERS,
  TRYON_PROMPTS, TRYON_PROMPT_VERSION, TRYON_RESERVATION_MICRO, TRYON_SETTINGS, TRYON_STEP_ORDER, isTryOnOptional, selectTryOnSteps, tryOnCategories,
  tryOnEstimateMicro, tryOnPrompt, tryOnSlots, type TryOnCandidate,
} from '../../src/domain/tryon';
import { selectTryOnStepsV1 } from '../fixtures/tryon-select-v1';
import { TRYON_V1_MANIFEST, TRYON_V1_PROMPTS, TRYON_V1_SETTINGS } from '../fixtures/tryon-v1-frozen';
import { TRYON_V2_MANIFEST, TRYON_V2_PROMPTS, TRYON_V2_SETTINGS } from '../fixtures/tryon-v2-frozen';
import { TRYON_V3_MANIFEST, TRYON_V3_PROMPTS, TRYON_V3_SETTINGS } from '../fixtures/tryon-v3-frozen';
import { TRYON_V4_MANIFEST, TRYON_V4_PROMPTS, TRYON_V4_SETTINGS } from '../fixtures/tryon-v4-frozen';
import { ENHANCE_PARAMETERS } from '../../src/domain/enhancement';
import { categories } from '../../src/domain/wardrobe';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const item = (itemId: string, category: TryOnCandidate['category'], extra: Partial<TryOnCandidate> = {}): TryOnCandidate =>
  ({ itemId, category, lifecycle: 'active', deleted: false, readyImage: true, ...extra });

describe('try-on garment chain', () => {
  it('keeps its import-free category list equal to the wardrobe categories', () => {
    expect([...tryOnCategories]).toEqual([...categories]);
  });
  it('orders top, bottom, then shoes regardless of the saved order', () => {
    const selection = selectTryOnSteps([item('s', 'footwear'), item('b', 'bottom'), item('t', 'top')]);
    expect(selection.steps).toEqual([{ slot: 'top', itemId: 't' }, { slot: 'bottom', itemId: 'b' },
      { slot: 'footwear', itemId: 's' }]);
  });

  it('takes the first eligible garment of each kind in the saved order', () => {
    const selection = selectTryOnSteps([item('t1', 'top'), item('t2', 'top'), item('b1', 'bottom')]);
    expect(selection.steps.map((step) => step.itemId)).toEqual(['t1', 'b1']);
  });

  it('lets a one-piece replace the top and bottom steps', () => {
    const selection = selectTryOnSteps([item('t', 'top'), item('d', 'one_piece'), item('b', 'bottom'), item('s', 'footwear')]);
    expect(selection.steps).toEqual([{ slot: 'one_piece', itemId: 'd' }, { slot: 'footwear', itemId: 's' }]);
  });

  it('skips retired, deleted and photo-less garments without substituting another kind', () => {
    const selection = selectTryOnSteps([
      item('t1', 'top', { lifecycle: 'archived' }), item('t2', 'top', { deleted: true }), item('t3', 'top', { readyImage: false }),
      item('d', 'one_piece', { lifecycle: 'sold' }), item('b', 'bottom'),
    ]);
    expect(selection.steps).toEqual([{ slot: 'bottom', itemId: 'b' }]);
  });

  it('adds layers and one accessory in a fixed order, up to five steps, and never draws outerwear', () => {
    const selection = selectTryOnSteps([item('x', 'accessory'), item('o', 'outerwear'), item('s', 'footwear'), item('l', 'layer'),
      item('b', 'bottom'), item('t', 'top'), item('y', 'accessory'), item('d', 'accessory', { deleted: true })]);
    expect(TRYON_MAX_STEPS).toBe(6);
    expect(selection.steps).toEqual([{ slot: 'top', itemId: 't' }, { slot: 'bottom', itemId: 'b' }, { slot: 'layer', itemId: 'l' },
      { slot: 'footwear', itemId: 's' }, { slot: 'accessory', itemId: 'x' }]);
    expect(selection.steps.some((step) => step.slot === 'outerwear')).toBe(false);
    expect([...TRYON_STEP_ORDER, ...TRYON_ONE_PIECE_STEP_ORDER]).not.toContain('outerwear');
    // A second accessory has no step; the deleted one is not eligible and is not listed either. The coat is optional, not "not included".
    expect(selection.notIncluded).toEqual(['y']);
    expect(selection.optional).toEqual(['o']);
  });

  it('keeps the old order for outfits without the new kinds, so shoes stay last', () => {
    const selection = selectTryOnSteps([item('s', 'footwear'), item('b', 'bottom'), item('t', 'top')]);
    expect(selection.steps.map((step) => step.slot)).toEqual(['top', 'bottom', 'footwear']);
    expect(selection.optional).toEqual([]);
    expect(selection.legacyItemIds).toBeNull();
  });

  it('lets a one-piece keep the layer, shoes and accessory steps, and still never draws outerwear', () => {
    const selection = selectTryOnSteps([item('t', 'top'), item('b', 'bottom'), item('d', 'one_piece'), item('l', 'layer'),
      item('o', 'outerwear'), item('s', 'footwear'), item('a', 'accessory')]);
    expect(selection.steps.map((step) => step.slot)).toEqual(['one_piece', 'layer', 'footwear', 'accessory']);
    expect(selection.notIncluded).toEqual([]);
    expect(selection.optional).toEqual(['o']);
  });

  it('keeps every eligible coat as an optional piece, in the outfit order, and none of them is a step', () => {
    const selection = selectTryOnSteps([item('c2', 'outerwear'), item('t', 'top'), item('c1', 'outerwear'), item('c3', 'outerwear', { lifecycle: 'sold' }),
      item('c4', 'outerwear', { readyImage: false })]);
    expect(selection.steps).toEqual([{ slot: 'top', itemId: 't' }]);
    expect(selection.optional).toEqual(['c2', 'c1']);
    expect(selection.notIncluded).toEqual([]);
    expect(isTryOnOptional('outerwear')).toBe(true);
    for (const category of tryOnCategories.filter((entry) => entry !== 'outerwear')) expect(isTryOnOptional(category)).toBe(false);
    expect(isTryOnOptional(null)).toBe(false);
  });

  it('names the garment set a manifest before v5 would have drawn, with that coat only, so a picture of one coat never stands for another', () => {
    const outfit = (coat: string) => selectTryOnSteps([item('t', 'top'), item('b', 'bottom'), item(coat, 'outerwear'), item('s', 'footwear')]);
    expect(outfit('c1').legacyItemIds!.slice().sort()).toEqual(['b', 'c1', 's', 't']);
    expect(outfit('c2').legacyItemIds!.slice().sort()).toEqual(['b', 'c2', 's', 't']);
    // The drawn set is the same for both coats; only the legacy set tells them apart.
    expect(outfit('c1').steps).toEqual(outfit('c2').steps);
    // It is what the previous selection chose: the steps plus the first eligible outerwear piece.
    const list = [item('t', 'top'), item('c1', 'outerwear'), item('c2', 'outerwear'), item('b', 'bottom')];
    expect(selectTryOnSteps(list).legacyItemIds!.slice().sort()).toEqual(selectTryOnStepsV1([...list]).concat([{ slot: 'outerwear', itemId: 'c1' }])
      .map((step) => step.itemId).sort());
  });

  it('tries on an outfit that has only an accessory or a layer, and draws nothing for an outfit that has only outerwear', () => {
    expect(selectTryOnSteps([item('a', 'accessory')]).steps).toEqual([{ slot: 'accessory', itemId: 'a' }]);
    expect(selectTryOnSteps([item('l', 'layer')]).steps).toEqual([{ slot: 'layer', itemId: 'l' }]);
    const coatOnly = selectTryOnSteps([item('o', 'outerwear')]);
    expect(coatOnly.steps).toEqual([]);
    expect(coatOnly.optional).toEqual(['o']);
  });

  it('returns no steps for an outfit with nothing to try on', () => {
    expect(selectTryOnSteps([item('a', 'accessory', { readyImage: false })]).steps).toEqual([]);
    expect(selectTryOnSteps([]).steps).toEqual([]);
  });
});

describe('frozen v1 selection used by the historical integration stages', () => {
  it('matches the three-step selection that shipped before TRYON-LIMITS1', () => {
    const list = [item('x', 'accessory'), item('o', 'outerwear'), item('s', 'footwear'), item('l', 'layer'), item('b', 'bottom'), item('t', 'top')];
    expect(selectTryOnStepsV1(list).map((step) => step.slot)).toEqual(['top', 'bottom', 'footwear']);
    expect(selectTryOnStepsV1([item('c', 'outerwear')])).toEqual([]);
    expect(selectTryOnStepsV1([item('d', 'one_piece'), item('t', 'top'), item('s', 'footwear')]).map((step) => step.slot)).toEqual(['one_piece', 'footwear']);
  });
});

describe('try-on request contract', () => {
  it('uses fixed words only and one prompt per garment kind', () => {
    for (const [slot, prompt] of Object.entries(TRYON_PROMPTS)) {
      expect(prompt).toBe(tryOnPrompt(slot as keyof typeof TRYON_PROMPTS));
      expect(prompt).toMatch(/^Image 1 shows a person\. Image 2 shows one garment \(/);
    }
    expect(new Set(Object.values(TRYON_PROMPTS)).size).toBe(7);
    expect(Object.keys(TRYON_PROMPTS)).toEqual(['one_piece', 'top', 'bottom', 'layer', 'outerwear', 'footwear', 'accessory']);
    expect([...tryOnSlots].sort()).toEqual(Object.keys(TRYON_PROMPTS).sort());
  });

  it('keeps the installed prompts that did not change byte for byte: bottoms, shoes and accessory as in v1 to v4, outerwear (unused) as in v4', () => {
    for (const [slot, prompt] of Object.entries(TRYON_V1_PROMPTS)) {
      if (slot === 'top' || slot === 'one_piece') continue;
      expect(TRYON_PROMPTS[slot as keyof typeof TRYON_PROMPTS]).toBe(prompt);
    }
    for (const slot of ['bottom', 'footwear', 'accessory'] as const) {
      for (const frozen of [TRYON_V2_PROMPTS, TRYON_V3_PROMPTS, TRYON_V4_PROMPTS]) expect(TRYON_PROMPTS[slot]).toBe(frozen[slot]);
    }
    expect(TRYON_PROMPTS.outerwear).toBe(TRYON_V4_PROMPTS.outerwear);
    for (const slot of ['top', 'one_piece', 'layer'] as const) expect(TRYON_PROMPTS[slot]).not.toBe(TRYON_V4_PROMPTS[slot]);
    expect(Object.keys(TRYON_PROMPTS)).toEqual(Object.keys(TRYON_V4_PROMPTS));
  });

  it('only adds to v4: the length sentence in the top, one-piece and layer prompts and the underneath sentence in the layer, every v4 sentence kept', () => {
    const LENGTH = 'Show the garment at the full length it has in image 2, with its hem falling where it would on a person of this build; do not '
      + 'shorten, crop, tuck in or hike it up.';
    const UNDERNEATH = 'Keep the full length of the clothing underneath; its hem stays visible below this garment if it is longer.';
    const END = ' Photorealistic, whole person in frame.';
    const added = (slot: 'top' | 'one_piece' | 'layer', extra: string) => {
      expect(TRYON_V4_PROMPTS[slot].endsWith(END)).toBe(true);
      return `${TRYON_V4_PROMPTS[slot].slice(0, -END.length)} ${extra}${END}`;
    };
    expect(TRYON_PROMPTS.top).toBe(added('top', LENGTH));
    expect(TRYON_PROMPTS.one_piece).toBe(added('one_piece', LENGTH));
    expect(TRYON_PROMPTS.layer).toBe(added('layer', `${LENGTH} ${UNDERNEATH}`));
    for (const slot of ['top', 'one_piece', 'layer'] as const) expect(TRYON_PROMPTS[slot]).toContain(TRYON_V4_PROMPTS[slot].slice(0, -END.length));
    for (const slot of ['bottom', 'outerwear', 'footwear', 'accessory'] as const) expect(TRYON_PROMPTS[slot]).not.toContain('full length it has in image 2');
    expect(TRYON_PROMPTS.top.match(/full length/g)).toHaveLength(1);
    // The pullover and open-coat rules of TRYON-PROMPT1 and 2 are untouched and still lead the layer wording.
    expect(TRYON_PROMPTS.layer.indexOf('Pullovers, including hooded sweatshirts, stay closed')).toBeLessThan(TRYON_PROMPTS.layer.indexOf(LENGTH));
    expect(TRYON_PROMPTS.layer).toContain('including jackets and coats photographed fastened, are worn fully open');
    // Not larger than needed: the prompt stays a small part of the 15,000-token input envelope the reservation was reviewed with
    // (characters, not tokens: 1,300 characters are about 325 tokens, about 2 %). The unchanged outerwear text keeps its v3-era cap.
    for (const slot of ['top', 'one_piece', 'layer'] as const) expect(TRYON_PROMPTS[slot].length).toBeLessThanOrEqual(TRYON_V4_PROMPTS[slot].length + 300);
    for (const prompt of Object.values(TRYON_PROMPTS)) expect(prompt.length).toBeLessThanOrEqual(1300);
    expect(TRYON_PROMPTS.outerwear.length).toBeLessThanOrEqual(999);
  });

  it('words the layer and outerwear open-front rules verbatim: construction copied from the photo, pullovers closed, a full-length front opening worn open even when photographed fastened', () => {
    const RULES = 'Copy the garment\'s construction from image 2; never invent or extend an opening or fastening. Pullovers, including '
      + 'hooded sweatshirts, stay closed; a neck-only zip or placket stays as shown. Garments with a full-length front opening, including '
      + 'jackets and coats photographed fastened, are worn fully open with the front panels naturally parted, keeping existing '
      + 'underlying clothing visible through the opening. Do not mistake a kangaroo pocket or drawstrings for a zipper. Do not invent a '
      + 'top or other clothing, or reveal clothing hidden by another closed layer. Keep the person\'s face, hair, skin, body shape, '
      + 'pose, other clothing and background unchanged. Preserve the garment\'s colour, pattern, logos, length, cut and design; when '
      + 'worn open, change only the fastening and drape.';
    expect(TRYON_PROMPTS.outerwear).toBe('Image 1 shows a person. Image 2 shows one garment (outerwear). Show the same person wearing this '
      + `garment as the outermost layer over their existing clothing. ${RULES} Photorealistic, whole person in frame.`);
    expect(TRYON_PROMPTS.layer.startsWith('Image 1 shows a person. Image 2 shows one garment (layer worn over other clothing). Show the same '
      + `person wearing this garment over their existing clothing. ${RULES} Show the garment at the full length`)).toBe(true);
    for (const slot of ['layer', 'outerwear'] as const) {
      const text = TRYON_PROMPTS[slot];
      // The construction rule leads; pullovers and neck-only zips stay as shown; a full-length opening is worn open even when photographed
      // fastened (the original closed-coat case), and a pocket or drawstrings are not read as a zipper.
      const at = (part: string) => { const index = text.indexOf(part); expect(index, part).toBeGreaterThan(-1); return index; };
      expect(at('Copy the garment\'s construction from image 2')).toBeLessThan(at('Pullovers, including hooded sweatshirts, stay closed'));
      expect(at('Pullovers, including hooded sweatshirts, stay closed; a neck-only zip or placket stays as shown')).toBeLessThan(at('are worn fully open'));
      expect(at('including jackets and coats photographed fastened, are worn fully open')).toBeLessThan(at('Do not mistake a kangaroo pocket or drawstrings for a zipper'));
      expect(text.match(/worn fully open/g)).toHaveLength(1);
      for (const gone of ['If this garment has an existing front opening', 'allow only fastening', 'clearly shows', 'Only if', 'unzipped look']) {
        expect(text).not.toContain(gone);
      }
    }
    expect(TRYON_PROMPTS.accessory).toContain('adding it without removing or changing any clothing');
    for (const slot of ['layer', 'outerwear', 'accessory'] as const) expect(TRYON_PROMPTS[slot]).not.toContain('replacing only the clothing it covers');
    // Fixed words only: no user text or item field can reach a prompt.
    for (const prompt of Object.values(TRYON_PROMPTS)) expect(prompt).toMatch(/^Image 1 shows a person\. Image 2 shows one garment \([a-z -]+\)\. [^{}$]+$/);
  });

  it('pins the installed v1 prompt, parameter and settings hashes from the frozen fixture', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261003090000_try_on.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_V1_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_V1_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_V1_MANIFEST}','${TRYON_MODEL}',1,`);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
  });

  it('pins the v2 prompt, parameter and settings hashes from the frozen fixture in TRYON-LIMITS1', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261101200000_tryon_limits.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_V2_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_V2_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_V2_MANIFEST}','${TRYON_MODEL}',2,`);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
  });

  it('pins the v3 prompt, parameter and settings hashes from the frozen fixture in TRYON-PROMPT1', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261102090000_tryon_prompt_v3.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_V3_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_V3_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_V3_MANIFEST}','${TRYON_MODEL}',3,`);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
    expect(sha(JSON.stringify(TRYON_V3_PROMPTS))).not.toBe(sha(JSON.stringify(TRYON_V2_PROMPTS)));
    expect(JSON.stringify(TRYON_V3_SETTINGS.limits)).toBe(JSON.stringify(TRYON_V2_SETTINGS.limits));
    expect(JSON.stringify({ ...TRYON_V3_SETTINGS, profileId: TRYON_V2_MANIFEST, promptVersion: 2 })).toBe(JSON.stringify(TRYON_V2_SETTINGS));
  });

  it('pins the v4 prompt, parameter and settings hashes from the frozen fixture in TRYON-PROMPT2', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261109110000_tryon_prompt_v4.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_V4_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_V4_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_V4_MANIFEST}','${TRYON_MODEL}',4,`);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
    expect(sql.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    expect(JSON.stringify(TRYON_V4_SETTINGS.limits)).toBe(JSON.stringify(TRYON_V3_SETTINGS.limits));
    expect(JSON.stringify({ ...TRYON_V4_SETTINGS, profileId: TRYON_V3_MANIFEST, promptVersion: 3 })).toBe(JSON.stringify(TRYON_V3_SETTINGS));
    expect(sha(JSON.stringify(TRYON_V4_PROMPTS))).not.toBe(sha(JSON.stringify(TRYON_V3_PROMPTS)));
  });

  it('pins the v5 prompt, parameter and settings hashes and the manifest envelope in TRYON-PROMPT3', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261111090000_tryon_prompt_v5.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_MANIFEST}','${TRYON_MODEL}',${TRYON_PROMPT_VERSION},`);
    expect(TRYON_MANIFEST).toBe('azure-global-image25-sunburst-tryon-v5');
    expect(TRYON_PROMPT_VERSION).toBe(5);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
    // The earlier manifests are not edited: the new migration inserts v5 only, and neither the parameters nor the limits changed.
    expect(sql.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    expect(sha(JSON.stringify(TRYON_PARAMETERS))).toBe(sha(JSON.stringify(TRYON_V1_SETTINGS.parameters)));
    expect(sha(JSON.stringify(TRYON_PARAMETERS))).toBe(sha(JSON.stringify(TRYON_V4_SETTINGS.parameters)));
    expect(JSON.stringify(TRYON_SETTINGS.limits)).toBe(JSON.stringify(TRYON_V4_SETTINGS.limits));
    expect(JSON.stringify({ ...TRYON_SETTINGS, profileId: TRYON_V4_MANIFEST, promptVersion: 4 })).toBe(JSON.stringify(TRYON_V4_SETTINGS));
    expect(sha(JSON.stringify(TRYON_PROMPTS))).not.toBe(sha(JSON.stringify(TRYON_V4_PROMPTS)));
    // Six steps stay the settings' limit (and the hash); at most five slots can be drawn now that outerwear is optional.
    expect(TRYON_SETTINGS.maxSteps).toBe(TRYON_MAX_STEPS);
    expect(TRYON_SETTINGS.maxResults).toBe(TRYON_MAX_RESULTS);
    // The notice is unchanged, so owners are not asked to consent again.
    expect(TRYON_NOTICE_REVISION).toBe(3);
    expect(BigInt(TRYON_RESERVATION_MICRO)).toBe(tryOnEstimateMicro(15000, 8000));
    expect(TRYON_PARAMETERS).toEqual({ ...ENHANCE_PARAMETERS, model: TRYON_DEPLOYMENT });
    expect(Object.keys(TRYON_PARAMETERS)).not.toContain('input_fidelity');
  });

  it('estimates with the ceiling of the rate products', () => {
    expect(tryOnEstimateMicro(0, 0)).toBe(0n);
    expect(tryOnEstimateMicro(1, 0)).toBe(8n);
    expect(tryOnEstimateMicro(9000, 6000)).toBe(252000n);
    expect(tryOnEstimateMicro(1, 1)).toBe(38n);
  });
});
