import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contentTypeFor, headersFor, parseHeaders, startDistServer, type DistServer } from '../../scripts/serve-dist.mjs';
import { artifactBytes, builds, readManifest, type BuildName } from './builds';
import { modelAssets, modelCacheName } from '../../src/images/background/model-assets';

export type { DistServer };
export const serve = (name: BuildName): Promise<DistServer> => startDistServer({ root: builds[name] });
export const cacheName = (name: BuildName) => `stillroom-shell-${readManifest(name).buildId}`;
const keptHeaders = new Set(['content-type', 'content-security-policy', 'referrer-policy', 'x-content-type-options', 'permissions-policy']);

// Waits until this page is controlled by an activated worker and returns its build's cache name.
export async function controlled(page: Page) {
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    return (await caches.keys()).filter((name) => name.startsWith('stillroom-shell-'));
  });
}

export async function updateAndSettle(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('No registration');
    await registration.update();
    const worker = registration.installing;
    if (worker) {
      await new Promise<void>((resolve) => {
        const done = () => { if (worker.state === 'installed' || worker.state === 'activated' || worker.state === 'redundant') resolve(); };
        worker.addEventListener('statechange', done);
        done();
      });
    }
    return { waiting: Boolean(registration.waiting), state: worker?.state ?? null };
  });
}

// The public headers the host sends for a build file, limited to the ones the worker keeps, by value.
export function expectedHeaders(name: BuildName, pathname: string) {
  const rules = parseHeaders(readFileSync(path.join(builds[name], '_headers'), 'utf8'));
  const expected: Record<string, string> = { 'content-type': contentTypeFor(pathname === '/' ? 'index.html' : pathname) };
  for (const [header, value] of headersFor(rules, pathname)) if (keptHeaders.has(header.toLowerCase())) expected[header.toLowerCase()] = value;
  return expected;
}

// Every cache entry must be a public file of the given build, byte for byte, with only public headers. With
// `models`, the background-removal cache may also exist and must hold exactly the verified inventory files.
// Model entries are measured and hashed in the page: returning their ~19 MB as number arrays took about two minutes.
export async function expectOnlyShell(page: Page, name: BuildName, privateMarkers: string[] = [], models = false) {
  const snapshot = await page.evaluate(async (modelCache) => {
    const result: Array<{ cache: string; url: string; headers: Array<[string, string]>; bytes: number[]; length: number; sha256: string }> = [];
    for (const cache of await caches.keys()) {
      const open = await caches.open(cache);
      for (const request of await open.keys()) {
        const response = await open.match(request);
        const buffer = await response!.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const bytes = cache === modelCache ? [] : [...new Uint8Array(buffer)];
        result.push({ cache, url: request.url, headers: [...response!.headers], bytes, length: buffer.byteLength, sha256: digest });
      }
    }
    return result;
  }, modelCacheName);
  const manifest = readManifest(name);
  for (const file of manifest.files) {
    const text = artifactBytes(name, file.url).toString('latin1');
    for (const marker of privateMarkers) if (text.includes(marker)) throw new Error(`Marker is public in ${file.url}`);
  }
  const origin = new URL(page.url()).origin;
  const modelEntries = snapshot.filter((entry) => entry.cache === modelCacheName);
  if (models) {
    expect(modelEntries.map((entry) => entry.url).sort()).toEqual(modelAssets.map((file) => `${origin}${file.path}`).sort());
    for (const entry of modelEntries) {
      const file = modelAssets.find((asset) => `${origin}${asset.path}` === entry.url)!;
      expect(entry.length, file.path).toBe(file.bytes);
      expect(entry.sha256, file.path).toBe(file.sha256);
    }
    snapshot.splice(0, snapshot.length, ...snapshot.filter((entry) => entry.cache !== modelCacheName));
  }
  expect(new Set(snapshot.map((entry) => entry.cache))).toEqual(new Set([cacheName(name)]));
  expect(snapshot.map((entry) => entry.url).sort()).toEqual(manifest.files.map((file) => `${origin}${file.url}`).sort());
  for (const entry of snapshot) {
    const url = new URL(entry.url);
    const bytes = Buffer.from(entry.bytes);
    expect(url.search + url.hash).toBe('');
    expect(bytes.equals(artifactBytes(name, url.pathname)), url.pathname).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.files.find((file) => file.url === url.pathname)?.sha256);
    expect(Object.fromEntries(entry.headers.map(([header, value]) => [header.toLowerCase(), value])), url.pathname).toEqual(expectedHeaders(name, url.pathname));
    const text = bytes.toString('latin1');
    for (const marker of privateMarkers) expect(text.includes(marker), `${url.pathname} contains private data`).toBe(false);
  }
}

// The entry scripts the page actually loaded, and the ones a build's index.html names.
export const loadedScripts = (page: Page) => page.evaluate(() => [...document.querySelectorAll('script[src]')].map((script) => new URL((script as HTMLScriptElement).src).pathname));
export const entryScripts = (name: BuildName) => [...artifactBytes(name, '/').toString('utf8').matchAll(/src="(\/assets\/[^"]+)"/g)].map((match) => match[1]);