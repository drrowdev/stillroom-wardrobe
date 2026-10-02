import type { Language } from './index';

// Eager: the only text the app can show before a catalogue has loaded (the boot-failure and fatal screens).
// tests/unit/i18n-catalogues.test.ts checks every value against the source catalogues.
export type BootKey = 'common.errorTitle' | 'error.unavailable' | 'common.retry';
// Typed as plain strings: these are catalogue text, checked against the source by the unit test.
export const bootMessages: Record<BootKey, Record<Language, string>> = {
  'common.errorTitle': { en: 'Could not load', fi: 'Lataaminen ei onnistunut', sv: 'Kunde inte läsa in' },
  'error.unavailable': { en: 'This is not available. Try again.', fi: 'Tämä ei ole saatavilla. Yritä uudelleen.', sv: 'Det här är inte tillgängligt. Försök igen.' },
  'common.retry': { en: 'Try again', fi: 'Yritä uudelleen', sv: 'Försök igen' },
};