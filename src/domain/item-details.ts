import { maximumFieldRevision, parseFieldProvenance, sameFieldProvenance, type FieldProvenance } from './attribute-provenance';
import { isCategory, isRecord, isUuid, type Category } from './wardrobe';
import { AppError } from '../data/errors';
import { locales, translate, type Language, type MessageKey } from '../i18n';
import { styleTagLimit } from './preferences';
import {
  buildGarmentWrite, collectionLimits, editGarmentField, freezeValues, newGarmentDraft, parseGarmentValues, sameValue,
  type GarmentDraft, type GarmentPatch, type GarmentValues,
} from './garment-fields';

export const itemFactColumns = [
  'subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length', 'brand', 'size_label',
  'material', 'seasons', 'formality', 'warmth', 'min_temp', 'max_temp', 'rain_rating', 'windproof',
  'upper_coverage', 'lower_coverage', 'style_tags', 'tags', 'purchase_date', 'purchase_price',
  'currency', 'notes', 'favourite', 'availability', 'lifecycle', 'wear_more', 'exclude_suggestions',
  'created_at',
] as const;
export const itemDetailColumns = `id,owner_id,title,category,version,field_provenance,deleted_at,updated_at,${itemFactColumns.join(',')}`;
export const imageDetailColumns = 'id,owner_id,item_id,alt_text,description_version,state,retired_at,main_path,thumb_path';
export type ItemFields = { title: string; category: Category };
export type ItemBaseline = ItemFields & {
  id: string; ownerId: string; version: number; provenance: FieldProvenance;
  facts: Record<string, unknown>;
  values: GarmentValues;
};
export type ImageBaseline = {
  id: string; ownerId: string; itemId: string; altText: string; version: number;
  mainPath: string; thumbPath: string;
};
export type ItemDetail = { item: ItemBaseline; image: ImageBaseline };
export type ItemAttempt = {
  epoch: number; baseline: ItemBaseline; fields: GarmentValues;
  patch: GarmentPatch;
};
export type DescriptionAttempt = { epoch: number; baseline: ImageBaseline; text: string };

export function detailRouteId(hash: string): string | null {
  const id = hash.startsWith('#/items/') ? hash.slice(8) : '';
  return isUuid(id) && id === id.toLowerCase() ? id : null;
}
export function validItemFields(title: string, category: string): ItemFields | null {
  const text = title.trim();
  return text.length > 0 && [...text].length <= 100 && !text.includes('\0') && isCategory(category)
    ? { title: text, category } : null;
}
export function validDescription(text: string): string | null {
  const value = text.trim();
  return [...value].length <= 240 && !value.includes('\0') ? value : null;
}
const colourCodes = [
  'black', 'white', 'grey', 'navy', 'blue', 'green', 'olive', 'beige', 'brown', 'red', 'yellow', 'orange', 'pink', 'purple',
] as const;
type ColourCode = typeof colourCodes[number];
const isColourCode = (value: string): value is ColourCode => colourCodes.some((code) => code === value);
// Which colour form each name template needs (Swedish neuter nouns, Finnish and Swedish plural shoes). English repeats one form.
const nameForms: Record<Category, 'base' | 'neuter' | 'plural'> = {
  top: 'base', bottom: 'base', accessory: 'base', one_piece: 'neuter', layer: 'neuter', outerwear: 'neuter', footwear: 'plural',
};
function colourWord(colour: ColourCode, form: 'base' | 'neuter' | 'plural', language: Language): string {
  const key: MessageKey = form === 'base' ? `colour.${colour}` : form === 'neuter' ? `colourNeuter.${colour}` : `colourPlural.${colour}`;
  return translate(language, key).toLocaleLowerCase(locales[language]);
}
function capitalise(text: string, language: Language): string {
  const [first = '', ...rest] = [...text];
  return first.toLocaleUpperCase(locales[language]) + rest.join('');
}
const firstColour = (colours: readonly string[]) => colours.find(isColourCode);
// "Green top" / "Vihreä yläosa" / "Grön överdel" from the category and the first colour only.
export function defaultItemName(category: string | null | undefined, colours: readonly string[], language: Language): string {
  const colour = firstColour(colours);
  const known = category && isCategory(category) ? category : null;
  if (known && colour) return capitalise(translate(language, `itemName.${known}`, { colour: colourWord(colour, nameForms[known], language) }), language);
  if (known) return translate(language, `categoryOne.${known}`);
  return colour ? translate(language, `colour.${colour}`) : '';
}
// "Linen shirt in blue": the name, plus the first colour when the name does not already mention it, within 240 characters.
export function defaultDescription(title: string, colours: readonly string[], language: Language): string {
  const name = title.trim();
  if (!name) return '';
  const colour = firstColour(colours);
  const lower = name.toLocaleLowerCase(locales[language]);
  const named = !colour || (['base', 'neuter', 'plural'] as const).some((form) => lower.includes(colourWord(colour, form, language)));
  const text = named ? name : translate(language, 'item.photoDescription', { name, colour: colourWord(colour, 'neuter', language) });
  return [...text].slice(0, 240).join('').trim();
}
export const visibleFields = ['title', 'category', 'colours', 'seasons'] as const;
export const moreFields = [
  'subcategory', 'pattern', 'brand', 'size_label', 'material', 'formality', 'warmth',
  'purchase_price', 'purchase_date', 'notes', 'tags', 'favourite',
] as const;
export const occasionOptions = [
  ['0', 'occasion.home'], ['1', 'occasion.everyday'], ['2', 'occasion.smart'], ['3', 'occasion.business'], ['4', 'occasion.formal'],
] as const satisfies ReadonlyArray<readonly [string, MessageKey]>;
// Three display steps over the stored 0–4 scale. A stored 0 or 4 keeps its value until the user picks another option.
export function warmthOptions(raw: string): ReadonlyArray<readonly [string, MessageKey]> {
  return [[raw === '0' || raw === '1' ? raw : '1', 'warmth.light'], ['2', 'warmth.medium'],
    [raw === '3' || raw === '4' ? raw : '3', 'warmth.warm']];
}
export const tagLength = styleTagLimit;
export type TagResult = { status: 'added'; tags: string[] } | { status: 'duplicate' | 'full' | 'invalid' | 'empty' };
// One Tags area shows both saved lists, so additions share one count and byte budget across tags and style words.
// Saved lists already over the budget stay as they are; only additions that would exceed it are refused.
export const tagBudget = { count: collectionLimits.tags, bytes: 512 } as const;
export function fitsTagBudget(entries: readonly string[]): boolean {
  return entries.length <= tagBudget.count && new TextEncoder().encode(entries.join(',')).byteLength <= tagBudget.bytes;
}
// True when not even a one-character tag would fit.
export function tagBudgetFull(tags: readonly string[], styleTags: readonly string[]): boolean {
  return !fitsTagBudget([...tags, ...styleTags, 'x']);
}
// New entries always go to `tags`; style words stay where they are. Duplicates across both lists are refused.
export function addTag(entry: string, tags: readonly string[], styleTags: readonly string[]): TagResult {
  const value = entry.trim();
  if (!value) return { status: 'empty' };
  if ([...value].length > tagLength || value.includes('\0')) return { status: 'invalid' };
  if ([...tags, ...styleTags].some((tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase())) return { status: 'duplicate' };
  if (!fitsTagBudget([...tags, ...styleTags, value])) return { status: 'full' };
  return { status: 'added', tags: [...tags, value] };
}
function version(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
export function parseItemBaseline(value: unknown, ownerId: string, itemId: string): ItemBaseline {
  if (!isUuid(ownerId) || !isUuid(itemId) || !isRecord(value) || value.owner_id !== ownerId || value.id !== itemId
    || value.deleted_at !== null || !version(value.version, Number.MAX_SAFE_INTEGER)
    || typeof value.title !== 'string' || !value.title || [...value.title].length > 100 || !isCategory(value.category)
    || typeof value.updated_at !== 'string' || itemFactColumns.some((key) => !Object.hasOwn(value, key) || !jsonValue(value[key]))) {
    throw new AppError('detail.unavailable');
  }
  let provenance: FieldProvenance;
  try { provenance = parseFieldProvenance(value.field_provenance); } catch { throw new AppError('detail.unavailable'); }
  const values = parseGarmentValues(value);
  return freezeValues({
    id: itemId, ownerId, title: value.title, category: value.category, version: value.version, provenance,
    values,
    facts: structuredClone(Object.fromEntries(itemFactColumns.map((key) => [key, key === 'purchase_price' ? values.purchase_price : value[key]]))),
  });
}
export function parseImageBaseline(value: unknown, ownerId: string, itemId: string): ImageBaseline {
  if (!isUuid(ownerId) || !isUuid(itemId) || !isRecord(value) || value.owner_id !== ownerId || value.item_id !== itemId || !isUuid(value.id)
    || value.state !== 'ready' || value.retired_at !== null || typeof value.alt_text !== 'string'
    || [...value.alt_text].length > 240 || !version(value.description_version, maximumFieldRevision)
    || value.main_path !== `${ownerId}/${itemId}/${value.id}/main.jpg`
    || value.thumb_path !== `${ownerId}/${itemId}/${value.id}/thumb.jpg`) throw new AppError('detail.unavailable');
  return freezeValues({
    id: value.id, ownerId, itemId, altText: value.alt_text, version: value.description_version,
    mainPath: String(value.main_path), thumbPath: String(value.thumb_path),
  });
}
export function prepareItemAttempt(baseline: ItemBaseline, title: string, category: string, epoch: number): ItemAttempt {
  let draft = newGarmentDraft(baseline.values.currency, 'en', baseline.values);
  if (title !== baseline.title) draft = editGarmentField(draft, 'title', title, 'en');
  if (category !== baseline.category) draft = editGarmentField(draft, 'category', category, 'en');
  return prepareGarmentAttempt(baseline, draft, epoch);
}
export function prepareGarmentAttempt(baseline: ItemBaseline, draft: GarmentDraft, epoch: number): ItemAttempt {
  if (!Number.isSafeInteger(baseline.version) || baseline.version < 1 || baseline.version >= Number.MAX_SAFE_INTEGER) throw new AppError('detail.invalidFields');
  const { values: fields, patch } = buildGarmentWrite(draft, baseline.values, baseline.provenance);
  if (Object.keys(patch).length === 1) throw new AppError('detail.invalidFields');
  return freezeValues({ epoch, baseline: structuredClone(baseline), fields, patch });
}
export function prepareDescriptionAttempt(baseline: ImageBaseline, text: string, epoch: number): DescriptionAttempt {
  const value = validDescription(text);
  if (value === null || value === baseline.altText || baseline.version >= maximumFieldRevision) throw new AppError('detail.invalidDescription');
  return freezeValues({ epoch, baseline: structuredClone(baseline), text: value });
}
export function confirmsItem(actual: ItemBaseline, attempt: ItemAttempt): boolean {
  const expectedFacts = { ...attempt.baseline.facts };
  for (const key of itemFactColumns) if (key !== 'created_at') expectedFacts[key] = attempt.fields[key];
  return actual.ownerId === attempt.baseline.ownerId && actual.id === attempt.baseline.id
    && actual.version === attempt.baseline.version + 1 && actual.title === attempt.fields.title
    && actual.category === attempt.fields.category && sameFieldProvenance(actual.provenance, attempt.patch.field_provenance)
    && sameValue(actual.facts, expectedFacts);
}
export function confirmsDescription(actual: ImageBaseline, attempt: DescriptionAttempt): boolean {
  return actual.ownerId === attempt.baseline.ownerId && actual.itemId === attempt.baseline.itemId
    && actual.id === attempt.baseline.id && actual.altText === attempt.text && actual.version === attempt.baseline.version + 1
    && actual.mainPath === attempt.baseline.mainPath && actual.thumbPath === attempt.baseline.thumbPath;
}
