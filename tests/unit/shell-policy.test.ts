import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import viteConfig, { finalizeShell } from '../../vite.config';
import { headersFor, parseHeaders } from '../../scripts/serve-dist.mjs';
import {
  artifactUrl, isExcludedArtifact, isShellArtifact, joinShellUrls, parsePrecacheManifest, routeRequest, shellCacheName, splitShellUrls, workerPath,
} from '../../src/pwa/shell-policy';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const buildId = 'a'.repeat(20);
const entry = (url: string, text = url) => ({ url, sha256: sha(text), bytes: text.length });
const manifest = (files: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, buildId, files, ...extra });

describe('shell artifact classification', () => {
  it('accepts only the public shell and excludes control, map, manifest and worker files', () => {
    for (const file of ['index.html', 'manifest.webmanifest', 'assets/index-Bfi6nLlj.js', 'assets/index-AbCdEf12.css', 'icon.svg', 'icon-192.png', 'apple-touch-icon.png']) {
      expect(isShellArtifact(file), file).toBe(true);
    }
    for (const file of ['_headers', '_redirects', 'precache-manifest.json', 'service-worker.js', 'assets/index-Bfi6nLlj.js.map', 'assets/index.js', 'assets/x-Bfi6nLlj.json', 'robots.txt', '../index.html']) {
      expect(isShellArtifact(file), file).toBe(false);
    }
    for (const file of ['_headers', '_redirects', 'precache-manifest.json', 'service-worker.js', 'assets/index-Bfi6nLlj.js.map']) {
      expect(isExcludedArtifact(file), file).toBe(true);
    }
    expect(isExcludedArtifact('robots.txt')).toBe(false);
    expect(artifactUrl('index.html')).toBe('/');
    expect(artifactUrl('assets/a-12345678.js')).toBe('/assets/a-12345678.js');
    expect(shellCacheName(buildId)).toBe(`stillroom-shell-${buildId}`);
  });

  it('keeps the worker URL in the registration code equal to the policy path', async () => {
    const source = await readFile(path.resolve('src/pwa/register.ts'), 'utf8');
    expect(/const workerUrl = '([^']+)';/.exec(source)?.[1]).toBe(workerPath);
  });
});

describe('precache manifest parsing', () => {
  const good = [entry('/'), entry('/assets/index-Bfi6nLlj.js')];

  it('accepts a well-formed manifest for the expected build', () => {
    expect(parsePrecacheManifest(manifest(good), buildId).files.map((file) => file.url)).toEqual(['/', '/assets/index-Bfi6nLlj.js']);
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['another build', manifest(good, { buildId: 'b'.repeat(20) })],
    ['an extra key', manifest(good, { extra: true })],
    ['another version', manifest(good, { version: 2 })],
    ['no files', manifest([])],
    ['no shell entry', manifest([entry('/assets/index-Bfi6nLlj.js')])],
    ['/index.html instead of /', manifest([entry('/index.html'), entry('/')])],
    ['a control file', manifest([...good, entry('/_headers')])],
    ['the manifest itself', manifest([...good, entry('/precache-manifest.json')])],
    ['the worker', manifest([...good, entry('/service-worker.js')])],
    ['a traversal', manifest([...good, entry('/../secret.js')])],
    ['a cross-origin URL', manifest([...good, entry('https://example.test/assets/index-Bfi6nLlj.js')])],
    ['a duplicate', manifest([...good, entry('/')])],
    ['a short digest', manifest([{ ...entry('/'), sha256: 'ab' }])],
    ['an upper-case digest', manifest([{ ...entry('/'), sha256: sha('/').toUpperCase() }])],
    ['zero bytes', manifest([{ ...entry('/'), bytes: 0 }])],
    ['fractional bytes', manifest([{ ...entry('/'), bytes: 1.5 }])],
    ['an extra entry key', manifest([{ ...entry('/'), headers: {} }])],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePrecacheManifest(value, buildId)).toThrow('Invalid precache manifest');
  });

  it('rejects a malformed expected build id', () => {
    expect(() => parsePrecacheManifest({ ...manifest(good), buildId: 'short' }, 'short')).toThrow();
  });
});

describe('worker routing', () => {
  const origin = 'https://app.example.test';
  const files = new Set(['/', '/assets/index-Bfi6nLlj.js', '/assets/index-AbCdEf12.css', '/icon-192.png', '/manifest.webmanifest']);
  const route = (path: string, mode = 'no-cors', destination = '', method = 'GET') => routeRequest({ method, url: path.startsWith('http') ? path : `${origin}${path}`, mode, destination }, origin, files);
  const navigate = (path: string) => route(path, 'navigate', 'document');

  it('answers only `/` document navigations with the shell, with or without a query', () => {
    expect(navigate('/')).toBe('shell');
    expect(navigate('/?code=synthetic')).toBe('shell');
    for (const path of ['/rest/v1/items', '/auth/v1/verify?token=synthetic', '/storage/v1/object/sign/wardrobe/a.jpg?token=x', '/functions/v1/analyze-clothing',
      '/_headers', '/index.html', '/settings', '/assets/index-Bfi6nLlj.js', '/precache-manifest.json', '/service-worker.js']) {
      expect(navigate(path), path).toBeNull();
    }
    expect(route('/', 'navigate', 'iframe')).toBeNull();
    expect(route('https://other.example.test/', 'navigate', 'document')).toBeNull();
    expect(route('/', 'navigate', 'document', 'POST')).toBeNull();
  });

  it('answers only exact verified files, without a query, for their own request destination', () => {
    expect(route('/assets/index-Bfi6nLlj.js', 'cors', 'script')).toBe('file');
    expect(route('/assets/index-AbCdEf12.css', 'no-cors', 'style')).toBe('file');
    expect(route('/icon-192.png', 'no-cors', 'image')).toBe('file');
    expect(route('/manifest.webmanifest', 'cors', 'manifest')).toBe('file');
    expect(route('/assets/index-Bfi6nLlj.js', 'cors', '')).toBeNull();
    expect(route('/assets/index-Bfi6nLlj.js', 'cors', 'style')).toBeNull();
    expect(route('/assets/index-Bfi6nLlj.js?x=1', 'cors', 'script')).toBeNull();
    expect(route('/assets/other-Bfi6nLlj.js', 'cors', 'script')).toBeNull();
    expect(route('/', 'cors', '')).toBeNull();
    for (const path of ['/rest/v1/items', '/_headers', '/precache-manifest.json', '/service-worker.js']) expect(route(path, 'cors', ''), path).toBeNull();
    expect(route('https://backend.example.test/assets/index-Bfi6nLlj.js', 'cors', 'script')).toBeNull();
    expect(route('/assets/index-Bfi6nLlj.js', 'cors', 'script', 'HEAD')).toBeNull();
  });

  it('round-trips the stamped URL list', () => {
    expect(splitShellUrls(joinShellUrls([...files]))).toEqual([...files]);
  });
});
describe('emitted headers and the test host', () => {
  async function emittedHeaders() {
    const config = await (viteConfig as (env: { mode: string; command: 'build' }) => Promise<{ plugins: Plugin[] }> | { plugins: Plugin[] })({ mode: 'test', command: 'build' });
    const plugin = config.plugins.flat().find((item) => item && (item as Plugin).name === 'private-app-headers') as Plugin;
    let source = '';
    (plugin.generateBundle as unknown as (this: { emitFile: (file: { source: string }) => void }) => void).call({ emitFile: (file) => { source = file.source; } });
    return parseHeaders(source);
  }

  it('never lets the worker, the manifest or the shell be cached by the browser, and keeps assets immutable', async () => {
    const rules = await emittedHeaders();
    for (const pathname of ['/', '/index.html', '/service-worker.js', '/precache-manifest.json']) {
      expect(headersFor(rules, pathname).get('Cache-Control'), pathname).toBe('no-cache');
    }
    expect(headersFor(rules, '/assets/index-Bfi6nLlj.js').get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(headersFor(rules, '/service-worker.js').get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('joins a header set by several matching rules, as Pages does, and rejects malformed files', () => {
    const rules = parseHeaders('/*\n  X-Test: one\n/a\n  X-Test: two\n  Other: yes\n');
    expect(headersFor(rules, '/a').get('X-Test')).toBe('one, two');
    expect(headersFor(rules, '/b').get('X-Test')).toBe('one');
    expect(headersFor(rules, '/b').has('Other')).toBe(false);
    expect(() => parseHeaders('  X-Test: orphan\n')).toThrow();
    expect(() => parseHeaders('not-a-path\n  X-Test: one\n')).toThrow();
  });
});

describe('build finalization', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  async function dist(files: Record<string, string>) {
    dir = await mkdtemp(path.join(tmpdir(), 'stillroom-shell-'));
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return dir;
  }
  const worker = "self.a='__STILLROOM_BUILD_ID__';self.b='__STILLROOM_MANIFEST_SHA256__';self.c='__STILLROOM_SHELL_URLS__';";

  it('writes a manifest of shell files only and stamps the worker with its digest', async () => {
    const root = await dist({ 'index.html': '<html>', 'assets/index-Bfi6nLlj.js': 'js', 'assets/index-Bfi6nLlj.js.map': 'map', '_headers': '/*', 'service-worker.js': worker });
    const result = await finalizeShell(root, false);
    const text = await readFile(path.join(root, 'precache-manifest.json'), 'utf8');
    expect(result.files).toEqual(['/', '/assets/index-Bfi6nLlj.js']);
    expect(result.manifestSha256).toBe(sha(text));
    expect(parsePrecacheManifest(JSON.parse(text), result.buildId).files).toEqual([entry('/', '<html>'), entry('/assets/index-Bfi6nLlj.js', 'js')]);
    expect(await readFile(path.join(root, 'service-worker.js'), 'utf8')).toBe(`self.a='${result.buildId}';self.b='${result.manifestSha256}';self.c='/,/assets/index-Bfi6nLlj.js';`);
  });

  it('changes the build id when any shell byte changes', async () => {
    const first = await finalizeShell(await dist({ 'index.html': 'a', 'service-worker.js': worker }), false);
    await rm(dir, { recursive: true, force: true });
    const second = await finalizeShell(await dist({ 'index.html': 'b', 'service-worker.js': worker }), false);
    expect(first.buildId).not.toBe(second.buildId);
  });

  it('gives a worker-only change its own release ID and cache', async () => {
    const first = await finalizeShell(await dist({ 'index.html': 'a', 'service-worker.js': worker }), false);
    await rm(dir, { recursive: true, force: true });
    const second = await finalizeShell(await dist({ 'index.html': 'a', 'service-worker.js': `${worker}/* next */` }), false);
    expect(second.files).toEqual(first.files);
    expect(shellCacheName(second.buildId)).not.toBe(shellCacheName(first.buildId));
  });
  it.each([
    ['an unclassified file', { 'index.html': 'a', 'robots.txt': 'x', 'service-worker.js': worker }, 'not classified'],
    ['a worker with imports', { 'index.html': 'a', 'service-worker.js': `import './x.js';${worker}` }, 'single classic script'],
    ['a worker with a dynamic import', { 'index.html': 'a', 'service-worker.js': `import('./x.js');${worker}` }, 'single classic script'],
    ['a worker without placeholders', { 'index.html': 'a', 'service-worker.js': 'self.a=1;' }, 'placeholders'],
    ['a worker with repeated placeholders', { 'index.html': 'a', 'service-worker.js': worker + worker }, 'placeholders'],
    ['no shell page', { 'assets/index-Bfi6nLlj.js': 'js', 'service-worker.js': worker }, 'Invalid precache manifest'],
  ])('fails the build for %s', async (_name, files, message) => {
    await expect(finalizeShell(await dist(files), false)).rejects.toThrow(message);
  });

  it('leaves the kill-switch worker unstamped', async () => {
    const root = await dist({ 'index.html': 'a', 'service-worker.js': 'self.k=1;' });
    await finalizeShell(root, true);
    expect(await readFile(path.join(root, 'service-worker.js'), 'utf8')).toBe('self.k=1;');
  });
});
