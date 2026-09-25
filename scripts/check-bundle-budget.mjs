#!/usr/bin/env node
// Bundle budgets for a production build (I25, R21). The limits change only in a reviewed PR that says why;
// they are never recalibrated per candidate. gzip uses the same zlib default as scripts/serve-dist.mjs.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const bundleBudgets = Object.freeze({
  initialJsGzipBytes: 240_000,
  chunkRawBytes: 300_000,
  lazyChunkGzipBytes: 30_000,
});

const assetUrl = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/;

// The entry script, its modulepreloads and stylesheets, as named by index.html.
export function entryAssets(indexHtml) {
  const tags = [...indexHtml.matchAll(/<(script|link)\b[^>]*>/g)].map((match) => match[0]);
  const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  const scripts = [], preloads = [], styles = [];
  for (const tag of tags) {
    if (tag.startsWith('<script') && attribute(tag, 'type') === 'module' && attribute(tag, 'src')) scripts.push(attribute(tag, 'src'));
    const rel = attribute(tag, 'rel'), href = attribute(tag, 'href');
    if (tag.startsWith('<link') && rel === 'modulepreload' && href) preloads.push(href);
    if (tag.startsWith('<link') && rel === 'stylesheet' && href) styles.push(href);
  }
  if (scripts.length !== 1) throw new Error(`index.html must name exactly one module entry script, found ${scripts.length}.`);
  for (const url of [...scripts, ...preloads, ...styles]) if (!assetUrl.test(url)) throw new Error(`Unexpected initial asset URL ${url}.`);
  return { entry: scripts[0], preloads, styles };
}

// Static imports only (`from"./x.js"`, `import"./x.js"`); `import("./x.js")` is a lazy chunk.
export function staticImports(code) {
  return [...code.matchAll(/(?:\bfrom|\bimport)\s*["'](\.\/[A-Za-z0-9_.-]+\.js)["']/g)].map((match) => match[1].slice(2));
}

/**
 * files: Map of asset file name (no directory) to bytes, for every file in dist/assets.
 * Returns per-file sizes, the initial set and the budget violations.
 */
export function evaluateBundle(indexHtml, files, budgets = bundleBudgets) {
  const { entry, preloads, styles } = entryAssets(indexHtml);
  const name = (url) => url.slice('/assets/'.length);
  const initial = new Set();
  const pending = [name(entry), ...preloads.map(name)];
  while (pending.length) {
    const file = pending.pop();
    if (initial.has(file)) continue;
    const bytes = files.get(file);
    if (!bytes) throw new Error(`Initial chunk ${file} is missing from dist/assets.`);
    initial.add(file);
    pending.push(...staticImports(bytes.toString('utf8')));
  }
  for (const style of styles) if (!files.has(name(style))) throw new Error(`Stylesheet ${style} is missing from dist/assets.`);
  const report = [...files].filter(([file]) => /\.(?:js|css)$/.test(file)).map(([file, bytes]) => ({
    file, raw: bytes.length, gzip: gzipSync(bytes).length,
    kind: file.endsWith('.css') ? 'css' : initial.has(file) ? 'initial' : 'lazy',
  })).sort((a, b) => a.file.localeCompare(b.file));
  const initialJsGzip = report.filter((row) => row.kind === 'initial').reduce((sum, row) => sum + row.gzip, 0);
  const violations = [];
  if (initialJsGzip > budgets.initialJsGzipBytes) violations.push(`initial JS ${initialJsGzip} B gzip > ${budgets.initialJsGzipBytes} B`);
  for (const row of report) {
    if (row.raw > budgets.chunkRawBytes) violations.push(`${row.file} ${row.raw} B raw > ${budgets.chunkRawBytes} B`);
    if (row.kind === 'lazy' && row.gzip > budgets.lazyChunkGzipBytes) violations.push(`lazy ${row.file} ${row.gzip} B gzip > ${budgets.lazyChunkGzipBytes} B`);
  }
  const lazy = report.filter((row) => row.kind === 'lazy');
  if (!lazy.length) violations.push('no lazy chunks: route splitting is missing');
  return { report, initial: [...initial].sort(), initialJsGzip, styles: styles.map(name), violations };
}

export async function checkDist(dist) {
  const indexHtml = await readFile(path.join(dist, 'index.html'), 'utf8');
  const assets = path.join(dist, 'assets');
  const files = new Map();
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (entry.isFile()) files.set(entry.name, await readFile(path.join(assets, entry.name)));
  }
  return evaluateBundle(indexHtml, files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkDist(path.resolve(process.argv[2] ?? 'dist'));
  for (const row of result.report) console.log(`${row.kind.padEnd(7)} ${String(row.raw).padStart(8)} raw ${String(row.gzip).padStart(7)} gzip  ${row.file}`);
  console.log(`initial JS gzip: ${result.initialJsGzip} B (budget ${bundleBudgets.initialJsGzipBytes} B)`);
  if (result.violations.length) {
    for (const violation of result.violations) console.error(`BUDGET: ${violation}`);
    process.exit(1);
  }
  console.log('Bundle budgets: pass');
}
