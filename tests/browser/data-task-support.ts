import { expect, type Page } from '@playwright/test';
import { translate, type Language } from '../../src/i18n';
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

/**
 * While a tool's request is held, every way out of Settings waits: the task Back and the rows are disabled, and a
 * shell link, a menu link and browser Back leave the tool running and visible. Once released, the latest choice
 * (browser Back, to Wardrobe) is followed as a traversal, with no new history entry. Settings must have been opened
 * from Wardrobe (settingsFromWardrobe).
 */
export async function expectExitsHeld(page: Page, task: DataTask, release: () => Promise<void>, language: Language = 'en') {
  const heading = taskHeading(page, task);
  const length = await page.evaluate(() => history.length);
  await expect(settingsBack(page)).toBeDisabled();
  for (const row of ['backup', 'restore', 'delete'] as const) await expect(dataRow(page, row)).toBeDisabled();
  await shellNav(page).getByRole('link', { name: translate(language, 'nav.outfits'), exact: true }).click();
  await expect(heading).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings');
  const menu = await openAccountMenu(page, language);
  await menu.getByRole('link', { name: translate(language, 'nav.trash'), exact: true }).click();
  await expect(heading).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings');
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings');
  await expect(heading).toBeVisible();
  await expect(page.locator('#outfits-title, #trash-title, #wardrobe-title')).toHaveCount(0);
  await release();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
}
