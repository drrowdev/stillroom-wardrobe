// Browser contract fixtures only. Real Auth/Storage authorization is a separate blocking suite.
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Language } from '../../src/i18n';

export const owners = {
  a: '10000000-0000-4000-8000-000000000001',
  b: '10000000-0000-4000-8000-000000000002',
};
type JsonRow = Record<string, unknown>;
export type MockOptions = {
  initialLanguage?: Language | null; failCommitOnce?: boolean; failLanguageSave?: boolean;
  recoverStatus?: number; updateStatus?: number; logoutStatus?: number; recoveryUser?: string;
};
export function recoveryHash(owner = owners.a, seconds = 3600): string {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: owner, aud: 'authenticated', role: 'authenticated', exp: expires }), 'c2lnbmF0dXJl'].join('.');
  return '#' + new URLSearchParams({ access_token: token, refresh_token: 'unused-opaque-fixture',
    expires_at: String(expires), expires_in: String(Math.max(1, seconds)), token_type: 'bearer', type: 'recovery', sb: '' });
}
export async function mockBackend(page: Page, options: MockOptions = {}) {
  const profiles: Record<string, JsonRow> = {
    [owners.a]: { owner_id: owners.a, display_name: 'Alex', ui_language: options.initialLanguage ?? null, timezone: 'Europe/Helsinki', currency: 'EUR', version: 1 },
    [owners.b]: { owner_id: owners.b, display_name: 'Robin', ui_language: 'sv', timezone: 'Europe/Helsinki', currency: 'EUR', version: 1 },
  };
  const items: JsonRow[] = [];
  const images: JsonRow[] = [];
  const files = new Map<string, Buffer>();
  const requests: Array<{ method: string; path: string; owner: string | null; ownerFilter: string | null }> = [];
  let commitFailed = false;
  const fixture = await readFile(new URL('../../blueprint/validation/fixture.jpg', import.meta.url));
  await page.route('http://127.0.0.1:54321/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let owner: string | null = null;
    const token = request.headers().authorization?.split(' ')[1]?.split('.')[1];
    if (token) {
      try { const value: unknown = JSON.parse(Buffer.from(token, 'base64url').toString()); if (typeof value === 'object' && value && 'sub' in value && typeof value.sub === 'string') owner = value.sub; }
      catch { /* The mocked anonymous key carries no owner. */ }
    }
    requests.push({ method, path: url.pathname, owner, ownerFilter: url.searchParams.get('owner_id') });
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { 'x-supabase-api-version': '2024-01-01' } });
    if (method === 'OPTIONS') { await route.fulfill({ status: 204 }); return; }
    if (url.pathname === '/auth/v1/token') {
      const body = request.postDataJSON() as { email?: string; password?: string };
      const id = body.email === 'user-a@example.test' ? owners.a : body.email === 'user-b@example.test' ? owners.b : null;
      if (!id || body.password !== 'fictional-test-password') { await json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400); return; }
      const claims = { sub: id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID() };
      const accessToken = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.browser-fixture`;
      await json({ access_token: accessToken, refresh_token: `fixture-${id}`, expires_in: 3600, token_type: 'bearer', user: { id, email: body.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-06T00:00:00Z' } });
      return;
    }
    if (url.pathname === '/auth/v1/recover') { await json({}, options.recoverStatus ?? 200); return; }
    if (url.pathname === '/auth/v1/logout') { await route.fulfill({ status: options.logoutStatus ?? 204 }); return; }
    if (!owner || !profiles[owner]) { await json({ message: 'Unauthorized' }, 401); return; }
    if (url.pathname === '/auth/v1/user') {
      if (method === 'PUT' && options.updateStatus) { await json({ code: 'reauthentication_needed', message: 'Private upstream text' }, options.updateStatus); return; }
      const id = options.recoveryUser ?? owner;
      await json({ id, email: id === owners.a ? 'user-a@example.test' : 'user-b@example.test', aud: 'authenticated', role: 'authenticated', is_anonymous: false });
      return;
    }
    if (url.pathname === '/rest/v1/profiles') {
      if (url.searchParams.get('owner_id') !== `eq.${owner}`) { await json(null); return; }
      const profile = profiles[owner]!;
      if (method === 'PATCH') {
        if (options.failLanguageSave) { await json({ message: 'Unavailable' }, 503); return; }
        if (url.searchParams.get('version') !== `eq.${profile.version}` || profile.ui_language !== null) { await json(null); return; }
        const body = request.postDataJSON() as JsonRow;
        profile.ui_language = body.ui_language;
        profile.version = Number(profile.version) + 1;
      }
      await json(profile); return;
    }
    const table = url.pathname === '/rest/v1/items' ? items : url.pathname === '/rest/v1/item_images' ? images : null;
    if (table) {
      if (method === 'POST') {
        const body = request.postDataJSON() as JsonRow;
        if (body.owner_id !== owner) { await json({ code: '42501' }, 403); return; }
        if (table.some((row) => row.id === body.id)) { await json({ code: '23505', message: 'duplicate' }, 409); return; }
        if (table === items) table.push({ ...body, deleted_at: null, version: 1, created_at: new Date().toISOString() });
        else table.push({ ...body, state: 'pending', main_path: `${owner}/${body.item_id}/${body.id}/main.jpg`, thumb_path: `${owner}/${body.item_id}/${body.id}/thumb.jpg` });
        await route.fulfill({ status: 201, body: '' }); return;
      }
      const own = table.filter((row) => row.owner_id === owner);
      const id = url.searchParams.get('id');
      const state = url.searchParams.get('state');
      const rows = own.filter((row) => (!id || `eq.${row.id}` === id) && (!state || `eq.${row.state}` === state));
      const singular = request.headers().accept?.includes('vnd.pgrst.object');
      await json(singular ? rows[0] ?? null : rows); return;
    }
    if (url.pathname === '/rest/v1/rpc/commit_image') {
      if (options.failCommitOnce && !commitFailed) { commitFailed = true; await json({ message: 'Unavailable' }, 503); return; }
      const body = request.postDataJSON() as JsonRow;
      const image = images.find((row) => row.id === body.p_image_id && row.owner_id === owner);
      if (!image || !files.has(String(image.main_path)) || !files.has(String(image.thumb_path))) { await json({ message: 'Upload incomplete' }, 400); return; }
      image.state = 'ready';
      await route.fulfill({ status: 204 }); return;
    }
    const prefix = '/storage/v1/object/wardrobe/';
    if (url.pathname.startsWith(prefix)) {
      const path = url.pathname.slice(prefix.length);
      if (!path.startsWith(`${owner}/`)) { await json({ statusCode: '403', message: 'Denied' }, 403); return; }
      if (method === 'POST') {
        if (files.has(path)) { await json({ statusCode: '409', message: 'The resource already exists' }, 409); return; }
        const body = request.postDataBuffer();
        if (!body) throw new Error('Missing fixture upload.');
        const contentType = request.headers()['content-type'] ?? '';
        if (contentType.includes('multipart/form-data')) {
          const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
          let bytes: Buffer | undefined;
          for (const entry of form.values()) if (entry instanceof Blob) bytes = Buffer.from(await entry.arrayBuffer());
          if (!bytes) throw new Error('Missing fixture JPEG.');
          files.set(path, bytes);
        } else files.set(path, body);
        await json({ Id: 'fixture', Key: `wardrobe/${path}` }); return;
      }
      const bytes = files.get(path);
      if (!bytes) { await json({ message: 'Not found' }, 404); return; }
      await route.fulfill({ status: 200, body: bytes, contentType: 'image/jpeg' }); return;
    }
    await json({ message: 'Unknown browser fixture route' }, 404);
  });
  return { profiles, items, images, files, requests, fixture };
}

export async function signIn(page: Page, account: 'a' | 'b' = 'a') {
  await page.locator('#email').fill(`user-${account}@example.test`);
  await page.locator('#password').fill('fictional-test-password');
  await page.locator('button[type="submit"]').click();
}
