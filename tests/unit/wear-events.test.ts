import { describe, expect, it } from 'vitest';
import type { AppClient } from '../../src/data/client';
import { createLook, pendingCreate } from '../../src/data/wear-events';
import {
  canMarkWorn, classifyWearError, compareLook, compareRemoval, confirmsWear, parseLook, stateAttempt, validateLook, wearArguments,
  type Look, type LookAttempt,
} from '../../src/domain/wear-events';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const eventId = '30000000-0000-4000-8000-000000000003';
const itemA = '40000000-0000-4000-8000-000000000004';
const itemB = '50000000-0000-4000-8000-000000000005';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: eventId, owner_id: owner, outfit_id: null, local_date: '2026-09-16', timezone: 'Europe/Helsinki', state: 'planned',
    label: 'Morning walk', deleted_at: null, version: 2, created_at: '2026-09-15T08:00:00Z',
    wear_event_items: [
      { id: '60000000-0000-4000-8000-000000000006', owner_id: owner, event_id: eventId, item_id: itemB, title_snapshot: 'Trousers', category_snapshot: 'bottom' },
      { id: '70000000-0000-4000-8000-000000000007', owner_id: owner, event_id: eventId, item_id: itemA, title_snapshot: 'Blue top', category_snapshot: 'top' },
    ],
    ...overrides,
  };
}
const look = (overrides: Record<string, unknown> = {}): Look => parseLook(row(overrides), owner);
const attempt = (overrides: Partial<LookAttempt> = {}): LookAttempt => ({
  id: eventId, localDate: '2026-09-16', timezone: 'Europe/Helsinki', state: 'worn', label: 'Morning walk', outfitId: null,
  itemIds: [itemA, itemB], baselineVersion: 2, ownerId: owner, epoch: 1, ...overrides,
});

describe('looks', () => {
  it('parses an owned look and sorts its pieces by title', () => {
    const value = look();
    expect(value.pieces.map(piece => piece.title)).toEqual(['Blue top', 'Trousers']);
    expect(value.state).toBe('planned');
  });

  it('rejects rows from another account and malformed links', () => {
    expect(() => parseLook(row({ owner_id: other }), owner)).toThrow();
    expect(() => parseLook(row({ local_date: '2026-02-30' }), owner)).toThrow();
    expect(() => parseLook(row({ state: 'maybe' }), owner)).toThrow();
    expect(() => parseLook(row({ wear_event_items: [{ ...row().wear_event_items[0], owner_id: other }] }), owner)).toThrow();
    expect(() => parseLook(row({ wear_event_items: [{ ...row().wear_event_items[0], event_id: other }] }), owner)).toThrow();
  });

  it('keeps a deleted garment’s snapshot without an item to send', () => {
    const value = look({ wear_event_items: [{ ...row().wear_event_items[0], item_id: null }] });
    expect(value.pieces[0]!.itemId).toBeNull();
    expect(canMarkWorn(value, '2026-09-16')).toBe(false);
    expect(stateAttempt(value, 'worn', 1).itemIds).toEqual([]);
  });

  it('only marks planned looks on or before today as worn', () => {
    expect(canMarkWorn(look(), '2026-09-16')).toBe(true);
    expect(canMarkWorn(look(), '2026-09-15')).toBe(false);
    expect(canMarkWorn(look({ state: 'worn' }), '2026-09-20')).toBe(false);
  });

  it('keeps the look’s own date and time zone when its state changes', () => {
    const value = stateAttempt(look({ timezone: 'Europe/Stockholm' }), 'worn', 3);
    expect(value).toMatchObject({ localDate: '2026-09-16', timezone: 'Europe/Stockholm', state: 'worn', baselineVersion: 2, epoch: 3 });
    expect(value.itemIds).toEqual([itemA, itemB]);
  });
});

describe('look validation', () => {
  const draft = { localDate: '2026-09-16', label: '  Walk ', outfitId: null, itemIds: [itemA] };
  it('accepts and trims a valid look', () => {
    expect(validateLook(draft)).toEqual({ value: { ...draft, label: 'Walk' } });
  });
  it('reports each problem', () => {
    expect(validateLook({ ...draft, localDate: '' })).toEqual({ errors: { date: 'calendar.dateRequired' } });
    expect(validateLook({ ...draft, label: ' ' })).toEqual({ errors: { label: 'outfits.nameRequired' } });
    expect(validateLook({ ...draft, label: 'x'.repeat(101) })).toEqual({ errors: { label: 'outfits.nameTooLong' } });
    expect(validateLook({ ...draft, itemIds: [] })).toEqual({ errors: { items: 'outfits.chooseAtLeastOne' } });
    expect(validateLook({ ...draft, itemIds: Array.from({ length: 13 }, (_, index) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`) }))
      .toEqual({ errors: { items: 'outfits.limit' } });
    expect(validateLook({ ...draft, itemIds: [itemA, itemA] })).toEqual({ errors: { items: 'outfits.invalidSelection' } });
    expect(validateLook({ ...draft, itemIds: ['4000000a-0000-4000-8000-00000000000a'.toUpperCase()] })).toEqual({ errors: { items: 'outfits.invalidSelection' } });
  });
});

describe('save_wear_event arguments and replies', () => {
  it('omits the expected version when creating a look', () => {
    const create = wearArguments(attempt({ baselineVersion: null, state: 'planned' }));
    expect(create).not.toHaveProperty('p_expected_version');
    expect(create).toMatchObject({ p_id: eventId, p_outfit_id: null, p_item_ids: [itemA, itemB], p_state: 'planned' });
    expect(wearArguments(attempt())).toMatchObject({ p_expected_version: 2 });
  });

  it('confirms only the next version', () => {
    expect(confirmsWear(attempt(), 3)).toBe(true);
    expect(confirmsWear(attempt(), 2)).toBe(false);
    expect(confirmsWear(attempt({ baselineVersion: null }), 1)).toBe(true);
    expect(confirmsWear(attempt(), '3')).toBe(false);
  });

  it('maps errors from both the hosted initial and the current RPC', () => {
    expect(classifyWearError({ code: '23505', message: 'duplicate key value' })).toBe('conflict');
    expect(classifyWearError({ code: 'P0001', message: 'Request conflict' })).toBe('conflict');
    expect(classifyWearError({ code: '23503', message: 'foreign key' })).toBe('conflict');
    expect(classifyWearError({ code: 'P0001', message: 'Invalid selection' })).toBe('invalidSelection');
    expect(classifyWearError({ code: 'P0001', message: 'A future plan cannot count as worn' })).toBe('future');
    expect(classifyWearError({ code: 'P0001', message: 'Invalid timezone' })).toBe('rejected');
    expect(classifyWearError({ code: '42501', message: 'denied' })).toBe('rejected');
    expect(classifyWearError({ code: 'P0001', message: 'Something else' })).toBe('unknown');
    expect(classifyWearError({ code: '23505' }, 503)).toBe('unknown');
    expect(classifyWearError(null)).toBe('unknown');
  });
});

describe('rereads after an unconfirmed write', () => {
  it('confirms a create, reports it missing, or reports a different look', () => {
    const create = attempt({ baselineVersion: null, state: 'planned' });
    expect(compareLook(create, look({ version: 1 }))).toBe('saved');
    expect(compareLook(create, null)).toBe('notSaved');
    expect(compareLook(create, look({ version: 1, label: 'Other' }))).toBe('changed');
    expect(compareLook(create, look({ version: 1, deleted_at: '2026-09-16T10:00:00Z' }))).toBe('changed');
  });

  it('confirms a state change or reports it unsaved', () => {
    expect(compareLook(attempt(), look({ version: 3, state: 'worn' }))).toBe('saved');
    expect(compareLook(attempt(), look({ version: 2 }))).toBe('notSaved');
    expect(compareLook(attempt(), look({ version: 4, state: 'worn' }))).toBe('changed');
    expect(compareLook(attempt(), null)).toBe('changed');
  });

  it('checks removal and undo by version and deleted state', () => {
    expect(compareRemoval({ version: 2, removed: true }, look({ version: 3, deleted_at: '2026-09-16T10:00:00Z' }))).toBe('saved');
    expect(compareRemoval({ version: 2, removed: true }, look({ version: 2 }))).toBe('notSaved');
    expect(compareRemoval({ version: 2, removed: true }, look({ version: 3 }))).toBe('changed');
    expect(compareRemoval({ version: 3, removed: false }, look({ version: 4 }))).toBe('saved');
    expect(compareRemoval({ version: 3, removed: false }, null)).toBe('changed');
  });
});

describe('the shared create store', () => {
  // Every write reply is lost and every reread fails, so the outcome stays unknown and the attempt is kept.
  const unreachable = () => {
    const read = { select: () => read, eq: () => read, abortSignal: () => read, maybeSingle: async () => ({ data: null, error: { code: 'PGRST000', message: 'Unavailable' } }) };
    return { rpc: () => ({ abortSignal: async () => ({ data: null, error: { message: 'Service unavailable' }, status: 503 }) }), from: () => read } as unknown as AppClient;
  };
  const attempt = (epoch: number): LookAttempt => ({ id: eventId, localDate: '2026-09-16', timezone: 'Europe/Helsinki', state: 'planned', label: 'Market day',
    outfitId: null, itemIds: [itemA], baselineVersion: null, ownerId: owner, epoch });

  it('keeps an unknown plan for its owner scope and clears it when the scope ends', async () => {
    const session = new AbortController(), scope = { ownerId: owner, epoch: 1, signal: session.signal };
    const result = await createLook(unreachable(), scope, 'plan', attempt(1), true, new AbortController().signal);
    expect(result?.reply).toEqual({ kind: 'unknown' });
    expect(pendingCreate(scope, 'plan')).toMatchObject({ id: eventId, label: 'Market day' });
    expect(Object.isFrozen(pendingCreate(scope, 'plan'))).toBe(true);
    session.abort();
    expect(pendingCreate(scope, 'plan')).toBeNull();
    const next = { ownerId: owner, epoch: 2, signal: new AbortController().signal };
    expect(pendingCreate(next, 'plan')).toBeNull();
  });

  it('stores nothing for a scope that has already ended', async () => {
    const session = new AbortController(), scope = { ownerId: owner, epoch: 1, signal: session.signal };
    session.abort();
    await expect(createLook(unreachable(), scope, 'plan', attempt(1), true, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(pendingCreate(scope, 'plan')).toBeNull();
  });
});
