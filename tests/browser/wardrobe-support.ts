import { expect, type Page } from '@playwright/test';

// UX6: the wardrobe filters are in a sheet opened from the toolbar. Opening waits for the sheet's heading to take
// focus and its options to load; closing waits for focus to return to the Filters button.
export const filterSheet = (page: Page) => page.locator('dialog.filter-sheet');
export const filtersButton = (page: Page) => page.locator('.wardrobe-filter-button');
export async function openFilters(page: Page, how: 'click' | 'keyboard' = 'click') {
  if (how === 'keyboard') { await filtersButton(page).focus(); await page.keyboard.press('Enter'); }
  else await filtersButton(page).click();
  await expect(page.locator('#filter-sheet-title')).toBeFocused();
  await expect(filterSheet(page).locator('.wardrobe-facet-grid')).toBeVisible();
}
export async function closeFilters(page: Page) {
  await filterSheet(page).locator('.filter-sheet-header button').click();
  await expect(filterSheet(page)).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
}
