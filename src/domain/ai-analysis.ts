import { isRecord, isUuid } from './wardrobe';
import { colours, styleTagLimit } from './preferences';
import {
  collectionLimits, enumFields, freezeValues, integerRanges, seasons, textLimits, type GarmentValues,
} from './garment-fields';

export const observedAiFields = [
  'category', 'subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length',
  'brand', 'size_label', 'upper_coverage', 'lower_coverage',
] as const;
export const estimatedAiFields = ['material', 'seasons', 'formality', 'style_tags'] as const;
export const aiFields = [...observedAiFields, ...estimatedAiFields] as const;
export type AiField = typeof aiFields[number];
export type AiKind<K extends AiField = AiField> = K extends typeof observedAiFields[number] ? 'ai_observed' : 'ai_estimated';
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type AiFacts = DeepReadonly<{
  outcome: 'ready' | 'unclear';
  fields: Partial<{ [K in AiField]: GarmentValues[K] | (GarmentValues[K] extends string[] ? never : null) }>;
}>;
export type AiResult = DeepReadonly<{
  schemaVersion: 1; requestId: string; draftId: string; generation: number; imageSha256: string;
  modelId: string; promptVersion: number; createdAtMs: number; expiresAtMs: number; facts: AiFacts;
}>;
export type AiParseResult<T> = { ok: true; value: T } | { ok: false; code: 'INVALID_RESULT' };
export const maximumAiBytes = 8192;
export const maximumAiLifetimeMs = 24 * 60 * 60 * 1000;
export const maximumAiCounter = 2147483647;

export function isAiCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximumAiCounter;
}
export function isAiTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isImageSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
export function aiKind<K extends AiField>(field: K): AiKind<K> {
  return (observedAiFields.some((key) => key === field) ? 'ai_observed' : 'ai_estimated') as AiKind<K>;
}

// These parsers accept JSON data, not objects with executable/accessor properties.
export function hasOnlyDataKeys(value: unknown, keys: readonly string[], required = keys): value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
    && required.every((key) => Object.hasOwn(value, key));
}
function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit * 2 && [...value].length <= limit
    && !value.includes('\0') && value.trim().length > 0;
}
function validList(value: unknown, limit: number, valid: (entry: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= limit
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
      .every((entry) => entry && Object.hasOwn(entry, 'value') && valid(entry.value))
    && new Set(value).size === value.length;
}
function validFact(field: AiField, value: unknown): boolean {
  switch (field) {
    case 'colours': return validList(value, collectionLimits.colours, (entry) => colours.some((code) => code === entry));
    case 'seasons': return validList(value, collectionLimits.seasons, (entry) => seasons.some((code) => code === entry));
    case 'style_tags': return validList(value, collectionLimits.style_tags, (entry) => validText(entry, styleTagLimit));
    case 'category': case 'pattern': case 'sleeve_length': case 'garment_length':
      return value === null || enumFields[field].some((code) => code === value);
    case 'formality': case 'upper_coverage': case 'lower_coverage': {
      const [min, max] = integerRanges[field];
      return value === null || typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    }
    default: return value === null || validText(value, textLimits[field]);
  }
}
export function isAssertedAiValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}
function withinByteLimit(value: AiFacts | AiResult): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximumAiBytes;
}
export function parseAiFacts(input: unknown): AiParseResult<AiFacts> {
  if (!hasOnlyDataKeys(input, ['outcome', 'fields']) || input.outcome !== 'ready' && input.outcome !== 'unclear'
    || !hasOnlyDataKeys(input.fields, aiFields, [])) return { ok: false, code: 'INVALID_RESULT' };
  const fields: Record<string, unknown> = {};
  for (const field of aiFields) {
    if (!Object.hasOwn(input.fields, field)) continue;
    const value = input.fields[field];
    if (!validFact(field, value) || input.outcome === 'unclear' && isAssertedAiValue(value)) return { ok: false, code: 'INVALID_RESULT' };
    fields[field] = Array.isArray(value) ? [...value] : value;
  }
  const facts = { outcome: input.outcome, fields } as AiFacts;
  if (!withinByteLimit(facts)) return { ok: false, code: 'INVALID_RESULT' };
  return { ok: true, value: freezeValues(facts) };
}

const resultKeys = [
  'schemaVersion', 'requestId', 'draftId', 'generation', 'imageSha256',
  'modelId', 'promptVersion', 'createdAtMs', 'expiresAtMs', 'facts',
] as const;
export function parseAiResult(input: unknown): AiParseResult<AiResult> {
  if (!hasOnlyDataKeys(input, resultKeys) || input.schemaVersion !== 1
    || !isUuid(input.requestId) || !isUuid(input.draftId) || !isAiCounter(input.generation)
    || !isImageSha256(input.imageSha256) || typeof input.modelId !== 'string'
    || !/^[A-Za-z0-9._:/-]{1,128}$/.test(input.modelId) || !isAiCounter(input.promptVersion)
    || !isAiTimestamp(input.createdAtMs) || !isAiTimestamp(input.expiresAtMs)
    || input.expiresAtMs <= input.createdAtMs || input.expiresAtMs - input.createdAtMs > maximumAiLifetimeMs) {
    return { ok: false, code: 'INVALID_RESULT' };
  }
  const facts = parseAiFacts(input.facts);
  if (!facts.ok) return facts;
  const value: AiResult = {
    schemaVersion: 1, requestId: input.requestId, draftId: input.draftId, generation: input.generation,
    imageSha256: input.imageSha256, modelId: input.modelId, promptVersion: input.promptVersion,
    createdAtMs: input.createdAtMs, expiresAtMs: input.expiresAtMs, facts: facts.value,
  };
  if (!withinByteLimit(value)) return { ok: false, code: 'INVALID_RESULT' };
  return { ok: true, value: freezeValues(value) };
}
