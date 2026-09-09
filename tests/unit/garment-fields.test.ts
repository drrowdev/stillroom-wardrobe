import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import {
  buildGarmentWrite, editGarmentField, garmentDraftDirty, garmentFields, garmentPayload, initialRawFields, newGarmentDraft,
  parseGarmentValues, sameValue, validateGarmentDraft, type GarmentDraft, type GarmentField, type RawFields,
} from '../../src/domain/garment-fields';
import { fieldAssertion, maximumFieldRevision, provenanceFields, type FieldProvenance } from '../../src/domain/attribute-provenance';
import { confirmsItem, itemFactColumns, parseItemBaseline, prepareGarmentAttempt } from '../../src/domain/item-details';
import { newSaveAttempt, saveItem } from '../../src/images/upload';
import { canonicalPrice, parsePrice, priceForDatabase, validDateOnly } from '../../src/i18n/format';
import { messages } from '../../src/i18n';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const id = '20000000-0000-4000-8000-000000000001';
const scope = (): OwnerScope => ({ ownerId: owner, epoch: 4, signal: new AbortController().signal });
function draft(): GarmentDraft {
  return editGarmentField(editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'Shirt', 'en'), 'category', 'top', 'en');
}
const fullRaw: RawFields = {
  title: 'Å shirt 🌿', category: 'layer', subcategory: 'Overshirt', colours: ['olive', 'green'], pattern: 'checked',
  sleeve_length: 'long', garment_length: 'regular', brand: 'Own brand', size_label: 'M', material: 'Cotton',
  seasons: ['spring', 'autumn'], formality: '2', warmth: '3', min_temp: '-5', max_temp: '15', rain_rating: '1',
  windproof: 'false', upper_coverage: '2', lower_coverage: '0', style_tags: ['calm'], tags: ['weekday'],
  purchase_date: '2026-09-09', purchase_price: '0.10', notes: '  Literal notes\nsecond line  ', currency: 'USD',
  favourite: 'true', availability: 'laundry', lifecycle: 'archived', exclude_suggestions: 'true', wear_more: 'true',
};
function fullDraft(): GarmentDraft {
  return { raw: structuredClone(fullRaw), intent: Object.fromEntries(garmentFields.map((key) => [key, true])), priceLanguage: 'en' };
}
function row() {
  return { ...garmentPayload(buildGarmentWrite(draft()).values), id, owner_id: owner, deleted_at: null, version: 3,
    created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', field_provenance: {} };
}
describe('closed complete manual fields', () => {
  it('has exactly thirty fields, unknown physical facts and visible non-factual defaults', () => {
    expect(new Set(garmentFields).size).toBe(30);
    const { values, patch } = buildGarmentWrite(draft());
    expect(values).toMatchObject({ colours: [], seasons: [], warmth: null, windproof: null, favourite: false, currency: 'EUR', availability: 'ready', lifecycle: 'active' });
    expect(Object.keys(garmentPayload(values)).sort()).toEqual([...garmentFields].sort());
    expect(patch.field_provenance).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
    expect(fieldAssertion(patch.field_provenance, 'warmth')).toEqual({ kind: 'unknown', revision: 0 });
    expect(newGarmentDraft('USD', 'fi').intent).toEqual({});
  });
  it('preserves all reviewed fields and only explicitly supplied insert assertions', () => {
    const result = buildGarmentWrite(fullDraft());
    expect(Object.keys(result.patch.field_provenance)).toHaveLength(24);
    for (const field of provenanceFields) expect(result.patch.field_provenance[field]).toEqual({ kind: 'user', revision: 1 });
    expect(result.values.notes).toBe(fullRaw.notes);
    expect(result.values.purchase_price).toBe('0.10');
    expect(result.values.windproof).toBe(false);
    expect(result.values.lower_coverage).toBe(0);
    expect(result.patch).not.toHaveProperty('id');
    expect(result.patch).not.toHaveProperty('owner_id');
    expect(result.patch).not.toHaveProperty('deleted_at');
  });
  it.each(provenanceFields)('couples the changed %s value and exact next manual assertion', (field) => {
    const base = parseItemBaseline(row(), owner, id);
    const next = editGarmentField(newGarmentDraft('EUR', 'en', base.values), field, fullRaw[field], 'en');
    const attempt = prepareGarmentAttempt(base, next, 4);
    expect(attempt.patch).toHaveProperty(field);
    expect(attempt.patch.field_provenance).toEqual({ [field]: { kind: 'user', revision: 1 } });
    expect(confirmsItem(parseItemBaseline({ ...row(), ...attempt.patch, version: 4 }, owner, id), attempt)).toBe(true);
    const bad = { ...row(), ...attempt.patch, version: 4, field_provenance: {} };
    expect(confirmsItem(parseItemBaseline(bad, owner, id), attempt)).toBe(false);
  });
  it.each(provenanceFields)('same-value confirmation of %s requires intent, then becomes an already-user no-op', (field) => {
    const base = parseGarmentValues({ ...row(), ...garmentPayload(buildGarmentWrite(fullDraft()).values) });
    const unchanged = newGarmentDraft('USD', 'en', base);
    expect(Object.keys(buildGarmentWrite(unchanged, base).patch)).toEqual(['field_provenance']);
    const edited = editGarmentField(unchanged, field, unchanged.raw[field], 'en');
    expect(buildGarmentWrite(edited, base).patch.field_provenance[field]).toEqual({ kind: 'user', revision: 1 });
    const provenance: FieldProvenance = { [field]: { kind: 'user', revision: 7 } };
    expect(buildGarmentWrite(edited, base, provenance).patch).toEqual({ field_provenance: provenance });
    expect(garmentDraftDirty(edited, base, provenance)).toBe(false);
    expect(garmentDraftDirty(edited, base, {})).toBe(true);
  });
  it.each(['unknown', 'user'] as const)('records explicit clears even on already-empty %s fields', (kind) => {
    const base = parseGarmentValues(row());
    for (const field of provenanceFields.filter((key) => key !== 'title' && key !== 'category')) {
      const provenance: FieldProvenance = { [field]: { kind, revision: 1 } };
      const next = editGarmentField(newGarmentDraft('EUR', 'en', base), field, initialRawFields('EUR')[field], 'en');
      const { patch } = buildGarmentWrite(next, base, provenance);
      expect(garmentDraftDirty(next, base, provenance)).toBe(true);
      expect(patch).toHaveProperty(field);
      expect(patch.field_provenance[field]).toEqual({ kind: 'user', revision: 2 });
    }
  });
  it.each([
    ['purchase_price', '12,50', 'fi'], ['purchase_price', '12,50', 'sv'],
    ['min_temp', '007', 'en'], ['title', '  Shirt  ', 'en'],
  ] as const)('retains equivalent already-user %s raw input under %s without a patch or dirty guard', (field, raw, language) => {
    const base = parseItemBaseline({ ...row(), purchase_price: 12.5, min_temp: 7,
      field_provenance: { [field]: { kind: 'user', revision: 1 } } }, owner, id);
    const next = editGarmentField(newGarmentDraft('EUR', language, base.values), field, raw, language);
    expect(validateGarmentDraft(next, base.values).values).toEqual(base.values);
    expect(garmentDraftDirty(next, base.values, base.provenance)).toBe(false);
    expect(buildGarmentWrite(next, base.values, base.provenance).patch).toEqual({ field_provenance: base.provenance });
    expect(() => prepareGarmentAttempt(base, next, 4)).toThrow('detail.invalidFields');
    expect(next.raw[field]).toBe(raw);
    expect(next.intent[field]).toBe(true);
    expect(garmentDraftDirty(next, base.values, {})).toBe(true);
    expect(buildGarmentWrite(next, base.values).patch).toMatchObject({ [field]: garmentPayload(base.values)[field],
      field_provenance: { [field]: { kind: 'user', revision: 1 } } });
  });
  it('keeps invalid input and actual notes/ordered collection/value changes protected beside price formatting', () => {
    const base = parseItemBaseline({ ...row(), purchase_price: 12.5, style_tags: ['calm', 'plain'],
      field_provenance: { purchase_price: { kind: 'user', revision: 1 } } }, owner, id);
    const formatted = editGarmentField(newGarmentDraft('EUR', 'fi', base.values), 'purchase_price', '12,50', 'fi');
    for (const [field, raw] of [['purchase_price', '12,'], ['min_temp', '51'], ['title', ' ']] as const) {
      const next = editGarmentField(formatted, field, raw, 'fi');
      expect(validateGarmentDraft(next, base.values).errors[field]).toBe(true);
      expect(garmentDraftDirty(next, base.values, base.provenance)).toBe(true);
      expect(() => buildGarmentWrite(next, base.values, base.provenance)).toThrow();
      expect(next.raw[field]).toBe(raw);
    }
    for (const [field, raw] of [['notes', '  Literal\nnotes  '], ['style_tags', ['plain', 'calm']], ['warmth', '0'], ['windproof', 'false']] as const) {
      const next = editGarmentField(formatted, field, typeof raw === 'string' ? raw : [...raw], 'en');
      expect(next.priceLanguage).toBe('fi');
      expect(next.raw.purchase_price).toBe('12,50');
      expect(garmentDraftDirty(next, base.values, base.provenance)).toBe(true);
      const attempt = prepareGarmentAttempt(base, next, 4);
      expect(attempt.patch).toHaveProperty(field);
      expect(attempt.patch).not.toHaveProperty('purchase_price');
      expect(attempt.patch.field_provenance[field]).toEqual({ kind: 'user', revision: 1 });
    }
    const mismatch = structuredClone(formatted);
    mismatch.raw.notes = 'Untracked change';
    expect(garmentDraftDirty(mismatch, base.values, base.provenance)).toBe(true);
  });
  it('rejects value/intent mismatch and arbitrary raw, intent or outgoing system keys', () => {
    const base = parseGarmentValues(row()), next = newGarmentDraft('EUR', 'en', base);
    next.raw.warmth = '2';
    expect(() => buildGarmentWrite(next, base)).toThrow();
    const create = draft(); create.raw.brand = 'No intent';
    expect(() => buildGarmentWrite(create)).toThrow();
    expect(() => buildGarmentWrite({ ...draft(), raw: { ...draft().raw, deleted_at: '' } } as GarmentDraft)).toThrow();
    expect(() => buildGarmentWrite({ ...draft(), intent: { owner_id: true } } as GarmentDraft)).toThrow();
    expect(garmentPayload({ ...base, deleted_at: '2026-09-09', version: 9 } as typeof base)).not.toHaveProperty('deleted_at');
    expect(garmentPayload({ ...base, version: 9 } as typeof base)).not.toHaveProperty('version');
  });
  it('retains legacy collections, whitespace, duplicate words and unrelated provenance exactly', () => {
    const historical = { ...row(), colours: ['unknown', 'Owner colour'], seasons: ['spring', 'summer', 'autumn', 'winter'],
      style_tags: ['x'.repeat(50), 'calm', 'calm'], subcategory: '   ', notes: '\n  original  \n',
      field_provenance: { warmth: { kind: 'unknown', revision: 8 } } };
    const base = parseItemBaseline(historical, owner, id);
    const next = editGarmentField(newGarmentDraft('EUR', 'fi', base.values), 'title', 'New name', 'fi');
    const attempt = prepareGarmentAttempt(base, next, 4);
    expect(attempt.patch).toEqual({ title: 'New name', field_provenance: { ...historical.field_provenance, title: { kind: 'user', revision: 1 } } });
    expect(confirmsItem(parseItemBaseline({ ...historical, ...attempt.patch, version: 4 }, owner, id), attempt)).toBe(true);
    expect(confirmsItem(parseItemBaseline({ ...historical, ...attempt.patch, version: 4, created_at: 'later' }, owner, id), attempt)).toBe(false);
    for (const field of itemFactColumns) expect(attempt.baseline.facts[field]).toEqual(base.facts[field]);
  });
  it('does not admit new duplicate words or clean historical words silently', () => {
    const base = parseGarmentValues({ ...row(), style_tags: ['calm', 'calm'] });
    expect(validateGarmentDraft(editGarmentField(newGarmentDraft('EUR', 'en', base), 'style_tags', ['calm', 'calm'], 'en'), base).values).not.toBeNull();
    expect(validateGarmentDraft(editGarmentField(draft(), 'style_tags', ['calm', 'calm'], 'en')).values).toBeNull();
  });
  it('refuses revision overflow and unsafe row versions before writes', () => {
    const base = parseItemBaseline({ ...row(), field_provenance: { warmth: { kind: 'unknown', revision: maximumFieldRevision } } }, owner, id);
    const next = editGarmentField(newGarmentDraft('EUR', 'en', base.values), 'warmth', '0', 'en');
    expect(() => prepareGarmentAttempt(base, next, 4)).toThrow('error.conflict');
    expect(() => prepareGarmentAttempt({ ...base, version: Number.MAX_SAFE_INTEGER }, next, 4)).toThrow();
  });
  it.each([
    ['title', '🌿'.repeat(101)], ['subcategory', '🌿'.repeat(61)], ['brand', 'a'.repeat(101)],
    ['size_label', 'a'.repeat(51)], ['material', 'a'.repeat(201)], ['notes', 'a'.repeat(4001)],
    ['formality', '5'], ['warmth', '1.2'], ['min_temp', '-41'], ['max_temp', '51'], ['rain_rating', '3'],
    ['upper_coverage', '-1'], ['lower_coverage', '3'], ['windproof', '0'], ['favourite', ''],
    ['currency', 'eur'], ['availability', 'unknown'], ['lifecycle', 'trash'], ['pattern', 'invented'],
    ['sleeve_length', 'invented'], ['garment_length', 'invented'], ['purchase_date', '2025-02-29'],
    ['purchase_price', '1e2'], ['purchase_price', '-1'], ['purchase_price', '10000000000'],
  ] as const)('retains and rejects invalid %s input', (field, value) => {
    const next = editGarmentField(draft(), field, value, 'en');
    expect(validateGarmentDraft(next).errors[field]).toBe(true);
    expect(next.raw[field]).toBe(value);
  });
  it.each([['colours', ['a', 'b', 'c', 'd']], ['seasons', ['monsoon']], ['tags', ['🌿'.repeat(41)]],
    ['style_tags', Array.from({ length: 9 }, (_, i) => String(i))], ['tags', Array.from({ length: 12 }, (_, i) => `${i}${'🌿'.repeat(39)}`)] ] satisfies Array<[GarmentField, string[]]>)('rejects invalid collection %s', (field, value) => {
    expect(validateGarmentDraft(editGarmentField(draft(), field, value, 'en')).errors[field]).toBe(true);
  });
  it('counts Unicode code points, preserves zero/false and rejects contradictory temperatures', () => {
    expect(validateGarmentDraft(editGarmentField(draft(), 'title', '🌿'.repeat(100), 'en')).values?.title).toHaveLength(200);
    const zero = editGarmentField(editGarmentField(draft(), 'warmth', '0', 'en'), 'windproof', 'false', 'en');
    expect(validateGarmentDraft(zero).values).toMatchObject({ warmth: 0, windproof: false });
    const bad = editGarmentField(editGarmentField(draft(), 'min_temp', '10', 'en'), 'max_temp', '9', 'en');
    expect(validateGarmentDraft(bad).errors).toMatchObject({ min_temp: true, max_temp: true });
  });
  it('keeps entry-locale context and unfinished raw price across UI language changes', () => {
    let next = editGarmentField(draft(), 'purchase_price', '1,234.50', 'en');
    next = editGarmentField(next, 'notes', 'Suomi', 'fi');
    expect(validateGarmentDraft(next).values?.purchase_price).toBe('1234.50');
    expect(next.raw.purchase_price).toBe('1,234.50');
    next = editGarmentField(next, 'purchase_price', '0,10', 'fi');
    next = editGarmentField(next, 'notes', 'English', 'en');
    expect(validateGarmentDraft(next).values?.purchase_price).toBe('0.10');
    next = editGarmentField(next, 'purchase_price', '1,', 'sv');
    next = editGarmentField(next, 'notes', '', 'en');
    expect(next.raw.purchase_price).toBe('1,');
    expect(validateGarmentDraft(next).values).toBeNull();
  });
  it('keeps the migration constraint/default-only and preserves all immutable old sources/types', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20260909110000_item_optional_collections.sql', import.meta.url), 'utf8');
    expect(sql).toContain("seasons <@ array['spring','summer','autumn','winter']::text[]");
    expect(sql).toContain('cardinality(colours) between 0 and 3');
    expect(sql).toContain('cardinality(seasons) between 0 and 4');
    expect(sql).not.toMatch(/\b(update|insert|delete|function|trigger|grant|policy|column\s+\w+\s+drop)\b/i);
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
  });
});
describe('canonical price and date values', () => {
  it.each(['0.01', '0.10', '0.00', '9999999999.99'])('round trips %s at the bounded SDK number boundary', (price) => {
    expect(canonicalPrice(priceForDatabase(price))).toBe(price);
  });
  it.each(['fi', 'sv'] as const)('accepts %s comma, point and reference grouping', (language) => {
    expect(parsePrice('1 234,50', language)).toBe('1234.50');
    expect(parsePrice('1\u00a0234.50', language)).toBe('1234.50');
    expect(parsePrice('0,10', language)).toBe('0.10');
    for (const bad of ['1.234,50', '1,234', '12 34,50', '1.2.3', 'NaN', '1e3', '-0', '1,']) expect(() => parsePrice(bad, language)).toThrow();
  });
  it('rejects malformed English grouping, rounding and overflow', () => {
    expect(parsePrice('1,234.50', 'en')).toBe('1234.50');
    for (const bad of ['', '1,23', '1.234', '10000000000.00', 'Infinity', '+2', '1.', '1 234']) expect(() => parsePrice(bad, 'en')).toThrow();
    for (const bad of [NaN, Infinity, -1, 0.001, 10000000000]) expect(() => canonicalPrice(bad)).toThrow();
    expect(validDateOnly('2024-02-29')).toBe(true);
    expect(validDateOnly('2099-12-31')).toBe(true);
    for (const bad of ['2025-02-29', '2026-04-31', '0000-01-01', '2026-9-9']) expect(validDateOnly(bad)).toBe(false);
  });
});

describe('full creation snapshot and metadata reconciliation (mocked SDK)', () => {
  const photo = () => ({ main: new Blob([new Uint8Array([255, 216, 255, 217])]), thumb: new Blob([new Uint8Array([255, 216, 255, 217])]),
    width: 2, height: 2, mainSha256: 'a'.repeat(64), thumbSha256: 'b'.repeat(64) });
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  function backend(fetcher: (url: URL, init?: RequestInit) => Response) {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => fetcher(new URL(String(input)), init));
    const client = createClient<Database>('http://127.0.0.1:54321', 'browser-fixture-only', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
    });
    return { client, fetch };
  }
  it('explains intentional blank photo descriptions in all languages without a title fallback', () => {
    expect(messages['capture.descriptionHelp']).toEqual({
      en: 'Describe the photo for someone using a screen reader. If left blank, the photo is saved without a description.',
      fi: 'Kuvaile kuvaa ruudunlukijan käyttäjälle. Jos jätät kentän tyhjäksi, kuva tallennetaan ilman kuvausta.',
      sv: 'Beskriv fotot för den som använder skärmläsare. Om fältet lämnas tomt sparas fotot utan beskrivning.',
    });
    for (const caption of ['', '   ']) {
      const attempt = newSaveAttempt(draft(), caption, photo(), scope());
      expect(attempt.values.title).toBe('Shirt');
      expect(attempt.altText).toBe('');
    }
  });
  it('deep freezes arrays/assertions/photo metadata while retaining immutable blobs and owner epoch', () => {
    const live = fullDraft(), pixels = photo(), attempt = newSaveAttempt(live, ' ', pixels, scope());
    live.raw.colours.push('pink'); live.raw.notes = 'mutated'; pixels.width = 8;
    expect(attempt.values.colours).toEqual(['olive', 'green']);
    expect(attempt.values.notes).toBe(fullRaw.notes);
    expect(attempt.photo.width).toBe(2);
    expect(attempt.photo.main).toBe(pixels.main);
    expect(attempt.altText).toBe('');
    expect(Object.isFrozen(attempt.payload.colours)).toBe(true);
    expect(Object.isFrozen(attempt.payload.field_provenance.title)).toBe(true);
    expect(attempt).toMatchObject({ ownerId: owner, epoch: 4 });
  });
  it('refuses foreign epoch, owner or abort before any new call', async () => {
    const attempt = newSaveAttempt(draft(), '', photo(), scope());
    const api = backend(() => response(null));
    const controller = new AbortController(); controller.abort();
    for (const current of [{ ...scope(), ownerId: other }, { ...scope(), epoch: 5 }, { ...scope(), signal: controller.signal }]) {
      await expect(saveItem(api.client, current, attempt, () => {})).rejects.toThrow();
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it.each(['pending', 'ready'])('checks %s caption/version without mutating transport', async (state) => {
    const attempt = newSaveAttempt(fullDraft(), '', photo(), scope());
    let caption = '', counter = state === 'pending' ? 2 : 8;
    const item = { ...attempt.payload, id: attempt.itemId, owner_id: owner, deleted_at: null, version: 1 };
    const api = backend((url, init) => {
      if (init?.method === 'POST') return response({ code: '23505' }, 409);
      if (url.pathname.endsWith('/items')) return response(item);
      return response({ id: attempt.imageId, item_id: attempt.itemId, owner_id: owner, state, retired_at: null,
        main_path: `${owner}/${attempt.itemId}/${attempt.imageId}/main.jpg`, thumb_path: `${owner}/${attempt.itemId}/${attempt.imageId}/thumb.jpg`,
        description_version: counter, alt_text: caption, width: 2, height: 2,
        main_bytes: 4, thumb_bytes: 4, main_sha256: 'a'.repeat(64), thumb_sha256: 'b'.repeat(64) });
    });
    if (state === 'pending') await expect(saveItem(api.client, scope(), attempt, () => {})).rejects.toThrow('error.conflict');
    else await expect(saveItem(api.client, scope(), attempt, () => {})).resolves.toBeUndefined();
    caption = 'Changed by owner'; counter = 1;
    await expect(saveItem(api.client, scope(), attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.fetch.mock.calls.every(([input]) => !String(input).includes('/storage/') && !String(input).includes('/rpc/'))).toBe(true);
  });
  it.each(garmentFields)('rejects a duplicate item with a different frozen %s', async (field) => {
    const attempt = newSaveAttempt(fullDraft(), 'caption', photo(), scope());
    const api = backend((url, init) => {
      if (init?.method === 'POST') return response({ code: '23505' }, 409);
      expect(url.pathname).toBe('/rest/v1/items');
      return response({ ...attempt.payload, id: attempt.itemId, owner_id: owner, deleted_at: null, version: 1, [field]: null });
    });
    await expect(saveItem(api.client, scope(), attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });
  it('compares nested values structurally, never by object key order', () => {
    expect(sameValue({ a: ['x', 'y'], b: { kind: 'user', revision: 1 } }, { b: { revision: 1, kind: 'user' }, a: ['x', 'y'] })).toBe(true);
    expect(sameValue(['x', 'y'], ['y', 'x'])).toBe(false);
  });
});
