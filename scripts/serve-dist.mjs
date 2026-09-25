#!/usr/bin/env node
// Test-only production host for dist/. It approximates what the app relies on from Cloudflare Pages:
// the emitted _headers rules, no serving of deployment-control files, /index.html redirected to /,
// the SPA fallback for navigations only, and gzip for text. The real Pages headers are checked on a
// deployed candidate separately; this host never runs in production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'], ['.webmanifest', 'application/manifest+json'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.txt', 'text/plain; charset=utf-8'],
]);
export const contentTypeFor = (file) => types.get(path.extname(file)) ?? 'application/octet-stream';
const compressible = /^(?:text\/|application\/(?:json|manifest\+json)|image\/svg\+xml)/;

// Parses the Pages `_headers` format: an unindented URL pattern followed by indented `Name: value` lines.
export function parseHeaders(text) {
  const rules = [];
  for (const [index, raw] of text.replaceAll('\r\n', '\n').split('\n').entries()) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      if (!raw.startsWith('/') || /\s/.test(raw.trim())) throw new Error(`_headers line ${index + 1}: invalid pattern`);
      rules.push({ pattern: raw.trim(), headers: [] });
      continue;
    }
    const match = /^\s+([A-Za-z0-9-]+):\s*(.+)$/.exec(raw);
    const rule = rules.at(-1);
    if (!match || !rule) throw new Error(`_headers line ${index + 1}: invalid header`);
    rule.headers.push([match[1], match[2].trim()]);
  }
  return rules;
}

function matches(pattern, pathname) {
  const expression = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return expression.test(pathname);
}

// Every matching rule applies, in file order. As on Pages, a header set by more than one matching rule has
// its values joined with a comma.
export function headersFor(rules, pathname) {
  const result = new Map();
  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      const previous = result.get(key);
      result.set(key, previous ? [previous[0], `${previous[1]}, ${value}`] : [name, value]);
    }
  }
  return new Map([...result.values()]);
}

async function file(root, relative) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

// Starts a host for `root`. `setRoot` swaps the served build (a deploy); `requests` records each request;
// `hold(pathname)` delays that path until the returned release function runs.
export async function startDistServer({ root, port = 0, host = '127.0.0.1' }) {
  let current = path.resolve(root);
  let rules = [];
  const loadRules = async () => { rules = parseHeaders(await readFile(path.join(current, '_headers'), 'utf8')); };
  await loadRules();
  const requests = [];
  const holds = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://host');
      const pathname = decodeURIComponent(url.pathname);
      requests.push({ method: request.method, pathname, mode: request.headers['sec-fetch-mode'] ?? '', dest: request.headers['sec-fetch-dest'] ?? '' });
      const held = holds.get(pathname);
      if (held) await held;
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      if (pathname.includes('\0') || pathname.split('/').some((segment) => segment === '..' || segment.startsWith('_'))) {
        response.writeHead(404).end(); return;
      }
      if (pathname === '/index.html') { response.writeHead(308, { Location: '/' }).end(); return; }
      let target = await file(current, pathname === '/' ? 'index.html' : `.${pathname}`);
      const navigation = request.headers['sec-fetch-mode'] === 'navigate' || (request.headers.accept ?? '').includes('text/html');
      if (!target && navigation && !path.posix.basename(pathname).includes('.')) {
        target = await file(current, 'index.html');
      }
      if (!target) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
      let body = await readFile(target);
      const headers = { 'Content-Type': contentTypeFor(target) };
      for (const [name, value] of headersFor(rules, pathname)) headers[name] = value;
      if (compressible.test(headers['Content-Type']) && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '')) {
        body = gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
      }
      headers['Content-Length'] = String(body.length);
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    requests,
    async setRoot(next) { current = path.resolve(next); await loadRules(); },
    hold(pathname) {
      let release;
      holds.set(pathname, new Promise((resolve) => { release = resolve; }));
      return () => { holds.delete(pathname); release(); };
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const port = Number(option('--port', '4173'));
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
  const running = await startDistServer({ root: option('--root', 'dist'), port });
  console.log(`Serving on ${running.url}`);
}
