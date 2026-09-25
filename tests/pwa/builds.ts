import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinShellUrls } from '../../src/pwa/shell-policy';
import { finalizeShell } from '../../vite.config';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildRoot = path.join(repository, 'node_modules', '.cache', 'stillroom-pwa');
// A and B are two ordinary releases, `kill` is the emergency worker build, and `torn` is B with A's
// index.html: a deploy that replaced the mutable page while B's worker is installing. w is A's shell with a
// changed worker: a worker-only release, finalized by the real build step.
export const builds = {
  a: path.join(buildRoot, 'a'), b: path.join(buildRoot, 'b'), kill: path.join(buildRoot, 'kill'), torn: path.join(buildRoot, 'torn'),
  aw: path.join(buildRoot, 'aw'),
} as const;
export type BuildName = keyof typeof builds;
export type Manifest = { version: 1; buildId: string; files: Array<{ url: string; sha256: string; bytes: number }> };

export function readManifest(name: BuildName): Manifest {
  return JSON.parse(readFileSync(path.join(builds[name], 'precache-manifest.json'), 'utf8')) as Manifest;
}
export function artifactBytes(name: BuildName, url: string): Buffer {
  return readFileSync(path.join(builds[name], url === '/' ? 'index.html' : url.slice(1)));
}

function build(name: 'a' | 'b' | 'kill', version: string, extra: Record<string, string> = {}) {
  rmSync(builds[name], { recursive: true, force: true });
  const result = spawnSync(process.execPath, [path.join(repository, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', builds[name], '--emptyOutDir'], {
    cwd: repository,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_') && !key.startsWith('STILLROOM_'))),
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_fixture_only',
      VITE_APP_VERSION: version,
      ...extra,
    },
  });
  if (result.status !== 0 || !existsSync(path.join(builds[name], 'service-worker.js'))) throw new Error(`Production fixture build ${name} failed.`);
}

// Puts the build placeholders back into A's stamped worker, changes only the worker code and finalizes again.
async function workerOnlyRelease() {
  rmSync(builds.aw, { recursive: true, force: true });
  cpSync(builds.a, builds.aw, { recursive: true });
  const manifestText = readFileSync(path.join(builds.a, 'precache-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as Manifest;
  let worker = readFileSync(path.join(builds.a, 'service-worker.js'), 'utf8');
  for (const [value, placeholder] of [
    [manifest.buildId, '__STILLROOM_BUILD_ID__'],
    [createHash('sha256').update(manifestText).digest('hex'), '__STILLROOM_MANIFEST_SHA256__'],
    [joinShellUrls(manifest.files.map((file) => file.url)), '__STILLROOM_SHELL_URLS__'],
  ] as const) {
    if (worker.split(value).length !== 2) throw new Error('Cannot derive the worker-only fixture release.');
    worker = worker.replace(value, placeholder);
  }
  writeFileSync(path.join(builds.aw, 'service-worker.js'), `${worker}\n/* worker-only fixture release */\n`);
  rmSync(path.join(builds.aw, 'precache-manifest.json'));
  await finalizeShell(builds.aw, false);
}

export async function buildAll() {
  mkdirSync(buildRoot, { recursive: true });
  build('a', 'pwa-a');
  build('b', 'pwa-b');
  build('kill', 'pwa-kill', { STILLROOM_SW_KILL_SWITCH: '1' });
  rmSync(builds.torn, { recursive: true, force: true });
  cpSync(builds.b, builds.torn, { recursive: true });
  cpSync(path.join(builds.a, 'index.html'), path.join(builds.torn, 'index.html'));
  if (readManifest('a').buildId === readManifest('b').buildId) throw new Error('Fixture builds A and B must differ.');
  await workerOnlyRelease();
  if (readManifest('aw').buildId === readManifest('a').buildId) throw new Error('The worker-only release must have its own ID.');
}
