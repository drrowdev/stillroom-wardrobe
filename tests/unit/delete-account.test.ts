import { describe, expect, it, vi } from 'vitest';
import { createDeleteAccount } from '../../supabase/functions/delete-account/handler.ts';
import type { Call, CallInit } from '../../supabase/functions/_shared/deletion-service.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const config = { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'public-key', serviceKey: 'service-key' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

type Seen = { path: string; init: CallInit };
function backend(options: { password?: string; auth?: boolean } = {}) {
  const seen: Seen[] = [];
  let stage = 'storage';
  let objects = ['main.jpg', 'thumb.jpg'];
  let authPresent = options.auth ?? true;
  const receipt = (extra = {}) => ({ owner_id: OWNER, stage, attempts: 1, grants: 0, last_code: null,
    requested_at: 't', completed_at: null, busy: stage !== 'complete', ...extra });
  const call: Call = async (path, init) => {
    seen.push({ path, init });
    const signal = new AbortController().signal;
    const reply = (response: Response) => ({ response, signal });
    if (path === '/auth/v1/user') return reply(json({ id: OWNER, role: 'authenticated', is_anonymous: false, email: 'c@example.test' }));
    if (path === '/auth/v1/token?grant_type=password') {
      const body = init.body as { password: string };
      return body.password === (options.password ?? 'right-password')
        ? reply(json({ access_token: 'fresh', user: { id: OWNER } })) : reply(json({ error: 'invalid_grant' }, 400));
    }
    if (path === '/auth/v1/logout?scope=local') return reply(new Response(null, { status: 204 }));
    if (path === '/rest/v1/rpc/purge_deletion_receipts') return reply(json(0));
    if (path === '/rest/v1/rpc/deletion_control') {
      const body = init.body as { p_action: string };
      if (body.p_action === 'storage_removed') stage = 'auth';
      if (body.p_action === 'auth_removed') stage = 'complete';
      return reply(json(receipt(body.p_action === 'begin' ? { acquired: true } : {})));
    }
    if (path.startsWith('/storage/v1/object/list/wardrobe')) {
      const prefix = (init.body as { prefix: string }).prefix;
      const folder = (name: string) => reply(json(objects.length ? [{ name, id: null }] : []));
      if (prefix === OWNER) return folder('item');
      if (prefix === `${OWNER}/item`) return folder('image');
      return reply(json(objects.map((name) => ({ name, id: 'x' }))));
    }
    if (path.startsWith(`/storage/v1/object/wardrobe/${OWNER}/item/image/`)) {
      objects = objects.filter((name) => !path.endsWith(`/${name}`));
      return reply(json({ message: 'Successfully deleted' }));
    }
    if (path === `/auth/v1/admin/users/${OWNER}`) {
      if (init.method === 'GET') return reply(authPresent ? json({ id: OWNER }) : json({}, 404));
      authPresent = false;
      return reply(json({}));
    }
    throw new Error(`unexpected ${path}`);
  };
  return { call, seen };
}
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('http://127.0.0.1:54321/functions/v1/delete-account', {
  method: 'POST', body: JSON.stringify(body),
  headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json', ...headers },
});
const handler = (call: Call) => createDeleteAccount(config, { call, newOp: () => '33333333-3333-4333-8333-333333333333' });

describe('delete-account Edge handler (injected transport, not a live Edge proof)', () => {
  it('re-authenticates, revokes the fresh session, purges receipts and only then runs the loop for the session owner', async () => {
    const { call, seen } = backend();
    const response = await handler(call)(request({ password: 'right-password' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: 'complete' });
    const paths = seen.map((entry) => entry.path);
    expect(paths.slice(0, 5)).toEqual(['/auth/v1/user', '/auth/v1/token?grant_type=password', '/auth/v1/logout?scope=local',
      '/rest/v1/rpc/purge_deletion_receipts', '/rest/v1/rpc/deletion_control']);
    expect(seen[2]?.init.bearer).toBe('fresh');
    const controls = seen.filter((entry) => entry.path === '/rest/v1/rpc/deletion_control').map((entry) => entry.init.body as Record<string, unknown>);
    expect(controls[0]).toMatchObject({ p_owner_id: OWNER, p_action: 'begin' });
    expect(controls.every((body) => body.p_owner_id === OWNER)).toBe(true);
    expect(controls.map((body) => body.p_action)).not.toContain('resume');
    expect(controls.map((body) => body.p_action)).not.toContain('grant');
    const hardDelete = seen.find((entry) => entry.init.method === 'DELETE' && entry.path.startsWith('/auth/v1/admin/users/'));
    expect(hardDelete?.init.body).toEqual({ should_soft_delete: false });
    const removed = seen.filter((entry) => entry.init.method === 'DELETE' && entry.path.startsWith('/storage/')).map((entry) => entry.path);
    expect(removed).toEqual([`/storage/v1/object/wardrobe/${OWNER}/item/image/main.jpg`, `/storage/v1/object/wardrobe/${OWNER}/item/image/thumb.jpg`]);
    const storageRemoved = seen.findIndex((entry) => (entry.init.body as { p_action?: string } | undefined)?.p_action === 'storage_removed');
    expect(storageRemoved).toBeGreaterThan(paths.lastIndexOf(removed.at(-1)!));
    // Service credentials are used only after re-authentication.
    const firstService = seen.findIndex((entry) => entry.init.key === 'service-key');
    expect(firstService).toBe(3);
  });

  it('refuses a wrong password with no privileged call and never echoes it', async () => {
    const { call, seen } = backend();
    const response = await handler(call)(request({ password: 'wrong-password-canary' }));
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ code: 'PASSWORD' });
    expect(text).not.toContain('canary');
    expect(seen.some((entry) => entry.init.key === 'service-key')).toBe(false);
  });

  it.each([
    [{ password: 'right-password', ownerId: OTHER }],
    [{ ownerId: OTHER }],
    [{ password: '' }],
    [{ password: 7 }],
    [[]],
  ])('refuses any body other than exactly one password %#', async (body) => {
    const { call, seen } = backend();
    const response = await handler(call)(request(body));
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('returns 401 before any call without a bearer token', async () => {
    const { call, seen } = backend();
    const response = await handler(call)(new Request('http://127.0.0.1:54321/functions/v1/delete-account', {
      method: 'POST', body: JSON.stringify({ password: 'right-password' }), headers: { 'Content-Type': 'application/json' },
    }));
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses an unknown origin and a query string before reading the body', async () => {
    const { call, seen } = backend();
    expect((await handler(call)(request({ password: 'x' }, { Origin: 'https://example.test' }))).status).toBe(403);
    expect((await handler(call)(new Request('http://127.0.0.1:54321/functions/v1/delete-account?owner=' + OTHER, {
      method: 'POST', body: '{}', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' } }))).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('reports retry, in progress and contact states without detail', async () => {
    for (const [reply, status, state] of [
      [{ kind: 'error', message: 'Retry limit' }, 409, 'contact'],
      [{ kind: 'ok', acquired: false }, 202, 'in_progress'],
    ] as const) {
      const { call } = backend();
      const wrapped: Call = async (path, init, ms) => {
        if (path === '/rest/v1/rpc/deletion_control') {
          const signal = new AbortController().signal;
          return reply.kind === 'error'
            ? { response: json({ code: 'P0001', message: reply.message, details: null, hint: null }, 400), signal }
            : { response: json({ owner_id: OWNER, stage: 'storage', attempts: 1, grants: 0, last_code: null, requested_at: 't',
              completed_at: null, busy: true, acquired: false }), signal };
        }
        return call(path, init, ms);
      };
      const response = await handler(wrapped)(request({ password: 'right-password' }));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ state });
    }
  });

  it('uses no network for a CORS preflight', async () => {
    const call = vi.fn<Call>();
    const response = await handler(call)(new Request('http://127.0.0.1:54321/functions/v1/delete-account', {
      method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type' } }));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5173');
    expect(call).not.toHaveBeenCalled();
  });
});
