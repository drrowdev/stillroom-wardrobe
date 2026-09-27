import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { artifactUrl, isExcludedArtifact, isShellArtifact, joinShellUrls, manifestPath, parsePrecacheManifest, workerPath } from './src/pwa/shell-policy.ts';
import { checkStaticTree, listTree, readInventory, type InventoryFile } from './scripts/check-static-assets.mjs';

const publicKeys = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_APP_VERSION',
]);
const buildIdPlaceholder = '__STILLROOM_BUILD_ID__';
const manifestPlaceholder = '__STILLROOM_MANIFEST_SHA256__';
const urlsPlaceholder = '__STILLROOM_SHELL_URLS__';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, file) : [file];
  }));
  return nested.flat().sort();
}

// Writes the precache manifest from the files actually emitted, then stamps the worker with the build
// identity and the manifest digest. Any emitted file that is neither shell nor excluded fails the build.
export async function finalizeShell(outDir: string, killSwitch: boolean): Promise<{ buildId: string; manifestSha256: string; files: string[] }> {
  const files: Array<{ url: string; sha256: string; bytes: number }> = [];
  for (const file of await listFiles(outDir)) {
    if (isExcludedArtifact(file)) continue;
    if (!isShellArtifact(file)) throw new Error(`Build file ${file} is not classified for the service worker.`);
    const bytes = await readFile(path.join(outDir, file));
    files.push({ url: artifactUrl(file), sha256: sha256(bytes), bytes: bytes.length });
  }
  files.sort((left, right) => left.url.localeCompare(right.url));
  const workerFile = path.join(outDir, workerPath.slice(1));
  let worker = await readFile(workerFile, 'utf8');
  if (/^\s*(?:import|export)\b/m.test(worker) || /\bimport\s*\(/.test(worker)) throw new Error('The service worker must be a single classic script.');
  if (!killSwitch && [buildIdPlaceholder, manifestPlaceholder, urlsPlaceholder].some((placeholder) => worker.split(placeholder).length !== 2)) {
    throw new Error('The service worker build placeholders are missing.');
  }
  // The release ID covers the shell bytes and the unstamped worker code, so a worker-only change is a new release.
  const buildId = sha256(`${files.map((file) => `${file.url} ${file.sha256}\n`).join('')}worker ${sha256(worker)}\n`).slice(0, 20);
  const manifest = JSON.stringify({ version: 1, buildId, files });
  parsePrecacheManifest(JSON.parse(manifest), buildId);
  await writeFile(path.join(outDir, manifestPath.slice(1)), manifest);
  const manifestSha256 = sha256(manifest);
  if (!killSwitch) {
    worker = worker.replace(buildIdPlaceholder, buildId).replace(manifestPlaceholder, manifestSha256)
      .replace(urlsPlaceholder, joinShellUrls(files.map((file) => file.url)));
  }
  await writeFile(workerFile, worker);
  return { buildId, manifestSha256, files: files.map((file) => file.url) };
}

// ORT names its runtime with `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`, which the bundler would
// emit as an extra, unapproved asset. The app always hands ORT verified bytes (env.wasm.wasmBinary), so those
// references are pointed at the inventory path instead; an unexpected ORT build fails here.
const ortRuntimeReference = 'new URL("ort-wasm-simd-threaded.wasm",import.meta.url).href';
function ortRuntimePath(runtime: InventoryFile): Plugin {
  return {
    name: 'stillroom-ort-runtime-path',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]onnxruntime-web[\\/]dist[\\/]ort\.wasm\.bundle\.min\.mjs$/.test(id.split('?')[0]!)) return null;
      if (code.split(ortRuntimeReference).length !== 3) throw new Error('Unexpected onnxruntime-web runtime references.');
      return { code: code.replaceAll(ortRuntimeReference, JSON.stringify(runtime.path)), map: null };
    },
  };
}
async function runtimeBytes(runtime: InventoryFile): Promise<Buffer> {
  const bytes = await readFile(path.resolve(runtime.source));
  if (bytes.length !== runtime.bytes || sha256(bytes) !== runtime.sha256) throw new Error(`${runtime.source} does not match the approved runtime.`);
  return bytes;
}
// Background removal assets (ADR24): the locked ORT runtime is emitted at its exact inventory path (the model is
// in public/), and the finished tree is checked against the inventory and the Pages limits before it can deploy.
function backgroundAssets(mode: string): Plugin {
  let outDir = '';
  let inventory: InventoryFile[] = [];
  return {
    name: 'stillroom-background-assets',
    async config() { inventory = await readInventory(); },
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const runtime = inventory.find((file) => file.role === 'runtime')!;
        if (request.url !== runtime.path) { next(); return; }
        response.setHeader('content-type', 'application/wasm');
        response.end(await runtimeBytes(runtime));
      });
    },
    async generateBundle() {
      const runtime = inventory.find((file) => file.role === 'runtime')!;
      this.emitFile({ type: 'asset', fileName: runtime.path.slice(1), source: await runtimeBytes(runtime) });
    },
    async closeBundle() {
      const problems = await checkStaticTree(outDir, inventory);
      if (mode !== 'browser-test') {
        for (const file of (await listTree(outDir)).filter((name) => name.endsWith('.js'))) {
          if ((await readFile(path.join(outDir, file), 'utf8')).includes('__stillroomBackground')) problems.push(`test hook in ${file}`);
        }
      }
      if (problems.length) throw new Error(`Static assets: ${problems.join('; ')}`);
    },
  };
}

function shellWorker(killSwitch: boolean): Plugin {
  let outDir = '';
  return {
    name: 'stillroom-shell-worker',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    buildStart() {
      this.emitFile({ type: 'chunk', id: path.resolve(killSwitch ? 'src/service-worker-kill-switch.ts' : 'src/service-worker.ts'), fileName: workerPath.slice(1) });
    },
    async closeBundle() { await finalizeShell(outDir, killSwitch); },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  if (Object.keys(environment).some((key) => !publicKeys.has(key))) {
    throw new Error('Only the three documented public build variables are allowed.');
  }
  const backend = environment.VITE_SUPABASE_URL
    ? new URL(environment.VITE_SUPABASE_URL).origin
    : '';
  // Build-only switch for the emergency worker; it is not a browser variable and never reaches the bundle as a value.
  const killSwitch = process.env.STILLROOM_SW_KILL_SWITCH === '1';
  const runtime = { role: 'runtime', ...JSON.parse(readFileSync(path.resolve('src/images/background/model-assets.json'), 'utf8'))
    .files.find((file: InventoryFile) => file.role === 'runtime') } as InventoryFile;
  return {
    define: { __STILLROOM_SHELL_WORKER__: JSON.stringify(!killSwitch) },
    plugins: [
      react(),
      shellWorker(killSwitch),
      ortRuntimePath(runtime),
      backgroundAssets(mode),
      {
        name: 'private-app-headers',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: '_headers',
            source: [
              '/*',
              `  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ${backend} https://geocoding-api.open-meteo.com https://api.open-meteo.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
              '  Referrer-Policy: no-referrer',
              '  X-Content-Type-Options: nosniff',
              '  Permissions-Policy: geolocation=(), microphone=()',
              '/',
              '  Cache-Control: no-cache',
              '/index.html',
              '  Cache-Control: no-cache',
              '/service-worker.js',
              '  Cache-Control: no-cache',
              '/precache-manifest.json',
              '  Cache-Control: no-cache',
              '/assets/*',
              '  Cache-Control: public, max-age=31536000, immutable',
              '/models/*',
              '  Cache-Control: public, max-age=31536000, immutable',
              '',
            ].join('\n'),
          });
        },
      },
    ],
    worker: { format: 'es', plugins: () => [ortRuntimePath(runtime)] },
    // Pre-bundle the lazily imported runtime so the dev server does not reload the page on first use.
    optimizeDeps: { include: ['onnxruntime-web/wasm'] },
    build: {
      sourcemap: false,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: 'supabase', test: /[\\/]node_modules[\\/]@supabase[\\/]/ },
            ],
          },
        },
      },
    },
    test: {
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
      restoreMocks: true,
    },
  };
});
