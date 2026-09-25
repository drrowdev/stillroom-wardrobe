import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { languages, messages, translate, type Language, type MessageKey } from '../../src/i18n';
import { aiFixture, manualEntry } from './ai-photo-first-support';
import { mockBackend, recoveryHash, signIn } from './mock-backend';

// I24: dialogs, editors and the P6c/service-worker surfaces in every language, at 320px and with 200% text.
const text = (language: Language, key: MessageKey, parameters?: Record<string, string | number>) => translate(language, key, parameters);
const button = (scope: Page | Locator, language: Language, key: MessageKey) => scope.getByRole('button', { name: text(language, key), exact: true });
const largeText = 'html { font-size: 200%; } body { font-size: 32px; }';
const secret = 'fictional delete password';

type Check = { overflow: boolean; clipped: string[]; small: string[]; split: string[] };
async function layout(page: Page, scope: string): Promise<Check> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`Missing ${selector}`);
    // Screen-reader-only text is deliberately clipped to 1px and is not checked here.
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('.sr-only');
    };
    const target = (element: Element) => {
      if (element instanceof HTMLInputElement && (['checkbox', 'radio'].includes(element.type) || element.matches('.sr-only')))
        return element.labels?.[0] ?? element.closest('label') ?? element;
      return element;
    };
    const name = (element: Element) => `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}"`;
    // Text that does not fit its own box, or that reaches past the viewport, is clipped or overlaps.
    const clipped = [...root.querySelectorAll('button, label, a, summary, legend, h1, h2, h3, p, li, dt, dd, [role=alert], [role=status]')]
      .filter((element) => shown(element) && getComputedStyle(element).display !== 'inline')
      .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.getBoundingClientRect().right > innerWidth + 1)
      .map(name);
    const small = [...root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]')]
      .filter((element) => (shown(element) || element.matches('input.sr-only') && (element as HTMLElement).tabIndex >= 0) && !(element.matches('a') && element.closest('p')))
      .map((element) => ({ element, box: target(element).getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ element, box }) => `${name(element)} ${Math.round(box.width)}x${Math.round(box.height)}`);
    // Dialog titles and buttons must wrap between words. A word may break only when it is wider than the
    // dialog's whole content box AND its title or button already takes the full width of its row, so a
    // squeezed button breaking letter by letter still fails.
    const split: string[] = [];
    const content = (element: Element) => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    for (const element of root.querySelectorAll(':is(dialog[open], dialog[open] *):is(h2, button)')) {
      const room = content(element.closest('dialog')!);
      const full = element.getBoundingClientRect().width >= content(element.parentElement!) - 1;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent ?? '';
        for (const match of value.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
          const lines = new Set(rects.map((rect) => Math.round(rect.top)));
          const width = rects.reduce((sum, rect) => sum + rect.width, 0);
          if (lines.size > 1 && (width <= room + 1 || !full)) split.push(`${element.tagName.toLowerCase()} "${match[0]}"`);
        }
      }
    }
    return { overflow: document.documentElement.scrollWidth > innerWidth, clipped: [...new Set(clipped)], small, split };
  }, scope);
}

/** Every dialog action can be scrolled to inside the dialog and is then fully visible and not covered. */
async function reachable(page: Page, label: string) {
  const actions = page.locator('dialog[open] .dialog-actions button');
  const count = await actions.count();
  expect(count, label).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const shown = await actions.nth(index).evaluate((element) => {
      element.scrollIntoView({ block: 'nearest' });
      const box = element.getBoundingClientRect(), frame = element.closest('dialog')!.getBoundingClientRect();
      const inside = box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1 && box.top >= 0 && box.bottom <= innerHeight
        && box.left >= 0 && box.right <= innerWidth;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: element.textContent, visible: inside && Boolean(hit && element.contains(hit)) };
    });
    expect(shown, label).toEqual({ text: shown.text, visible: true });
  }
  await actions.first().evaluate((element) => { element.closest('dialog')!.scrollTop = 0; });
}

/**
 * Signed-in screens have exactly one skip link. It is hidden until focused, is the first Tab stop, is then
 * fully visible with a focus ring, and moves focus to #main. Signed-out screens have none.
 */
async function skipLink(page: Page, label: string) {
  const links = page.locator('.skip-link');
  if (!await page.locator('.workspace').count()) { expect(await links.count(), label).toBe(0); return; }
  expect(await links.count(), label).toBe(1);
  const hidden = await links.evaluate((element) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.bottom <= 0;
  });
  expect(hidden, `${label} skip link off-screen until focused`).toBe(true);
  await page.evaluate(() => { document.documentElement.setAttribute('tabindex', '-1'); document.documentElement.focus(); });
  await page.keyboard.press('Tab');
  await page.evaluate(() => { document.documentElement.removeAttribute('tabindex'); });
  await expect(links, label).toBeFocused();
  expect(await links.evaluate((element) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { inView: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
      ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 || style.boxShadow !== 'none' };
  }), label).toEqual({ inView: true, ring: true });
  await page.keyboard.press('Enter');
  await expect(page.locator('#main'), label).toBeFocused();
}

/** The dialog title keeps following the text size: about twice as large with 200% text. */
async function titleScales(page: Page, label: string) {
  const size = () => page.locator('dialog[open] h2').first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const normal = await size();
  const style = await page.addStyleTag({ content: largeText });
  const large = await size();
  await style.evaluate((node) => { (node as HTMLStyleElement).remove(); });
  expect(large / normal, `${label} title ${normal}px -> ${large}px`).toBeGreaterThanOrEqual(1.9);
}

/** Checks one visible state at 320px, then again with 200% text, and restores the page afterwards. */
async function audit(page: Page, language: Language, scope: string) {
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(page.locator(scope).first()).toBeVisible();
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 800 });
  if (scope === 'dialog[open]' && await page.locator('dialog[open] h2').count()) await titleScales(page, language);
  for (const enlarged of [false, true]) {
    const style = enlarged ? await page.addStyleTag({ content: largeText }) : null;
    const label = `${scope} ${language} ${enlarged ? '200%' : '100%'}`;
    expect(await layout(page, scope), label).toEqual({ overflow: false, clipped: [], small: [], split: [] });
    if (scope === 'dialog[open]') await reachable(page, label);
    else await skipLink(page, label);
    expect((await new AxeBuilder({ page }).analyze()).violations, `${scope} ${language} axe`).toEqual([]);
    await style?.evaluate((node) => { (node as HTMLStyleElement).remove(); });
  }
  await page.setViewportSize(size);
}

// Bounded synthetic captures for the coordinator's visual review; this session never opens them.
const directory = path.join('test-results', 'i24-visual');
async function capture(page: Page, info: TestInfo, file: string, target?: Locator) {
  if (info.project.name !== 'chromium') return;
  await mkdir(directory, { recursive: true });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 800 });
  const style = await page.addStyleTag({ content: largeText });
  // A card taller than the viewport is captured whole, after the narrow and enlarged layout has settled.
  if (target) await target.screenshot({ path: path.join(directory, `${file}.png`) });
  else await page.screenshot({ path: path.join(directory, `${file}.png`), fullPage: false });
  await style.evaluate((node) => { (node as HTMLStyleElement).remove(); });
  await page.setViewportSize(size);
}

/**
 * Starting from the scope itself, Tab visits every control in reading (DOM) order, each with a visible
 * focus ring. The first control is reached by keyboard too, so a surface with one control is still checked.
 */
async function focusOrder(page: Page, scope: string) {
  const expected = await page.evaluate((selector) => {
    const root = document.querySelector(selector)!;
    if (document.querySelector('[tabindex]:not([tabindex="-1"]):not([tabindex="0"])')) throw new Error('A positive tabindex changes the order.');
    const seenGroups = new Set<string>();
    const stops = [...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex="0"]')].filter((element) => {
      if (element.matches(':disabled') || element.tabIndex < 0 || element.closest('[inert]')) return false;
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
      if (element instanceof HTMLInputElement && element.type === 'radio') {
        const group = element.name;
        const checked = root.querySelector<HTMLInputElement>(`input[type=radio][name="${group}"]:checked`);
        if (checked ? checked !== element : seenGroups.has(group)) return false;
        seenGroups.add(group);
      }
      return true;
    }).slice(0, 25);
    stops.forEach((element, index) => { element.dataset.focusStop = String(index); });
    // A known keyboard starting point: the scope container, made focusable only for this check.
    const container = root as HTMLElement;
    container.dataset.focusStart = container.getAttribute('tabindex') ?? '';
    container.setAttribute('tabindex', '-1');
    container.focus();
    if (document.activeElement !== container) throw new Error(`Cannot start the Tab sequence at ${selector}`);
    return stops.length;
  }, scope);
  expect(expected).toBeGreaterThan(0);
  const visited: Array<{ stop: string | null; visible: boolean }> = [];
  for (let index = 0; index < expected; index++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const style = element ? getComputedStyle(element) : null;
      return { stop: element?.dataset.focusStop ?? null,
        visible: Boolean(style && (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 || style.boxShadow !== 'none')) };
    }));
  }
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[data-focus-stop]').forEach((element) => { delete element.dataset.focusStop; });
    document.querySelectorAll<HTMLElement>('[data-focus-start]').forEach((element) => {
      if (element.dataset.focusStart) element.setAttribute('tabindex', element.dataset.focusStart); else element.removeAttribute('tabindex');
      delete element.dataset.focusStart;
    });
  });
  expect(visited).toEqual(Array.from({ length: expected }, (_, index) => ({ stop: String(index), visible: true })));
}

async function start(page: Page, language: Language, hash = '#/') {
  const api = await mockBackend(page, { initialLanguage: language });
  const saved = api.seedSavedItem('a', 'Fictional linen shirt');
  api.seedSavedItem('a', 'Fictional wool trousers');
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  await page.goto('/' + hash); await signIn(page);
  await expect(page.locator('.workspace-identity')).toContainText('Alex');
  return { api, saved, errors };
}
const nav = (page: Page, language: Language, key: MessageKey) => page.locator('.workspace-nav, nav').first().getByRole('link', { name: text(language, key), exact: true });

for (const language of languages) {
  test.describe(`I24 ${language}`, () => {
    test('Settings editors, the install hint and the leave dialog', async ({ page }, info) => {
      const { errors } = await start(page, language, '#/settings');
      await expect(page.locator('#settings-title')).toBeVisible();
      const hint = page.locator('section[aria-labelledby="install-heading"]');
      // The mobile project uses an iPhone user agent, so it gets the Safari steps and nothing else.
      await expect(hint.locator('p')).toHaveText([text(language, info.project.name === 'mobile' ? 'install.ios' : 'install.android')]);
      await audit(page, language, '.workspace-main');
      await page.locator('#profile-display_name').fill('Unsaved name');
      await nav(page, language, 'nav.wardrobe').click();
      const dialog = page.locator('dialog[aria-labelledby="discard-title"]');
      await expect(dialog).toContainText(text(language, 'settings.discardBody'));
      await expect(button(dialog, language, 'common.continueEditing')).toBeFocused();
      await audit(page, language, 'dialog[open]');
      await focusOrder(page, 'dialog[open]');
      if (language === 'fi') await capture(page, info, 'leave-dialog-fi-320-200');
      await button(dialog, language, 'common.continueEditing').click();
      await expect(page.locator('#profile-display_name')).toHaveValue('Unsaved name');
      expect(errors).toEqual([]);
    });

    test('backup passphrase and the delete confirmation with its typed phrase and password check', async ({ page }, info) => {
      await start(page, language, '#/settings');
      await page.route('http://127.0.0.1:54321/functions/v1/delete-account', (route) => route.fulfill({ status: 403, json: { code: 'PASSWORD' } }));
      const backup = page.locator('.backup-card');
      await button(backup, language, 'backup.create').click();
      await expect(backup.getByLabel(text(language, 'backup.passphrase'), { exact: true })).toBeFocused();
      await audit(page, language, '.backup-card');
      await focusOrder(page, '.backup-card');
      const card = page.locator('.delete-card');
      await button(card, language, 'delete.title').click();
      await card.getByLabel(text(language, 'delete.password'), { exact: true }).fill(secret);
      await card.getByLabel(text(language, 'delete.confirm'), { exact: true }).check();
      await card.getByLabel(text(language, 'delete.phraseLabel', { phrase: text(language, 'delete.phraseValue') }), { exact: true })
        .fill(text(language, 'delete.phraseValue'));
      await audit(page, language, '.delete-card');
      await focusOrder(page, '.delete-card');
      await button(card, language, 'delete.button').click();
      await expect(card.getByRole('alert')).toHaveText(text(language, 'delete.wrongPassword'));
      await expect(card.getByRole('alert')).toBeFocused();
      await audit(page, language, '.delete-card');
      if (language === 'fi') {
        await expect(card.getByText(text(language, 'delete.phraseValue'), { exact: false }).first()).toBeVisible();
        await capture(page, info, 'delete-card-fi-320-200', card);
      }
    });

    test('item detail editing and its leave dialog', async ({ page }) => {
      const { saved } = await start(page, language);
      await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
      await expect(page.locator('#detail-title')).toBeVisible();
      await audit(page, language, '.workspace-main');
      await page.locator('#detail-title').fill('Unsaved title');
      await nav(page, language, 'nav.outfits').click();
      const dialog = page.locator('dialog[aria-labelledby="discard-title"]');
      await expect(dialog).toContainText(text(language, 'detail.discardPage'));
      await audit(page, language, 'dialog[open]');
      await focusOrder(page, 'dialog[open]');
      await button(dialog, language, 'common.continueEditing').click();
      await expect(page.locator('#detail-title')).toHaveValue('Unsaved title');
    });

    test('the Add item draft and its discard dialog', async ({ page }) => {
      const { api } = await start(page, language);
      await button(page, language, 'wardrobe.add').first().click();
      await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: api.fixture });
      await expect(page.locator('.capture-photo img')).toBeVisible();
      await manualEntry(page);
      await page.locator('#item-title').fill('Unsaved draft title');
      await audit(page, language, '.workspace-main');
      await nav(page, language, 'nav.wardrobe').click();
      const dialog = page.locator('dialog[aria-labelledby="discard-title"]');
      await expect(dialog).toContainText(text(language, 'capture.discardBody'));
      await audit(page, language, 'dialog[open]');
      await focusOrder(page, 'dialog[open]');
      await button(dialog, language, 'common.continueEditing').click();
      await expect(page.locator('#item-title')).toHaveValue('Unsaved draft title');
      expect(api.items).toHaveLength(2);
    });

    test('Trash: the Undo notice and the permanent-delete confirmation', async ({ page }) => {
      const { saved } = await start(page, language);
      await page.locator(`a[href="#/items/${saved.item.id}"]`).click();
      await button(page, language, 'item.trash').click();
      await expect(button(page, language, 'common.undo')).toBeVisible();
      await audit(page, language, '.workspace-main');
      await page.getByRole('button', { name: text(language, 'account.menu') }).click();
      await page.locator('.account-popover').getByRole('link', { name: text(language, 'nav.trash'), exact: true }).click();
      await expect(page.locator('#trash-title')).toBeVisible();
      await audit(page, language, '.workspace-main');
      await button(page, language, 'deletion.prepare').click();
      await expect(page.getByRole('dialog')).toContainText('Fictional linen shirt');
      await audit(page, language, 'dialog[open]');
      await focusOrder(page, 'dialog[open]');
    });

    test('the outfit editor, keyboard reordering and its leave dialog', async ({ page }, info) => {
      await start(page, language, '#/outfits/new');
      await expect(page.locator('#outfit-editor-title')).toBeVisible();
      for (const name of ['Fictional linen shirt', 'Fictional wool trousers'])
        await page.getByRole('button', { name: text(language, 'a11y.selectItem', { name }) }).click();
      const down = page.getByRole('button', { name: text(language, 'a11y.moveDown', { name: 'Fictional linen shirt' }), exact: true });
      await down.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: text(language, 'a11y.moveUp', { name: 'Fictional linen shirt' }), exact: true })).toBeFocused();
      await expect(page.locator('.outfit-slot').first()).toContainText('Fictional wool trousers');
      await audit(page, language, '.workspace-main');
      await nav(page, language, 'nav.wardrobe').click();
      const dialog = page.locator('dialog[aria-labelledby="outfit-leave-title"]');
      await expect(dialog).toContainText(text(language, 'outfits.discardBody'));
      await audit(page, language, 'dialog[open]');
      await focusOrder(page, 'dialog[open]');
      if (language === 'sv') await capture(page, info, 'outfit-leave-sv-320-200');
    });

    test('the AI consent card with its privacy notice', async ({ page }) => {
      await aiFixture(page, language, false);
      await page.evaluate(() => { location.hash = '#/settings'; });
      const consent = page.locator('section[aria-labelledby="ai-consent-title"]');
      await consent.locator('summary').click();
      await expect(consent.getByText(text(language, 'aiC.azureNotice'), { exact: true })).toBeVisible();
      await audit(page, language, 'section[aria-labelledby="ai-consent-title"]');
      await focusOrder(page, 'section[aria-labelledby="ai-consent-title"]');
    });

    test('signing out returns focus to the sign-in heading, which passes the same checks', async ({ page }) => {
      await start(page, language);
      await page.getByRole('button', { name: text(language, 'account.menu') }).click();
      await page.locator('.account-popover').getByRole('button', { name: text(language, 'auth.signOut'), exact: true }).click();
      await expect(page.locator('#login-title')).toBeFocused();
      await page.getByRole('button', { name: text(language, `language.${language}`), exact: true }).click();
      await audit(page, language, 'body');
      await focusOrder(page, '.entry-card');
    });

    test('the password recovery screen and its warning', async ({ page }) => {
      await mockBackend(page, { initialLanguage: language });
      await page.goto('/' + recoveryHash());
      await page.getByRole('button', { name: text(language, `language.${language}`), exact: true }).click();
      await expect(page.locator('.recovery-confirm')).toBeVisible();
      await audit(page, language, 'body');
      await page.getByRole('checkbox').check();
      await button(page, language, 'recovery.continue').click();
      await expect(page.locator('#recovery-password')).toBeVisible();
      await audit(page, language, 'body');
      await focusOrder(page, '.entry-card');
    });

    for (const state of ['retry', 'in_progress', 'contact'] as const) {
      test(`the deletion recovery screen when deletion is ${state}`, async ({ page }, info) => {
        await mockBackend(page, { initialLanguage: language });
        await page.route(/\/rest\/v1\/profiles(\?|$)/, (route) => route.fulfill({ status: 403, json: { code: '42501', message: 'permission denied' } }));
        await page.route('http://127.0.0.1:54321/rest/v1/rpc/deletion_status', (route) => route.fulfill({ status: 200, json: { state } }));
        await page.route('http://127.0.0.1:54321/functions/v1/delete-account', (route) => route.fulfill({ status: 202, json: { state: 'in_progress' } }));
        await page.goto('/'); await signIn(page);
        await expect(page.locator('#deletion-recovery-title')).toBeFocused();
        await page.locator(`.language-selector button[lang="${language}"]`).click();
        const scope = 'section[aria-labelledby="deletion-recovery-title"]';
        await audit(page, language, scope);
        await focusOrder(page, scope);
        if (state !== 'contact') {
          // Interrupted and resumed: another attempt reports that deletion is still running.
          await page.locator(scope).getByLabel(text(language, 'delete.password'), { exact: true }).fill(secret);
          await page.locator(scope).getByRole('button', { name: text(language, 'delete.finish'), exact: true }).click();
          await expect(page.locator(scope).locator('.notice[role=status]')).toHaveText(text(language, 'delete.inProgress'));
          await expect(page.locator(scope).getByLabel(text(language, 'delete.password'), { exact: true })).toHaveValue('');
          await audit(page, language, scope);
          if (language === 'sv' && state === 'in_progress') await capture(page, info, 'deletion-resume-sv-320-200');
        }
      });
    }
  });
}

// The focus check must not pass vacuously: a sole control is reached by Tab and its ring is checked.
test.describe('the split-word check itself', () => {
  // A word wider than the whole dialog may break, but only inside a title or button that fills its row.
  const dialog = (button: string) => '<!doctype html><html lang="en"><style>body { margin: 0; } '
    + '.dialog { width: 240px; padding: 16px; overflow-wrap: break-word; } '
    + '.dialog-actions { display: flex; gap: 10px; } .dialog-actions button { min-height: 44px; font-size: 24px; white-space: normal; } '
    + `${button}</style><dialog class="dialog" open><h2>Title</h2><div class="dialog-actions">`
    + '<button type="button">Nope</button><button type="button">Supercalifragilisticexpialidocious</button></div></dialog></html>';
  const splitWords = async (page: Page) => (await layout(page, 'dialog[open]')).split;
  test('fails an oversized word breaking inside a squeezed button', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.setContent(dialog('.dialog-actions button { flex: 1 1 0; min-width: 0; }'));
    expect(await splitWords(page)).toContain('button "Supercalifragilisticexpialidocious"');
  });
  test('passes an unavoidable break in a full-width stacked button', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.setContent(dialog('.dialog-actions { flex-direction: column; } .dialog-actions button { width: 100%; }'));
    const words = await page.locator('dialog button').last().evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(words, 'the long word really wraps').toBeGreaterThan(1);
    expect(await splitWords(page)).toEqual([]);
  });
});

test.describe('the focus-order check itself', () => {
  const surface = (ring: string) => `<!doctype html><html lang="en"><style>button { outline: none; } ${ring}</style>`
    + '<main><section id="only"><h2>Only control</h2><button type="button">Sign out</button></section></main></html>';
  test('passes a sole control that shows a focus ring', async ({ page }) => {
    await page.setContent(surface('button:focus-visible { outline: 3px solid #1B4D3E; }'));
    await focusOrder(page, '#only');
  });
  test('fails a sole control without a focus indicator', async ({ page }) => {
    await page.setContent(surface(''));
    await expect(focusOrder(page, '#only')).rejects.toThrow(/visible/);
  });
});

// Safety and privacy warnings must really be translated, not English copied into another language.
test('recovery, deletion, backup and AI privacy warnings are translated in Finnish and Swedish', () => {
  const keys: MessageKey[] = ['recovery.confirm', 'recovery.passwordHint', 'recovery.revocationHelp', 'recovery.memoryOnly', 'delete.confirm',
    'delete.inProgress', 'delete.contact', 'deletion.warning', 'backup.personalWarning', 'backup.passphraseWarning', 'aiC.notice', 'aiC.azureNotice',
    'aiC.azureTrainingNotice', 'aiC.warning', 'profile.privacy', 'weather.consent', 'install.ios', 'install.android', 'update.available'];
  for (const key of keys) for (const language of ['fi', 'sv'] as const) {
    expect(messages[key][language].trim(), `${key} ${language}`).not.toBe('');
    expect(messages[key][language], `${key} ${language}`).not.toBe(messages[key].en);
  }
});
