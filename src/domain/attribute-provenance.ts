import { isRecord } from './wardrobe';

export const patterns = ['solid', 'striped', 'checked', 'dotted', 'floral', 'graphic', 'abstract', 'animal', 'other'] as const;
export const sleeveLengths = ['sleeveless', 'short', 'elbow', 'three_quarter', 'long'] as const;
export const garmentLengths = ['cropped', 'short', 'regular', 'long'] as const;
export type Pattern = typeof patterns[number];
export type SleeveLength = typeof sleeveLengths[number];
export type GarmentLength = typeof garmentLengths[number];

export const provenanceFields = [
  'title', 'category', 'subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length',
  'brand', 'size_label', 'material', 'seasons', 'formality', 'warmth', 'min_temp', 'max_temp',
  'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage', 'style_tags', 'tags',
  'purchase_date', 'purchase_price', 'notes',
] as const;
export const provenanceKinds = ['unknown', 'ai_observed', 'ai_estimated', 'user'] as const;
export const maximumFieldRevision = 2147483647;
export const maximumProvenanceBytes = 4096;
export type ProvenanceField = typeof provenanceFields[number];
export type ProvenanceKind = typeof provenanceKinds[number];
export type FieldAssertion = { kind: ProvenanceKind; revision: number };
export type FieldProvenance = Partial<Record<ProvenanceField, FieldAssertion>>;

class InvalidFieldProvenance extends Error {
  constructor() { super('Invalid input'); }
}

export function parseFieldProvenance(value: unknown): FieldProvenance {
  if (!isRecord(value) || Object.keys(value).length > provenanceFields.length) throw new InvalidFieldProvenance();
  const parsed: FieldProvenance = {};
  for (const [field, entry] of Object.entries(value)) {
    if (!provenanceFields.some((known) => known === field) || !isRecord(entry)
      || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'kind') || !Object.hasOwn(entry, 'revision')
      || !provenanceKinds.some((kind) => kind === entry.kind)
      || typeof entry.revision !== 'number' || !Number.isInteger(entry.revision)
      || entry.revision < 1 || entry.revision > maximumFieldRevision) throw new InvalidFieldProvenance();
    parsed[field as ProvenanceField] = { kind: entry.kind as ProvenanceKind, revision: entry.revision };
  }
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maximumProvenanceBytes) throw new InvalidFieldProvenance();
  return parsed;
}

// Absence is unverified even when a retained value is non-null.
export function fieldAssertion(provenance: FieldProvenance, field: ProvenanceField): FieldAssertion {
  return provenance[field] ?? { kind: 'unknown', revision: 0 };
}

export function manualSaveProvenance(fields: readonly ProvenanceField[] = ['title', 'category'], baseline: FieldProvenance = {}): FieldProvenance {
  const result = parseFieldProvenance(baseline);
  for (const field of fields) {
    if (!provenanceFields.includes(field)) throw new InvalidFieldProvenance();
    const previous = fieldAssertion(result, field);
    if (previous.revision >= maximumFieldRevision) throw new InvalidFieldProvenance();
    result[field] = { kind: 'user', revision: previous.revision + 1 };
  }
  return result;
}

export function sameFieldProvenance(actual: unknown, expected: unknown): boolean {
  try {
    const left = parseFieldProvenance(actual), right = parseFieldProvenance(expected);
    return provenanceFields.every((field) => left[field]?.kind === right[field]?.kind
      && left[field]?.revision === right[field]?.revision);
  } catch (error) {
    if (error instanceof InvalidFieldProvenance) return false;
    throw error;
  }
}

export function analyzedSaveProvenance(kinds: Partial<Record<ProvenanceField, ProvenanceKind>>): FieldProvenance {
  return parseFieldProvenance(Object.fromEntries(Object.entries(kinds).map(([field, kind]) => [field, { kind, revision: 1 }])));
}
