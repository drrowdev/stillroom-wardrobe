import { test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

test('LOCAL real recovery UI, no-opener/new-context isolation and ordinary restoration', async ({ browser }) => {
  let stage = 'local configuration';
  let primary: string | null = null;
  let restored = false;
  let attempted = false;
  let affirmativeLogout = false;
  let originalBearer: string | null = null;
  let aId: string | null = null;
  let bId: string | null = null;
  const clients: SupabaseClient[] = [];
  const newPassword = randomBytes(54).toString('base64url');
  const env = process.env;
  validateSessionEnvironment(env);
  const base = assertLocalApi(env.SUPABASE_URL!);
  const key = env.SUPABASE_PUBLISHABLE_KEY!;
  async function transport(input: RequestInfo | URL, init: RequestInit = {}) {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address);
    check(address.startsWith(`${base}/`) && url.origin === base && !url.username && !url.password && !url.hash);
    const headers = new Headers(init.headers);
    check(headers.get('apikey') === key);
    check(['/auth/v1/token', '/auth/v1/user'].includes(url.pathname)
      || url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/storage/v1/'));
    const response = await fetch(input, {
      ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const bytes = await response.arrayBuffer();
    check(bytes.byteLength <= 262_144);
    return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: response.headers });
  }
  function client() {
    const result = createClient(base, key, {
      auth: {
        storageKey: `local-recovery-proof-${clients.length}`, persistSession: false,
        autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit', debug: false,
      },
      global: { fetch: transport },
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
  async function uiLogin(page: Page, label: 'A' | 'B', password = env[`TEST_${label}_PASSWORD`]!) {
    await page.goto(root);
    await page.locator('#email').fill(env[`TEST_${label}_EMAIL`]!);
    await page.locator('#password').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.locator('#wardrobe-title').waitFor({ state: 'visible', timeout: 20_000 });
  }
  const fixtures: { label: 'A' | 'B'; owner: string; item: string; image: string; paths: string[]; language: string | null }[] = [];
  const jpg = await readFile(new URL('../security/fixture.jpg', import.meta.url));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  async function createFixture(label: 'A' | 'B', c: SupabaseClient, owner: string) {
    const originalProfile = JSON.parse(await profile(c, owner)) as { ui_language: string | null };
    const fixture = { label, owner, item: randomUUID(), image: randomUUID(), paths: [] as string[], language: originalProfile.ui_language };
    fixtures.push(fixture);
    check(!(await c.from('items').insert({ id: fixture.item, owner_id: owner, title: `Fictional recovery garment ${label}`, category: 'top' })).error);
    const reservation = await c.from('item_images').insert({
      id: fixture.image, owner_id: owner, item_id: fixture.item, main_bytes: jpg.length, thumb_bytes: jpg.length,
      main_sha256: digest(jpg), thumb_sha256: digest(jpg), width: 2, height: 2, alt_text: 'Fictional recovery image',
    }).select('main_path,thumb_path').single();
    check(!reservation.error && reservation.data);
    fixture.paths.push(reservation.data.main_path as string, reservation.data.thumb_path as string);
    for (const path of fixture.paths) check(!(await c.storage.from('wardrobe').upload(path, jpg, { contentType: 'image/jpeg', upsert: false })).error);
    check(!(await c.rpc('commit_image', { p_image_id: fixture.image })).error);
    return fixture;
  }
  async function verifyFixture(c: SupabaseClient, fixture: typeof fixtures[number]) {
    const item = await c.from('items').select('id,owner_id,title,category,version').eq('owner_id', fixture.owner).eq('id', fixture.item).single();
    check(!item.error && item.data?.title === `Fictional recovery garment ${fixture.label}` && item.data.version === 1);
    for (const path of fixture.paths) {
      const image = await c.storage.from('wardrobe').download(path);
      check(!image.error && image.data && digest(new Uint8Array(await image.data.arrayBuffer())) === digest(jpg));
    }
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requester = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const config = await readFile(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
    check(/secure_password_change = true/.test(config) && /minimum_password_length = 24/.test(config));
    check(new TextEncoder().encode(newPassword).length === 72);
    stage = 'original ordinary logins and own profiles';
    const a = await login('A'), b = await login('B');
    aId = a.user.id; bId = b.user.id; check(aId !== bId);
    stage = 'ordinary private fixtures and initial UI sessions';
    const fa = await createFixture('A', a.c, aId), fb = await createFixture('B', b.c, bId);
    // Normal UI initialization is separate from recovery and restored in finally.
    const initial = await browser.newContext({ serviceWorkers: 'block' });
    const initialPage = await initial.newPage();
    try { await uiLogin(initialPage, 'A'); } finally { await initial.close(); }
    const bPage = await context.newPage();
    await uiLogin(bPage, 'B');
    await bPage.getByText('Fictional recovery garment B', { exact: true }).waitFor();
    const aBefore = await profile(a.c, aId), bBefore = await profile(b.c, bId);
    stage = 'prior mail cursor';
    const prior = new Set((await messages()).map(message => message.ID));
    const requestPage = await requester.newPage();
    let recoverCount = 0;
    requestPage.on('request', request => {
      if (new URL(request.url()).pathname === '/auth/v1/recover' && request.method() === 'POST') recoverCount++;
    });
    await requestPage.goto(root);
    await requestPage.getByRole('button', { name: 'Forgot your password?' }).click();
    await requestPage.locator('#recovery-email').fill(env.TEST_A_EMAIL!);
    const started = Date.now();
    stage = 'single recovery request through real UI';
    const requested = requestPage.waitForResponse(response => new URL(response.url()).pathname === '/auth/v1/recover', { timeout: 20_000 });
    await requestPage.getByRole('button', { name: 'Request recovery email', exact: true }).click();
    check((await requested).ok() && recoverCount === 1);
    await requestPage.getByRole('status').filter({ hasText: 'If this account is eligible' }).waitFor();
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
    await requester.close();
    stage = 'single actual link consumption in no-opener page';
    const page = await context.newPage();
    let isolatedTransport = true, updateCount = 0, logoutCount = 0, passwordSuccess = false;
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== base || url.pathname === '/auth/v1/verify') return;
      const bearer = request.headers().authorization ?? null;
      if (!originalBearer && url.pathname === '/auth/v1/user') originalBearer = bearer;
      if (!['/auth/v1/user', '/auth/v1/logout', '/rest/v1/profiles'].includes(url.pathname) || bearer !== originalBearer) isolatedTransport = false;
      if (request.method() === 'PUT' && url.pathname === '/auth/v1/user') { attempted = true; updateCount++; }
      if (url.pathname === '/auth/v1/logout') logoutCount++;
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== base) return;
      if (url.pathname === '/auth/v1/user' && response.request().method() === 'PUT') passwordSuccess = response.ok();
      if (url.pathname === '/auth/v1/logout') affirmativeLogout = response.ok();
    });
    await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    stage = 'real target confirmation before password entry';
    check(await page.evaluate(() => window.opener === null));
    await page.getByRole('checkbox').waitFor({ state: 'visible', timeout: 20_000 });
    check(!(await page.getByRole('checkbox').isChecked()) && await page.locator('#recovery-password').count() === 0);
    check((await page.locator('.recovery-card').innerText()).includes(env.TEST_A_EMAIL!));
    check(await page.evaluate(() => location.hash === '#/recovery' && !location.search && history.state === null && !sessionStorage.getItem('stillroom.auth')));
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    stage = 'real secure password form and affirmative global revocation';
    await page.locator('#recovery-password').fill(newPassword);
    await page.locator('#recovery-confirm-password').fill(newPassword);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.locator('#login-title').waitFor({ state: 'visible', timeout: 25_000 });
    check(isolatedTransport && passwordSuccess && affirmativeLogout && updateCount === 1 && logoutCount === 1);
    check(await page.evaluate(() => !sessionStorage.getItem('stillroom.auth')));
    page.removeAllListeners('request'); page.removeAllListeners('response');
    stage = 'real new-password UI login and old password refusal';
    await uiLogin(page, 'A', newPassword);
    await page.getByText('Fictional recovery garment A', { exact: true }).waitFor();
    const anew = await login('A', newPassword);
    check(anew.user.id === aId && await profile(anew.c, aId) === aBefore);
    const old = await client().auth.signInWithPassword({ email: env.TEST_A_EMAIL!, password: env.TEST_A_PASSWORD! });
    check(old.error?.code === 'invalid_credentials' && !old.data.session);
    stage = 'preexisting other-owner refresh and unchanged profile';
    const refreshed = await b.c.auth.refreshSession();
    check(!refreshed.error && refreshed.data.user?.id === bId && await profile(b.c, bId) === bBefore);
    await verifyFixture(anew.c, fa); await verifyFixture(b.c, fb);
    await bPage.reload();
    await bPage.getByText('Fictional recovery garment B', { exact: true }).waitFor({ state: 'visible' });
    check(!(await bPage.getByText('Fictional recovery garment A', { exact: true }).isVisible()));
    check(await profile(anew.c, aId) === aBefore && await profile(b.c, bId) === bBefore);
  } catch { primary = stage; }
  finally {
    await requester.close().catch(() => {});
    await context.close().catch(() => {});
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
      for (const fixture of fixtures) {
        const c = fixture.label === 'A' ? a.c : b.c;
        if (fixture.paths.length) check(!(await c.storage.from('wardrobe').remove(fixture.paths)).error);
        for (const path of fixture.paths) check((await c.storage.from('wardrobe').download(path)).error);
        check(!(await c.rpc('forget_image', { p_image_id: fixture.image })).error);
        check(!(await c.from('items').delete().eq('owner_id', fixture.owner).eq('id', fixture.item)).error);
        const remaining = await c.from('items').select('id').eq('owner_id', fixture.owner).eq('id', fixture.item);
        check(!remaining.error && remaining.data?.length === 0);
        const current = JSON.parse(await profile(c, fixture.owner)) as { ui_language: string | null; version: number };
        if (current.ui_language !== fixture.language) {
          const restoredLanguage = await c.from('profiles').update({ ui_language: fixture.language })
            .eq('owner_id', fixture.owner).eq('version', current.version).select('ui_language').single();
          check(!restoredLanguage.error && restoredLanguage.data.ui_language === fixture.language);
        }
      }
      restored = true;
    } catch { /* Preserve the primary stage; never print fixture or SDK values. */ }
    for (const c of clients) await c.auth.dispose();
  }
  if (primary || !restored) throw new Error(`BLOCKED: ${primary ?? 'fixture reconciliation'}; originals verified: ${restored}. STOP shared suites if false.`);
});
