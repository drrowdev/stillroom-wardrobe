import { test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import { parseProfile } from '../../src/data/profile';

const root = 'http://127.0.0.1:5173/';
const projection = 'owner_id,display_name,ui_language,timezone,currency,version';
function check(value: unknown): asserts value {
  if (!value) throw new Error('Local recovery gate failed.');
}
type MailSummary = { ID: string; Created: string; To: { Address: string }[] };
async function mail(path: string): Promise<unknown> {
  check(/^\/api\/v1\/(?:messages\?limit=1000|message\/[A-Za-z0-9_-]{1,128})$/.test(path));
  const response = await fetch(`http://127.0.0.1:54324${path}`, {
    cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5_000),
  });
  check(response.ok);
  const bytes = await response.arrayBuffer();
  check(bytes.byteLength <= 1_048_576);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
async function messages(): Promise<MailSummary[]> {
  const result = await mail('/api/v1/messages?limit=1000') as { messages?: MailSummary[] };
  check(Array.isArray(result.messages));
  return result.messages;
}

test('LOCAL protocol feasibility only; not recovery UI acceptance', async ({ browser }) => {
  let stage = 'local configuration';
  let primary: string | null = null;
  let restored = false;
  let attempted = false;
  let changed = false;
  let affirmativeLogout = false;
  let originalAccess: string | null = null;
  let aId: string | null = null;
  let bId: string | null = null;
  const clients: SupabaseClient[] = [];
  const abort = new AbortController();
  const newPassword = randomBytes(54).toString('base64url');
  const env = process.env;
  validateSessionEnvironment(env);
  const base = assertLocalApi(env.SUPABASE_URL!);
  const key = env.SUPABASE_PUBLISHABLE_KEY!;
  async function transport(input: RequestInfo | URL, init: RequestInit = {}, isolated = false) {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address);
    check(address.startsWith(`${base}/`) && url.origin === base && !url.username && !url.password && !url.hash);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    check(headers.get('apikey') === key);
    if (isolated) {
      const publicRequest = method === 'POST' && url.pathname === '/auth/v1/recover' && !originalAccess;
      const ownProfile = method === 'GET' && url.pathname === '/rest/v1/profiles' && aId
        && url.searchParams.get('owner_id') === `eq.${aId}` && url.searchParams.get('select') === projection;
      const user = ['GET', 'PUT'].includes(method) && url.pathname === '/auth/v1/user' && !url.search;
      const logout = method === 'POST' && url.pathname === '/auth/v1/logout' && changed && url.search === '?scope=global';
      check(publicRequest || (originalAccess && (ownProfile || user || logout)));
      if (!publicRequest) {
        check(headers.get('authorization') === 'Bearer ' + originalAccess);
        const claims = JSON.parse(Buffer.from(originalAccess!.split('.')[1]!, 'base64url').toString()) as { exp: number };
        check(claims.exp * 1000 > Date.now() + 150_000);
      }
    } else check(['/auth/v1/token', '/auth/v1/user', '/rest/v1/profiles'].includes(url.pathname));
    const response = await fetch(input, {
      ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(isolated ? [abort.signal] : [])]),
    });
    const bytes = await response.arrayBuffer();
    check(bytes.byteLength <= 262_144);
    if (isolated && url.pathname === '/auth/v1/logout') affirmativeLogout = response.ok;
    return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: response.headers });
  }
  function client(isolated = false) {
    const result = createClient(base, key, {
      auth: {
        storageKey: `local-protocol-${clients.length}`, persistSession: false,
        autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit', debug: false,
      },
      global: { fetch: (input, init) => transport(input, init, isolated) },
    });
    clients.push(result);
    return result;
  }
  async function login(label: 'A' | 'B', password = env[`TEST_${label}_PASSWORD`]!) {
    const c = client();
    const result = await c.auth.signInWithPassword({ email: env[`TEST_${label}_EMAIL`]!, password });
    check(!result.error && result.data.user && result.data.session);
    return { c, user: result.data.user };
  }
  async function profile(c: SupabaseClient, id: string) {
    const { data, error } = await c.from('profiles').select(projection).eq('owner_id', id).single();
    check(!error);
    return JSON.stringify(parseProfile(data, id));
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const config = await readFile(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
    check(/secure_password_change = true/.test(config) && /minimum_password_length = 24/.test(config));
    check(new TextEncoder().encode(newPassword).length === 72);
    stage = 'original ordinary logins and own profiles';
    const a = await login('A'), b = await login('B');
    aId = a.user.id; bId = b.user.id; check(aId !== bId);
    const aBefore = await profile(a.c, aId), bBefore = await profile(b.c, bId);
    let receiveCallback: ((value: string) => void) | undefined;
    const captured = new Promise<string>(resolve => { receiveCallback = resolve; });
    await context.exposeBinding('receiveProtocolCallback', (_, value: unknown) => {
      check(typeof value === 'string' && value.length < 16_384);
      receiveCallback?.(value);
    });
    await context.addInitScript(() => {
      if (location.origin === 'http://127.0.0.1:5173') {
        const fragment = location.hash;
        history.replaceState(null, '', '/#/recovery');
        const receiver = window as unknown as { receiveProtocolCallback: (value: string) => Promise<void> };
        void receiver.receiveProtocolCallback(fragment);
      }
    });
    stage = 'prior mail cursor';
    const prior = new Set((await messages()).map(message => message.ID));
    const started = Date.now();
    const recovery = client(true);
    stage = 'single recovery request';
    const requested = await recovery.auth.resetPasswordForEmail(env.TEST_A_EMAIL!, { redirectTo: root });
    check(!requested.error);
    stage = 'fresh recipient and time-correlated mail';
    let messageId: string | null = null;
    const deadline = started + 20_000;
    while (Date.now() < deadline) {
      const found = (await messages()).filter(message => !prior.has(message.ID)
        && Date.parse(message.Created) >= started - 1000
        && message.To.some(recipient => recipient.Address === env.TEST_A_EMAIL));
      check(found.length <= 1);
      if (found[0]) { messageId = found[0].ID; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    check(messageId);
    stage = 'bounded mail detail and actual link shape';
    const message = await mail(`/api/v1/message/${messageId}`) as { To: { Address: string }[]; HTML: string };
    check(message.To.some(recipient => recipient.Address === env.TEST_A_EMAIL));
    const links = [...message.HTML.matchAll(/href="([^"]+)"/g)]
      .map(match => match[1]!.replaceAll('&amp;', '&')).filter(value => value.startsWith(`${base}/auth/v1/verify?`));
    check(links.length === 1);
    const link = new URL(links[0]!);
    check(link.origin === base && link.pathname === '/auth/v1/verify'
      && link.searchParams.get('type') === 'recovery' && new URL(link.searchParams.get('redirect_to')!).href === root);
    stage = 'single actual link consumption in no-opener page';
    const page = await context.newPage();
    await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    stage = 'no-opener and callback capture';
    check(await page.evaluate(() => window.opener === null));
    const callback = await Promise.race([
      captured,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Callback unavailable.')), 5_000)),
    ]);
    stage = 'standard recovery fragment fields';
    const fields = new URLSearchParams(callback.slice(1));
    check(fields.get('type') === 'recovery' && fields.get('token_type') === 'bearer');
    originalAccess = fields.get('access_token');
    const refresh = fields.get('refresh_token');
    check(originalAccess && refresh);
    stage = 'original-access server identity and enabled profile';
    const verified = await recovery.auth.getUser(originalAccess);
    check(!verified.error && verified.data.user?.id === aId
      && verified.data.user.email === env.TEST_A_EMAIL && !verified.data.user.is_anonymous);
    const session = await recovery.auth.setSession({ access_token: originalAccess, refresh_token: refresh });
    check(!session.error && session.data.user?.id === aId);
    check(await profile(recovery, aId) === aBefore);
    stage = 'secure self password update with 72 UTF8 bytes';
    attempted = true;
    const updated = await recovery.auth.updateUser({ password: newPassword });
    check(!updated.error && updated.data.user?.id === aId);
    changed = true;
    stage = 'affirmative recovered-owner global revocation';
    const signedOut = await recovery.auth.signOut({ scope: 'global' });
    check(!signedOut.error && affirmativeLogout);
    stage = 'new password login and old password refusal';
    const anew = await login('A', newPassword);
    check(anew.user.id === aId && await profile(anew.c, aId) === aBefore);
    const old = await client().auth.signInWithPassword({ email: env.TEST_A_EMAIL!, password: env.TEST_A_PASSWORD! });
    check(old.error?.code === 'invalid_credentials' && !old.data.session);
    stage = 'preexisting other-owner refresh and unchanged profile';
    const refreshed = await b.c.auth.refreshSession();
    check(!refreshed.error && refreshed.data.user?.id === bId && await profile(b.c, bId) === bBefore);
  } catch { primary = stage; }
  finally {
    abort.abort();
    try {
      if (attempted) {
        let fresh: Awaited<ReturnType<typeof login>> | null;
        try { fresh = await login('A', newPassword); } catch { fresh = null; }
        if (fresh) {
          const result = await fresh.c.auth.updateUser({ password: env.TEST_A_PASSWORD! });
          check(!result.error && result.data.user?.id === aId);
        }
      }
      const a = await login('A'), b = await login('B');
      check(a.user.id === aId && b.user.id === bId);
      await profile(a.c, a.user.id); await profile(b.c, b.user.id);
      restored = true;
    } catch { /* Preserve the primary stage; never print fixture or SDK values. */ }
    await context.close().catch(() => {});
    for (const c of clients) await c.auth.stopAutoRefresh();
  }
  if (primary || !restored) throw new Error(`BLOCKED: ${primary ?? 'fixture reconciliation'}; originals verified: ${restored}. STOP shared suites if false.`);
});
