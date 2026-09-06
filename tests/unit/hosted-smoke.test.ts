import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HOSTED_URL, runHostedSmoke, validateHostedEnvironment } from '../../scripts/hosted-smoke.mjs';
import type { HostedEnvironment, HostedOwner } from '../../scripts/hosted-smoke.mjs';

const image = readFileSync(new URL('../security/fixture.jpg', import.meta.url));
const hash = createHash('sha256').update(image).digest('hex');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function token(uid: string, overrides = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256' })}.${encode({
    sub: uid, role: 'authenticated', aud: 'authenticated', iss: `${HOSTED_URL}/auth/v1`,
    exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false, ...overrides,
  })}.unit_test_signature`;
}
function environment(): HostedEnvironment {
  return {
    ALLOW_HOSTED_SMOKE: '1', HOSTED_SUPABASE_URL: HOSTED_URL,
    HOSTED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only',
    HOSTED_A_USER_ID: id(1), HOSTED_A_ACCESS_TOKEN: token(id(1)),
    HOSTED_A_ITEM_ID: id(3), HOSTED_A_IMAGE_ID: id(5),
    HOSTED_B_USER_ID: id(2), HOSTED_B_ACCESS_TOKEN: token(id(2)),
    HOSTED_B_ITEM_ID: id(4), HOSTED_B_IMAGE_ID: id(6),
  };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});
const media = () => new Response(image, { headers: { 'content-type': 'image/jpeg' } });
type Request = { url: URL; owner: HostedOwner; foreign: boolean; number: number };
type Override = (request: Request) => Response | undefined;
function service(env: HostedEnvironment, override: Override = () => undefined) {
  const { owners } = validateHostedEnvironment(env);
  let number = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(HOSTED_URL);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(['apikey', 'authorization']);
    const owner = owners.find((candidate) => headers.get('authorization') === 'Bearer ' + candidate.token)!;
    expect(owner).toBeDefined();
    const targetId = url.searchParams.get('owner_id')?.slice(3) ?? url.searchParams.get('id')?.slice(3);
    const target = owners.find((candidate) => [candidate.uid, candidate.item, candidate.image].includes(targetId ?? '')
      || url.pathname.includes(`/${candidate.uid}/`)) ?? owner;
    const foreign = owner !== target;
    const replacement = override({ url, owner, foreign, number: ++number });
    if (replacement) return replacement;
    if (url.pathname === '/auth/v1/user') {
      return json({ id: owner.uid, role: 'authenticated', aud: 'authenticated', is_anonymous: false });
    }
    if (url.pathname.startsWith('/storage/v1/object/authenticated/wardrobe/')) {
      return foreign ? json({ statusCode: '404', error: 'not_found' }, 400) : media();
    }
    if (foreign) return json([]);
    if (url.pathname === '/rest/v1/profiles') return json([{ owner_id: owner.uid }]);
    if (url.pathname === '/rest/v1/items') return json([{ id: owner.item, owner_id: owner.uid, deleted_at: null }]);
    expect(url.pathname).toBe('/rest/v1/item_images');
    return json([{
      id: owner.image, owner_id: owner.uid, item_id: owner.item, state: 'ready',
      main_path: `${owner.uid}/${owner.item}/${owner.image}/main.jpg`,
      thumb_path: `${owner.uid}/${owner.item}/${owner.image}/thumb.jpg`,
      main_bytes: image.length, thumb_bytes: image.length, main_sha256: hash, thumb_sha256: hash,
    }]);
  });
}

describe('hosted read-only smoke guards (mock contracts, not hosted RLS proof)', () => {
  it('requires every private operator input before making any request', async () => {
    for (const field of Object.keys(environment())) {
      const env = environment();
      delete env[field];
      const fetcher = vi.fn<typeof fetch>();
      expect(await runHostedSmoke(env, fetcher)).toEqual({ status: 'BLOCKED', exitCode: 2 });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it.each([
    `${HOSTED_URL}/`, `${HOSTED_URL}:443`, `${HOSTED_URL}/path`, `${HOSTED_URL}?x=1`,
    `${HOSTED_URL}#x`, `${HOSTED_URL}.evil.test`, HOSTED_URL.replace('https:', 'http:'),
    'http://127.0.0.1:54321', 'https://other.supabase.co', HOSTED_URL.toUpperCase(),
    HOSTED_URL.replace('https://', 'https://user@'),
  ])('refuses every non-exact URL: %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await runHostedSmoke({ ...environment(), HOSTED_SUPABASE_URL: url }, fetcher)).exitCode).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'GITHUB_ENV', 'GITHUB_ACTIONS', 'GH_TOKEN', 'GITHUB_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL', 'PGPASSWORD', 'SUPABASE_ACCESS_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTPS_PROXY', 'TEST_A_PASSWORD',
    'UNRELATED_TOKEN', 'HOSTED_A_EMAIL',
  ])('refuses inherited environment, including empty entries: %s', async (name) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const value of ['', 'private-unit-marker']) {
      expect((await runHostedSmoke({ ...environment(), [name]: value }, fetcher)).exitCode).toBe(2);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { role: ['service', 'role'].join('_') }, { role: 'anon' }, { sub: id(2) },
    { aud: 'other' }, { iss: 'https://other.supabase.co/auth/v1' }, { exp: 0 },
    { exp: '9999999999' }, { is_anonymous: true },
  ])('refuses unsafe token claims before network: %j', async (claims) => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await runHostedSmoke({
      ...environment(), HOSTED_A_ACCESS_TOKEN: token(id(1), claims),
    }, fetcher)).exitCode).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed/privileged keys, tokens, UUIDs, duplicate owners and missing opt-in', async () => {
    const env = environment();
    const cases = [
      { ALLOW_HOSTED_SMOKE: 'true' },
      { HOSTED_SUPABASE_PUBLISHABLE_KEY: ['sb', 'secret', 'unit'].join('_') },
      { HOSTED_SUPABASE_PUBLISHABLE_KEY: token(id(1), { role: 'anon' }) },
      { HOSTED_A_ACCESS_TOKEN: 'not-a-token' },
      { HOSTED_A_ACCESS_TOKEN: 'e30.bnVsbA.signature' },
      { HOSTED_A_ITEM_ID: `${id(3)}&select=*` },
      { HOSTED_B_USER_ID: id(1), HOSTED_B_ACCESS_TOKEN: env.HOSTED_A_ACCESS_TOKEN },
      { HOSTED_B_ITEM_ID: env.HOSTED_A_ITEM_ID },
      { HOSTED_B_IMAGE_ID: env.HOSTED_A_IMAGE_ID },
    ];
    for (const change of cases) {
      const fetcher = vi.fn<typeof fetch>();
      expect((await runHostedSmoke({ ...env, ...change }, fetcher)).exitCode).toBe(2);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('requires server-verified identities even with plausible token claims', async () => {
    for (const user of [
      {}, null, { id: id(2), role: 'authenticated', aud: 'authenticated', is_anonymous: false },
      { id: id(1), role: 'authenticated', aud: 'authenticated', is_anonymous: true },
    ]) {
      const env = environment();
      const fetcher = service(env, () => json(user));
      expect((await runHostedSmoke(env, fetcher)).exitCode).toBe(2);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('requires both positive fixtures, both foreign directions, then both positive liveness checks', async () => {
    const env = environment();
    const requests: Request[] = [];
    const fetcher = service(env, (request) => { requests.push(request); return undefined; });
    expect(await runHostedSmoke(env, fetcher)).toEqual({ status: 'PASS', exitCode: 0 });
    expect(requests).toHaveLength(34);
    expect(requests.slice(0, 12).every((r) => !r.foreign)).toBe(true);
    expect(requests.slice(12, 22).every((r) => r.foreign)).toBe(true);
    expect(requests.slice(22).every((r) => !r.foreign)).toBe(true);
    expect(requests.filter((r) => r.url.pathname === '/auth/v1/user')).toHaveLength(4);
  });
  it('accepts case-insensitive MIME types with whitespace before parameters', async () => {
    const env = environment();
    const fetcher = service(env);
    const withParameters: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init);
      response.headers.set('content-type', response.headers.get('content-type')!.toUpperCase() + ' ; charset=utf-8');
      return response;
    };
    expect(await runHostedSmoke(env, withParameters)).toEqual({ status: 'PASS', exitCode: 0 });
  });
  it.each(['/rest/v1/profiles', '/rest/v1/items', '/rest/v1/item_images'])('blocks missing own fixtures: %s', async (route) => {
    const env = environment();
    const fetcher = service(env, ({ url }) => url.pathname === route ? json([]) : undefined);
    expect((await runHostedSmoke(env, fetcher)).exitCode).toBe(2);
  });
  it.each([1, 2])('fails foreign row or media exposure in direction %s', async (ownerNumber) => {
    for (const kind of ['rows', 'media']) {
      const env = environment();
      const fetcher = service(env, ({ url, foreign, owner }) => {
        if (!foreign || owner.uid !== id(ownerNumber)) return undefined;
        return url.pathname.startsWith('/rest/') && kind === 'rows' ? json([{ owner_id: id(9) }])
          : url.pathname.startsWith('/storage/') && kind === 'media' ? media() : undefined;
      });
      expect(await runHostedSmoke(env, fetcher)).toEqual({ status: 'FAIL', exitCode: 1 });
    }
  });
  it.each([300, 301, 302, 307, 401, 403, 404, 429, 500, 503])('does not accept arbitrary HTTP %s as denial', async (status) => {
    const env = environment();
    const fetcher = service(env, ({ foreign }) => foreign ? json({}, status) : undefined);
    expect((await runHostedSmoke(env, fetcher)).exitCode).toBe(2);
  });
  it('does not turn generic Storage errors or invalid bodies into denial evidence', async () => {
    for (const response of [json({}, 404), json({ error: 'unavailable' }, 400), new Response('private-unit-marker', { status: 404 })]) {
      const env = environment();
      const fetcher = service(env, ({ foreign, url }) => foreign && url.pathname.startsWith('/storage/') ? response : undefined);
      expect((await runHostedSmoke(env, fetcher)).exitCode).toBe(2);
    }
  });
  it('requires own bytes/hash and post-denial liveness, not merely prior success', async () => {
    for (const override of [
      ({ url, foreign }: Request) => !foreign && url.pathname.startsWith('/storage/') ? new Response('wrong bytes', { headers: { 'content-type': 'image/jpeg' } }) : undefined,
      ({ number }: Request) => number === 23 ? json({}, 503) : undefined,
      ({ number }: Request) => number === 25 ? json([]) : undefined,
      ({ number }: Request) => number === 34 ? json({}, 404) : undefined,
    ]) {
      const env = environment();
      expect((await runHostedSmoke(env, service(env, override))).exitCode).toBe(2);
    }
  });
  it('bounds bodies, suppresses transport details and preserves failure when cancellation fails', async () => {
    const env = environment();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-unit-marker'));
    expect(await runHostedSmoke(env, transport)).toEqual({ status: 'BLOCKED', exitCode: 2 });
    const oversized = service(env, () => new Response('x'.repeat(65_537), { headers: { 'content-type': 'application/json' } }));
    expect((await runHostedSmoke(env, oversized)).exitCode).toBe(2);
    const cancelFailure = service(env, ({ foreign, url }) => {
      if (!foreign || !url.pathname.startsWith('/storage/')) return undefined;
      return new Response(new ReadableStream({ cancel() { throw new Error('private-unit-marker'); } }));
    });
    expect(await runHostedSmoke(env, cancelFailure)).toEqual({ status: 'FAIL', exitCode: 1 });
  });
  it('CLI refuses absent inputs/extra arguments without private output or a live hosted call', () => {
    const script = fileURLToPath(new URL('../../scripts/hosted-smoke.mjs', import.meta.url));
    for (const args of [[], ['private-unit-marker']]) {
      const child = spawnSync(process.execPath, [script, ...args], { env: {}, encoding: 'utf8', timeout: 5000 });
      expect(child.status).toBe(2);
      expect(child.stdout).toBe('Hosted read-only smoke: BLOCKED; no private details logged.\n');
      expect(child.stderr).toBe('');
    }
  });
});
