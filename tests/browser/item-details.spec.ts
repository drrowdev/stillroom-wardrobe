import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { messages, type Language } from '../../src/i18n';
import { mockBackend, owners, signIn } from './mock-backend';

const itemUrl = 'http://127.0.0.1:54321/rest/v1/items*';
const descriptionUrl = 'http://127.0.0.1:54321/rest/v1/rpc/update_image_description';
const nameSave = (page: Page, language: Language = 'en') => page.getByRole('button', { name: messages['detail.saveName'][language], exact: true });
const descriptionSave = (page: Page, language: Language = 'en') => page.getByRole('button', { name: messages['detail.saveDescription'][language], exact: true });
async function setup(page: Page, language: Language = 'en') {
  const api = await mockBackend(page, { initialLanguage: language });
  const saved = api.seedSavedItem();
  const foreign = api.seedSavedItem('b', 'Robin private');
  await page.goto('/'); await signIn(page);
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await expect(page.locator('#detail-title')).toHaveValue(saved.item.title);
  return { api, ...saved, foreign };
}
function writes(page: Page) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/rest/') && ['POST', 'PATCH', 'DELETE'].includes(request.method())) {
      calls.push({ method: request.method(), path: url.pathname, query: url.searchParams, body: request.postDataJSON() as Record<string, unknown> });
    }
  });
  return calls;
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`saved editor ${language}: independent explicit saves, clear and persisted reload`, async ({ page }) => {
    const { api, item, image, foreign } = await setup(page, language);
    const oldItem = structuredClone(item), oldImage = structuredClone(image), oldForeign = structuredClone(foreign);
    const oldFiles = [...api.files].map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]);
    const calls = writes(page);
    await expect(nameSave(page, language)).toBeDisabled();
    await expect(descriptionSave(page, language)).toBeDisabled();
    await expect(page.getByText(messages['settings.intro'][language], { exact: true })).toBeVisible();
    await page.locator('#detail-title').fill('Å overshirt 🌿');
    await page.locator('#detail-category').selectOption('layer');
    await page.locator('#detail-description').fill('Oma kuvaus / egen beskrivning');
    expect(calls).toHaveLength(0);
    await nameSave(page, language).click();
    await expect(page.getByText(messages['detail.nameSaved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#detail-description')).toHaveValue('Oma kuvaus / egen beskrivning');
    await expect(page.getByText(messages['detail.descriptionSaved'][language], { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#/items/${item.id}$`));
    expect(item).toEqual({ ...oldItem, title: 'Å overshirt 🌿', category: 'layer', version: 2, updated_at: item.updated_at,
      field_provenance: { title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } } });
    expect(image).toEqual(oldImage);
    await page.locator('#detail-title').fill('Sibling draft');
    await descriptionSave(page, language).click();
    await expect(page.getByText(messages['detail.descriptionSaved'][language], { exact: true })).toBeVisible();
    await expect(page.locator('#detail-title')).toHaveValue('Sibling draft');
    expect(image).toEqual({ ...oldImage, alt_text: 'Oma kuvaus / egen beskrivning', description_version: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query.get('id')).toBe(`eq.${item.id}`);
    expect(calls[0]!.query.get('owner_id')).toBe(`eq.${owners.a}`);
    expect(calls[0]!.query.get('version')).toBe('eq.1');
    expect(Object.keys(calls[0]!.body).sort()).toEqual(['category', 'field_provenance', 'title']);
    expect(calls[1]!.body).toEqual({ p_image_id: image.id, p_expected_description_version: 1, p_alt_text: 'Oma kuvaus / egen beskrivning' });
    page.once('dialog', (dialog) => { void dialog.accept(); });
    await page.reload();
    await expect(page.locator('#detail-title')).toHaveValue('Å overshirt 🌿');
    await expect(page.locator('#detail-description')).toHaveValue('Oma kuvaus / egen beskrivning');
    await page.getByRole('button', { name: messages['detail.clearDescription'][language], exact: true }).click();
    await descriptionSave(page, language).click();
    await expect(page.getByText(messages['detail.descriptionSaved'][language], { exact: true })).toBeVisible();
    expect(image.alt_text).toBe('');
    expect(item.version).toBe(2);
    await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(page.locator('.item-card h2')).toHaveText('Å overshirt 🌿');
    await page.locator(`a[href="#/items/${item.id}"]`).click();
    await expect(page.locator('#detail-description')).toHaveValue('');
    expect(foreign).toEqual(oldForeign);
    expect([...api.files].map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')])).toEqual(oldFiles);
    expect(api.requests.some((call) => call.path.startsWith('/functions/') || call.path.startsWith('/storage/') && call.method !== 'GET')).toBe(false);
    expect(api.uploadWire.posts).toBe(0);
  });
}
test('saved editor keeps required validation, literal XSS text and no implicit writes', async ({ page }) => {
  const { item } = await setup(page);
  const calls = writes(page);
  await page.locator('#detail-title').fill('   ');
  await expect(nameSave(page)).toBeDisabled();
  await page.locator('#detail-title').fill('x'.repeat(101));
  await expect(page.locator('#detail-title')).toHaveValue('x'.repeat(100));
  await page.locator('#detail-title').fill('<img src=x onerror=alert(1)>');
  await nameSave(page).click();
  await expect(page.getByText(messages['detail.nameSaved'].en, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.item-card h2')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.item-card h2 img')).toHaveCount(0);
  expect(item.title).toBe('<img src=x onerror=alert(1)>');
  expect(calls).toHaveLength(1);
});
test('language and offline changes preserve both drafts and disable offline writes', async ({ page, context }) => {
  await setup(page);
  await page.locator('#detail-title').fill('Oma nimi');
  await page.locator('#detail-description').fill('Egen beskrivning');
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.getByRole('button', { name: messages['account.menu'].fi }).click();
  await expect(page.locator('#detail-title')).toHaveValue('Oma nimi');
  await expect(page.locator('#detail-description')).toHaveValue('Egen beskrivning');
  await context.setOffline(true);
  await expect(nameSave(page, 'fi')).toBeDisabled();
  await expect(descriptionSave(page, 'fi')).toBeDisabled();
  await context.setOffline(false);
  await expect(nameSave(page, 'fi')).toBeEnabled();
  await expect(descriptionSave(page, 'fi')).toBeEnabled();
});
test('dirty Back navigation and hash changes require explicit discard and preserve cancel focus', async ({ page }) => {
  const { api, item } = await setup(page);
  const second = api.seedSavedItem('a', 'Second item');
  await page.locator('#detail-title').fill('Unsaved');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#detail-title')).toHaveValue('Unsaved');
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/items/${item.id}$`));
  await page.getByRole('button', { name: messages['common.continueEditing'].en, exact: true }).click();
  await page.evaluate((id) => { location.hash = `#/items/${id}`; }, second.item.id);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: messages['common.discard'].en, exact: true }).click();
  await expect(page.locator('#detail-title')).toHaveValue('Second item');
  expect(item.title).toBe('Olive overshirt');
});
test('conflict retains frozen draft and section reload never discards the sibling', async ({ page }) => {
  const { item } = await setup(page);
  await page.locator('#detail-title').fill('My attempt');
  await page.locator('#detail-description').fill('Sibling description');
  Object.assign(item, { title: 'Another saved name', version: 2 });
  await nameSave(page).click();
  await expect(page.locator('.detail-name [role="alert"]')).toBeFocused();
  await expect(page.locator('#detail-title')).toHaveValue('My attempt');
  await expect(nameSave(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: messages['detail.check'].en })).toHaveCount(0);
  await page.getByRole('button', { name: messages['detail.reload'].en }).click();
  await page.getByRole('button', { name: messages['common.continueEditing'].en }).click();
  await expect(page.locator('#detail-title')).toHaveValue('My attempt');
  await page.getByRole('button', { name: messages['detail.reload'].en }).click();
  await page.getByRole('button', { name: messages['common.discard'].en }).click();
  await expect(page.locator('#detail-title')).toHaveValue('Another saved name');
  await expect(page.locator('#detail-description')).toHaveValue('Sibling description');
});
for (const section of ['name', 'description'] as const) {
  test(`${section} lost response freezes attempt; read-only check confirms exact current state`, async ({ page }) => {
    const { item, image } = await setup(page);
    const calls = writes(page);
    const target = section === 'name' ? '#detail-title' : '#detail-description';
    const sibling = section === 'name' ? '#detail-description' : '#detail-title';
    await page.locator(target).fill('Attempted text');
    await page.locator(sibling).fill('Sibling draft');
    await page.route(section === 'name' ? itemUrl : descriptionUrl, async (route) => {
      if (route.request().method() === 'GET') { await route.fallback(); return; }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (section === 'name') Object.assign(item, body, { version: 2 });
      else Object.assign(image, { alt_text: body.p_alt_text, description_version: 2 });
      await route.fulfill({ status: 503, json: { message: 'Private upstream error' } });
    });
    await (section === 'name' ? nameSave(page) : descriptionSave(page)).click();
    await expect(page.getByText(messages['detail.unconfirmed'].en, { exact: true })).toBeVisible();
    await expect(page.locator(target)).toBeDisabled();
    await expect(page.locator(sibling)).toHaveValue('Sibling draft');
    await expect(page.getByText('Private upstream error')).toHaveCount(0);
    await page.getByRole('button', { name: messages['detail.check'].en }).click();
    await expect(page.getByText(messages[section === 'name' ? 'detail.nameSaved' : 'detail.descriptionSaved'].en, { exact: true })).toBeVisible();
    expect(calls).toHaveLength(1);
    await expect(page.locator(sibling)).toHaveValue('Sibling draft');
    await expect(page.locator(target)).toBeEnabled();
  });
}
for (const mismatch of ['later version', 'unchanged version', 'untouched physical fact', 'untouched provenance', 'replacement image'] as const) {
  test(`read-only reconciliation refuses ${mismatch} despite equal text`, async ({ page }) => {
    const { item, image, api } = await setup(page);
    const calls = writes(page);
    const description = mismatch === 'replacement image';
    await page.locator(description ? '#detail-description' : '#detail-title').fill('Attempted text');
    await page.route(description ? descriptionUrl : itemUrl, async (route) => {
      if (route.request().method() === 'GET') { await route.fallback(); return; }
      if (description) {
        const replacement = { ...image, id: '30000000-0000-4000-8000-000000000099', alt_text: 'Attempted text', description_version: 2 };
        replacement.main_path = `${owners.a}/${item.id}/${replacement.id}/main.jpg`;
        replacement.thumb_path = `${owners.a}/${item.id}/${replacement.id}/thumb.jpg`;
        api.images.splice(api.images.indexOf(image), 1, replacement);
      } else {
        Object.assign(item, route.request().postDataJSON(), { version: mismatch === 'later version' ? 3 : mismatch === 'unchanged version' ? 1 : 2 });
        if (mismatch === 'untouched physical fact') Object.assign(item, { warmth: 4 });
        if (mismatch === 'untouched provenance') Object.assign(item, { field_provenance: { ...item.field_provenance, warmth: { kind: 'user', revision: 1 } } });
      }
      await route.fulfill({ status: 503, json: {} });
    });
    await (description ? descriptionSave(page) : nameSave(page)).click();
    await expect(page.getByRole('button', { name: messages['detail.check'].en })).toBeVisible();
    await page.getByRole('button', { name: messages['detail.check'].en }).click();
    await expect(page.getByText(messages['detail.conflicting'].en, { exact: true })).toBeVisible();
    await expect(page.locator(description ? '#detail-description' : '#detail-title')).toHaveValue('Attempted text');
    expect(calls).toHaveLength(1);
    await expect(description ? descriptionSave(page) : nameSave(page)).toBeDisabled();
  });
}
test('known description rejection is not reported as an ambiguous success', async ({ page }) => {
  await setup(page);
  await page.route(descriptionUrl, (route) => route.fulfill({ status: 403, json: { code: '42501', message: 'Private SQL message' } }));
  await page.locator('#detail-description').fill('Attempt');
  await descriptionSave(page).click();
  await expect(page.getByText(messages['detail.rejected'].en, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: messages['detail.check'].en })).toHaveCount(0);
  await expect(page.getByText('Private SQL message')).toHaveCount(0);
});
test('strict routes make malformed, foreign, absent and pending-only items generically unavailable', async ({ page }) => {
  const { api, foreign, item } = await setup(page);
  const pending = api.seedSavedItem('a', 'Incomplete');
  pending.image.state = 'pending';
  for (const id of [item.id.toUpperCase(), item.id + '/', item.id + '?query=1', 'bad', foreign.item.id, pending.item.id, '20000000-0000-4000-8000-000000000099']) {
    await page.evaluate((id) => { location.hash = '#/items/' + id; }, id);
    await expect(page.getByText(messages['detail.unavailable'].en, { exact: true })).toBeVisible();
    await expect(page.locator('#detail-title')).toHaveCount(0);
    await expect(page.getByText('Robin private', { exact: true })).toHaveCount(0);
  }
  await page.evaluate(() => { location.hash = '#/items/new'; });
  await expect(page.locator('#capture-title')).toBeVisible();
});
test('missing image bytes show the existing treatment without disabling saved text corrections', async ({ page }) => {
  const api = await mockBackend(page, { initialLanguage: 'en' });
  const saved = api.seedSavedItem(); api.files.delete(saved.image.main_path);
  await page.goto('/'); await signIn(page);
  await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
  await expect(page.getByText(messages['photo.missing'].en, { exact: true })).toBeVisible();
  await page.locator('#detail-title').fill('Text correction');
  await nameSave(page).click();
  await expect(page.getByText(messages['detail.nameSaved'].en, { exact: true })).toBeVisible();
});
test('late item reads cannot populate a different item editor', async ({ page }) => {
  const { api, item } = await setup(page);
  const second = api.seedSavedItem('a', 'Second item');
  let held: Route | undefined;
  await page.route(itemUrl, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('id') === `eq.${item.id}`) held = route;
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator(`a[href="#/items/${item.id}"]`).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate((id) => { location.hash = '#/items/' + id; }, second.item.id);
  await expect(page.locator('#detail-title')).toHaveValue('Second item');
  await held!.fulfill({ json: item }).catch(() => {});
  await expect(page.locator('#detail-title')).toHaveValue('Second item');
});
test('pending writes are single-flight and block navigation, but logout clears them and late replies', async ({ page }) => {
  const { item, foreign } = await setup(page);
  let held: Route | undefined;
  const calls = writes(page);
  await page.route(itemUrl, async (route) => {
    if (route.request().method() === 'PATCH') held = route;
    else await route.fallback();
  });
  await page.locator('#detail-title').fill('Never show to Robin');
  await nameSave(page).focus(); await page.keyboard.press('Enter');
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('.detail-name form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/items/${item.id}$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: messages['account.menu'].en }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].en, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await signIn(page, 'b');
  await expect(page.locator('.workspace-identity')).toContainText('Robin');
  await page.evaluate((id) => { location.hash = '#/items/' + id; }, foreign.item.id);
  await expect(page.locator('#detail-title')).toHaveValue('Robin private');
  await held!.fulfill({ json: { ...item, title: 'Never show to Robin', version: 2 } }).catch(() => {});
  await expect(page.locator('#detail-title')).toHaveValue('Robin private');
  await expect(page.getByText(messages['detail.nameSaved'].sv, { exact: true })).toHaveCount(0);
});
test('a description save can finish while the independent item attempt remains pending', async ({ page }) => {
  const { item, image } = await setup(page);
  let held: Route | undefined;
  await page.route(itemUrl, async (route) => {
    if (route.request().method() === 'PATCH') held = route; else await route.fallback();
  });
  await page.locator('#detail-title').fill('Pending name');
  await nameSave(page).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('#detail-description').fill('Saved description');
  await descriptionSave(page).click();
  await expect(page.getByText(messages['detail.descriptionSaved'].en, { exact: true })).toBeVisible();
  await expect(page.locator('#detail-title')).toHaveValue('Pending name');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/items/${item.id}$`));
  expect(image.alt_text).toBe('Saved description');
  await held!.fallback();
  await expect(page.getByText(messages['detail.nameSaved'].en, { exact: true })).toBeVisible();
  expect(item.title).toBe('Pending name');
});
for (const pending of ['read', 'description write'] as const) {
  test(`UID change clears saved editor and ignores its late ${pending}`, async ({ page }) => {
    const { item, image, foreign } = await setup(page);
    let held: Route | undefined;
    await page.route(pending === 'read' ? itemUrl : descriptionUrl, async (route) => {
      const url = new URL(route.request().url());
      if (pending !== 'read' || url.searchParams.get('id') === `eq.${item.id}` && url.searchParams.get('owner_id') === `eq.${owners.a}`) held = route;
      else await route.fallback();
    });
    if (pending === 'read') {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.locator(`a[href="#/items/${item.id}"]`).click();
    } else {
      await page.locator('#detail-description').fill('Never show to next owner');
      await descriptionSave(page).click();
    }
    await expect.poll(() => Boolean(held)).toBe(true);
    expect(await page.evaluate(async () => {
      const modulePath = '/src/data/client.ts';
      const { makeClient } = await import(modulePath) as typeof import('../../src/data/client');
      const client = makeClient({ url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_browser_fixture_only', version: 'browser-fixture' });
      const result = await client.auth.signInWithPassword({ email: 'user-b@example.test', password: 'fictional-test-password' });
      return !result.error;
    })).toBe(true);
    await expect(page.locator('.workspace-identity')).toContainText('Robin');
    await page.evaluate((id) => { location.hash = '#/items/' + id; }, foreign.item.id);
    await expect(page.locator('#detail-title')).toHaveValue('Robin private');
    await held!.fulfill({ json: pending === 'read' ? item :
      [{ id: image.id, owner_id: owners.a, item_id: item.id, alt_text: 'Never show to next owner', description_version: 2 }] }).catch(() => {});
    await expect(page.locator('#detail-title')).toHaveValue('Robin private');
    await expect(page.locator('#detail-description')).toHaveValue('An olive overshirt');
    await expect(page.getByText(messages['detail.descriptionSaved'].sv, { exact: true })).toHaveCount(0);
  });
}
test('saved detail accessibility: keyboard, 320px and 200% text', async ({ page }) => {
  await setup(page, 'fi');
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('#detail-title').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#detail-category')).toBeFocused();
  await page.locator('#detail-title').fill('Å'.repeat(100));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 2rem; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('synthetic saved detail visual evidence retains functional assertions in every project', async ({ page }, testInfo) => {
  const { api, item } = await setup(page);
  await expect(page.locator('.detail-photo img')).toBeVisible();
  const directory = path.resolve('test-results/i29b-visual');
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  const captures = [
    { language: 'en', width: 1280, file: 'item-details-en-desktop.png' },
    { language: 'fi', width: 320, file: 'item-details-fi-mobile.png' },
  ] as const;
  for (const capture of captures) {
    if (capture.language === 'fi') {
      await page.getByRole('button', { name: messages['account.menu'].en }).click();
      await page.getByRole('button', { name: 'Suomi', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
      await page.getByRole('button', { name: messages['account.menu'].fi }).click();
    }
    await page.setViewportSize({ width: capture.width, height: 900 });
    expect(api.profiles[owners.a]?.owner_id === owners.a && api.profiles[owners.a]?.ui_language === capture.language
      && api.requests.filter((request) => request.path.startsWith('/rest/')).every((request) => request.owner === owners.a && request.ownerFilter === `eq.${owners.a}`)).toBe(true);
    expect(await page.evaluate(({ origin, language, id }) => {
      const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
      const values = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')]
        .filter(visible).map((element) => element.value).join('\n');
      const credentialLike = /jwt|eyJ|sb_|service_role|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
      return location.origin === origin && location.hostname === '127.0.0.1' && location.hash === '#/items/' + id
        && document.documentElement.lang === language && Boolean(document.querySelector('#item-detail-title'))
        && document.querySelector('.workspace-identity')?.textContent?.includes('Alex') === true
        && document.querySelector<HTMLInputElement>('#detail-title')?.value === 'Olive overshirt'
        && document.querySelector<HTMLSelectElement>('#detail-category')?.value === 'top'
        && document.querySelector<HTMLTextAreaElement>('#detail-description')?.value === 'An olive overshirt'
        && !document.querySelector('input[type="password"], #email, #password')
        && !credentialLike.test(document.body.innerText) && !credentialLike.test(values);
    }, { origin, language: capture.language, id: item.id }), 'Synthetic saved detail capture guard').toBe(true);
    await expect(nameSave(page, capture.language)).toBeDisabled();
    await expect(descriptionSave(page, capture.language)).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (testInfo.project.name === 'chromium') {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, capture.file), fullPage: true });
    }
  }
  if (testInfo.project.name === 'chromium') {
    expect((await readdir(directory)).sort()).toEqual(captures.map((capture) => capture.file).sort());
    for (const capture of captures) {
      const file = path.join(directory, capture.file), metadata = await lstat(file);
      expect(metadata.isFile() && metadata.size > 24 && metadata.size <= 1024 * 1024, 'Bounded PNG file').toBe(true);
      const handle = await open(file, 'r');
      try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        expect(bytesRead === 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && header.toString('ascii', 12, 16) === 'IHDR' && header.readUInt32BE(16) === capture.width,
        'PNG type and viewport width').toBe(true);
      } finally { await handle.close(); }
    }
  }
});
