import type { Database } from '../data/database.types';
import { AppError } from '../data/errors';
import { isLanguage, type Language } from '../i18n';
import { canonicalPrice, parsePrice, priceForDatabase, validDateOnly } from '../i18n/format';
import { categories, isRecord, type Category } from './wardrobe';
import {
  fieldAssertion, garmentLengths, manualSaveProvenance, patterns, provenanceFields, sleeveLengths,
  type FieldProvenance, type GarmentLength, type Pattern, type SleeveLength,
} from './attribute-provenance';
import { colours, styleTagLimit } from './preferences';

export const seasons = ['spring', 'summer', 'autumn', 'winter'] as const;
export const availability = ['ready', 'laundry', 'repair', 'lent'] as const;
export const lifecycle = ['active', 'archived', 'donated', 'sold'] as const;
export const garmentFields = [...provenanceFields, 'currency', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions', 'wear_more'] as const;
export type GarmentField = typeof garmentFields[number];
export type GarmentValues = {
  title: string; category: Category; subcategory: string | null; colours: string[];
  pattern: Pattern | null; sleeve_length: SleeveLength | null; garment_length: GarmentLength | null;
  brand: string | null; size_label: string | null; material: string | null; seasons: string[];
  formality: number | null; warmth: number | null; min_temp: number | null; max_temp: number | null;
  rain_rating: number | null; windproof: boolean | null; upper_coverage: number | null; lower_coverage: number | null;
  style_tags: string[]; tags: string[]; purchase_date: string | null; purchase_price: string | null; notes: string;
  currency: string; favourite: boolean; availability: typeof availability[number]; lifecycle: typeof lifecycle[number];
  exclude_suggestions: boolean; wear_more: boolean;
};
export type ManualIntent = Partial<Record<GarmentField, true>>;
export type RawFields = { [K in GarmentField]: GarmentValues[K] extends string[] ? string[] : string };
export type GarmentDraft = { raw: RawFields; intent: ManualIntent; priceLanguage: Language };
export type GarmentPayload = Required<Pick<Database['public']['Tables']['items']['Insert'], GarmentField>>;
export type GarmentPatch = Partial<GarmentPayload> & { field_provenance: FieldProvenance };
export type FieldErrors = Partial<Record<GarmentField, true>>;

export const textLimits = { title: 100, subcategory: 60, brand: 100, size_label: 50, material: 200, notes: 4000 } as const;
export const integerRanges = {
  formality: [0, 4], warmth: [0, 4], min_temp: [-40, 50], max_temp: [-40, 50],
  rain_rating: [0, 2], upper_coverage: [0, 2], lower_coverage: [0, 2],
} as const;
export const collectionLimits = { colours: 3, seasons: 4, style_tags: 8, tags: 12 } as const;
export const enumFields = { category: categories, pattern: patterns, sleeve_length: sleeveLengths, garment_length: garmentLengths, availability, lifecycle } as const;
export const booleanFields = ['windproof', 'favourite', 'exclude_suggestions', 'wear_more'] as const;

export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (isRecord(left) && isRecord(right)) return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  return false;
}
export function freezeValues<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeValues);
    Object.freeze(value);
  }
  return value;
}
export function initialRawFields(currency: string): RawFields {
  return {
    title: '', category: '', subcategory: '', colours: [], pattern: '', sleeve_length: '', garment_length: '',
    brand: '', size_label: '', material: '', seasons: [], formality: '', warmth: '', min_temp: '', max_temp: '',
    rain_rating: '', windproof: '', upper_coverage: '', lower_coverage: '', style_tags: [], tags: [],
    purchase_date: '', purchase_price: '', notes: '', currency, favourite: 'false', availability: 'ready',
    lifecycle: 'active', exclude_suggestions: 'false', wear_more: 'false',
  };
}
export function newGarmentDraft(currency: string, language: Language, baseline?: GarmentValues): GarmentDraft {
  const raw = initialRawFields(currency);
  if (baseline) {
    for (const key of garmentFields) {
      const value = baseline[key];
      if (key === 'colours' || key === 'seasons' || key === 'style_tags' || key === 'tags') raw[key] = [...baseline[key]];
      else raw[key] = value === null ? '' : String(value);
    }
  }
  // Loaded prices are canonical dot decimals regardless of the current UI language.
  return { raw, intent: {}, priceLanguage: baseline ? 'en' : language };
}
export function editGarmentField<K extends GarmentField>(draft: GarmentDraft, key: K, value: RawFields[K], language: Language): GarmentDraft {
  return {
    raw: { ...draft.raw, [key]: Array.isArray(value) ? [...value] : value }, intent: { ...draft.intent, [key]: true },
    priceLanguage: key === 'purchase_price' ? language : draft.priceLanguage,
  };
}
function allowed(value: unknown, codes: readonly string[]): boolean {
  return typeof value === 'string' && codes.includes(value);
}
function stringValue(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && [...value].length <= maximum;
}
type CollectionBaseline = Pick<GarmentValues, keyof typeof collectionLimits>;
function validCollection(key: keyof typeof collectionLimits, value: unknown, baseline?: CollectionBaseline): value is string[] {
  if (!Array.isArray(value) || value.length > collectionLimits[key] || !value.every((entry) => typeof entry === 'string' && !entry.includes('\0'))) return false;
  if (key === 'tags' && new TextEncoder().encode(value.join(',')).byteLength > 512) return false;
  return value.every((entry: string) => {
    const retained = baseline?.[key].includes(entry);
    const valid = key === 'seasons' ? allowed(entry, seasons) : key === 'colours' ? allowed(entry, colours) || entry === 'unknown'
      : entry.trim().length > 0 && [...entry].length <= styleTagLimit;
    return (valid || key !== 'seasons' && retained) && value.filter((word) => word === entry).length <= Math.max(1, baseline?.[key].filter((word) => word === entry).length ?? 0);
  });
}
export function validateGarmentDraft(draft: GarmentDraft, baseline?: GarmentValues, collections: CollectionBaseline | undefined = baseline): { values: GarmentValues | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const values: Record<string, unknown> = {};
  if (!isRecord(draft.raw) || !isRecord(draft.intent) || !isLanguage(draft.priceLanguage) || Object.keys(draft.raw).length !== garmentFields.length
    || Object.keys(draft.intent).some((key) => !garmentFields.some((field) => field === key) || draft.intent[key as GarmentField] !== true)) {
    throw new AppError('detail.invalidFields');
  }
  for (const key of garmentFields) {
    const raw = draft.raw[key];
    if (baseline && !draft.intent[key]) {
      const original = newGarmentDraft(baseline.currency, 'en', baseline).raw[key];
      if (!sameValue(raw, original)) errors[key] = true;
      values[key] = structuredClone(baseline[key]);
      continue;
    }
    if (key in collectionLimits) {
      if (!validCollection(key as keyof typeof collectionLimits, raw, collections)) errors[key] = true;
      values[key] = Array.isArray(raw) ? [...raw] : raw;
      continue;
    }
    if (typeof raw !== 'string' || raw.includes('\0')) { errors[key] = true; continue; }
    if (key in textLimits) {
      const text = key === 'title' ? raw.trim() : raw;
      if (!stringValue(text, textLimits[key as keyof typeof textLimits]) || key === 'title' && !text) errors[key] = true;
      values[key] = key === 'title' || key === 'notes' ? text : text.trim() ? text : null;
    } else if (key in integerRanges) {
      const [min, max] = integerRanges[key as keyof typeof integerRanges];
      if (raw !== '' && (!/^-?\d+$/.test(raw) || !Number.isInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)) errors[key] = true;
      values[key] = raw === '' ? null : Number(raw);
    } else if (key in enumFields) {
      const optional = key === 'pattern' || key === 'sleeve_length' || key === 'garment_length';
      if (!(optional && raw === '') && !allowed(raw, enumFields[key as keyof typeof enumFields])) errors[key] = true;
      values[key] = optional && raw === '' ? null : raw;
    } else if (key === 'purchase_price') {
      try { values[key] = raw.trim() === '' ? null : parsePrice(raw, draft.priceLanguage); } catch { errors[key] = true; }
    } else if (key === 'purchase_date') {
      if (raw !== '' && !validDateOnly(raw)) errors[key] = true;
      values[key] = raw === '' ? null : raw;
    } else if (key === 'currency') {
      if (!/^[A-Z]{3}$/.test(raw)) errors[key] = true;
      values[key] = raw;
    } else {
      if (raw !== 'true' && raw !== 'false' && !(key === 'windproof' && raw === '')) errors[key] = true;
      values[key] = raw === '' ? null : raw === 'true';
    }
  }
  if (typeof values.min_temp === 'number' && typeof values.max_temp === 'number' && values.min_temp > values.max_temp) {
    errors.min_temp = true; errors.max_temp = true;
  }
  return { values: Object.keys(errors).length ? null : values as GarmentValues, errors };
}
export function garmentPayload(values: GarmentValues): GarmentPayload {
  const { purchase_price, ...fields } = values;
  // Explicit projection prevents system keys from escaping even from a structurally wider caller.
  const payload = {} as GarmentPayload;
  for (const key of garmentFields) {
    if (key === 'purchase_price') payload[key] = purchase_price === null ? null : priceForDatabase(purchase_price);
    else Object.assign(payload, { [key]: structuredClone(fields[key]) });
  }
  return payload;
}
function garmentFieldChange(key: GarmentField, draft: GarmentDraft, values: GarmentValues, baseline: GarmentValues | undefined, provenance: FieldProvenance) {
  const changed = baseline !== undefined && !sameValue(values[key], baseline[key]);
  const factual = provenanceFields.find((field) => field === key);
  const raw = draft.raw[key];
  const cleared = raw === '' || Array.isArray(raw) && raw.length === 0;
  const confirm = factual && draft.intent[key] && (!baseline || changed || cleared || fieldAssertion(provenance, factual).kind !== 'user');
  return { changed, factual, confirm };
}
export function buildGarmentWrite(draft: GarmentDraft, baseline?: GarmentValues, oldProvenance: FieldProvenance = {}): {
  values: GarmentValues; patch: GarmentPatch;
} {
  const { values } = validateGarmentDraft(draft, baseline);
  if (!values) throw new AppError('detail.invalidFields');
  const payload = garmentPayload(values);
  const patch: GarmentPatch = { field_provenance: structuredClone(oldProvenance) };
  const asserted: typeof provenanceFields[number][] = [];
  const defaults = initialRawFields(draft.raw.currency);
  for (const key of garmentFields) {
    const { changed, factual, confirm } = garmentFieldChange(key, draft, values, baseline, oldProvenance);
    if (changed && !draft.intent[key]) throw new AppError('detail.invalidFields');
    if (!baseline && factual && !draft.intent[key] && !sameValue(draft.raw[key], defaults[key])) throw new AppError('detail.invalidFields');
    if (!baseline || changed || confirm) Object.assign(patch, { [key]: payload[key] });
    if (confirm && factual) asserted.push(factual);
  }
  try { patch.field_provenance = manualSaveProvenance(asserted, oldProvenance); } catch { throw new AppError('error.conflict'); }
  return { values, patch };
}
export function garmentDraftDirty(draft: GarmentDraft, baseline: GarmentValues, provenance: FieldProvenance): boolean {
  const { values } = validateGarmentDraft(draft, baseline);
  if (!values) return true;
  return garmentFields.some((key) => {
    const { changed, confirm } = garmentFieldChange(key, draft, values, baseline, provenance);
    return changed || confirm;
  });
}
export function parseGarmentValues(row: Record<string, unknown>): GarmentValues {
  const draft = newGarmentDraft(typeof row.currency === 'string' ? row.currency : '', 'en');
  for (const key of garmentFields) {
    const value = row[key];
    const nullable = key !== 'title' && key !== 'category' && key !== 'notes'
      && !['currency', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions', 'wear_more'].includes(key);
    if (value === null && !nullable) throw new AppError('detail.unavailable');
    if (key === 'colours' || key === 'seasons' || key === 'style_tags' || key === 'tags') {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new AppError('detail.unavailable');
      draft.raw[key] = [...value];
    } else {
      const typeValid = value === null || (key in integerRanges ? typeof value === 'number'
        : booleanFields.some((field) => field === key) ? typeof value === 'boolean'
        : key === 'purchase_price' ? typeof value === 'number' || typeof value === 'string' : typeof value === 'string');
      if (!typeValid) throw new AppError('detail.unavailable');
      draft.raw[key] = value === null ? '' : String(value);
    }
    draft.intent[key] = true;
  }
  if (row.purchase_price !== null) {
    try { draft.raw.purchase_price = canonicalPrice(row.purchase_price); } catch { throw new AppError('detail.unavailable'); }
  }
  const retained = {
    colours: draft.raw.colours, seasons: draft.raw.seasons, style_tags: draft.raw.style_tags, tags: draft.raw.tags,
  };
  // Existing free text and duplicates are retained, not retroactively normalized.
  const result = validateGarmentDraft(draft, undefined, retained);
  if (!result.values) throw new AppError('detail.unavailable');
  const values = result.values;
  for (const key of ['title', 'subcategory', 'brand', 'size_label', 'material'] as const) {
    const original = row[key];
    if (typeof original === 'string') values[key] = original;
  }
  return values;
}
