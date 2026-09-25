// Service-side dependencies for the shared deletion loop, used by the Edge Function and the operator tool.
// Every call has its own timeout, never follows redirects and reads a bounded body.
import { exact, readJson } from '../analyze-clothing/protocol.ts';
import { PAGE_LIMIT, TIMEOUTS, type DeletionDeps, type Guard, type Outcome, type Receipt } from './deletion-loop.ts';

export type CallInit = { method: string; body?: unknown; bearer?: string; key: string };
export type Called = { response: Response; signal: AbortSignal };
/** Resolves to `null` when no response arrived (network failure, abort or timeout). */
export type Call = (path: string, init: CallInit, ms: number) => Promise<Called | null>;

const MESSAGES = ['Not available', 'Retry limit', 'Request conflict', 'Invalid action', 'Remove files first', 'Remove identity first'];
const NAME = /^[0-9A-Za-z._-]{1,200}$/;

export function createCall(baseUrl: string): Call {
  return async (path, init, ms) => {
    const signal = AbortSignal.timeout(ms);
    const headers: Record<string, string> = { apikey: init.key };
    if (init.bearer !== undefined) headers.Authorization = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init.method, redirect: 'error', cache: 'no-store', signal, headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { response, signal };
    } catch {
      return null;
    }
  };
}

async function body(got: Called, limit: number): Promise<unknown> {
  return readJson(got.response, limit, got.signal).catch(() => undefined);
}

function isReceipt(value: unknown): value is Receipt {
  return typeof value === 'object' && value !== null && typeof (value as Receipt).stage === 'string'
    && typeof (value as Receipt).attempts === 'number';
}

export function serviceDeps(owner: string, serviceKey: string, call: Call): Omit<DeletionDeps, 'now'> {
  const service = { bearer: serviceKey, key: serviceKey };
  const listed = async (prefix: string, before: Guard): Promise<Outcome<{ name: string; file: boolean }[]>> => {
    if (!await before()) return { kind: 'ambiguous' };
    const got = await call('/storage/v1/object/list/wardrobe', { method: 'POST', ...service,
      body: { prefix, limit: PAGE_LIMIT, offset: 0, sortBy: { column: 'name', order: 'asc' } } }, TIMEOUTS.storagePageMs);
    if (!got) return { kind: 'ambiguous' };
    const value = await body(got, 262144);
    if (!got.response.ok) return got.response.status >= 500 ? { kind: 'ambiguous' } : { kind: 'error', message: 'Storage' };
    if (!Array.isArray(value) || !value.every((entry) => typeof entry?.name === 'string' && NAME.test(entry.name))) {
      return { kind: 'error', message: 'Storage' };
    }
    return { kind: 'ok', value: value.map((entry) => ({ name: entry.name as string, file: typeof entry.id === 'string' })) };
  };
  return {
    async control(action, op, code) {
      const got = await call('/rest/v1/rpc/deletion_control', { method: 'POST', ...service,
        body: { p_owner_id: owner, p_action: action, p_op: op, p_code: code ?? null } }, TIMEOUTS.rpcMs);
      if (!got) return { kind: 'ambiguous' };
      const value = await body(got, 16384);
      if (got.response.ok) return isReceipt(value) ? { kind: 'ok', value } : { kind: 'ambiguous' };
      if (exact(value, ['code', 'message', 'details', 'hint']) && MESSAGES.includes(String(value.message))) {
        return { kind: 'error', message: String(value.message) };
      }
      return { kind: 'ambiguous' };
    },
    async listOwnerObjects(_owner, before) {
      // Objects live at <owner>/<item>/<image>/<file>; walk at most three folder levels, one page each.
      const names: string[] = [];
      const walk = async (prefix: string, depth: number): Promise<Outcome<null>> => {
        const page = await listed(prefix, before);
        if (page.kind !== 'ok') return page;
        for (const entry of page.value) {
          if (names.length >= PAGE_LIMIT) break;
          if (entry.file) { names.push(`${prefix}/${entry.name}`); continue; }
          if (depth >= 3) return { kind: 'error', message: 'Storage' };
          const inner = await walk(`${prefix}/${entry.name}`, depth + 1);
          if (inner.kind !== 'ok') return inner;
        }
        return { kind: 'ok', value: null };
      };
      const done = await walk(owner, 0);
      return done.kind === 'ok' ? { kind: 'ok', value: names } : done;
    },
    async removeObjects(names, before) {
      // One object per request, the same Storage operation the item deletion path uses.
      for (const name of names) {
        if (!name.startsWith(`${owner}/`) || !name.split('/').every((part) => NAME.test(part))) return { kind: 'error', message: 'Storage' };
        // Deadline and lease are checked before every request; a stop leaves the rest for the next attempt.
        if (!await before()) return { kind: 'ambiguous' };
        const got = await call(`/storage/v1/object/wardrobe/${name}`, { method: 'DELETE', ...service }, TIMEOUTS.storagePageMs);
        if (!got) return { kind: 'ambiguous' };
        const value = await body(got, 65536);
        if (got.response.ok) continue;
        const missing = got.response.status === 400 && typeof value === 'object' && value !== null
          && (value as { code?: unknown }).code === 'NoSuchKey';
        if (missing) continue;
        return got.response.status >= 500 ? { kind: 'ambiguous' } : { kind: 'error', message: 'Storage' };
      }
      return { kind: 'ok', value: null };
    },
    async getAuthUser() {
      const got = await call(`/auth/v1/admin/users/${owner}`, { method: 'GET', ...service }, TIMEOUTS.authMs);
      if (!got) return { kind: 'ambiguous' };
      const value = await body(got, 65536);
      if (got.response.status === 404) return { kind: 'ok', value: false };
      if (got.response.ok && typeof value === 'object' && value !== null && (value as { id?: unknown }).id === owner) {
        return { kind: 'ok', value: true };
      }
      return got.response.status >= 500 ? { kind: 'ambiguous' } : { kind: 'error', message: 'Auth' };
    },
    async deleteAuthUser() {
      // Hard delete: a soft delete keeps the auth.users row, so the admission trigger would not fire.
      const got = await call(`/auth/v1/admin/users/${owner}`, { method: 'DELETE', ...service,
        body: { should_soft_delete: false } }, TIMEOUTS.authMs);
      if (!got) return { kind: 'ambiguous' };
      await body(got, 65536);
      if (got.response.ok || got.response.status === 404) return { kind: 'ok', value: null };
      return got.response.status >= 500 ? { kind: 'ambiguous' } : { kind: 'error', message: 'Auth' };
    },
  };
}
