import { describe, expect, it } from 'vitest';
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
    expect(validateDetails('  Shirt  ', 'top', '')).toEqual({ title: 'Shirt', category: 'top', altText: 'Shirt' });
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
});
