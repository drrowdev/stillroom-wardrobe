// One stage-driven account-deletion loop, shared by the delete-account Edge Function (Deno) and the
// operator tool (Node type stripping). Every dependency is injected; this module does no I/O itself.
// Only erasable TypeScript syntax is allowed here, so Node can run it without a build step.

/** A definite reply, a definite refusal, or a reply that may or may not have been applied. */
export type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'error'; message: string } | { kind: 'ambiguous' };

export type Receipt = {
  owner_id: string; stage: string; attempts: number; grants: number; last_code: string | null;
  requested_at: string; completed_at: string | null; busy: boolean; acquired?: boolean;
};

export type ControlAction = 'begin' | 'resume' | 'renew' | 'storage_removed' | 'auth_removed' | 'failed' | 'release' | 'status';
export type FailureCode = 'UPSTREAM_UNAVAILABLE' | 'RETRY_REQUIRED';

export type DeletionDeps = {
  control(action: ControlAction, op: string, code?: FailureCode): Promise<Outcome<Receipt>>;
  /**
   * At most PAGE_LIMIT object names under `<owner>/`; an empty list means none remain. `before` runs before
   * every Storage request; when it returns false no further request is sent and the result is ambiguous.
   */
  listOwnerObjects(owner: string, before: Guard): Promise<Outcome<string[]>>;
  removeObjects(names: string[], before: Guard): Promise<Outcome<null>>;
  /** `true` when the Auth user still exists. */
  getAuthUser(owner: string): Promise<Outcome<boolean>>;
  /** Hard delete (`should_soft_delete: false`); an already-absent user is success. */
  deleteAuthUser(owner: string): Promise<Outcome<null>>;
  /** Milliseconds since an arbitrary origin; injected so tests control deadlines. */
  now(): number;
};

export type DeletionState = 'complete' | 'in_progress' | 'retry' | 'contact' | 'not_available';
export type Guard = () => Promise<boolean>;

export const STEP_LIMIT = 8;
export const PAGE_LIMIT = 100;
export const PAGES_PER_STEP = 50;
// Each dependency applies these to one external call.
export const TIMEOUTS = Object.freeze({ storagePageMs: 20000, authMs: 15000, rpcMs: 10000 });
// The SQL lease lasts LEASE_MS from each acquisition or renewal. The loop renews every RENEW_EVERY_MS, so a
// request started just before renewal (at most one external timeout) still finishes inside the lease.
export const LEASE_MS = 120000;
export const RENEW_EVERY_MS = 30000;

/**
 * Runs the deletion from whatever stage the database reports. `mode` is `begin` for the Edge Function
 * after re-authentication and `resume` for the operator tool; `op` is the caller-generated lease token.
 * No new external work starts after `deadline` (a `now()` value).
 */
export async function runDeletion(deps: DeletionDeps, owner: string, mode: 'begin' | 'resume', op: string,
  deadline: number): Promise<DeletionState> {
  // Replaying begin/resume with the same token is idempotent, so an ambiguous reply is replayed once.
  let start = await deps.control(mode, op);
  if (start.kind === 'ambiguous') start = await deps.control(mode, op);
  if (start.kind === 'ambiguous') return 'retry';
  if (start.kind === 'error') {
    if (start.message === 'Retry limit') return 'contact';
    if (start.message === 'Not available') return 'not_available';
    return start.message === 'Request conflict' ? 'in_progress' : 'retry';
  }
  if (start.value.stage === 'complete') return 'complete';
  if (start.value.acquired !== true) return 'in_progress';

  const completed = async (): Promise<boolean> => {
    const status = await deps.control('status', op);
    return status.kind === 'ok' && status.value.stage === 'complete';
  };
  // A lost lease stops new work; the current holder or a later attempt continues.
  const renew = async (): Promise<DeletionState | 'ambiguous' | null> => {
    const renewed = await deps.control('renew', op);
    if (renewed.kind === 'ok') return null;
    if (renewed.kind === 'ambiguous') return 'ambiguous';
    return (await completed()) ? 'complete' : 'in_progress';
  };
  const fail = async (code: FailureCode): Promise<DeletionState> => {
    const failed = await deps.control('failed', op, code);
    if (failed.kind === 'ok') return 'retry';
    return (await completed()) ? 'complete' : 'retry';
  };
  const release = async (): Promise<DeletionState> => {
    await deps.control('release', op);
    return (await completed()) ? 'complete' : 'retry';
  };

  // Ownership is known until renewedAt + LEASE_MS, because no other worker can take a live lease.
  // Before every external request the guard checks the deadline and renews once RENEW_EVERY_MS has passed.
  let renewedAt = deps.now();
  const halt: { reason: 'deadline' | 'unknown' | DeletionState | null } = { reason: null };
  const guard: Guard = async () => {
    if (halt.reason !== null) return false;
    if (deps.now() > deadline) { halt.reason = 'deadline'; return false; }
    if (deps.now() - renewedAt >= RENEW_EVERY_MS) {
      const at = deps.now();
      const held = await renew();
      if (held === 'ambiguous') { halt.reason = 'unknown'; return false; }
      if (held) { halt.reason = held; return false; }
      renewedAt = at;
      // Renewal itself takes time; the request must still start before the deadline.
      if (deps.now() > deadline) { halt.reason = 'deadline'; return false; }
    }
    return true;
  };
  // After a guarded call: undefined means carry on, 'next' rereads the stage, anything else is returned.
  const halted = async (): Promise<DeletionState | 'next' | undefined> => {
    const reason = halt.reason;
    halt.reason = null;
    if (reason === null) return undefined;
    if (reason === 'deadline') return release();
    return reason === 'unknown' ? 'next' : reason;
  };

  let stage = start.value.stage;
  let filesRemaining = 0;
  for (let step = 0; step < STEP_LIMIT; step += 1) {
    if (deps.now() > deadline) return release();
    if (step > 0) {
      const status = await deps.control('status', op);
      if (status.kind !== 'ok') continue;
      stage = status.value.stage;
    }
    if (stage === 'complete') return 'complete';
    const renewing = deps.now();
    const held = await renew();
    if (held === 'ambiguous') continue;
    if (held) return held;
    renewedAt = renewing;
    if (stage === 'auth') {
      // Storage and rows are already gone; only reconcile the Auth user.
      if (!await guard()) { const next = await halted(); if (next === 'next' || next === undefined) continue; return next; }
      const present = await deps.getAuthUser(owner);
      if (present.kind === 'ambiguous') continue;
      if (present.kind === 'error') return fail('UPSTREAM_UNAVAILABLE');
      if (present.value) {
        if (!await guard()) { const next = await halted(); if (next === 'next' || next === undefined) continue; return next; }
        const removed = await deps.deleteAuthUser(owner);
        if (removed.kind === 'ambiguous') continue;
        if (removed.kind === 'error') return fail('UPSTREAM_UNAVAILABLE');
      }
      const marked = await deps.control('auth_removed', op);
      if (marked.kind === 'ok' && marked.value.stage === 'complete') return 'complete';
      continue;
    }
    // `freeze` and `rows` never persist after a committed call; both are handled as `storage`.
    let emptied = false;
    for (let page = 0; page < PAGES_PER_STEP; page += 1) {
      const names = await deps.listOwnerObjects(owner, guard);
      if (names.kind === 'ambiguous') break;
      if (names.kind === 'error') return fail('UPSTREAM_UNAVAILABLE');
      if (names.value.length === 0) { emptied = true; break; }
      const removed = await deps.removeObjects(names.value.slice(0, PAGE_LIMIT), guard);
      if (removed.kind === 'ambiguous') break;
      if (removed.kind === 'error') return fail('UPSTREAM_UNAVAILABLE');
    }
    const next = await halted();
    if (next === 'next') continue;
    if (next !== undefined) return next;
    if (!emptied) continue;
    const marked = await deps.control('storage_removed', op);
    if (marked.kind === 'ok') { stage = marked.value.stage; continue; }
    if (marked.kind === 'error' && marked.message === 'Remove files first') {
      filesRemaining += 1;
      if (filesRemaining >= 2) return fail('RETRY_REQUIRED');
    }
  }
  return release();
}
