import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import {
  classifySaveError, compareSaved, componentLabel, componentMeta, confirmsVersion, draftFromRecord, emptyDraft, hasGap, isOutfitRoute,
  leaveDialogFor, matchesPayload, missingComponent, moveDown, moveUp, navFamilyFor, occasionLabel, outfitColumns, outfitRouteId,
  parseComponents, parseOutfitRow, remove, sameDraft, saveArguments, toggle, validateDraft, type OutfitComponent, type OutfitRecord, type SaveAttempt,
} from '../../src/domain/outfits';
import { loadOutfit, loadOutfits, rereadSave, saveOutfit } from '../../src/data/outfits';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const outfitId = '3333aaaa-3333-4333-8333-33333333abcd';
const itemIds = ['4444aaaa-4444-4444-8444-44444444abc1', '44444444-4444-4444-8444-444444444442', '44444444-4444-4444-8444-444444444443'];
const imageId = '55555555-5555-4555-8555-555555555555';
const payload = { title: 'Friday', occasion: 'smart', notes: '', favourite: false, itemIds: [itemIds[0]!, itemIds[1]!] };
const create: SaveAttempt = { kind: 'create', id: outfitId, payload, baselineVersion: null, ownerId: owner, epoch: 2 };
const edit: SaveAttempt = { ...create, kind: 'edit', baselineVersion: 3 };

function row(extra: Record<string, unknown> = {}) {
  return {
    id: outfitId, owner_id: owner, title: 'Friday', occasion: 'smart', notes: '', favourite: false, deleted_at: null, version: 1,
    created_at: '2026-09-11T10:00:00.000000+00:00',
    outfit_items: [{ owner_id: owner, item_id: itemIds[1], position: 1 }, { owner_id: owner, item_id: itemIds[0], position: 0 }], ...extra,
  };
}
const record = (extra: Record<string, unknown> = {}): OutfitRecord => parseOutfitRow(row(extra), owner);
const current = (id: string): OutfitComponent => ({ id, state: 'current', title: 'Shirt', category: 'top', colour: 'olive', lifecycle: 'active', thumbPath: null, altText: '' });
const components = new Map(itemIds.map(id => [id, current(id)]));

describe('I11 outfit drafts', () => {
  it('requires a trimmed name and at least one item, and bounds lengths only at Save', () => {
    expect(validateDraft(emptyDraft(), components)).toEqual({ errors: { title: 'outfits.nameRequired', items: 'outfits.chooseAtLeastOne' } });
    expect(validateDraft({ ...emptyDraft(), title: '   ', itemIds: [itemIds[0]!] }, components)).toEqual({ errors: { title: 'outfits.nameRequired' } });
    expect(validateDraft({ ...emptyDraft(), title: 'x'.repeat(101), notes: 'n'.repeat(2001), itemIds: [itemIds[0]!] }, components))
      .toEqual({ errors: { title: 'outfits.nameTooLong', notes: 'outfits.notesTooLong' } });
    expect(validateDraft({ ...emptyDraft(), title: '👕'.repeat(100), notes: ' kept ', itemIds: [itemIds[0]!] }, components))
      .toEqual({ payload: { title: '👕'.repeat(100), occasion: 'everyday', notes: 'kept', favourite: false, itemIds: [itemIds[0]] } });
  });
  it('rejects duplicate, malformed, too many or unavailable items and keeps a custom occasion', () => {
    const base = { ...emptyDraft(), title: 'A' };
    expect(validateDraft({ ...base, itemIds: [itemIds[0]!, itemIds[0]!] }, components)).toEqual({ errors: { items: 'outfits.invalidSelection' } });
    expect(validateDraft({ ...base, itemIds: [itemIds[0]!.toUpperCase()] }, components)).toEqual({ errors: { items: 'outfits.invalidSelection' } });
    expect(validateDraft({ ...base, itemIds: Array.from({ length: 13 }, (_, n) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`) }, components))
      .toEqual({ errors: { items: 'outfits.limit' } });
    const gone = new Map(components); gone.set(itemIds[2]!, missingComponent(itemIds[2]!));
    expect(validateDraft({ ...base, itemIds: [itemIds[2]!] }, gone)).toEqual({ errors: { items: 'outfits.removeUnavailable' } });
    expect(validateDraft({ ...base, itemIds: ['44444444-4444-4444-8444-000000000009'] }, components)).toEqual({ errors: { items: 'outfits.removeUnavailable' } });
    const trashed = new Map(components); trashed.set(itemIds[0]!, { ...current(itemIds[0]!), state: 'trashed' });
    expect('payload' in validateDraft({ ...base, itemIds: [itemIds[0]!] }, trashed)).toBe(true);
    expect(validateDraft({ ...base, occasion: 'Wedding', itemIds: [itemIds[0]!] }, components)).toMatchObject({ payload: { occasion: 'Wedding' } });
  });
  it('toggles up to twelve items and moves or removes by position', () => {
    const twelve = Array.from({ length: 12 }, (_, n) => `id-${n}`);
    expect(toggle(twelve, 'id-12')).toEqual({ ids: twelve, limited: true });
    expect(toggle(twelve, 'id-3').ids).toHaveLength(11);
    expect(toggle([], 'a')).toEqual({ ids: ['a'], limited: false });
    expect(moveUp(['a', 'b', 'c'], 2)).toEqual(['a', 'c', 'b']);
    expect(moveUp(['a', 'b'], 0)).toEqual(['a', 'b']);
    expect(moveDown(['a', 'b', 'c'], 0)).toEqual(['b', 'a', 'c']);
    expect(moveDown(['a', 'b'], 1)).toEqual(['a', 'b']);
    expect(remove(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('compares drafts by value and order', () => {
    const draft = draftFromRecord(record());
    expect(draft.itemIds).toEqual([itemIds[0], itemIds[1]]);
    expect(sameDraft(draft, { ...draft, itemIds: [...draft.itemIds] })).toBe(true);
    expect(sameDraft(draft, { ...draft, itemIds: [...draft.itemIds].reverse() })).toBe(false);
    expect(sameDraft(draft, { ...draft, favourite: true })).toBe(false);
  });
});

describe('I11 outfit rows', () => {
  it('parses owned rows, orders links by position and detects gaps', () => {
    const parsed = record();
    expect(parsed.links.map(link => link.itemId)).toEqual([itemIds[0], itemIds[1]]);
    expect(hasGap(parsed)).toBe(false);
    expect(hasGap(record({ outfit_items: [{ owner_id: owner, item_id: itemIds[0], position: 0 }, { owner_id: owner, item_id: itemIds[1], position: 2 }] }))).toBe(true);
    expect(outfitColumns).toContain('outfit_items!outfit_items_owner_id_outfit_id_fkey(owner_id,item_id,position)');
  });
  it.each([
    ['foreign owner', { owner_id: other }],
    ['foreign link owner', { outfit_items: [{ owner_id: other, item_id: itemIds[0], position: 0 }] }],
    ['uppercase id', { id: outfitId.toUpperCase() }],
    ['empty title', { title: '' }],
    ['long title', { title: 'x'.repeat(101) }],
    ['nul notes', { notes: 'a\0b' }],
    ['zero version', { version: 0 }],
    ['text version', { version: '1' }],
    ['duplicate item', { outfit_items: [{ owner_id: owner, item_id: itemIds[0], position: 0 }, { owner_id: owner, item_id: itemIds[0], position: 1 }] }],
    ['duplicate position', { outfit_items: [{ owner_id: owner, item_id: itemIds[0], position: 0 }, { owner_id: owner, item_id: itemIds[1], position: 0 }] }],
    ['position out of range', { outfit_items: [{ owner_id: owner, item_id: itemIds[0], position: 12 }] }],
    ['missing links', { outfit_items: null }],
  ])('rejects a row with %s', (_, extra) => {
    expect(() => record(extra)).toThrow('Invalid outfit.');
  });
  it('parses components, marks missing ones and rejects foreign or mismatched rows', () => {
    const items = [
      { id: itemIds[0], owner_id: owner, title: 'Shirt', category: 'top', colours: ['olive'], deleted_at: null, lifecycle: 'active' },
      { id: itemIds[1], owner_id: owner, title: 'Coat', category: 'outerwear', colours: [], deleted_at: '2026-09-01T00:00:00Z', lifecycle: 'active' },
    ];
    const images = [{ id: imageId, owner_id: owner, item_id: itemIds[0], state: 'ready', alt_text: 'Shirt', main_path: `${owner}/${itemIds[0]}/${imageId}/main.jpg`, thumb_path: `${owner}/${itemIds[0]}/${imageId}/thumb.jpg` }];
    const parsed = parseComponents(itemIds, items, images, owner);
    expect(parsed.get(itemIds[0]!)).toMatchObject({ state: 'current', colour: 'olive', thumbPath: `${owner}/${itemIds[0]}/${imageId}/thumb.jpg` });
    expect(parsed.get(itemIds[1]!)).toMatchObject({ state: 'trashed', colour: null, thumbPath: null });
    expect(parsed.get(itemIds[2]!)).toEqual(missingComponent(itemIds[2]!));
    expect(() => parseComponents(itemIds, [{ ...items[0], owner_id: other }], [], owner)).toThrow();
    expect(() => parseComponents(itemIds, items, [{ ...images[0], owner_id: other }], owner)).toThrow();
    expect(() => parseComponents(itemIds, items, [{ ...images[0], thumb_path: `${other}/${itemIds[0]}/${imageId}/thumb.jpg` }], owner)).toThrow();
    expect(() => parseComponents([itemIds[2]!], items, [], owner)).toThrow();
  });
  it('labels component state and meta with typed keys', () => {
    expect(componentLabel(current(itemIds[0]!))).toBeNull();
    expect(componentLabel({ ...current(itemIds[0]!), state: 'trashed' })).toBe('outfits.inTrash');
    expect(componentLabel(missingComponent(itemIds[0]!))).toBe('outfits.unavailableItem');
    expect(componentLabel({ ...current(itemIds[0]!), state: 'archived', lifecycle: 'sold' })).toBe('lifecycle.sold');
    expect(componentLabel({ ...current(itemIds[0]!), state: 'archived', lifecycle: 'archived' })).toBe('detail.archived');
    expect(componentMeta('footwear', 'white')).toEqual({ category: 'categoryOne.footwear', colour: 'colour.white' });
    expect(componentMeta('top', 'unknown')).toEqual({ category: 'categoryOne.top', colour: null });
    expect(occasionLabel({ occasion: 'smart' })).toBe('occasion.smart');
    expect(occasionLabel({ occasion: 'Wedding' })).toBeNull();
  });
});

describe('I11 routes and leave dialogs', () => {
  it('accepts only lowercase UUID outfit routes', () => {
    expect(outfitRouteId(outfitId)).toBe(outfitId);
    expect(outfitRouteId(outfitId.toUpperCase())).toBeNull();
    expect(outfitRouteId('new')).toBeNull();
  });
  it('maps routes to the header and never uses the shared discard dialog for outfits', () => {
    for (const route of ['outfits', 'outfit-new', `outfit:${outfitId}`]) {
      expect(isOutfitRoute(route)).toBe(true); expect(navFamilyFor(route)).toBe('outfits'); expect(leaveDialogFor(route)).toBe('outfit');
    }
    for (const route of ['wardrobe', 'add', `detail:${itemIds[0]}`]) { expect(navFamilyFor(route)).toBe('wardrobe'); expect(leaveDialogFor(route)).toBe('discard'); }
    for (const route of ['settings', 'trash']) expect(navFamilyFor(route)).toBeNull();
  });
});

describe('I11 save arguments and unknown results', () => {
  it('sends six create keys and seven edit keys', () => {
    expect(Object.keys(saveArguments(create)).sort()).toEqual(['p_favourite', 'p_id', 'p_item_ids', 'p_notes', 'p_occasion', 'p_title']);
    expect(saveArguments(edit)).toMatchObject({ p_id: outfitId, p_expected_version: 3, p_item_ids: payload.itemIds });
    expect(Object.keys(saveArguments(edit))).toHaveLength(7);
  });
  it('confirms only the exact next version as a number', () => {
    expect(confirmsVersion(create, 1)).toBe(true);
    expect(confirmsVersion(create, null)).toBe(false);
    expect(confirmsVersion(create, '1')).toBe(false);
    expect(confirmsVersion(create, 2)).toBe(false);
    expect(confirmsVersion(edit, 4)).toBe(true);
    expect(confirmsVersion(edit, 2)).toBe(false);
    expect(confirmsVersion({ ...edit, baselineVersion: 1 }, 4)).toBe(false);
  });
  it('treats only definitive database rejections as known', () => {
    expect(classifySaveError({ code: 'P0001', message: 'Invalid selection' })).toBe('invalidSelection');
    expect(classifySaveError({ code: 'P0001', message: 'Request conflict' })).toBe('changed');
    expect(classifySaveError({ code: '23505', message: 'duplicate' })).toBe('changed');
    for (const code of ['42501', '23514', '23502', '23503', 'PGRST301', 'PGRST302']) expect(classifySaveError({ code })).toBe('rejected');
    for (const error of [{ code: 'P0001', message: 'Other' }, { code: '22023' }, { code: 'PGRST000' }, { code: '' }, null, 'boom'])
      expect(classifySaveError(error)).toBe('unknown');
  });
  it('treats every 5xx reply as unknown before reading its code', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      for (const code of ['42501', '23514', '23503', '23505', 'PGRST301', 'P0001']) expect(classifySaveError({ code, message: 'Invalid selection' }, status)).toBe('unknown');
    }
    expect(classifySaveError({ code: '42501' }, 403)).toBe('rejected');
    expect(classifySaveError({ code: '23505' }, 409)).toBe('changed');
    // A create whose ID is already taken (by this or another account) now returns the normalized conflict body.
    expect(classifySaveError({ code: 'P0001', details: null, hint: null, message: 'Request conflict' }, 400)).toBe('changed');
    expect(classifySaveError({ code: 'P0001', message: 'Invalid selection' }, 400)).toBe('invalidSelection');
  });
  it('decides a create from one reread', () => {
    expect(compareSaved(create, null)).toBe('notSaved');
    expect(compareSaved(create, record())).toBe('saved');
    expect(compareSaved(create, record({ version: 2 }))).toBe('changed');
    expect(compareSaved(create, record({ title: 'Other' }))).toBe('changed');
    expect(compareSaved(create, record({ deleted_at: '2026-09-11T11:00:00Z' }))).toBe('gone');
  });
  it('decides an edit from one reread', () => {
    expect(compareSaved(edit, null)).toBe('gone');
    expect(compareSaved(edit, record({ version: 3 }))).toBe('notSaved');
    expect(compareSaved(edit, record({ version: 4 }))).toBe('saved');
    expect(compareSaved(edit, record({ version: 4, notes: 'x' }))).toBe('changed');
    expect(compareSaved(edit, record({ version: 5 }))).toBe('changed');
    expect(compareSaved(edit, record({ version: 4, deleted_at: '2026-09-11T11:00:00Z' }))).toBe('gone');
    expect(matchesPayload(record(), { ...payload, itemIds: [...payload.itemIds].reverse() })).toBe(false);
  });
});

describe('I11 data requests', () => {
  function fake(handler: (url: URL, init: RequestInit) => Response) {
    const calls: { url: URL; method: string; body: unknown }[] = [];
    const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      return handler(url, init);
    };
    const client = createClient<Database>('http://127.0.0.1:54321', 'sb_publishable_unit', { auth: { persistSession: false }, global: { fetch } });
    return { client, calls };
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const scope = (epoch = 2): OwnerScope => ({ ownerId: owner, epoch, signal: new AbortController().signal });

  it('lists owner outfits newest first and rejects foreign rows', async () => {
    const api = fake(() => json([row()]));
    expect((await loadOutfits(api.client, scope(), new AbortController().signal)).map(value => value.id)).toEqual([outfitId]);
    const query = api.calls[0]!.url.searchParams;
    expect([query.get('owner_id'), query.get('deleted_at'), query.get('order'), query.get('limit')]).toEqual([`eq.${owner}`, 'is.null', 'created_at.desc,id.desc', '500']);
    await expect(loadOutfits(fake(() => json([row({ owner_id: other })])).client, scope(), new AbortController().signal)).rejects.toThrow('error.unavailable');
  });
  it('reads one outfit by owner and id without filtering deleted rows', async () => {
    const api = fake(() => json(row({ deleted_at: '2026-09-11T11:00:00Z' })));
    expect(await loadOutfit(api.client, scope(), outfitId, new AbortController().signal)).toMatchObject({ deletedAt: '2026-09-11T11:00:00Z' });
    const query = api.calls[0]!.url.searchParams;
    expect([query.get('owner_id'), query.get('id'), query.has('deleted_at')]).toEqual([`eq.${owner}`, `eq.${outfitId}`, false]);
    expect(await loadOutfit(api.client, scope(), 'not-an-id', new AbortController().signal)).toBeNull();
    expect(api.calls).toHaveLength(1);
  });
  it('saves through the RPC and classifies replies without resending', async () => {
    const saved = fake(() => json(1));
    expect(await saveOutfit(saved.client, scope(), create, new AbortController().signal)).toEqual({ kind: 'saved', version: 1 });
    expect(saved.calls[0]).toMatchObject({ method: 'POST', body: saveArguments(create) });
    expect(saved.calls[0]!.url.pathname).toBe('/rest/v1/rpc/save_outfit');
    expect(await saveOutfit(fake(() => json('1')).client, scope(), create, new AbortController().signal)).toEqual({ kind: 'unknown' });
    expect(await saveOutfit(fake(() => json({ message: 'Unavailable' }, 503)).client, scope(), create, new AbortController().signal)).toEqual({ kind: 'unknown' });
    for (const status of [500, 502, 503, 504])
      expect(await saveOutfit(fake(() => json({ code: '42501', message: 'permission denied' }, status)).client, scope(), create, new AbortController().signal)).toEqual({ kind: 'unknown' });
    expect(await saveOutfit(fake(() => json({ code: '42501', message: 'permission denied' }, 403)).client, scope(), create, new AbortController().signal)).toEqual({ kind: 'rejected' });
    expect(await saveOutfit(fake(() => json({ code: 'P0001', message: 'Request conflict' }, 400)).client, scope(), edit, new AbortController().signal)).toEqual({ kind: 'changed' });
    const broken = fake(() => { throw new TypeError('Failed to fetch'); });
    expect(await saveOutfit(broken.client, scope(), create, new AbortController().signal)).toEqual({ kind: 'unknown' });
    expect(broken.calls).toHaveLength(1);
  });
  it('drops results for another owner epoch', async () => {
    await expect(saveOutfit(fake(() => json(1)).client, scope(3), create, new AbortController().signal)).rejects.toThrow('Cancelled');
  });
  it('rereads read-only after an unknown result', async () => {
    const api = fake(() => json(null));
    expect(await rereadSave(api.client, scope(), create, new AbortController().signal)).toEqual({ outcome: 'notSaved', record: null });
    expect(api.calls.map(call => call.method)).toEqual(['GET']);
  });
});
