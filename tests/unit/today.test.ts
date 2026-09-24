import { describe, expect, it } from 'vitest';
import { classifyVoteError, parseFeedbackRows, parseRuleRows, parseStoredVote } from '../../src/data/suggestions';
import { navFamilyFor } from '../../src/domain/outfits';
import type { WardrobeItem } from '../../src/domain/wardrobe';
import { defaultSeason, localDate, mergeVotes, rankingVotes, suggestionPool } from '../../src/features/today/use-suggestions';

const owner = '00000000-0000-4000-8000-00000000000a';
const other = '00000000-0000-4000-8000-00000000000b';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signature = 'a'.repeat(64);

function item(n: number, fields: Partial<WardrobeItem> = {}): WardrobeItem {
  return {
    id: id(n), ownerId: owner, title: `Item ${n}`, category: 'top', createdAt: '2026-09-01T00:00:00Z', imageId: id(100 + n),
    mainPath: 'm', thumbPath: 't', altText: '', favourite: false, availability: 'available', lifecycle: 'active',
    excludeSuggestions: false, colours: [], seasons: [], formality: null, ...fields,
  } as WardrobeItem;
}

describe('I15 suggestion data', () => {
  it('reads this owner\'s feedback as sorted combinations and rejects anything else', () => {
    expect(parseFeedbackRows([{ id: id(1), owner_id: owner, item_ids: [id(3), id(2)], signature, vote: 1 }], owner))
      .toEqual([{ itemIds: [id(2), id(3)], vote: 1 }]);
    const bad = [
      { id: id(1), owner_id: other, item_ids: [id(2)], signature, vote: 1 },
      { id: id(1), owner_id: owner, item_ids: [], signature, vote: 1 },
      { id: id(1), owner_id: owner, item_ids: [id(2), id(2)], signature, vote: 1 },
      { id: id(1), owner_id: owner, item_ids: [id(2)], signature, vote: 0 },
      { id: id(1), owner_id: owner, item_ids: [id(2)], signature: 'x', vote: -1 },
      { id: id(1), owner_id: owner, item_ids: [owner.toUpperCase()], signature, vote: -1 },
    ];
    for (const row of bad) expect(() => parseFeedbackRows([row], owner)).toThrow();
    const twice = [{ id: id(1), owner_id: owner, item_ids: [id(2), id(3)], signature, vote: 1 },
      { id: id(4), owner_id: owner, item_ids: [id(3), id(2)], signature, vote: -1 }];
    expect(() => parseFeedbackRows(twice, owner)).toThrow();
    expect(() => parseFeedbackRows(null, owner)).toThrow();
  });

  it('reads excluded pairs only for this owner with the lower ID first', () => {
    expect(parseRuleRows([{ id: id(1), owner_id: owner, item_low: id(2), item_high: id(3) }], owner)).toEqual([[id(2), id(3)]]);
    expect(() => parseRuleRows([{ id: id(1), owner_id: other, item_low: id(2), item_high: id(3) }], owner)).toThrow();
    expect(() => parseRuleRows([{ id: id(1), owner_id: owner, item_low: id(3), item_high: id(2) }], owner)).toThrow();
  });

  it('offers only active clothes that have a photo', () => {
    const pool = suggestionPool([item(1), item(2, { lifecycle: 'archived' }), item(3, { imageId: '' }), item(4, { availability: 'laundry' })]);
    expect(pool.map(entry => entry.id)).toEqual([id(1), id(4)]);
    expect(pool[1]!.availability).toBe('laundry');
    expect(pool.every(entry => entry.warmth === null && entry.minTemp === null && !entry.deleted)).toBe(true);
  });

  it('uses the profile time zone for today and falls back when it is invalid', () => {
    const now = new Date('2026-02-28T23:30:00Z');
    expect(localDate('Europe/Helsinki', now)).toBe('2026-03-01');
    expect(localDate('America/New_York', now)).toBe('2026-02-28');
    expect(defaultSeason('Europe/Helsinki', now)).toBe('spring');
    expect(defaultSeason('America/New_York', now)).toBe('winter');
    expect(localDate('Not/AZone', now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('highlights Today in the navigation', () => {
    expect(navFamilyFor('today')).toBe('today');
  });
});

describe('vote write outcomes', () => {
  it('treats lost replies, transport failures and server errors as unknown', () => {
    for (const [error, status] of [[{ code: '' }, 0], [{ message: 'x' }, 500], [{ code: 'PGRST000' }, 503], [null, 400], [{ code: '42501' }, 502]] as const) {
      expect(classifyVoteError(error, status)).toBe('unknown');
    }
    expect(classifyVoteError({ code: 'XX999' }, 400)).toBe('unknown');
  });
  it('treats definite refusals as rejected', () => {
    for (const code of ['42501', '23514', '23503', 'P0001', 'PGRST301']) expect(classifyVoteError({ code }, 400)).toBe('rejected');
  });
  it('reads back the stored choice for exactly the attempted outfit', () => {
    const key = [id(1), id(2)].join('|');
    const row = { id: id(50), owner_id: owner, item_ids: [id(2), id(1)], signature, vote: -1 };
    expect(parseStoredVote([row], owner, key)).toBe(-1);
    expect(parseStoredVote([], owner, key)).toBeNull();
    expect(() => parseStoredVote([{ ...row, item_ids: [id(1), id(3)] }], owner, key)).toThrow();
    expect(() => parseStoredVote([row, { ...row, id: id(51), item_ids: [id(4)] }], owner, key)).toThrow();
    expect(() => parseStoredVote([{ ...row, owner_id: other }], owner, key)).toThrow();
  });
});

describe('mergeVotes', () => {
  it('lays choices confirmed after a read started over its older snapshot', () => {
    const snapshot = new Map<string, 1 | -1>([['a', 1], ['b', -1], ['c', 1]]);
    const confirmed = new Map([['a', { vote: null, seq: 3 }], ['b', { vote: 1 as const, seq: 2 }], ['d', { vote: -1 as const, seq: 4 }], ['c', { vote: null, seq: 1 }]]);
    expect([...mergeVotes(snapshot, confirmed, 1)].sort()).toEqual([['b', 1], ['c', 1], ['d', -1]]);
    expect([...mergeVotes(snapshot, confirmed, 4)]).toEqual([...snapshot]);
    expect(snapshot.get('a')).toBe(1);
  });
});

describe('rankingVotes', () => {
  it('keeps the ranking value of choices made on the shown page and takes fresh votes for the rest', () => {
    const fresh = new Map<string, 1 | -1>([['a', -1], ['b', 1], ['c', -1]]);
    const ranked = new Map<string, 1 | -1>([['b', -1], ['d', 1]]);
    expect([...rankingVotes(fresh, ranked, new Set(['a', 'b', 'd']))].sort()).toEqual([['b', -1], ['c', -1], ['d', 1]]);
    expect([...rankingVotes(fresh, ranked, new Set())]).toEqual([...fresh]);
  });
});
