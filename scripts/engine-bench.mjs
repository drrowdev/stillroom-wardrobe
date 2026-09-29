#!/usr/bin/env node
// P1 phone bench (plan R-6 rev3): times the recommendation engine on a phone with the fictional, seeded 500-item
// catalogue from tests/performance/engine-entry.ts. No backend, account or private data. It must run from a clean
// checkout of the candidate C, and the page shows C's full SHA with the fixture settings and timings.
//
//   npm run bench:engine -- --candidate <full-C-SHA> [--lan <private-IPv4>] [--port <port>]
//
// By default the page is served on 127.0.0.1 only (Android: Chrome remote DevTools port forwarding). `--lan` is an
// explicit opt-in for the iPhone: one RFC 1918 IPv4 address, never 0.0.0.0. The server stops after 15 minutes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startDistServer } from './serve-dist.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BENCH_ROOT = path.join(repository, 'node_modules', '.cache', 'stillroom-engine-bench');
export const LIFETIME_MS = 15 * 60 * 1000;
export const RUNS = 5;
export const LIMIT_MS = 200;
export const DEFAULT_PORT = 4180;
// Nothing on the page may reach the network or browser storage; the CSP also blocks connections.
export const FORBIDDEN = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'supabase', 'localStorage', 'sessionStorage',
  'indexedDB', 'caches', 'serviceWorker', 'document.cookie'];

const SHA = /^[0-9a-f]{40}$/;

/** True only for a dotted-quad RFC 1918 address (10/8, 172.16/12, 192.168/16). */
export function isPrivateIPv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address));
  if (!match) return false;
  const parts = match.slice(1).map((part) => (part.length > 1 && part.startsWith('0') ? Number.NaN : Number(part)));
  if (parts.some((part) => !(part >= 0 && part <= 255))) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseBenchArguments(argv) {
  const options = { port: DEFAULT_PORT };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--candidate', '--lan', '--port'].includes(flag) || value === undefined || seen.has(flag)) return { error: `unexpected argument ${flag}` };
    seen.add(flag);
    if (flag === '--candidate') options.candidate = value;
    if (flag === '--lan') options.lan = value;
    if (flag === '--port') options.port = /^[0-9]{4,5}$/.test(value) ? Number(value) : Number.NaN;
  }
  if (!SHA.test(options.candidate ?? '')) return { error: '--candidate must be the full 40-character lowercase SHA of C' };
  if (options.lan !== undefined && !isPrivateIPv4(options.lan)) return { error: '--lan must be one private IPv4 address (10.x, 172.16-31.x or 192.168.x)' };
  if (!(options.port >= 1024 && options.port <= 65535)) return { error: '--port must be between 1024 and 65535' };
  return { options: { ...options, host: options.lan ?? '127.0.0.1' } };
}

/** Returns a refusal reason unless the checkout is clean (including untracked files) and HEAD is the candidate. */
export function checkBinding(candidate, git) {
  let head;
  let porcelain;
  try {
    head = git(['rev-parse', 'HEAD']).trim();
    porcelain = git(['status', '--porcelain', '--untracked-files=all']);
  } catch {
    return 'cannot read the git checkout';
  }
  if (head !== candidate) return `HEAD ${head.slice(0, 8)} is not the candidate ${candidate.slice(0, 8)}`;
  if (porcelain.trim() !== '') return 'the checkout is not clean';
  return null;
}

/** Builds the engine entry as an IIFE and returns its source. */
export async function buildEngineScript(outDir = path.join(BENCH_ROOT, 'engine')) {
  const { build } = await import('vite');
  rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'warn',
    root: repository,
    build: {
      outDir,
      emptyOutDir: true,
      lib: { entry: path.join(repository, 'tests', 'performance', 'engine-entry.ts'), formats: ['iife'], name: 'StillroomEngine', fileName: () => 'engine.js' },
    },
  });
  return readFileSync(path.join(outDir, 'engine.js'), 'utf8');
}

/** Runs the bundle once in Node to read the fixture settings the page will show. */
export function fixtureOf(engineScript) {
  const engine = vm.runInNewContext(`${engineScript}\n;StillroomEngine`, { performance });
  const { items, timings } = engine.timeAll();
  return { seed: engine.fixture.seed, items, contexts: timings.length, runs: RUNS };
}

const runner = (sha, fixture) => `
(function () {
  var engine = StillroomEngine;
  var output = document.getElementById('result');
  var button = document.getElementById('again');
  var sha = ${JSON.stringify(sha)};
  var setup = 'Candidate ' + sha + '\\nFixture: ' + ${fixture.items} + ' items, ' + ${fixture.contexts} + ' contexts, seed ' + ${fixture.seed} + ', ' + ${RUNS} + ' runs';
  function run() {
    var slowest = [];
    var lines = [setup, ''];
    for (var index = 0; index < ${RUNS}; index += 1) {
      var timings = engine.timeAll().timings;
      var slow = 0;
      for (var j = 0; j < timings.length; j += 1) if (timings[j].ms > slow) slow = timings[j].ms;
      slowest.push(slow);
      lines.push('Run ' + (index + 1) + ': slowest context ' + slow.toFixed(1) + ' ms');
    }
    var median = slowest.slice().sort(function (a, b) { return a - b; })[${Math.floor(RUNS / 2)}];
    lines.push('', 'Median: ' + median.toFixed(1) + ' ms', (median < ${LIMIT_MS} ? 'PASS' : 'FAIL') + ' (median < ${LIMIT_MS} ms)');
    output.textContent = lines.join('\\n');
  }
  output.textContent = setup + '\\n\\nRunning…';
  button.addEventListener('click', function () { output.textContent = setup + '\\n\\nRunning…'; setTimeout(run, 50); });
  setTimeout(run, 300);
})();
`;

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** Returns the page and its `_headers` rules. Both inline blocks are allowed by hash; connections are blocked. */
export function renderPage({ sha, engineScript, fixture }) {
  const script = `${engineScript}\n${runner(sha, fixture)}`;
  const style = 'body{font:16px/1.5 system-ui,sans-serif;margin:16px}pre{white-space:pre-wrap;font-size:15px}button{font-size:16px;padding:8px 16px}';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Suggestions bench ${sha.slice(0, 8)}</title>
<style>${style}</style>
</head>
<body>
<h1>Suggestions bench</h1>
<p>Candidate <code>${sha}</code></p>
<pre id="result" aria-live="polite"></pre>
<button id="again" type="button">Run again</button>
<script>${script}</script>
</body>
</html>
`;
  const csp = `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const headers = `/*\n  Content-Security-Policy: ${csp}\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`;
  return { html, headers };
}

/** Serves `root` on `host` and closes the server after `lifetimeMs`. */
export async function serveBench({ root, host, port, lifetimeMs = LIFETIME_MS }) {
  if (host !== '127.0.0.1' && !isPrivateIPv4(host)) throw new Error('refused host');
  const server = await startDistServer({ root, host, port });
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    await server.close();
    resolveClosed();
  };
  const timer = setTimeout(() => { void close(); }, lifetimeMs);
  return { url: server.url, close, closed, stopsAt: new Date(Date.now() + lifetimeMs) };
}

const gitRead = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** CLI entry. Returns the exit code; refuses before building anything unless bound to C. */
export async function main(argv, { git = gitRead, build = buildEngineScript, serve = serveBench, log = console.log, root = BENCH_ROOT } = {}) {
  const parsed = parseBenchArguments(argv);
  if (parsed.error) { log(`bench:engine refused: ${parsed.error}`); return 2; }
  const { candidate, host, port } = parsed.options;
  const refusal = checkBinding(candidate, git);
  if (refusal) { log(`bench:engine refused: ${refusal}`); return 1; }
  const engineScript = await build();
  const fixture = fixtureOf(engineScript);
  const { html, headers } = renderPage({ sha: candidate, engineScript, fixture });
  const site = path.join(root, 'site');
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  writeFileSync(path.join(site, 'index.html'), html);
  writeFileSync(path.join(site, '_headers'), headers);
  const running = await serve({ root: site, host, port });
  log(`Candidate ${candidate}`);
  log(`Fixture: ${fixture.items} items, ${fixture.contexts} contexts, seed ${fixture.seed}, ${fixture.runs} runs`);
  log(`Acceptance: the median of the ${RUNS} slowest-context times is < ${LIMIT_MS} ms. The timings appear on the page.`);
  log(`Open ${running.url}/ (stops at ${running.stopsAt.toISOString()}; Ctrl+C stops it sooner)`);
  await running.closed;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
