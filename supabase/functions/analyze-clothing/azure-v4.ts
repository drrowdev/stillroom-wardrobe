import { garmentTypes, garmentTypesByCategory, isGarmentTypeFor } from '../../../src/domain/garment-types.ts';
import { AZURE_PROMPT, AZURE_SCHEMA, type AzureSpec } from './azure-openai.ts';
import type { JsonObject } from './protocol.ts';

// CAPS1a: prompt version 3 adds one closed field, garment_type. The v2 and v3 manifests keep their exact prompt, schema and
// settings (frozen, digest-pinned); this file derives the v4 text from them so every other word stays the same.
function swap(text: string, find: string, replacement: string): string {
  if (text.split(find).length !== 2) throw new Error('The analysis prompt changed unexpectedly.');
  return text.replace(find, () => replacement);
}
const typeList = Object.entries(garmentTypesByCategory).map(([category, codes]) => `${category}: ${codes.join(', ')}`).join('; ');
export const AZURE_PROMPT_V4 = swap(swap(swap(AZURE_PROMPT,
  'Include all 14 field keys.', 'Include all 15 field keys.'),
  'still include all 14 field keys', 'still include all 15 field keys'),
  'Do not infer warmth',
  'Garment type: set garment_type to one code allowed for the category you chose, or null when unsure or when none fits; never use a code '
  + `that is not listed for that category. Allowed codes: ${typeList}. `
  + 't_shirt is a plain tee; polo has a collar and a short placket; shirt has a full button front; shorts include jeans and sweat shorts; '
  + 'shell is a thin waterproof or windproof jacket; puffer is padded or down; overshirt is a heavy shirt worn as a jacket; knit is a knitted pullover. '
  + 'Do not infer warmth');

const base = AZURE_SCHEMA.properties.fields;
export const AZURE_SCHEMA_V4 = {
  type: 'object', additionalProperties: false, required: ['outcome', 'fields'],
  properties: {
    outcome: AZURE_SCHEMA.properties.outcome,
    fields: { type: 'object', additionalProperties: false,
      required: ['category', 'garment_type', ...base.required.filter((key) => key !== 'category')],
      properties: {
        category: base.properties.category,
        garment_type: { type: ['string', 'null'], enum: [...garmentTypes, null] },
        subcategory: base.properties.subcategory, colours: base.properties.colours, pattern: base.properties.pattern,
        sleeve_length: base.properties.sleeve_length, garment_length: base.properties.garment_length,
        brand: base.properties.brand, size_label: base.properties.size_label,
        upper_coverage: base.properties.upper_coverage, lower_coverage: base.properties.lower_coverage,
        material: base.properties.material, seasons: base.properties.seasons, formality: base.properties.formality,
        style_tags: base.properties.style_tags,
      },
    },
  },
};
export const AZURE_SPEC_V4: AzureSpec = Object.freeze({ prompt: AZURE_PROMPT_V4, schema: AZURE_SCHEMA_V4 });

/** A type the returned category does not have is dropped to null, so the photo still fills in and no invented pairing is stored. */
export function normalizeGarmentType(facts: JsonObject): JsonObject {
  const fields = facts.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return facts;
  const record = fields as JsonObject;
  if (record.garment_type === null || record.garment_type === undefined || isGarmentTypeFor(record.category, record.garment_type)) return facts;
  return { ...facts, fields: { ...record, garment_type: null } };
}
