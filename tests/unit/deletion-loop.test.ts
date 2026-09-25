import { describe, expect, it } from 'vitest';
import { LEASE_MS, RENEW_EVERY_MS, runDeletion, STEP_LIMIT, type ControlAction, type DeletionDeps, type Outcome, type Receipt } from '../../supabase/functions/_shared/deletion-loop.ts';

// A small in-memory model of deletion_control plus Storage and Auth, with fault injection.
// The CI rehearsal proves the SQL itself; this proves the loop's handling of every reply shape.
type Job = { stage: string; attempts: number; grants: number; lease: string | null; leaseUntil: number; lastCode: string | null };
class World {
  time = 0;
  job: Job | null = null;
  enabled = true;
  objects = new Set<string>();
  auth = true;
  calls: string[] = [];
  /** The account's enabled flag seen by each Storage call. */
  storageSawEnabled: boolean[] = [];
  lostAfter = new Set<string>();
  failOnce = new Map<string, 'ambiguous' | 'error'>();
  constructor(objects = 3) { for (let n = 0; n < objects; n += 1) this.objects.add(`owner/item/${n}`); }
  receipt(extra: Partial<Receipt> = {}): Receipt {
    const j = this.job!;
    return { owner_id: 'owner', stage: j.stage, attempts: j.attempts, grants: j.grants, last_code: j.lastCode,
      requested_at: 't', completed_at: j.stage === 'complete' ? 't' : null, busy: j.leaseUntil > this.time, ...extra };
  }
  apply(action: ControlAction, op: string, code?: string): Outcome<Receipt> {
    const error = (message: string): Outcome<Receipt> => ({ kind: 'error', message });
    const ok = (extra: Partial<Receipt> = {}): Outcome<Receipt> => ({ kind: 'ok', value: this.receipt(extra) });
    if (!this.job) {
      if (action !== 'begin' || !this.enabled) return error('Not available');
      this.job = { stage: 'freeze', attempts: 0, grants: 0, lease: null, leaseUntil: 0, lastCode: null };
    }
    const j = this.job;
    if (action === 'status') return ok();
    if (j.stage === 'complete') {
      if (action === 'begin' || action === 'resume') return ok({ acquired: false });
      if (action === 'auth_removed' || action === 'release') return ok();
      return error('Request conflict');
    }
    const live = j.leaseUntil > this.time;
    if (action === 'begin' || action === 'resume') {
      if (j.lease === op && live) return ok({ acquired: true });
      if (live) return ok({ acquired: false });
      if (j.attempts >= 10) return error('Retry limit');
      this.enabled = false;
      if (j.stage !== 'auth') j.stage = 'storage';
      j.attempts += 1; j.lease = op; j.leaseUntil = this.time + LEASE_MS; j.lastCode = null;
      return ok({ acquired: true });
    }
    if (j.lease !== op || !live) return error('Request conflict');
    if (action === 'renew') { j.leaseUntil = this.time + LEASE_MS; return ok(); }
    if (action === 'release') { j.lease = null; j.leaseUntil = 0; return ok(); }
    if (action === 'failed') { j.lastCode = code ?? null; j.lease = null; j.leaseUntil = 0; return ok(); }
    if (action === 'storage_removed') {
      if (j.stage !== 'storage') return error('Request conflict');
      if (this.objects.size) return error('Remove files first');
      j.stage = 'auth'; j.leaseUntil = this.time + LEASE_MS; return ok();
    }
    if (j.stage !== 'auth') return error('Request conflict');
    if (this.auth) return error('Remove identity first');
    j.stage = 'complete'; j.lease = null; j.leaseUntil = 0; return ok();
  }
  fault<T>(name: string, run: () => Outcome<T>): Outcome<T> {
    this.calls.push(name);
    this.time += 1;
    const injected = this.failOnce.get(name);
    if (injected) { this.failOnce.delete(name); return injected === 'ambiguous' ? { kind: 'ambiguous' } : { kind: 'error', message: 'Upstream' }; }
    const result = run();
    if (this.lostAfter.delete(name)) return { kind: 'ambiguous' };
    return result;
  }
  deps(): DeletionDeps {
    return {
      control: async (action, op, code) => this.fault(action, () => this.apply(action, op, code)),
      listOwnerObjects: async (_owner, before) => {
        if (!await before()) return { kind: 'ambiguous' };
        this.storageSawEnabled.push(this.enabled);
        return this.fault('list', () => ({ kind: 'ok', value: [...this.objects].slice(0, 2) }));
      },
      removeObjects: async (names, before) => {
        if (!await before()) return { kind: 'ambiguous' };
        this.storageSawEnabled.push(this.enabled);
        return this.fault('remove', () => { for (const name of names) this.objects.delete(name); return { kind: 'ok', value: null }; });
      },
      getAuthUser: async () => this.fault('getAuth', () => ({ kind: 'ok', value: this.auth })),
      deleteAuthUser: async () => this.fault('deleteAuth', () => { this.auth = false; return { kind: 'ok', value: null }; }),
      now: () => this.time,
    };
  }
}
const run = (world: World, op = 'op-1', mode: 'begin' | 'resume' = 'begin', deadline = 10000) =>
  runDeletion(world.deps(), 'owner', mode, op, deadline);

describe('shared deletion loop (in-memory model, not a database proof)', () => {
  it('removes files, rows and identity in order and uses one attempt', async () => {
    const world = new World(5);
    await expect(run(world)).resolves.toBe('complete');
    expect(world.objects.size).toBe(0);
    expect(world.auth).toBe(false);
    expect(world.job).toMatchObject({ stage: 'complete', attempts: 1 });
    const order = ['storage_removed', 'deleteAuth', 'auth_removed'].map((name) => world.calls.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(world.calls.lastIndexOf('remove')).toBeLessThan(order[0]!);
  });

  it('reports a second worker as in progress without using an attempt, and the first finishes', async () => {
    const world = new World();
    world.apply('begin', 'first');
    await expect(run(world, 'second')).resolves.toBe('in_progress');
    expect(world.job?.attempts).toBe(1);
    expect(world.calls.filter((call) => call !== 'begin')).toEqual([]);
    await expect(run(world, 'first')).resolves.toBe('complete');
    expect(world.job?.attempts).toBe(1);
  });

  it.each(['begin', 'storage_removed', 'deleteAuth', 'auth_removed', 'remove', 'renew'])(
    'rereads after a lost reply following %s and finishes with one attempt', async (name) => {
      const world = new World();
      world.lostAfter.add(name);
      await expect(run(world)).resolves.toBe('complete');
      expect(world.job).toMatchObject({ stage: 'complete', attempts: 1 });
      expect(world.calls).not.toContain('failed');
      expect(world.calls.filter((call) => call === 'deleteAuth').length).toBeLessThanOrEqual(1);
    });

  it('never deletes the Auth user again once its absence is confirmed', async () => {
    const world = new World();
    world.lostAfter.add('auth_removed');
    await run(world);
    expect(world.calls.filter((call) => call === 'deleteAuth')).toHaveLength(1);
  });

  it('skips Storage and rows at `auth` and reconciles an Auth user that is already absent', async () => {
    const world = new World(0);
    world.job = { stage: 'auth', attempts: 1, grants: 0, lease: null, leaseUntil: 0, lastCode: null };
    world.enabled = false;
    world.auth = false;
    await expect(run(world, 'op-2', 'resume')).resolves.toBe('complete');
    expect(world.calls).not.toContain('list');
    expect(world.calls).not.toContain('storage_removed');
    expect(world.calls).not.toContain('deleteAuth');
    expect(world.job?.attempts).toBe(2);
  });

  it('returns success for a completed job and a late `failed` cannot change it', async () => {
    const world = new World();
    await run(world);
    const before = world.receipt();
    expect(world.apply('failed', 'op-1', 'UPSTREAM_UNAVAILABLE')).toEqual({ kind: 'error', message: 'Request conflict' });
    expect(world.receipt()).toEqual(before);
    world.calls = [];
    await expect(run(world, 'op-3')).resolves.toBe('complete');
    expect(world.calls).toEqual(['begin']);
  });

  it('treats a conflict or ambiguous reply as a reason to reread, never to call `failed`', async () => {
    const world = new World();
    world.failOnce.set('storage_removed', 'ambiguous');
    world.failOnce.set('status', 'ambiguous');
    await expect(run(world)).resolves.toBe('complete');
    expect(world.calls).not.toContain('failed');
  });

  it('records a definite upstream failure once and reports retry; the next attempt resumes', async () => {
    const world = new World();
    world.failOnce.set('deleteAuth', 'error');
    await expect(run(world)).resolves.toBe('retry');
    expect(world.job).toMatchObject({ stage: 'auth', lastCode: 'UPSTREAM_UNAVAILABLE', lease: null });
    await expect(run(world, 'op-2')).resolves.toBe('complete');
    expect(world.job?.attempts).toBe(2);
  });

  it('stops starting work once the lease has expired and another worker holds it', async () => {
    const world = new World(10);
    const deps = world.deps();
    const list = deps.listOwnerObjects;
    deps.listOwnerObjects = async (owner, before) => {
      const page = await list(owner, before);
      // This listing outlived the lease, and another worker has acquired it meanwhile.
      world.time += LEASE_MS;
      world.job!.lease = 'other'; world.job!.leaseUntil = world.time + LEASE_MS;
      return page;
    };
    await expect(runDeletion(deps, 'owner', 'begin', 'op-1', 10 * LEASE_MS)).resolves.toBe('in_progress');
    expect(world.calls.filter((call) => call === 'list')).toHaveLength(1);
    expect(world.calls).not.toContain('remove');
    expect(world.calls).not.toContain('storage_removed');
  });

  it('rechecks the deadline after a slow renewal and starts no request once it has passed', async () => {
    const world = new World(10);
    const deps = world.deps();
    const list = deps.listOwnerObjects;
    deps.listOwnerObjects = async (owner, before) => {
      const page = await list(owner, before);
      world.time += RENEW_EVERY_MS;
      return page;
    };
    const control = deps.control;
    let renewals = 0;
    deps.control = async (action, op, code) => {
      const reply = await control(action, op, code);
      // The second renewal is the guard's; it returns only after the deadline.
      if (action === 'renew' && (renewals += 1) === 2) world.time = deadline + 1;
      return reply;
    };
    const deadline = RENEW_EVERY_MS + 100;
    await expect(runDeletion(deps, 'owner', 'begin', 'op-1', deadline)).resolves.toBe('retry');
    expect(renewals).toBe(2);
    expect(world.calls.filter((call) => call === 'list')).toHaveLength(1);
    expect(world.calls).not.toContain('remove');
    expect(world.job?.lease).toBeNull();
  });

  it('touches Storage only after the freeze, and not at all when begin is refused', async () => {
    const world = new World(5);
    await expect(run(world)).resolves.toBe('complete');
    expect(world.storageSawEnabled.length).toBeGreaterThan(0);
    expect(world.storageSawEnabled.every((enabled) => enabled === false)).toBe(true);
    const refused = new World(5);
    refused.enabled = false;
    await expect(run(refused)).resolves.toBe('not_available');
    expect(refused.calls).toEqual(['begin']);
    expect(refused.objects.size).toBe(5);
  });

  it('maps the retry limit to contact and a missing job to not available', async () => {
    const world = new World();
    world.job = { stage: 'storage', attempts: 10, grants: 0, lease: null, leaseUntil: 0, lastCode: null };
    await expect(run(world, 'op', 'resume')).resolves.toBe('contact');
    await expect(run(new World(), 'op', 'resume')).resolves.toBe('not_available');
  });

  it('refuses to mark files removed while any remain, and fails after two such refusals', async () => {
    const world = new World(1);
    const deps = world.deps();
    deps.listOwnerObjects = async () => world.fault('list', () => ({ kind: 'ok', value: [] }));
    await expect(runDeletion(deps, 'owner', 'begin', 'op-1', 10000)).resolves.toBe('retry');
    expect(world.job).toMatchObject({ stage: 'storage', lastCode: 'RETRY_REQUIRED' });
    expect(world.objects.size).toBe(1);
  });

  it('releases the lease at the deadline or the step bound instead of running on', async () => {
    const world = new World(1);
    await expect(run(world, 'op-1', 'begin', 2)).resolves.toBe('retry');
    expect(world.job?.lease).toBeNull();
    const stuck = new World(1);
    const deps = stuck.deps();
    deps.listOwnerObjects = async () => stuck.fault('list', () => ({ kind: 'ambiguous' }));
    await expect(runDeletion(deps, 'owner', 'begin', 'op-1', 10000)).resolves.toBe('retry');
    expect(stuck.calls.filter((call) => call === 'list')).toHaveLength(STEP_LIMIT);
    expect(stuck.job?.lease).toBeNull();
  });
});
