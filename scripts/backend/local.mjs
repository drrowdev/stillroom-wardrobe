import { spawn } from 'node:child_process';
import http from 'node:http';
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
      report.stderrDockerErrorMarker = 'unclassified';
      if (report.stderrBytes <= 4096) {
        let marker = 'none', lineStart = 0;
        for (let lf = stderr.indexOf('\n'); lf !== -1; lf = stderr.indexOf('\n', lineStart)) {
          let line = stderr.slice(lineStart, stderr[lf - 1] === '\r' ? lf - 1 : lf);
          lineStart = lf + 1;
          if (line.includes('\r')) continue;
          if (line.startsWith('docker: ')) line = line.slice('docker: '.length);
          const envelope = 'Error response from daemon: ';
          if (!line.startsWith(envelope)) continue;
          const message = line.slice(envelope.length);
          let category = 'unclassified';
          if (message.startsWith('pull access denied for ') || message.startsWith('manifest for ')
            || message.startsWith('failed to resolve reference ')) category = 'image-resolution-or-registry';
          else if (message.startsWith('network ') && message.endsWith(' not found')
            && message.length > 'network '.length + ' not found'.length) category = 'missing-network';
          else if (message.startsWith('Conflict. The container name ')) category = 'container-name-conflict';
          else if (message.startsWith('failed to create task for container: ')
            || message.startsWith('OCI runtime create failed: ')
            || message.startsWith('OCI runtime start failed: ')) category = 'oci-runtime-start';
          marker = marker === 'none' ? category : marker === category ? marker : 'multiple';
        }
        report.stderrDockerErrorMarker = marker === 'none' ? 'unclassified' : marker;
      }
      // Literal text shapes only, never causes. h:false does not establish that pg-meta ran;
      // i:false does not prove absence of acquisition activity. The separate CI pull step,
      // not either boolean, is the acquisition evidence.
      const diag = { h: null, i: null, s: 'over', f: 'over' };
      if (report.stderrBytes <= 4096) {
        diag.h = false; diag.i = false; diag.s = 'none'; diag.f = 'none';
        const trailer = "Run 'docker run --help' for more information";
        const imageHead = "Unable to find image '", imageTail = "' locally";
        const envelope = 'Error response from daemon: ';
        const request = (text) => text.startsWith('Get "https://') || text.startsWith('Head "https://');
        const ends = (text, suffixes) => suffixes.some((suffix) => text.endsWith(suffix));
        const families = [
          [(text) => text.startsWith('failed to resolve reference "') && text.endsWith('429 Too Many Requests'), 'rate'],
          [(text) => text.startsWith('toomanyrequests: '), 'rate'],
          [(text) => text.startsWith('unauthorized: ') || text.startsWith('denied: '), 'auth'],
          [(text) => text.startsWith('manifest unknown'), 'nomanifest'],
          [(text) => text.startsWith('pull access denied for ') || text.startsWith('manifest for ')
            || text.startsWith('failed to resolve reference '), 'img-ref'],
          [(text) => text.startsWith('network ') && text.endsWith(' not found')
            && text.length > 'network '.length + ' not found'.length, 'net-missing'],
          [(text) => text.startsWith('Conflict. The container name '), 'conflict'],
          [(text) => text.startsWith('failed to create task for container: ')
            || text.startsWith('OCI runtime create failed: ') || text.startsWith('OCI runtime start failed: '), 'oci'],
          [(text) => request(text) && text.endsWith(': no such host'), 'net-dns'],
          [(text) => request(text) && ends(text, [': i/o timeout',
            '(Client.Timeout exceeded while awaiting headers)', ': context deadline exceeded']), 'net-timeout'],
          [(text) => request(text) && text.endsWith(': connect: connection refused'), 'net-refused'],
          [(text) => request(text) && text.endsWith(': TLS handshake timeout'), 'net-tls'],
          [(text) => text.endsWith(': no space left on device'), 'disk'],
          [(text) => text === 'context canceled', 'canceled'],
          [(text) => text.startsWith('Cannot connect to the Docker daemon at '), 'daemon-down'],
        ];
        const merge = (current, value) => current === 'none' ? value : current === value ? current : 'multi';
        let lineStart = 0;
        for (let lf = stderr.indexOf('\n'); lf !== -1; lf = stderr.indexOf('\n', lineStart)) {
          const line = stderr.slice(lineStart, stderr[lf - 1] === '\r' ? lf - 1 : lf);
          lineStart = lf + 1;
          if (line.includes('\r')) continue;
          if (line === trailer) diag.h = true;
          if (line.startsWith(imageHead) && line.endsWith(imageTail)
            && line.length > imageHead.length + imageTail.length) diag.i = true;
          let rest = line, kind = 'none';
          if (rest.startsWith('docker: ')) { rest = rest.slice('docker: '.length); kind = 'docker'; }
          if (rest.startsWith(envelope)) { rest = rest.slice(envelope.length); kind = 'daemon'; }
          if (kind === 'none') continue;
          diag.s = merge(diag.s, kind);
          diag.f = merge(diag.f, families.find(([test]) => test(rest))?.[1] ?? 'unknown');
        }
      }
      report.dockerDiag = diag;
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
    stderrStatementIndex: null,
    stderrPermissionMarker: 'none',
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
    '20260911200000_checked_ai_item_save.sql',
    '20260913120000_item_lifecycle.sql',
    '20260921193000_azure_terra_analysis.sql',
    '20260922020000_checked_image_changes.sql',
    '20260924100000_garment_colours.sql',
    '20260924100100_azure_colour_manifest.sql',
    '20260925090000_ai_purge_schedule.sql',
    '20260925100000_uniform_id_conflicts.sql',
    '20260925110000_restore_item_save.sql',
    '20260925120000_account_deletion.sql',
    '20260925120100_deletion_receipt_purge_schedule.sql',
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
  const permissionPrefixes = [
    ['must be owner of table ', 'owner-required'],
    ['must be owner of relation ', 'owner-required'],
    ['must be owner of schema ', 'owner-required'],
    ['must be owner of function ', 'owner-required'],
    ['permission denied for table ', 'table-privilege'],
    ['permission denied for schema ', 'schema-privilege'],
    ['permission denied for function ', 'function-privilege'],
    ['new row violates row-level security policy', 'rls-policy-violation'],
    ['target row violates row-level security policy', 'rls-policy-violation'],
  ];
  const permissionSuffix = ' (SQLSTATE 42501)';
  let statementInvalid = false, lineStart = 0;
  // Even complete heads/markers can be echoed SQL: observe shape, never authenticate a cause.
  for (let lf = stderr.indexOf('\n'); lf !== -1; lf = stderr.indexOf('\n', lineStart)) {
    const line = stderr.slice(lineStart, stderr[lf - 1] === '\r' ? lf - 1 : lf);
    lineStart = lf + 1;
    if (line.startsWith('At statement:')) {
      const match = /^At statement: (0|[1-9][0-9]{0,3})$/.exec(line);
      if (!match || match[0] !== line) statementInvalid = true;
      else {
        const index = Number(match[1]);
        if (report.stderrStatementIndex !== null && report.stderrStatementIndex !== index) statementInvalid = true;
        report.stderrStatementIndex = index;
      }
    }
    const delimiter = line.indexOf(': ');
    const messageLength = line.length - permissionSuffix.length - delimiter - 2;
    if (delimiter > 0 && messageLength >= 0
      && !line.includes('\r') && line.endsWith(permissionSuffix)) {
      const category = permissionPrefixes.find(([prefix]) =>
        prefix.length <= messageLength && line.startsWith(prefix, delimiter + 2))?.[1] ?? 'unclassified';
      if (report.stderrPermissionMarker === 'none') report.stderrPermissionMarker = category;
      else if (report.stderrPermissionMarker !== category) report.stderrPermissionMarker = 'multiple';
    }
  }
  if (statementInvalid) report.stderrStatementIndex = null;
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

export function runCommand(command, args, { input, env = commandEnvironment(), timeout = 120_000, maxOutputBytes } = {}) {
  const explicitCaptureLimit = maxOutputBytes !== undefined;
  if (!explicitCaptureLimit) maxOutputBytes = 16 * 1024 * 1024;
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
      const discard = oversized && explicitCaptureLimit;
      resolve({ code: oversized || timedOut ? 2 : code ?? 2, stdout: discard ? '' : Buffer.concat(stdout).toString('utf8'), stderr: discard ? '' : Buffer.concat(stderr).toString('utf8') });
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

export async function withAnalyzedSaveFixtureLock(ownerId, itemId, imageId, resource, operation) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || process.env.ALLOW_SECURITY_TESTS !== '1'
    || !uuid.test(ownerId) || !uuid.test(itemId) || !uuid.test(imageId)
    || !itemId.startsWith('b229') || !imageId.startsWith('b229')
    || !['profile', 'item', 'image', 'objects'].includes(resource)) fail('REFUSED: B2 fixture lock boundary.');
  await requireLocalContainer();
  const target = resource === 'profile' ? `public.profiles where owner_id='${ownerId}'`
    : resource === 'item' ? `public.items where owner_id='${ownerId}' and id='${itemId}'`
      : resource === 'image' ? `public.item_images where owner_id='${ownerId}' and id='${imageId}'`
        : `storage.objects where bucket_id='wardrobe' and name in ('${ownerId}/${itemId}/${imageId}/main.jpg','${ownerId}/${itemId}/${imageId}/thumb.jpg')`;
  const child = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password',
    '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], {
    cwd: ROOT, env: commandEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let resolveReady, rejectReady, output = '', bytes = 0, failure, releaseError, releasing = false, primaryError = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const reject = (message) => {
    failure ??= new LocalBackendError(message, 1);
    rejectReady(failure);
    child.kill('SIGTERM');
  };
  const closed = new Promise((resolve) => {
    child.once('close', (code) => {
      if (!releasing) reject('FAIL: B2 lock child closed before release.');
      resolve(code);
    });
    child.once('error', () => { reject('FAIL: B2 lock child failed.'); resolve(1); });
  });
  const timer = setTimeout(() => reject('FAIL: B2 fixture lock deadline.'), 15_000);
  child.stdin.on('error', () => reject('FAIL: B2 fixture lock input.'));
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 4096) { reject('FAIL: B2 fixture lock output bound.'); return; }
    output += chunk.toString();
    if (output.trim() === 'B2_LOCK_HELD') resolveReady();
  });
  child.stderr.on('data', () => reject('FAIL: B2 fixture lock SQL.'));
  try {
    child.stdin.write(`begin; do $$ declare n integer; begin perform 1 from ${target} for update nowait;
      get diagnostics n = row_count; if n<>${resource === 'objects' ? 2 : 1} then raise exception 'Fixture absent'; end if;
      end $$;\n\\echo B2_LOCK_HELD\n`);
    await ready;
    await operation();
    if (failure) throw failure;
  } catch (error) {
    primaryError = true;
    throw error;
  } finally {
    releasing = true;
    if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end('rollback;\n');
    const code = await closed;
    clearTimeout(timer);
    if (code !== 0 || failure) {
      if (primaryError) console.error('FAIL: B2 fixture lock release; primary failure retained.');
      else releaseError = failure ?? new LocalBackendError('FAIL: B2 fixture lock release.', 1);
    }
  }
  if (releaseError) throw releaseError;
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

export function assertAnalysisServeContract(config, directories, files, help, finalizerFiles, imageChangeFiles,
  deleteAccountFiles, sharedFiles) {
    const sections = [...config.matchAll(/^\[functions\.([^\]]+)\]/gm)].map((match) => match[1]);
    if (JSON.stringify(sections.sort()) !== '["analyze-clothing","delete-account","finalize-analyzed-item","finalize-image-change"]'
      || JSON.stringify([...directories].sort()) !== '["_shared","analyze-clothing","delete-account","finalize-analyzed-item","finalize-image-change"]'
      || JSON.stringify([...files].sort()) !== JSON.stringify([
        'azure-openai.ts', 'deno.d.ts', 'deno.json', 'google-cloud.ts', 'handler.ts', 'index.ts', 'protocol.ts',
      ])
      || !Array.isArray(finalizerFiles)
      || JSON.stringify([...finalizerFiles].sort()) !== '["deno.json","handler.ts","index.ts","verify-image.ts"]'
      || !Array.isArray(imageChangeFiles)
      || JSON.stringify([...imageChangeFiles].sort()) !== '["deno.json","handler.ts","index.ts"]'
      || !Array.isArray(deleteAccountFiles)
      || JSON.stringify([...deleteAccountFiles].sort()) !== '["deno.json","handler.ts","index.ts"]'
      || !Array.isArray(sharedFiles)
      || JSON.stringify([...sharedFiles].sort()) !== '["deletion-loop.ts","deletion-service.ts"]'
      || !/^\[edge_runtime\]\s*\nenabled = true\s*$/m.test(config)
      || !/^\[functions\.analyze-clothing\]\s*\nenabled = true\s*\nverify_jwt = true\s*$/m.test(config)
      || !/^\[functions\.finalize-analyzed-item\]\s*\nenabled = true\s*\nverify_jwt = true\s*$/m.test(config)
      || !/^\[functions\.finalize-image-change\]\s*\nenabled = true\s*\nverify_jwt = true\s*$/m.test(config)
      || !/^\[functions\.delete-account\]\s*\nenabled = true\s*\nverify_jwt = true\s*$/m.test(config)
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

export async function probeAnalysisHandler(transport = closingFetch, timeout = 2000) {
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

// Every served function besides analyze-clothing. Each worker must answer its own preflight before "ready".
export const WARM_FUNCTIONS = Object.freeze(['finalize-analyzed-item', 'finalize-image-change', 'delete-account']);

export async function probeServedFunction(name, transport = closingFetch, timeout = 2000) {
  if (!WARM_FUNCTIONS.includes(name)) throw new AnalysisStartupError('reader-failed');
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new AnalysisStartupError('deadline');
  const response = await transport(`${LOCAL_API}/functions/v1/${name}`, {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' },
    redirect: 'manual', signal: AbortSignal.timeout(Math.min(timeout, 2000)),
  });
  await response.body?.cancel();
  const signed = response.headers.get('Cache-Control') === 'no-store'
    && response.headers.get('X-Content-Type-Options') === 'nosniff'
    && response.headers.get('Access-Control-Allow-Methods') === 'POST';
  return { status: response.status, signed, ready: response.status === 204 && signed };
}

// Only gateway 404/502/503 answers (before the worker serves) and transport failures are retried until the startup
// deadline. Any other status, or a 204 without the handler's own signature, fails at once without reading the body.
// Only a refused or reset connection, a socket error or this probe's own timeout means the worker may still boot.
function transientWarmFailure(error) {
  try {
    if (error?.name === 'TimeoutError') return true;
    return error instanceof TypeError && ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code);
  } catch { return false; }
}

export async function warmServedFunctions(owned, deadline, transport = closingFetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const started = Date.now();
  const evidence = { functions: 0, attempts: 0, elapsedMs: 0, reason: 'ready', lastStatus: null };
  let current = WARM_FUNCTIONS[0];
  try {
    for (const name of WARM_FUNCTIONS) {
      current = name;
      for (;;) {
        startupRemaining(deadline); owned.assertRunning();
        evidence.attempts++;
        let result = null;
        try {
          result = await probeServedFunction(name, transport, Math.min(startupRemaining(deadline), 2000));
          evidence.lastStatus = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 0;
        } catch (error) {
          evidence.lastStatus = 'transport';
          if (error instanceof AnalysisStartupError) throw error;
          if (!transientWarmFailure(error)) throw new AnalysisStartupError('transport-other');
        }
        owned.assertRunning();
        if (result?.ready) break;
        if (result?.status === 204) throw new AnalysisStartupError('signature-mismatch');
        // Only gateway answers before the worker serves are transient; any other status fails at once.
        if (result !== null && ![404, 502, 503].includes(result.status)) {
          const status = result.status;
          const statusClass = Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other';
          throw new AnalysisStartupError(`status-${statusClass}`);
        }
        await pause(Math.min(250, startupRemaining(deadline)));
      }
      evidence.functions++;
    }
  } catch (error) {
    const reason = error instanceof AnalysisStartupError ? error.reason : 'reader-failed';
    evidence.reason = `warm-${current}-${reason}`;
    throw new AnalysisStartupError(evidence.reason);
  } finally {
    evidence.elapsedMs = Math.max(0, Math.min(60_000, Date.now() - started));
    try { console.log('B1-WARM ' + JSON.stringify(evidence)); } catch { /* Evidence cannot change readiness. */ }
  }
}

// Readiness, warm-up and settle probes each use a fresh connection that is closed afterwards, so none of them leaves
// a pooled keep-alive socket behind for the next request. Failures are shaped like fetch's own transport errors.
export function closingFetch(url, { method = 'GET', headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const request = http.request(url, { method, headers, agent: false, signal }, (response) => {
      const values = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) values.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      response.on('error', () => {});
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers: values, body: { cancel: async () => { response.destroy(); } } });
    });
    request.on('error', (error) => reject(signal?.aborted ? signal.reason
      : Object.assign(new TypeError('fetch failed'), { cause: { code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' } })));
    request.end();
  });
}

// True only when fetch failed before any response because the connection was closed or reset.
export function failedBeforeResponse(error) {
  try {
    return error instanceof TypeError && error.message === 'fetch failed'
      && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code);
  } catch { return false; }
}

// Repeats an operation only after a connection closed or reset before any response, at most `attempts` times.
// A response of any status, or any other failure, is returned or thrown at once.
export async function retryBeforeResponse(operation, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (attempt >= attempts || !failedBeforeResponse(error)) throw error; }
  }
}

// `supabase functions serve` reloads Kong after it starts the runtime. The reload's old nginx workers close their
// idle keep-alive connections, so a request right after readiness can meet a socket the gateway is closing. The
// reload is observed through Kong's worker processes: it is done once no worker is draining and none is from before.
const KONG_CONTAINER = `supabase_kong_${PROJECT_ID}`;
export function parseKongWorkers(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16384) return null;
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!/^\s*PID\s+/.test(lines[0] ?? '')) return null;
  const workers = [];
  let draining = 0;
  for (const line of lines.slice(1)) {
    const match = /^\s*(\d{1,10})\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    if (!match[2].startsWith('nginx: worker process')) continue;
    if (match[2].includes('is shutting down')) draining++; else workers.push(match[1]);
  }
  return workers.length || draining ? { workers, draining } : null;
}
export async function readKongWorkers(deadline, run = runCommand) {
  let result;
  try {
    result = await run('docker', ['top', KONG_CONTAINER, '-o', 'pid,args'],
      { timeout: Math.min(startupRemaining(deadline), 5000), maxOutputBytes: 16384 });
  } catch (error) {
    if (error instanceof AnalysisStartupError) throw error;
    return null;
  }
  return result?.code === 0 ? parseKongWorkers(result.stdout) : null;
}
export function kongReloaded(before, now) {
  return now !== null && now.draining === 0 && now.workers.length > 0 && now.workers.every((pid) => !before.workers.includes(pid));
}
export async function probeAuthHealth(key, transport = closingFetch, timeout = 2000) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new AnalysisStartupError('deadline');
  const response = await transport(`${LOCAL_API}/auth/v1/health`, {
    method: 'GET', headers: { apikey: key }, redirect: 'error', signal: AbortSignal.timeout(Math.min(timeout, 2000)),
  });
  await response.body?.cancel();
  return response.status;
}

// Waits up to 15 s for the observed Kong reload, always leaving 7 s of the startup deadline, then for three
// consecutive healthy Auth answers 250 ms apart through the gateway. Only a closed, reset or refused connection, this probe's own timeout and a gateway 502/503
// are waited through; anything else, or the deadline, fails closed. When the workers cannot be read, or no reload
// is seen within the bound (the CLI's reload is best-effort), the healthy answers alone are a timing heuristic.
const RELOAD_WAIT_MS = 15_000;
// Enough for three health probes at their 2 s timeout and the pauses between them.
const HEALTH_RESERVE_MS = 7_000;
export async function settleGateway(owned, deadline, { before, key, readWorkers = readKongWorkers, transport = closingFetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const started = Date.now();
  const evidence = { reload: before === null ? 'unobserved' : 'pending', attempts: 0, socketErrors: 0, elapsedMs: 0,
    reason: 'ready', lastStatus: null };
  const observeUntil = Math.min(started + RELOAD_WAIT_MS, deadline - HEALTH_RESERVE_MS);
  let healthy = 0;
  try {
    for (;;) {
      startupRemaining(deadline); owned.assertRunning();
      if (evidence.reload === 'pending') {
        // The observation has its own budget, checked before each read, so a slow read cannot use up the time
        // the health answers need.
        if (observeUntil - Date.now() <= 0) { evidence.reload = 'not-seen'; continue; }
        let now;
        try { now = await readWorkers(observeUntil); }
        catch (error) {
          if (!(error instanceof AnalysisStartupError && error.reason === 'deadline')) throw error;
          evidence.reload = 'not-seen'; continue;
        }
        if (now === null) evidence.reload = observeUntil - Date.now() <= 0 ? 'not-seen' : 'unobserved';
        else if (kongReloaded(before, now)) evidence.reload = 'observed';
        else if (observeUntil - Date.now() <= 0) evidence.reload = 'not-seen';
        else { await pause(Math.min(250, observeUntil - Date.now())); continue; }
      }
      evidence.attempts++;
      let status = null;
      try {
        status = await probeAuthHealth(key, transport, Math.min(startupRemaining(deadline), 2000));
        evidence.lastStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
      } catch (error) {
        evidence.lastStatus = 'transport';
        if (error instanceof AnalysisStartupError) throw error;
        if (!transientWarmFailure(error)) throw new AnalysisStartupError('transport-other');
        evidence.socketErrors++;
      }
      owned.assertRunning();
      if (status === 200) {
        if (++healthy >= 3) return;
      } else {
        healthy = 0;
        if (status !== null && ![502, 503].includes(status)) {
          throw new AnalysisStartupError(`status-${Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other'}`);
        }
      }
      await pause(Math.min(250, startupRemaining(deadline)));
    }
  } catch (error) {
    const reason = error instanceof AnalysisStartupError ? error.reason : 'reader-failed';
    evidence.reason = `gateway-${reason}`;
    throw new AnalysisStartupError(evidence.reason);
  } finally {
    evidence.elapsedMs = Math.max(0, Math.min(60_000, Date.now() - started));
    try { console.log('B1-GATEWAY ' + JSON.stringify(evidence)); } catch { /* Evidence cannot change readiness. */ }
  }
}

// Fixed, content-free step and cause codes for rehearsal failures. Anything outside the lists prints as "other".
export const PROBE_STEPS = Object.freeze([
  'server-start', 'server-running', 'fixture', 'child',
  'replacement-create', 'replacement-reserve', 'replacement-upload-thumb', 'replacement-incomplete',
  'replacement-upload-main', 'replacement-complete', 'replacement-verify', 'recovery-accept', 'recovery-complete',
  'stale-caption', 'completion-race', 'replacement-cleanup',
  'colour-sign-in', 'colour-manual-save', 'colour-invalid-saves', 'colour-controls', 'colour-consent',
  'colour-analysis-claim', 'colour-analysis-finish', 'colour-analyzed-reserve', 'colour-analyzed-upload',
  'colour-analyzed-finalize', 'colour-history', 'colour-v2-claim', 'colour-target',
  'b2-sign-in', 'b2-analysis-request', 'b2-reserve-refusals', 'b2-reserve', 'b2-upload', 'b2-phase',
]);
const PROBE_HTTP = [400, 401, 403, 404, 409, 429, 500, 502, 503, 504];
const STARTUP_REASONS = ['deadline', 'reader-failed', 'reader-ambiguous', 'identity-unstable', 'signature-mismatch',
  'boot-error', 'missing-module', 'output-limit', 'child-exit', 'absent-no-replacement', 'identity-unchanged',
  'replacement-not-started', 'replacement-not-serving'];
export const PROBE_CAUSES = Object.freeze([
  ...PROBE_HTTP.map((status) => `http-${status}`), 'http-4xx', 'http-5xx', 'http-other',
  'transport-timeout', 'transport-aborted', 'transport-refused', 'transport-reset', 'transport-socket', 'transport-failed',
  'unexpected-body', 'assert', ...STARTUP_REASONS.map((reason) => `startup-${reason}`), 'startup-warm', 'startup-gateway', 'other',
]);
const PROBE_LINE = /^PROBE-REASON ([a-z0-9-]{1,48}) ([a-z0-9-]{1,48})$/;
let probeState = { step: null, cause: null };

export function probeStep(step) {
  probeState = { step: PROBE_STEPS.includes(step) ? step : 'other', cause: null };
}
export function probeCause(cause) {
  if (probeState.step !== null && probeState.cause === null) probeState.cause = PROBE_CAUSES.includes(cause) ? cause : 'other';
}
export function resetProbe() { probeState = { step: null, cause: null }; }
export function probeHttpCause(status) {
  if (PROBE_HTTP.includes(status)) return `http-${status}`;
  return Number.isInteger(status) && status >= 400 && status < 500 ? 'http-4xx'
    : Number.isInteger(status) && status >= 500 && status < 600 ? 'http-5xx' : 'http-other';
}
export function probeErrorCause(error) {
  try {
    if (error instanceof AnalysisStartupError) {
      if (typeof error.reason === 'string' && error.reason.startsWith('warm-')) return 'startup-warm';
      if (typeof error.reason === 'string' && error.reason.startsWith('gateway-')) return 'startup-gateway';
      return STARTUP_REASONS.includes(error.reason) ? `startup-${error.reason}` : 'other';
    }
    if (error instanceof Error && error.message === 'EVIDENCE_REQUIRED') return 'assert';
    if (error instanceof SyntaxError) return 'unexpected-body';
    if (error?.name === 'TimeoutError') return 'transport-timeout';
    if (error?.name === 'AbortError') return 'transport-aborted';
    if (error instanceof TypeError && error.message === 'fetch failed') {
      const code = error.cause?.code;
      return code === 'ECONNREFUSED' ? 'transport-refused' : code === 'ECONNRESET' ? 'transport-reset'
        : typeof code === 'string' && code.startsWith('UND_ERR_SOCKET') ? 'transport-socket' : 'transport-failed';
    }
  } catch { /* Classification never replaces the failure. */ }
  return 'other';
}
function probeCodes(error) {
  const { step, cause } = probeState;
  resetProbe();
  if (step === null) return null;
  const resolved = cause ?? probeErrorCause(error);
  return [PROBE_STEPS.includes(step) ? step : 'other', PROBE_CAUSES.includes(resolved) ? resolved : 'other'];
}
// Suffix for a FAIL line: empty unless a step was marked since the last reset.
export function probeFailureDetail(error) {
  const codes = probeCodes(error);
  return codes ? `; step=${codes[0]}; cause=${codes[1]}` : '';
}
// A child process reports its codes as one line; the parent adopts them only if both are known codes.
export function probeReasonLine(error) {
  const codes = probeCodes(error);
  return codes ? `PROBE-REASON ${codes[0]} ${codes[1]}` : null;
}
export function adoptProbeReason(output) {
  if (typeof output !== 'string' || output.length > 65_536) return;
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith('PROBE-REASON'));
  const match = lines.length === 1 ? PROBE_LINE.exec(lines[0]) : null;
  if (lines.length === 0) return;
  probeStep(match && PROBE_STEPS.includes(match[1]) ? match[1] : 'other');
  probeCause(match && PROBE_CAUSES.includes(match[2]) ? match[2] : 'other');
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
  if (value.startedAt === null) {
    if (value.running) throw new AnalysisStartupError('reader-failed');
  } else runtimeTime(value.startedAt);
  return value;
}

const RUNTIME_LIST = ['ps', '-a', '--no-trunc', '--filter', 'name=^/supabase_edge_runtime_stillroom-wardrobe$', '--format', '{{.ID}} {{.State}}'];
const RUNTIME_LINE = /^([0-9a-f]{64}) (created|running|paused|restarting|removing|exited|dead)\r?\n?$/;

export async function readAnalysisRuntime(deadline, run = runCommand) {
  const observation = { schemaVersion: 1, step: 'ps-call', commandCode: null, listedState: null };
  let currentResult = null, original = null;
  const call = async (args, { allowGone = false } = {}) => {
    currentResult = null; observation.commandCode = null;
    const result = await run('docker', args, { timeout: Math.min(startupRemaining(deadline), 5000), maxOutputBytes: 4096 });
    startupRemaining(deadline);
    currentResult = result;
    observation.step = observation.step === 'ps-call' ? 'ps-result' : 'inspect-result';
    const code = result.code;
    // Only a bounded, well-formed exit 1 of the just-listed ID may mean the container disappeared meanwhile.
    const gone = allowGone && code === 1;
    if (!gone && code !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096) {
      throw new AnalysisStartupError('reader-failed');
    }
    return gone ? null : result.stdout;
  };
  // Re-list with the same exact-name filter, parser, limits and original deadline. Absence is confirmed only when
  // the container is gone, or the same ID is removing/dead; anything else stays reader-failed.
  const confirmGone = async (id) => {
    original = { ...observation, commandCode: 1 };
    let relisted;
    try {
      observation.step = 'ps-call';
      relisted = await call(RUNTIME_LIST);
    } catch { throw new AnalysisStartupError('reader-failed'); }
    if (relisted === '') return null;
    const again = RUNTIME_LINE.exec(relisted);
    if (again && again[1] === id && (again[2] === 'removing' || again[2] === 'dead')) return null;
    throw new AnalysisStartupError('reader-failed');
  };
  try {
    const listed = await call(RUNTIME_LIST);
    observation.step = 'ps-shape';
    if (listed === '') return null;
    if (listed.trim().split('\n').length > 1) throw new AnalysisStartupError('reader-ambiguous');
    const match = RUNTIME_LINE.exec(listed);
    if (!match) throw new AnalysisStartupError('reader-failed');
    observation.listedState = match[2];
    observation.step = 'inspect-call';
    const inspected = await call(['inspect', '--format', '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}', match[1]], { allowGone: true });
    if (inspected === null) return await confirmGone(match[1]);
    observation.step = 'inspect-shape';
    const fields = /^([0-9a-f]{64})\|(true|false)\|([^\r\n]+)\r?\n?$/.exec(inspected);
    if (!fields || fields[1] !== match[1]) throw new AnalysisStartupError('reader-failed');
    const startedAt = match[2] === 'created' && fields[2] === 'false' && fields[3] === '0001-01-01T00:00:00Z'
      ? null : fields[3];
    observation.step = 'runtime-validation';
    return validateRuntime({ id: fields[1], running: fields[2] === 'true', startedAt });
  } catch (error) {
    try {
      // Classify only after the original failure, without invoking result accessors. A failed re-list reports the
      // original inspect observation.
      if (original === null) {
        const descriptor = currentResult !== null && typeof currentResult === 'object'
          ? Object.getOwnPropertyDescriptor(currentResult, 'code') : undefined;
        if (descriptor && Object.hasOwn(descriptor, 'value') && Number.isInteger(descriptor.value)
          && descriptor.value >= 0 && descriptor.value <= 255) observation.commandCode = descriptor.value;
      }
      const line = 'B1-RUNTIME-READ ' + JSON.stringify(original ?? observation);
      if (Buffer.byteLength(line + '\n', 'utf8') <= 512 && !/[\r\n]/.test(line)) console.log(line);
    } catch { /* Diagnostic failure cannot replace the original thrown value. */ }
    throw error;
  }
}

export async function waitForAnalysisHandler(owned, { deadline, spawnedAt, previous, readRuntime = readAnalysisRuntime }, transport = closingFetch) {
  const evidence = { replacement: false, running: false, fresh: false, stable: false,
    elapsedMs: 0, reason: 'deadline', lastHttp: null, transportFailure: false };
  let waitingReason = previous === null ? 'absent-no-replacement' : 'identity-unchanged';
  let candidate = null;
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
      evidence.transportFailure = false;
    } catch {
      evidence.transportFailure = true;
      healthy();
      return false;
    }
    healthy();
    return result.ready;
  };
  try {
    validateRuntime(previous);
    if (!Number.isSafeInteger(spawnedAt) || spawnedAt > Date.now() || deadline - spawnedAt > 60_000) {
      throw new AnalysisStartupError('reader-failed');
    }
    for (;;) {
      const current = await metadata();
      if (candidate && (current === null || candidate.id !== current.id
        || candidate.startedAt !== null && candidate.startedAt !== current.startedAt)) {
        throw new AnalysisStartupError('identity-unstable');
      }
      evidence.replacement = current !== null && (previous === null || current.id !== previous.id);
      waitingReason = current === null ? 'absent-no-replacement' : !evidence.replacement ? 'identity-unchanged'
        : current.startedAt === null ? 'replacement-not-started' : 'replacement-not-serving';
      evidence.running = current?.running === true;
      evidence.fresh = current !== null && current.startedAt !== null && (previous === null || previous.startedAt === null
        ? true : runtimeTime(current.startedAt) > runtimeTime(previous.startedAt))
        && runtimeTime(current.startedAt) >= BigInt(spawnedAt) * 1_000_000n;
      if (evidence.replacement) {
        if (current.startedAt !== null && !evidence.fresh) throw new AnalysisStartupError('reader-failed');
        candidate = { id: current.id, startedAt: current.startedAt };
      }
      if (evidence.replacement && evidence.running && await probe()) {
        if (!same(current, await metadata())) throw new AnalysisStartupError('identity-unstable');
        if (!await probe()) throw new AnalysisStartupError('signature-mismatch');
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
    const finalizerFiles = await readdir(path.join(directory, 'finalize-analyzed-item'), { withFileTypes: true });
    if (finalizerFiles.some((entry) => !entry.isFile() || entry.isSymbolicLink())) fail('REFUSED: unexpected finalizer source inventory.');
    const imageChangeFiles = await readdir(path.join(directory, 'finalize-image-change'), { withFileTypes: true });
    if (imageChangeFiles.some((entry) => !entry.isFile() || entry.isSymbolicLink())) fail('REFUSED: unexpected image-change source inventory.');
    const deleteAccountFiles = await readdir(path.join(directory, 'delete-account'), { withFileTypes: true });
    const sharedFiles = await readdir(path.join(directory, '_shared'), { withFileTypes: true });
    if ([...deleteAccountFiles, ...sharedFiles].some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      fail('REFUSED: unexpected account-deletion source inventory.');
    }
    assertAnalysisServeContract(await readFile(path.join(ROOT, 'supabase', 'config.toml'), 'utf8'),
      entries.map((entry) => entry.name), files.map((entry) => entry.name), await cli(['functions', 'serve', '--help']),
      finalizerFiles.map((entry) => entry.name), imageChangeFiles.map((entry) => entry.name),
      deleteAccountFiles.map((entry) => entry.name), sharedFiles.map((entry) => entry.name));
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('supabase/package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    const { key } = await localStatus();
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
    // Kong's workers before serve starts, to observe the reload that serve triggers afterwards.
    const kongBefore = await readKongWorkers(deadline);
    const spawnedAt = Date.now();
    startupRemaining(deadline);
    const child = spawn(process.execPath, [path.join(path.dirname(packagePath), pkg.bin.supabase),
      '--agent', 'no', '--workdir', ROOT, 'functions', 'serve'], {
      cwd: ROOT, env: commandEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const owned = ownAnalysisProcess(child, 600_000, Math.max(1, deadline - Date.now()));
    try {
      await waitForAnalysisHandler(owned, { deadline, spawnedAt, previous });
      await warmServedFunctions(owned, deadline);
      await settleGateway(owned, deadline, { before: kongBefore, key });
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
