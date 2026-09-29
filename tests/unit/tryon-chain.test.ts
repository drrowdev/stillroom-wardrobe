// VTO-1: the deterministic garment chain, the fixed prompts and the manifest arithmetic (plan rev4 §4, §7.1).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  TRYON_DEPLOYMENT, TRYON_MANIFEST, TRYON_MAX_STEPS, TRYON_MODEL, TRYON_PARAMETERS, TRYON_PROMPTS, TRYON_RESERVATION_MICRO,
  TRYON_SETTINGS, selectTryOnSteps, tryOnCategories, tryOnEstimateMicro, tryOnPrompt, type TryOnCandidate,
} from '../../src/domain/tryon';
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

  it('lists layers, outerwear and accessories as not included, and never exceeds three steps', () => {
    const selection = selectTryOnSteps([item('t', 'top'), item('l', 'layer'), item('o', 'outerwear'), item('a', 'accessory'),
      item('b', 'bottom'), item('s', 'footwear'), item('x', 'accessory', { deleted: true })]);
    expect(selection.steps).toHaveLength(TRYON_MAX_STEPS);
    expect(selection.notIncluded).toEqual(['l', 'o', 'a']);
  });

  it('returns no steps for an outfit with nothing to try on', () => {
    expect(selectTryOnSteps([item('a', 'accessory')]).steps).toEqual([]);
    expect(selectTryOnSteps([]).steps).toEqual([]);
  });
});

describe('try-on request contract', () => {
  it('uses fixed words only and one prompt per garment kind', () => {
    for (const [slot, prompt] of Object.entries(TRYON_PROMPTS)) {
      expect(prompt).toBe(tryOnPrompt(slot as keyof typeof TRYON_PROMPTS));
      expect(prompt).toMatch(/^Image 1 shows a person\. Image 2 shows one garment \(/);
    }
    expect(new Set(Object.values(TRYON_PROMPTS)).size).toBe(4);
  });

  it('pins the prompt, parameter and settings hashes and the manifest envelope', async () => {
    const sql = await readFile(new URL('../../supabase/migrations/20261003090000_try_on.sql', import.meta.url), 'utf8');
    for (const hash of [sha(JSON.stringify(TRYON_PROMPTS)), sha(JSON.stringify(TRYON_PARAMETERS)), sha(JSON.stringify(TRYON_SETTINGS))]) {
      expect(sql).toContain(`'${hash}'`);
    }
    expect(sql).toContain(`'${TRYON_MANIFEST}','${TRYON_MODEL}',1,`);
    expect(sql).toContain(`'USD',800,3000,15000,8000,${TRYON_RESERVATION_MICRO},512000,1600,4194304,512000,70,'2027-01-01T00:00:00Z'`);
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
