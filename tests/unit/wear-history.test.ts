import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../src/data/database.types';
import { loadWearHistory, summarizeWear, wearProjection } from '../../src/data/wear-history';
import { parseWardrobeRows } from '../../src/data/items';
import { AppError } from '../../src/data/errors';

const owner = '10000000-0000-4000-8000-000000000001', foreign = '10000000-0000-4000-8000-000000000002';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = () => ({ ownerId: owner, epoch: 4, signal: new AbortController().signal });
const items = parseWardrobeRows([{
  id: id(1), owner_id: owner, title: 'Fixture', category: 'top', created_at: '2026-09-01T00:00:00Z', deleted_at: null,
  favourite: false, availability: 'ready', lifecycle: 'active', exclude_suggestions: false,
  brand: null, tags: [], colours: [], seasons: [], formality: null, purchase_price: null, currency: 'EUR',
}], [{ id: id(2), owner_id: owner, item_id: id(1), state: 'ready', main_path: `${owner}/${id(1)}/${id(2)}/main.jpg`, thumb_path: `${owner}/${id(1)}/${id(2)}/thumb.jpg`, alt_text: '' }], owner);
function link(n: number) {
  return { id: id(100 + n), owner_id: owner, item_id: id(1) as string | null, event_id: id(1000 + n),
    event: { id: id(1000 + n), owner_id: owner, local_date: '2026-09-01', state: 'worn', deleted_at: null as string | null } };
}
function client(fetcher: typeof fetch) {
  return createClient<Database>('http://127.0.0.1:54321', 'sb_publishable_unit_fixture', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher },
  });
}
afterEach(() => vi.useRealTimers());
describe('bounded owner wear history', () => {
  it('counts distinct stored local dates, never planned, deleted, detached or nonsaved links', () => {
    const planned = link(3); planned.event.state = 'planned';
    const deleted = link(4); deleted.event.deleted_at = '2026-09-02T00:00:00Z';
    const detached = link(5); detached.item_id = null;
    const nonsaved = link(6); nonsaved.item_id = id(900);
    const next = link(7); next.event.local_date = '2026-09-02';
    const summary = summarizeWear([link(1), link(2), planned, deleted, detached, nonsaved, next], scope(), items);
    expect(summary.items.get(id(1))).toEqual({ count: 2, lastWorn: '2026-09-02' });
    expect(summary.items.size).toBe(1);
    expect(summarizeWear([], scope(), items).items.get(id(1))).toEqual({ count: 0, lastWorn: null });
  });
  it('rejects foreign/malformed relations and impossible dates rather than guessing zero', () => {
    for (const row of [
      { ...link(1), owner_id: foreign }, { ...link(1), event: { ...link(1).event, owner_id: foreign } },
      { ...link(1), event: null }, { ...link(1), event: [link(1).event] }, { ...link(1), event_id: id(8) },
      { ...link(1), event: { ...link(1).event, local_date: '2026-02-30' } },
      { ...link(1), event: { ...link(1).event, state: 'invented' } }, { ...link(1), item_id: undefined },
    ]) expect(() => summarizeWear([row], scope(), items)).toThrow();
    expect(() => summarizeWear([link(1), link(1)], scope(), items)).toThrow();
  });
  it.each([500, 501])('pages %i links with the real composite INNER projection and exact predicates', async count => {
    const urls: URL[] = [], rows = Array.from({ length: count }, (_, n) => link(n));
    const api = client(async input => {
      const url = new URL(String(input)); urls.push(url);
      const start = url.searchParams.has('id') ? 500 : 0;
      return new Response(JSON.stringify(rows.slice(start, start + 500)));
    });
    const summary = await loadWearHistory(api, scope(), items);
    expect(summary.items.get(id(1))?.count).toBe(1);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.searchParams.get('select')).toBe(wearProjection);
      expect(url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
      expect(url.searchParams.get('event.owner_id')).toBe(`eq.${owner}`);
      expect(url.searchParams.get('event.state')).toBe('eq.worn');
      expect(url.searchParams.get('event.deleted_at')).toBe('is.null');
      expect(url.searchParams.get('item_id')).toBe('not.is.null');
      expect(url.searchParams.get('limit')).toBe('500');
      expect(url.searchParams.has('item_id.in')).toBe(false);
    }
    expect(urls[1]!.searchParams.get('id')).toBe(`gt.${rows[499]!.id}`);
  });
  it('refuses repeated cursors, errors and malformed responses', async () => {
    const rows = Array.from({ length: 500 }, (_, n) => link(n));
    let calls = 0;
    await expect(loadWearHistory(client(async () => { calls++; return new Response(JSON.stringify(rows)); }), scope(), items)).rejects.toThrow('wardrobe.historyUnavailable');
    expect(calls).toBe(2);
    await expect(loadWearHistory(client(async () => new Response('{}')), scope(), items)).rejects.toThrow('wardrobe.historyUnavailable');
    await expect(loadWearHistory(client(async () => new Response('{}', { status: 503 })), scope(), items)).rejects.toThrow('wardrobe.historyUnavailable');
  });
  it('refuses a changed owner epoch rather than publishing a stale successful snapshot', async () => {
    const lifetime = scope();
    await expect(loadWearHistory(client(async () => {
      lifetime.epoch++;
      return new Response('[]');
    }), lifetime, items)).rejects.toThrow('wardrobe.historyUnavailable');
    expect(() => summarizeWear([], scope(), [...items, ...items])).toThrow();
  });
  it('times out the complete paged operation at 30s, cleans the timer and distinguishes owner cancellation', async () => {
    vi.useFakeTimers();
    const api = client(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    }));
    const pending = loadWearHistory(api, scope(), items);
    const rejected = expect(pending).rejects.toEqual(new AppError('wardrobe.historyUnavailable'));
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController();
    const cancelled = loadWearHistory(api, { ...scope(), signal: controller.signal }, items);
    const refusal = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await refusal;
    expect(vi.getTimerCount()).toBe(0);
  });
});
