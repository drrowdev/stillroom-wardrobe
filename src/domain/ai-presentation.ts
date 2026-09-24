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
// Never convert money to the garment's currency. Use rounds up to the next cent and the allowance rounds down.
export function usdCents(value: string, language: Language, mode: 'used' | 'limit'): string {
  if (!isMicro(value)) throw new AppError('aiC.unavailable');
  const amount = BigInt(value), cents = mode === 'used' ? (amount + 9999n) / 10000n : amount / 10000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('aiC.unavailable');
  const whole = mode === 'limit' && cents % 100n === 0n;
  return new Intl.NumberFormat(locales[language], { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` as `${number}`);
}
