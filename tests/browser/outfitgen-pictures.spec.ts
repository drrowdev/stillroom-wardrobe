import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { OUTFITGEN_NOTICE_REVISION } from '../../src/domain/outfitgen';
import { TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import { translate, type Language, type MessageKey } from '../../src/i18n/all';
import '../../src/i18n/outfitgen';
import '../../src/i18n/tryon';
import { mockBackend, owners, signIn } from './mock-backend';
import { expectSignedIn, signOutThroughMenu } from './shell-support';

// OUTFITGEN2: automatic pictures of the owner wearing each suggested outfit, against the mocked backend. Real provider calls, real timing and
// real cost are an owner trial. The reply gates below hold a try-on step open so the queue's single flight, its pauses and its stops can be seen.
type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const text = (key: MessageKey, language: Language = 'en', parameters?: Record<string, string | number>) => translate(language, key, parameters);
const section = (page: Page) => page.locator('section[aria-labelledby="suggested-title"]');
const cards = (page: Page) => section(page).locator('.suggested-card');
const zoom = 'html { font-size: 200%; } body { font-size: 32px; }';
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
const gate = () => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return { hold, release: () => release() };
};
const created = () => new Date(Date.now() - 120_000).toISOString();
/** A line that names the time it will look again: the text with the time left open. */
const timed = (key: MessageKey, language: Language = 'en') =>
  new RegExp(text(key, language, { time: '@@' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('@@', '\\d{2}[:.]\\d{2}'));
const statusLine = (page: Page) => section(page).locator('.suggested-picture-status');

function seed(api: Api) {
  const add = (title: string, fields: Row) => {
    const { item } = api.seedSavedItem('a', title);
    Object.assign(item as Row, { seasons: ['spring', 'summer', 'autumn', 'winter'], formality: 2, ...fields });
    return item as Row & { id: string };
  };
  return { shirt: add('White shirt', { category: 'top' }), trousers: add('Navy trousers', { category: 'bottom' }),
    boots: add('Black boots', { category: 'footwear' }), dress: add('Green dress', { category: 'one_piece' }), top2: add('Grey tee', { category: 'top' }) };
}
type Clothes = ReturnType<typeof seed>;
const sets = (clothes: Clothes) => [
  { itemIds: [clothes.shirt.id, clothes.trousers.id, clothes.boots.id], title: 'Crisp navy', reason: 'Quiet colours that stay calm together.', occasion: 'smart', score: 9, createdAt: created() },
  { itemIds: [clothes.dress.id, clothes.boots.id], title: 'Green day', reason: 'One piece and dark boots.', occasion: 'everyday', score: 8, createdAt: created() },
];
const key = (ids: string[]) => [...ids].sort().join(',');

/** A usable saved photo (1024x1280 JPEG, made by the app's own encoder from a flat synthetic figure). */
async function usablePhoto(page: Page) {
  return Buffer.from(await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 800, height: 1000 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e4e1da'; context.fillRect(0, 0, 800, 1000);
    context.fillStyle = '#3d5a80'; context.fillRect(290, 260, 220, 330);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    const path = '/src/images/body-photo.ts';
    const { admitBodySource, prepareBodyPhoto } = await import(/* @vite-ignore */ path) as typeof import('../../src/images/body-photo');
    const photo = await prepareBodyPhoto(await admitBodySource(blob), { turns: 0, crop: { x: 0, y: 0, width: 1, height: 1 } });
    return [...photo.bytes];
  }));
}

type Start = { beforeSignIn?: (api: Api, clothes: Clothes) => void | Promise<void>; shortPlan?: boolean; tryOn?: boolean; photo?: boolean; outfitConsent?: boolean; hash?: string; replies?: Api['tryonControl']['replies']; language?: Language;
  /** Replaces the two default suggestions (TRYON-PROMPT3: outfits with coats). */
  sets?: (clothes: Clothes, api: Api) => ReturnType<typeof sets> };
async function start(page: Page, options: Start = {}, existing?: { api: Api; clothes: Clothes }) {
  // Playwright's WebKit route interception reports an empty body for Blob uploads, so there the try-on POST is re-sent as an ArrayBuffer.
  if (test.info().project.name === 'webkit-photo') {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/functions/v1/try-on') && init?.body instanceof FormData) {
          const encoded = new Response(init.body);
          const headers = new Headers(init.headers);
          headers.set('content-type', encoded.headers.get('content-type') ?? '');
          return original(input, { ...init, headers, body: await encoded.arrayBuffer() });
        }
        return original(input, init);
      };
    });
  }
  const api = existing?.api ?? await mockBackend(page, { initialLanguage: options.language ?? 'en' });
  const clothes = existing?.clothes ?? seed(api);
  api.outfitgenControl.setup[owners.a] = { configured: true, activated: true };
  if (options.outfitConsent !== false) api.outfitgenControl.consent[owners.a] = OUTFITGEN_NOTICE_REVISION;
  for (const entry of options.sets ? options.sets(clothes, api) : sets(clothes)) api.outfitgenControl.suggestions.push({ id: randomUUID(), owner: owners.a, state: 'suggested', ...entry });
  // Two tops make a plan of one step: too short to get a picture.
  if (options.shortPlan) api.outfitgenControl.suggestions.push({ id: randomUUID(), owner: owners.a, state: 'suggested', itemIds: [clothes.shirt.id, clothes.top2.id],
    title: 'Two tops', reason: 'Just tops.', occasion: 'home', score: 8, createdAt: created() });
  api.tryonControl.setup[owners.a] = { activated: true };
  if (options.tryOn !== false) api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
  if (options.replies) api.tryonControl.replies.push(...options.replies);
  if (options.photo !== false) {
    await page.goto('/');
    const jpeg = await usablePhoto(page);
    api.tryonControl.photos[owners.a] = { jpeg, sha256: createHash('sha256').update(jpeg).digest('hex'), savedAtMs: Date.now() - 86_400_000 };
  }
  await options.beforeSignIn?.(api, clothes);
  await page.goto(options.hash ?? '/#/outfits'); await signIn(page);
  await expectSignedIn(page);
  return { api, clothes };
}
const requestsOf = (api: Api) => api.tryonControl.requests;
const chains = (api: Api) => [...new Set(requestsOf(api).map((entry) => entry.chainId))];
const quiet = (page: Page, ms = 4_500) => page.waitForTimeout(ms);
/** Pictures mount as their cards come near the screen, so each card is brought into view while counting. */
async function picturesShown(page: Page, count: number) {
  await expect.poll(async () => {
    const total = await cards(page).count();
    for (let at = 0; at < total; at++) await cards(page).nth(at).scrollIntoViewIfNeeded();
    return section(page).locator('.suggested-picture img').count();
  }, { timeout: 60_000 }).toBe(count);
}

test.describe('OUTFITGEN2 automatic pictures', () => {
  test('makes one picture per suggestion, one chain at a time, and lists the garments under it', async ({ page }) => {
    const first = gate();
    const { api, clothes } = await start(page, { replies: [{ hold: first.hold }] });
    await expect(cards(page)).toHaveCount(2);
    // While the first picture is made the card shows its step, the section counts the pictures, and the next one waits.
    await expect(cards(page).first().locator('.suggested-wait')).toContainText(text('outfitgen.pictureStep', 'en', { step: 1, steps: 3 }), { timeout: 30_000 });
    await expect(statusLine(page)).toContainText(text('outfitgen.pictureProgress', 'en', { done: 0, total: 2 }));
    await expect(cards(page).nth(1).locator('.suggested-wait')).toHaveText(text('outfitgen.pictureQueued'));
    expect(chains(api)).toHaveLength(1);
    first.release();
    await picturesShown(page, 2);
    // Chains never interleave: every request of the first chain comes before any of the second, and each step is sent once.
    const requests = requestsOf(api);
    expect(requests.map((entry) => entry.step)).toEqual([1, 2, 3, 1, 2]);
    expect(chains(api)).toHaveLength(2);
    expect(requests.every((entry) => entry.owner === owners.a && entry.soi)).toBe(true);
    expect(new Set(requests.map((entry) => entry.requestId)).size).toBe(requests.length);
    expect(requests[0]!.itemIds).toEqual([clothes.shirt.id, clothes.trousers.id, clothes.boots.id].map(String));
    expect(requests[3]!.itemIds).toEqual([clothes.dress.id, clothes.boots.id].map(String));
    expect(api.tryonControl.results.map((entry) => [entry.outfitId, key(entry.itemIds)])).toEqual([
      [null, key([clothes.shirt.id, clothes.trousers.id, clothes.boots.id])], [null, key([clothes.dress.id, clothes.boots.id])]]);
    // The picture is on top, the garments are listed individually under it, and the picture is labelled.
    const card = cards(page).first();
    await expect(card.locator('.suggested-picture img')).toHaveAttribute('alt', text('outfitgen.pictureAlt', 'en', { title: 'Crisp navy' }));
    await expect(card.locator('.suggested-picture figcaption')).toHaveText(text('tryon.madeWith'));
    await expect(card.locator('.suggested-garments li')).toHaveCount(3);
    await expect(card.locator('.suggested-garments li').first()).toContainText('White shirt');
    await expect(card.locator('.suggested-garments li').nth(2)).toContainText(text('tryon.slot.footwear'));
    await expect(card.locator('.suggested-picture button')).toHaveCount(1);
    // A card shows no Delete: removing a picture goes through Remove or the Try-ons list.
    await expect(card.getByRole('button', { name: text('common.delete'), exact: true })).toHaveCount(0);
    await quiet(page, 2_000);
    expect(requestsOf(api)).toHaveLength(5);
  });

  test('waits for the owner\'s own try-on, and goes on once it has finished', async ({ page }) => {
    const queueStep = gate(), manualStep = gate();
    // Reply 1: the queue's step 1. Reply 2: its step 2, held. Reply 3: the owner's first step, held.
    const { api, clothes } = await start(page, { replies: [{}, { hold: queueStep.hold }, { hold: manualStep.hold }] });
    const outfitId = randomUUID(), now = new Date(Date.now() - 60_000).toISOString();
    api.outfits.push({ id: outfitId, owner_id: owners.a, title: 'Own outfit', occasion: 'everyday', notes: '', favourite: false, deleted_at: null, version: 1, created_at: now, updated_at: now });
    [clothes.dress.id, clothes.boots.id].forEach((itemId, position) => api.outfitItems.push({ owner_id: owners.a, outfit_id: outfitId, item_id: itemId, position }));
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
    await page.locator('#tryon-open').click();
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(3);
    const queueChain = requestsOf(api)[0]!.chainId;
    expect(requestsOf(api)[2]!.chainId).not.toBe(queueChain);
    // The queue's step 2 finishes, but its step 3 is not sent while the owner's run is busy.
    queueStep.release();
    await quiet(page);
    expect(requestsOf(api).filter((entry) => entry.chainId === queueChain).map((entry) => entry.step)).toEqual([1, 2]);
    // After the owner's run, the queue sends its step 3 and the rest of its outfits.
    manualStep.release();
    await expect.poll(() => requestsOf(api).filter((entry) => entry.chainId === queueChain).map((entry) => entry.step), { timeout: 60_000 }).toEqual([1, 2, 3]);
    await expect.poll(() => api.tryonControl.results.length, { timeout: 60_000 }).toBe(3);
  });

  test('stops quietly when the monthly allowance is used, and sends nothing more', async ({ page }) => {
    const { api } = await start(page, { replies: [{ code: 'ALLOWANCE', status: 429 }] });
    await expect(section(page).getByText(text('outfitgen.pictureBudget'), { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(section(page).locator('.suggested-picture')).toHaveCount(0);
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(1);
    // The garments stay listed, and the rest of the section works.
    await expect(cards(page).first().locator('.suggested-garments li')).toHaveCount(3);
    await expect(cards(page).first().getByRole('button', { name: text('outfitgen.keepLabel', 'en', { title: 'Crisp navy' }), exact: true })).toBeEnabled();
  });

  test('stops when the spending guard pauses AI features, and stays stopped', async ({ page }) => {
    const { api } = await start(page, { replies: [{ code: 'PAUSED', status: 403 }] });
    await expect(section(page).getByText(text('aiGuard.paused'), { exact: true })).toBeVisible({ timeout: 30_000 });
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(1);
  });

  test('never retries a failed outfit more than once and never loops', async ({ page }) => {
    // Every step fails: each outfit is tried at most twice, and two failures in a row stop the queue.
    const { api } = await start(page, { replies: Array.from({ length: 12 }, () => ({ code: 'FAILED', status: 502 })) });
    await expect(section(page).getByText(timed('outfitgen.pictureRetry'))).toBeVisible({ timeout: 90_000 });
    const sent = requestsOf(api).length;
    expect(sent).toBeLessThanOrEqual(4);
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(sent);
    expect(api.tryonControl.results).toHaveLength(0);
  });

  test('a refusal before the claim stops the queue for the cooldown instead of retrying at once', async ({ page }) => {
    const { api } = await start(page, { replies: [{ code: 'UNAVAILABLE', status: 503 }] });
    await expect(section(page).locator('.suggested-picture-line')).toContainText(timed('outfitgen.pictureRetry'), { timeout: 30_000 });
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(1);
  });

  test('consent withdrawn in another window is seen before the next chain', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, {}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(3);
    // Another window turns suggested outfits off while the first chain is on its last step.
    api.outfitgenControl.consent[owners.a] = null;
    held.release();
    await expect.poll(() => api.tryonControl.results.length, { timeout: 30_000 }).toBe(1);
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(3);
  });

  test('a pending try-on consent change keeps the next step from being sent', async ({ page }) => {
    const step = gate(), write = gate();
    const { api } = await start(page, { replies: [{}, { hold: step.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    await page.route('**/rest/v1/rpc/tryon_set_consent', async (route) => { await write.hold; await route.fallback(); });
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.locator('section[aria-labelledby="tryon-heading"] [role="switch"][aria-checked="true"]').click();
    step.release();
    await quiet(page, 3_000);
    expect(requestsOf(api)).toHaveLength(2);
    write.release();
  });

  test('Remove keeps its cleanup pending until the chain is shown to be over, then deletes the late picture', async ({ page }) => {
    const step = gate();
    const { api, clothes } = await start(page, { replies: [{}, { hold: step.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    let failing = true;
    for (const name of ['tryon_cancel', 'tryon_chain_status']) {
      await page.route(`**/rest/v1/rpc/${name}`, (route) => failing ? route.abort('failed') : route.fallback());
    }
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    step.release();
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeDisabled();
    // The chain finishes late, after the cleanup looked.
    const late = randomUUID();
    api.tryonControl.results.push({ id: late, owner: owners.a, outfitId: null, itemIds: [clothes.shirt.id, clothes.trousers.id, clothes.boots.id],
      image: api.fixture, completedAtMs: Date.now() });
    for (const chain of api.tryonControl.chains) { chain.state = 'complete'; chain.resultId = late; }
    failing = false;
    // A later pass retries by itself too, so the button may already be gone.
    await section(page).getByRole('button', { name: text('common.retry'), exact: true }).click({ timeout: 3_000 }).catch(() => undefined);
    await expect.poll(() => api.tryonControl.deletes, { timeout: 30_000 }).toEqual([late]);
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toHaveCount(0);
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  });

  test('Remove stays pending when the cancel fails before step 1 claims, then deletes the picture that completes late', async ({ page }) => {
    const step = gate();
    const { api, clothes } = await start(page, { replies: [{ hold: step.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(1);
    let failing = true;
    await page.route('**/rest/v1/rpc/tryon_cancel', (route) => failing ? route.abort('failed') : route.fallback());
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    // The chain does not exist on the server yet, so "not found" proves nothing: the sent request can still claim.
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeDisabled();
    step.release();
    await expect.poll(() => api.tryonControl.chains.length).toBe(1);
    const late = randomUUID();
    api.tryonControl.results.push({ id: late, owner: owners.a, outfitId: null, itemIds: [clothes.shirt.id, clothes.trousers.id, clothes.boots.id],
      image: api.fixture, completedAtMs: Date.now() });
    api.tryonControl.chains[0]!.state = 'complete'; api.tryonControl.chains[0]!.resultId = late;
    failing = false;
    // A later pass retries by itself too, so the button may already be gone.
    await section(page).getByRole('button', { name: text('common.retry'), exact: true }).click({ timeout: 3_000 }).catch(() => undefined);
    await expect.poll(() => api.tryonControl.deletes, { timeout: 30_000 }).toEqual([late]);
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toHaveCount(0);
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
  });

  test('Remove sends the cancel again after it failed, and only a confirmed cancel clears the cleanup', async ({ page }) => {
    const step = gate();
    const { api } = await start(page, { replies: [{ hold: step.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(1);
    let failing = true;
    await page.route('**/rest/v1/rpc/tryon_cancel', (route) => failing ? route.abort('failed') : route.fallback());
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeDisabled();
    // The held step claims the chain; it is running on the server and nothing finishes it.
    step.release();
    await expect.poll(() => api.tryonControl.chains.map((chain) => chain.state)).toEqual(['running']);
    const first = api.tryonControl.chains[0]!;
    await quiet(page, 1_500);
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeDisabled();
    failing = false;
    await section(page).getByRole('button', { name: text('common.retry'), exact: true }).click({ timeout: 3_000 }).catch(() => undefined);
    await expect.poll(() => first.state, { timeout: 30_000 }).toBe('cancelled');
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toHaveCount(0);
    await expect(section(page).getByRole('button', { name: text('common.undo'), exact: true })).toBeEnabled();
    expect(api.tryonControl.deletes).toEqual([]);
  });
  test('Remove and Undo on a plan too short for a picture finish at once', async ({ page }) => {
    await start(page, { shortPlan: true });
    await expect(cards(page)).toHaveCount(3);
    await cards(page).nth(2).getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Two tops' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(2);
    const undo = section(page).getByRole('button', { name: text('common.undo'), exact: true });
    await expect(undo).toBeEnabled({ timeout: 10_000 });
    await expect(section(page).getByText(text('outfitgen.pictureDeleteFailed'), { exact: false })).toHaveCount(0);
    await undo.click();
    await expect(cards(page)).toHaveCount(3);
  });

  test('the queue goes on after a refused try-on consent change that leaves everything else as it was', async ({ page }) => {
    const write = gate();
    const { api } = await start(page, { hash: '/#/settings' });
    await expect(page.locator('#tryon-heading')).toBeVisible({ timeout: 30_000 });
    await page.route('**/rest/v1/rpc/tryon_set_consent', async (route) => { await write.hold; await route.fulfill({ status: 503, json: { message: 'fixture' } }); });
    await page.locator('section[aria-labelledby="tryon-heading"] [role="switch"][aria-checked="true"]').click();
    await page.evaluate(() => { location.hash = '#/outfits'; });
    await expect(cards(page)).toHaveCount(2);
    await quiet(page, 1_500);
    expect(requestsOf(api)).toEqual([]);
    write.release();
    // The write was refused and the consent is unchanged: nothing else changes, yet the queue must wake up.
    await expect.poll(() => requestsOf(api).length, { timeout: 40_000 }).toBeGreaterThan(0);
  });

  test('the queue goes on after a rejected photo replacement that leaves the saved photo as it was', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'The crop flow is covered by the chromium and webkit-photo projects.');
    const write = gate();
    const { api } = await start(page, { hash: '/#/settings' });
    const photo = await usablePhoto(page);
    await expect(page.locator('#profile-photo-input')).toBeAttached({ timeout: 30_000 });
    await page.locator('#profile-photo-input').setInputFiles({ name: 'replacement.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect(page.locator('#crop-editor-title')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: text('photo.applyCrop'), exact: true }).click();
    await expect(page.locator('#profile-photo-save')).toBeFocused({ timeout: 20_000 });
    await page.route('**/rest/v1/rpc/tryon_person_photo_put_v1', async (route) => { await write.hold; await route.fulfill({ status: 503, json: { message: 'fixture' } }); });
    await page.locator('#profile-photo-save').click();
    // The save is held; the app's own start timer lets the queue look while it is.
    await quiet(page, 9_500);
    expect(requestsOf(api)).toEqual([]);
    write.release();
    await expect.poll(() => requestsOf(api).length, { timeout: 40_000 }).toBeGreaterThan(0);
  });

  test('a failed outfit-consent read is tried again, and nothing is sent until one succeeds', async ({ page }) => {
    const { api } = await start(page, { hash: '/#/today', beforeSignIn: (mock) => { mock.outfitgenControl.statusFaults.push(...Array.from({ length: 200 }, () => 'fail' as const)); } });
    await expect.poll(() => api.outfitgenControl.statusReads, { timeout: 30_000 }).toBeGreaterThan(1);
    await quiet(page, 9_500);
    const reads = api.outfitgenControl.statusReads;
    expect(requestsOf(api)).toEqual([]);
    api.outfitgenControl.statusFaults.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => requestsOf(api).length, { timeout: 60_000 }).toBeGreaterThan(0);
    // The failed reads were tried at passes, not in a storm.
    expect(reads).toBeLessThan(12);
  });
  test('a picture still being made when the suggestion is kept appears in the kept outfit\'s details', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, {}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(3);
    await cards(page).first().getByRole('button', { name: text('outfitgen.keepLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    const outfitId = String(api.outfits.find((entry) => entry.title === 'Crisp navy')!.id);
    await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
    await expect(page.locator('#outfit-detail-title')).toBeVisible();
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(0);
    held.release();
    await expect(page.locator('.tryon-saved-list img')).toBeVisible({ timeout: 30_000 });
  });
  test('Remove deletes what was made while the suggestion existed, and Undo makes a new picture', async ({ page }) => {
    const { api, clothes } = await start(page);
    const first = [clothes.shirt.id, clothes.trousers.id, clothes.boots.id];
    await picturesShown(page, 2);
    const madeFor = (ids: string[]) => api.tryonControl.results.filter((entry) => key(entry.itemIds) === key(ids));
    const picture = madeFor(first)[0]!;
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    await expect.poll(() => api.tryonControl.deletes).toEqual([picture.id]);
    expect(madeFor(first)).toHaveLength(0);
    // The other outfit's picture stays.
    expect(madeFor([clothes.dress.id, clothes.boots.id])).toHaveLength(1);
    await section(page).getByRole('button', { name: text('common.undo'), exact: true }).click();
    await expect(cards(page)).toHaveCount(2);
    await expect.poll(() => madeFor(first).length, { timeout: 60_000 }).toBe(1);
    await expect(cards(page).first().locator('.suggested-picture img')).toBeVisible({ timeout: 30_000 });
  });

  test('a picture older than the suggestion is shown, not made again, and kept when Remove is pressed', async ({ page }) => {
    const { api, clothes } = await start(page);
    const older = randomUUID();
    api.tryonControl.results.push({ id: older, owner: owners.a, outfitId: null,
      itemIds: [clothes.boots.id, clothes.trousers.id, clothes.shirt.id], image: api.fixture, completedAtMs: Date.now() - 3_600_000 });
    await picturesShown(page, 2);
    // The first outfit found its picture by its garments, so only the second one was made.
    expect(chains(api)).toHaveLength(1);
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Crisp navy' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    await quiet(page, 2_500);
    expect(api.tryonControl.deletes).toEqual([]);
    expect(api.tryonControl.results.some((entry) => entry.id === older)).toBe(true);
  });

  test('makes no calls and shows no picture line without try-on, without a saved photo or without the suggestions consent', async ({ page, browser }) => {
    const off = await start(page, { tryOn: false });
    await expect.poll(() => off.api.tryonControl.statusReads, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(cards(page)).not.toHaveCount(0);
    await quiet(page, 3_000);
    await expect(section(page).locator('.suggested-picture-line')).toHaveCount(0);
    expect(requestsOf(off.api)).toEqual([]);
    expect(off.api.tryonControl.photoCalls.get).toBe(0);

    const context = await browser.newContext();
    const second = await context.newPage();
    try {
      const noPhoto = await start(second, { photo: false });
      await expect.poll(() => noPhoto.api.tryonControl.statusReads, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect(cards(second)).not.toHaveCount(0);
      await quiet(second, 3_000);
      await expect(section(second).locator('.suggested-picture-line')).toHaveCount(0);
      expect(requestsOf(noPhoto.api)).toEqual([]);
      expect(noPhoto.api.tryonControl.photoCalls.get).toBe(0);
    } finally { await context.close(); }

    const context2 = await browser.newContext();
    const third = await context2.newPage();
    try {
      const noConsent = await start(third, { outfitConsent: false });
      await expect(section(third).getByText(text('outfitgen.off'), { exact: true })).toBeVisible({ timeout: 30_000 });
      await quiet(third, 3_000);
      expect(requestsOf(noConsent.api)).toEqual([]);
      expect(noConsent.api.tryonControl.photoCalls.get).toBe(0);
      expect(noConsent.api.tryonControl.statusReads).toBe(0);
    } finally { await context2.close(); }
  });

  test('a second window does not start a chain while the first one holds the lock', async ({ page, browser }) => {
    const held = gate();
    const first = await start(page, { replies: [{ hold: held.hold }] });
    await expect.poll(() => requestsOf(first.api).length, { timeout: 30_000 }).toBe(1);
    const context = page.context();
    const other = await context.newPage();
    const second = await start(other);
    await expect(statusLine(other)).toContainText(timed('outfitgen.pictureOtherWindow'), { timeout: 30_000 });
    await quiet(other);
    expect(requestsOf(second.api)).toEqual([]);
    held.release();
    // The first window finishes both outfits and releases the lock; the second then finds nothing left to ask for or starts its own.
    await expect.poll(() => first.api.tryonControl.results.length, { timeout: 60_000 }).toBe(2);
    void browser;
  });

  test('a reloaded page takes the interrupted chain\'s row as ordinary and makes its own pictures at once', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    // A closing page may not get its cancel through (a crash, a killed tab): the server then still holds the chain.
    await page.route('**/rest/v1/rpc/tryon_cancel', (route) => route.abort('failed'));
    await page.reload();
    await expectSignedIn(page);
    // The reload orphaned a paid step and the row stays on the server, but the page does not wait behind it: its own chains are accepted.
    await expect.poll(() => chains(api).length, { timeout: 60_000 }).toBeGreaterThan(1);
    await picturesShown(page, 2);
    expect(api.tryonControl.results).toHaveLength(2);
    held.release();
  });

  test('a reload during the last step ends with one picture per outfit', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, {}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(3);
    await page.reload();
    await expectSignedIn(page);
    held.release();
    // Whichever way the server settled the interrupted chain (finished, or cancelled by the closing page), each outfit ends with one picture.
    await picturesShown(page, 2);
    await quiet(page, 3_000);
    expect(api.tryonControl.results).toHaveLength(2);
    expect(new Set(api.tryonControl.results.map((entry) => key(entry.itemIds))).size).toBe(2);
    expect(api.tryonControl.chains.filter((entry) => entry.state === 'running')).toEqual([]);
  });
  test('sending stops when the owner signs out', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    await signOutThroughMenu(page);
    await expect(page.locator('#email')).toBeVisible();
    held.release();
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(2);
  });

  test('is accessible and readable at 320 px and 200% text', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await start(page);
    await picturesShown(page, 2);
    await page.addStyleTag({ content: zoom });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe(page);
  });

  test('Settings says the saved photo is also used for the pictures, next to the try-on notice', async ({ page }) => {
    await start(page, { hash: '/#/settings' });
    await expect(page.locator('#tryon-heading')).toBeVisible({ timeout: 30_000 });
    await page.locator('section[aria-labelledby="tryon-heading"]').getByText(text('aiF.about'), { exact: true }).click();
    await expect(page.locator('section[aria-labelledby="tryon-heading"]')).toContainText(text('outfitgenC.photoUse'));
  });

  // OUTFITGEN-PENDING100: a list of 100 suggestions. The two planned sets share their pictures, so two chains are made; the point is
  // that 100 cards are listed while only the cards near the screen mount their picture.
  test('lists 100 suggestions and mounts a picture only on the cards near the screen', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const { api } = await start(page, {
      beforeSignIn: (mock, clothes) => {
        const base = sets(clothes);
        for (let index = 2; index < 100; index++) mock.outfitgenControl.suggestions.push({ id: randomUUID(), owner: owners.a, state: 'suggested', ...base[index % 2]!,
          title: `Set ${index}`, createdAt: created() });
      },
    });
    await expect(section(page).getByRole('heading', { level: 2 })).toHaveText(text('outfitgen.titleCount', 'en', { count: 100 }), { timeout: 30_000 });
    await expect(cards(page)).toHaveCount(100);
    await expect.poll(() => requestsOf(api).length, { timeout: 60_000 }).toBe(5);
    await expect.poll(() => api.tryonControl.results.length, { timeout: 60_000 }).toBe(2);
    await expect.poll(() => section(page).locator('.suggested-picture img').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await section(page).locator('.suggested-picture img').count()).toBeLessThan(25);
    expect(chains(api)).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

// PICTURES-WAIT1: the queue is not stalled by an ordinary gap between the server's stored count and the list, it says why it is idle, and it shows progress.
type Chain = Api['tryonControl']['chains'][number];
const stored = (api: Api, outfitId: string | null, itemIds: string[]) =>
  api.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId, itemIds, image: api.fixture, completedAtMs: Date.now() - 3_600_000 });
const savedOutfit = (api: Api, deleted: boolean) => {
  const id = randomUUID(), now = new Date(Date.now() - 60_000).toISOString();
  api.outfits.push({ id, owner_id: owners.a, title: 'Saved outfit', occasion: 'everyday', notes: '', favourite: false, deleted_at: deleted ? now : null, version: 1, created_at: now, updated_at: now });
  return id;
};
const newApi = async (page: Page) => { const api = await mockBackend(page, { initialLanguage: 'en' }); return { api, clothes: seed(api) }; };
/** Both suggestions already have their pictures, so the queue is idle. */
const withPictures = (api: Api, clothes: Clothes) => { for (const entry of sets(clothes)) stored(api, null, entry.itemIds); };
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test.describe('PICTURES-WAIT1 pictures wait, lines and progress', () => {
  test('the owner\'s account (4 stored pictures, 2 of them of Trashed outfits) gets its pictures without a long silent wait', async ({ page }) => {
    const existing = await newApi(page);
    const { api, clothes } = existing;
    const trashed = savedOutfit(api, true);
    stored(api, trashed, [clothes.top2.id, clothes.trousers.id]);
    stored(api, trashed, [clothes.top2.id, clothes.boots.id]);
    stored(api, null, [clothes.shirt.id, clothes.top2.id]);
    stored(api, null, [clothes.dress.id, clothes.top2.id]);
    await start(page, {}, existing);
    // The status counts 4 rows and the list returns 2: that gap is ordinary, so chains are accepted and both pictures appear.
    await picturesShown(page, 2);
    expect(chains(api)).toHaveLength(2);
    expect(requestsOf(api).map((entry) => entry.step)).toEqual([1, 2, 3, 1, 2]);
    expect(api.tryonControl.results).toHaveLength(6);
    await expect(statusLine(page)).not.toContainText(timed('outfitgen.pictureOtherPicture'));
  });

  test('shows the picture count and the time left while pictures are made, and nothing once they are done', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, {}, {}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(4);
    await expect(statusLine(page)).toContainText(text('outfitgen.pictureProgress', 'en', { done: 1, total: 2 }));
    await expect(statusLine(page)).toContainText(/about \d+ min left|under 1 min left/);
    const bar = cards(page).nth(1).getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuemax', '2');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await expect(cards(page).nth(1).locator('.suggested-wait')).toContainText(text('outfitgen.pictureStep', 'en', { step: 1, steps: 2 }));
    held.release();
    await picturesShown(page, 2);
    await expect(statusLine(page)).toHaveText('');
  });

  test('hides the estimate when the queue stops, and says why instead', async ({ page }) => {
    await start(page, { replies: [{ code: 'UNAVAILABLE', status: 503 }] });
    await expect(statusLine(page)).toContainText(timed('outfitgen.pictureRetry'), { timeout: 30_000 });
    await expect(statusLine(page)).not.toContainText('left');
    await expect(statusLine(page)).not.toContainText(text('outfitgen.pictureProgress', 'en', { done: 0, total: 2 }));
  });

  test('says "Taking longer than usual" for a slow step, never sends anything because of it, and respects reduced motion', async ({ page }) => {
    await page.clock.install({ time: Date.now() });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const held = gate();
    const { api } = await start(page, { replies: [{ hold: held.hold }] });
    const card = cards(page).first();
    await expect(card.locator('.suggested-wait')).toContainText(text('outfitgen.pictureStep', 'en', { step: 1, steps: 3 }), { timeout: 30_000 });
    expect(await card.locator('.suggested-progress span[data-state="now"]').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    await page.clock.fastForward(91_000);
    await expect(card.locator('.suggested-wait')).toContainText(text('outfitgen.pictureSlow'));
    await expect(card.locator('.suggested-wait')).not.toContainText(text('outfitgen.pictureStep', 'en', { step: 1, steps: 3 }));
    await quiet(page, 1_000);
    expect(requestsOf(api)).toHaveLength(1);
    held.release();
    await picturesShown(page, 2);
    expect(requestsOf(api).map((entry) => entry.step)).toEqual([1, 2, 3, 1, 2]);
  });

  test('moves the indicator when a step is finished', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    const bar = cards(page).first().getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '1');
    await expect(cards(page).first().locator('.suggested-wait')).toContainText(text('outfitgen.pictureStep', 'en', { step: 2, steps: 3 }));
    held.release();
  });

  for (const language of ['en', 'fi', 'sv'] as const) {
    test(`stays readable at 320 px and 200% text while a picture is made, slow, and paused (${language})`, async ({ page }) => {
      await page.clock.install({ time: Date.now() });
      await page.setViewportSize({ width: 320, height: 740 });
      const held = gate();
      const { api } = await start(page, { language, replies: [{ hold: held.hold }, {}, {}, { code: 'UNAVAILABLE', status: 503 }] });
      const card = cards(page).first();
      await expect(card.locator('.suggested-wait')).toContainText(text('outfitgen.pictureStep', language, { step: 1, steps: 3 }), { timeout: 30_000 });
      await expect(statusLine(page)).toContainText(text('outfitgen.pictureProgress', language, { done: 0, total: 2 }));
      await page.addStyleTag({ content: zoom });
      expect(await noOverflow(page)).toBe(true);
      await axe(page);
      await page.clock.fastForward(91_000);
      await expect(card.locator('.suggested-wait')).toContainText(text('outfitgen.pictureSlow', language));
      expect(await noOverflow(page)).toBe(true);
      await axe(page);
      // The step then fails to start the next chain: the queue says it is paused, with the time it looks again.
      held.release();
      await expect(statusLine(page)).toContainText(timed('outfitgen.pictureRetry', language), { timeout: 60_000 });
      expect(await noOverflow(page)).toBe(true);
      await axe(page);
      void api;
    });
  }

  test('waits while a chain started elsewhere holds a row, also beyond 90 s and several looks, and goes on when it ends', async ({ page }) => {
    await page.clock.install({ time: Date.now() });
    const held = gate();
    const { api } = await start(page, { replies: [{ hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(1);
    // Another device starts a chain while this page's first chain is on its first step.
    const foreign: Chain = { id: randomUUID(), owner: owners.a, outfitId: null, steps: [], nextStep: 1, state: 'running', resultId: null, expiresAtMs: Date.now() + 1_800_000 };
    api.tryonControl.chains.push(foreign);
    held.release();
    await expect.poll(() => api.tryonControl.results.length, { timeout: 30_000 }).toBe(1);
    await expect(statusLine(page)).toContainText(timed('outfitgen.pictureOtherPicture'), { timeout: 30_000 });
    for (let look = 0; look < 4; look++) { await page.clock.fastForward(61_000); await page.waitForTimeout(400); }
    expect(chains(api)).toHaveLength(1);
    expect(requestsOf(api)).toHaveLength(3);
    // The other chain ends: the next look makes the second picture, and its claim is accepted.
    foreign.state = 'expired';
    await page.clock.fastForward(61_000);
    await picturesShown(page, 2);
    expect(chains(api)).toHaveLength(2);
    expect(api.tryonControl.results).toHaveLength(2);
  });

  test('stops waiting for a row that outlives a chain (31 minutes)', async ({ page }) => {
    await page.clock.install({ time: Date.now() });
    const held = gate();
    const { api } = await start(page, { replies: [{ hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(1);
    const foreign: Chain = { id: randomUUID(), owner: owners.a, outfitId: null, steps: [], nextStep: 1, state: 'running', resultId: null, expiresAtMs: Date.now() + 1_800_000 };
    api.tryonControl.chains.push(foreign);
    held.release();
    await expect.poll(() => api.tryonControl.results.length, { timeout: 30_000 }).toBe(1);
    await expect(statusLine(page)).toContainText(timed('outfitgen.pictureOtherPicture'), { timeout: 30_000 });
    await page.clock.fastForward(20 * 60_000);
    await page.waitForTimeout(400);
    expect(chains(api)).toHaveLength(1);
    await page.clock.fastForward(12 * 60_000);
    await picturesShown(page, 2);
    expect(chains(api)).toHaveLength(2);
  });

  test('an outfit moved to the Trash while a picture is made does not stall the queue, and Restore does not either', async ({ page }) => {
    const existing = await newApi(page);
    const { api, clothes } = existing;
    const outfitId = savedOutfit(api, false);
    stored(api, outfitId, [clothes.top2.id, clothes.boots.id]);
    const held = gate();
    await start(page, { replies: [{ hold: held.hold }] }, existing);
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(1);
    const outfit = api.outfits.find((row) => row.id === outfitId)!;
    outfit.deleted_at = new Date().toISOString();
    held.release();
    await picturesShown(page, 2);
    expect(chains(api)).toHaveLength(2);
    await expect(statusLine(page)).not.toContainText(timed('outfitgen.pictureOtherPicture'));
    outfit.deleted_at = null;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await quiet(page, 1_500);
    expect(chains(api)).toHaveLength(2);
  });

  test('a plan too short for a picture is counted as an outfit without one, and nothing is made for it', async ({ page }) => {
    const existing = await newApi(page);
    withPictures(existing.api, existing.clothes);
    const { api } = await start(page, { shortPlan: true }, existing);
    await expect(cards(page)).toHaveCount(3);
    await expect(statusLine(page)).toHaveText(text('outfitgen.pictureMissing_one', 'en', { count: 1 }), { timeout: 30_000 });
    await quiet(page, 1_500);
    expect(requestsOf(api)).toHaveLength(0);
  });

  test('a paused try-on service is not called "off", and the queue goes on once it is back', async ({ page }) => {
    const { api } = await start(page, { beforeSignIn: (backend) => { backend.tryonControl.setup[owners.a] = { activated: true, providerAvailable: false }; } });
    await expect(statusLine(page)).toContainText(timed('outfitgen.pictureTryOnPaused'), { timeout: 30_000 });
    expect(requestsOf(api)).toHaveLength(0);
    // The service is back: the next look reads the status again before the earlier state blocks anything.
    api.tryonControl.setup[owners.a] = { activated: true, providerAvailable: true };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await picturesShown(page, 2);
    expect(api.tryonControl.results).toHaveLength(2);
  });

  test('a given-up chain whose cancel could not be confirmed keeps the next chain from starting, whatever the foreign count says', async ({ page }) => {
    const foreign: Chain = { id: randomUUID(), owner: owners.a, outfitId: null, steps: [], nextStep: 1, state: 'running', resultId: null, expiresAtMs: Date.now() + 1_800_000 };
    // A chain of another device is running at the first look (baseline 1). The queue's first step reaches the server, its reply is lost,
    // and the cancel of the given-up chain cannot get through.
    const { api, clothes } = await start(page, { replies: [{ abort: true, commit: true }], beforeSignIn: async (backend) => {
      backend.tryonControl.chains.push(foreign);
      await page.route('**/rest/v1/rpc/tryon_cancel', (route) => route.abort('failed'));
    } });
    await expect.poll(() => api.tryonControl.chains.filter((chain) => chain.id !== foreign.id).length, { timeout: 30_000 }).toBe(1);
    const lost = api.tryonControl.chains.find((chain) => chain.id !== foreign.id)!;
    await expect(statusLine(page)).toContainText(timed('outfitgen.pictureStopping'), { timeout: 60_000 });
    // The other chain finishes with a picture of its own: stored 2 (it and the lost chain's row), ready 1, so the gap equals the baseline again.
    foreign.state = 'complete';
    stored(api, null, [clothes.shirt.id, clothes.top2.id]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await quiet(page, 3_000);
    expect(lost.state).toBe('running');
    expect(chains(api)).toEqual([lost.id]);
    // Once the cancel goes through, the chain is shown to be over and the queue goes on.
    await page.unroute('**/rest/v1/rpc/tryon_cancel');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await picturesShown(page, 2);
    expect(lost.state).toBe('cancelled');
    expect(chains(api).length).toBeGreaterThan(1);
  });

  test('a given-up chain that finishes while it is being reconciled leaves no duplicate chain for the same outfit', async ({ page }) => {
    const foreign: Chain = { id: randomUUID(), owner: owners.a, outfitId: null, steps: [], nextStep: 1, state: 'running', resultId: null, expiresAtMs: Date.now() + 1_800_000 };
    let lookups = 0;
    const existing = await newApi(page);
    const { clothes } = existing;
    // The second outfit already has its picture, so the first one is the only candidate: after the lost step it is the retry.
    stored(existing.api, null, sets(clothes)[1]!.itemIds);
    const { api } = await start(page, { replies: [{ abort: true, commit: true }], beforeSignIn: async (backend) => {
      backend.tryonControl.chains.push(foreign);
      await page.route('**/rest/v1/rpc/tryon_cancel', (route) => route.abort('failed'));
      await page.route('**/rest/v1/rpc/tryon_chain_status', async (route) => {
        const chain = backend.tryonControl.chains.find((entry) => entry.id !== foreign.id && entry.id === (route.request().postDataJSON() as { p_chain_id?: string }).p_chain_id);
        lookups += chain ? 1 : 0;
        if (chain && lookups === 1) {
          // The run's own check still sees its chain running. Meanwhile the other device's chain finishes with a picture of its own.
          foreign.state = 'complete';
          stored(backend, null, [clothes.shirt.id, clothes.top2.id]);
        }
        if (chain && lookups === 2) {
          // The queue's check of the given-up chain: its last step went through after all, and the picture is stored.
          chain.state = 'complete';
          const itemIds = chain.steps.map((step) => step.itemId);
          const id = randomUUID();
          backend.tryonControl.results.push({ id, owner: owners.a, outfitId: null, itemIds, image: backend.fixture, completedAtMs: Date.now() });
          chain.resultId = id;
        }
        await route.fallback();
      });
    } }, existing);
    await picturesShown(page, 2);
    await quiet(page, 2_000);
    // The outfit's garments were asked for once: the finished picture was not made again.
    const firsts = requestsOf(api).filter((entry) => entry.step === 1);
    expect(firsts).toHaveLength(1);
    expect(lookups).toBeGreaterThanOrEqual(2);
  });

  test('says when no picture could be made for some outfits', async ({ page }) => {
    const { api } = await start(page, { replies: [{ code: 'FILTERED', status: 422 }, { code: 'FILTERED', status: 422 }] });
    await expect(statusLine(page)).toHaveText(text('outfitgen.pictureMissing_other', 'en', { count: 2 }), { timeout: 30_000 });
    await quiet(page, 1_500);
    expect(requestsOf(api)).toHaveLength(2);
  });

  test('says when the browser cannot keep windows apart, and when it is offline', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); });
    const existing = await newApi(page);
    withPictures(existing.api, existing.clothes);
    await start(page, {}, existing);
    await expect(statusLine(page)).toHaveText(text('outfitgen.pictureNoLocks'), { timeout: 30_000 });
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); window.dispatchEvent(new Event('focus')); });
    await expect(statusLine(page)).toHaveText(text('outfitgen.pictureOffline'), { timeout: 30_000 });
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); window.dispatchEvent(new Event('online')); });
    await expect(statusLine(page)).toHaveText(text('outfitgen.pictureNoLocks'), { timeout: 30_000 });
  });

  test('says when the status cannot be read, and looks again', async ({ page }) => {
    const existing = await newApi(page);
    withPictures(existing.api, existing.clothes);
    await start(page, {}, existing);
    await expect(cards(page)).toHaveCount(2);
    await quiet(page, 1_500);
    await page.route('**/rest/v1/rpc/tryon_status', (route) => route.fulfill({ status: 503, body: '{}', contentType: 'application/json' }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(statusLine(page)).toContainText(timed('outfitgen.pictureUnreadable'), { timeout: 30_000 });
  });

  test('stays readable at 320 px and 200% text with pictures being made and a pass running at once', async ({ page }) => {
    await page.clock.install({ time: Date.now() });
    await page.setViewportSize({ width: 320, height: 740 });
    const picture = gate();
    const pass = gate();
    const { api } = await start(page, { replies: [{ hold: picture.hold }] });
    await expect(cards(page).first().locator('.suggested-wait')).toContainText(text('outfitgen.pictureStep', 'en', { step: 1, steps: 3 }), { timeout: 30_000 });
    api.outfitgenControl.unassessed = 6;
    api.outfitgenControl.replies.push({ status: 200, body: { code: 'OK', suggested: 0, judged: 4, remaining: true }, unassessed: 4, hold: pass.hold });
    await section(page).locator('#suggested-find').click();
    await expect(section(page).locator('.suggested-pass')).toBeVisible();
    await expect(statusLine(page)).toContainText(text('outfitgen.pictureProgress', 'en', { done: 0, total: 2 }));
    await page.addStyleTag({ content: zoom });
    expect(await noOverflow(page)).toBe(true);
    await axe(page);
    // The pass adds one status region (its start and result); its progress is plain text, and the pictures keep their own polite line.
    await expect(section(page).locator('[role="status"]')).toHaveCount(1);
    expect(await section(page).locator('.suggested-pass').evaluate((node) => node.closest('[aria-live], [role="status"]') === null)).toBe(true);
    pass.release();
    picture.release();
  });
});

// TRYON-PROMPT3: coats are optional pieces that are never drawn, so outfits that differ only by their coat share one picture, and a picture
// made before (with a coat) belongs only to an outfit with that same coat.
test.describe('TRYON-PROMPT3 outfits with coats', () => {
  const withCoats = (names: string[]) => (clothes: Clothes, api: Api) => {
    const coats = names.map((title) => { const { item } = api.seedSavedItem('a', title); Object.assign(item as Row, { category: 'outerwear', seasons: ['autumn'], formality: 2 }); return item as Row & { id: string }; });
    return coats.map((coat, at) => ({ itemIds: [clothes.shirt.id, clothes.trousers.id, clothes.boots.id, coat.id], title: `Look ${names[at]}`,
      reason: 'Quiet colours that stay calm together.', occasion: 'smart', score: 9 - at, createdAt: created() }));
  };
  const coatIds = (api: Api, titles: string[]) => titles.map((title) => String(api.items.find((item) => item.title === title)!.id));

  test('never sends a coat, shares one picture between outfits that differ only by the coat, and lists the coat as optional', async ({ page }) => {
    const { api, clothes } = await start(page, { sets: withCoats(['Grey coat', 'Green coat']) });
    await expect(cards(page)).toHaveCount(2);
    await picturesShown(page, 2);
    const [coatA, coatB] = coatIds(api, ['Grey coat', 'Green coat']);
    const requests = requestsOf(api);
    expect(requests.map((entry) => entry.step)).toEqual([1, 2, 3]);
    expect(chains(api)).toHaveLength(1);
    expect(requests.every((entry) => !(entry.itemIds ?? []).includes(coatA!) && !(entry.itemIds ?? []).includes(coatB!))).toBe(true);
    expect(requests[0]!.itemIds).toEqual([clothes.shirt.id, clothes.trousers.id, clothes.boots.id].map(String));
    expect(api.tryonControl.results.map((entry) => key(entry.itemIds))).toEqual([key([clothes.shirt.id, clothes.trousers.id, clothes.boots.id])]);
    // The coat stays in each outfit, listed with its category and a plain Optional marker; the other garments carry none.
    for (const card of [cards(page).nth(0), cards(page).nth(1)]) {
      await expect(card.locator('.suggested-garments li')).toHaveCount(4);
      await expect(card.locator('.suggested-garments li').nth(3)).toContainText(`${text('tryon.slot.outerwear')} · ${text('tryon.optional')}`);
      await expect(card.locator('.suggested-garments li').nth(0)).not.toContainText(text('tryon.optional'));
    }
    await quiet(page, 2_000);
    expect(requestsOf(api)).toHaveLength(3);
  });

  test('Keep one outfit and Remove the other: the shared picture survives and nothing is made again', async ({ page }) => {
    const { api, clothes } = await start(page, { sets: withCoats(['Grey coat', 'Green coat']) });
    await picturesShown(page, 2);
    const drawn = key([clothes.shirt.id, clothes.trousers.id, clothes.boots.id]);
    expect(api.tryonControl.results.map((entry) => key(entry.itemIds))).toEqual([drawn]);
    await cards(page).nth(1).getByRole('button', { name: text('outfitgen.keepLabel', 'en', { title: 'Look Green coat' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(1);
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Look Grey coat' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(0);
    await quiet(page, 4_500);
    expect(api.tryonControl.deletes).toEqual([]);
    expect(api.tryonControl.results.map((entry) => key(entry.itemIds))).toEqual([drawn]);
    expect(chains(api)).toHaveLength(1);
    // The kept outfit still shows the picture.
    const outfitId = String(api.outfits.find((entry) => entry.title === 'Look Green coat')!.id);
    await page.evaluate((id) => { location.hash = `#/outfits/${id}`; }, outfitId);
    await expect(page.locator('#outfit-detail-title')).toBeVisible();
    await expect(page.locator('.tryon-saved-list img')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.outfit-composition li').filter({ hasText: 'Green coat' })).toContainText(text('tryon.optional'));
  });

  test('Remove of one outfit while the other outfit\'s Remove is still in flight and then fails (BUSY): the shared picture stays and nothing is made again', async ({ page }) => {
    const { api } = await start(page, { sets: withCoats(['Grey coat', 'Green coat']) });
    await picturesShown(page, 2);
    expect(api.tryonControl.results).toHaveLength(1);
    const holdA = gate(), held = gate();
    // Both Remove requests are held; the first is answered once both are in flight, the second later and refused as busy.
    api.outfitgenControl.removeHolds.push(holdA.hold, held.hold);
    api.outfitgenControl.decisionCodes.push('OK', 'BUSY');
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Look Grey coat' }), exact: true }).click();
    await section(page).getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Look Green coat' }), exact: true }).click();
    await expect.poll(() => api.outfitgenControl.removeHolds.length).toBe(0);
    holdA.release();
    await expect(cards(page)).toHaveCount(1);
    await quiet(page, 2_500);
    expect(api.tryonControl.deletes).toEqual([]);
    held.release();
    await expect.poll(() => api.outfitgenControl.decisionCodes.length).toBe(0);
    await quiet(page, 3_000);
    expect(api.tryonControl.deletes).toEqual([]);
    expect(api.tryonControl.results).toHaveLength(1);
    expect(chains(api)).toHaveLength(1);
    await expect(cards(page).first().locator('.suggested-picture img')).toBeVisible();
  });

  test('both outfits removed together: the shared picture is cleaned up once the last one is gone, and nothing is made', async ({ page }) => {
    const { api } = await start(page, { sets: withCoats(['Grey coat', 'Green coat']) });
    await picturesShown(page, 2);
    const picture = api.tryonControl.results[0]!;
    const holdA = gate(), held = gate();
    api.outfitgenControl.removeHolds.push(holdA.hold, held.hold);
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Look Grey coat' }), exact: true }).click();
    await section(page).getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Look Green coat' }), exact: true }).click();
    await expect.poll(() => api.outfitgenControl.removeHolds.length).toBe(0);
    holdA.release();
    await expect(cards(page)).toHaveCount(1);
    await quiet(page, 2_000);
    // The other outfit is still listed, so the picture it needs stays for now.
    expect(api.tryonControl.deletes).toEqual([]);
    held.release();
    await expect(cards(page)).toHaveCount(0);
    await expect.poll(() => api.tryonControl.deletes, { timeout: 30_000 }).toEqual([picture.id]);
    await quiet(page, 2_000);
    expect(api.tryonControl.results).toHaveLength(0);
    expect(chains(api)).toHaveLength(1);
  });

  test('Remove deletes the picture when no other outfit has the same garments', async ({ page }) => {
    const { api } = await start(page, { sets: withCoats(['Grey coat']) });
    await picturesShown(page, 1);
    const picture = api.tryonControl.results[0]!;
    await cards(page).first().getByRole('button', { name: text('outfitgen.removeLabel', 'en', { title: 'Look Grey coat' }), exact: true }).click();
    await expect(cards(page)).toHaveCount(0);
    await expect.poll(() => api.tryonControl.deletes).toEqual([picture.id]);
  });

  test('a picture made before with the same coat is shown and not made again, and one with another coat is not shown for this coat', async ({ page }) => {
    const { api, clothes } = await start(page, { sets: withCoats(['Grey coat']), beforeSignIn: (existing, items) => {
      const other = existing.seedSavedItem('a', 'Green coat').item as Row & { id: string };
      Object.assign(other, { category: 'outerwear' });
      // A picture of the same outfit with the other coat, made before coats stopped being drawn.
      existing.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId: null, image: existing.fixture, completedAtMs: Date.now() - 3_600_000,
        itemIds: [items.shirt.id, items.trousers.id, items.boots.id, String(other.id)] });
    } });
    // The earlier picture shows another coat, so it is not this outfit's picture: a new one is made, without any coat.
    await picturesShown(page, 1);
    expect(chains(api)).toHaveLength(1);
    const [coat] = coatIds(api, ['Grey coat']);
    expect(requestsOf(api).every((entry) => !(entry.itemIds ?? []).includes(coat!))).toBe(true);
    expect(key(api.tryonControl.results.at(-1)!.itemIds)).toBe(key([clothes.shirt.id, clothes.trousers.id, clothes.boots.id]));
    expect(api.tryonControl.deletes).toEqual([]);
  });

  test('a picture made before with exactly this coat is shown and nothing is made', async ({ page }) => {
    const { api } = await start(page, { sets: withCoats(['Grey coat']), beforeSignIn: (existing, items) => {
      const coat = existing.items.find((item) => item.title === 'Grey coat')!;
      existing.tryonControl.results.push({ id: randomUUID(), owner: owners.a, outfitId: null, image: existing.fixture, completedAtMs: Date.now() - 3_600_000,
        itemIds: [items.shirt.id, items.trousers.id, items.boots.id, String(coat.id)] });
    } });
    await picturesShown(page, 1);
    await quiet(page, 3_000);
    expect(requestsOf(api)).toEqual([]);
    expect(api.tryonControl.deletes).toEqual([]);
  });
});
