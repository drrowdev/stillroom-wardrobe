// LANG1: the startup catalogues (messages.json + phase-zero.json) split into one public JSON file per language.
// The app fetches only the active language; the service worker precaches all three (shell-policy catalogueFile).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const catalogueLanguages = ['en', 'fi', 'sv'];
export const catalogueSources = ['src/i18n/messages.json', 'src/i18n/phase-zero.json'];
export const virtualId = 'virtual:stillroom-catalogues';
const resolvedVirtualId = `\0${virtualId}`;

/** Pure: one `{ key: text }` table per language, keys in source order, and each file's name and digest. */
export function buildCatalogues(sources) {
  const merged = Object.assign({}, ...sources);
  const keys = Object.keys(merged);
  const catalogues = {};
  for (const language of catalogueLanguages) {
    const table = {};
    for (const key of keys) {
      const text = merged[key]?.[language];
      if (typeof text !== 'string' || text === '') throw new Error(`Catalogue ${language} is missing ${key}.`);
      table[key] = text;
    }
    const source = JSON.stringify(table);
    const digest = createHash('sha256').update(source).digest();
    const hash8 = digest.toString('base64url').slice(0, 8);
    catalogues[language] = { fileName: `assets/catalogue-${language}-${hash8}.json`, source, sha256: digest.toString('hex') };
  }
  return { keyCount: keys.length, catalogues };
}

export function readCatalogues(root = process.cwd()) {
  return buildCatalogues(catalogueSources.map((file) => JSON.parse(readFileSync(path.resolve(root, file), 'utf8'))));
}

export function descriptorSource({ keyCount, catalogues }) {
  const pick = (field) => JSON.stringify(Object.fromEntries(catalogueLanguages.map((language) => [language, field(catalogues[language])])));
  return [
    `export const catalogueUrls = ${pick((entry) => `/${entry.fileName}`)};`,
    `export const catalogueDigests = ${pick((entry) => entry.sha256)};`,
    `export const catalogueKeyCount = ${keyCount};`,
    '',
  ].join('\n');
}

/** The Vite plugin: the descriptor module, the emitted files (build) and the same paths (dev server). */
export function cataloguePlugin({ emit = true } = {}) {
  let root = process.cwd();
  return {
    name: 'stillroom-catalogues',
    configResolved(config) { root = config.root; },
    resolveId(id) { return id === virtualId ? resolvedVirtualId : null; },
    load(id) {
      if (id !== resolvedVirtualId) return null;
      for (const file of catalogueSources) this.addWatchFile(path.resolve(root, file));
      return descriptorSource(readCatalogues(root));
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '').split('?')[0];
        if (!pathname.startsWith('/assets/catalogue-')) { next(); return; }
        const entry = Object.values(readCatalogues(root).catalogues).find((candidate) => `/${candidate.fileName}` === pathname);
        if (!entry) { next(); return; }
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-cache');
        response.end(entry.source);
      });
    },
    generateBundle() {
      if (!emit) return;
      for (const entry of Object.values(readCatalogues(root).catalogues)) {
        this.emitFile({ type: 'asset', fileName: entry.fileName, source: entry.source });
      }
    },
  };
}
