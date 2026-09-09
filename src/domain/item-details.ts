import { fieldAssertion, maximumFieldRevision, parseFieldProvenance, sameFieldProvenance, type FieldProvenance } from './attribute-provenance';
import { isCategory, isRecord, isUuid, type Category } from './wardrobe';
import { AppError } from '../data/errors';

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
};
export type ImageBaseline = {
  id: string; ownerId: string; itemId: string; altText: string; version: number;
  mainPath: string; thumbPath: string;
};
export type ItemDetail = { item: ItemBaseline; image: ImageBaseline };
export type ItemAttempt = {
  epoch: number; baseline: ItemBaseline; fields: ItemFields;
  patch: { title?: string; category?: Category; field_provenance: FieldProvenance };
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
function version(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (isRecord(left) && isRecord(right)) return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  return false;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
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
  return frozen({
    id: itemId, ownerId, title: value.title, category: value.category, version: value.version, provenance,
    facts: structuredClone(Object.fromEntries(itemFactColumns.map((key) => [key, value[key]]))),
  });
}
export function parseImageBaseline(value: unknown, ownerId: string, itemId: string): ImageBaseline {
  if (!isUuid(ownerId) || !isUuid(itemId) || !isRecord(value) || value.owner_id !== ownerId || value.item_id !== itemId || !isUuid(value.id)
    || value.state !== 'ready' || value.retired_at !== null || typeof value.alt_text !== 'string'
    || [...value.alt_text].length > 240 || !version(value.description_version, maximumFieldRevision)
    || value.main_path !== `${ownerId}/${itemId}/${value.id}/main.jpg`
    || value.thumb_path !== `${ownerId}/${itemId}/${value.id}/thumb.jpg`) throw new AppError('detail.unavailable');
  return frozen({
    id: value.id, ownerId, itemId, altText: value.alt_text, version: value.description_version,
    mainPath: String(value.main_path), thumbPath: String(value.thumb_path),
  });
}
export function prepareItemAttempt(baseline: ItemBaseline, title: string, category: string, epoch: number): ItemAttempt {
  const fields = validItemFields(title, category);
  if (!fields || baseline.version >= Number.MAX_SAFE_INTEGER) throw new AppError('detail.invalidFields');
  const provenance = structuredClone(baseline.provenance);
  const patch: ItemAttempt['patch'] = { field_provenance: provenance };
  for (const field of ['title', 'category'] as const) {
    if (fields[field] === baseline[field]) continue;
    const assertion = fieldAssertion(provenance, field);
    if (assertion.revision >= maximumFieldRevision) throw new AppError('error.conflict');
    provenance[field] = { kind: 'user', revision: assertion.revision + 1 };
    if (field === 'title') patch.title = fields.title;
    else patch.category = fields.category;
  }
  if (patch.title === undefined && patch.category === undefined) throw new AppError('detail.invalidFields');
  return frozen({ epoch, baseline: structuredClone(baseline), fields, patch });
}
export function prepareDescriptionAttempt(baseline: ImageBaseline, text: string, epoch: number): DescriptionAttempt {
  const value = validDescription(text);
  if (value === null || value === baseline.altText || baseline.version >= maximumFieldRevision) throw new AppError('detail.invalidDescription');
  return frozen({ epoch, baseline: structuredClone(baseline), text: value });
}
export function confirmsItem(actual: ItemBaseline, attempt: ItemAttempt): boolean {
  return actual.ownerId === attempt.baseline.ownerId && actual.id === attempt.baseline.id
    && actual.version === attempt.baseline.version + 1 && actual.title === attempt.fields.title
    && actual.category === attempt.fields.category && sameFieldProvenance(actual.provenance, attempt.patch.field_provenance)
    && sameValue(actual.facts, attempt.baseline.facts);
}
export function confirmsDescription(actual: ImageBaseline, attempt: DescriptionAttempt): boolean {
  return actual.ownerId === attempt.baseline.ownerId && actual.itemId === attempt.baseline.itemId
    && actual.id === attempt.baseline.id && actual.altText === attempt.text && actual.version === attempt.baseline.version + 1
    && actual.mainPath === attempt.baseline.mainPath && actual.thumbPath === attempt.baseline.thumbPath;
}
