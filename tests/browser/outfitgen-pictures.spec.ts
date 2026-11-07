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

type Start = { beforeSignIn?: (api: Api) => void; shortPlan?: boolean; tryOn?: boolean; photo?: boolean; outfitConsent?: boolean; hash?: string; replies?: Api['tryonControl']['replies'] };
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
  const api = existing?.api ?? await mockBackend(page, { initialLanguage: 'en' });
  const clothes = existing?.clothes ?? seed(api);
  api.outfitgenControl.setup[owners.a] = { configured: true, activated: true };
  if (options.outfitConsent !== false) api.outfitgenControl.consent[owners.a] = OUTFITGEN_NOTICE_REVISION;
  for (const entry of sets(clothes)) api.outfitgenControl.suggestions.push({ id: randomUUID(), owner: owners.a, state: 'suggested', ...entry });
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
  options.beforeSignIn?.(api);
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
    // While the first picture is made the card says so, and the next one waits.
    await expect(cards(page).first().locator('.suggested-wait')).toContainText(text('outfitgen.pictureMaking', 'en', { ordinal: 1, total: 2 }), { timeout: 30_000 });
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
    await expect(section(page).getByText(text('outfitgen.pictureRetry'), { exact: true })).toBeVisible({ timeout: 90_000 });
    const sent = requestsOf(api).length;
    expect(sent).toBeLessThanOrEqual(4);
    await quiet(page);
    expect(requestsOf(api)).toHaveLength(sent);
    expect(api.tryonControl.results).toHaveLength(0);
  });

  test('a refusal before the claim stops the queue for the cooldown instead of retrying at once', async ({ page }) => {
    const { api } = await start(page, { replies: [{ code: 'UNAVAILABLE', status: 503 }] });
    await expect(section(page).locator('.suggested-picture-line')).toContainText(text('outfitgen.pictureRetry'), { timeout: 30_000 });
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

  test('makes no calls without try-on, without a saved photo or without the suggestions consent', async ({ page, browser }) => {
    const off = await start(page, { tryOn: false });
    await expect(section(page).locator('.suggested-picture-line')).toContainText(text('outfitgen.pictureTryOnOff'), { timeout: 30_000 });
    await quiet(page, 3_000);
    expect(requestsOf(off.api)).toEqual([]);
    expect(off.api.tryonControl.photoCalls.get).toBe(0);

    const context = await browser.newContext();
    const second = await context.newPage();
    try {
      const noPhoto = await start(second, { photo: false });
      await expect(section(second).locator('.suggested-picture-line')).toContainText(text('outfitgen.pictureNoPhoto'), { timeout: 30_000 });
      await quiet(second, 3_000);
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
    await quiet(other);
    expect(requestsOf(second.api)).toEqual([]);
    held.release();
    // The first window finishes both outfits and releases the lock; the second then finds nothing left to ask for or starts its own.
    await expect.poll(() => first.api.tryonControl.results.length, { timeout: 60_000 }).toBe(2);
    void browser;
  });

  test('a reloaded page does not start a chain while the server still holds the first one', async ({ page }) => {
    const held = gate();
    const { api } = await start(page, { replies: [{}, { hold: held.hold }] });
    await expect.poll(() => requestsOf(api).length, { timeout: 30_000 }).toBe(2);
    // A closing page may not get its cancel through (a crash, a killed tab): the server then still holds the chain.
    await page.route('**/rest/v1/rpc/tryon_cancel', (route) => route.abort('failed'));
    await page.reload();
    await expectSignedIn(page);
    // The reload orphaned a paid step: the chain is still running on the server, so nothing new is sent.
    await quiet(page, 6_000);
    expect(requestsOf(api)).toHaveLength(2);
    // Once the chain is gone, the next evaluation goes on.
    for (const chain of api.tryonControl.chains) chain.state = 'expired';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => requestsOf(api).length, { timeout: 60_000 }).toBeGreaterThan(2);
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
});
