import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshRecoveryLink, parseRecoveryCallback, type RecoveryLink } from '../../src/auth/recovery-callback';
import { passwordProblem, recoveryError, recoveryPasswordMaximumBytes, recoveryPasswordMinimum } from '../../src/auth/recovery';
import { makeRecoveryClient } from '../../src/data/client';
import { fetchProfile } from '../../src/data/profile';

const origin = 'http://127.0.0.1:5173';
const config = { url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_unit_fixture', version: 'unit' };
const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
function capability(exp = Math.floor(Date.now() / 1000) + 3600): RecoveryLink {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    accessToken: [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: owner, role: 'authenticated', aud: 'authenticated', exp }), 'c2lnbmF0dXJl'].join('.'),
    refreshToken: 'unused-opaque-refresh', subject: owner, expiresAt: exp,
  };
}
function callback(link = capability()) {
  return `${origin}/#${new URLSearchParams({
    access_token: link.accessToken, refresh_token: link.refreshToken, expires_at: String(link.expiresAt),
    expires_in: '3600', token_type: 'bearer', type: 'recovery',
  })}`;
}
const user = { id: owner, email: 'user-a@example.test', aud: 'authenticated', role: 'authenticated', is_anonymous: false };
const profile = { owner_id: owner, display_name: 'Fictional', ui_language: null, timezone: 'Europe/Helsinki', currency: 'EUR', version: 1 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded recovery callback intent, not cryptographic provenance', () => {
  it('accepts only the standard fragment and does not treat an opaque refresh token as verified', () => {
    const link = capability();
    link.refreshToken = 'unrelated-opaque-token';
    expect(parseRecoveryCallback(callback(link), origin, false)).toEqual({ kind: 'link', link });
  });
  it('accepts the pinned Auth standard empty sb marker only once', () => {
    expect(parseRecoveryCallback(callback() + '&sb=', origin, false).kind).toBe('link');
    expect(parseRecoveryCallback(callback() + '&sb=unexpected', origin, false).kind).toBe('invalid');
    expect(parseRecoveryCallback(callback() + '&sb=&sb=', origin, false).kind).toBe('invalid');
  });
  it.each(['', '#/wardrobe', '#/items/new', '#main'])('ignores normal route %s', hash => {
    expect(parseRecoveryCallback(`${origin}/${hash}`, origin, false)).toEqual({ kind: 'none' });
  });
  it.each(['code=x', 'token_hash=x&type=recovery', 'error=bad&error_description=private', '%61ccess_token%3Dprivate', '/recovery'])('rejects unsupported callbacks', fragment => {
    expect(parseRecoveryCallback(`${origin}/#${fragment}`, origin, false).kind).toBe('invalid');
  });
  it.each(['signup', 'invite', 'magiclink', 'email_change', 'oauth'])('rejects type %s', type => {
    expect(parseRecoveryCallback(callback().replace('type=recovery', `type=${type}`), origin, false).kind).toBe('invalid');
  });
  it.each(['&type=recovery', '&provider_token=private', '&code=x', '&access_token=x', '&unknown=x'])('rejects duplicates and unexpected fields', suffix => {
    expect(parseRecoveryCallback(callback() + suffix, origin, false).kind).toBe('invalid');
  });
  it('rejects mixed query/fragment, nonroot paths, foreign origins, oversized and absent fields', () => {
    for (const address of [
      callback().replace('/#', '/?code=x#'), callback().replace('/#', '/callback#'),
      callback().replace(origin, 'https://example.invalid'), callback() + 'x'.repeat(16_384),
      callback().replace('&refresh_token=unused-opaque-refresh', ''),
    ]) expect(parseRecoveryCallback(address, origin, false).kind).toBe('invalid');
  });
  it('fails closed at the 150-second margin and on inconsistent expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 150;
    expect(freshRecoveryLink(capability(exp))).toBe(false);
    expect(parseRecoveryCallback(callback(capability(exp)), origin, false).kind).toBe('invalid');
    expect(parseRecoveryCallback(callback().replace('expires_in=3600', 'expires_in=1'), origin, false).kind).toBe('invalid');
  });
  it('refuses any occupied or initialized normal page before identity lookup', () => {
    expect(parseRecoveryCallback(callback(), origin, true)).toEqual({ kind: 'conflict' });
  });
});

describe('raw password and safe errors', () => {
  it('uses one floor and rejects rather than normalizes or truncates', () => {
    expect(recoveryPasswordMinimum).toBe(24);
    expect(recoveryPasswordMaximumBytes).toBe(72);
    const raw = ' '.repeat(24);
    expect(passwordProblem(raw, raw)).toBeNull();
    expect(passwordProblem('a'.repeat(23), 'a'.repeat(23))).toBe('recovery.short');
    expect(passwordProblem('a'.repeat(72), 'a'.repeat(72))).toBeNull();
    expect(passwordProblem('a'.repeat(73), 'a'.repeat(73))).toBe('recovery.long');
    expect(passwordProblem('ä'.repeat(36), 'ä'.repeat(36))).toBeNull();
    expect(passwordProblem('ä'.repeat(37), 'ä'.repeat(37))).toBe('recovery.long');
    expect(passwordProblem('x'.repeat(24), 'x'.repeat(24) + ' ')).toBe('recovery.mismatch');
    expect(passwordProblem('é'.repeat(24), 'e\u0301'.repeat(24))).toBe('recovery.mismatch');
  });
  it('never exposes raw server messages', () => {
    expect(recoveryError({ message: 'private email and password' })).toBe('recovery.unavailable');
    expect(recoveryError({ status: 429 })).toBe('recovery.throttled');
    expect(recoveryError({ code: 'reauthentication_needed' })).toBe('recovery.reauthentication');
    expect(recoveryError({ code: 'same_password' })).toBe('recovery.same');
  });
});

describe('actual SDK Auth and profile transport guard', () => {
  function backend(status = 200) {
    const calls: { url: URL; method: string; bearer: string | null; credentials: RequestCredentials | undefined; redirect: RequestRedirect | undefined; cache: RequestCache | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({ url, method: request.method, bearer: request.headers.get('authorization'), credentials: init?.credentials, redirect: init?.redirect, cache: init?.cache });
      if (url.pathname === '/auth/v1/logout') return new Response(null, { status });
      return new Response(JSON.stringify(url.pathname === '/rest/v1/profiles' ? [profile] : url.pathname === '/auth/v1/recover' ? {} : user), { headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }
  it('retains original access for server identity and exact own profile, never the opaque refresh', async () => {
    const calls = backend();
    const link = capability();
    const transport = makeRecoveryClient(config, link, `${origin}/`);
    try {
      expect((await transport.client.auth.setSession({ access_token: link.accessToken, refresh_token: 'other-owner-unused' })).error).toBeNull();
      transport.bindOwner(owner);
      expect((await fetchProfile(transport.client, owner, transport.signal)).owner_id).toBe(owner);
      expect(calls.map(call => call.url.pathname)).toEqual(['/auth/v1/user', '/rest/v1/profiles']);
      for (const call of calls) {
        expect(call.bearer).toBe('Bearer ' + link.accessToken);
        expect(call).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
      }
      expect(calls[1]!.url.searchParams.get('select')).toBe('owner_id,display_name,ui_language,timezone,currency,version');
      expect(calls[1]!.url.searchParams.get('owner_id')).toBe(`eq.${owner}`);
    } finally { transport.dispose(); }
  });
  it('denies all token grants, foreign profile filters, extra projections and all private tables before network', async () => {
    const calls = backend(), link = capability();
    const transport = makeRecoveryClient(config, link, `${origin}/`);
    try {
      await transport.client.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
      transport.bindOwner(owner);
      calls.length = 0;
      expect((await transport.client.auth.signInWithPassword({ email: 'user-a@example.test', password: 'synthetic' })).error).not.toBeNull();
      expect((await transport.client.auth.refreshSession({ refresh_token: 'unused' })).error).not.toBeNull();
      await transport.client.from('profiles').select('*').eq('owner_id', owner);
      await transport.client.from('profiles').select('owner_id').eq('owner_id', other);
      await transport.client.from('items').select('id');
      expect(calls).toHaveLength(0);
    } finally { transport.dispose(); }
  });
  it('disposal and near-expiry prevent credentialed network requests', async () => {
    const calls = backend();
    const expired = makeRecoveryClient(config, capability(Math.floor(Date.now() / 1000) + 149), `${origin}/`);
    await expired.client.auth.getUser(capability().accessToken);
    expired.dispose();
    const current = makeRecoveryClient(config, capability(), `${origin}/`);
    current.dispose();
    await current.client.auth.getUser(capability().accessToken);
    expect(calls).toHaveLength(0);
  });
  it.each([204, 401, 403, 404])('requires actual affirmative logout, not swallowed SDK status %s', async status => {
    const calls = backend(status), link = capability();
    const transport = makeRecoveryClient(config, link, `${origin}/`);
    try {
      await transport.client.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
      transport.bindOwner(owner);
      await transport.client.auth.signOut({ scope: 'global' });
      expect(calls.filter(call => call.url.pathname === '/auth/v1/logout')).toHaveLength(0);
      await transport.client.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
      transport.allowUpdate();
      expect((await transport.client.auth.updateUser({ password: 'x'.repeat(24) })).error).toBeNull();
      transport.confirmSuccess();
      await transport.client.auth.signOut({ scope: 'global' });
      expect(transport.logoutAffirmed).toBe(status === 204);
      expect(calls.filter(call => call.url.pathname === '/auth/v1/logout')).toHaveLength(1);
    } finally { transport.dispose(); }
  });
  it('request mode permits only the exact public recovery request, without PKCE', async () => {
    const calls = backend();
    const transport = makeRecoveryClient(config, null, `${origin}/`);
    try {
      expect((await transport.client.auth.resetPasswordForEmail('user-a@example.test', { redirectTo: `${origin}/` })).error).toBeNull();
      await transport.client.auth.resetPasswordForEmail('user-a@example.test', { redirectTo: 'https://example.invalid/' });
      await transport.client.auth.getUser(capability().accessToken);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.pathname).toBe('/auth/v1/recover');
    } finally { transport.dispose(); }
  });
  it.each([
    [{ code: 'weak_password', message: 'Password should be at least 30 characters.' }, 30],
    [{ error_code: 'weak_password', msg: 'Password should be at least 32 characters.' }, 32],
    [{ code: 'weak_password', message: 'Password should be at least 99 characters.' }, undefined],
    [{ code: 'weak_password', message: 'untrusted text 30 characters' }, undefined],
  ])('retains only allowlisted policy codes and bounded numeric hints', async (body, minimum) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 422 })));
    const transport = makeRecoveryClient(config, null, `${origin}/`);
    try {
      await transport.client.auth.resetPasswordForEmail('user-a@example.test', { redirectTo: `${origin}/` });
      expect(transport.errorDetails).toEqual(minimum ? { status: 422, code: 'weak_password', minimum } : { status: 422, code: 'weak_password' });
    } finally { transport.dispose(); }
  });
  it('oversized upstream bodies and network failures fail closed without SDK retries', async () => {
    const network = vi.fn(async () => new Response('x'.repeat(262_145)));
    vi.stubGlobal('fetch', network);
    const transport = makeRecoveryClient(config, null, `${origin}/`);
    try {
      expect((await transport.client.auth.resetPasswordForEmail('user-a@example.test', { redirectTo: `${origin}/` })).error).not.toBeNull();
      network.mockRejectedValueOnce(new Error('private upstream information'));
      expect((await transport.client.auth.resetPasswordForEmail('user-a@example.test', { redirectTo: `${origin}/` })).error).not.toBeNull();
      expect(network).toHaveBeenCalledTimes(2);
      expect(transport.errorDetails).toEqual({ status: 0 });
    } finally { transport.dispose(); }
  });
});
