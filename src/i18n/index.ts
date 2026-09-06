import baseMessages from './messages.json' with { type: 'json' };
import phaseZeroMessages from './phase-zero.json' with { type: 'json' };

export const messages = { ...baseMessages, ...phaseZeroMessages };
export type MessageKey = keyof typeof messages;
export type Language = 'en' | 'fi' | 'sv';
export const languages: readonly Language[] = ['en', 'fi', 'sv'];
export const locales: Record<Language, string> = { en: 'en-GB', fi: 'fi-FI', sv: 'sv-FI' };
export type Parameters = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, parameters?: Parameters) => string;

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

export function translate(language: Language, key: MessageKey, parameters: Parameters = {}): string {
  const entry = Object.hasOwn(messages, key) ? messages[key] : undefined;
  const template = entry?.[language] || entry?.en;
  if (!template) {
    if (import.meta.env.DEV) throw new Error('Missing translation.');
    return messages['error.unavailable'][language];
  }
  const required = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!);
  if (required.some((name) => !Object.hasOwn(parameters, name))) {
    if (import.meta.env.DEV) throw new Error('Missing translation parameter.');
    return messages['error.unavailable'][language];
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
