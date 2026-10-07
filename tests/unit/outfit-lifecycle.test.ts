import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import { changeOutfit, checkOutfitAction } from '../../src/data/outfit-lifecycle';
import { loadTrashedOutfits } from '../../src/data/outfits';
import { confirmsOutfitReply, outfitRecoveryDays, reconcileOutfit, recoverableOutfit, type OutfitIntent } from '../../src/domain/outfit-lifecycle';
import type { OutfitRecord } from '../../src/domain/outfits';

const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-07T10:00:00Z';
const before: OutfitRecord = { id, ownerId: owner, version: 3, createdAt: date, deletedAt: null, title: 'Weekend',
  notes: 'Kept', occasion: 'smart', favourite: true, links: [{ itemId: '33333333-3333-4333-8333-333333333333', position: 0 }] };
const trash: OutfitIntent = { baseline: before, epoch: 4, action: 'trash' };
const after = { ...before, version: 4, deletedAt: date };
const row = (record: OutfitRecord) => ({ id: record.id, owner_id: record.ownerId, version: record.version, created_at: record.createdAt,
  deleted_at: record.deletedAt, title: record.title, notes: record.notes, occasion: record.occasion, favourite: record.favourite,
  outfit_items: record.links.map(link => ({ owner_id: owner, item_id: link.itemId, position: link.position })) });
function harness(replies: { data?: unknown; status?: number; throw?: boolean }[]) {
  const abort = new AbortController();
  const scope = { ownerId: owner, epoch: 4, signal: abort.signal } as OwnerScope;
  const requests: { url: URL; method: string; body: unknown }[] = [];
  const client = createClient<Database>('http://127.0.0.1:54321', 'fictional', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      const reply = replies.shift();
      if (!reply || reply.throw) throw new TypeError('Offline');
      return new Response(JSON.stringify(reply.data ?? null), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  return { client, scope, requests, abort };
}
describe('OUTFIT1 checked lifecycle', () => {
  it('uses inclusive seven-day recovery for display, rejecting future, live and expired timestamps', () => {
    const now = Date.parse(date);
    expect(recoverableOutfit(after, now)).toBe(true);
    expect(recoverableOutfit(after, now + 7 * 86400000)).toBe(true);
    expect(recoverableOutfit(after, now + 7 * 86400000 + 1)).toBe(false);
    expect(recoverableOutfit(after, now - 1)).toBe(false);
    expect(recoverableOutfit(before, now)).toBe(false);
    expect(outfitRecoveryDays(after, now)).toBe(7);
    expect(outfitRecoveryDays(after, now + 6 * 86400000 + 1)).toBe(1);
    expect(outfitRecoveryDays(after, now + 7 * 86400000)).toBe(0);
    expect(outfitRecoveryDays(after, now + 7 * 86400000 + 1)).toBe(0);
    expect(outfitRecoveryDays(before, now)).toBe(0);
  });
  it('accepts only exact identity, safe increment and lifecycle replies', () => {
    const reply = { id, owner_id: owner, version: 4, deleted_at: date };
    expect(confirmsOutfitReply(trash, reply)).toEqual(after);
    for (const change of [{ id: owner }, { owner_id: id }, { version: '4' }, { version: 5 }, { deleted_at: null }, { extra: true }, { deleted_at: 'invalid' }])
      expect(confirmsOutfitReply(trash, { ...reply, ...change })).toBeUndefined();
    expect(confirmsOutfitReply({ ...trash, baseline: { ...before, version: Number.MAX_SAFE_INTEGER } },
      { ...reply, version: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(confirmsOutfitReply({ baseline: after, epoch: 4, action: 'delete' }, { id, owner_id: owner, version: 4, deleted: true })).toBeNull();
  });
  it('reconciles no-op, changed payload/order, exact change and absence without overwriting', () => {
    expect(reconcileOutfit(trash, before)).toEqual({ kind: 'notSaved' });
    expect(reconcileOutfit(trash, after)).toEqual({ kind: 'saved', record: after });
    for (const change of [{ title: 'Edited' }, { favourite: false }, { notes: '' }, { version: 5 }, { links: [] }])
      expect(reconcileOutfit(trash, { ...after, ...change })).toEqual({ kind: 'conflict' });
    expect(reconcileOutfit(trash, null)).toEqual({ kind: 'conflict' });
    expect(reconcileOutfit({ baseline: after, epoch: 4, action: 'delete' }, null)).toEqual({ kind: 'saved', record: null });
    expect(reconcileOutfit({ baseline: after, epoch: 4, action: 'delete' }, after)).toEqual({ kind: 'notSaved' });
  });
  it('sends only checked RPC arguments and keeps the complete outfit payload', async () => {
    const h = harness([{ data: { id, owner_id: owner, version: 4, deleted_at: date } }]);
    expect(await changeOutfit(h.client, h.scope, trash)).toEqual({ kind: 'saved', record: after });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ method: 'POST', body: { p_id: id, p_expected_version: 3, p_trashed: true } });
    expect(h.requests[0]!.url.pathname).toBe('/rest/v1/rpc/set_outfit_trashed');
  });
  it.each([['Recovery expired', 'expired'], ['Try-on running', 'busy'], ['Request conflict', 'conflict']] as const)('reports %s explicitly without a resend', async (message, kind) => {
      const h = harness([{ status: 400, data: { code: '22023', message } }]);
      expect(await changeOutfit(h.client, h.scope, trash)).toEqual({ kind }); expect(h.requests).toHaveLength(1);
    });
  it('rereads a malformed/lost success and never repeats the write', async () => {
    const h = harness([{ data: { id, version: 4 } }, { data: row(after) }]);
    expect(await changeOutfit(h.client, h.scope, trash)).toEqual({ kind: 'saved', record: after });
    expect(h.requests.map(request => request.method)).toEqual(['POST', 'GET']);
    expect(h.requests[1]!.url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
  });
  it('treats a 5xx with a refusal code as uncertain, not a definite refusal', async () => {
    const h = harness([{ status: 503, data: { code: '42501', message: 'Not available' } }, { data: row(after) }]);
    expect(await changeOutfit(h.client, h.scope, trash)).toEqual({ kind: 'saved', record: after });
    expect(h.requests.map(request => request.method)).toEqual(['POST', 'GET']);
  });
  it('only owner-scoped absence confirms an unknown deletion, with read-only checks', async () => {
    const h = harness([{ status: 503, data: { message: 'Unavailable' } }, { data: null }]);
    expect(await changeOutfit(h.client, h.scope, { baseline: after, epoch: 4, action: 'delete' })).toEqual({ kind: 'saved', record: null });
    expect(h.requests.map(request => request.method)).toEqual(['POST', 'GET']);
    const held = harness([{ throw: true }]);
    expect(await checkOutfitAction(held.client, held.scope, trash)).toEqual({ kind: 'unknown' });
    expect(held.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('clears the ability to write on owner/epoch abort or mismatch', async () => {
    const h = harness([]); h.abort.abort();
    await expect(changeOutfit(h.client, h.scope, trash)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.requests).toHaveLength(0);
    const other = harness([]);
    await expect(changeOutfit(other.client, other.scope, { ...trash, epoch: 5 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(other.requests).toHaveLength(0);
  });
  it('lists only owner-scoped Trash with a validated embedded payload', async () => {
    const h = harness([{ data: [row(after)] }]);
    expect(await loadTrashedOutfits(h.client, h.scope, h.scope.signal)).toEqual([after]);
    expect(h.requests[0]!.url.searchParams.get('deleted_at')).toBe('not.is.null');
    const wrong = harness([{ data: [row(before)] }]);
    await expect(loadTrashedOutfits(wrong.client, wrong.scope, wrong.scope.signal)).rejects.toThrow();
  });
});
