import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { entryAssets, evaluateBundle, staticImports } from '../../scripts/check-bundle-budget.mjs';
import { createLink, startDistServer } from '../../scripts/serve-dist.mjs';
import { startupTransfer } from '../performance/startup-transfer';

const html = (body = '') => '<!doctype html><html><head>'
  + '<script type="module" crossorigin src="/assets/index-a.js"></script>'
  + '<link rel="modulepreload" crossorigin href="/assets/react-b.js">'
  + '<link rel="stylesheet" crossorigin href="/assets/index-c.css">'
  + `${body}</head><body><div id="root"></div></body></html>`;
// Base64 noise compresses to about 75% and each case controls its own numbers.
const noise = (bytes: number) => randomBytes(bytes).toString('base64').slice(0, bytes);
const js = (imports: string, bytes = 100) => Buffer.from(`${imports};/*${noise(bytes)}*/`);
const small = { initialJsGzipBytes: 5_000, chunkRawBytes: 8_000, lazyChunkGzipBytes: 2_000 };
function files(overrides: Record<string, Buffer> = {}) {
  return new Map(Object.entries({
    'index-a.js': js('import{a}from"./react-b.js";import"./shared-d.js";const l=()=>import("./route-e.js")'),
    'react-b.js': js('export const a=1'),
    'shared-d.js': js('export{}'),
    'route-e.js': js('import{a}from"./react-b.js"'),
    'index-c.css': Buffer.from('body{margin:0}'),
    ...overrides,
  }));
}

describe('bundle budgets', () => {
  it('follows static imports from the entry and preloads, and treats dynamic imports as lazy', () => {
    const input = files();
    const result = evaluateBundle(html(), input, small);
    expect(result.initial).toEqual(['index-a.js', 'react-b.js', 'shared-d.js']);
    expect(result.report.find((row) => row.file === 'route-e.js')?.kind).toBe('lazy');
    expect(result.report.find((row) => row.file === 'index-c.css')?.kind).toBe('css');
    expect(result.initialJsGzip).toBe(['index-a.js', 'react-b.js', 'shared-d.js']
      .reduce((sum, file) => sum + gzipSync(input.get(file)!).length, 0));
    expect(result.violations).toEqual([]);
  });

  it('fails when the initial JS is over its gzip budget', () => {
    const result = evaluateBundle(html(), files({ 'react-b.js': js('export const a=1', 7_000) }), small);
    expect(result.violations).toEqual([expect.stringMatching(/^initial JS \d+ B gzip > 5000 B$/)]);
  });

  it('fails a chunk over the raw limit even when it compresses well', () => {
    const result = evaluateBundle(html(), files({ 'shared-d.js': Buffer.from(`export{};${'a'.repeat(9_000)}`) }), small);
    expect(result.violations).toEqual([expect.stringMatching(/^shared-d\.js \d+ B raw > 8000 B$/)]);
  });

  it('fails a lazy chunk over its gzip budget, but not the same bytes when loaded initially', () => {
    const big = js('import{a}from"./react-b.js"', 3_000);
    expect(evaluateBundle(html(), files({ 'route-e.js': big }), small).violations)
      .toEqual([expect.stringMatching(/^lazy route-e\.js \d+ B gzip > 2000 B$/)]);
    expect(evaluateBundle(html(), files({ 'shared-d.js': big }), small).violations).toEqual([]);
  });

  it('fails when nothing is split into a lazy chunk', () => {
    const result = evaluateBundle(html(), files({ 'index-a.js': js('import"./react-b.js";import"./shared-d.js";import"./route-e.js"') }), small);
    expect(result.violations).toEqual(['no lazy chunks: route splitting is missing']);
  });

  it('refuses a missing initial chunk, a second entry script and unexpected asset URLs', () => {
    const missing = files(); missing.delete('shared-d.js');
    expect(() => evaluateBundle(html(), missing, small)).toThrow(/shared-d\.js is missing/);
    expect(() => entryAssets(html('<script type="module" src="/assets/other.js"></script>'))).toThrow(/exactly one module entry/);
    expect(() => entryAssets(html('<link rel="modulepreload" href="https://cdn.example.test/x.js">'))).toThrow(/Unexpected initial asset URL/);
    const noCss = files(); noCss.delete('index-c.css');
    expect(() => evaluateBundle(html(), noCss, small)).toThrow(/Stylesheet/);
  });

  it('parses minified static imports but not dynamic ones', () => {
    expect(staticImports('import{a as b}from"./x-1.js";import"./y_2.js";export*from"./z.js";const c=import("./lazy.js")'))
      .toEqual(['x-1.js', 'y_2.js', 'z.js']);
  });
});

describe('the performance test host shapes every response through one shared link', () => {
  it('rejects an invalid throttle', () => {
    expect(() => createLink({ bytesPerSecond: 0 })).toThrow();
    expect(() => createLink({ bytesPerSecond: 1_000, latencyMs: -1 })).toThrow();
  });

  it('adds the latency and shares the bandwidth between concurrent responses', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stillroom-link-'));
    const server = await startDistServer({ root: await (async () => {
      await writeFile(path.join(root, '_headers'), '/*\n  X-Test: 1\n');
      await writeFile(path.join(root, 'a.png'), randomBytes(40_000));
      await writeFile(path.join(root, 'b.png'), randomBytes(40_000));
      return root;
    })(), throttle: { bytesPerSecond: 400_000, latencyMs: 50 } });
    try {
      const started = performance.now();
      const bodies = await Promise.all(['a.png', 'b.png'].map(async (name) => (await fetch(`${server.url}/${name}`)).arrayBuffer()));
      const elapsed = performance.now() - started;
      expect(bodies.map((body) => body.byteLength)).toEqual([40_000, 40_000]);
      // 80,000 B at 400,000 B/s is 200 ms on one link; two separate links would take about 100 ms.
      expect(elapsed).toBeGreaterThanOrEqual(0.9 * (50 + 200));
      for (const entry of server.requests) {
        expect(entry.bytes).toBe(40_000);
        expect(entry.end - entry.start).toBeGreaterThanOrEqual(0.9 * (50 + 100));
      }
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe('startup transfer total', () => {
  const expected = ['/', '/assets/index-a.js', '/assets/react-b.js'];
  it('counts dynamic and prefetched startup downloads outside the expected set', () => {
    const transfer = new Map([['/', 2_000], ['/assets/index-a.js', 120_000], ['/assets/react-b.js', 100_000],
      ['/assets/lazy-c.js', 20_000], ['/assets/prefetch-d.js', 20_000]]);
    const result = startupTransfer(transfer, expected);
    expect(result.expected).toBe(222_000);
    expect(result.total).toBe(262_000);
    expect(result.total).toBeGreaterThan(250_000);
    expect(result.extra.map((entry) => entry.pathname)).toEqual(['/assets/lazy-c.js', '/assets/prefetch-d.js']);
  });
  it('fails when an expected asset is missing or empty', () => {
    expect(() => startupTransfer(new Map([['/', 2_000], ['/assets/index-a.js', 1]]), expected)).toThrow(/react-b/);
    expect(() => startupTransfer(new Map([['/', 2_000], ['/assets/index-a.js', 1], ['/assets/react-b.js', 0]]), expected)).toThrow(/react-b/);
  });
  it('rejects invalid sizes', () => {
    expect(() => startupTransfer(new Map([['/', 1], ['/assets/index-a.js', 1], ['/assets/react-b.js', 1], ['/x', Number.NaN]]), expected)).toThrow(/invalid/);
  });
});
