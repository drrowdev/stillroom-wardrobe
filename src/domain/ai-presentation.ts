import type { AiFacts } from './ai-analysis';
import { locales, type Language } from '../i18n';
import { defaultDescription, defaultItemName } from './item-details';
import { isMicro } from './ai-controls';
import { AppError } from '../data/errors';

// A short suggested name ("Black top") and local tag suggestions from style words; tags are never a saved claim.
export function presentAiFacts(facts: AiFacts, language: Language): { title: string; description: string; tags: string[] } {
  if (facts.outcome !== 'ready') return { title: '', description: '', tags: [] };
  const title = [...defaultItemName(facts.fields.category, facts.fields.colours ?? [], language)].slice(0, 100).join('');
  const seen = new Set<string>();
  const tags = (facts.fields.style_tags ?? []).map((tag) => tag.trim()).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || [...tag].length > 40 || seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { title, description: defaultDescription(title, facts.fields.colours ?? [], language), tags };
}
// Never convert money to a floating-point number or the garment's currency.
export function microUsd(value: string, language: Language): string {
  if (!isMicro(value)) throw new AppError('aiC.unavailable');
  const amount = BigInt(value), whole = amount / 1000000n, fraction = String(amount % 1000000n).padStart(6, '0');
  const decimal = new Intl.NumberFormat(locales[language]).formatToParts(1.1).find((part) => part.type === 'decimal')?.value;
  if (!decimal) throw new AppError('aiC.unavailable');
  return `${new Intl.NumberFormat(locales[language]).format(whole)}${decimal}${fraction} USD`;
}
