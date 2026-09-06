import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PROJECT_ID = 'stillroom-wardrobe';
export const DB_CONTAINER = `supabase_db_${PROJECT_ID}`;
export const LOCAL_API = 'http://127.0.0.1:54321';
export const CACHE_PATH = path.join(ROOT, '.supabase', 'test-users.json');
export const MIGRATION_HASH = '4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5';
export const TEST_EMAILS = ['user-a@example.test', 'user-b@example.test'];

export class LocalBackendError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'LocalBackendError';
    this.exitCode = exitCode;
  }
}

export function fail(message, exitCode = 2) {
  throw new LocalBackendError(message, exitCode);
}

export function reportError(error) {
  console.error(error instanceof LocalBackendError ? error.message : 'FAIL: local backend operation failed; private details were not logged.');
  process.exitCode = error instanceof LocalBackendError ? error.exitCode : 1;
}

export function assertLoopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('REFUSED: a valid loopback HTTP URL is required.'); }
  // Inspect the supplied authority too: URL normalizes integer/octal/short IPv4 forms.
  const authority = /^http:\/\/([^/?#]+)\/?$/i.exec(value)?.[1];
  if (!authority || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('REFUSED: only a literal loopback HTTP origin is allowed; no remote override exists.');
  }
  return url.origin;
}

export function assertLocalApi(value) {
  const origin = assertLoopbackUrl(value);
  if (new URL(origin).port !== '54321') fail('REFUSED: this tooling only targets the disposable API on port 54321.');
  return origin;
}

export function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

export function assertPublishableKey(key) {
  if (typeof key !== 'string' || !key.trim() || key !== key.trim()
    || /[\r\n]/.test(key) || key.startsWith('sb_secret_')) {
    fail('REFUSED: provide a local publishable or legacy anon key, never a service secret.');
  }
  if (!key.startsWith('sb_publishable_') && jwtClaims(key).role !== 'anon') {
    fail('REFUSED: the key is not a publishable or legacy anon key.');
  }
  return key;
}

export function assertNoServiceSecrets(env) {
  const forbidden = /(?:SERVICE[_-]?ROLE|SECRET[_-]?KEY|SUPABASE.*(?:SERVICE|SECRET|TOKEN)|DATABASE_URL|DB_PASSWORD|PGPASSWORD)/i;
  if (Object.entries(env).some(([name, value]) => value && forbidden.test(name))) {
    fail('REFUSED: normal-session test processes must not contain administrator or database credentials.');
  }
}

export function validateSessionEnvironment(env) {
  assertNoServiceSecrets(env);
  if (env.ALLOW_SECURITY_TESTS !== '1') fail('NOT RUN: set ALLOW_SECURITY_TESTS=1 explicitly for disposable local tests.');
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'TEST_A_EMAIL', 'TEST_A_PASSWORD', 'TEST_B_EMAIL', 'TEST_B_PASSWORD'];
  if (required.some((name) => !env[name])) fail('NOT RUN: local normal-session credentials are missing; run npm run db:reset first.');
  assertLocalApi(env.SUPABASE_URL);
  assertPublishableKey(env.SUPABASE_PUBLISHABLE_KEY);
  if (env.TEST_A_EMAIL !== TEST_EMAILS[0] || env.TEST_B_EMAIL !== TEST_EMAILS[1]) {
    fail('REFUSED: only the two fixed fictional local identities may be used.');
  }
  if (env.TEST_A_PASSWORD.length < 24 || env.TEST_B_PASSWORD.length < 24 || env.TEST_A_PASSWORD === env.TEST_B_PASSWORD) {
    fail('REFUSED: independent high-entropy local credentials are required.');
  }
}

export function normalSessionEnvironment(source, credentials) {
  assertNoServiceSecrets(source);
  const result = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']) {
    if (source[name]) result[name] = source[name];
  }
  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'TEST_A_EMAIL', 'TEST_A_PASSWORD', 'TEST_B_EMAIL', 'TEST_B_PASSWORD']) {
    result[name] = credentials[name];
  }
  result.ALLOW_SECURITY_TESTS = source.ALLOW_SECURITY_TESTS;
  validateSessionEnvironment(result);
  return result;
}

export function commandEnvironment(source = process.env) {
  const result = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'DOCKER_CONFIG']) {
    if (source[name]) result[name] = source[name];
  }
  result.NO_COLOR = '1';
  result.SUPABASE_TELEMETRY_DISABLED = 'true';
  return result;
}

export function runCommand(command, args, { input, env = commandEnvironment(), timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, oversized = false;
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        // Windows does not forward SIGTERM through the CLI's Node/binary wrappers.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          env, shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const timer = setTimeout(terminate, timeout);
    const receive = (target) => (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { if (!oversized) terminate(); oversized = true; }
      else target.push(chunk);
    };
    child.stdout.on('data', receive(stdout));
    child.stderr.on('data', receive(stderr));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ code: 2, stdout: '', stderr: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: oversized ? 2 : code ?? 2, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

export async function assertProjectConfig() {
  let config;
  try { config = await readFile(path.join(ROOT, 'supabase', 'config.toml'), 'utf8'); }
  catch { fail('NOT RUN: local Supabase configuration is missing.'); }
  if (!/^project_id\s*=\s*"stillroom-wardrobe"\s*$/m.test(config)) fail('REFUSED: local project ID differs from the disposable fixture project.');
  if (process.env.SUPABASE_URL) assertLocalApi(process.env.SUPABASE_URL);
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT']) {
    if (process.env[name]) fail('REFUSED: Docker endpoint overrides are not permitted by disposable local tooling.');
  }
}

export async function requireDocker(run = runCommand) {
  const context = await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (context.code !== 0) fail('NOT RUN: Docker is unavailable. Install/start Docker separately, then rerun this command.');
  const endpoint = context.stdout.trim();
  if (!endpoint.startsWith('unix:///') && !endpoint.startsWith('npipe:////./pipe/')) {
    fail('REFUSED: Docker must use a local Unix socket or Windows named pipe, not a remote daemon.');
  }
  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (info.code !== 0 || !info.stdout.trim()) fail('NOT RUN: the local Docker daemon is not running or accessible.');
}

export async function requireLocalContainer(run = runCommand) {
  const template = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"image":{{json .Config.Image}},"running":{{json .State.Running}}}';
  const result = await run('docker', ['container', 'inspect', '--format', template, DB_CONTAINER]);
  let container;
  try { container = JSON.parse(result.stdout); } catch { fail('NOT RUN: the known local Supabase database container is unavailable.'); }
  if (result.code !== 0 || container.name !== `/${DB_CONTAINER}` || container.project !== PROJECT_ID
    || !container.running || !/(?:^|\/)supabase\/postgres:/.test(container.image)) {
    fail('REFUSED: the database container identity, project label, image, or running state does not match.');
  }
}

export async function cli(args, timeout = 120_000) {
  let entrypoint;
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('supabase/package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    if (pkg.version !== '2.116.0') fail('REFUSED: local tooling requires the pinned Supabase CLI 2.116.0.');
    entrypoint = path.join(path.dirname(packagePath), pkg.bin.supabase);
  } catch (error) {
    if (error instanceof LocalBackendError) throw error;
    fail('NOT RUN: the pinned Supabase CLI is missing; finish npm ci first.');
  }
  const version = await runCommand(process.execPath, [entrypoint, '--version']);
  if (version.code !== 0 || version.stdout.trim() !== '2.116.0') fail('REFUSED: local tooling requires the pinned Supabase CLI 2.116.0.');
  return runCommand(process.execPath, [entrypoint, '--agent', 'no', '--workdir', ROOT, ...args], { timeout });
}

export async function localStatus() {
  const result = await cli(['status', '--output', 'json']);
  let data;
  try { data = JSON.parse(result.stdout); } catch { fail('NOT RUN: local Supabase status is unavailable; run npm run db:start.'); }
  if (result.code !== 0) fail('NOT RUN: local Supabase services are not ready.');
  const url = assertLocalApi(data.API_URL);
  const key = assertPublishableKey(data.PUBLISHABLE_KEY || data.ANON_KEY);
  const serviceKey = data.SECRET_KEY || data.SERVICE_ROLE_KEY;
  if (typeof serviceKey !== 'string' || (!serviceKey.startsWith('sb_secret_') && jwtClaims(serviceKey).role !== 'service_role')) {
    fail('NOT RUN: local setup credentials are unavailable from the CLI.');
  }
  return { url, key, serviceKey };
}

export async function privilegedLocalSql(sql) {
  await requireLocalContainer();
  const result = await runCommand('docker', [
    'exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
  ], { input: sql });
  if (result.code !== 0) fail('FAIL: isolated local database fixture failed; SQL output was suppressed.', 1);
  return result.stdout.trim();
}

export async function readCredentialCache() {
  try {
    const stat = await lstat(CACHE_PATH);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) fail('REFUSED: local fixture credential file is not a regular bounded file.');
    const data = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    if (data.projectId !== PROJECT_ID || data.version !== 1) fail('REFUSED: local fixture credentials belong to a different project.');
    const env = {
      SUPABASE_URL: data.url, SUPABASE_PUBLISHABLE_KEY: data.publishableKey,
      TEST_A_EMAIL: data.users?.[0]?.email, TEST_A_PASSWORD: data.users?.[0]?.password,
      TEST_B_EMAIL: data.users?.[1]?.email, TEST_B_PASSWORD: data.users?.[1]?.password,
      ALLOW_SECURITY_TESTS: '1',
    };
    validateSessionEnvironment(env);
    return env;
  } catch (error) {
    if (error instanceof LocalBackendError) throw error;
    fail('NOT RUN: valid local fixture credentials are missing; run npm run db:reset.');
  }
}
