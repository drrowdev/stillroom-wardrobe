import { describe, expect, it, vi } from 'vitest';
import { colours, profileFields, sameProfileFields, validatePreferences, validateProfile, validTimezone } from '../../src/domain/preferences';
import { categories } from '../../src/domain/wardrobe';
import { parsePreferences, savePreferences } from '../../src/data/preferences';
import { parseProfile, updateProfile } from '../../src/data/profile';
import type { AppClient } from '../../src/data/client';
import type { PreferencesRow, ProfileRow } from '../../src/data/rows';

const owner = '10000000-0000-4000-8000-000000000001';
const profile: ProfileRow = { owner_id: owner, version: 4, display_name: 'Åsa 🌿', ui_language: 'fi', timezone: 'Europe/Helsinki', currency: 'EUR' };
const preferences: PreferencesRow = { owner_id: owner, version: 3, style_tags: [], preferred_colours: [], excluded_categories: [], minimum_upper_coverage: 0, minimum_lower_coverage: 0, cold_sensitivity: 0, repeat_gap_days: 2 };
function backend(...responses: Array<{ data: unknown; error?: unknown }>) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const key of ['from', 'update', 'select', 'eq', 'abortSignal']) chain[key] = (...args: unknown[]) => { calls.push([key, ...args]); return chain; };
  chain.maybeSingle = vi.fn(async () => responses.shift() ?? { data: null });
  return { client: chain as unknown as AppClient, calls, single: chain.maybeSingle };
}
const scope = () => ({ ownerId: owner, epoch: 1, signal: new AbortController().signal });
describe('private preference validation', () => {
  it('whitelists profile fields without translating or trimming private text', () => {
    expect(validateProfile({ ...profile, display_name: ' Åsa 🌿 ' })).toEqual({ display_name: ' Åsa 🌿 ', timezone: 'Europe/Helsinki', currency: 'EUR' });
    expect(sameProfileFields(profile, { ...profileFields(profile), currency: 'SEK' })).toBe(false);
    expect(validateProfile({ ...profile, display_name: '🌿'.repeat(60) }).display_name).toHaveLength(120);
  });
  it.each(['', ' ', 'a'.repeat(61)])('rejects invalid name %j', (display_name) => {
    expect(() => validateProfile({ ...profile, display_name })).toThrow('settings.invalidName');
  });
  it.each(['eur', 'EU', 'EURO', '12X', ' EUR'])('rejects malformed currency %j', (currency) => {
    expect(() => validateProfile({ ...profile, currency })).toThrow('settings.invalidCurrency');
  });
  it.each(['', 'Mars/Olympus', '+02:00', 'Europe/Helsinki '])('rejects invalid timezone %j', (timezone) => {
    expect(validTimezone(timezone)).toBe(false);
    expect(() => validateProfile({ ...profile, timezone })).toThrow('settings.invalidTimezone');
  });
  it('accepts IANA zones and uppercase currencies independently of language', () => {
    expect(validTimezone('Europe/Stockholm')).toBe(true);
    expect(validTimezone('UTC')).toBe(true);
    expect(validateProfile({ ...profile, currency: 'SEK' }).timezone).toBe(profile.timezone);
  });
  it('accepts empty arrays and exact selection limits, rejecting overflow and new unknowns', () => {
    expect(validatePreferences(preferences).style_tags).toEqual([]);
    expect(validatePreferences({ ...preferences, style_tags: Array.from({ length: 8 }, (_, n) => `私の ${n}`), preferred_colours: colours.slice(0, 8), excluded_categories: [...categories] })).toBeTruthy();
    for (const key of ['style_tags', 'preferred_colours', 'excluded_categories'] as const) {
      expect(() => validatePreferences({ ...preferences, [key]: Array(9).fill('green') })).toThrow();
      expect(() => validatePreferences({ ...preferences, [key]: ['green', 'green'] })).toThrow();
    }
    expect(() => validatePreferences({ ...preferences, preferred_colours: ['unknown-id'] })).toThrow();
    expect(() => validatePreferences({ ...preferences, excluded_categories: ['unknown-id'] })).toThrow();
  });
  it('preserves persisted unknown, duplicate and longer private values without truncation', () => {
    const baseline = { ...preferences, style_tags: ['é'.repeat(90), 'same', 'same'], preferred_colours: ['custom'], excluded_categories: ['custom'] };
    expect(validatePreferences(baseline, baseline)).toMatchObject({ style_tags: baseline.style_tags, preferred_colours: ['custom'], excluded_categories: ['custom'] });
    expect(parsePreferences(baseline, owner)).toEqual(baseline);
    expect(() => validatePreferences({ ...baseline, style_tags: [...baseline.style_tags, 'same'] }, baseline)).toThrow();
    expect(() => validatePreferences({ ...preferences, style_tags: ['é'.repeat(41)] })).toThrow();
  });
  it.each([
    ['minimum_upper_coverage', 0, 2], ['minimum_lower_coverage', 0, 2],
    ['cold_sensitivity', -2, 2], ['repeat_gap_days', 0, 14],
  ] as const)('validates integer bounds for %s', (key, min, max) => {
    for (const value of [min, max]) expect(validatePreferences({ ...preferences, [key]: value })[key]).toBe(value);
    for (const value of [min - 1, max + 1, 0.5, NaN, Infinity, '1', null]) expect(() => validatePreferences({ ...preferences, [key]: value })).toThrow();
  });
  it('rejects foreign rows, missing preferences and invalid versions', () => {
    for (const value of [null, {}, { ...preferences, owner_id: 'other' }, { ...preferences, version: 0 }]) expect(() => parsePreferences(value, owner)).toThrow();
    for (const version of [0, -1, NaN, 0.5]) expect(() => parseProfile({ ...profile, version }, owner)).toThrow();
  });
});
describe('versioned per-row PATCH contracts', () => {
  it('sends only profile fields and uses owner, version, scope signal and returned row', async () => {
    const row = { ...profile, display_name: 'Returned', version: 5 };
    const api = backend({ data: row });
    const current = scope();
    expect(await updateProfile(api.client, current, profile, { kind: 'profile', fields: profile })).toEqual(row);
    expect(api.calls).toContainEqual(['update', profileFields(profile)]);
    expect(api.calls).toContainEqual(['eq', 'owner_id', owner]);
    expect(api.calls).toContainEqual(['eq', 'version', 4]);
    expect(api.calls).toContainEqual(['abortSignal', current.signal]);
    expect(api.single).toHaveBeenCalledTimes(1);
  });
  it('language PATCH is language only', async () => {
    const api = backend({ data: { ...profile, ui_language: 'sv', version: 5 } });
    await updateProfile(api.client, scope(), profile, { kind: 'language', language: 'sv' });
    expect(api.calls).toContainEqual(['update', { ui_language: 'sv' }]);
  });
  it('preference PATCH never sends identity/version or other profile fields', async () => {
    const api = backend({ data: { ...preferences, version: 4 } });
    await savePreferences(api.client, scope(), preferences, preferences);
    const body = api.calls.find(([name]) => name === 'update')?.[1];
    expect(Object.keys(body as object).sort()).toEqual(['cold_sensitivity', 'excluded_categories', 'minimum_lower_coverage', 'minimum_upper_coverage', 'preferred_colours', 'repeat_gap_days', 'style_tags']);
  });
  it.each(['profile', 'preferences'] as const)('%s empty update rereads exactly once, never retries or upserts', async (kind) => {
    const row = kind === 'profile' ? profile : preferences;
    for (const [data, message] of [[{ ...row, version: 99 }, 'error.conflict'], [row, 'error.unavailable'], [null, kind === 'profile' ? 'account.locked' : 'settings.preferencesUnavailable']] as const) {
      const api = backend({ data: null }, { data });
      const result = kind === 'profile'
        ? updateProfile(api.client, scope(), profile, { kind: 'profile', fields: profile })
        : savePreferences(api.client, scope(), preferences, preferences);
      await expect(result).rejects.toThrow(message);
      expect(api.single).toHaveBeenCalledTimes(2);
      expect(api.calls.filter(([name]) => name === 'update')).toHaveLength(1);
    }
  });
  it('localizes only the known Postgres timezone error and never raw upstream text', async () => {
    const api = backend({ data: null, error: { code: 'P0001', message: 'Invalid timezone' } });
    await expect(updateProfile(api.client, scope(), profile, { kind: 'profile', fields: profile })).rejects.toThrow('settings.serverTimezone');
    const other = backend({ data: null, error: { code: 'P0001', message: 'Private upstream value' } });
    await expect(updateProfile(other.client, scope(), profile, { kind: 'profile', fields: profile })).rejects.toThrow('error.unavailable');
  });
  it('refuses foreign baselines and aborted work before requests', async () => {
    const api = backend();
    await expect(savePreferences(api.client, scope(), { ...preferences, owner_id: 'other' }, preferences)).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(updateProfile(api.client, { ...scope(), signal: abort.signal }, profile, { kind: 'profile', fields: profile })).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
});
