import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import {
  addTag, defaultItemName, fitsTagBudget, tagBudgetFull, confirmsDescription, defaultDescription, confirmsItem, detailRouteId, imageDetailColumns, itemDetailColumns, itemFactColumns, moreFields,
  parseImageBaseline, parseItemBaseline, prepareDescriptionAttempt, prepareGarmentAttempt, prepareItemAttempt, validDescription,
  validItemFields, visibleFields, warmthOptions,
} from '../../src/domain/item-details';
import { editGarmentField, garmentFields, newGarmentDraft } from '../../src/domain/garment-fields';
import { colours } from '../../src/domain/preferences';
import { loadItemDetail, saveImageDescription, saveItemFields } from '../../src/data/item-details';
import { maximumFieldRevision } from '../../src/domain/attribute-provenance';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const id = '20000000-0000-4000-8000-00000000000a';
const imageId = '30000000-0000-4000-8000-000000000001';
const scope = (): OwnerScope => ({ ownerId: owner, epoch: 4, signal: new AbortController().signal });
function item(overrides: Record<string, unknown> = {}) {
  return { ...Object.fromEntries(itemFactColumns.map((key) => [key, null])),
    id, owner_id: owner, title: 'Old name', category: 'top', version: 7, deleted_at: null,
    field_provenance: { warmth: { kind: 'unknown', revision: 2 }, title: { kind: 'user', revision: 3 } },
    warmth: 2, colours: ['green'], notes: 'Literal <script> text', created_at: '2026-09-09T00:00:00Z',
    seasons: [], style_tags: [], tags: [], currency: 'EUR', favourite: false, availability: 'ready',
    lifecycle: 'active', exclude_suggestions: false, wear_more: false,
    updated_at: '2026-09-09T00:00:00Z', ...overrides };
}
function image(overrides: Record<string, unknown> = {}) {
  return { id: imageId, owner_id: owner, item_id: id, alt_text: 'Old description', description_version: 3,
    state: 'ready', retired_at: null, main_path: `${owner}/${id}/${imageId}/main.jpg`,
    thumb_path: `${owner}/${id}/${imageId}/thumb.jpg`, ...overrides };
}
const baseline = () => parseItemBaseline(item(), owner, id);
const photo = () => parseImageBaseline(image(), owner, id);
const attempted = () => prepareItemAttempt(baseline(), 'New name', 'bottom', 4);
function serverItem() {
  const attempt = attempted();
  return item({ ...attempt.patch, version: 8, updated_at: '2026-09-09T00:01:00Z' });
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function client(fetcher: (url: URL, init: RequestInit | undefined) => Promise<Response>) {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => fetcher(new URL(String(input)), init));
  const value = createClient<Database>('http://127.0.0.1:54321', 'browser-fixture-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  return { value, fetch };
}
describe('simplified form over the full saved row (UX L1a)', () => {
  const hidden = {
    min_temp: -5, max_temp: 25, rain_rating: 1, windproof: true, upper_coverage: 2, lower_coverage: 1,
    sleeve_length: 'long', garment_length: 'regular', currency: 'USD', lifecycle: 'archived', availability: 'laundry',
    exclude_suggestions: true, wear_more: true, style_tags: ['relaxed'],
  };
  const provenance = {
    title: { kind: 'user', revision: 3 }, sleeve_length: { kind: 'ai_observed', revision: 1 },
    min_temp: { kind: 'user', revision: 2 }, upper_coverage: { kind: 'unknown', revision: 1 },
    style_tags: { kind: 'ai_estimated', revision: 1 }, warmth: { kind: 'unknown', revision: 2 },
  };
  it('partitions shown fields and leaves every other column unrendered', () => {
    const shown = new Set<string>([...visibleFields, ...moreFields]);
    expect(visibleFields).toEqual(['title', 'category', 'colours', 'seasons']);
    expect(garmentFields.filter((field) => !shown.has(field)).sort()).toEqual([
      'availability', 'currency', 'exclude_suggestions', 'garment_length', 'lifecycle', 'lower_coverage', 'max_temp',
      'min_temp', 'rain_rating', 'sleeve_length', 'style_tags', 'upper_coverage', 'wear_more', 'windproof']);
  });
  it('sends only the edited name and keeps every hidden value and provenance entry exactly', () => {
    const base = parseItemBaseline(item({ ...hidden, field_provenance: provenance }), owner, id);
    const draft = editGarmentField(newGarmentDraft(base.values.currency, 'en', base.values), 'title', 'Renamed', 'en');
    const attempt = prepareGarmentAttempt(base, draft, 4);
    expect(Object.keys(attempt.patch).sort()).toEqual(['field_provenance', 'title']);
    expect(attempt.patch.field_provenance).toEqual({ ...provenance, title: { kind: 'user', revision: 4 } });
    for (const [key, value] of Object.entries(hidden)) expect(attempt.fields[key as keyof typeof attempt.fields]).toEqual(value);
    expect(confirmsItem(parseItemBaseline(item({ ...hidden, ...attempt.patch, version: 8 }), owner, id), attempt)).toBe(true);
  });
  it.each([0, 1, 2, 3, 4])('keeps stored warmth %i on an untouched save and maps it to one of three options', (warmth) => {
    const base = parseItemBaseline(item({ warmth }), owner, id);
    const draft = editGarmentField(newGarmentDraft('EUR', 'en', base.values), 'title', 'Renamed', 'en');
    const attempt = prepareGarmentAttempt(base, draft, 4);
    expect(attempt.patch).not.toHaveProperty('warmth');
    expect(attempt.fields.warmth).toBe(warmth);
    const options = warmthOptions(String(warmth));
    expect(options.map(([, key]) => key)).toEqual(['warmth.light', 'warmth.medium', 'warmth.warm']);
    expect(options.filter(([value]) => value === String(warmth)).map(([, key]) => key))
      .toEqual([warmth < 2 ? 'warmth.light' : warmth === 2 ? 'warmth.medium' : 'warmth.warm']);
  });
  it('maps new warmth choices to 1, 2 and 3', () => {
    expect(warmthOptions('').map(([value]) => value)).toEqual(['1', '2', '3']);
  });
  it('adds new tags to tags only, refusing duplicates across both lists and respecting limits', () => {
    expect(addTag('  Linen  ', ['work'], ['relaxed'])).toEqual({ status: 'added', tags: ['work', 'Linen'] });
    expect(addTag('RELAXED', [], ['relaxed'])).toEqual({ status: 'duplicate' });
    expect(addTag('Work', ['work'], [])).toEqual({ status: 'duplicate' });
    expect(addTag(' ', [], [])).toEqual({ status: 'empty' });
    expect(addTag('x'.repeat(41), [], [])).toEqual({ status: 'invalid' });
    expect(addTag('x'.repeat(40), [], [])).toEqual({ status: 'added', tags: ['x'.repeat(40)] });
    expect(addTag('new', Array.from({ length: 12 }, (_, index) => `t${index}`), [])).toEqual({ status: 'full' });
    expect(addTag('ä'.repeat(20), Array.from({ length: 6 }, (_, index) => 'ä'.repeat(39) + index), []))
      .toEqual({ status: 'full' });
  });
  it('shares one count and byte budget across tags and style words (R4)', () => {
    const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    expect(addTag('new', names('t', 10), names('s', 1))).toEqual({ status: 'added', tags: [...names('t', 10), 'new'] });
    expect(addTag('new', names('t', 11), names('s', 1))).toEqual({ status: 'full' });
    expect(addTag('new', names('t', 4), names('s', 8))).toEqual({ status: 'full' });
    expect(tagBudgetFull(names('t', 10), names('s', 1))).toBe(false);
    expect(tagBudgetFull(names('t', 4), names('s', 8))).toBe(true);
    // 6 × 80-byte words + 5 commas = 485 bytes; one more comma leaves exactly 26 bytes.
    const wide = (count: number) => Array.from({ length: count }, (_, index) => 'ä'.repeat(39) + String.fromCharCode(0xe0 + index));
    const [tags, style] = [wide(3), wide(6).slice(3)];
    expect(fitsTagBudget([...tags, ...style, 'x'.repeat(26)])).toBe(true);
    expect(addTag('x'.repeat(26), tags, style)).toEqual({ status: 'added', tags: [...tags, 'x'.repeat(26)] });
    expect(addTag('x'.repeat(27), tags, style)).toEqual({ status: 'full' });
    expect(addTag('x'.repeat(27), tags, [])).toMatchObject({ status: 'added' });
  });
  it('leaves saved lists already over the combined budget unchanged and only refuses additions', () => {
    const tags = Object.freeze(Array.from({ length: 10 }, (_, index) => `t${index}`));
    const style = Object.freeze(Array.from({ length: 8 }, (_, index) => `s${index}`));
    expect(fitsTagBudget([...tags, ...style])).toBe(false);
    expect(addTag('new', tags, style)).toEqual({ status: 'full' });
    expect(tagBudgetFull(tags, style)).toBe(true);
    expect(tags).toHaveLength(10);
    expect(style).toHaveLength(8);
  });
});
describe('default photo description', () => {
  it('uses the name and only the first colour, when the name does not already mention it', () => {
    expect(defaultDescription('  Linen shirt ', ['blue', 'white'], 'en')).toBe('Linen shirt in blue');
    expect(defaultDescription('Blue linen shirt', ['blue', 'white'], 'en')).toBe('Blue linen shirt');
    expect(defaultDescription('Shirt', [], 'en')).toBe('Shirt');
    expect(defaultDescription('   ', ['blue'], 'en')).toBe('');
    expect(defaultDescription('Paita', ['blue', 'white'], 'fi')).toBe('Paita, väriltään sininen');
    expect(defaultDescription('Skjorta', ['blue', 'white'], 'sv')).toBe('Skjorta i blått');
    expect(defaultDescription('Gröna skor', ['green'], 'sv')).toBe('Gröna skor');
    expect(defaultDescription('Grönt helplagg', ['green'], 'sv')).toBe('Grönt helplagg');
    expect(defaultDescription('Vihreät kengät', ['green'], 'fi')).toBe('Vihreät kengät');
  });
  it('names the item naturally from the category and the first colour in each language (V1)', () => {
    expect(defaultItemName('top', ['green', 'navy'], 'en')).toBe('Green top');
    expect(defaultItemName('top', ['green', 'navy'], 'fi')).toBe('Vihreä yläosa');
    expect(defaultItemName('top', ['green', 'navy'], 'sv')).toBe('Grön överdel');
    expect(defaultItemName('footwear', ['black'], 'en')).toBe('Black shoes');
    expect(defaultItemName('footwear', ['black'], 'fi')).toBe('Mustat kengät');
    expect(defaultItemName('footwear', ['white'], 'sv')).toBe('Vita skor');
    expect(defaultItemName('one_piece', ['red'], 'sv')).toBe('Rött helplagg');
    expect(defaultItemName('outerwear', ['beige'], 'sv')).toBe('Beige ytterplagg');
    expect(defaultItemName('bottom', ['navy'], 'en')).toBe('Navy bottoms');
    expect(defaultItemName('top', [], 'sv')).toBe('Överdel');
    expect(defaultItemName(null, ['olive'], 'fi')).toBe('Oliivinvihreä');
    expect(defaultItemName(null, [], 'en')).toBe('');
    expect(defaultItemName('outerwear', ['burgundy'], 'en')).toBe('Burgundy outerwear');
    expect(defaultItemName('outerwear', ['burgundy'], 'fi')).toBe('Viininpunainen ulkovaate');
    expect(defaultItemName('outerwear', ['burgundy'], 'sv')).toBe('Vinrött ytterplagg');
    expect(defaultItemName('footwear', ['gold'], 'sv')).toBe('Guldfärgade skor');
    expect(defaultItemName('top', ['light_blue'], 'en')).toBe('Light blue top');
    expect(defaultItemName(null, ['teal'], 'fi')).toBe('Petroolinsininen');
    expect(colours).toHaveLength(21);
    for (const language of ['en', 'fi', 'sv'] as const) {
      for (const category of ['top', 'bottom', 'one_piece', 'footwear', 'layer', 'outerwear', 'accessory']) {
        for (const colour of colours) {
          const name = defaultItemName(category, [colour], language);
          expect(name).toMatch(/^\p{Lu}\S* \p{Ll}/u);
          expect(name).not.toMatch(/·|\{|\}/u);
          expect(defaultDescription(name, [colour], language)).toBe(name);
        }
      }
    }
  });
  it('stays within the description limit', () => {
    expect([...defaultDescription('x'.repeat(300), ['blue'], 'en')]).toHaveLength(240);
  });
});
describe('saved detail domain boundaries', () => {
  it('accepts only canonical complete UUID routes, keeping creation distinct', () => {
    expect(detailRouteId(`#/items/${id}`)).toBe(id);
    for (const suffix of ['new', id.toUpperCase(), id + '/', id + '?x=1', id + '#x', encodeURIComponent('/' + id), ' ' + id, '', '../' + id, id.slice(0, -1)]) {
      expect(detailRouteId('#/items/' + suffix)).toBeNull();
    }
    expect(detailRouteId('/items/' + id)).toBeNull();
  });
  it.each(['a', '🌿'])('validates the three saved fields in code points (%s) without creation fallback', (character) => {
    expect(validItemFields('  Å name 🌿  ', 'layer')).toEqual({ title: 'Å name 🌿', category: 'layer' });
    expect(validItemFields(character.repeat(100), 'top')).toEqual({ title: character.repeat(100), category: 'top' });
    for (const name of ['', '  ', character.repeat(101), 'a\0']) expect(validItemFields(name, 'top')).toBeNull();
    expect(validItemFields('Name', 'unknown')).toBeNull();
    expect(validDescription('  ')).toBe('');
    expect(validDescription('  Å 🌿 ')).toBe('Å 🌿');
    expect(validDescription(character.repeat(240))).toBe(character.repeat(240));
    expect(validDescription(character.repeat(241))).toBeNull();
    expect(validDescription('\0')).toBeNull();
  });
  it.each([60, 100])('accepts a stored %i-astral-character title and confirms an exact-limit edit', (length) => {
    const base = parseItemBaseline(item({ title: '🌿'.repeat(length) }), owner, id);
    expect(base.title).toBe('🌿'.repeat(length));
    const attempt = prepareItemAttempt(base, '🍂'.repeat(100), 'top', 4);
    expect(attempt.fields.title).toBe('🍂'.repeat(100));
    expect(confirmsItem(parseItemBaseline(item({ ...attempt.patch, version: 8 }), owner, id), attempt)).toBe(true);
    expect(() => prepareItemAttempt(base, '🍂'.repeat(101), 'top', 4)).toThrow('detail.invalidFields');
  });
  it('edits a valid stored 240-astral-character description without losing text', () => {
    const base = parseImageBaseline(image({ alt_text: '🌿'.repeat(240) }), owner, id);
    expect(base.altText).toBe('🌿'.repeat(240));
    const attempt = prepareDescriptionAttempt(base, '🌿'.repeat(239) + '🍂', 4);
    expect(attempt.text).toBe('🌿'.repeat(239) + '🍂');
    expect(confirmsDescription(parseImageBaseline(image({ alt_text: attempt.text, description_version: 4 }), owner, id), attempt)).toBe(true);
    expect(base.altText).toBe('🌿'.repeat(240));
    expect(() => prepareDescriptionAttempt(base, '🌿'.repeat(241), 4)).toThrow('detail.invalidDescription');
  });
  it('freezes exact changed fields and preserves untouched values and provenance', () => {
    const base = baseline(), attempt = prepareItemAttempt(base, ' New name ', 'top', 4);
    expect(attempt.patch).toEqual({ title: 'New name', field_provenance: {
      warmth: { kind: 'unknown', revision: 2 }, title: { kind: 'user', revision: 4 },
    } });
    expect(attempt.baseline.facts).toEqual(base.facts);
    expect(base.provenance.title?.revision).toBe(3);
    expect(Object.isFrozen(attempt) && Object.isFrozen(attempt.baseline.facts) && Object.isFrozen(attempt.patch.field_provenance)).toBe(true);
    expect(attempted().patch.field_provenance.category).toEqual({ kind: 'user', revision: 1 });
    expect(() => prepareItemAttempt(base, base.title, base.category, 4)).toThrow();
  });
  it('refuses unsafe row and field revision increments without changing the baseline', () => {
    const ceiling = parseItemBaseline(item({ version: Number.MAX_SAFE_INTEGER }), owner, id);
    expect(() => prepareItemAttempt(ceiling, 'New name', 'top', 4)).toThrow();
    const maxField = parseItemBaseline(item({ field_provenance: { title: { kind: 'user', revision: maximumFieldRevision } } }), owner, id);
    expect(() => prepareItemAttempt(maxField, 'New name', 'top', 4)).toThrow('error.conflict');
    expect(prepareItemAttempt(maxField, maxField.title, 'bottom', 4).patch.field_provenance.title?.revision).toBe(maximumFieldRevision);
    expect(() => prepareDescriptionAttempt(photo(), photo().altText, 4)).toThrow();
    expect(() => prepareDescriptionAttempt({ ...photo(), version: maximumFieldRevision }, '', 4)).toThrow();
    expect(prepareDescriptionAttempt(photo(), '  ', 4).text).toBe('');
  });
  it.each([
    { owner_id: other }, { id: other }, { deleted_at: '2026-09-09' }, { version: 0 }, { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { title: '' }, { title: 'a'.repeat(101) }, { title: '🌿'.repeat(101) },
    { category: 'bad' }, { field_provenance: null },
    { colours: undefined }, { warmth: Infinity },
  ])('rejects malformed/unowned item baseline %j', (overrides) => {
    expect(() => parseItemBaseline(item(overrides), owner, id)).toThrow('detail.unavailable');
  });
  it.each([
    { owner_id: other }, { item_id: other }, { id: 'bad' }, { state: 'pending' }, { state: 'retired' },
    { retired_at: '2026-09-09' }, { description_version: 0 }, { description_version: 2147483648 },
    { description_version: 1.5 }, { alt_text: null }, { alt_text: 'a'.repeat(241) }, { main_path: 'https://example.test/photo.jpg' },
  ])('rejects incomplete/unowned image baseline %j', (overrides) => {
    expect(() => parseImageBaseline(image(overrides), owner, id)).toThrow('detail.unavailable');
  });
  it('requires exact next version, all intended fields and all untouched facts for confirmation', () => {
    const attempt = attempted();
    expect(confirmsItem(parseItemBaseline(serverItem(), owner, id), attempt)).toBe(true);
    for (const change of [{ version: 7 }, { version: 9 }, { title: 'Other' }, { category: 'top' },
      { warmth: 3 }, { notes: 'New note' }, { field_provenance: { ...attempt.patch.field_provenance, warmth: { kind: 'user', revision: 3 } } }]) {
      expect(confirmsItem(parseItemBaseline({ ...serverItem(), ...change }, owner, id), attempt)).toBe(false);
    }
    for (const field of itemFactColumns) {
      const row = parseItemBaseline(serverItem(), owner, id);
      expect(confirmsItem({ ...row, facts: { ...row.facts, [field]: 'different' } }, attempt)).toBe(false);
    }
    expect(confirmsItem({ ...baseline(), ownerId: other }, attempt)).toBe(false);
  });
  it('does not treat equal descriptions, later counters or replacement images as confirmation', () => {
    const attempt = prepareDescriptionAttempt(photo(), '', 4);
    const next = { ...photo(), altText: '', version: 4 };
    expect(confirmsDescription(next, attempt)).toBe(true);
    for (const change of [{ version: 3 }, { version: 5 }, { id: other }, { ownerId: other }, { itemId: other }, { mainPath: 'other' }, { altText: 'other' }]) {
      expect(confirmsDescription({ ...next, ...change }, attempt)).toBe(false);
    }
  });
});
describe('saved detail typed data contracts (mocked, not live RLS)', () => {
  it('reads only the owned nondeleted item and current ready image with explicit projections', async () => {
    const c = client(async (url) => {
      expect(url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
      if (url.pathname.endsWith('/items')) {
        expect(url.searchParams.get('id')).toBe(`eq.${id}`);
        expect(url.searchParams.get('deleted_at')).toBe('is.null');
        expect(url.searchParams.get('select')).toBe(itemDetailColumns);
        return response(item());
      }
      expect(url.searchParams.get('item_id')).toBe(`eq.${id}`);
      expect(url.searchParams.get('state')).toBe('eq.ready');
      expect(url.searchParams.get('retired_at')).toBe('is.null');
      expect(url.searchParams.get('select')).toBe(imageDetailColumns);
      return response([image()]);
    });
    expect(await loadItemDetail(c.value, scope(), id)).toEqual({ item: baseline(), image: photo() });
    expect(c.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([[], [image(), image()], [image({ state: 'pending' })]].map((rows) => ({ rows })))('does not expose incomplete or ambiguous images', async ({ rows }) => {
    const c = client(async (url) => response(url.pathname.endsWith('/items') ? item() : rows));
    await expect(loadItemDetail(c.value, scope(), id)).rejects.toThrow('detail.unavailable');
  });
  it('sends only changed item fields and provenance with exact CAS predicates', async () => {
    const s = scope(), attempt = attempted();
    const c = client(async (url, init) => {
      expect(init?.method).toBe('PATCH');
      expect(init?.signal).toBe(s.signal);
      expect(url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
      expect(url.searchParams.get('id')).toBe(`eq.${id}`);
      expect(url.searchParams.get('version')).toBe('eq.7');
      expect(url.searchParams.get('deleted_at')).toBe('is.null');
      expect(JSON.parse(String(init?.body))).toEqual(attempt.patch);
      return response(serverItem());
    });
    expect(confirmsItem(await saveItemFields(c.value, s, attempt), attempt)).toBe(true);
    expect(c.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [null, 'error.conflict'], [{ ...serverItem(), owner_id: other }, 'detail.unconfirmed'],
    [{ ...serverItem(), version: 9 }, 'detail.unconfirmed'], [{ ...serverItem(), warmth: 4 }, 'detail.unconfirmed'],
    [{ ...serverItem(), field_provenance: {} }, 'detail.unconfirmed'], [[], 'error.conflict'],
  ])('never retries an ambiguous or conflicting item response', async (body, key) => {
    const c = client(async () => response(body));
    await expect(saveItemFields(c.value, scope(), attempted())).rejects.toThrow(String(key));
    expect(c.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ code: '22023', message: 'Request conflict' }, 400, 'error.conflict'],
    [{ code: '42501', message: 'Private SQL detail' }, 403, 'detail.rejected'],
    [{ code: '22023', message: 'Invalid input' }, 400, 'detail.rejected'],
    [{ message: 'Private upstream failure' }, 503, 'detail.unconfirmed'],
  ])('maps errors to safe definitive or uncertain states', async (body, status, key) => {
    const c = client(async () => response(body, Number(status)));
    await expect(saveItemFields(c.value, scope(), attempted())).rejects.toThrow(String(key));
    expect(c.fetch).toHaveBeenCalledTimes(1);
  });
  it('uses only the three generated RPC arguments and validates its narrow response', async () => {
    const attempt = prepareDescriptionAttempt(photo(), '  ', 4);
    const c = client(async (url, init) => {
      expect(url.pathname).toBe('/rest/v1/rpc/update_image_description');
      expect(JSON.parse(String(init?.body))).toEqual({ p_image_id: imageId, p_expected_description_version: 3, p_alt_text: '' });
      return response([{ id: imageId, owner_id: owner, item_id: id, alt_text: '', description_version: 4 }]);
    });
    expect(confirmsDescription(await saveImageDescription(c.value, scope(), attempt), attempt)).toBe(true);
    expect(c.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([null, [], [{ id: imageId, owner_id: owner, item_id: id, alt_text: '', description_version: 3 }],
    [{ id: imageId, owner_id: owner, item_id: id, alt_text: '', description_version: 5 }],
    [{ id: imageId, owner_id: other, item_id: id, alt_text: '', description_version: 4 }],
    [{ id: imageId, owner_id: owner, item_id: id, alt_text: '', description_version: 4, extra: true }],
  ].map((body) => ({ body })))('does not confirm malformed, stale or foreign RPC data', async ({ body }) => {
    const c = client(async () => response(body));
    await expect(saveImageDescription(c.value, scope(), prepareDescriptionAttempt(photo(), '', 4))).rejects.toThrow('detail.unconfirmed');
    expect(c.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses wrong owner/epoch and aborted operations before requesting', async () => {
    const c = client(async () => response(null));
    for (const s of [{ ...scope(), ownerId: other }, { ...scope(), epoch: 5 }, { ...scope(), signal: AbortSignal.abort() }]) {
      await expect(saveItemFields(c.value, s, attempted())).rejects.toThrow();
      await expect(saveImageDescription(c.value, s, prepareDescriptionAttempt(photo(), '', 4))).rejects.toThrow();
    }
    await expect(loadItemDetail(c.value, scope(), 'bad')).rejects.toThrow();
    expect(c.fetch).not.toHaveBeenCalled();
  });
  it('keeps transport failure uncertain and ignores late success after abort', async () => {
    const failure = client(async () => { throw new TypeError('Private transport detail'); });
    await expect(saveItemFields(failure.value, scope(), attempted())).rejects.toThrow('detail.unconfirmed');
    const controller = new AbortController();
    const c = client(async () => { controller.abort(); return response(serverItem()); });
    await expect(saveItemFields(c.value, { ...scope(), signal: controller.signal }, attempted())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
