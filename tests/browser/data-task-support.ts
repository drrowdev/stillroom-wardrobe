import { expect, type Page } from '@playwright/test';
import { translate, type Language } from '../../src/i18n/all';
import { goTo, openAccountMenu, shellNav } from './shell-support';

export type DataTask = 'backup' | 'restore' | 'delete';
export const dataRow = (page: Page, task: DataTask) => page.locator(`#data-row-${task}`);
export const taskHeading = (page: Page, task: DataTask) => page.locator(`#${task}-heading`);
// The Back button at the top of Settings; inside a task view it returns to the sections.
export const settingsBack = (page: Page) => page.locator('.settings-page > button.text-button');

/** Opens a Data and privacy row from Settings; the tool's heading takes focus. */
export async function openDataTask(page: Page, task: DataTask) {
  await dataRow(page, task).click();
  await expect(taskHeading(page, task)).toBeFocused();
}
/** Shows a tool's view, leaving another open view first. */
export async function showDataTask(page: Page, task: DataTask) {
  if (await taskHeading(page, task).isVisible()) return;
  if (await page.locator('.settings-task section').count()) await settingsBack(page).click();
  await openDataTask(page, task);
}
/** Leaves a task view by its Back button; focus returns to the row that opened it. */
export async function closeDataTask(page: Page, opened: DataTask) {
  await settingsBack(page).click();
  await expect(dataRow(page, opened)).toBeFocused();
}
/** Opens Settings from Wardrobe through the menu, so that browser Back has an in-app page to return to. */
export async function settingsFromWardrobe(page: Page, language: Language = 'en') {
  await shellNav(page).getByRole('link', { name: translate(language, 'nav.wardrobe'), exact: true }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await goTo(page, 'nav.settings', language);
  await expect(page.locator('#settings-title')).toBeVisible();
}

/** The ways out of Settings that must wait while a tool's request is held, each with the page it then leads to. */
export const heldExits = ['nav', 'menu', 'anchor', 'address', 'back'] as const;
export type HeldExit = typeof heldExits[number];
const destinations: Record<HeldExit, { title: string; hash?: string; added: number }> = {
  nav: { title: '#outfits-title', hash: '#/outfits', added: 1 },
  menu: { title: '#trash-title', hash: '#/trash', added: 1 },
  anchor: { title: '#wardrobe-title', hash: '#/wardrobe', added: 1 },
  address: { title: '#today-title', hash: '#/today', added: 1 },
  back: { title: '#wardrobe-title', added: 0 },
};

/**
 * While a tool's request is held, tries one way out of Settings: the shell navigation (Outfits), a menu link (Trash),
 * an in-page anchor (the brand link to Wardrobe), a typed address (#/today) or browser Back. The task Back and the rows
 * are disabled, and the tool stays visible on Settings. Returns a check to run after the request is released: the
 * chosen destination is then shown, Back as a traversal with no new history entry. Settings must have been opened from
 * Wardrobe (settingsFromWardrobe).
 */
export async function tryExitWhileHeld(page: Page, task: DataTask, exit: HeldExit, language: Language = 'en') {
  const heading = taskHeading(page, task);
  const length = await page.evaluate(() => history.length);
  await expect(settingsBack(page)).toBeDisabled();
  for (const row of ['backup', 'restore', 'delete'] as const) await expect(dataRow(page, row)).toBeDisabled();
  if (exit === 'nav') await shellNav(page).getByRole('link', { name: translate(language, 'nav.outfits'), exact: true }).click();
  else if (exit === 'menu') {
    const menu = await openAccountMenu(page, language);
    await menu.getByRole('link', { name: translate(language, 'nav.trash'), exact: true }).click();
    await page.keyboard.press('Escape');
  } else if (exit === 'anchor') await page.locator('a.brand').click();
  else if (exit === 'address') await page.evaluate(() => { location.hash = '#/today'; });
  else await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings');
  await expect(heading).toBeVisible();
  await expect(page.locator('#outfits-title, #trash-title, #wardrobe-title, #today-title')).toHaveCount(0);
  return async () => {
    const target = destinations[exit];
    await expect(page.locator(target.title)).toBeVisible();
    if (target.hash) expect(new URL(page.url()).hash).toBe(target.hash);
    else expect(new URL(page.url()).hash).not.toBe('#/settings');
    expect(await page.evaluate(() => history.length)).toBe(length + target.added);
    await expect(page.locator('.settings-task')).toHaveCount(0);
  };
}
