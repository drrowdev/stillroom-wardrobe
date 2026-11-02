// VTO-1: the deterministic garment chain, the fixed prompts and the manifest arithmetic (plan rev4 §4, §7.1).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  TRYON_DEPLOYMENT, TRYON_MANIFEST, TRYON_MAX_RESULTS, TRYON_MAX_STEPS, TRYON_MODEL, TRYON_NOTICE_REVISION, TRYON_PARAMETERS, TRYON_PROMPTS,
  TRYON_PROMPT_VERSION, TRYON_RESERVATION_MICRO, TRYON_SETTINGS, selectTryOnSteps, tryOnCategories, tryOnEstimateMicro, tryOnPrompt,
  tryOnSlots, type TryOnCandidate,
} from '../../src/domain/tryon';
import { selectTryOnStepsV1 } from '../fixtures/tryon-select-v1';
import { TRYON_V1_MANIFEST, TRYON_V1_PROMPTS, TRYON_V1_SETTINGS } from '../fixtures/tryon-v1-frozen';
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

  it('adds layers, outerwear and one accessory in a fixed order, up to six steps', () => {
    const selection = selectTryOnSteps([item('x', 'accessory'), item('o', 'outerwear'), item('s', 'footwear'), item('l', 'layer'),
      item('b', 'bottom'), item('t', 'top'), item('y', 'accessory'), item('d', 'accessory', { deleted: true })]);
    expect(TRYON_MAX_STEPS).toBe(6);
    expect(selection.steps).toEqual([{ slot: 'top', itemId: 't' }, { slot: 'bottom', itemId: 'b' }, { slot: 'layer', itemId: 'l' },
      { slot: 'outerwear', itemId: 'o' }, { slot: 'footwear', itemId: 's' }, { slot: 'accessory', itemId: 'x' }]);
    expect(selection.steps).toHaveLength(TRYON_MAX_STEPS);
    // A second accessory has no step; the deleted one is not eligible and is not listed either.
    expect(selection.notIncluded).toEqual(['y']);
  });

  it('keeps the old order for outfits without the new kinds, so shoes stay last', () => {
    const selection = selectTryOnSteps([item('s', 'footwear'), item('b', 'bottom'), item('t', 'top')]);
    expect(selection.steps.map((step) => step.slot)).toEqual(['top', 'bottom', 'footwear']);
  });

  it('lets a one-piece keep the layer, outerwear, shoes and accessory steps', () => {
    const selection = selectTryOnSteps([item('t', 'top'), item('b', 'bottom'), item('d', 'one_piece'), item('l', 'layer'),
      item('o', 'outerwear'), item('s', 'footwear'), item('a', 'accessory')]);
    expect(selection.steps.map((step) => step.slot)).toEqual(['one_piece', 'layer', 'outerwear', 'footwear', 'accessory']);
    expect(selection.notIncluded).toEqual([]);
  });

  it('tries on an outfit that has only an accessory, a layer or outerwear', () => {
    expect(selectTryOnSteps([item('a', 'accessory')]).steps).toEqual([{ slot: 'accessory', itemId: 'a' }]);
    expect(selectTryOnSteps([item('o', 'outerwear')]).steps).toEqual([{ slot: 'outerwear', itemId: 'o' }]);
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

  it('keeps the four installed v1 prompts byte for byte and words the three new slots for adding, not replacing', () => {
    for (const [slot, prompt] of Object.entries(TRYON_V1_PROMPTS)) expect(TRYON_PROMPTS[slot as keyof typeof TRYON_PROMPTS]).toBe(prompt);
    expect(TRYON_PROMPTS.layer).toContain('over the clothing they already wear');
    expect(TRYON_PROMPTS.outerwear).toContain('as the outermost layer');
    expect(TRYON_PROMPTS.accessory).toContain('adding it without removing or changing any clothing');
    for (const slot of ['layer', 'outerwear', 'accessory'] as const) expect(TRYON_PROMPTS[slot]).not.toContain('replacing only the clothing it covers');
  });

  it('pins the installed v1 prompt, parameter and settings hashes from the frozen fixture', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261003090000_try_on.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_V1_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_V1_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_V1_MANIFEST}','${TRYON_MODEL}',1,`);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
  });

  it('pins the v2 prompt, parameter and settings hashes and the manifest envelope in TRYON-LIMITS1', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261101200000_tryon_limits.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_MANIFEST}','${TRYON_MODEL}',${TRYON_PROMPT_VERSION},`);
    expect(TRYON_MANIFEST).toBe('azure-global-image25-sunburst-tryon-v2');
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
    // The v1 manifest is not edited: the new migration inserts v2 only, and the request parameters did not change.
    expect(sql.match(/insert into private\.ai_execution_manifests/g)).toHaveLength(1);
    expect(sha(JSON.stringify(TRYON_PARAMETERS))).toBe(sha(JSON.stringify(TRYON_V1_SETTINGS.parameters)));
    expect(TRYON_SETTINGS.maxSteps).toBe(TRYON_MAX_STEPS);
    expect(TRYON_SETTINGS.maxResults).toBe(TRYON_MAX_RESULTS);
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
