import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import { mockBackend, owners, signIn } from './mock-backend';
import { expectSignedIn, signOutThroughMenu } from './shell-support';

// OUTFITS-PICTURES: the owner's existing try-on pictures on the saved-outfit cards, against the mocked backend. Only reads exist:
// the saved-results list and the picture bytes. Assertions are text (counts, ids, classes); no image is looked at.
type Api = Awaited<ReturnType<typeof mockBackend>>;
type Row = Record<string, unknown>;
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
const card = (page: Page, title: string) => page.locator('.outfit-card', { has: page.getByRole('heading', { name: title, exact: true }) });
const picture = (page: Page, title: string) => card(page, title).locator('.outfit-card-picture img');
const collage = (page: Page, title: string) => card(page, title).locator('.outfit-card-thumbs:not(.outfit-card-picture)');

function seed(api: Api) {
  const add = (title: string, category: string) => {
    const { item } = api.seedSavedItem('a', title);
    Object.assign(item as Row, { category });
    return item as Row & { id: string };
  };
  return { top: add('Olive overshirt', 'top'), trousers: add('Navy trousers', 'bottom'), shoes: add('White trainers', 'footwear'),
    dress: add('Green dress', 'one_piece'), coat: add('Grey coat', 'outerwear'), cardigan: add('Beige cardigan', 'layer') };
}
type Clothes = ReturnType<typeof seed>;
function seedOutfit(api: Api, itemIds: string[], title: string) {
  const id = randomUUID(), now = new Date(Date.now() - 60000).toISOString();
  api.outfits.push({ id, owner_id: owners.a, title, occasion: 'everyday', notes: '', favourite: false, deleted_at: null, version: 1, created_at: now, updated_at: now });
  itemIds.forEach((itemId, position) => api.outfitItems.push({ owner_id: owners.a, outfit_id: id, item_id: itemId, position }));
  return id;
}
const result = (api: Api, outfitId: string | null, itemIds: string[], ageMs: number) => {
  const id = randomUUID();
  api.tryonControl.results.push({ id, owner: owners.a, outfitId, itemIds, image: api.fixture, completedAtMs: Date.now() - ageMs });
  return id;
};
/** Records the try-on read calls (by name) and every other try-on request, and the picture ids asked for. */
function watch(page: Page) {
  const calls: string[] = [], pictures: string[] = [], other: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/rest/v1/rpc/tryon_')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      calls.push(name);
      if (name === 'tryon_result_image_v1') pictures.push(String((request.postDataJSON() as Row).p_result_id));
    } else if (url.pathname.startsWith('/functions/v1/try-on')) other.push(request.url());
  });
  return { calls, pictures, other };
}
async function open(page: Page, build: (api: Api, clothes: Clothes) => void,
  options: { missing?: boolean; routes?: (page: Page, api: Api) => Promise<void> } = {}) {
  const api = await mockBackend(page);
  const clothes = seed(api);
  api.tryonControl.setup[owners.a] = { activated: true };
  api.tryonControl.consent[owners.a] = TRYON_NOTICE_REVISION;
  if (options.missing) api.tryonControl.missing = true;
  build(api, clothes);
  await options.routes?.(page, api);
  const seen = watch(page);
  await page.goto('/#/outfits'); await signIn(page);
  await expectSignedIn(page);
  return { api, clothes, seen };
}

test.describe('OUTFITS-PICTURES saved-outfit cards', () => {
  test('shows the newest matching picture, by the outfit or by its garments, and the collage when there is none', async ({ page }) => {
    const ids = {} as { own: string; ownNewest: string; idea: string };
    const { api, seen } = await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      const own = seedOutfit(api, full, 'Weekend');
      seedOutfit(api, [clothes.dress.id, clothes.shoes.id], 'Summer party');
      seedOutfit(api, [clothes.coat.id, clothes.cardigan.id, clothes.trousers.id], 'Cold day');
      result(api, own, full, 5_000_000);
      ids.ownNewest = result(api, own, full, 1_000_000);
      ids.idea = result(api, null, [clothes.shoes.id, clothes.dress.id], 2_000_000);
      // An idea picture of another set belongs to no card.
      result(api, null, [clothes.top.id, clothes.shoes.id], 100);
    });
    await expect(picture(page, 'Weekend')).toHaveCount(1);
    await expect(picture(page, 'Summer party')).toHaveCount(1);
    await expect(collage(page, 'Cold day')).toHaveCount(1);
    await expect(picture(page, 'Cold day')).toHaveCount(0);
    await expect(collage(page, 'Weekend')).toHaveCount(0);
    expect([...seen.pictures].sort()).toEqual([ids.ownNewest, ids.idea].sort());
    // The picture sits in the same box as the collage and the card still reads as its title.
    await expect(card(page, 'Weekend').locator('.outfit-card-picture')).toHaveAttribute('aria-hidden', 'true');
    await expect(card(page, 'Weekend').getByRole('link', { name: /Weekend/ })).toHaveAttribute('href', /#\/outfits\//);
    await axe(page);
    expect(api.tryonControl.requests).toHaveLength(0);
  });

  test('a one-garment picture made by hand (a dress with a coat) belongs to the saved outfit, on its card and in its details (TRYON-PROMPT3)', async ({ page }) => {
    const { seen } = await open(page, (api, clothes) => {
      seedOutfit(api, [clothes.dress.id, clothes.coat.id], 'Evening');
      seedOutfit(api, [clothes.top.id, clothes.coat.id], 'Errand');
      // The picture of an unsaved idea of the dress alone, made before the outfit was saved; another garment's picture belongs to no card.
      result(api, null, [clothes.dress.id], 1_000_000);
      result(api, null, [clothes.shoes.id], 100);
    });
    await expect(picture(page, 'Evening')).toHaveCount(1);
    await expect(collage(page, 'Evening')).toHaveCount(0);
    await expect(picture(page, 'Errand')).toHaveCount(0);
    expect(seen.pictures).toHaveLength(1);
    await card(page, 'Evening').getByRole('link', { name: /Evening/ }).click();
    await expect(page.locator('#outfit-detail-title')).toHaveText('Evening');
    await expect(page.locator('.tryon-saved-list img')).toHaveCount(1);
    await expect(page.locator('.outfit-composition li').filter({ hasText: 'Grey coat' })).toContainText('Optional');
  });

  test('uses only the read calls: no step, chain or claim request, and the results list once', async ({ page }) => {
    const { api, seen } = await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      result(api, seedOutfit(api, full, 'Weekend'), full, 1000);
    });
    await expect(picture(page, 'Weekend')).toHaveCount(1);
    await page.waitForTimeout(500);
    const allowed = new Set(['tryon_status', 'tryon_results_v1', 'tryon_result_image_v1']);
    expect(seen.calls.filter(name => !allowed.has(name))).toEqual([]);
    expect(seen.calls.filter(name => name === 'tryon_results_v1')).toHaveLength(1);
    expect(seen.other).toEqual([]);
    expect(api.tryonControl.requests).toHaveLength(0);
    expect(api.tryonControl.chainReads).toBe(0);
    expect(api.tryonControl.cancels).toEqual([]);
  });

  test('keeps the collage, without an error message, when the picture cannot be loaded', async ({ page }) => {
    const { seen } = await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      result(api, seedOutfit(api, full, 'Weekend'), full, 1000);
      result(api, seedOutfit(api, [clothes.dress.id, clothes.shoes.id], 'Summer party'), [clothes.dress.id, clothes.shoes.id], 1000);
    }, { routes: async p => {
      await p.route('**/rest/v1/rpc/tryon_result_image_v1', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' }));
    } });
    await expect.poll(() => seen.pictures.length).toBe(2);
    await page.waitForTimeout(300);
    await expect(collage(page, 'Weekend')).toHaveCount(1);
    await expect(collage(page, 'Summer party')).toHaveCount(1);
    await expect(page.locator('.outfit-card-picture')).toHaveCount(0);
    await expect(page.locator('.notice-error')).toHaveCount(0);
  });

  test('keeps the collage, without an error message, when the saved list cannot be read', async ({ page }) => {
    await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      result(api, seedOutfit(api, full, 'Weekend'), full, 1000);
    }, { routes: async p => {
      await p.route('**/rest/v1/rpc/tryon_results_v1', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' }));
    } });
    await expect(collage(page, 'Weekend')).toHaveCount(1);
    await page.waitForTimeout(500);
    await expect(page.locator('.outfit-card-picture')).toHaveCount(0);
    await expect(page.locator('.notice-error')).toHaveCount(0);
  });

  test('loads pictures only near the screen and at most three at a time', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    let inFlight = 0, peak = 0;
    const { seen } = await open(page, (api, clothes) => {
      for (let at = 0; at < 14; at++) {
        const items = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
        const id = seedOutfit(api, items, `Outfit ${String(at).padStart(2, '0')}`);
        result(api, id, items, 1000 + at);
      }
    }, { routes: async (p, api) => {
      await p.route('**/rest/v1/rpc/tryon_result_image_v1', async route => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 150));
        inFlight--;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'OK', jpegBase64: api.fixture.toString('base64'), bytes: api.fixture.length }) });
      });
    } });
    await expect(page.locator('.outfit-card-picture')).not.toHaveCount(0);
    await page.waitForTimeout(800);
    const before = seen.pictures.length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(14);
    await expect(async () => {
      await page.evaluate(() => window.scrollBy(0, 300));
      expect(await page.locator('.outfit-card-picture').count()).toBe(14);
    }).toPass({ timeout: 30_000, intervals: [100, 200, 300] });
    expect(peak).toBeLessThanOrEqual(3);
    expect(new Set(seen.pictures).size).toBe(14);
  });

  test('drops the pictures on sign-out', async ({ page }) => {
    await page.addInitScript(() => {
      const revoked: string[] = [];
      (window as unknown as { revoked: string[] }).revoked = revoked;
      const original = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url: string) => { revoked.push(url); original(url); };
    });
    await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      result(api, seedOutfit(api, full, 'Weekend'), full, 1000);
    });
    await expect(picture(page, 'Weekend')).toHaveCount(1);
    const url = await picture(page, 'Weekend').getAttribute('src');
    expect(url).toMatch(/^blob:/);
    await signOutThroughMenu(page);
    await expect(page.locator('.outfit-card')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { revoked: string[] }).revoked)).toContain(url);
  });

  test('keeps one 4:5 box for picture and collage cards, at 320 px with 200% text and in a wide grid', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      result(api, seedOutfit(api, full, 'Weekend'), full, 1000);
      seedOutfit(api, [clothes.coat.id, clothes.cardigan.id, clothes.trousers.id], 'Cold day');
    });
    await expect(picture(page, 'Weekend')).toHaveCount(1);
    const sizes = () => page.evaluate(() => ({
      boxes: [...document.querySelectorAll('.outfit-card-thumbs')].map(box => ({ w: box.getBoundingClientRect().width, h: box.getBoundingClientRect().height })),
      image: (() => { const box = document.querySelector('.outfit-card-picture img')!.getBoundingClientRect(); return { w: box.width, h: box.height }; })(),
      tops: [...document.querySelectorAll('.outfit-card-link')].map(link => Math.round(link.getBoundingClientRect().top)),
      scroll: document.documentElement.scrollWidth <= innerWidth,
    }));
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
      if (width === 320) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 32px; }' });
      await expect(picture(page, 'Weekend')).toHaveCount(1);
      const seen = await sizes();
      expect(seen.boxes).toHaveLength(2);
      for (const { w, h } of seen.boxes) expect(Math.abs(h - w * 1.25)).toBeLessThan(2);
      expect(Math.abs(seen.boxes[0]!.w - seen.boxes[1]!.w)).toBeLessThan(1);
      expect(Math.abs(seen.boxes[0]!.h - seen.boxes[1]!.h)).toBeLessThan(1);
      expect(Math.abs(seen.image.h - seen.boxes[0]!.h)).toBeLessThan(3);
      if (width === 1280) expect(seen.tops[0]).toBe(seen.tops[1]);
      expect(seen.scroll).toBe(true);
    }
  });

  test('stays on the collage when the pictures cannot be read, or this backend has no try-on', async ({ page }) => {
    const down = await open(page, (api, clothes) => {
      const full = [clothes.top.id, clothes.trousers.id, clothes.shoes.id];
      result(api, seedOutfit(api, full, 'Weekend'), full, 1000);
    }, { missing: true });
    await expect(collage(page, 'Weekend')).toHaveCount(1);
    await page.waitForTimeout(800);
    await expect(picture(page, 'Weekend')).toHaveCount(0);
    await expect(page.locator('.notice-error')).toHaveCount(0);
    expect(down.seen.calls).not.toContain('tryon_results_v1');
    expect(down.seen.calls).not.toContain('tryon_result_image_v1');
  });
});
