import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCatalogues, catalogueLanguages, descriptorSource, readCatalogues } from '../../scripts/i18n-catalogues.mjs';
import baseMessages from '../../src/i18n/messages.json' with { type: 'json' };
import phaseZeroMessages from '../../src/i18n/phase-zero.json' with { type: 'json' };
import { languages, messages, type CatalogueTable, type Language } from '../../src/i18n/all';
import { bootMessages } from '../../src/i18n/boot';
import { initialDisplay, requestCurrent, requestDisplay, settleDisplay } from '../../src/i18n/display-language';
import { createCatalogueLoader, fetchCatalogue, maxCatalogueBytes, parseCatalogue, type CatalogueDescriptor } from '../../src/i18n/load';
import { isShellArtifact } from '../../src/pwa/shell-policy';
import { ENHANCE_NOTICE_KEYS } from '../../src/features/settings/enhance-store';

const built = readCatalogues();
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const descriptor: CatalogueDescriptor = {
  urls: { en: `/${built.catalogues.en.fileName}`, fi: `/${built.catalogues.fi.fileName}`, sv: `/${built.catalogues.sv.fileName}` },
  digests: { en: built.catalogues.en.sha256, fi: built.catalogues.fi.sha256, sv: built.catalogues.sv.sha256 },
  keyCount: built.keyCount,
};
const json = (body: string, init: { status?: number; type?: string; length?: string } = {}) => new Response(body, {
  status: init.status ?? 200,
  headers: { 'content-type': init.type ?? 'application/json; charset=utf-8', ...(init.length ? { 'content-length': init.length } : {}) },
});
const digest = (bytes: Uint8Array) => Promise.resolve(sha(bytes));
const serving = (body: string, init?: Parameters<typeof json>[1]) => ({ fetch: vi.fn(() => Promise.resolve(json(body, init))), digest });
const withDigest = (language: Language, body: string): CatalogueDescriptor => ({ ...descriptor, digests: { ...descriptor.digests, [language]: sha(body) } });

describe('generated startup catalogues', () => {
  it('are deterministic, one public JSON file per language with a matching shell name and full digest', () => {
    const again = buildCatalogues([baseMessages, phaseZeroMessages]);
    expect(again).toEqual(built);
    expect(catalogueLanguages).toEqual([...languages]);
    for (const language of languages) {
      const entry = built.catalogues[language];
      expect(entry.fileName).toMatch(new RegExp(`^assets/catalogue-${language}-[A-Za-z0-9_-]{8}\\.json$`));
      expect(isShellArtifact(entry.fileName), entry.fileName).toBe(true);
      expect(entry.sha256).toBe(sha(entry.source));
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(languages.map((language) => built.catalogues[language].fileName)).size).toBe(3);
  });

  it('carry every startup key with byte-identical text, including the pinned consent notices', () => {
    const startup = { ...baseMessages, ...phaseZeroMessages } as Record<string, Record<Language, string>>;
    expect(built.keyCount).toBe(Object.keys(startup).length);
    for (const language of languages) {
      const table = JSON.parse(built.catalogues[language].source) as Record<string, string>;
      expect(Object.keys(table)).toEqual(Object.keys(startup));
      for (const [key, entry] of Object.entries(startup)) expect(table[key], `${language} ${key}`).toBe(entry[language]);
      for (const key of ENHANCE_NOTICE_KEYS) expect(table[key]).toBe(messages[key][language]);
    }
  });

  it('refuse a source with a missing or empty translation', () => {
    expect(() => buildCatalogues([{ 'a.b': { en: 'A', fi: 'A', sv: '' } }])).toThrow('Catalogue sv is missing a.b.');
    expect(() => buildCatalogues([{ 'a.b': { en: 'A', fi: 'A' } }])).toThrow('Catalogue sv is missing a.b.');
  });

  it('describe the release in the build-generated descriptor', () => {
    const source = descriptorSource(built);
    for (const language of languages) {
      expect(source).toContain(`"${language}":"/${built.catalogues[language].fileName}"`);
      expect(source).toContain(`"${language}":"${built.catalogues[language].sha256}"`);
    }
    expect(source).toContain(`export const catalogueKeyCount = ${built.keyCount};`);
  });

  it('keep the eager boot text equal to the catalogue text', () => {
    for (const [key, entry] of Object.entries(bootMessages)) {
      for (const language of languages) expect(entry[language], `${language} ${key}`).toBe(messages[key as keyof typeof messages][language]);
    }
  });
});

describe('catalogue loading', () => {
  const en = built.catalogues.en.source;

  it('installs a verified catalogue as a frozen table from its canonical URL', async () => {
    const dependencies = serving(en);
    const table = await fetchCatalogue('en', descriptor, dependencies);
    expect(dependencies.fetch).toHaveBeenCalledWith(descriptor.urls.en, { credentials: 'same-origin', mode: 'same-origin' });
    expect(Object.isFrozen(table)).toBe(true);
    expect(table['common.retry']).toBe('Try again');
  });

  it.each([
    ['a failed response', () => json(en, { status: 404 })],
    ['an HTML response', () => json(en, { type: 'text/html' })],
    ['a JSON-like MIME', () => json(en, { type: 'application/jsonp' })],
    ['a declared oversize body', () => json(en, { length: String(maxCatalogueBytes + 1) })],
    ['a streamed oversize body', () => json('x'.repeat(maxCatalogueBytes + 1))],
  ])('rejects %s', async (_name, response) => {
    await expect(fetchCatalogue('en', descriptor, { fetch: () => Promise.resolve(response()), digest })).rejects.toThrow();
  });

  it('rejects bytes the release did not name: a substituted key, another language or altered consent text', async () => {
    const table = JSON.parse(en) as Record<string, string>;
    const [first] = Object.keys(table);
    const substituted = JSON.stringify(Object.fromEntries(Object.entries(table).map(([key, text]) => [key === first ? 'common.substituted' : key, text])));
    expect(() => parseCatalogue(substituted, built.keyCount)).not.toThrow();
    const altered = JSON.stringify({ ...table, [ENHANCE_NOTICE_KEYS[0]]: `${table[ENHANCE_NOTICE_KEYS[0]]} ` });
    for (const body of [substituted, built.catalogues.fi.source, altered]) {
      await expect(fetchCatalogue('en', descriptor, serving(body))).rejects.toThrow('Catalogue digest.');
    }
    await expect(fetchCatalogue('en', { ...descriptor, digests: { ...descriptor.digests, en: '0'.repeat(64) } }, serving(en))).rejects.toThrow('Catalogue digest.');
  });

  it.each([
    ['non-JSON', 'not json'],
    ['an array', '[]'],
    ['too few keys', JSON.stringify({ a: 'A' })],
    ['an empty value', JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(en) as object).map((key, index) => [key, index === 0 ? '' : 'x'])))],
    ['a non-string value', JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(en) as object).map((key, index) => [key, index === 0 ? 1 : 'x'])))],
  ])('rejects a digest-matching but malformed body: %s', async (_name, body) => {
    await expect(fetchCatalogue('en', withDigest('en', body), serving(body))).rejects.toThrow();
  });

  it('shares one in-flight load, drops a failure and retries the same canonical URL', async () => {
    const tables: Partial<Record<Language, CatalogueTable>> = {};
    let fail = true;
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => {
      if (fail) { fail = false; return Promise.reject(new TypeError('offline')); }
      return Promise.resolve(json(built.catalogues.fi.source));
    });
    const load = createCatalogueLoader(descriptor, { fetch, digest, install: (language, table) => { tables[language] = table; }, loaded: (language) => tables[language] !== undefined });
    const [first, second] = [load('fi'), load('fi')];
    expect(first).toBe(second);
    await expect(first).rejects.toThrow('offline');
    expect(tables.fi).toBeUndefined();
    await load('fi');
    expect(tables.fi?.['common.retry']).toBe('Yritä uudelleen');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([descriptor.urls.fi, descriptor.urls.fi]);
    expect(String(fetch.mock.calls[1]![0])).not.toContain('?');
    await load('fi');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('display language', () => {
  const loaded = (set: Language[]) => (language: Language) => set.includes(language);

  it('shows a requested language only once its catalogue is installed', () => {
    expect(initialDisplay('fi', loaded(['en']))).toEqual({ requested: 'fi', shown: 'en', failed: null });
    expect(initialDisplay('sv', loaded(['sv']))).toEqual({ requested: 'sv', shown: 'sv', failed: null });
    const waiting = requestDisplay({ requested: 'en', shown: 'en', failed: null }, 'fi', loaded(['en']));
    expect(waiting).toEqual({ requested: 'fi', shown: 'en', failed: null });
    expect(settleDisplay(waiting, 'fi', true)).toEqual({ requested: 'fi', shown: 'fi', failed: null });
    expect(settleDisplay(waiting, 'fi', false)).toEqual({ requested: 'fi', shown: 'en', failed: 'fi' });
  });

  it('lets only the latest request switch, so rapid choices never land out of order', () => {
    const one = requestDisplay({ requested: 'en', shown: 'en', failed: null }, 'fi', loaded(['en']));
    const two = requestDisplay(one, 'sv', loaded(['en']));
    expect(settleDisplay(two, 'fi', true)).toBe(two);
    expect(settleDisplay(two, 'fi', false)).toBe(two);
    expect(settleDisplay(two, 'sv', true).shown).toBe('sv');
    expect(requestDisplay(two, 'en', loaded(['en']))).toEqual({ requested: 'en', shown: 'en', failed: null });
  });

  it('applies a chooser result only for the latest request, in the same entry context, while mounted', () => {
    const context = {};
    const request = { token: 3, context };
    expect(requestCurrent(request, { token: 3, context, mounted: true })).toBe(true);
    expect(requestCurrent(request, { token: 4, context, mounted: true })).toBe(false);
    expect(requestCurrent(request, { token: 3, context: {}, mounted: true })).toBe(false);
    expect(requestCurrent(request, { token: 3, context, mounted: false })).toBe(false);
  });
});

describe('translation store', () => {
  it('has no fallback for a language that is not loaded, and none of the catalogue text', async () => {
    vi.resetModules();
    const fresh = await import('../../src/i18n/index');
    expect(fresh.catalogueLoaded('en')).toBe(false);
    expect(() => fresh.translate('fi', 'common.retry')).toThrow('The fi catalogue is not loaded.');
    fresh.installCatalogue('en', JSON.parse(built.catalogues.en.source) as CatalogueTable);
    expect(fresh.translate('en', 'common.retry')).toBe('Try again');
    expect(() => fresh.translate('fi', 'common.retry')).toThrow('The fi catalogue is not loaded.');
    vi.resetModules();
  });

  it('keeps the catalogue text out of the app modules', () => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.resolve('src'));
    const relative = (file: string) => path.relative(path.resolve('src'), file).split(path.sep).join('/');
    for (const file of files) {
      const name = relative(file);
      const source = readFileSync(file, 'utf8');
      if (name !== 'i18n/all.ts') {
        expect(source, name).not.toMatch(/from ['"][^'"]*i18n\/all['"]|from ['"]\.\/all['"]/);
        expect(source, name).not.toMatch(/^import (?!type )[^;]*(?:messages|phase-zero)\.json/m);
      }
      if (name !== 'i18n/tryon.ts' && name !== 'i18n/all.ts') expect(source, name).not.toMatch(/^import (?!type )[^;]*tryon\.json/m);
    }
    const index = readFileSync(path.resolve('src/i18n/index.ts'), 'utf8');
    expect(index).not.toContain('virtual:');
    expect(index).not.toMatch(/from '\.\/load'/);
  });
});
