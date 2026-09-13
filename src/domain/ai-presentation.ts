import type { AiFacts } from './ai-analysis';
import { translate, locales, type Language, type MessageKey } from '../i18n';
import { isMicro } from './ai-controls';
import { AppError } from '../data/errors';

const categories: Record<string, MessageKey> = {
  top: 'category.top', bottom: 'category.bottom', one_piece: 'category.one_piece', footwear: 'category.footwear',
  layer: 'category.layer', outerwear: 'category.outerwear', accessory: 'category.accessory',
};
const colours: Record<string, MessageKey> = {
  black: 'colour.black', white: 'colour.white', grey: 'colour.grey', navy: 'colour.navy', blue: 'colour.blue',
  green: 'colour.green', olive: 'colour.olive', beige: 'colour.beige', brown: 'colour.brown', red: 'colour.red',
  yellow: 'colour.yellow', orange: 'colour.orange', pink: 'colour.pink', purple: 'colour.purple',
};
export function presentAiFacts(facts: AiFacts, language: Language): { title: string; description: string; tags: string[] } {
  if (facts.outcome !== 'ready') return { title: '', description: '', tags: [] };
  const labels = [facts.fields.category ? categories[facts.fields.category] : undefined,
    ...(facts.fields.colours ?? []).map((colour) => colours[colour])]
    .filter((key): key is MessageKey => key !== undefined).map((key) => translate(language, key));
  const title = labels.join(' · ');
  return { title: [...title].slice(0, 100).join(''),
    description: title ? [...translate(language, 'aiC.description', { details: title })].slice(0, 240).join('') : '',
    tags: [...new Set(labels)].filter((label) => [...label].length <= 40) };
}
// Never convert money to a floating-point number or the garment's currency.
export function microUsd(value: string, language: Language): string {
  if (!isMicro(value)) throw new AppError('aiC.unavailable');
  const amount = BigInt(value), whole = amount / 1000000n, fraction = String(amount % 1000000n).padStart(6, '0');
  const decimal = new Intl.NumberFormat(locales[language]).formatToParts(1.1).find((part) => part.type === 'decimal')?.value;
  if (!decimal) throw new AppError('aiC.unavailable');
  return `${new Intl.NumberFormat(locales[language]).format(whole)}${decimal}${fraction} USD`;
}
