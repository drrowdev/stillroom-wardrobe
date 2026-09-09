import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  patterns, sleeveLengths, garmentLengths, provenanceFields, provenanceKinds,
  maximumFieldRevision, maximumProvenanceBytes, parseFieldProvenance, fieldAssertion,
  manualSaveProvenance, sameFieldProvenance,
} from '../../src/domain/attribute-provenance';
import { categories, isUuid, validateDetails } from '../../src/domain/wardrobe';
import { readConfiguration } from '../../src/data/config';
import { parseWardrobeRows } from '../../src/data/items';
import { parseProfile } from '../../src/data/profile';

const owner = '10000000-0000-4000-8000-000000000001';
const itemId = '20000000-0000-4000-8000-000000000001';
const imageId = '30000000-0000-4000-8000-000000000001';
const row = { id: itemId, owner_id: owner, title: 'Olive shirt', category: 'top', created_at: '2026-09-06T08:00:00Z', deleted_at: null };
const image = {
  id: imageId, item_id: itemId, owner_id: owner, state: 'ready', alt_text: 'Olive shirt',
  main_path: `${owner}/${itemId}/${imageId}/main.jpg`, thumb_path: `${owner}/${itemId}/${imageId}/thumb.jpg`,
};
describe('manual draft validation', () => {
  it('requires real details only when saving', () => {
    expect(validateDetails('', '', '')).toBeNull();
    expect(validateDetails('   ', 'top', '')).toBeNull();
    expect(validateDetails('Shirt', 'foreign', '')).toBeNull();
    expect(validateDetails('  Shirt  ', 'top', '')).toEqual({ title: 'Shirt', category: 'top', altText: '' });
  });
  it('keeps edited descriptions and bounds fields', () => {
    expect(validateDetails('Shirt', 'top', 'Front view')?.altText).toBe('Front view');
    expect(validateDetails('a'.repeat(101), 'top', '')).toBeNull();
    expect(validateDetails('Shirt', 'top', 'a'.repeat(241))).toBeNull();
    expect(categories).toHaveLength(7);
    expect(isUuid(owner)).toBe(true);
    expect(isUuid('../image')).toBe(false);
  });
});
describe('private API boundaries', () => {
  it('shows only complete owned items', () => {
    expect(parseWardrobeRows([row], [], owner)).toEqual([]);
    expect(parseWardrobeRows([row], [{ ...image, state: 'pending' }], owner)).toEqual([]);
    expect(parseWardrobeRows([{ ...row, deleted_at: '2026-09-06' }], [image], owner)).toEqual([]);
    expect(parseWardrobeRows([row], [image], owner)[0]?.title).toBe('Olive shirt');
  });
  it('rejects owner and image-path mismatches', () => {
    expect(() => parseWardrobeRows([{ ...row, owner_id: 'another' }], [image], owner)).toThrow();
    expect(() => parseWardrobeRows([row], [{ ...image, main_path: 'public/photo.jpg' }], owner)).toThrow();
    expect(() => parseWardrobeRows(null, [], owner)).toThrow();
    expect(() => parseProfile({ owner_id: 'another' }, owner)).toThrow();
  });
});
describe('public configuration', () => {
  it('has an honest unconfigured state', () => expect(readConfiguration({})).toEqual({ status: 'missing' }));
  it('accepts only https or local development and public keys', () => {
    const values = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' };
    expect(readConfiguration(values).status).toBe('ready');
    expect(readConfiguration({ ...values, VITE_SUPABASE_URL: 'http://example.com' }).status).toBe('invalid');
    expect(readConfiguration({ ...values, VITE_SUPABASE_URL: 'https://user:password@example.com' }).status).toBe('invalid');
    expect(readConfiguration({ ...values, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_invalid' }).status).toBe('invalid');
    const key = `e30.${btoa(JSON.stringify({ role: 'service_role' }))}.fixture`;
    expect(readConfiguration({ ...values, VITE_SUPABASE_PUBLISHABLE_KEY: key }).status).toBe('invalid');
  });

  describe('I29a saved field provenance', () => {
    const migration = readFileSync(new URL('../../supabase/migrations/20260906000000_item_field_provenance.sql', import.meta.url), 'utf8');
    it('keeps the exact bounded field and finite code contracts aligned with SQL', () => {
      expect(migration.replace(/\s+/g, '')).toContain(`fieldsconstanttext[]:=array['${provenanceFields.join("','")}'];`);
      expect(new Set(provenanceFields).size).toBe(24);
      for (const [field, codes] of [['pattern', patterns], ['sleeve_length', sleeveLengths], ['garment_length', garmentLengths]] as const) {
        expect(migration).toContain(`check (${field} in (${codes.map((code) => `'${code}'`).join(',')}))`);
      }
      expect(patterns).toEqual(['solid', 'striped', 'checked', 'dotted', 'floral', 'graphic', 'abstract', 'animal', 'other']);
      expect(sleeveLengths).toEqual(['sleeveless', 'short', 'elbow', 'three_quarter', 'long']);
      expect(garmentLengths).toEqual(['cropped', 'short', 'regular', 'long']);
      expect(migration).toContain('previous_revision=2147483647');
      expect(migration).toContain('>4096');
    });
    it('retains maximum revisions only when no increment is needed and keeps the migration additive', () => {
      expect(migration).toContain(`if entry is distinct from previous then
      if entry is null or previous_revision=2147483647 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
      if (entry->'revision')::integer<>previous_revision+1 then
        raise exception using errcode='22023',message='Request conflict';
      end if;
    elsif new_values->field is distinct from old_values->field then
      if previous_revision=2147483647 then
        raise exception using errcode='22023',message='Request conflict';
      end if;`);
      for (const field of ['formality', 'warmth', 'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage']) {
        expect(migration).toContain(`alter column ${field} drop not null`);
        expect(migration).toContain(`alter column ${field} drop default`);
      }
      expect(migration).not.toMatch(/\b(?:update|insert into|delete from)\s+public\.items\b/i);
      expect(migration).toContain("language plpgsql set search_path = ''");
      expect(migration).not.toMatch(/security definer|create policy|grant |touch_record/i);
      const initial = readFileSync(new URL('../../supabase/migrations/20260905000000_initial.sql', import.meta.url), 'utf8');
      const exportStart = 'function public.export_manifest(';
      const exportBody = (source: string) => source.slice(source.indexOf(exportStart), source.indexOf('$$;', source.indexOf(exportStart)) + 3);
      expect(exportBody(migration)).toBe(exportBody(initial).replace("'schema_version',1", "'schema_version',2"));
    });
    it('reads all four kinds without treating absent or unknown provenance as a null value', () => {
      for (const kind of provenanceKinds) {
        const parsed = parseFieldProvenance({ title: { kind, revision: maximumFieldRevision } });
        expect(fieldAssertion(parsed, 'title')).toEqual({ kind, revision: maximumFieldRevision });
        expect(fieldAssertion(parsed, 'warmth')).toEqual({ kind: 'unknown', revision: 0 });
      }
      expect(parseFieldProvenance({})).toEqual({});
      const full = Object.fromEntries(provenanceFields.map((field) => [field, { kind: 'ai_estimated', revision: maximumFieldRevision }]));
      expect(parseFieldProvenance(full)).toEqual(full);
      expect(new TextEncoder().encode(JSON.stringify(full)).byteLength).toBeLessThan(maximumProvenanceBytes);
    });
    it('rejects malformed maps, fields, entries and revisions with a static error', () => {
      const invalid = [
        null, undefined, [], 'garment', 1, { currency: { kind: 'user', revision: 1 } },
        { title: null }, { title: [] }, { title: {} }, { title: { kind: 'user' } },
        { title: { revision: 1 } }, { title: { kind: 'user', revision: 1, extra: true } },
        { title: { kind: 'invented', revision: 1 } },
        { title: { kind: 'å'.repeat(4096), revision: 1 } },
        Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, { kind: 'user', revision: 1 }])),
        ...[0, -1, 1.5, maximumFieldRevision + 1, NaN, Infinity, '1', null, true].map((revision) => ({ title: { kind: 'user', revision } })),
      ];
      for (const value of invalid) {
        expect(() => parseFieldProvenance(value)).toThrow('Invalid input');
        expect(sameFieldProvenance(value, {})).toBe(false);
      }
    });
    it('asserts only manual title/category at insert revision one', () => {
      expect(manualSaveProvenance()).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
      const map = manualSaveProvenance();
      map.title!.revision = 5;
      expect(manualSaveProvenance().title?.revision).toBe(1);
    });
    it('compares exact semantic keys and entries independent of property order', () => {
      const expected = manualSaveProvenance();
      expect(sameFieldProvenance({ category: { revision: 1, kind: 'user' }, title: { revision: 1, kind: 'user' } }, expected)).toBe(true);
      for (const mismatch of [
        {}, { title: expected.title }, { ...expected, warmth: { kind: 'unknown', revision: 1 } },
        ...provenanceKinds.filter((kind) => kind !== 'user').map((kind) => ({ ...expected, title: { kind, revision: 1 } })),
        { ...expected, title: { kind: 'user', revision: 2 } },
      ]) expect(sameFieldProvenance(mismatch, expected)).toBe(false);
      expect(sameFieldProvenance(expected, null)).toBe(false);
    });
    it('does not silently classify unexpected programming errors as provenance conflicts', () => {
      const failure = new Error('Invalid input');
      const broken = Object.defineProperty({}, 'title', { enumerable: true, get() { throw failure; } });
      expect(() => sameFieldProvenance(broken, {})).toThrow(failure);
      expect(() => sameFieldProvenance({}, broken)).toThrow(failure);
    });
  });
});
