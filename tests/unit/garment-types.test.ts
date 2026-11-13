import { describe, expect, it } from 'vitest';
import { categories } from '../../src/domain/wardrobe';
import { garmentTypes, garmentTypesByCategory, garmentTypesFor, isGarmentType, isGarmentTypeFor } from '../../src/domain/garment-types';
import {
  buildGarmentWrite, editGarmentField, garmentDraftDirty, newGarmentDraft, parseGarmentValues, validateGarmentDraft,
} from '../../src/domain/garment-fields';
import { itemFacts } from '../../src/features/wardrobe/item-facts';
import { parseItemBaseline } from '../../src/domain/item-details';
import { languages, translate, type MessageKey } from '../../src/i18n/all';
import type { GarmentValues } from '../../src/domain/garment-fields';

const owner = '10000000-0000-4000-8000-000000000001';
const item = '20000000-0000-4000-8000-000000000001';
const typed = (category: string, type: string) => editGarmentField(editGarmentField(editGarmentField(
  newGarmentDraft('EUR', 'en'), 'title', 'Garment', 'en'), 'category', category, 'en'), 'garment_type', type, 'en');
function baseline(category: string, type: string | null): GarmentValues {
  const draft = editGarmentField(editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'Garment', 'en'), 'category', category, 'en');
  const values = { ...buildGarmentWrite(draft).values, garment_type: type } as GarmentValues;
  return values;
}

describe('closed garment types (CAPS1a)', () => {
  it('lists every code once, each category has types, and every type belongs to a category', () => {
    expect(garmentTypes).toHaveLength(32);
    expect(new Set(garmentTypes).size).toBe(32);
    for (const category of categories) expect(garmentTypesByCategory[category].length).toBeGreaterThan(0);
    const used = new Set(categories.flatMap((category) => garmentTypesByCategory[category]));
    expect([...used].sort()).toEqual([...garmentTypes].sort());
  });
  it('allows a vest or an overshirt as a layer and as outerwear, and nothing outside its category', () => {
    for (const type of ['vest', 'overshirt']) {
      expect(isGarmentTypeFor('layer', type)).toBe(true);
      expect(isGarmentTypeFor('outerwear', type)).toBe(true);
      expect(isGarmentTypeFor('top', type)).toBe(false);
    }
    expect(isGarmentTypeFor('bottom', 'jeans')).toBe(true);
    expect(isGarmentTypeFor('top', 'jeans')).toBe(false);
    expect(isGarmentTypeFor('', 'shirt')).toBe(false);
    expect(isGarmentTypeFor('toString', 'shirt')).toBe(false);
    expect(garmentTypesFor('nonsense')).toEqual([]);
    expect(isGarmentType('shirt') && !isGarmentType('Shirt') && !isGarmentType(null)).toBe(true);
  });
  it('has a label in every language for every type', () => {
    for (const language of languages) for (const type of garmentTypes) {
      expect(translate(language, `garmentType.${type}` as MessageKey).trim()).not.toBe('');
    }
  });
  it('validates the pair, treats an empty type as not set, and refuses an invented or mismatched code', () => {
    expect(validateGarmentDraft(typed('outerwear', 'vest')).values?.garment_type).toBe('vest');
    expect(validateGarmentDraft(editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'x', 'en')).errors.garment_type).toBeUndefined();
    const mismatch = { ...typed('top', 'shirt'), raw: { ...typed('top', 'shirt').raw, garment_type: 'jeans' } };
    expect(validateGarmentDraft(mismatch).errors.garment_type).toBe(true);
    expect(validateGarmentDraft({ ...mismatch, raw: { ...mismatch.raw, garment_type: 'poncho' } }).errors.garment_type).toBe(true);
  });
  it('clears a type the new category does not have, as one explicit edit, and keeps a type it does have', () => {
    const moved = editGarmentField(typed('top', 'sweatshirt'), 'category', 'layer', 'en');
    expect(moved.raw.garment_type).toBe('sweatshirt');
    const cleared = editGarmentField(typed('top', 'shirt'), 'category', 'bottom', 'en');
    expect(cleared.raw.garment_type).toBe('');
    expect(cleared.intent.garment_type).toBe(true);
    expect(validateGarmentDraft(cleared).errors).toEqual({});
  });
  it('writes the type with a user assertion when set or cleared on a saved item, and never when untouched', () => {
    const saved = baseline('top', 'shirt');
    const provenance = { garment_type: { kind: 'ai_observed' as const, revision: 1 } };
    const base = newGarmentDraft('EUR', 'en', saved);
    expect(garmentDraftDirty(base, saved, provenance)).toBe(false);
    const set = buildGarmentWrite(editGarmentField(base, 'garment_type', 'polo', 'en'), saved, provenance);
    expect(set.patch.garment_type).toBe('polo');
    expect(set.patch.field_provenance.garment_type).toEqual({ kind: 'user', revision: 2 });
    const clear = buildGarmentWrite(editGarmentField(base, 'garment_type', '', 'en'), saved, provenance);
    expect(clear.patch.garment_type).toBeNull();
    expect(clear.patch.field_provenance.garment_type).toEqual({ kind: 'user', revision: 2 });
    const other = buildGarmentWrite(editGarmentField(base, 'brand', 'Own', 'en'), saved, provenance);
    expect(other.patch).not.toHaveProperty('garment_type');
    expect(other.patch.field_provenance.garment_type).toEqual({ kind: 'ai_observed', revision: 1 });
  });
  it('shows the type in the item facts after the category, in every language, and omits it when not set', () => {
    for (const language of languages) {
      const t = (key: MessageKey) => translate(language, key);
      const facts = itemFacts(baseline('outerwear', 'puffer'), language, t);
      expect(facts.map((fact) => fact.field).slice(0, 2)).toEqual(['category', 'garment_type']);
      expect(facts[1]?.label).toBe(translate(language, 'item.garmentType'));
      expect(facts[1]?.value).toBe(translate(language, 'garmentType.puffer'));
      expect(itemFacts(baseline('outerwear', null), language, t).some((fact) => fact.field === 'garment_type')).toBe(false);
    }
  });
  it('reads a stored row with its type, and refuses a row that lacks the column or carries an impossible pair', () => {
    const base = baseline('bottom', 'jeans');
    const row = { id: item, owner_id: owner, version: 1, deleted_at: null, updated_at: '2026-11-12T00:00:00Z',
      field_provenance: {}, created_at: '2026-11-12T00:00:00Z', ...base, garment_type: 'jeans', purchase_price: null };
    expect(parseItemBaseline(row, owner, item).values.garment_type).toBe('jeans');
    const without: Record<string, unknown> = { ...row };
    delete without.garment_type;
    expect(() => parseItemBaseline(without, owner, item)).toThrow();
    expect(() => parseItemBaseline({ ...row, garment_type: 'blazer' }, owner, item)).toThrow();
    expect(parseGarmentValues({ ...row, garment_type: null }).garment_type).toBeNull();
  });
});
