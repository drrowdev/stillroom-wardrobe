// Browser contract fixtures only. Real Auth/Storage authorization is a separate blocking suite.
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import type { Language } from '../../src/i18n';

export const owners = {
  a: '10000000-0000-4000-8000-000000000001',
  b: '10000000-0000-4000-8000-000000000002',
};
type JsonRow = Record<string, unknown>;
const storagePrefix = '/storage/v1/object/wardrobe/';
const fixtureKey = 'sb_publishable_browser_fixture_only';
const uploadHeaders = ['authorization', 'apikey', 'content-type', 'x-upsert', 'x-client-info'];
const uploadLimit = 1024 * 1024;

async function uploadReceiver(page: Page, items: JsonRow[], images: JsonRow[], files: Map<string, Buffer>, tokens: Map<string, string>) {
  const port = Number(process.env.PLAYWRIGHT_PORT ?? 5181);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid browser test port.');
  const origin = `http://127.0.0.1:${port}`;
  const cors = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': uploadHeaders.join(', '),
    vary: 'Origin',
  };
  const sockets = new Set<Socket>();
  const lifetime = new AbortController();
  const state = {
    get listening() { return server.listening; },
    get connections() { return sockets.size; },
    closed: false, posts: 0, preflights: 0, rejected: 0, receivedBytes: 0, payloadBytes: 0, peakBufferedBytes: 0,
  };
  const reservedOwner = (pathname: string) => {
    if (!pathname.startsWith(storagePrefix)) return undefined;
    const path = pathname.slice(storagePrefix.length);
    const [owner, item, image, variant, extra] = path.split('/');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (extra !== undefined || ![owners.a, owners.b].includes(owner ?? '') ||
      !uuid.test(item ?? '') || !uuid.test(image ?? '') || !['main.jpg', 'thumb.jpg'].includes(variant ?? '')) return undefined;
    return items.some((row) => row.owner_id === owner && row.id === item) &&
      images.some((row) => row.owner_id === owner && row.item_id === item && row.id === image &&
        (row.main_path === path || row.thumb_path === path)) ? owner : undefined;
  };
  const preflightAllowed = (headers: IncomingHttpHeaders) => headers.origin === origin && !headers.cookie &&
    headers['access-control-request-method'] === 'POST' &&
    typeof headers['access-control-request-headers'] === 'string' &&
    headers['access-control-request-headers'].split(',').every((name) => uploadHeaders.includes(name.trim().toLowerCase()));
  const credentialsAllowed = (headers: IncomingHttpHeaders, owner: string) => headers.origin === origin && !headers.cookie &&
    headers.apikey === fixtureKey && tokens.get(headers.authorization ?? '') === owner && headers['x-upsert'] === 'false';
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const timer = setTimeout(() => { state.rejected++; void close(); }, 5000);
    const finish = (body: unknown, status = 200) => {
      response.writeHead(status, { ...cors, 'content-type': 'application/json', ...(status >= 400 ? { connection: 'close' } : {}) });
      response.end(JSON.stringify(body), () => { if (status >= 400) void close(); });
    };
    response.once('close', () => clearTimeout(timer));
    void (async () => {
      const pathname = request.url ?? '';
      const owner = reservedOwner(pathname);
      if (!owner || request.headers.origin !== origin || request.headers.cookie) throw new Error('Fixture upload rejected.');
      if (request.method === 'OPTIONS') {
        if (!preflightAllowed(request.headers)) throw new Error('Fixture upload rejected.');
        state.preflights++;
        response.writeHead(204, cors).end();
        return;
      }
      if (request.method !== 'POST' || !credentialsAllowed(request.headers, owner)) {
        throw new Error('Fixture upload rejected.');
      }
      state.posts++;
      const contentType = request.headers['content-type'] ?? '';
      const boundary = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'-]{1,70})"|([A-Za-z0-9'-]{1,70}))$/i.exec(contentType);
      if (!boundary) throw new Error('Fixture upload rejected.');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        state.receivedBytes += bytes.length;
        if (bytes.length > uploadLimit - length) throw new Error('Fixture upload rejected.');
        length += bytes.length;
        chunks.push(bytes);
        state.peakBufferedBytes = Math.max(state.peakBufferedBytes, length);
      }
      const body = Buffer.concat(chunks, length);
      const delimiter = `--${boundary[1] ?? boundary[2]}`;
      const ending = Buffer.from(`\r\n${delimiter}--`);
      if (!body.subarray(0, delimiter.length + 2).equals(Buffer.from(`${delimiter}\r\n`)) ||
        !(body.subarray(-ending.length).equals(ending) || body.subarray(-ending.length - 2).equals(Buffer.concat([ending, Buffer.from('\r\n')])))) {
        throw new Error('Fixture upload rejected.');
      }
      const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
      const file = form.get('');
      if (form.getAll('').length !== 1 || !(file instanceof Blob) || file.type !== 'image/jpeg' || !file.size ||
        form.getAll('cacheControl').length !== 1 || form.get('cacheControl') !== '0' ||
        form.getAll('metadata').length > 1 || (form.has('metadata') && typeof form.get('metadata') !== 'string') ||
        [...form.keys()].some((key) => !['', 'cacheControl', 'metadata'].includes(key))) throw new Error('Fixture upload rejected.');
      const bytes = Buffer.from(await file.arrayBuffer());
      const path = pathname.slice(storagePrefix.length);
      if (closing || files.has(path)) throw new Error('Fixture upload rejected.');
      files.set(path, bytes);
      state.payloadBytes += bytes.length;
      finish({ Id: 'fixture', Key: `wardrobe/${path}` });
    })().catch(() => {
      state.rejected++;
      if (!response.destroyed && !response.headersSent) finish({ message: 'Fixture upload rejected.' }, 400);
      else void close();
    });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve) => {
    page.off('close', onPageClose);
    lifetime.abort();
    server.close(() => { state.closed = true; resolve(); });
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  });
  const onPageClose = () => { void close(); };
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  server.on('error', onPageClose);
  server.on('clientError', (_error, socket) => { state.rejected++; socket.destroy(); void close(); });
  page.once('close', onPageClose);
  try {
    if (page.isClosed()) throw new Error('Fixture page closed.');
    await new Promise<void>((resolve, reject) => {
      const closed = () => reject(new Error('Fixture receiver unavailable.'));
      server.once('error', reject);
      server.once('close', closed);
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }, () => {
        server.off('error', reject);
        server.off('close', closed);
        resolve();
      });
    });
    if (page.isClosed() || closing) throw new Error('Fixture page closed.');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture receiver unavailable.');
    return { url: `http://127.0.0.1:${address.port}`, state, cors, reservedOwner, preflightAllowed, credentialsAllowed, close };
  } catch {
    await close();
    throw new Error('Fixture receiver unavailable.');
  }
}
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
  const tokens = new Map<string, string>();
  const receiver = await uploadReceiver(page, items, images, files, tokens);
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
    if (method === 'OPTIONS') {
      if (url.pathname.startsWith(storagePrefix)) {
        const allowed = !url.search && receiver.reservedOwner(url.pathname) && receiver.preflightAllowed(request.headers());
        await route.fulfill({ status: allowed ? 204 : 403, headers: receiver.cors });
      } else await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === '/auth/v1/token') {
      const body = request.postDataJSON() as { email?: string; password?: string };
      const id = body.email === 'user-a@example.test' ? owners.a : body.email === 'user-b@example.test' ? owners.b : null;
      if (!id || body.password !== 'fictional-test-password') { await json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400); return; }
      const claims = { sub: id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID() };
      const accessToken = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.browser-fixture`;
      tokens.set('Bearer ' + accessToken, id);
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
        if (url.search || receiver.reservedOwner(url.pathname) !== owner || !receiver.credentialsAllowed(request.headers(), owner)) {
          await json({ message: 'Fixture upload rejected.' }, 403); return;
        }
        try { await route.continue({ url: receiver.url + url.pathname }); }
        catch { await receiver.close(); throw new Error('Fixture continuation failed.'); }
        return;
      }
      const bytes = files.get(path);
      if (!bytes) { await json({ message: 'Not found' }, 404); return; }
      await route.fulfill({ status: 200, body: bytes, contentType: 'image/jpeg' }); return;
    }
    await json({ message: 'Unknown browser fixture route' }, 404);
  }).catch(async () => { await receiver.close(); throw new Error('Fixture routing unavailable.'); });
  return { profiles, items, images, files, requests, fixture, uploadWire: receiver.state };
}

export async function signIn(page: Page, account: 'a' | 'b' = 'a') {
  await page.locator('#email').fill(`user-${account}@example.test`);
  await page.locator('#password').fill('fictional-test-password');
  await page.locator('button[type="submit"]').click();
}
