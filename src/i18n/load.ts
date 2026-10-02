import { catalogueDigests, catalogueKeyCount, catalogueUrls } from 'virtual:stillroom-catalogues';
import { catalogueLoaded, installCatalogue, type CatalogueTable, type Language } from './index';

// LANG1: fetches one language's startup catalogue as public JSON data, never as code. A retry is a plain new fetch of
// the same canonical URL: a controlled page is answered from its own release's verified cache (offline too).
export const maxCatalogueBytes = 256 * 1024;
export type CatalogueDescriptor = {
  urls: Readonly<Record<Language, string>>;
  digests: Readonly<Record<Language, string>>;
  keyCount: number;
};
export type LoaderDependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  digest: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  install: (language: Language, table: CatalogueTable) => void;
  loaded: (language: Language) => boolean;
};

async function readBounded(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxCatalogueBytes) throw new Error('Catalogue too large.');
  if (!response.body) throw new Error('Catalogue body missing.');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxCatalogueBytes) { await reader.cancel(); throw new Error('Catalogue too large.'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export function parseCatalogue(text: string, keyCount: number): CatalogueTable {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid catalogue.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== keyCount || entries.some(([, text]) => typeof text !== 'string' || text === '')) throw new Error('Invalid catalogue.');
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

export async function fetchCatalogue(language: Language, descriptor: CatalogueDescriptor, dependencies: Pick<LoaderDependencies, 'fetch' | 'digest'>): Promise<CatalogueTable> {
  const response = await dependencies.fetch(descriptor.urls[language], { credentials: 'same-origin', mode: 'same-origin' });
  if (!response.ok) throw new Error('Catalogue unavailable.');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Catalogue type.');
  const bytes = await readBounded(response);
  // The release's own descriptor names the exact bytes: a substituted, altered or other-language file is refused.
  if (await dependencies.digest(bytes) !== descriptor.digests[language]) throw new Error('Catalogue digest.');
  return parseCatalogue(new TextDecoder('utf-8', { fatal: true }).decode(bytes), descriptor.keyCount);
}

/** One in-flight load per language; a failure is dropped so the next attempt fetches again. */
export function createCatalogueLoader(descriptor: CatalogueDescriptor, dependencies: LoaderDependencies): (language: Language) => Promise<void> {
  const inflight = new Map<Language, Promise<void>>();
  return (language) => {
    if (dependencies.loaded(language)) return Promise.resolve();
    const pending = inflight.get(language);
    if (pending) return pending;
    const load = fetchCatalogue(language, descriptor, dependencies)
      .then((table) => { dependencies.install(language, table); })
      .finally(() => { inflight.delete(language); });
    inflight.set(language, load);
    return load;
  };
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
export const ensureCatalogue = createCatalogueLoader(
  { urls: catalogueUrls, digests: catalogueDigests, keyCount: catalogueKeyCount },
  {
    fetch: (url, init) => fetch(url, init),
    digest: async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes)),
    install: installCatalogue,
    loaded: catalogueLoaded,
  },
);