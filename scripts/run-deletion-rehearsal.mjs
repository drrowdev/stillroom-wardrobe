#!/usr/bin/env node
// P6c account-deletion rehearsal. CI only (job `deletion-rehearsal`); there is no local mode.
// It starts its own disposable Supabase stack with a run-unique project ID, deletes fictional owner C
// through the shared deletion loop with injected faults, and proves control account D is unchanged.
// Every Docker/Supabase subprocess runs through run() with one frozen pinned environment.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DOCKER = '/usr/bin/docker';
export const FLOCK = '/usr/bin/flock';
export const SOCKET = '/var/run/docker.sock';
export const DOCKER_HOST = `unix://${SOCKET}`;
export const API_URL = 'http://127.0.0.1:55321';
export const PORTS = Object.freeze({ 54321: 55321, 54322: 55322, 54320: 55320, 54324: 55324 });
export const LABEL = 'com.supabase.cli.project';
export const PREFIX = 'stillroom-rehearsal-';
export const REFUSED_EXIT = 3;
export const EMAILS = Object.freeze({ C: 'deletion-c@example.test', D: 'deletion-d@example.test' });
const OVERRIDES = ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_TLS', 'PGHOST', 'PGPORT', 'PGSSLMODE',
  'PGHOSTADDR', 'PGSERVICE', 'DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_CLI_BINARY_OVERRIDE',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy'];

export class Refusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = (code) => { throw new Refusal(code); };

/** The one place that starts a process. Always shell:false, always an explicit environment. */
export function createRun(spawnImpl = spawn) {
  return (bin, args, { env, input, fd, timeout = 120_000, cwd = ROOT } = {}) => new Promise((resolve) => {
    if (!path.isAbsolute(bin) || !env || typeof env !== 'object') { resolve({ code: 2, stdout: '', stderr: '' }); return; }
    const stdio = ['pipe', 'pipe', 'pipe', ...(fd === undefined ? [] : [fd])];
    const child = spawnImpl(bin, args, { cwd, env, shell: false, stdio });
    const out = [], err = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const take = (target) => (chunk) => { size += chunk.length; if (size <= 16 * 1024 * 1024) target.push(chunk); else child.kill('SIGKILL'); };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ code: 2, stdout: '', stderr: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 2, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

export function assertCi(env, platform = process.platform) {
  if (platform !== 'linux' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'drrowdev/stillroom-wardrobe'
    || env.GITHUB_JOB !== 'deletion-rehearsal' || env.STILLROOM_DELETION_REHEARSAL !== '1'
    || env.ALLOW_HOSTED_SMOKE !== undefined || !/^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^[0-9]{1,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !path.isAbsolute(env.RUNNER_TEMP ?? '')
    || !path.isAbsolute(env.HOME ?? '')) refuse('CI_REQUIRED');
}

export function assertNoOverrides(env) {
  if (env.DOCKER_HOST !== undefined && env.DOCKER_HOST !== DOCKER_HOST) refuse('ENDPOINT_OVERRIDE');
  if (OVERRIDES.some((name) => env[name] !== undefined)) refuse('ENDPOINT_OVERRIDE');
}

export function projectId(env) { return `${PREFIX}${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`; }

/** Built from an allowlist, never by copying the inherited environment. */
export function pinnedEnvironment(env, dockerConfig) {
  return Object.freeze({
    PATH: '/usr/bin:/bin', HOME: env.HOME, RUNNER_TEMP: env.RUNNER_TEMP, DOCKER_HOST, DOCKER_CONFIG: dockerConfig,
    SUPABASE_TELEMETRY_DISABLED: 'true', DO_NOT_TRACK: '1', NO_COLOR: '1',
  });
}

/** The normal-session child: API URL, publishable key and the two fictional passwords only. */
export function childEnvironment(env, api, publishable, accounts) {
  return Object.freeze({
    PATH: '/usr/bin:/bin', HOME: env.HOME, NO_COLOR: '1', REHEARSAL_URL: api, REHEARSAL_PUBLISHABLE_KEY: publishable,
    REHEARSAL_C_EMAIL: accounts.C.email, REHEARSAL_C_PASSWORD: accounts.C.password,
    REHEARSAL_D_EMAIL: accounts.D.email, REHEARSAL_D_PASSWORD: accounts.D.password,
  });
}

export function rehearsalConfig(source, id) {
  let text = source;
  const swap = (from, to) => {
    if (text.split(from).length !== 2) refuse('CONFIG');
    text = text.split(from).join(to);
  };
  swap('project_id = "stillroom-wardrobe"', `project_id = "${id}"`);
  for (const [from, to] of Object.entries(PORTS)) swap(` = ${from}\n`, ` = ${to}\n`);
  swap('[inbucket]\nenabled = true', '[inbucket]\nenabled = false');
  swap('[edge_runtime]\nenabled = true', '[edge_runtime]\nenabled = false');
  if (/ = 543\d\d\b/.test(text)) refuse('CONFIG');
  return text;
}

async function supabaseEntrypoint(fs, root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const cli = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'supabase', 'package.json'), 'utf8'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pkg.devDependencies?.supabase ?? '') || cli.version !== pkg.devDependencies.supabase
    || cli.bin?.supabase !== 'dist/supabase.js') refuse('BINARY');
  return path.join(root, 'node_modules', 'supabase', 'dist', 'supabase.js');
}

async function rootOwnedFile(fs, file) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0) refuse('BINARY');
}

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/**
 * Runs the rehearsal. `sys` is injectable so unit tests can record every call without Docker.
 * Returns the exit code; refusals return REFUSED_EXIT before any cleanup-capable state.
 */
export async function rehearse(sys) {
  const { env, fs, run, hostname, execPath, root, log } = sys;
  const state = { owned: 'none', dir: null, id: null, pinned: null, recorded: { containers: [], volumes: [] }, supabase: null };
  const docker = (args, extra = {}) => run(DOCKER, args, { env: state.pinned, ...extra });
  const supabase = (args, extra = {}) => run(execPath, [state.supabase, '--agent', 'no', '--workdir', state.dir, ...args],
    { env: state.pinned, ...extra });
  const labelled = async (exact) => {
    const containers = await docker(['ps', '-a', '--filter', `label=${LABEL}=${exact}`, '--format', '{{.ID}}']);
    const volumes = await docker(['volume', 'ls', '--filter', `label=${LABEL}=${exact}`, '--format', '{{.Name}}']);
    if (containers.code !== 0 || volumes.code !== 0) return null;
    return { containers: lines(containers.stdout), volumes: lines(volumes.stdout) };
  };
  // The single cleanup path. Nothing is stopped or removed before this run owns resources.
  const cleanup = async () => {
    if (state.owned === 'none') return;
    await supabase(['stop', '--no-backup'], { timeout: 300_000 });
    const found = await labelled(state.id) ?? { containers: [], volumes: [] };
    const containers = [...new Set([...(state.owned === 'recorded' ? state.recorded.containers : []), ...found.containers])];
    const volumes = [...new Set([...(state.owned === 'recorded' ? state.recorded.volumes : []), ...found.volumes])];
    if (containers.length) await docker(['rm', '-f', ...containers]);
    if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
    await fs.rm(state.dir, { recursive: true, force: true });
  };
  try {
    assertCi(env, sys.platform);
    assertNoOverrides(env);
    state.id = projectId(env);
    await rootOwnedFile(fs, DOCKER);
    await rootOwnedFile(fs, FLOCK);
    state.supabase = await supabaseEntrypoint(fs, root);
    const dockerConfig = await fs.mkdtemp(path.posix.join(env.RUNNER_TEMP, 'stillroom-docker-config-'));
    await fs.writeFile(path.posix.join(dockerConfig, 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
    state.pinned = pinnedEnvironment(env, dockerConfig);

    const socket = await fs.lstat(SOCKET).catch(() => null);
    if (!socket || socket.isSymbolicLink() || !socket.isSocket()) refuse('SOCKET');
    if (!['/var/run/docker.sock', '/run/docker.sock'].includes(await fs.realpath(SOCKET).catch(() => ''))) refuse('SOCKET');
    const context = await docker(['context', 'show']);
    if (context.code !== 0 || context.stdout.trim() !== 'default') refuse('CONTEXT');
    const endpoint = await docker(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']);
    if (endpoint.code !== 0 || endpoint.stdout.trim() !== DOCKER_HOST) refuse('CONTEXT');
    const info = await docker(['info', '--format', '{{json .}}']);
    let daemon = null;
    try { daemon = JSON.parse(info.stdout); } catch { /* refused below */ }
    if (info.code !== 0 || !daemon || daemon.OSType !== 'linux' || daemon.Name !== hostname
      || (daemon.ClientInfo?.Context !== undefined && daemon.ClientInfo.Context !== 'default')) refuse('DAEMON');

    // Refuse, never remove, anything a rehearsal could have left behind.
    const exact = await labelled(state.id);
    if (!exact || exact.containers.length || exact.volumes.length) refuse('PREEXISTING');
    const projects = await docker(['ps', '-a', '--format', `{{.Label "${LABEL}"}}`]);
    const volumeProjects = await docker(['volume', 'ls', '--format', `{{.Label "${LABEL}"}}`]);
    if (projects.code !== 0 || volumeProjects.code !== 0
      || [...lines(projects.stdout), ...lines(volumeProjects.stdout)].some((label) => label.startsWith(PREFIX))) refuse('PREEXISTING');

    // flock(1) locks our own descriptor; the lock lasts until this process exits. The file is never deleted.
    const lock = await fs.open(path.posix.join(env.RUNNER_TEMP, 'stillroom-rehearsal.lock'), 'a', 0o600);
    sys.keep?.(lock);
    const locked = await run(FLOCK, ['--nonblock', '3'], { env: state.pinned, fd: lock.fd });
    if (locked.code !== 0) refuse('LOCK_BUSY');

    state.dir = await fs.mkdtemp(path.posix.join(env.RUNNER_TEMP, `${state.id}-`));
    await fs.mkdir(path.posix.join(state.dir, 'supabase'), { mode: 0o700 });
    const config = await fs.readFile(path.join(root, 'supabase', 'config.toml'), 'utf8');
    await fs.writeFile(path.posix.join(state.dir, 'supabase', 'config.toml'), rehearsalConfig(config, state.id), { flag: 'wx' });
    await fs.cp(path.join(root, 'supabase', 'migrations'), path.posix.join(state.dir, 'supabase', 'migrations'), { recursive: true });

    const probe = await supabase(['status', '--output', 'json']);
    if (probe.code === 0 || /API_URL|http:\/\/127\.0\.0\.1/.test(probe.stdout + probe.stderr)) refuse('STACK_REACHABLE');

    state.owned = 'starting';
    const started = await supabase(['start', '--yes', '-x', 'postgres-meta,studio,edge-runtime,logflare,vector,supavisor,mailpit,realtime'],
      { timeout: 900_000 });
    if (started.code !== 0) throw new Error('START_FAILED');
    const own = await labelled(state.id);
    if (!own || !own.containers.length || !own.volumes.length) throw new Error('BINDING');
    state.recorded = own;
    state.owned = 'recorded';
    const stack = await verifyStack({ docker, supabase, id: state.id, containers: own.containers });
    await (sys.exercise ?? exercise)({ ...sys, run, docker, stack, dbContainer: `supabase_db_${state.id}`, pinned: state.pinned });
    log('PASS: account deletion rehearsal; owner C removed with resumed faults, control D unchanged');
    return 0;
  } catch (error) {
    if (error instanceof Refusal) { log(`REFUSED: ${error.code}`); return REFUSED_EXIT; }
    log(`FAIL: account deletion rehearsal; ${error instanceof Error && /^[A-Z_:-]+[A-Za-z0-9_:. -]*$/.test(error.message) ? error.message : 'unexpected error'}`);
    return 1;
  } finally {
    await cleanup().catch(() => log('FAIL: rehearsal cleanup was incomplete'));
  }
}

// Exact images the pinned CLI (supabase 2.116.0) starts for this service set, from either CLI registry.
// Excluded services (-x) are absent. A CLI upgrade must update this list deliberately.
const TAGS = Object.freeze({ postgres: '17.6.1.165', kong: '2.8.1', postgrest: 'v16.1', gotrue: 'v2.196.0',
  'storage-api': 'v1.70.3', imgproxy: 'v3.8.0' });
export const IMAGES = Object.freeze(['public.ecr.aws/supabase', 'ghcr.io/supabase']
  .flatMap((registry) => Object.entries(TAGS).map(([name, tag]) => `${registry}/${name}:${tag}`)));
// The CI job sets the daemon's default host binding to 127.0.0.1 before the stack starts; this script never changes
// Docker configuration, it only checks the effective published addresses. Anything but loopback is refused.
export const HOST_IPS = Object.freeze(['127.0.0.1']);
export async function verifyStack({ docker, supabase, id, containers }) {
  const template = `{"name":{{json .Name}},"image":{{json .Config.Image}},"project":{{json (index .Config.Labels "${LABEL}")}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}`;
  let database = false;
  for (const container of containers) {
    const result = await docker(['container', 'inspect', '--format', template, container]);
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw new Error('BINDING'); }
    if (result.code !== 0 || value.project !== id || !IMAGES.includes(value.image)) throw new Error('BINDING');
    for (const bindings of Object.values(value.ports ?? {})) {
      for (const binding of bindings ?? []) {
        // The port must be this stack's own, and the API is only used on 127.0.0.1.
        if (typeof binding?.HostIp !== 'string' || !HOST_IPS.includes(binding.HostIp) || !/^553[2-2][0-9]$/.test(binding.HostPort ?? '')) {
          throw new Error('BINDING');
        }
      }
    }
    if (value.name === `/supabase_db_${id}`) database = value.running === true;
  }
  if (!database) throw new Error('BINDING');
  const status = await supabase(['status', '--output', 'json']);
  let data;
  try { data = JSON.parse(status.stdout); } catch { throw new Error('BINDING'); }
  const serviceKey = data.SERVICE_ROLE_KEY;
  const publishable = data.PUBLISHABLE_KEY || data.ANON_KEY;
  if (status.code !== 0 || data.API_URL !== API_URL || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:55322\/postgres$/.test(data.DB_URL ?? '')
    || typeof serviceKey !== 'string' || typeof publishable !== 'string' || !serviceKey || !publishable) throw new Error('BINDING');
  const claims = JSON.parse(Buffer.from(serviceKey.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}');
  if (claims.role !== 'service_role') throw new Error('BINDING');
  return { api: API_URL, serviceKey, publishable };
}

const OWNER_TABLES_SOURCE = 'supabase/migrations/20260925120000_account_deletion.sql';
export async function ownerTables(fs, root) {
  const sql = await fs.readFile(path.join(root, OWNER_TABLES_SOURCE), 'utf8');
  const start = sql.indexOf('create function private.deletion_owner_rows_absent');
  const body = sql.slice(start, sql.indexOf('$$;', start));
  const tables = [...body.matchAll(/from ((?:public|private)\.[a-z_]+) where owner_id=p_owner/g)].map((match) => match[1]);
  if (tables.length < 20 || new Set(tables).size !== tables.length) throw new Error('TABLES');
  return tables;
}

/**
 * A failed psql step as `SQL:<step>:<SQLSTATE>:<message>`. Only the first ERROR line is used (never DETAIL, which
 * can hold row values); identifiers and addresses are redacted and the text is limited to plain characters.
 */
export function sqlFailure(step, stderr) {
  const match = /ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(stderr ?? '');
  if (!match) return `SQL:${step}:UNKNOWN`;
  const message = match[2]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/[^\s@]+@[^\s@]+/g, 'EMAIL')
    .replace(/[^A-Za-z0-9_.: -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `SQL:${step}:${match[1]}:${message}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const literal = (uid) => { if (!UUID.test(uid)) throw new Error('UUID'); return `'${uid}'::uuid`; };

/** The real rehearsal body; only reached with a verified, run-owned local stack. */
async function exercise(ctx) {
  const { docker, stack, dbContainer, fs, root, run, env, execPath } = ctx;
  // Every psql call reports the current step; see sqlFailure for what a failure may print.
  let step = 'fixture';
  const psql = (text) => docker(['exec', '-i', dbContainer, 'psql', '-X', '--no-password', '-h', '127.0.0.1', '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-q', '-t', '-A'], { input: text });
  const sql = async (text) => {
    const result = await psql(text);
    if (result.code !== 0) throw new Error(sqlFailure(step, result.stderr));
    return result.stdout.trim();
  };
  const { runDeletion } = await import('../supabase/functions/_shared/deletion-loop.ts');
  const { createCall, serviceDeps } = await import('../supabase/functions/_shared/deletion-service.ts');
  const call = createCall(stack.api);
  const service = { bearer: stack.serviceKey, key: stack.serviceKey };
  const tables = await ownerTables(fs, root);

  await sql(`insert into private.approved_accounts(admission_no,email) values (1,'${EMAILS.C}'),(2,'${EMAILS.D}');`);
  const accounts = {};
  for (const label of ['C', 'D']) {
    accounts[label] = { email: EMAILS[label], password: randomBytes(32).toString('base64url') };
    const created = await call('/auth/v1/admin/users', { method: 'POST', ...service,
      body: { email: accounts[label].email, password: accounts[label].password, email_confirm: true } }, 15_000);
    if (!created?.response.ok) throw new Error('FIXTURE_USER');
    await created.response.body?.cancel();
  }
  const child = (mode) => run(execPath, [path.join(root, 'tests', 'integration', 'delete-account.sessions.mjs'), mode],
    { env: childEnvironment(env, stack.api, stack.publishable, accounts), timeout: 180_000 });
  const seeded = await child('seed');
  if (seeded.code !== 0) throw new Error('SEED');
  const owners = JSON.parse(lines(seeded.stdout).at(-1) ?? '{}');
  const c = owners.c, d = owners.d;
  if (!UUID.test(c) || !UUID.test(d) || c === d) throw new Error('SEED');
  if (await sql(`select string_agg(admission_no||':'||user_id, ',' order by admission_no) from private.approved_accounts;`) !== `1:${c},2:${d}`) {
    throw new Error('BINDING:admission');
  }

  const digest = (uid) => sql(`select jsonb_build_object(${tables.map((table) =>
    `'${table}',(select jsonb_build_array(count(*),md5(coalesce(string_agg(t::text,'|' order by t::text),''))) from ${table} t where t.owner_id=${literal(uid)})`).join(',')},
    'storage',(select jsonb_build_array(count(*),md5(coalesce(string_agg(o.name||':'||coalesce(o.metadata->>'size','')||':'||coalesce(o.metadata->>'eTag',''),'|' order by o.name),'')))
      from storage.objects o where o.bucket_id='wardrobe' and split_part(o.name,'/',1)=${literal(uid)}::text),
    'admission',(select jsonb_build_array(a.admission_no,a.email,a.enabled,a.user_id,a.generation) from private.approved_accounts a where a.user_id=${literal(uid)}))::text;`);
  const before = await digest(d);
  const cBefore = JSON.parse(await digest(c));
  if (cBefore.storage[0] < 4 || cBefore['public.items'][0] < 2 || cBefore['public.outfits'][0] < 1) throw new Error('SEED');

  step = 'catalog';
  // The Auth deletion trigger function is owned by postgres and its trigger is enabled on auth.users.
  if (await sql(`select pg_get_userbyid(p.proowner)::text||':'||p.prosecdef::text||':'||(select string_agg(t.tgname::text||'='||t.tgenabled::text,',')
    from pg_trigger t where t.tgfoid=p.oid and t.tgrelid='auth.users'::regclass) from pg_proc p
    where p.oid='private.release_deleted_admission()'::regprocedure;`) !== 'postgres:true:stillroom_release_admission=O') throw new Error('CATALOG:trigger-owner');

  step = 'guard';
  const deleteObject = async (name) => {
    const reply = await call(`/storage/v1/object/wardrobe/${name}`, { method: 'DELETE', ...service }, 15_000);
    await reply?.response.body?.cancel();
    return reply?.response.ok === true;
  };
  const cObjects = lines(await sql(`select name from storage.objects where bucket_id='wardrobe' and split_part(name,'/',1)=${literal(c)}::text order by name limit 2;`));
  if (cObjects.length !== 2) throw new Error('SEED');
  const [cObject, expendable] = cObjects;
  const refusedDelete = async (label) => { if (await deleteObject(cObject)) throw new Error(`GUARD:${label}`); };
  await sql(`insert into private.deletion_jobs(owner_id,stage,admission_no,admission_generation)
    select user_id,'storage',admission_no,generation from private.approved_accounts where user_id=${literal(c)};`);
  // Unchanged baseline, not the F1 exception: service-role Storage deletes for an ENABLED owner were already
  // allowed before P6c, and a stale job does not change that. Proven on an expendable object only.
  if (!await deleteObject(expendable)) throw new Error('GUARD:enabled-baseline');
  if (await sql(`select count(*) from storage.objects where bucket_id='wardrobe' and name='${expendable.replace(/'/g, "''")}';`) !== '0') {
    throw new Error('GUARD:enabled-baseline');
  }
  const cBaseline = JSON.parse(await digest(c));
  await sql(`update private.deletion_jobs set stage='freeze' where owner_id=${literal(c)};
    update private.approved_accounts set enabled=false where user_id=${literal(c)};`);
  await refusedDelete('disabled-not-storage');
  await sql(`update private.deletion_jobs set stage='storage',admission_generation=gen_random_uuid() where owner_id=${literal(c)};`);
  await refusedDelete('generation-mismatch');
  await sql(`delete from private.deletion_jobs where owner_id=${literal(c)};
    update private.approved_accounts set enabled=true where user_id=${literal(c)};`);
  if (JSON.stringify(JSON.parse(await digest(c))) !== JSON.stringify(cBaseline)) throw new Error('GUARD:owner-changed');
  if (await digest(d) !== before) throw new Error('GUARD:control-changed');

  const control = (action, op, code) => serviceDeps(c, stack.serviceKey, call).control(action, op, code);
  const deps = (faults = {}) => {
    const real = { ...serviceDeps(c, stack.serviceKey, call), now: Date.now };
    return { ...real, ...Object.fromEntries(Object.entries(faults).map(([name, wrap]) => [name, wrap(real[name])])) };
  };
  const budget = () => Date.now() + 100_000;

  step = 'loop-first';
  // Attempt 1: a partial listing, then a definite Storage failure, leaves the job at `storage`.
  // The owner flow reaches Storage only after the freeze: every Storage call sees C disabled with its job at `storage`.
  let listings = 0, removals = 0;
  const frozen = async () => {
    if (await sql(`select a.enabled||':'||j.stage from private.approved_accounts a join private.deletion_jobs j on j.owner_id=a.user_id
      where a.user_id=${literal(c)};`) !== 'false:storage') throw new Error('LOOP:storage-before-freeze');
  };
  const first = await runDeletion(deps({
    listOwnerObjects: (list) => async (...args) => { await frozen(); const page = await list(...args); listings += 1; return listings === 1 && page.kind === 'ok' ? { kind: 'ok', value: page.value.slice(0, 1) } : page; },
    removeObjects: (remove) => async (...args) => { await frozen(); removals += 1; return removals === 2 ? { kind: 'error', message: 'Storage' } : remove(...args); },
  }), c, 'begin', randomUUID(), budget());
  if (listings === 0) throw new Error('LOOP:no-storage-call');
  if (first !== 'retry') throw new Error(`LOOP:first-${first}`);
  const afterFirst = JSON.parse(await sql(`select jsonb_build_object('stage',stage,'code',last_code,'lease',lease_id,'attempts',attempts)::text from private.deletion_jobs where owner_id=${literal(c)};`));
  if (afterFirst.stage !== 'storage' || afterFirst.code !== 'UPSTREAM_UNAVAILABLE' || afterFirst.lease !== null || afterFirst.attempts !== 1) throw new Error('LOOP:first-state');
  if (await sql(`select enabled from private.approved_accounts where user_id=${literal(c)};`) !== 'f') throw new Error('LOOP:not-frozen');

  step = 'loop-busy';
  // A second worker while another holds the lease reports in progress and changes nothing.
  const holder = randomUUID();
  const held = await control('resume', holder);
  if (held.kind !== 'ok' || held.value.acquired !== true) throw new Error('LOOP:hold');
  if (await runDeletion(deps(), c, 'resume', randomUUID(), budget()) !== 'in_progress') throw new Error('LOOP:busy');
  if ((await control('release', holder)).kind !== 'ok') throw new Error('LOOP:release');

  step = 'cascade';
  // Attempt 3: the first `storage_removed` fails late in the row cascade, after items, outfits and wear events are
  // deleted, and rolls back to `storage` with every row kept; the reply after the next one is lost, and Auth answers
  // with a failure once. The blocking trigger exists only on this disposable stack and only for that one call.
  let rolledBack = false, lost = false, authFailed = false;
  const second = await runDeletion(deps({
    control: (real) => async (action, op, code) => {
      if (action === 'storage_removed' && !rolledBack) {
        rolledBack = true;
        const kept = await digest(c);
        if (JSON.parse(kept)['public.items'][0] < 1 || JSON.parse(kept)['public.profiles'][0] !== 1) throw new Error('CASCADE:fixture');
        await sql(`create function private.rehearsal_block() returns trigger language plpgsql as $$
          begin raise exception using errcode='P0R01', message='REHEARSAL_BLOCK'; end$$;
          create trigger rehearsal_block before delete on public.profiles for each row execute function private.rehearsal_block();`);
        let reply, text;
        try {
          // Called directly so the exact injected error is visible; the service wrapper reports it only as ambiguous.
          reply = await call('/rest/v1/rpc/deletion_control', { method: 'POST', ...service,
            body: { p_owner_id: c, p_action: action, p_op: op, p_code: code ?? null } }, 10_000);
          text = await reply?.response.text() ?? '';
        } finally {
          await sql('drop trigger rehearsal_block on public.profiles; drop function private.rehearsal_block();');
        }
        let value = null;
        try { value = JSON.parse(text); } catch { /* checked below */ }
        if (!reply || reply.response.ok || value?.code !== 'P0R01' || value?.message !== 'REHEARSAL_BLOCK') throw new Error('CASCADE:not-blocked');
        if (await sql(`select stage from private.deletion_jobs where owner_id=${literal(c)};`) !== 'storage') throw new Error('CASCADE:stage');
        if (await digest(c) !== kept) throw new Error('CASCADE:rollback');
        return { kind: 'ambiguous' };
      }
      const result = await real(action, op, code);
      if (action === 'storage_removed' && !lost) { lost = true; return { kind: 'ambiguous' }; }
      return result;
    },
    deleteAuthUser: (remove) => async () => {
      if (!authFailed) { authFailed = true; return { kind: 'error', message: 'Auth' }; }
      return remove();
    },
  }), c, 'resume', randomUUID(), budget());
  if (!rolledBack) throw new Error('CASCADE:not-reached');
  if (second !== 'retry') throw new Error(`LOOP:second-${second}`);
  if (await sql(`select stage from private.deletion_jobs where owner_id=${literal(c)};`) !== 'auth') throw new Error('LOOP:second-state');

  step = 'q2';
  // Attempt 4 completes. Q2: the Auth trigger waits for C's admission row (no NOWAIT) for at most its 5 s lock
  // timeout. Held for 8 s, the first GoTrue hard delete times out and changes nothing; held for 2 s, the next one
  // waits, then removes the user and the row together. Holders are found by application name and pg_locks.
  const hold = (name, seconds) => sql(`set application_name='${name}'; begin;
    select 1 from private.approved_accounts where user_id=${literal(c)} for update; select pg_sleep(${seconds}); commit;`);
  const until = async (label, query) => {
    for (let tries = 0; tries < 50; tries += 1) {
      if (await sql(query) === 't') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Q2:${label}`);
  };
  const holds = (name) => `select exists(select 1 from pg_locks l join pg_stat_activity s on s.pid=l.pid
    where s.application_name='${name}' and l.granted and l.relation='private.approved_accounts'::regclass and l.mode='RowShareLock'
    and s.wait_event='PgSleep');`;
  const blockedBy = (name) => `select exists(select 1 from pg_stat_activity w join pg_stat_activity h on h.application_name='${name}'
    where w.wait_event_type='Lock' and h.pid=any(pg_blocking_pids(w.pid)));`;
  const present = () => sql(`select (select count(*) from auth.users where id=${literal(c)})||':'||
    (select count(*) from private.approved_accounts where user_id=${literal(c)});`);
  const waitedFor = async (name, remove, args) => {
    await until(`${name}-not-held`, holds(name));
    if (await present() !== '1:1') throw new Error('Q2:auth-early');
    const started = Date.now();
    const pending = remove(...args);
    await until(`${name}-no-wait`, blockedBy(name));
    const result = await pending;
    return { result, waited: Date.now() - started };
  };
  let timedOut = null, served = null;
  const holders = [];
  const third = await runDeletion(deps({
    deleteAuthUser: (remove) => async (...args) => {
      if (!timedOut) {
        holders.push(hold('rehearsal-q2-timeout', 8));
        timedOut = await waitedFor('rehearsal-q2-timeout', remove, args);
        if (timedOut.result.kind === 'ok' || timedOut.waited < 4500) throw new Error('Q2:no-timeout');
        if (await present() !== '1:1') throw new Error('Q2:timeout-changed');
        await holders[0];
        return { kind: 'ambiguous' };
      }
      holders.push(hold('rehearsal-q2-release', 2));
      served = await waitedFor('rehearsal-q2-release', remove, args);
      return served.result;
    },
  }), c, 'resume', randomUUID(), budget());
  await Promise.all(holders);
  if (!timedOut || !served) throw new Error('Q2:not-reached');
  if (third !== 'complete') throw new Error('LOOP:third');
  if (served.result.kind !== 'ok' || served.waited < 1000) throw new Error('Q2:not-serialized');
  const receipt = await sql(`select jsonb_build_object('stage',stage,'attempts',attempts,'completed',completed_at is not null)::text from private.deletion_jobs where owner_id=${literal(c)};`);
  if (await runDeletion(deps(), c, 'resume', randomUUID(), budget()) !== 'complete') throw new Error('LOOP:repeat');
  const late = await control('failed', randomUUID(), 'UPSTREAM_UNAVAILABLE');
  if (late.kind === 'ok') throw new Error('LOOP:late-failure');
  if (await sql(`select jsonb_build_object('stage',stage,'attempts',attempts,'completed',completed_at is not null)::text from private.deletion_jobs where owner_id=${literal(c)};`) !== receipt) {
    throw new Error('LOOP:receipt-changed');
  }
  if (JSON.parse(receipt).stage !== 'complete' || JSON.parse(receipt).attempts !== 4) throw new Error('LOOP:attempts');

  step = 'result';
  const gone = await sql(`select jsonb_build_object(
    'rows',private.deletion_owner_rows_absent(${literal(c)}),
    'objects',(select count(*) from storage.objects where bucket_id='wardrobe' and split_part(name,'/',1)=${literal(c)}::text),
    'auth',(select count(*) from auth.users where id=${literal(c)}),
    'admission',(select count(*) from private.approved_accounts where admission_no=1 or email='${EMAILS.C}'))::text;`);
  if (gone !== '{"auth": 0, "rows": true, "objects": 0, "admission": 0}') throw new Error('RESULT:owner-c');
  if (await digest(d) !== before) throw new Error('RESULT:control-changed');
  const purged = await call('/rest/v1/rpc/purge_deletion_receipts', { method: 'POST', ...service, body: {} }, 10_000);
  if (!purged?.response.ok || (await purged.response.text()).trim() !== '0') throw new Error('RESULT:purge');
  const verified = await child('verify');
  if (verified.code !== 0) throw new Error('RESULT:sessions');
}

async function main() {
  const handles = [];
  const code = await rehearse({
    env: process.env, fs: fsp, run: createRun(), hostname: os.hostname(), execPath: process.execPath, root: ROOT,
    platform: process.platform, log: (line) => console.log(line), keep: (handle) => handles.push(handle),
  });
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
