import { spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
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

export function securityFailureExitCode(primary, error) {
  if (primary === 1 || primary === 2) return primary;
  return error instanceof LocalBackendError ? 2 : 1;
}

export function fail(message, exitCode = 2) {
  throw new LocalBackendError(message, exitCode);
}

export function reportError(error) {
  console.error(error instanceof LocalBackendError ? error.message : 'FAIL: local backend operation failed; private details were not logged.');
  process.exitCode = error instanceof LocalBackendError ? error.exitCode : 1;
}

export function describeGenerationResult(result, elapsedMs) {
  const report = {
    tag: 'invalid-result',
    exitCode: null,
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= Number.MAX_SAFE_INTEGER ? Math.floor(elapsedMs) : null,
    stdoutBytes: null,
    stderrBytes: null,
    hasDatabaseOutput: false,
    hasImagesOutput: false,
    stderrMentionsConnectPhase: false,
    stderrLines: null,
    stderrFirstLineBytes: null,
    stderrDockerOperation: 'none',
  };
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return report;
    // Read only data properties; never invoke input accessors or stringify input.
    const code = Object.getOwnPropertyDescriptor(result, 'code')?.value;
    const stdout = Object.getOwnPropertyDescriptor(result, 'stdout')?.value;
    const stderr = Object.getOwnPropertyDescriptor(result, 'stderr')?.value;
    report.exitCode = Number.isSafeInteger(code) ? code : null;
    if (typeof stdout === 'string') {
      report.stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      report.hasDatabaseOutput = stdout.includes('export type Database =');
      report.hasImagesOutput = stdout.includes('item_images:');
    }
    if (typeof stderr === 'string') report.stderrBytes = Buffer.byteLength(stderr, 'utf8');
    if (report.exitCode === null || report.elapsedMs === null || report.stdoutBytes === null || report.stderrBytes === null) return report;
    if (code !== 0) {
      report.tag = report.stderrBytes > 0 ? 'nonzero-with-stderr'
        : report.stdoutBytes > 0 ? 'nonzero-with-stdout' : 'nonzero-empty-output';
    } else {
      report.tag = !report.hasDatabaseOutput ? 'missing-database-output'
        : !report.hasImagesOutput ? 'missing-images-output' : 'success';
    }
    if (report.tag === 'nonzero-with-stderr') {
      report.stderrMentionsConnectPhase = stderr.includes('Connecting to');
      const firstLf = stderr.indexOf('\n');
      report.stderrFirstLineBytes = Buffer.byteLength(firstLf === -1 ? stderr : stderr.slice(0, firstLf), 'utf8');
      // Count LF separators, not logical lines; a CR before LF remains a first-line byte.
      report.stderrLines = 0;
      for (let index = firstLf; index !== -1; index = stderr.indexOf('\n', index + 1)) report.stderrLines += 1;
      const operations = [
        ['failed to inspect docker image', 'inspect-image'],
        ['failed to pull docker image', 'pull-image'],
        ['failed to create docker container:', 'create-container'],
        ['failed to start docker container ', 'start-container'],
        ['failed to inspect docker container:', 'inspect-container'],
        ['failed to read docker logs:', 'read-logs'],
        ['failed to copy docker logs:', 'copy-logs'],
        ['error running container:', 'run-container'],
      ];
      for (const [literal, operation] of operations) {
        if (stderr.includes(literal)) {
          report.stderrDockerOperation = operation;
          break;
        }
      }
      report.stderrContainerExitBucket = 'unclassified';
      // CLI 2.116.0 emits a bare message plus LF with NO_COLOR; never infer a cause.
      if (report.stderrBytes <= 4096) {
        const anchor = 'error running container:';
        const first = stderr.indexOf(anchor);
        if (first !== -1 && stderr.indexOf(anchor, first + anchor.length) === -1) {
          const match = /(?:^|\n)error running container: exit ([1-9][0-9]{0,2})\n/.exec(stderr);
          if (match) {
            const exit = Number(match[1]);
            if (exit <= 255) {
              report.stderrContainerExitBucket = exit === 125 ? 'exit-125'
                : exit === 126 || exit === 127 ? 'exit-126-or-127' : 'other-nonzero';
            }
          }
        }
      }
    }
  } catch {
    // Even malformed objects must yield only the fixed observational fields.
  }
  return report;
}

export function describeStartupOrResetFailure(result, elapsedMs) {
  const report = {
    tag: 'invalid-result',
    exitCode: null,
    elapsedMs: null,
    stdoutBytes: null,
    stderrBytes: null,
    stderrDockerOperation: 'none',
    stderrContainerExitBucket: 'unclassified',
    stderrSqlState: 'none',
    announcedKnownMigrationCount: 0,
    lastAnnouncedKnownMigrationIndex: null,
    stderrPortAllocationMarker: false,
  };
  let code, stdout, stderr;
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return report;
    // Own data properties only; hostile reflection must leave the closed defaults intact.
    code = Object.getOwnPropertyDescriptor(result, 'code')?.value;
    stdout = Object.getOwnPropertyDescriptor(result, 'stdout')?.value;
    stderr = Object.getOwnPropertyDescriptor(result, 'stderr')?.value;
  } catch {
    return report;
  }
  if (!Number.isInteger(code) || code < 0 || code > 255
    || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > Number.MAX_SAFE_INTEGER
    || typeof stdout !== 'string' || typeof stderr !== 'string') return report;
  const limit = 16 * 1024 * 1024;
  if (stdout.length > limit || stderr.length > limit) return report;
  const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(stderr, 'utf8');
  if (stdoutBytes + stderrBytes > limit) return report;
  report.exitCode = code;
  report.elapsedMs = Math.floor(elapsedMs);
  report.stdoutBytes = stdoutBytes;
  report.stderrBytes = stderrBytes;
  report.tag = code === 0 ? 'success' : stderrBytes > 0 ? 'nonzero-with-stderr'
    : stdoutBytes > 0 ? 'nonzero-with-stdout' : 'nonzero-empty-output';
  if (report.tag !== 'nonzero-with-stderr') return report;

  const operations = [
    ['failed to inspect docker image', 'inspect-image'],
    ['failed to pull docker image', 'pull-image'],
    ['failed to create docker container:', 'create-container'],
    ['failed to start docker container ', 'start-container'],
    ['failed to inspect docker container:', 'inspect-container'],
    ['failed to read docker logs:', 'read-logs'],
    ['failed to copy docker logs:', 'copy-logs'],
    ['error running container:', 'run-container'],
  ];
  for (const [literal, operation] of operations) {
    if (stderr.includes(literal)) {
      report.stderrDockerOperation = report.stderrDockerOperation === 'none' ? operation : 'multiple';
    }
  }
  if (stderrBytes <= 4096) {
    const anchor = 'error running container:';
    const first = stderr.indexOf(anchor);
    if (first !== -1 && stderr.indexOf(anchor, first + anchor.length) === -1) {
      const match = /(?:^|\n)error running container: exit ([1-9][0-9]{0,2})\n/.exec(stderr);
      if (match) {
        const exit = Number(match[1]);
        if (exit <= 255) {
          report.stderrContainerExitBucket = exit === 125 ? 'exit-125'
            : exit === 126 || exit === 127 ? 'exit-126-or-127' : 'other-nonzero';
        }
      }
    }
  }
  const sqlStates = ['42601', '42P01', '42702', '42703', '42883', '42501',
    '23505', '23503', '23514', '55P03', '40P01'];
  let firstSqlState;
  for (const match of stderr.matchAll(/ \(SQLSTATE ([0-9A-Z]{5})\)/g)) {
    if (firstSqlState === undefined) {
      firstSqlState = match[1];
      report.stderrSqlState = sqlStates.find((state) => state === firstSqlState) ?? 'unclassified';
    } else if (match[1] !== firstSqlState) {
      report.stderrSqlState = 'multiple';
      break;
    }
  }
  const migrations = [
    '20260905000000_initial.sql',
    '20260906000000_item_field_provenance.sql',
    '20260909070000_item_description_edit.sql',
    '20260909110000_item_optional_collections.sql',
    '20260909180000_ai_request_controls.sql',
    '20260910070000_checked_item_save.sql',
    '20260911040000_ai_analysis_backend.sql',
  ];
  let lastAnnouncement = -1;
  for (const [index, filename] of migrations.entries()) {
    const literal = `Applying migration ${filename}...`;
    let observed = false;
    for (let at = stderr.indexOf(literal); at !== -1; at = stderr.indexOf(literal, at + literal.length)) {
      const end = at + literal.length;
      if ((at === 0 || stderr[at - 1] === '\n')
        && (stderr[end] === '\n' || stderr[end] === '\r' && stderr[end + 1] === '\n')) {
        observed = true;
        if (at > lastAnnouncement) {
          lastAnnouncement = at;
          report.lastAnnouncedKnownMigrationIndex = index + 1;
        }
      }
    }
    if (observed) report.announcedKnownMigrationCount += 1;
  }
  report.stderrPortAllocationMarker = stderr.includes('port is already allocated');
  return report;
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

export function runCommand(command, args, { input, env = commandEnvironment(), timeout = 120_000, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
    fail('REFUSED: invalid command capture limit.');
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, oversized = false, timedOut = false;
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        // Windows does not forward SIGTERM through the CLI's Node/binary wrappers.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          env, shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const receive = (target) => (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) { if (!oversized) terminate(); oversized = true; }
      else target.push(chunk);
    };
    child.stdout.on('data', receive(stdout));
    child.stderr.on('data', receive(stderr));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ code: 2, stdout: '', stderr: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: oversized || timedOut ? 2 : code ?? 2, stdout: oversized ? '' : Buffer.concat(stdout).toString('utf8'), stderr: oversized ? '' : Buffer.concat(stderr).toString('utf8') });
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

export function assertAnalysisServeContract(config, directories, files, help) {
    const sections = [...config.matchAll(/^\[functions\.([^\]]+)\]/gm)].map((match) => match[1]);
    if (JSON.stringify(sections) !== '["analyze-clothing"]'
      || JSON.stringify(directories) !== '["analyze-clothing"]'
      || JSON.stringify([...files].sort()) !== JSON.stringify([
        'deno.d.ts', 'deno.json', 'google-cloud.ts', 'handler.ts', 'index.ts', 'protocol.ts',
      ])
      || !/^\[edge_runtime\]\s*\nenabled = true\s*$/m.test(config)
      || !/^\[functions\.analyze-clothing\]\s*\nenabled = true\s*\nverify_jwt = true\s*$/m.test(config)
      || help?.code !== 0 || !/^ *Serve all Functions locally\./m.test(help.stdout)
      || !/^ *supabase functions serve \[flags\] \[<Function name\.\.\.>\]\s*$/m.test(help.stdout)) {
      fail('REFUSED: the pinned analysis function serve contract does not match.');
    }
  }

export function ownAnalysisProcess(child, lifetimeMs = 600_000, startupMs = 60_000) {
    let exited = false, stopping = false, failed = false, bytes = 0, killTimer;
    const evidence = { exitCode: null, bootError: false, missingModule: false, outputLimit: false };
    let tail = '';
    const closed = new Promise((resolve) => {
      child.once('close', (code) => {
        evidence.exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
        exited = true; resolve();
      });
      child.once('error', () => { failed = true; exited = true; resolve(); });
    });
    const stop = async () => {
      if (stopping) return closed;
      stopping = true;
      clearTimeout(lifetime); clearTimeout(startup);
      if (!exited) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2000);
      }
      await closed;
      clearTimeout(killTimer);
    };
    const expire = () => { failed = true; void stop(); };
    const lifetime = setTimeout(expire, lifetimeMs);
    const startup = setTimeout(expire, startupMs);
    const receive = (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { evidence.outputLimit = true; expire(); return; }
      const text = tail + chunk.toString('utf8');
      evidence.bootError ||= /worker boot error|failed to boot|boot failure/i.test(text);
      evidence.missingModule ||= /module not found|cannot find module/i.test(text);
      tail = text.slice(-64);
      if (evidence.bootError || evidence.missingModule) expire();
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    return {
      stop,
      ready() { clearTimeout(startup); this.assertRunning(); },
      assertRunning() {
        if (failed || exited || stopping) throw new AnalysisStartupError(evidence.bootError ? 'boot-error'
          : evidence.missingModule ? 'missing-module' : evidence.outputLimit ? 'output-limit' : 'child-exit');
      },
    };
  }

export async function probeAnalysisHandler(transport = fetch, timeout = 2000) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new AnalysisStartupError('deadline');
  const response = await transport(`${LOCAL_API}/functions/v1/analyze-clothing`, {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' },
    redirect: 'error', signal: AbortSignal.timeout(Math.min(timeout, 2000)),
  });
  await response.body?.cancel();
  const indicators = {
    status: response.status,
    noStore: response.headers.get('Cache-Control') === 'no-store',
    nosniff: response.headers.get('X-Content-Type-Options') === 'nosniff',
    post: response.headers.get('Access-Control-Allow-Methods') === 'POST',
  };
  return { ...indicators, ready: indicators.status === 204 && indicators.noStore && indicators.nosniff && indicators.post };
}

class AnalysisStartupError extends LocalBackendError {
  constructor(reason) { super(`FAIL: analysis startup ${reason}.`, 1); this.reason = reason; }
}

function startupRemaining(deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new AnalysisStartupError('deadline');
  return remaining;
}

function runtimeTime(value) {
  if (typeof value !== 'string') throw new AnalysisStartupError('reader-failed');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  const ms = match ? Date.parse(`${match[1]}Z`) : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || new Date(ms).toISOString().slice(0, 19) !== match[1]) {
    throw new AnalysisStartupError('reader-failed');
  }
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

function validateRuntime(value) {
  if (value === null) return value;
  if (!value || Object.keys(value).sort().join(',') !== 'id,running,startedAt'
    || typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id)
    || typeof value.running !== 'boolean') throw new AnalysisStartupError('reader-failed');
  runtimeTime(value.startedAt);
  return value;
}

export async function readAnalysisRuntime(deadline, run = runCommand) {
  const call = async (args) => {
    const result = await run('docker', args, { timeout: Math.min(startupRemaining(deadline), 5000), maxOutputBytes: 4096 });
    startupRemaining(deadline);
    if (result.code !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096) {
      throw new AnalysisStartupError('reader-failed');
    }
    return result.stdout;
  };
  const listed = await call(['ps', '-a', '--no-trunc', '--filter',
    'name=^/supabase_edge_runtime_stillroom-wardrobe$', '--format', '{{.ID}} {{.State}}']);
  if (listed === '') return null;
  if (listed.trim().split('\n').length > 1) throw new AnalysisStartupError('reader-ambiguous');
  const match = /^([0-9a-f]{64}) (created|running|paused|restarting|removing|exited|dead)\r?\n?$/.exec(listed);
  if (!match) throw new AnalysisStartupError('reader-failed');
  const inspected = await call(['inspect', '--format', '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}', match[1]]);
  const fields = /^([0-9a-f]{64})\|(true|false)\|([^\r\n]+)\r?\n?$/.exec(inspected);
  if (!fields || fields[1] !== match[1]) throw new AnalysisStartupError('reader-failed');
  return validateRuntime({ id: fields[1], running: fields[2] === 'true', startedAt: fields[3] });
}

export async function waitForAnalysisHandler(owned, { deadline, spawnedAt, previous, readRuntime = readAnalysisRuntime }, transport = fetch) {
  const evidence = { replacement: false, running: false, fresh: false, stable: false,
    elapsedMs: 0, reason: 'deadline', lastHttp: null, transportFailure: false };
  let waitingReason = previous === null ? 'absent-no-replacement' : 'identity-unchanged';
  const healthy = () => { startupRemaining(deadline); owned.assertRunning(); };
  const metadata = async () => {
    healthy();
    let value;
    try { value = validateRuntime(await readRuntime(deadline)); }
    catch (error) { owned.assertRunning(); throw error; }
    healthy();
    return value;
  };
  const same = (a, b) => b !== null && a.id === b.id && a.running === b.running && a.startedAt === b.startedAt;
  const probe = async () => {
    healthy();
    let result;
    try {
      result = await probeAnalysisHandler(transport, Math.min(startupRemaining(deadline), 2000));
      evidence.lastHttp = { status: result.status, noStore: result.noStore, nosniff: result.nosniff, post: result.post };
    } catch {
      evidence.transportFailure = true;
      healthy();
      throw new AnalysisStartupError('signature-mismatch');
    }
    healthy();
    if (!result.ready) throw new AnalysisStartupError('signature-mismatch');
  };
  try {
    validateRuntime(previous);
    if (!Number.isSafeInteger(spawnedAt) || spawnedAt > Date.now() || deadline - spawnedAt > 60_000) {
      throw new AnalysisStartupError('reader-failed');
    }
    for (;;) {
      const current = await metadata();
      evidence.replacement = current !== null && (previous === null || current.id !== previous.id);
      waitingReason = current === null ? 'absent-no-replacement' : evidence.replacement ? 'deadline' : 'identity-unchanged';
      evidence.running = current?.running === true;
      evidence.fresh = current !== null && (previous === null
        ? runtimeTime(current.startedAt) >= BigInt(spawnedAt) * 1_000_000n
        : runtimeTime(current.startedAt) > runtimeTime(previous.startedAt));
      if (evidence.replacement && !evidence.fresh) throw new AnalysisStartupError('reader-failed');
      if (evidence.replacement && evidence.running) {
        waitingReason = 'deadline';
        await probe();
        if (!same(current, await metadata())) throw new AnalysisStartupError('identity-unstable');
        await probe();
        if (!same(current, await metadata())) throw new AnalysisStartupError('identity-unstable');
        evidence.stable = true;
        healthy(); owned.ready();
        evidence.reason = 'ready';
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, startupRemaining(deadline))));
    }
  } catch (error) {
    evidence.reason = error instanceof AnalysisStartupError ? error.reason : 'reader-failed';
    if (evidence.reason === 'deadline') evidence.reason = waitingReason;
    throw new AnalysisStartupError(evidence.reason);
  } finally {
    evidence.elapsedMs = Number.isSafeInteger(deadline) ? Math.max(0, Math.min(60_000, Date.now() - (deadline - 60_000))) : 0;
    try { console.log('B1-READINESS ' + JSON.stringify(evidence)); } catch { /* Evidence cannot change readiness. */ }
  }
}

export async function startAnalysisServer() {
    await assertProjectConfig();
    await requireDocker();
    await requireLocalContainer();
    const directory = path.join(ROOT, 'supabase', 'functions');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
      fail('REFUSED: unexpected local function inventory.');
    }
    const files = await readdir(path.join(directory, 'analyze-clothing'), { withFileTypes: true });
    if (files.some((entry) => !entry.isFile() || entry.isSymbolicLink())) fail('REFUSED: unexpected analysis source inventory.');
    assertAnalysisServeContract(await readFile(path.join(ROOT, 'supabase', 'config.toml'), 'utf8'),
      entries.map((entry) => entry.name), files.map((entry) => entry.name), await cli(['functions', 'serve', '--help']));
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('supabase/package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    const deadline = Date.now() + 60_000;
    let previous;
    try { previous = await readAnalysisRuntime(deadline); }
    catch (error) {
      try {
        console.log('B1-READINESS ' + JSON.stringify({ replacement: false, running: false, fresh: false, stable: false,
          elapsedMs: Math.max(0, Math.min(60_000, Date.now() - (deadline - 60_000))),
          reason: error instanceof AnalysisStartupError ? error.reason : 'reader-failed', lastHttp: null, transportFailure: false }));
      } catch { /* Evidence cannot replace the primary failure. */ }
      throw new AnalysisStartupError(error instanceof AnalysisStartupError ? error.reason : 'reader-failed');
    }
    const spawnedAt = Date.now();
    startupRemaining(deadline);
    const child = spawn(process.execPath, [path.join(path.dirname(packagePath), pkg.bin.supabase),
      '--agent', 'no', '--workdir', ROOT, 'functions', 'serve'], {
      cwd: ROOT, env: commandEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const owned = ownAnalysisProcess(child, 600_000, Math.max(1, deadline - Date.now()));
    try {
      await waitForAnalysisHandler(owned, { deadline, spawnedAt, previous });
      return owned;
    } catch (error) {
      await owned.stop();
      throw error;
    }

}

const servedCodes = new Set(['INVALID_INPUT', 'UNAUTHENTICATED', 'UNAVAILABLE', 'CONSENT_REQUIRED',
  'CONFLICT', 'ACTIVE_DRAFT', 'TERMINAL', 'TOO_LARGE', 'UNSUPPORTED_MEDIA', 'RATE_LIMIT', 'ALLOWANCE',
  'UNCONFIGURED', 'INACTIVE', 'CONFIG_CHANGED', 'ANALYSIS_FAILED', 'TIMEOUT', 'unrecognized']);
const servedPrefix = 'B1-SERVED ';
const servedNotice = 'B1-SERVED evidence-rejected-or-overflow';

export function servedCode(value) { return servedCodes.has(value) ? value : 'unrecognized'; }

function servedRecord(value) {
  return value !== null && typeof value === 'object'
    && Object.keys(value).sort().join(',') === 'case,code,jsonParsed,noStore,nosniff,owner,status,transport,vary'
    && ['served-owner', 'served-invalid-token'].includes(value.case) && ['A', 'B'].includes(value.owner)
    && Number.isInteger(value.status) && (value.status === 0 || (value.status >= 100 && value.status <= 599))
    && ['noStore', 'nosniff', 'vary', 'jsonParsed'].every((key) => typeof value[key] === 'boolean')
    && servedCodes.has(value.code) && ['none', 'request-failed', 'body-failed'].includes(value.transport)
    && (value.status !== 0 || (!value.noStore && !value.nosniff && !value.vary && !value.jsonParsed
      && value.code === 'unrecognized' && value.transport === 'request-failed'));
}

export function createServedDiagnostics(emit = console.log) {
  let count = 0, bytes = 0, rejected = false;
  return (record) => {
    if (rejected) return;
    let line;
    try { if (servedRecord(record)) line = servedPrefix + JSON.stringify(record); } catch { /* Reject non-record input. */ }
    if (!line || ++count > 8 || (bytes += Buffer.byteLength(line + '\n')) > 2048) {
      rejected = true; emit(servedNotice); return;
    }
    emit(line);
  };
}

export function parseServedDiagnostics(stdout, stderr) {
  const records = [];
  let bytes = 0;
  try {
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      if (!line.startsWith(servedPrefix)) continue;
      bytes += Buffer.byteLength(line + '\n');
      if (bytes > 2048 || records.length >= 8) throw new Error();
      const record = JSON.parse(line.slice(servedPrefix.length));
      if (!servedRecord(record)) throw new Error();
      records.push(servedPrefix + JSON.stringify(record));
    }
    return records;
  } catch { return [servedNotice]; }
}
