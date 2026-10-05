import type baseMessages from './messages.json';
import type phaseZeroMessages from './phase-zero.json';
import type tryOnMessages from './tryon.json';
import { bootMessages } from './boot';

// LANG1: this module holds no catalogue text. The app fetches the active language's startup table (./load) before
// it renders; tests and tools install all three through ./all. Lazy screens register their own catalogues.
type Startup = typeof baseMessages & typeof phaseZeroMessages;
/** Catalogs loaded with a lazy screen rather than at startup; `registerMessages` adds them when their chunk loads. */
type LazyCatalogs = typeof tryOnMessages;
export type MessageKey = keyof (Startup & LazyCatalogs);
export type Language = 'en' | 'fi' | 'sv';
export const languages: readonly Language[] = ['en', 'fi', 'sv'];
export const locales: Record<Language, string> = { en: 'en-GB', fi: 'fi-FI', sv: 'sv-FI' };
export type Parameters = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, parameters?: Parameters) => string;
export type CatalogueTable = Readonly<Record<string, string>>;

const tables: Partial<Record<Language, CatalogueTable>> = {};
const extras = new Map<string, Readonly<Record<Language, string>>>();

/** Installs one language's startup table. Catalogues are public build data, so they stay across sign-out and UID changes. */
export function installCatalogue(language: Language, table: CatalogueTable): void {
  tables[language] = table;
}
export function catalogueLoaded(language: Language): boolean {
  return tables[language] !== undefined;
}
export function registerMessages(catalog: Partial<LazyCatalogs>): void {
  for (const [key, entry] of Object.entries(catalog)) if (entry) extras.set(key, entry);
}

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'fi' || value === 'sv';
}

export function resolveLanguage(
  browserLanguages: readonly string[],
  saved: Language | null = null,
  signInChoice: Language | null = null,
): Language {
  if (saved) return saved;
  if (signInChoice) return signInChoice;
  for (const tag of browserLanguages) {
    const language = tag.toLowerCase().split('-')[0];
    if (isLanguage(language)) return language;
  }
  return 'en';
}

function lookup(language: Language, key: string): string | undefined {
  const table = tables[language];
  return (table && Object.hasOwn(table, key) ? table[key] : undefined) || extras.get(key)?.[language] || undefined;
}
function unavailable(language: Language): string {
  return tables[language]?.['error.unavailable'] ?? bootMessages['error.unavailable'][language];
}

export function translate(language: Language, key: MessageKey, parameters: Parameters = {}): string {
  // A language whose table is not installed has no fallback: rendering it would show another language.
  const template = catalogueLoaded(language) ? lookup(language, key) ?? (language === 'en' ? undefined : lookup('en', key)) : undefined;
  if (!template) {
    if (import.meta.env.DEV) throw new Error(catalogueLoaded(language) ? 'Missing translation.' : `The ${language} catalogue is not loaded.`);
    return unavailable(language);
  }
  const required = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!);
  if (required.some((name) => !Object.hasOwn(parameters, name))) {
    if (import.meta.env.DEV) throw new Error('Missing translation parameter.');
    return unavailable(language);
  }
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name: string) => String(parameters[name]));
}

export function itemCount(language: Language, count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid count.');
  const plural = new Intl.PluralRules(locales[language]).select(count);
  return translate(language, plural === 'one' ? 'wardrobe.count_one' : 'wardrobe.count_other', {
    count: new Intl.NumberFormat(locales[language]).format(count),
  });
}

type PluralKey = { [K in MessageKey]: K extends `${infer Base}_one` ? (`${Base}_other` extends MessageKey ? Base : never) : never }[MessageKey];
/** Picks `<base>_one` or `<base>_other` with the language's plural rules and formats `{count}`. */
export function pluralText(language: Language, base: PluralKey, count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid count.');
  const plural = new Intl.PluralRules(locales[language]).select(count);
  return translate(language, `${base}_${plural === 'one' ? 'one' : 'other'}` as MessageKey, {
    count: new Intl.NumberFormat(locales[language]).format(count),
  });
}