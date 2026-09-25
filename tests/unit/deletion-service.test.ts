import { describe, expect, it } from 'vitest';
import { LEASE_MS, RENEW_EVERY_MS, runDeletion } from '../../supabase/functions/_shared/deletion-loop.ts';
import { serviceDeps, type Call } from '../../supabase/functions/_shared/deletion-service.ts';

// Service dependencies against an injected transport with a controlled clock: every Storage request must be
// preceded by a deadline and lease check, and nothing more is sent once either fails.
const OWNER = '11111111-1111-4111-8111-111111111111';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function backend(files: number, onStorage: (kind: 'list' | 'delete', count: number) => void = () => {}) {
  const clock = { now: 0 };
  const log: string[] = [];
  let objects = Array.from({ length: files }, (_, n) => `f${String(n).padStart(3, '0')}.jpg`);
  let stage = 'storage';
  let leaseUntil = 0;
  let lists = 0, deletes = 0;
  const receipt = (extra = {}) => ({ owner_id: OWNER, stage, attempts: 1, grants: 0, last_code: null,
    requested_at: 't', completed_at: stage === 'complete' ? 't' : null, busy: leaseUntil > clock.now, ...extra });
  const conflict = () => json({ code: 'P0001', message: 'Request conflict', details: null, hint: null }, 400);
  const call: Call = async (path, init) => {
    const signal = new AbortController().signal;
    const reply = (response: Response) => ({ response, signal });
    clock.now += 10;
    if (path === '/rest/v1/rpc/deletion_control') {
      const action = (init.body as { p_action: string }).p_action;
      log.push(action);
      if (action === 'status') return reply(json(receipt()));
      if (action === 'begin') { leaseUntil = clock.now + LEASE_MS; return reply(json(receipt({ acquired: true }))); }
      if (leaseUntil <= clock.now) return reply(conflict());
      if (action === 'renew') { leaseUntil = clock.now + LEASE_MS; return reply(json(receipt())); }
      if (action === 'release' || action === 'failed') { leaseUntil = 0; return reply(json(receipt())); }
      if (action === 'storage_removed') { stage = 'auth'; return reply(json(receipt())); }
      if (action === 'auth_removed') { stage = 'complete'; leaseUntil = 0; return reply(json(receipt())); }
      throw new Error(`unexpected ${action}`);
    }
    if (path === '/storage/v1/object/list/wardrobe') {
      log.push('list'); lists += 1; onStorage('list', lists);
      const prefix = (init.body as { prefix: string }).prefix;
      if (prefix === OWNER) return reply(json(objects.length ? [{ name: 'item', id: null }] : []));
      return reply(json(objects.slice(0, 100).map((name) => ({ name, id: 'x' }))));
    }
    if (path.startsWith(`/storage/v1/object/wardrobe/${OWNER}/item/`)) {
      log.push('delete'); deletes += 1; onStorage('delete', deletes);
      objects = objects.filter((name) => !path.endsWith(`/${name}`));
      return reply(json({ message: 'Successfully deleted' }));
    }
    if (path === `/auth/v1/admin/users/${OWNER}`) { log.push(`auth-${init.method}`); return reply(json({}, 404)); }
    throw new Error(`unexpected ${path}`);
  };
  const deps = { ...serviceDeps(OWNER, 'service-key', call), now: () => clock.now };
  return { deps, clock, log, remaining: () => objects.length };
}

describe('deletion service guard before every Storage request (injected transport)', () => {
  it('stops after a slow request passes the deadline and releases the lease', async () => {
    const world = backend(5, (kind, count) => { if (kind === 'delete' && count === 1) world.clock.now += 60_000; });
    await expect(runDeletion(world.deps, OWNER, 'begin', 'op-1', 50_000)).resolves.toBe('retry');
    expect(world.log.filter((entry) => entry === 'delete')).toHaveLength(1);
    expect(world.log.at(-2)).toBe('release');
    expect(world.log.lastIndexOf('delete')).toBeLessThan(world.log.indexOf('release'));
    expect(world.remaining()).toBe(4);
  });

  it('renews during a long run and finishes when the lease stays held', async () => {
    const world = backend(250, (kind) => { if (kind === 'delete') world.clock.now += 1_000; });
    await expect(runDeletion(world.deps, OWNER, 'begin', 'op-1', 10_000_000)).resolves.toBe('complete');
    expect(world.remaining()).toBe(0);
    expect(world.log.filter((entry) => entry === 'renew').length).toBeGreaterThan(250_000 / RENEW_EVERY_MS);
  });

  it('sends no further Storage request once the lease expires partway through the pages', async () => {
    // The second page listing stalls past the lease, so the next renewal is refused.
    const world = backend(150, (kind, count) => { if (kind === 'list' && count === 3) world.clock.now += LEASE_MS + 1; });
    await expect(runDeletion(world.deps, OWNER, 'begin', 'op-1', 10_000_000)).resolves.toBe('in_progress');
    const refused = world.log.lastIndexOf('renew');
    expect(world.log.slice(refused + 1).filter((entry) => entry === 'list' || entry === 'delete')).toEqual([]);
    expect(world.log).not.toContain('storage_removed');
    expect(world.remaining()).toBe(50);
  });
});
