import { test, type Browser, type Page, type Route } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import { classifyObjectDeletion, deleteWardrobeObject } from '../../src/data/storage-delete';
import { parseProfile } from '../../src/data/profile';
import { messages } from '../../src/i18n';
import { parseDeletionStatuses } from '../../src/domain/item-lifecycle';

const root = 'http://127.0.0.1:5173/';
const projection = 'owner_id,display_name,ui_language,timezone,currency,version';
const fixtureAssertion = new Error('Local item lifecycle gate failed.');
function check(value: unknown): asserts value { if (!value) throw fixtureAssertion; }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const click = (page: Page, key: keyof typeof messages) => page.getByRole('button', { name: messages[key].en, exact: true }).click();

async function journey(browser: Browser, resume: boolean) {
  let stage = 'local configuration', primary: string | null = null, cleaned = true;
  type Checkpoint = 'none' | 'fixtures' | 'peer.baseline' | 'outfit.create' | 'history.create' | 'item.baseline'
    | 'login.open' | 'login.email' | 'login.password' | 'login.submit' | 'login.wardrobe'
    | 'trash.detail' | 'trash.click' | 'trash.wardrobe' | 'trash.status'
    | 'undo.click' | 'undo.visible' | 'undo.status' | 'second.detail' | 'second.trash' | 'second.wardrobe'
    | 'menu.open' | 'menu.link' | 'menu.heading' | 'restore.click' | 'restore.notice' | 'restore.values'
    | 'delete.route' | 'delete.dialog' | 'delete.confirm' | 'delete.unconfirmed' | 'delete.interception'
    | 'delete.quiet' | 'claim.status' | 'claim.restore-refused' | 'resume.reload' | 'resume.heading'
    | 'resume.row-check' | 'resume.claim-check' | 'resume.visible' | 'resume.status' | 'resume.click'
    | 'resume.notice' | 'resume.proofs' | 'finish.absent' | 'finish.history' | 'peer.values' | 'peer.download' | 'peer.bytes' | 'peer.foreign'
    | 'request.path' | 'request.headers' | 'request.owner' | 'intercept.deadline' | 'intercept.fetch'
    | 'intercept.body' | 'intercept.classify' | 'intercept.abort' | 'intercept.dispose' | 'intercept.unroute' | 'intercept.failure-abort'
    | 'response.body' | 'response.classify' | 'cleanup.context' | 'cleanup.status' | 'cleanup.session'
    | 'cleanup.bytes' | 'cleanup.finish' | 'cleanup.image' | 'cleanup.item' | 'cleanup.absent'
    | 'cleanup.history-read' | 'cleanup.history-delete' | 'cleanup.profile-read' | 'cleanup.profile-restore' | 'cleanup.auth';
  type Reason = 'timeout' | 'abort' | 'fixture-assertion' | 'other' | 'unknown';
  type Failure = { checkpoint: Checkpoint; reason: Reason; value: unknown };
  const main: { checkpoint: Checkpoint; lastCompleted: Checkpoint; failure: Failure | null } = {
    checkpoint: 'none', lastCompleted: 'none', failure: null,
  };
  const proof: { failure: Failure | null } = { failure: null };
  const cleanup: { checkpoint: Checkpoint; failure: Failure | null } = { checkpoint: 'none', failure: null };
  let interceptionEntered = false, upstreamRemoved = false, deliveryAbortCompleted = false;
  function reason(value: unknown): Reason {
    if (value === fixtureAssertion) return 'fixture-assertion';
    try {
      if (value === null || typeof value !== 'object') return 'unknown';
      const descriptor = Object.getOwnPropertyDescriptor(value, 'name');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return 'unknown';
      switch (descriptor.value) {
        case 'TimeoutError': return 'timeout';
        case 'AbortError': return 'abort';
        case 'Error': case 'TypeError': case 'RangeError': case 'SyntaxError': return 'other';
        default: return 'unknown';
      }
    } catch { return 'unknown'; }
  }
  function start(checkpoint: Checkpoint) { main.checkpoint = checkpoint; }
  function complete() { main.lastCompleted = main.checkpoint; }
  async function proofStep<T>(checkpoint: Checkpoint, operation: () => T | PromiseLike<T>): Promise<T> {
    try { return await operation(); }
    catch (value) { proof.failure ??= { checkpoint, reason: reason(value), value }; throw value; }
  }
  function cleanupFailure(value: unknown) {
    cleaned = false;
    cleanup.failure ??= { checkpoint: cleanup.checkpoint, reason: reason(value), value };
  }
  const end = Date.now() + 110000;
  let operationDeadline = end - 35000;
  const env = process.env;
  validateSessionEnvironment(env);
  const base = assertLocalApi(env.SUPABASE_URL!), key = env.SUPABASE_PUBLISHABLE_KEY!;
  const clients: SupabaseClient[] = [];
  const fixtures: {
    client: SupabaseClient; owner: string; item: string; image: string; paths: string[];
    original: ReturnType<typeof parseProfile>; event: string | null; outfit: string | null;
  }[] = [];
  const jpg = await readFile(new URL('../security/fixture.jpg', import.meta.url));
  async function transport(input: RequestInfo | URL, init: RequestInit = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    check(url.origin === base && !url.username && !url.password && !url.hash && new Headers(init.headers).get('apikey') === key);
    check(['/auth/v1/token', '/auth/v1/user'].includes(url.pathname) || url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/storage/v1/'));
    const remaining = operationDeadline - Date.now(); check(remaining > 0);
    const response = await fetch(input, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(Math.min(5000, remaining)) });
    const data = await response.arrayBuffer();
    check(data.byteLength <= 262144);
    return new Response(response.status === 204 ? null : data, { status: response.status, headers: response.headers });
  }
  async function profile(c: SupabaseClient, owner: string) {
    const result = await c.from('profiles').select(projection).eq('owner_id', owner).single();
    check(!result.error); return parseProfile(result.data, owner);
  }
  async function fixture(label: 'A' | 'B') {
    const c = createClient(base, key, { auth: { storageKey: `lifecycle-${randomUUID()}`, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false }, global: { fetch: transport } });
    clients.push(c);
    const login = await c.auth.signInWithPassword({ email: env[`TEST_${label}_EMAIL`]!, password: env[`TEST_${label}_PASSWORD`]! });
    check(!login.error && login.data.user && login.data.session);
    const owner = login.data.user.id, original = await profile(c, owner);
    const value = { client: c, owner, original, item: randomUUID(), image: randomUUID(), paths: [] as string[], event: null as string | null, outfit: null as string | null };
    fixtures.push(value);
    if (original.ui_language !== 'en') {
      const changed = await c.from('profiles').update({ ui_language: 'en' }).eq('owner_id', owner).eq('version', original.version).select(projection).single();
      check(!changed.error && parseProfile(changed.data, owner).ui_language === 'en');
    }
    check(!(await c.from('items').insert({ id: value.item, owner_id: owner, title: `Fictional lifecycle ${label}`, category: 'top' })).error);
    const reserved = await c.from('item_images').insert({ id: value.image, owner_id: owner, item_id: value.item,
      main_bytes: jpg.length, thumb_bytes: jpg.length, main_sha256: digest(jpg), thumb_sha256: digest(jpg),
      width: 2, height: 2, alt_text: 'Fictional lifecycle image' }).select('main_path,thumb_path').single();
    check(!reserved.error && reserved.data);
    check(reserved.data.main_path === `${owner}/${value.item}/${value.image}/main.jpg` && reserved.data.thumb_path === `${owner}/${value.item}/${value.image}/thumb.jpg`);
    value.paths.push(reserved.data.main_path as string, reserved.data.thumb_path as string);
    for (const path of value.paths) check(!(await c.storage.from('wardrobe').upload(path, jpg, { contentType: 'image/jpeg', upsert: false })).error);
    check(!(await c.rpc('commit_image', { p_image_id: value.image })).error);
    return value;
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(5000);
  context.setDefaultNavigationTimeout(10000);
  const page = await context.newPage();
  const button = (key: keyof typeof messages) => page.getByRole('button', { name: messages[key].en, exact: true });
  async function goTrash() {
    start('menu.open');
    await click(page, 'account.menu');
    complete(); start('menu.link');
    await page.locator('.account-popover').getByRole('link', { name: messages['nav.trash'].en, exact: true }).click();
    complete(); start('menu.heading');
    await page.locator('#trash-title').waitFor();
    complete();
  }
  async function nodeStatus(value: typeof fixtures[number]) {
    const result = await value.client.rpc('item_deletion_status', { p_item_ids: [value.item] });
    check(!result.error);
    return parseDeletionStatuses(result.data, value.owner, [value.item]);
  }
  try {
    stage = 'fresh independent ordinary sessions and fixtures';
    start('fixtures');
    const a = await fixture('A'), b = await fixture('B');
    check(a.owner !== b.owner);
    complete(); start('peer.baseline');
    const peer = await b.client.from('items').select('*').eq('owner_id', b.owner).eq('id', b.item).single();
    check(!peer.error && peer.data);
    complete(); start('outfit.create');
    a.outfit = randomUUID();
    check(!(await a.client.rpc('save_outfit', { p_id: a.outfit, p_title: 'Fictional lifecycle outfit', p_occasion: '', p_notes: '', p_favourite: false, p_item_ids: [a.item] })).error);
    complete(); start('history.create');
    a.event = randomUUID();
    check(!(await a.client.rpc('save_wear_event', { p_id: a.event, p_local_date: '2026-09-14', p_timezone: 'UTC', p_state: 'worn',
      p_label: 'Fictional lifecycle wear', p_outfit_id: a.outfit, p_item_ids: [a.item] })).error);
    complete(); start('item.baseline');
    const original = await a.client.from('items').select('*').eq('owner_id', a.owner).eq('id', a.item).single();
    check(!original.error && original.data);
    complete();
    stage = 'real page login and Trash action';
    start('login.open');
    await page.goto(root);
    complete(); start('login.email');
    await page.locator('#email').fill(env.TEST_A_EMAIL!);
    complete(); start('login.password');
    await page.locator('#password').fill(env.TEST_A_PASSWORD!);
    complete(); start('login.submit');
    await page.locator('button[type=submit]').click();
    complete(); start('login.wardrobe');
    await page.locator('#wardrobe-title').waitFor({ timeout: 15000 });
    complete(); start('trash.detail');
    await page.locator(`a[href="#/items/${a.item}"]`).click();
    complete(); start('trash.click');
    await click(page, 'item.trash');
    complete(); start('trash.wardrobe');
    await page.locator('#wardrobe-title').waitFor();
    complete(); start('trash.status');
    const trashed = (await nodeStatus(a))[0];
    check(trashed && trashed.deleted_at !== null && trashed.version === Number(original.data.version) + 1);
    complete();
    if (!resume) {
      stage = 'real page Undo and independent Restore';
      start('undo.click');
      await click(page, 'common.undo');
      complete(); start('undo.visible');
      await page.locator(`a[href="#/items/${a.item}"]`).waitFor();
      complete(); start('undo.status');
      const undone = (await nodeStatus(a))[0]; check(undone && undone.version === trashed.version + 1 && undone.deleted_at === null);
      complete(); start('second.detail');
      await page.locator(`a[href="#/items/${a.item}"]`).click();
      complete(); start('second.trash');
      await click(page, 'item.trash');
      complete(); start('second.wardrobe');
      await page.locator('#wardrobe-title').waitFor();
      complete(); await goTrash();
      start('restore.click');
      await page.locator('.trash-list li').filter({ hasText: 'Fictional lifecycle A' }).getByRole('button', { name: messages['trash.restore'].en }).click();
      complete(); start('restore.notice');
      await page.getByText(messages['lifecycle.restored'].en, { exact: true }).waitFor();
      complete(); start('restore.values');
      const actual = await a.client.from('items').select('*').eq('owner_id', a.owner).eq('id', a.item).single();
      check(!actual.error && actual.data);
      for (const name of Object.keys(original.data)) if (!['version', 'updated_at'].includes(name)) check(JSON.stringify(actual.data[name]) === JSON.stringify(original.data[name]));
      check(actual.data.version === Number(original.data.version) + 4);
      complete();
    } else {
      stage = 'actual PAGE singular DELETE transport and one-shot response loss';
      await goTrash();
      const calls: string[] = [], proofs: Promise<void>[] = [];
      let proofFailed = false, latched = false, interception: Promise<void> | null = null;
      const outcomes: ('removed' | 'missing')[] = [];
      page.on('request', request => {
        if (request.method() !== 'DELETE') return;
        const url = new URL(request.url());
        calls.push(url.pathname);
        proofs.push((async () => {
          await proofStep('request.path', () => check(url.origin === base && a.paths.some(path => url.pathname === `/storage/v1/object/wardrobe/${path}`)
            && !url.search && !url.hash && request.postData() === null));
          const authorization = await proofStep('request.headers', async () => {
            const headers = await request.allHeaders();
            check(headers.apikey === key && headers.authorization?.startsWith('Bearer '));
            return headers.authorization;
          });
          await proofStep('request.owner', async () => {
            const verified = await a.client.auth.getUser(authorization.slice(7));
            check(!verified.error && verified.data.user?.id === a.owner);
          });
        })().catch(() => { proofFailed = true; }));
      });
      const exact = `${base}/storage/v1/object/wardrobe/${a.paths[0]!}`;
      const intercept = (route: Route) => {
        if (latched || route.request().method() !== 'DELETE') return route.continue();
        latched = true; interceptionEntered = true;
        interception = (async () => {
          const deadline = Math.min(operationDeadline, Date.now() + 10000);
          await proofStep('intercept.deadline', () => check(deadline > Date.now()));
          const upstream = await proofStep('intercept.fetch', () => route.fetch({ timeout: Math.max(1, deadline - Date.now()), maxRetries: 0, maxRedirects: 0 }));
          try {
            const bytes = await proofStep('intercept.body', async () => {
              const bytes = await upstream.body();
              check(bytes.length <= 4096 && Date.now() < deadline);
              return bytes;
            });
            await proofStep('intercept.classify', () => {
              const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
              check(classifyObjectDeletion({ status: upstream.status(), ok: upstream.ok(), data }) === 'removed');
              upstreamRemoved = true;
            });
            await proofStep('intercept.abort', async () => { await route.abort('failed'); deliveryAbortCompleted = true; });
          } finally { await proofStep('intercept.dispose', () => upstream.dispose()); }
          await proofStep('intercept.unroute', () => page.unroute(exact, intercept));
        })();
        return interception.catch(async () => {
          proofFailed = true;
          await proofStep('intercept.failure-abort', async () => { await route.abort('failed'); deliveryAbortCompleted = true; });
        });
      };
      start('delete.route');
      await page.route(exact, intercept);
      complete(); start('delete.dialog');
      const selected = page.locator('.trash-list li').filter({ hasText: 'Fictional lifecycle A' });
      await selected.getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
      complete(); start('delete.confirm');
      await page.getByRole('dialog').getByRole('button', { name: messages['lifecycle.delete'].en, exact: true }).click();
      complete(); start('delete.unconfirmed');
      await page.getByRole('alert').filter({ hasText: messages['lifecycle.unconfirmed'].en }).waitFor();
      complete(); start('delete.interception');
      if (interception) await interception;
      check(upstreamRemoved && !proofFailed && calls.length === 1);
      complete(); start('delete.quiet');
      await page.waitForTimeout(300);
      check(calls.length === 1);
      complete(); start('claim.status');
      const claim = (await nodeStatus(a))[0]; check(claim?.request_id && claim.expected_version === trashed.version);
      complete(); start('claim.restore-refused');
      const deniedRestore = await a.client.rpc('set_item_trashed', { p_item_id: a.item, p_expected_version: claim.version, p_trashed: false });
      check(deniedRestore.error);
      complete();
      stage = 'reload revisits missing path, explicit resume and actual checked finish';
      start('resume.reload');
      await page.reload();
      complete(); start('resume.heading');
      await page.locator('#trash-title').waitFor();
      check(calls.length === 1);
      complete(); start('resume.row-check');
      await selected.getByRole('button', { name: messages['lifecycle.check'].en }).click();
      complete(); start('resume.claim-check');
      await page.locator('.lifecycle-resume').getByRole('button', { name: messages['lifecycle.check'].en }).click();
      complete(); start('resume.visible');
      await button('lifecycle.resume').waitFor();
      check(calls.length === 1);
      complete(); start('resume.status');
      const observed = (await nodeStatus(a))[0];
      check(observed?.request_id === claim.request_id && observed.expected_version === claim.expected_version && observed.version === claim.version);
      complete();
      page.on('response', response => {
        if (response.request().method() !== 'DELETE') return;
        proofs.push((async () => {
          const bytes = await proofStep('response.body', async () => { const bytes = await response.body(); check(bytes.length <= 4096); return bytes; });
          await proofStep('response.classify', () => {
            const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            outcomes.push(classifyObjectDeletion({ status: response.status(), ok: response.ok(), data }));
          });
        })().catch(() => { proofFailed = true; }));
      });
      start('resume.click');
      await click(page, 'lifecycle.resume');
      complete(); start('resume.notice');
      await page.getByText(messages['lifecycle.deleted'].en, { exact: true }).waitFor();
      complete(); start('resume.proofs');
      await Promise.all(proofs);
      check(!proofFailed && Number(calls.length) === 3 && outcomes.length === 2 && outcomes.includes('missing') && outcomes.includes('removed'));
      complete(); start('finish.absent');
      check((await nodeStatus(a)).length === 0);
      complete(); start('finish.history');
      const history = await a.client.from('wear_event_items').select('item_id,title_snapshot,category_snapshot').eq('owner_id', a.owner).eq('event_id', a.event);
      check(!history.error && history.data?.length === 1 && history.data[0].item_id === null
        && history.data[0].title_snapshot === 'Fictional lifecycle A' && history.data[0].category_snapshot === 'top');
      complete();
      page.removeAllListeners('request'); page.removeAllListeners('response');
    }
    stage = 'ordinary peer isolation and unchanged bytes';
    start('peer.values');
    const peerAfter = await b.client.from('items').select('*').eq('owner_id', b.owner).eq('id', b.item).single();
    check(!peerAfter.error && JSON.stringify(peerAfter.data) === JSON.stringify(peer.data));
    complete();
    for (const path of b.paths) {
      start('peer.download');
      const response = await b.client.storage.from('wardrobe').download(path);
      complete(); start('peer.bytes');
      check(!response.error && response.data && digest(new Uint8Array(await response.data.arrayBuffer())) === digest(jpg));
      complete();
    }
    start('peer.foreign');
    const foreign = await a.client.from('items').select('id').eq('owner_id', b.owner).eq('id', b.item);
    check(!foreign.error && foreign.data?.length === 0);
    complete();
  } catch (value) { primary = stage; main.failure ??= { checkpoint: main.checkpoint, reason: reason(value), value }; }
  finally {
    operationDeadline = end;
    cleanup.checkpoint = 'cleanup.context';
    try { await context.close(); } catch (value) { cleanupFailure(value); }
    for (const value of fixtures) {
      try {
        cleanup.checkpoint = 'cleanup.status';
        const c = value.client, status = (await nodeStatus(value))[0];
        if (status) {
          cleanup.checkpoint = 'cleanup.session';
          const cached = await c.auth.getSession();
          check(!cached.error && cached.data.session?.user.id === value.owner);
          cleanup.checkpoint = 'cleanup.bytes';
          for (const path of value.paths) await deleteWardrobeObject(async (route, options) => {
            const response = await transport(base + route, { ...options, headers: { apikey: key, Authorization: `Bearer ${cached.data.session!.access_token}` } });
            return { status: response.status, ok: response.ok, data: await response.json() as unknown };
          }, value.owner, path);
          if (status.request_id) {
            cleanup.checkpoint = 'cleanup.finish';
            const result = await c.rpc('finish_item_deletion', { p_item_id: value.item, p_request_id: status.request_id });
            check(!result.error && result.data?.length === 1 && result.data[0].state === 'completed');
          } else {
            cleanup.checkpoint = 'cleanup.image';
            if (value.paths.length) check(!(await c.rpc('forget_image', { p_image_id: value.image })).error);
            cleanup.checkpoint = 'cleanup.item';
            check(!(await c.from('items').delete().eq('owner_id', value.owner).eq('id', value.item).eq('version', status.version)).error);
          }
        }
        cleanup.checkpoint = 'cleanup.absent';
        check((await nodeStatus(value)).length === 0);
        for (const [table, id] of [['wear_events', value.event], ['outfits', value.outfit]] as const) if (id) {
          cleanup.checkpoint = 'cleanup.history-read';
          const current = await c.from(table).select('version').eq('owner_id', value.owner).eq('id', id).maybeSingle();
          check(!current.error);
          cleanup.checkpoint = 'cleanup.history-delete';
          if (current.data) check(!(await c.from(table).delete().eq('owner_id', value.owner).eq('id', id).eq('version', current.data.version)).error);
        }
        cleanup.checkpoint = 'cleanup.profile-read';
        const current = await profile(c, value.owner);
        for (const field of ['display_name', 'timezone', 'currency'] as const) check(current[field] === value.original[field]);
        if (current.ui_language !== value.original.ui_language) {
          cleanup.checkpoint = 'cleanup.profile-restore';
          const restored = await c.from('profiles').update({ ui_language: value.original.ui_language }).eq('owner_id', value.owner).eq('version', current.version).select(projection).single();
          check(!restored.error && parseProfile(restored.data, value.owner).ui_language === value.original.ui_language);
        }
        // Used-ID registry markers intentionally remain until actual Auth deletion.
      } catch (value) { cleanupFailure(value); }
    }
    cleanup.checkpoint = 'cleanup.auth';
    for (const client of clients) { try { await client.auth.dispose(); } catch (value) { cleanupFailure(value); } }
  }
  if (primary || !cleaned) {
    let record = '[i08-lifecycle] diagnostic-failure';
    try {
      const encoded = '[i08-lifecycle] ' + JSON.stringify({
        schemaVersion: 1, case: resume ? 'resume' : 'restore',
        main: { checkpoint: main.failure?.checkpoint ?? main.checkpoint, lastCompleted: main.lastCompleted, reason: main.failure?.reason ?? 'unknown' },
        proof: { checkpoint: proof.failure?.checkpoint ?? 'none', reason: proof.failure?.reason ?? 'unknown' },
        cleanup: { checkpoint: cleanup.failure?.checkpoint ?? 'none', reason: cleanup.failure?.reason ?? 'unknown' },
        cleanupVerified: cleaned, interceptionEntered, upstreamRemoved, deliveryAbortCompleted,
      });
      if (Buffer.byteLength(encoded + '\n', 'utf8') <= 1024) record = encoded;
    } catch { /* Keep the bounded failure marker, never expose the diagnostic error. */ }
    try { console.error(record); }
    catch { /* The original test failure still takes precedence if output fails. */ }
    throw new Error(`BLOCKED: local lifecycle ${primary ?? 'cleanup'}; ordinary cleanup verified: ${cleaned}.`);
  }
}
test('LOCAL I08 real page Trash, Undo and Restore with independent ordinary fixtures', async ({ browser }) => { await journey(browser, false); });
test('LOCAL I08 real page singular deletion, lost delivery, reload and missing-on-resume', async ({ browser }) => { await journey(browser, true); });
