import { colours } from '../../domain/preferences';
import { patterns } from '../../domain/attribute-provenance';
import { categories } from '../../domain/wardrobe';
import { seasons, type GarmentValues } from '../../domain/garment-fields';
import { occasionOptions } from '../../domain/item-details';
import { formatDateOnly, formatMoney } from '../../i18n/format';
import type { Language, MessageKey, Translate } from '../../i18n';

export type ItemFact = { field: string; label: string; value: string };

const warmthKeys: Record<string, MessageKey> = { 0: 'warmth.light', 1: 'warmth.light', 2: 'warmth.medium', 3: 'warmth.warm', 4: 'warmth.warm' };
const includes = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/**
 * The saved item's facts for the view card: Category, Colours and Seasons always ("Not set" when empty), every other
 * field only when it has a value. A legacy or unknown stored value is shown as it is, as the edit form does.
 */
export function itemFacts(values: GarmentValues, language: Language, t: Translate): ItemFact[] {
  const notSet = t('item.notSet');
  const list = (items: string[]) => items.join(', ');
  const category = includes(categories, values.category) ? t(`categoryOne.${values.category}`) : values.category;
  const colour = (code: string) => code === 'unknown' || includes(colours, code) ? t(`colour.${code}` as MessageKey) : code;
  const season = (code: string) => includes(seasons, code) ? t(`season.${code}`) : code;
  const facts: ItemFact[] = [
    { field: 'category', label: t('item.category'), value: category || notSet },
    { field: 'colours', label: t('item.colours'), value: values.colours.length ? list(values.colours.map(colour)) : notSet },
    { field: 'seasons', label: t('item.seasons'), value: values.seasons.length ? list(values.seasons.map(season)) : notSet },
  ];
  const add = (field: string, label: MessageKey, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value.trim() !== '') facts.push({ field, label: t(label), value });
  };
  add('subcategory', 'item.type', values.subcategory);
  add('pattern', 'item.pattern', values.pattern === null ? null : includes(patterns, values.pattern) ? t(`pattern.${values.pattern}`) : values.pattern);
  add('brand', 'item.brand', values.brand);
  add('size_label', 'item.size', values.size_label);
  add('material', 'item.material', values.material);
  if (values.formality !== null) {
    const occasion = occasionOptions.find(([value]) => value === String(values.formality));
    add('formality', 'item.occasion', occasion ? t(occasion[1]) : String(values.formality));
  }
  if (values.warmth !== null) {
    const key = warmthKeys[String(values.warmth)];
    add('warmth', 'item.warmth', key ? t(key) : String(values.warmth));
  }
  if (values.purchase_price !== null) {
    let price = `${values.purchase_price} ${values.currency}`;
    try { price = formatMoney(values.purchase_price, values.currency, language); } catch { /* shown as stored */ }
    add('purchase_price', 'item.price', price);
  }
  if (values.purchase_date !== null) {
    let date = values.purchase_date;
    try { date = formatDateOnly(values.purchase_date, language); } catch { /* shown as stored */ }
    add('purchase_date', 'item.purchaseDate', date);
  }
  add('tags', 'item.tags', list([...values.tags, ...values.style_tags]));
  add('notes', 'item.notes', values.notes);
  const status = [values.favourite ? t('item.favourite') : '', values.lifecycle !== 'active' ? t(`lifecycle.${values.lifecycle}`) : '']
    .filter(Boolean);
  add('status', 'item.status', list(status));
  return facts;
}
