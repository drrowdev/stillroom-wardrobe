import { expect, type Locator, type Page } from '@playwright/test';
import { translate, type Language } from '../../src/i18n/all';

// UX1 shell: at 650 px and narrower the account menu is the More tab; wider, it is the account button in the header.
export const NARROW_MAX_WIDTH = 650;
export const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1280) <= NARROW_MAX_WIDTH;

/** The destination nav on screen: the tab bar on a phone, the header's top nav on desktop. */
export const shellNav = (page: Page): Locator => page.locator(isNarrow(page) ? 'nav.tab-bar' : 'nav.top-nav');

export const accountTrigger = (page: Page): Locator => page.locator('#account-trigger');
export const accountMenu = (page: Page): Locator => page.locator('#account-menu');

/**
 * On a phone the tab bar hides while a text field has focus (the on-screen keyboard is up). A user dismisses the
 * keyboard first; blur the field the same way instead of forcing a click on a hidden control.
 */
export async function dismissKeyboard(page: Page) {
  if (!isNarrow(page) || await accountTrigger(page).isVisible()) return;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(accountTrigger(page)).toBeVisible();
}

/**
 * The tab bar re-measures one frame after its size changes (tab-fit.ts), so after a text-size change wait two frames
 * before measuring it.
 */
export async function settleShell(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Opens the account menu (desktop) or More (phone); with a language, also checks the trigger's translated name. */
export async function openAccountMenu(page: Page, language?: Language): Promise<Locator> {
  const trigger = accountTrigger(page);
  await dismissKeyboard(page);
  if (language) await expect(trigger).toHaveAccessibleName(translate(language, isNarrow(page) ? 'nav.more' : 'account.menu'));
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(accountMenu(page)).toBeVisible();
  return accountMenu(page);
}

/**
 * Closes the account menu or More if it is still open. A tap elsewhere, or a route moving focus, may close it at the
 * same moment as the click, which would then reopen it, so check again until it stays closed.
 */
export async function closeAccountMenu(page: Page) {
  const trigger = accountTrigger(page);
  await expect(async () => {
    if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false', { timeout: 500 });
    await expect(accountMenu(page)).toHaveCount(0, { timeout: 100 });
  }).toPass({ timeout: 10_000 });
}

export async function signOutThroughMenu(page: Page, language: Language = 'en') {
  const menu = await openAccountMenu(page, language);
  await menu.getByRole('button', { name: translate(language, 'auth.signOut'), exact: true }).click();
}

/**
 * The signed-in owner's name as the shell shows it: the account button on desktop, or the top of the More panel on a
 * phone. On a phone the panel is opened and closed again, and focus goes back to where it was.
 */
export async function expectIdentity(page: Page, name: string) {
  if (!isNarrow(page)) {
    await expect(page.locator('.account-name')).toBeVisible();
    await expect(page.locator('.account-name')).toHaveText(name);
    return;
  }
  // Right after sign-in the route may still move focus to its committed target, which correctly closes More (focus
  // left the menu). Reopen until the menu stays open, so the identity is read from a settled page.
  let previous = await page.evaluateHandle(() => document.activeElement);
  await expect(async () => {
    if (await accountTrigger(page).getAttribute('aria-expanded') !== 'true') {
      await previous.dispose();
      previous = await page.evaluateHandle(() => document.activeElement);
      await dismissKeyboard(page);
      await accountTrigger(page).click();
    }
    await expect(accountMenu(page)).toBeVisible({ timeout: 500 });
    await page.waitForTimeout(250);
    await expect(accountTrigger(page)).toHaveAttribute('aria-expanded', 'true', { timeout: 100 });
  }).toPass({ timeout: 10_000 });
  await expect(accountMenu(page).locator('.menu-identity')).toBeVisible();
  await expect(accountMenu(page).locator('.menu-identity')).toHaveText(name);
  await closeAccountMenu(page);
  await previous.evaluate((element) => {
    if (element instanceof HTMLElement && element.isConnected && element !== document.body) element.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await previous.dispose();
}

/** The signed-in workspace has rendered: its account trigger is on screen. */
export async function expectSignedIn(page: Page) {
  await expect(accountTrigger(page)).toBeVisible();
}

/** No signed-in shell: no account trigger, name or menu anywhere. */
export async function expectNoIdentity(page: Page) {
  await expect(accountTrigger(page)).toHaveCount(0);
  await expect(page.locator('.account-name, .menu-identity')).toHaveCount(0);
}

type MenuRoute = 'nav.statistics' | 'nav.settings' | 'nav.trash';
/** Follows a link that is in the menu (Settings, Trash; Statistics on a phone) or in the desktop top nav (Statistics). */
export async function goTo(page: Page, key: MenuRoute, language: Language = 'en') {
  const name = translate(language, key);
  if (key === 'nav.statistics' && !isNarrow(page)) {
    await page.locator('.top-nav').getByRole('link', { name, exact: true }).click();
    return;
  }
  const menu = await openAccountMenu(page, language);
  await menu.getByRole('link', { name, exact: true }).click();
}
