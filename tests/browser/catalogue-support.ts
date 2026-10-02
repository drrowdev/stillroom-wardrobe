import type { Page } from '@playwright/test';
import type { Language } from '../../src/i18n/all';

// LANG1: the page's language catalogue requests (/assets/catalogue-<lang>-<hash>.json), recorded and, on request,
// held until released or failed. Only the page's own requests pass through page.route; the data is never mocked.
type Outcome = 'load' | 'fail';
export async function controlCatalogues(page: Page) {
  const urls: string[] = [];
  const gates = new Map<Language, Promise<Outcome>>();
  const failures = new Map<Language, number>();
  await page.route(/\/assets\/catalogue-(?:en|fi|sv)-[\w-]{8}\.json(?:\?.*)?$/, async (route) => {
    const url = route.request().url();
    const language = /\/catalogue-(en|fi|sv)-/.exec(url)![1] as Language;
    urls.push(url);
    const failing = failures.get(language) ?? 0;
    if (failing > 0) { failures.set(language, failing - 1); await route.abort('failed').catch(() => {}); return; }
    const gate = gates.get(language);
    if (gate && await gate === 'fail') { await route.abort('failed').catch(() => {}); return; }
    await route.fallback().catch(() => {});
  });
  const languageOf = (url: string) => /\/catalogue-(en|fi|sv)-/.exec(url)![1] as Language;
  return {
    urls,
    requested: () => urls.map(languageOf),
    count: (language: Language) => urls.filter((url) => languageOf(url) === language).length,
    /** Holds every request for `language` until `release` settles them all with one outcome. */
    hold(language: Language) {
      let settle!: (outcome: Outcome) => void;
      gates.set(language, new Promise<Outcome>((resolve) => { settle = resolve; }));
      return (outcome: Outcome = 'load') => { gates.delete(language); settle(outcome); };
    },
    /** Fails the next `times` requests for `language`; later ones load. */
    failNext(language: Language, times = 1) { failures.set(language, times); },
  };
}
