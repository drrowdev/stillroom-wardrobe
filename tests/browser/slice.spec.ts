import { expect, test, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { messages, type Language } from '../../src/i18n';
import { inspectJpegSegments } from '../fixtures/jpeg-helpers';
import { mockBackend, owners, signIn } from './mock-backend';

for (const language of ['en', 'fi', 'sv'] satisfies Language[]) {
  test(`photo, editable draft and explicit save in ${language}`, async ({ page }) => {
    const backend = await mockBackend(page);
    await page.goto('/');
    await page.getByRole('button', { name: messages[`language.${language}`][language], exact: true }).click();
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'][language]);
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
    await expect(page.locator('.capture-photo img')).toBeVisible();
    expect(backend.items).toHaveLength(0);
    expect(backend.files.size).toBe(0);
    await page.locator('#item-title').fill('My edited olive shirt');
    await page.locator('#item-category').selectOption('top');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('An olive shirt, front view');
    await page.getByRole('button', { name: messages['capture.save'][language] }).click();
    await expect(page.locator('.item-caption h2')).toHaveText('My edited olive shirt');
    await expect(page.locator('.item-photo img')).toHaveAttribute('alt', 'An olive shirt, front view');
    expect(backend.items).toHaveLength(1);
    expect(backend.images[0]?.state).toBe('ready');
    expect(backend.files.size).toBe(2);
    expect(backend.profiles[owners.a]?.ui_language).toBe(language);
    expect(backend.profiles[owners.b]?.ui_language).toBe('sv');
    for (const bytes of backend.files.values()) {
      expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
      expect(bytes.length).toBeLessThanOrEqual(512000);
    }
  });
}

for (const language of ['en', 'fi', 'sv'] satisfies Language[]) {
  test(`accessibility of private preparation details, cancel and same-file reselection in ${language}`, async ({ page }) => {
    const backend = await mockBackend(page, { initialLanguage: language });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await signIn(page);
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await page.locator('#item-title').fill('Manual synthetic title');
    await page.locator('#item-category').selectOption('top');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('Manual synthetic description');
    await page.locator('#item-alt').fill('');
    const input = page.locator('input[type="file"]').first();
    const show = page.getByRole('button', { name: messages['photo.showDetails'][language] });
    await expect(show).toHaveCount(0);
    const before = backend.requests.length;
    const invalid = { name: 'PRIVATE_FILENAME_FIXTURE.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) };
    await input.setInputFiles(invalid);
    await expect(page.getByRole('alert')).toHaveText(messages['photo.invalid'][language]);
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#preparation-details')).toBeHidden();
    await show.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('region', { name: messages['photo.details'][language] });
    await expect(details).toBeVisible();
    await expect(details).toHaveText(messages['photo.stageSource'][language] + messages['photo.reasonInvalid'][language]);
    await expect(details).not.toHaveAttribute('aria-live');
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('button', { name: messages['photo.hideDetails'][language] })).toBeFocused();
    await expect(page.locator('body')).not.toContainText('PRIVATE_FILENAME_FIXTURE');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await input.setInputFiles([]);
    await expect(details).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(messages['photo.invalid'][language]);
    await input.setInputFiles(invalid);
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
    // A mislabeled synthetic JPEG proves byte admission, not native HEIC picker conversion.
    await input.setInputFiles({ name: 'synthetic.heic', mimeType: 'application/octet-stream', buffer: backend.fixture });
    await expect(page.locator('.capture-photo img')).toBeVisible();
    await expect(show).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const preview = await page.locator('.capture-photo img').getAttribute('src');
    await input.setInputFiles([]);
    await expect(page.locator('.capture-photo img')).toHaveAttribute('src', preview!);
    await expect(page.locator('#item-title')).toHaveValue('Manual synthetic title');
    await expect(page.locator('#item-category')).toHaveValue('top');
    await expect(page.locator('#item-alt')).toHaveValue('');
    expect(backend.requests.slice(before)).toEqual([]);
    expect(backend.items).toHaveLength(0);
    expect(backend.files.size).toBe(0);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    await page.getByRole('button', { name: messages['common.cancel'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['common.discard'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await expect(show).toHaveCount(0);
    await expect(page.locator('#item-title')).toHaveValue('');
    await expect(page.locator('.capture-photo img')).toHaveCount(0);
  });
}

type PhotoReadProbe = Window & { photoReadStarted?: boolean; releasePhotoRead?: () => void };
async function holdNextPhotoRead(page: Page) {
  await page.evaluate(() => {
    const probe = window as PhotoReadProbe;
    probe.photoReadStarted = false;
    const native = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      Blob.prototype.arrayBuffer = native;
      probe.photoReadStarted = true;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        probe.releasePhotoRead = () => {
          delete probe.releasePhotoRead;
          void native.call(this).then(resolve, reject);
        };
      });
    };
  });
}

test('late selection cannot overwrite a replacement or manual edits and clears no-file cancellation correctly', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  const before = backend.requests.length;
  await holdNextPhotoRead(page);
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: 'old.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) });
  await expect.poll(() => page.evaluate(() => (window as PhotoReadProbe).photoReadStarted)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save to my wardrobe' })).toBeDisabled();
  await page.locator('#item-title').fill('Edited while preparing');
  await page.locator('#item-category').selectOption('bottom');
  const replacement = { name: 'same.jpg', mimeType: 'image/jpeg', buffer: backend.fixture };
  await input.setInputFiles(replacement);
  await expect(page.locator('.capture-photo img')).toBeVisible();
  const preview = await page.locator('.capture-photo img').getAttribute('src');
  await page.evaluate(() => (window as PhotoReadProbe).releasePhotoRead?.());
  await expect(page.locator('.capture-photo img')).toHaveAttribute('src', preview!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#item-title')).toHaveValue('Edited while preparing');
  await expect(page.locator('#item-category')).toHaveValue('bottom');
  await input.setInputFiles(replacement);
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await expect(page.locator('.capture-photo img')).not.toHaveAttribute('src', preview!);
  expect(backend.requests.slice(before)).toEqual([]);
});

test('discard and owner logout clear preparation details and ignore late photo reads', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) });
  await page.getByRole('button', { name: 'Show preparation details' }).click();
  await page.locator('#item-title').fill('Unsaved synthetic');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) });
  await page.getByRole('button', { name: 'Show preparation details' }).click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await signIn(page, 'b');
  await expect(page.locator('#capture-title')).toHaveText(messages['capture.title'].sv);
  await expect(page.locator('#item-title')).toHaveValue('');
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await holdNextPhotoRead(page);
  await input.setInputFiles({ name: 'late.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect.poll(() => page.evaluate(() => (window as PhotoReadProbe).photoReadStarted)).toBe(true);
  await page.getByRole('button', { name: messages['account.menu'].sv }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].sv, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await page.evaluate(() => (window as PhotoReadProbe).releasePhotoRead?.());
  await expect(page.locator('.capture-photo img')).toHaveCount(0);
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(backend.items).toHaveLength(0);
  expect(backend.files.size).toBe(0);
});

test('discarding a prepared draft creates no library records', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  const before = backend.requests.length;
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await page.locator('#item-title').fill('Unsaved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing' }).click();
  await expect(page.locator('#item-title')).toHaveValue('Unsaved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(backend.items).toHaveLength(0);
  expect(backend.files.size).toBe(0);
  expect(backend.requests.slice(before)).toEqual([]);
});

test('retrying a failed commit reuses the same records and image bytes', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en', failCommitOnce: true });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await page.locator('#item-title').fill('A retryable shirt');
  await page.locator('#item-category').selectOption('top');
  await page.getByRole('button', { name: 'Save to my wardrobe' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const image = { ...backend.images[0] };
  const item = { ...backend.items[0] };
  const files = new Map([...backend.files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  for (const variant of ['main', 'thumb']) {
    const bytes = files.get(`${owners.a}/${item.id}/${image.id}/${variant}.jpg`)!;
    expect(bytes.length).toBe(image[`${variant}_bytes`]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(image[`${variant}_sha256`]);
  }
  await expect(page.locator('#item-title')).toHaveAttribute('readonly');
  await expect(page.locator('#item-category')).toBeDisabled();
  await expect(page.locator('input[type="file"]').first()).toBeDisabled();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.item-caption h2')).toHaveText('A retryable shirt');
  expect(backend.items).toHaveLength(1);
  expect(backend.images).toHaveLength(1);
  expect(backend.files.size).toBe(2);
  expect(backend.items[0]).toEqual(item);
  expect(backend.images[0]).toEqual({ ...image, state: 'ready' });
  expect(backend.files).toEqual(files);
  for (const variant of ['main', 'thumb']) {
    const path = `${owners.a}/${item.id}/${image.id}/${variant}.jpg`;
    const bytes = backend.files.get(path)!;
    expect(bytes).toEqual(files.get(path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(image[`${variant}_sha256`]);
    expect(bytes.length).toBe(image[`${variant}_bytes`]);
    expect(inspectJpegSegments(bytes).some((segment) => segment.marker === 0xfe ||
      (segment.marker >= 0xe1 && segment.marker <= 0xef))).toBe(false);
  }
});

test('logout clears private state before another owner signs in', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'fi' });
  await page.goto('/');
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.getByRole('button', { name: messages['account.menu'].fi }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].fi }).click();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Alex', { exact: true })).toHaveCount(0);
  await signIn(page, 'b');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.locator('.account-button')).toContainText('Robin');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('stillroom')))).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test('offline save is disabled without losing draft text', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('#item-title').fill('Still here');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save to my wardrobe' })).toBeDisabled();
  await expect(page.locator('#item-title')).toHaveValue('Still here');
});

test('a failed language save stays visible without pretending to persist', async ({ page }) => {
  const backend = await mockBackend(page, { failLanguageSave: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(page.locator('.language-warning')).toContainText(messages['account.languageRetry'].fi);
  expect(backend.profiles[owners.a]?.ui_language).toBeNull();
});

test('sign-out is broadcast across tabs without sending account data', async ({ page, context }) => {
  const second = await context.newPage();
  await mockBackend(page, { initialLanguage: 'en' });
  await mockBackend(second, { initialLanguage: 'en' });
  await page.goto('/');
  await second.goto('/');
  await signIn(page);
  // A session belongs to the tab that signed in; the SDK's cross-tab broadcast must not adopt it.
  await expect(second.locator('#email')).toBeVisible();
  await signIn(second);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(second.locator('#wardrobe-title')).toBeVisible();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(second.locator('#email')).toBeVisible();
  await expect(second.getByText('Alex', { exact: true })).toHaveCount(0);
  await second.close();
});

type AuthMarkers = Window & { authEvents?: Array<{ event: string; owner: string | null }> };
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function observeSdkEvents(page: Page) {
  await page.evaluate(async () => {
    const modulePath = '/src/data/client.ts';
    const { makeClient } = await import(modulePath) as typeof import('../../src/data/client');
    const client = makeClient({
      url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_browser_fixture_only', version: 'browser-fixture',
    });
    const markers = window as AuthMarkers;
    markers.authEvents = [];
    client.auth.onAuthStateChange((event, session) => {
      const owner = session?.user.id ?? null;
      // Run after the controller's queued callback, without retaining a session/token.
      setTimeout(() => markers.authEvents?.push({ event, owner }), 0);
    });
  });
}

for (const firstOwner of ['a', 'b'] as const) {
  test(`different-account tabs retain their owner when ${firstOwner} signs in first, and logout clears both`, async ({ page, context }) => {
    const second = await context.newPage();
    const tabs = { a: page, b: second };
    const backends = {
      a: await mockBackend(page, { initialLanguage: 'fi' }),
      b: await mockBackend(second, { initialLanguage: 'fi' }),
    };
    const content = {
      a: { name: 'Alex', language: 'fi', title: 'Fictional moss overshirt', alt: 'Moss overshirt front view' },
      b: { name: 'Robin', language: 'sv', title: 'Fictional ochre trousers', alt: 'Ochre trousers front view' },
    } as const;
    const other = (owner: 'a' | 'b') => owner === 'a' ? 'b' : 'a';
    for (const backend of Object.values(backends)) {
      for (const owner of ['a', 'b'] as const) {
        const itemId = `20000000-0000-4000-8000-${owner === 'a' ? '000000000001' : '000000000002'}`;
        const imageId = `30000000-0000-4000-8000-${owner === 'a' ? '000000000001' : '000000000002'}`;
        const prefix = `${owners[owner]}/${itemId}/${imageId}`;
        backend.items.push({ id: itemId, owner_id: owners[owner], title: content[owner].title, category: owner === 'a' ? 'top' : 'bottom', created_at: '2026-09-06T00:00:00Z', deleted_at: null });
        backend.images.push({ id: imageId, owner_id: owners[owner], item_id: itemId, state: 'ready', main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`, alt_text: content[owner].alt });
        backend.files.set(`${prefix}/thumb.jpg`, backend.fixture);
      }
    }
    const assertOwn = async (owner: 'a' | 'b') => {
      const tab = tabs[owner], own = content[owner], foreign = content[other(owner)];
      await expect(tab.locator('html')).toHaveAttribute('lang', own.language);
      await expect(tab.locator('.account-button')).toContainText(own.name);
      await expect(tab.locator('.workspace-identity')).toContainText(own.name);
      await expect(tab.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'][own.language]);
      await expect(tab.locator('.item-caption h2')).toHaveText(own.title);
      await expect(tab.locator('.item-photo img')).toHaveAttribute('alt', own.alt);
      await expect(tab.locator('.item-photo img')).toHaveJSProperty('complete', true);
      await expect(tab.locator('.item-photo img')).toHaveJSProperty('naturalWidth', 2);
      await expect(tab.getByText(foreign.name, { exact: true })).toHaveCount(0);
      await expect(tab.getByText(foreign.title, { exact: true })).toHaveCount(0);
      await expect(tab.getByAltText(foreign.alt)).toHaveCount(0);
      const requests = backends[owner].requests.filter((request) => request.method === 'GET' && /^\/(rest|storage)\//.test(request.path));
      expect(requests.some((request) => request.path === '/rest/v1/items')).toBe(true);
      expect(requests.some((request) => request.path.startsWith('/storage/'))).toBe(true);
      expect(requests.every((request) => request.owner === owners[owner])).toBe(true);
      expect(requests.filter((request) => request.path.startsWith('/rest/')).every((request) => request.ownerFilter === `eq.${owners[owner]}`)).toBe(true);
    };
    for (const tab of Object.values(tabs)) {
      await tab.goto('/');
      await expect(tab.locator('#email')).toBeVisible();
      await observeSdkEvents(tab);
    }
    await signIn(tabs[firstOwner], firstOwner);
    await assertOwn(firstOwner);
    const secondOwner = other(firstOwner);
    await signIn(tabs[secondOwner], secondOwner);
    await expect.poll(() => tabs[firstOwner].evaluate(() => (window as AuthMarkers).authEvents))
      .toContainEqual({ event: 'SIGNED_IN', owner: owners[secondOwner] });
    await assertOwn(firstOwner);
    await assertOwn(secondOwner);
    // Recovery broadcasts a real SDK SIGNED_IN back to the already signed-in second owner.
    await tabs[secondOwner].evaluate(() => { (window as AuthMarkers).authEvents = []; });
    await tabs[firstOwner].reload();
    await expect.poll(() => tabs[secondOwner].evaluate(() => (window as AuthMarkers).authEvents))
      .toContainEqual({ event: 'SIGNED_IN', owner: owners[firstOwner] });
    await assertOwn(firstOwner);
    await assertOwn(secondOwner);
    await tabs[secondOwner].reload();
    for (const owner of ['a', 'b'] as const) {
      const tab = tabs[owner];
      const response = tab.waitForResponse((result) => new URL(result.url()).pathname === '/rest/v1/profiles');
      await tab.bringToFront();
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      const result = await response;
      expect(result.status()).toBe(200);
      await result.finished();
      await assertOwn(owner);
    }

    // Hold actual owner-profile replies across logout; cancellation must prevent restoration.
    const held: Array<{ release: ReturnType<typeof latch>; finished: ReturnType<typeof latch>; cancelled: Promise<Request> }> = [];
    for (const owner of ['a', 'b'] as const) {
      const started = latch(), release = latch(), finished = latch();
      const cancelled = tabs[owner].waitForEvent('requestfailed', {
        predicate: (request) => new URL(request.url()).pathname === '/rest/v1/profiles',
      });
      await tabs[owner].route('**/rest/v1/profiles?**', async (route) => {
        started.resolve();
        await release.promise;
        await route.fulfill({ json: backends[owner].profiles[owners[owner]] });
        finished.resolve();
      });
      await tabs[owner].evaluate(() => window.dispatchEvent(new Event('focus')));
      await started.promise;
      held.push({ release, finished, cancelled });
    }
    const logoutTab = tabs[firstOwner], language = content[firstOwner].language;
    await logoutTab.getByRole('button', { name: messages['account.menu'][language] }).click();
    await logoutTab.getByRole('button', { name: messages['auth.signOut'][language], exact: true }).click();
    for (const tab of Object.values(tabs)) await expect(tab.locator('#email')).toBeVisible();
    await Promise.all(held.map((pending) => pending.cancelled));
    for (const pending of held) pending.release.resolve();
    await Promise.all(held.map((pending) => pending.finished.promise));
    for (const tab of Object.values(tabs)) {
      await expect(tab.locator('.workspace')).toHaveCount(0);
      await expect(tab.locator('html')).toHaveAttribute('lang', 'en');
      expect(await tab.evaluate(() => [sessionStorage, localStorage].flatMap((store) => Object.keys(store).filter((key) => key.startsWith('stillroom'))))).toEqual([]);
      expect(await tab.evaluate(() => caches.keys())).toEqual([]);
      expect(await tab.evaluate(() => indexedDB.databases())).toEqual([]);
      await tab.reload();
      await expect(tab.locator('#email')).toBeVisible();
      await expect(tab.locator('.item-photo img')).toHaveCount(0);
      for (const value of Object.values(content)) {
        await expect(tab.getByText(value.name, { exact: true })).toHaveCount(0);
        await expect(tab.getByText(value.title, { exact: true })).toHaveCount(0);
      }
    }
  });
}

test('accessibility while wardrobe items are loading', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  const started = latch(), release = latch();
  await page.route('**/rest/v1/items?**', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    started.resolve();
    await release.promise;
    await route.fallback();
  });
  const loading = page.locator('.item-grid[aria-busy="true"]');
  try {
    await page.goto('/');
    await signIn(page);
    await started.promise;
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-label', messages['common.loading'].en);
    await expect(loading.locator('.loading-card')).toHaveCount(4);
    const results = await new AxeBuilder({ page }).analyze();
    await expect(loading).toBeVisible();
    expect(results.violations).toEqual([]);
    await expect(page.getByRole('region', { name: messages['common.loading'].en, exact: true })).toHaveAttribute('aria-busy', 'true');
  } finally {
    release.resolve();
  }
  await expect(loading).toHaveCount(0);
  await expect(page.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'].en);
  await expect(page.getByRole('button', { name: messages['wardrobe.firstItem'].en })).toBeVisible();
  expect(backend.requests).toContainEqual({ method: 'GET', path: '/rest/v1/items', owner: owners.a, ownerFilter: `eq.${owners.a}` });
});

test('accessibility and 320px layout across login, empty wardrobe and draft', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await expect(page.locator('#email')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await expect(page.locator('#capture-title')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
