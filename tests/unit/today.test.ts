import { describe, expect, it } from 'vitest';
import type { AppClient } from '../../src/data/client';
import { avoidedRows, classifyVoteError, parseFeedbackRows, parseRuleRows, parseStoredVote, readPair, writePair } from '../../src/data/suggestions';
import { navFamilyFor } from '../../src/domain/outfits';
import type { WardrobeItem } from '../../src/domain/wardrobe';
import type { Suggestion } from '../../src/domain/recommendations';
import { defaultSeason, localDate, mergePairs, mergeVotes, rankingPairs, rankingVotes, suggestionPool, visibleIdeas } from '../../src/features/today/use-suggestions';

const owner = '00000000-0000-4000-8000-00000000000a';
const other = '00000000-0000-4000-8000-00000000000b';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signature = 'a'.repeat(64);

function item(n: number, fields: Partial<WardrobeItem> = {}): WardrobeItem {
  return {
    id: id(n), ownerId: owner, title: `Item ${n}`, category: 'top', createdAt: '2026-09-01T00:00:00Z', imageId: id(100 + n),
    mainPath: 'm', thumbPath: 't', altText: '', favourite: false, availability: 'available', lifecycle: 'active',
    excludeSuggestions: false, colours: [], seasons: [], formality: null,
    weather: { warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null, rainRating: null, windproof: null }, ...fields,
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
    const pool = suggestionPool([item(1), item(2, { lifecycle: 'archived' }), item(3, { imageId: '' }), item(4, { availability: 'laundry', weather: { warmth: 3, lowerCoverage: 2, minTemp: null, maxTemp: null, rainRating: 1, windproof: true } })]);
    expect(pool.map(entry => entry.id)).toEqual([id(1), id(4)]);
    expect(pool[1]!.availability).toBe('laundry');
    expect(pool[0]!.warmth).toBeNull();
    expect(pool[1]).toMatchObject({ warmth: 3, lowerCoverage: 2, rainRating: 1, windproof: true, minTemp: null });
    expect(pool.every(entry => !entry.deleted)).toBe(true);
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

type Call = { table: string; steps: [string, unknown[]][] };
// A stand-in client that records each query chain and answers it with the next scripted reply.
function fakeClient(replies: ({ data?: unknown; error?: unknown; status?: number } | 'throw')[]) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, steps: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const name of ['select', 'upsert', 'delete', 'eq', 'limit']) chain[name] = (...args: unknown[]) => { call.steps.push([name, args]); return chain; };
      chain.abortSignal = () => {
        const reply = replies.shift();
        if (reply === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ data: reply?.data ?? null, error: reply?.error ?? null, status: reply?.status ?? 200 });
      };
      return chain;
    },
  };
  return { client: client as unknown as AppClient, calls };
}

describe('avoided pairs', () => {
  const scope = { ownerId: owner, epoch: 1, signal: new AbortController().signal };
  const pair = `${id(2)}|${id(3)}`;
  const attempt = (avoid: boolean, key = pair) => ({ ownerId: owner, epoch: 1, pair: key, avoid });

  it('stores a pair once, keyed by owner and the lower ID first', async () => {
    const { client, calls } = fakeClient([{ status: 201 }]);
    expect(await writePair(client, scope, attempt(true), new AbortController().signal)).toBe('done');
    expect(calls).toEqual([{ table: 'combination_rules', steps: [['upsert', [{ owner_id: owner, item_low: id(2), item_high: id(3) },
      { onConflict: 'owner_id,item_low,item_high', ignoreDuplicates: true }]]] }]);
  });

  it('removes exactly this owner\'s pair', async () => {
    const { client, calls } = fakeClient([{ status: 204 }]);
    expect(await writePair(client, scope, attempt(false), new AbortController().signal)).toBe('done');
    expect(calls[0]!.steps).toEqual([['delete', []], ['eq', ['owner_id', owner]], ['eq', ['item_low', id(2)]], ['eq', ['item_high', id(3)]]]);
  });

  it('refuses a pair that is not two different canonical item IDs without sending anything', async () => {
    for (const key of [`${id(3)}|${id(2)}`, `${id(2)}|${id(2)}`, `${id(2)}|${id(3)}|${id(4)}`, id(2), `${id(2)}|${other.toUpperCase()}`]) {
      const { client, calls } = fakeClient([]);
      await expect(writePair(client, scope, attempt(true, key), new AbortController().signal)).rejects.toThrow();
      await expect(readPair(client, scope, attempt(true, key), new AbortController().signal)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  it('treats a lost reply as unknown and a refusal as rejected', async () => {
    expect(await writePair(fakeClient(['throw']).client, scope, attempt(true), new AbortController().signal)).toBe('unknown');
    expect(await writePair(fakeClient([{ error: { code: '' }, status: 503 }]).client, scope, attempt(true), new AbortController().signal)).toBe('unknown');
    expect(await writePair(fakeClient([{ error: { code: '23503' }, status: 409 }]).client, scope, attempt(true), new AbortController().signal)).toBe('rejected');
  });

  it('does not write for a scope that has changed owner or session', async () => {
    const { client, calls } = fakeClient([]);
    await expect(writePair(client, { ...scope, epoch: 2 }, attempt(true), new AbortController().signal)).rejects.toThrow(/Cancelled/);
    expect(calls).toEqual([]);
  });

  it('reads back whether exactly this pair is stored', async () => {
    const row = { id: id(9), owner_id: owner, item_low: id(2), item_high: id(3) };
    expect(await readPair(fakeClient([{ data: [row] }]).client, scope, attempt(true), new AbortController().signal)).toBe(true);
    expect(await readPair(fakeClient([{ data: [] }]).client, scope, attempt(false), new AbortController().signal)).toBe(false);
    await expect(readPair(fakeClient([{ data: [{ ...row, item_high: id(4) }] }]).client, scope, attempt(true), new AbortController().signal)).rejects.toThrow();
    await expect(readPair(fakeClient([{ data: [row, { ...row, id: id(10) }] }]).client, scope, attempt(true), new AbortController().signal)).rejects.toThrow();
    await expect(readPair(fakeClient([{ data: [{ ...row, owner_id: other }] }]).client, scope, attempt(true), new AbortController().signal)).rejects.toThrow();
  });

  it('lists pairs only while both pieces are in the wardrobe with a photo; trashed pieces are not loaded', () => {
    const items = [item(1), item(2), item(3, { lifecycle: 'archived' }), item(4, { imageId: '' })];
    const rows = avoidedRows([`${id(1)}|${id(2)}`, `${id(1)}|${id(3)}`, `${id(2)}|${id(4)}`, `${id(1)}|${id(5)}`], items);
    expect(rows.map(row => [row.pair, row.items.map(entry => entry.id)])).toEqual([[`${id(1)}|${id(2)}`, [id(1), id(2)]], [`${id(1)}|${id(3)}`, [id(1), id(3)]]]);
    const ordered = avoidedRows([`${id(1)}|${id(2)}`], [item(1, { category: 'footwear' }), item(2, { category: 'top' })]);
    expect(ordered[0]!.items.map(entry => entry.id)).toEqual([id(2), id(1)]);
  });
});

describe('pair ranking on a page', () => {
  it('lays pairs changed after a read started over its snapshot', () => {
    const confirmed = new Map([['a|b', { avoided: false, seq: 3 }], ['c|d', { avoided: true, seq: 2 }], ['e|f', { avoided: true, seq: 1 }]]);
    expect([...mergePairs(new Set(['a|b', 'x|y']), confirmed, 1)].sort()).toEqual(['c|d', 'x|y']);
    expect([...mergePairs(new Set(['a|b']), confirmed, 3)]).toEqual(['a|b']);
  });
  it('keeps the ranking value of pairs changed on the shown page', () => {
    expect([...rankingPairs(new Set(['a|b', 'c|d']), new Set(['e|f']), new Set(['a|b', 'e|f']))].sort()).toEqual(['c|d', 'e|f']);
    expect([...rankingPairs(new Set(['a|b']), new Set(), new Set())]).toEqual(['a|b']);
  });
  it('leaves out ideas holding a newly avoided pair, except the card it was chosen on', () => {
    const idea = (key: string, itemIds: string[]) => ({ key, itemIds }) as unknown as Suggestion;
    const ideas = [idea('one', ['a', 'b', 'c']), idea('two', ['a', 'b', 'd']), idea('three', ['a', 'd']), idea('four', ['c', 'd'])];
    const keys = (live: string[], ranked: string[], chosen: [string, string][]) =>
      visibleIdeas(ideas, new Set(live), new Set(ranked), new Map(chosen)).map(entry => entry.key);
    expect(keys(['a|b'], [], [['one', 'a|b']])).toEqual(['one', 'three', 'four']);
    expect(keys(['a|b'], ['a|b'], [])).toEqual(['one', 'two', 'three', 'four']);
    expect(keys([], [], [])).toEqual(['one', 'two', 'three', 'four']);
  });
});