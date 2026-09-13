import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, assertNoServiceSecrets, assertProjectConfig, requireDocker, requireLocalContainer,
  cli, runCommand, normalSessionEnvironment, readCredentialCache, validateSessionEnvironment, privilegedLocalSql,
  DB_CONTAINER, commandEnvironment,
} from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import {
  SOURCE_HASHES, requireEvidence, assertSnapshotAbsent, cleanupSnapshot,
} from '../tests/integration/preservation.sessions.mjs';

export const MIGRATIONS = Object.freeze([
  { name: '20260905000000_initial.sql', version: '20260905000000', time: '2026-09-05 00:00:00', bytes: 35214, sha256: SOURCE_HASHES.base },
  { name: '20260906000000_item_field_provenance.sql', version: '20260906000000', time: '2026-09-06 00:00:00', bytes: 5923, sha256: SOURCE_HASHES.target },
  { name: '20260909070000_item_description_edit.sql', version: '20260909070000', time: '2026-09-09 07:00:00', bytes: 2618, sha256: SOURCE_HASHES.description },
  { name: '20260909110000_item_optional_collections.sql', version: '20260909110000', time: '2026-09-09 11:00:00', bytes: 454, sha256: SOURCE_HASHES.collections },
  { name: '20260909180000_ai_request_controls.sql', version: '20260909180000', time: '2026-09-09 18:00:00', bytes: 28579, sha256: SOURCE_HASHES.controls },
  { name: '20260910070000_checked_item_save.sql', version: '20260910070000', time: '2026-09-10 07:00:00', bytes: 16801, sha256: SOURCE_HASHES.save },
  { name: '20260911040000_ai_analysis_backend.sql', version: '20260911040000', time: '2026-09-11 04:00:00', bytes: 24856, sha256: SOURCE_HASHES.analysis },
  { name: '20260911200000_checked_ai_item_save.sql', version: '20260911200000', time: '2026-09-11 20:00:00', bytes: 29668, sha256: SOURCE_HASHES.analyzedSave },
  { name: '20260913120000_item_lifecycle.sql', version: '20260913120000', time: '2026-09-13 12:00:00', bytes: 15332, sha256: SOURCE_HASHES.lifecycle },
]);

// Catalog-only structural proof. Never delete a normal fixture profile to test retention.
export const ITEM_SAVE_CATALOG_SQL = `
select jsonb_build_object(
  'rls',(select count(*)=2 and bool_and(c.relrowsecurity)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname in ('item_save_used_ids','item_save_attempts')),
  'policies',(select count(*)=0 from pg_catalog.pg_policies
    where schemaname='private' and tablename in ('item_save_used_ids','item_save_attempts')),
  'tableDenied',(select bool_and(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE'))
    from unnest(array['authenticated','anon']) r,
      unnest(array['private.item_save_used_ids','private.item_save_attempts']) t),
  'markerColumns',(select array_agg(a.attname::text order by a.attnum)=array['owner_id','item_id','image_id']
      and bool_and(a.atttypid='uuid'::regtype and a.attnotnull)
    from pg_catalog.pg_attribute a where a.attrelid='private.item_save_used_ids'::regclass
      and a.attnum>0 and not a.attisdropped),
  'markerKeys',(select count(*)=3 and bool_and(pg_get_constraintdef(c.oid)=any(array[
      'PRIMARY KEY (owner_id, item_id)','UNIQUE (owner_id, image_id)',
      'FOREIGN KEY (owner_id) REFERENCES profiles(owner_id) ON DELETE CASCADE']))
    from pg_catalog.pg_constraint c where c.conrelid='private.item_save_used_ids'::regclass),
  'attemptFks',(select count(*)=3 and bool_and(pg_get_constraintdef(c.oid)=any(array[
      'FOREIGN KEY (owner_id) REFERENCES profiles(owner_id) ON DELETE CASCADE',
      'FOREIGN KEY (owner_id, item_id) REFERENCES items(owner_id, id) ON DELETE CASCADE',
      'FOREIGN KEY (owner_id, item_id, image_id) REFERENCES item_images(owner_id, item_id, id) ON DELETE SET NULL (image_id)']))
    from pg_catalog.pg_constraint c where c.conrelid='private.item_save_attempts'::regclass and c.contype='f'),
  'helperDenied',(select bool_and(not has_function_privilege(r,f,'EXECUTE'))
    from unnest(array['authenticated','anon']) r,
      unnest(array['private.commit_item_save_image(uuid)','private.item_save_owner()',
        'private.item_save_current(uuid,uuid,uuid,text)','private.item_save_fingerprint(items,item_images)']) f),
  'rpc',(select count(*)=3 and bool_and(p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(p.proconfig)
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE'))
    from pg_catalog.pg_proc p where p.oid=any(array[
      'public.reserve_item_save(jsonb,jsonb)'::regprocedure,
      'public.finalize_item_save(uuid,uuid,text)'::regprocedure,'public.commit_image(uuid)'::regprocedure]))
);`;

export const ITEM_LIFECYCLE_CATALOG_SQL = `
select jsonb_build_object(
  'rls',(select c.relrowsecurity from pg_catalog.pg_class c where c.oid='private.item_deletion_claims'::regclass),
  'policies',(select count(*)=0 from pg_catalog.pg_policies where schemaname='private' and tablename='item_deletion_claims'),
  'tableDenied',(select bool_and(not has_table_privilege(r,'private.item_deletion_claims','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    from unnest(array['anon','authenticated']) r),
  'columns',(select array_agg(a.attname::text order by a.attnum)=array['owner_id','item_id','request_id','expected_version','started_at']
      and bool_and(a.attnotnull) from pg_catalog.pg_attribute a
    where a.attrelid='private.item_deletion_claims'::regclass and a.attnum>0 and not a.attisdropped),
  'keys',(select count(*)=3 and bool_and(pg_get_constraintdef(c.oid)=any(array[
      'PRIMARY KEY (owner_id, item_id)','UNIQUE (owner_id, request_id)',
      'FOREIGN KEY (owner_id, item_id) REFERENCES items(owner_id, id) ON DELETE CASCADE']))
    from pg_catalog.pg_constraint c where c.conrelid='private.item_deletion_claims'::regclass and c.contype in ('p','u','f')),
  'rpc',(select count(*)=4 and bool_and(p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(p.proconfig) and 'lock_timeout=2s'=any(p.proconfig)
      and has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    from pg_catalog.pg_proc p where p.oid=any(array[
      'public.set_item_trashed(uuid,bigint,boolean)'::regprocedure,'public.item_deletion_status(uuid[])'::regprocedure,
      'public.begin_item_deletion(uuid,bigint,uuid,text)'::regprocedure,'public.finish_item_deletion(uuid,uuid)'::regprocedure])),
  'guards',(select count(*)=4 and bool_and(p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(p.proconfig) and 'lock_timeout=2s'=any(p.proconfig)
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and has_function_privilege('authenticated',p.oid,'EXECUTE')=(p.proname='may_create_item_object')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    from pg_catalog.pg_proc p where p.oid=any(array['private.item_lifecycle_owner()'::regprocedure,
      'private.guard_item_deletion()'::regprocedure,'private.guard_item_image_deletion()'::regprocedure,
      'private.may_create_item_object(text)'::regprocedure])),
  'pureManifest',(select p.provolatile='i' and not p.prosecdef and 'search_path=""'=any(p.proconfig)
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
    from pg_catalog.pg_proc p where p.oid='private.item_lifecycle_manifest(jsonb)'::regprocedure),
  'triggers',(select count(*)=2 and bool_and(t.tgenabled='O' and not t.tgisinternal and
      ((t.tgrelid='public.items'::regclass and t.tgfoid='private.guard_item_deletion()'::regprocedure and t.tgtype=27)
        or (t.tgrelid='public.item_images'::regclass and t.tgfoid='private.guard_item_image_deletion()'::regprocedure and t.tgtype=31)))
    from pg_catalog.pg_trigger t where t.tgname in ('item_deletion_guard','item_image_deletion_guard')),
  'storageCreate',(select count(*)=1 and bool_and(cmd='INSERT' and roles=array['authenticated']::name[]
      and qual is null and with_check='((bucket_id = ''wardrobe''::text) AND private.may_create_item_object(name))')
    from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and policyname='wardrobe_create'),
  'storageUnchanged',(select count(*)=2 and bool_and(cmd in ('SELECT','DELETE')
      and roles=array['authenticated']::name[] and qual=case policyname
        when 'wardrobe_read' then '((bucket_id = ''wardrobe''::text) AND private.owns_storage_path(name, false))'
        when 'wardrobe_delete' then '((bucket_id = ''wardrobe''::text) AND private.may_delete_storage(name))' end)
    from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and policyname in ('wardrobe_read','wardrobe_delete'))
      and not exists(select 1 from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and cmd in ('UPDATE','ALL'))
);`;

export function assertLifecycleFixture(env, ownerId, itemId) {
  assertRehearsalEnvironment(env, []);
  requireEvidence(env.ALLOW_SECURITY_TESTS === '1');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  requireEvidence(uuid.test(ownerId) && uuid.test(itemId) && itemId.startsWith('1080'));
}

// CI-only setup, not an access assertion or a general SQL callback.
export async function withLifecycleParentLock(ownerId, itemId, mode, operation) {
  assertLifecycleFixture(process.env, ownerId, itemId);
  requireEvidence(['update', 'key share'].includes(mode) && typeof operation === 'function');
  await requireLocalContainer();
  const child = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password',
    '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], {
    cwd: ROOT, env: commandEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let resolveReady, rejectReady, resolveClosed, output = '', size = 0, failure, releasing = false;
  let primaryFailed = false, primaryValue, cleanupFailed = false, cleanupValue;
  const cleanupFailure = (error) => {
    if (!cleanupFailed) { cleanupFailed = true; cleanupValue = error; }
  };
  const terminate = () => {
    try { child.kill('SIGTERM'); } catch (error) { cleanupFailure(error); }
  };
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Setup can throw before await ready; observe release-time rejection without changing that await.
  void ready.catch(() => {});
  const failChild = () => {
    if (!failure) failure = new Error('EVIDENCE_REQUIRED');
    rejectReady(failure);
    terminate();
  };
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
    child.once('error', failChild);
    child.once('close', (code) => { if (!releasing) failChild(); resolve(code); });
  });
  const reject = () => { failChild(); resolveClosed(1); };
  const timer = setTimeout(reject, 15_000);
  child.stdin.on('error', failChild);
  child.stderr.on('data', failChild);
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > 128) { failChild(); return; }
    output += chunk.toString();
    if (output.trim() === 'I08_PARENT_HELD') resolveReady();
  });
  try {
    child.stdin.write(`begin; set local statement_timeout='12s'; set local idle_in_transaction_session_timeout='12s';
      do $$ declare n integer; begin
        perform 1 from public.items where owner_id='${ownerId}' and id='${itemId}' for ${mode} nowait;
        get diagnostics n = row_count; if n<>1 then raise exception 'Fixture absent'; end if;
      end $$;\n\\echo I08_PARENT_HELD\n`);
    await ready;
    await operation();
    requireEvidence(!failure);
  } catch (error) {
    primaryFailed = true;
    primaryValue = error;
  }
  releasing = true;
  try {
    if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end('rollback;\n');
  } catch (error) { cleanupFailure(error); terminate(); }
  try {
    const code = await closed;
    requireEvidence(code === 0 && !failure);
  } catch (error) { cleanupFailure(error); }
  try { clearTimeout(timer); } catch (error) { cleanupFailure(error); }
  if (cleanupFailed) {
    try { console.error('FAIL: I08 exact parent-lock release'); } catch (error) { cleanupFailure(error); }
  }
  if (primaryFailed) throw primaryValue;
  if (cleanupFailed) throw cleanupValue;
}

export async function withLifecycleCatalogMarker(ownerId, itemId, operation) {
  assertLifecycleFixture(process.env, ownerId, itemId);
  requireEvidence(typeof operation === 'function');
  const markerId = randomUUID(), name = `${ownerId}/${itemId}/i08-catalog-marker`;
  // No bytes are written. Normal BEGIN must already have installed this exact claim.
  let created = false, primaryFailed = false, primaryValue, cleanupFailed = false, cleanupValue;
  const cleanupFailure = (error) => {
    if (!cleanupFailed) { cleanupFailed = true; cleanupValue = error; }
  };
  try {
    const setup = await privilegedLocalSql(`do $$ begin
      if not exists(select 1 from private.item_deletion_claims where owner_id='${ownerId}' and item_id='${itemId}')
        or exists(select 1 from storage.objects where bucket_id='wardrobe' and starts_with(name,'${ownerId}/${itemId}/'))
        then raise exception 'Fixture state'; end if;
      insert into storage.objects(id,bucket_id,name) values('${markerId}','wardrobe','${name}');
      end $$; select 'I08_MARKER_CREATED';`);
    requireEvidence(setup === 'I08_MARKER_CREATED');
    created = true;
    await operation();
  } catch (error) {
    primaryFailed = true;
    primaryValue = error;
  }
  try {
    const cleanup = await privilegedLocalSql(`with removed as (
          delete from storage.objects where id='${markerId}' and bucket_id='wardrobe' and name='${name}' returning id
        ) select count(*) from removed;`);
    requireEvidence(created ? cleanup === '1' : ['0', '1'].includes(cleanup));
  } catch (error) { cleanupFailure(error); }
  try {
    requireEvidence(await privilegedLocalSql(`select count(*) from storage.objects
          where id='${markerId}' or (bucket_id='wardrobe' and name='${name}');`) === '0');
  } catch (error) { cleanupFailure(error); }
  if (cleanupFailed) {
    try { console.error('FAIL: I08 exact catalog-marker cleanup'); } catch (error) { cleanupFailure(error); }
  }
  if (primaryFailed) throw primaryValue;
  if (cleanupFailed) throw cleanupValue;
}

export function assertRehearsalEnvironment(env, args) {
  requireEvidence(Array.isArray(args) && args.length === 0);
  requireEvidence(env.ALLOW_PRESERVATION_REHEARSAL === '1' && env.CI === 'true' && env.GITHUB_ACTIONS === 'true');
  assertNoServiceSecrets(env);
}

export function validateInventory(entries) {
  requireEvidence(Array.isArray(entries) && entries.length === MIGRATIONS.length);
  for (const expected of MIGRATIONS) {
    const found = entries.filter((entry) => entry.name === expected.name);
    requireEvidence(found.length === 1);
    const entry = found[0];
    requireEvidence(entry.regular === true && entry.symlink === false
      && entry.bytes === expected.bytes && entry.sha256 === expected.sha256);
  }
}

export async function assertMigrationInventory() {
  const directory = path.join(ROOT, 'supabase', 'migrations');
  const stat = await lstat(directory);
  requireEvidence(stat.isDirectory() && !stat.isSymbolicLink());
  const entries = [];
  for (const name of await readdir(directory)) {
    requireEvidence(MIGRATIONS.some((entry) => entry.name === name));
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    requireEvidence(info.isFile() && !info.isSymbolicLink() && info.size <= Math.max(...MIGRATIONS.map((entry) => entry.bytes)));
    entries.push({ name, regular: true, symlink: false, bytes: info.size,
      sha256: createHash('sha256').update(await readFile(filename)).digest('hex') });
  }
  validateInventory(entries);
}

export function assertCapabilities(results) {
  requireEvidence(Array.isArray(results) && results.length === 3);
  for (const [index, flags] of [['--local', '--version'], ['--local'], ['--local']].entries()) {
    const result = results[index];
    requireEvidence(result?.code === 0 && typeof result.stdout === 'string');
    for (const flag of flags) {
      requireEvidence(new RegExp(`^ *${flag}(?: +|$)`, 'm').test(result.stdout));
    }
  }
}

const HISTORY_REASONS = Object.freeze([
  'history-command', 'length-cap', 'charset', 'line-count', 'header', 'separator',
  'cell-count', 'cell-quoting', 'cell-content', 'version-mismatch', 'remote-mismatch',
  'time-mismatch', 'inventory-mismatch',
]);

class HistoryError extends Error {
  constructor(reason) {
    super('EVIDENCE_REQUIRED');
    this.reason = reason;
  }
}

function requireHistory(condition, reason) {
  if (!condition) throw new HistoryError(reason);
}

export function historyFailureDetail(error) {
  const reason = error instanceof HistoryError
    ? HISTORY_REASONS.find((label) => label === error.reason) : undefined;
  return reason ? `; reason=${reason}` : '';
}

// SOURCE-DERIVED: CLI v2.116.0 makeTable/RenderTable preserves body backticks.
// Actual compatibility still requires a successful authorized fresh CI history gate.
export function parseMigrationHistory(output) {
  requireHistory(typeof output === 'string', 'cell-content');
  requireHistory(output.length <= 4096, 'length-cap');
  requireHistory(/^[\x20-\x7e\r\n]*$/.test(output), 'charset');
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim());
  requireHistory(lines.length === MIGRATIONS.length + 2, 'line-count');
  const cells = (line) => line.split('|').map((cell) => cell.trim());
  requireHistory(JSON.stringify(cells(lines[0])) === JSON.stringify(['Local', 'Remote', 'Time (UTC)']), 'header');
  requireHistory(/^-+\|-+\|-+$/.test(lines[1]), 'separator');
  const rows = lines.slice(2).map((line, index) => {
    const quoted = cells(line);
    requireHistory(quoted.length === 3, 'cell-count');
    const row = quoted.map((cell) => {
      requireHistory(/^`[^`]*`$/.test(cell), 'cell-quoting');
      const inner = cell.slice(1, -1);
      requireHistory(inner.length > 0 && (inner === ' ' || inner.trim() === inner), 'cell-content');
      return inner === ' ' ? '' : inner;
    });
    const { version, time } = MIGRATIONS[index];
    requireHistory(row[0] === version, 'version-mismatch');
    requireHistory(row[1] === '' || row[1] === version, 'remote-mismatch');
    requireHistory(row[2] === time, 'time-mismatch');
    return { local: row[0], applied: row[1] };
  });
  return {
    applied: rows.filter((row) => row.applied !== '').map((row) => row.applied),
    pending: rows.filter((row) => row.applied === '').map((row) => row.local),
  };
}

export function assertHistory(output, stage) {
  requireHistory(stage === 'base' || stage === 'target', 'inventory-mismatch');
  const inventory = parseMigrationHistory(output);
  const expected = stage === 'base'
    ? { applied: [MIGRATIONS[0].version], pending: MIGRATIONS.slice(1).map((entry) => entry.version) }
    : { applied: MIGRATIONS.map((entry) => entry.version), pending: [] };
  requireHistory(JSON.stringify(inventory) === JSON.stringify(expected), 'inventory-mismatch');
  return inventory;
}

export function assertHistoryResult(result, stage) {
  requireHistory(result?.code === 0, 'history-command');
  return assertHistory(result.stdout, stage);
}

export function exportBodyEvidence(sql) {
  requireEvidence(typeof sql === 'string');
  const declaration = /create(?: or replace)? function public\.export_manifest\(p_export_id uuid\) returns jsonb\nlanguage sql stable security invoker set search_path = '' as \$\$\n/g;
  const matches = [...sql.matchAll(declaration)];
  requireEvidence(matches.length === 1);
  // Include the opening newline: do not trim PostgreSQL's stored body literal.
  const start = matches[0].index + matches[0][0].length - 1;
  const end = sql.indexOf('\n$$;', start);
  requireEvidence(end > start && !sql.slice(start, end).includes('$$'));
  const body = sql.slice(start, end + 1);
  return { bytes: Buffer.byteLength(body), md5: createHash('md5').update(body).digest('hex') };
}

async function history(stage) {
  const result = await cli(['migration', 'list', '--local']);
  const inventory = assertHistoryResult(result, stage);
  console.log(`PASS: history ${stage} applied=${inventory.applied.join(',')} pending=${inventory.pending.join(',') || 'none'}`);
}

async function main() {
  let stage = 'guards', run, ownsSnapshot = false;
  try {
    assertRehearsalEnvironment(process.env, process.argv.slice(2));
    await assertProjectConfig();
    await requireDocker();
    await requireLocalContainer();
    await assertMigrationInventory();
    stage = 'capabilities';
    const help = [];
    for (const args of [['db', 'reset', '--help'], ['migration', 'up', '--help'], ['migration', 'list', '--help']]) {
      help.push(await cli(args));
    }
    assertCapabilities(help);
    console.log(`PASS: pinned 2.116.0 capabilities and exact ${MIGRATIONS.length}-source inventory`);
    for (const entry of MIGRATIONS) console.log(`PASS: source ${entry.version} bytes=${entry.bytes} sha256=${entry.sha256}`);
    stage = 'S1-base-reset';
    requireEvidence((await cli(['db', 'reset', '--local', '--no-seed', '--yes', '--version', MIGRATIONS[0].version], 10 * 60_000)).code === 0);
    stage = 'S1-base-history';
    await history('base');
    stage = 'S1-provision';
    requireEvidence((await runCommand(process.execPath, [path.join(ROOT, 'scripts', 'provision-test-users.mjs')])).code === 0);
    const env = normalSessionEnvironment(process.env, await readCredentialCache());
    validateSessionEnvironment(env);
    run = randomUUID();
    await assertSnapshotAbsent(run);
    ownsSnapshot = true;
    const child = async (phase) => {
      const result = await runCommand(process.execPath, [
        path.join(ROOT, 'tests', 'integration', 'preservation.sessions.mjs'), phase, run,
      ], { env });
      // Never forward child assertions, HTTP data or arbitrary exception text.
      requireEvidence(result.code === 0 && result.stdout.trim() === `PASS: preservation ${phase}; owners=2 tables=10 rows=30 objects=8`);
      console.log(result.stdout.trim());
    };
    stage = 'S2-capture';
    await child('capture');
    stage = 'S3-inventory';
    await assertMigrationInventory();
    stage = 'S3-base-history';
    await history('base');
    stage = 'S3-migration-up';
    requireEvidence((await cli(['migration', 'up', '--local'])).code === 0);
    stage = 'S3-target-history';
    await history('target');
    stage = 'S4-verify';
    await child('verify');
    stage = 'S4-checked-save-catalog';
    const catalog = JSON.parse(await privilegedLocalSql(ITEM_SAVE_CATALOG_SQL));
    requireEvidence(Object.keys(catalog).length === 8 && Object.values(catalog).every((value) => value === true));
    console.log('PASS: checked Save catalog protections/profile cascade; account-deletion journey NOT RUN');
    stage = 'S4-item-lifecycle-catalog';
    const lifecycleCatalog = JSON.parse(await privilegedLocalSql(ITEM_LIFECYCLE_CATALOG_SQL));
    requireEvidence(Object.keys(lifecycleCatalog).length === 11 && Object.values(lifecycleCatalog).every((value) => value === true));
    console.log('PASS: I08 private claims, privileged fresh guards and narrow Storage policy catalog');
    stage = 'S4-item-lifecycle-fixtures';
    const { lifecycleFixtureCases } = await import('../tests/integration/item-lifecycle.sessions.mjs');
    await lifecycleFixtureCases(env, { withLifecycleParentLock, withLifecycleCatalogMarker });
    console.log('PASS: I08 CI-only exact-parent overlap and catalog-marker setup; ordinary-owner assertions; no physical erasure claim');
    console.log('PASS: populated base-to-target preservation and bounded post-comparison probes');
  } catch (error) {
    console.error(`FAIL: preservation ${stage}; EVIDENCE_REQUIRED${historyFailureDetail(error)}; subsequent stages NOT RUN`);
    process.exitCode = 1;
  } finally {
    if (ownsSnapshot) {
      try {
        await cleanupSnapshot(run);
        console.log('PASS: exact-run snapshot cleanup');
      } catch {
        console.error('FAIL: preservation cleanup; EVIDENCE_REQUIRED');
        process.exitCode = 1;
      }
    }
  }
}

if (isMain(import.meta.url)) await main();
