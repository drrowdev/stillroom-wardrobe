import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ROOT, assertNoServiceSecrets, assertProjectConfig, requireDocker, requireLocalContainer,
  cli, runCommand, normalSessionEnvironment, readCredentialCache, validateSessionEnvironment, privilegedLocalSql,
  DB_CONTAINER, commandEnvironment, jwtClaims, reportError, startAnalysisServer,
} from './backend/local.mjs';
import { PUBLICATION_BODY_MD5, assertCiStorageGuardInstall, installCiStorageGuard, verifyCiStorageGuard } from './backend/ci-storage-guard.mjs';
import { isMain } from './quality/files.mjs';
import {
  SOURCE_HASHES, requireEvidence, assertSnapshotAbsent, cleanupSnapshot,
} from '../tests/integration/preservation.sessions.mjs';
import { captureAzurePreservation, verifyAzurePreservation,
  captureImageChangePreservation, verifyImageChangePreservation } from '../tests/integration/azure-preservation.sessions.mjs';

const PRIOR_MAIN_VERSION = '20260913120000';
const AZURE_TARGET_VERSION = '20260921193000';

export const MIGRATIONS = Object.freeze([
  { name: '20260905000000_initial.sql', version: '20260905000000', time: '2026-09-05 00:00:00', bytes: 35214, sha256: SOURCE_HASHES.base },
  { name: '20260906000000_item_field_provenance.sql', version: '20260906000000', time: '2026-09-06 00:00:00', bytes: 5923, sha256: SOURCE_HASHES.target },
  { name: '20260909070000_item_description_edit.sql', version: '20260909070000', time: '2026-09-09 07:00:00', bytes: 2618, sha256: SOURCE_HASHES.description },
  { name: '20260909110000_item_optional_collections.sql', version: '20260909110000', time: '2026-09-09 11:00:00', bytes: 454, sha256: SOURCE_HASHES.collections },
  { name: '20260909180000_ai_request_controls.sql', version: '20260909180000', time: '2026-09-09 18:00:00', bytes: 28579, sha256: SOURCE_HASHES.controls },
  { name: '20260910070000_checked_item_save.sql', version: '20260910070000', time: '2026-09-10 07:00:00', bytes: 16801, sha256: SOURCE_HASHES.save },
  { name: '20260911040000_ai_analysis_backend.sql', version: '20260911040000', time: '2026-09-11 04:00:00', bytes: 24856, sha256: SOURCE_HASHES.analysis },
  { name: '20260911200000_checked_ai_item_save.sql', version: '20260911200000', time: '2026-09-11 20:00:00', bytes: 29668, sha256: SOURCE_HASHES.analyzedSave },
  { name: '20260913120000_item_lifecycle.sql', version: '20260913120000', time: '2026-09-13 12:00:00', bytes: 20822, sha256: SOURCE_HASHES.lifecycle },
  { name: '20260921193000_azure_terra_analysis.sql', version: '20260921193000', time: '2026-09-21 19:30:00', bytes: 29274, sha256: SOURCE_HASHES.azure },
  { name: '20260922020000_checked_image_changes.sql', version: '20260922020000', time: '2026-09-22 02:00:00', bytes: 82482, sha256: SOURCE_HASHES.imageChanges },
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
  'guards',(select count(*)=6 and bool_and(p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(p.proconfig) and 'lock_timeout=2s'=any(p.proconfig)
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and has_function_privilege('authenticated',p.oid,'EXECUTE')=(p.proname='may_create_item_object')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    from pg_catalog.pg_proc p where p.oid=any(array['private.item_lifecycle_owner()'::regprocedure,
      'private.guard_item_deletion()'::regprocedure,'private.guard_item_image_deletion()'::regprocedure,
      'private.may_create_item_object(text)'::regprocedure,'private.record_item_image_identity()'::regprocedure,
      'private.guard_item_object_publication()'::regprocedure])),
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
  'registryRls',(select c.relrowsecurity from pg_catalog.pg_class c where c.oid='private.item_image_used_ids'::regclass)
    and not exists(select 1 from pg_catalog.pg_policies where schemaname='private' and tablename='item_image_used_ids'),
  'registryColumns',(select array_agg(a.attname::text order by a.attnum)=array['owner_id','image_id']
      and bool_and(a.atttypid='uuid'::regtype and a.attnotnull) from pg_catalog.pg_attribute a
    where a.attrelid='private.item_image_used_ids'::regclass and a.attnum>0 and not a.attisdropped),
  'registryKeys',(select count(*)=2 and bool_and(pg_get_constraintdef(c.oid)=any(array[
      'PRIMARY KEY (owner_id, image_id)','FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE']))
    from pg_catalog.pg_constraint c where c.conrelid='private.item_image_used_ids'::regclass),
  'registryDenied',(select bool_and(not has_table_privilege(r,'private.item_image_used_ids','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    from unnest(array['anon','authenticated']) r),
  'identityTrigger',(select count(*)=1 and bool_and(t.tgenabled='A' and not t.tgisinternal and not t.tgdeferrable
      and t.tgtype=5 and t.tgrelid='public.item_images'::regclass and t.tgfoid='private.record_item_image_identity()'::regprocedure)
    from pg_catalog.pg_trigger t where t.tgname='item_image_identity_guard'),
  'publicationTrigger',(select count(*)=1 and bool_and(t.tgenabled='A' and not t.tgisinternal and not t.tgdeferrable
      and t.tgtype=21 and t.tgrelid='storage.objects'::regclass and t.tgfoid='private.guard_item_object_publication()'::regprocedure)
    from pg_catalog.pg_trigger t where t.tgname='item_object_publication_guard'),
  'nativeOperation',(select p.provolatile='s' and p.prorettype='boolean'::regtype
      and md5(p.prosrc)='8682c6d323bc2e01e70abf92f4ae85f6'
    from pg_catalog.pg_proc p where p.oid='storage.allow_only_operation(text)'::regprocedure)
    and not storage.allow_only_operation('storage.object.upload')
    and not storage.allow_only_operation('storage.object.delete')
    and (select md5(p.prosrc)='998d324ea2b1abc49351e8c2367b5796' from pg_catalog.pg_proc p
      where p.oid='storage.protect_delete()'::regprocedure)
    and exists(select 1 from pg_catalog.pg_constraint c where c.conrelid='storage.buckets'::regclass
      and c.conname='buckets_versioning_dark_check' and c.convalidated
      and pg_get_constraintdef(c.oid)='CHECK ((versioning_status = ''DISABLED''::text))'),
  'sourcePins',(select count(*)=11 and bool_and(md5(p.prosrc)=expected.hash)
    from (values
      ('private.record_item_image_identity()','429fea268470e1b8d135de612f4c8a22'),
      ('private.item_lifecycle_manifest(jsonb)','d9b3ad0180f0ecd8585c80966eb3cddd'),
      ('private.item_lifecycle_owner()','5f4e91aa94e250ed1367753d82de73c4'),
      ('private.guard_item_deletion()','a3215f653a4b240d691f7a4a16be4cbd'),
      ('private.guard_item_image_deletion()','dc3c9d450fb27915b20ac84313acf80e'),
      ('private.may_create_item_object(text)','93443dd83aaec31f8696ca844331dd83'),
      ('private.guard_item_object_publication()','${PUBLICATION_BODY_MD5}'),
      ('public.set_item_trashed(uuid,bigint,boolean)','c27f9c20cb84663278c1b7adc465311e'),
      ('public.item_deletion_status(uuid[])','4b9f170466dcac2472112ea5cb6b3a67'),
      ('public.begin_item_deletion(uuid,bigint,uuid,text)','c9bb6b0a059b4bd19e7dcbb5800f1151'),
      ('public.finish_item_deletion(uuid,uuid)','7dbb0841f466bd4b7da3b56e6bb4ad0a')
    ) expected(identity,hash) join pg_catalog.pg_proc p on p.oid=expected.identity::regprocedure),
  'storageReadDelete',(select count(*)=2 and bool_and(
      cmd=case policyname when 'wardrobe_read' then 'SELECT' when 'wardrobe_delete' then 'DELETE' end
      and roles=array['authenticated']::name[] and with_check is null)
    from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and policyname in ('wardrobe_read','wardrobe_delete'))
      and (select count(*)=2 and bool_and(qual is not null and qual=case policyname
        when 'wardrobe_read' then '((bucket_id = ''wardrobe''::text) AND (private.owns_storage_path(name, false) OR (private.may_delete_storage(name) AND storage.allow_only_operation(''storage.object.delete''::text))))'
        when 'wardrobe_delete' then '((bucket_id = ''wardrobe''::text) AND private.may_delete_storage(name) AND storage.allow_only_operation(''storage.object.delete''::text))' end)
    from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and policyname in ('wardrobe_read','wardrobe_delete'))
      and (select array_agg(policyname::text order by policyname::text)=array['wardrobe_create','wardrobe_delete','wardrobe_read']::text[]
        from pg_catalog.pg_policies where schemaname='storage' and tablename='objects')
      and not exists(select 1 from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and cmd in ('UPDATE','ALL'))
);`;

export const STORAGE_CATALOG_INVENTORY_SQL = `
with report as (select jsonb_build_object(
  'triggers',(select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'type',t.tgtype,
    'deferred',t.tgdeferrable,'schema',n.nspname,'function',p.proname,
    'definition',pg_get_triggerdef(t.oid,true)) order by t.tgname)
    from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where t.tgrelid='storage.objects'::regclass and not t.tgisinternal),
  'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),
    'definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,'acl',p.proacl,
    'definition',pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='storage' and (p.oid in(select tgfoid from pg_catalog.pg_trigger where tgrelid='storage.objects'::regclass)
      or p.proname in('allow_only_operation','operation','protect_delete'))),
  'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
    'nullable',not a.attnotnull,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
    from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='storage.objects'::regclass and a.attnum>0 and not a.attisdropped),
  'constraints',(select jsonb_agg(pg_get_constraintdef(c.oid) order by c.conname)
    from pg_catalog.pg_constraint c where c.conrelid in('storage.objects'::regclass,'storage.buckets'::regclass)),
  'prefixesPresent',to_regclass('storage.prefixes') is not null,
  'deleteProtected',(select count(*)=1 and bool_and(t.tgtype=10 and t.tgenabled in('O','A')
      and not t.tgdeferrable and t.tgfoid='storage.protect_delete()'::regprocedure)
    from pg_catalog.pg_trigger t where t.tgrelid='storage.objects'::regclass and t.tgname='protect_objects_delete'),
  'wardrobeVersioningDisabled',(select versioning_status='DISABLED' from storage.buckets where id='wardrobe')
) as value)
select case when octet_length(value::text)<=32768 then value else '{"blocked":true}'::jsonb end from report;`;

export function requireStorageCatalogInventory(value) {
  requireEvidence(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'columns,constraints,deleteProtected,functions,prefixesPresent,triggers,wardrobeVersioningDisabled'
    && value.deleteProtected === true && value.wardrobeVersioningDisabled === true && value.prefixesPresent === false
    && Array.isArray(value.triggers) && value.triggers.length <= 16
    && Array.isArray(value.functions) && value.functions.length <= 20
    && Array.isArray(value.columns) && value.columns.length <= 32 && Array.isArray(value.constraints) && value.constraints.length <= 32);
  for (const field of ['triggers', 'functions', 'columns', 'constraints']) requireEvidence(value[field].length > 0);
  for (const [name, type, nullable, defaultValue] of [
    ['owner', 'uuid', true, null], ['owner_id', 'text', true, null], ['version', 'text', true, null],
    ['archived_at', 'timestamp with time zone', true, null],
    ['is_delete_marker', 'boolean', false, 'false'], ['is_versioned', 'boolean', false, 'false'],
  ]) {
    const columns = value.columns.filter((column) => column?.name === name);
    requireEvidence(columns.length === 1 && columns[0].type === type && columns[0].nullable === nullable
      && columns[0].default === defaultValue && columns[0].generated === '');
  }
  const text = JSON.stringify(value);
  requireEvidence(Buffer.byteLength(text) <= 32768);
  // Exact observed native executable definitions still require coordinator review. No baseline is auto-enrolled.
  console.log('I08 vendor catalog REVIEW_REQUIRED ' + createHash('sha256').update(text).digest('hex') + ' ' + text);
}

export function assertLifecycleFixture(env, ownerId, itemId) {
  assertRehearsalEnvironment(env, []);
  requireEvidence(env.ALLOW_SECURITY_TESTS === '1');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  requireEvidence(uuid.test(ownerId) && uuid.test(itemId) && itemId.startsWith('1080'));
}

// CI-only setup, not an access assertion or a general SQL callback.
export async function withLifecycleParentLock(ownerId, itemId, mode, operation) {
  assertLifecycleFixture(process.env, ownerId, itemId);
  requireEvidence(['update', 'key share', 'owner share', 'owner no key update', 'deletion update'].includes(mode) && typeof operation === 'function');
  const lock = mode.startsWith('owner ')
    ? `private.approved_accounts where user_id='${ownerId}' and enabled for ${mode.slice(6)} nowait`
    : mode === 'deletion update'
      ? `private.item_deletion_operations where owner_id='${ownerId}' and item_id='${itemId}' and phase='prepared' for update nowait`
      : `public.items where owner_id='${ownerId}' and id='${itemId}' for ${mode} nowait`;
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
        perform 1 from ${lock};
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

export async function withLifecycleCatalogMarker(ownerId, itemId, operation, { imageId, remove }) {
  assertLifecycleFixture(process.env, ownerId, itemId);
  requireEvidence(typeof operation === 'function' && typeof remove === 'function'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(imageId));
  const markerId = randomUUID(), name = `${ownerId}/${itemId}/${imageId}/thumb.jpg`;
  // A canonical pending image must pass the real publication guard. No blob is created.
  let phase = 'setup', primaryPhase, cleanupPhase;
  let created = false, primaryFailed = false, primaryValue, cleanupFailed = false, cleanupValue;
  const cleanupFailure = (error) => {
    if (!cleanupFailed) { cleanupFailed = true; cleanupValue = error; cleanupPhase = phase; }
  };
  try {
    const setup = await privilegedLocalSql(`do $$ begin
      if exists(select 1 from private.item_deletion_claims where owner_id='${ownerId}' and item_id='${itemId}')
        or not exists(select 1 from public.item_images where owner_id='${ownerId}' and item_id='${itemId}'
          and id='${imageId}' and state='pending' and thumb_path='${name}')
        or exists(select 1 from storage.objects where bucket_id='wardrobe' and starts_with(name,'${ownerId}/${itemId}/'))
        then raise exception 'Fixture state'; end if;
      insert into storage.objects(id,bucket_id,name,owner,owner_id,version)
        values('${markerId}','wardrobe','${name}','${ownerId}','${ownerId}','${randomUUID()}');
      update storage.objects set metadata='{}'::jsonb where id='${markerId}';
      begin
        update storage.objects set version='forbidden-replacement' where id='${markerId}';
        raise exception 'Version replacement accepted';
      exception when unique_violation then null; end;
      begin
        update storage.objects set owner_id=null where id='${markerId}';
        raise exception 'Identity replacement accepted';
      exception when insufficient_privilege then null; end;
      begin
        update storage.objects set is_delete_marker=true where id='${markerId}';
        raise exception 'Versioning replacement accepted';
      exception when insufficient_privilege then null; end;
      end $$; select 'I08_MARKER_CREATED';`);
    requireEvidence(setup === 'I08_MARKER_CREATED');
    created = true;
    phase = 'callback';
    await operation(name);
  } catch (error) {
    primaryFailed = true;
    primaryValue = error;
    primaryPhase = phase;
  }
  try {
    phase = 'cleanup-count';
    const cleanup = await privilegedLocalSql(`select count(*) from storage.objects
      where id='${markerId}' and bucket_id='wardrobe' and name='${name}';`);
    requireEvidence(created ? cleanup === '1' : ['0', '1'].includes(cleanup));
    if (cleanup === '1') {
      phase = 'removal';
      requireEvidence(await remove(name) === 'removed');
    }
  } catch (error) { cleanupFailure(error); }
  try {
    phase = 'final-absence';
    requireEvidence(await privilegedLocalSql(`select count(*) from storage.objects
          where id='${markerId}' or (bucket_id='wardrobe' and name='${name}');`) === '0');
  } catch (error) { cleanupFailure(error); }
  if (cleanupFailed) {
    phase = 'notice';
    try { console.error('FAIL: I08 exact catalog-marker cleanup'); } catch (error) { cleanupFailure(error); }
  }
  if (primaryFailed || cleanupFailed) {
    phase = 'notice';
    try { console.error(`FAIL: I08 catalog-marker primary=${primaryFailed ? primaryPhase : 'none'}; cleanup=${cleanupFailed ? cleanupPhase : 'none'}`); }
    catch (error) { cleanupFailure(error); }
  }
  if (primaryFailed) throw primaryValue;
  if (cleanupFailed) throw cleanupValue;
}

export async function requireLifecyclePrefixEmpty(ownerId, itemId) {
  assertLifecycleFixture(process.env, ownerId, itemId);
  requireEvidence(await privilegedLocalSql(`select count(*) from storage.objects
    where bucket_id='wardrobe' and starts_with(name,'${ownerId}/${itemId}/');`) === '0');
  console.log('PASS: I08 labelled privileged structural catalog-prefix count=0; not physical remnant proof');
}

export async function requireLifecycleClaimFence(ownerId, itemId, imageId) {
  assertLifecycleFixture(process.env, ownerId, itemId);
  requireEvidence(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(imageId));
  requireEvidence(await privilegedLocalSql(`do $$ declare refused boolean:=false; begin
    if not exists(select 1 from private.item_deletion_claims where owner_id='${ownerId}' and item_id='${itemId}')
      or not exists(select 1 from public.item_images where owner_id='${ownerId}' and item_id='${itemId}' and id='${imageId}')
      or exists(select 1 from storage.objects where bucket_id='wardrobe' and starts_with(name,'${ownerId}/${itemId}/'))
      then raise exception 'Fixture state'; end if;
    begin
      insert into storage.objects(bucket_id,name,owner_id,version)
        values('wardrobe','${ownerId}/${itemId}/${imageId}/thumb.jpg','${ownerId}','1');
    exception when insufficient_privilege then refused:=true; end;
    if not refused then raise exception 'Publication accepted'; end if;
  end $$; select 'I08_PUBLICATION_REFUSED';`) === 'I08_PUBLICATION_REFUSED');
  console.log('PASS: I08 labelled privileged post-claim publication refusal; not ordinary upload proof');
}

const LIFECYCLE_PHASES = Object.freeze(['input', 'docker', 'container-call', 'container-result', 'container-shape',
  'image-call', 'image-result', 'image-shape', 'spawn', 'input-write', 'await-ready', 'callback', 'settlement', 'cleanup']);
const LIFECYCLE_CAUSES = Object.freeze(['refusal', 'exception', 'process-error', 'process-close', 'stdin-error',
  'stderr', 'output-cap', 'utf8', 'json', 'protocol', 'deadline', 'cleanup']);
const LIFECYCLE_CONTAINER_GUARDS = Object.freeze(['parse', 'name', 'project', 'running', 'image-tag', 'image-id', 'mount-array',
  'mount-count', 'mount-type', 'mount-name', 'mount-target', 'mount-rw', 'config-array', 'config-count',
  'config-backend', 'config-root', 'config-tenant', 'config-bucket', 'config-sentinel']);
const LIFECYCLE_CHILD_PHASES = Object.freeze(['input', 'ancestors', 'item-absence', 'target-absence', 'request', 'write',
  'file-poll', 'ready-check', 'ready', 'complete', 'response', 'cleanup']);
const LIFECYCLE_CHILD_CAUSES = Object.freeze(['refusal', 'exception', 'deadline', 'early-response',
  'request-error', 'response-error', 'response-aborted', 'body-cap', 'response-contract', 'cleanup']);
const lifecycleErrorAssociations = new WeakMap();
let lifecycleActive = null, lifecycleFailure = null;
const lifecycleLabel = (labels, value) => labels.find((label) => label === value) ?? 'OTHER';
const lifecycleInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
const lifecyclePrimitive = (value) => value === undefined ? 'undefined' : value === null ? 'null'
  : value === false ? 'false' : Object.is(value, 0) ? 'zero' : Object.is(value, -0) ? 'negative-zero' : value === '' ? 'empty' : null;
function lifecyclePhase(phase) {
  if (lifecycleActive) {
    lifecycleActive.phase = lifecycleLabel(LIFECYCLE_PHASES, phase);
    lifecycleActive.commandCode = null; lifecycleActive.guard = null;
  }
}
function lifecycleGuard(guard) {
  if (lifecycleActive) lifecycleActive.guard = lifecycleLabel(LIFECYCLE_CONTAINER_GUARDS, guard);
}
function lifecycleCommand(result) {
  try {
    const descriptor = result && typeof result === 'object' ? Object.getOwnPropertyDescriptor(result, 'code') : undefined;
    if (lifecycleActive) lifecycleActive.commandCode = descriptor && Object.hasOwn(descriptor, 'value')
      ? lifecycleInteger(descriptor.value, 0, 255) : null;
  } catch { /* Diagnostic reflection cannot change the original result guard. */ }
}
function lifecycleFirst(state, cause) {
  if (state && !state.first) state.first = { phase: state.phase, cause: lifecycleLabel(LIFECYCLE_CAUSES, cause),
    commandCode: state.commandCode, exitCode: state.exitCode,
    ...(state.phase === 'container-shape' ? { guard: lifecycleLabel(LIFECYCLE_CONTAINER_GUARDS, state.guard) } : {}), ...state.child };
}
export function lifecycleFailureDetail(error) {
  const failure = lifecycleFailure;
  lifecycleFailure = null;
  if (!failure) return '';
  const associated = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? lifecycleErrorAssociations.get(error) === failure
    : failure.primitive !== null && lifecyclePrimitive(error) === failure.primitive;
  try { return associated ? '; lifecycle=' + JSON.stringify(failure.first) : ''; }
  catch { return ''; }
}

export async function lifecycleStorageRuntime(run = runCommand) {
  assertRehearsalEnvironment(process.env, []);
  lifecyclePhase('docker');
  await requireDocker(run);
  const container = 'supabase_storage_stillroom-wardrobe';
  const template = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},'
    + '"image":{{json .Config.Image}},"id":{{json .Image}},"running":{{json .State.Running}},'
    + '"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"target":{{json $m.Destination}},"rw":{{$m.RW}}}{{end}}],'
    + '"config":[{{range .Config.Env}}{{if or (eq (index (split . "=") 0) "STORAGE_BACKEND") (eq (index (split . "=") 0) "FILE_STORAGE_BACKEND_PATH") (eq (index (split . "=") 0) "TENANT_ID") (eq (index (split . "=") 0) "GLOBAL_S3_BUCKET")}}{{json .}},{{end}}{{end}}null]}';
  lifecyclePhase('container-call');
  const result = await run('docker', ['container', 'inspect', '--format', template, container], { maxOutputBytes: 4096 });
  lifecyclePhase('container-result'); lifecycleCommand(result);
  requireEvidence(result.code === 0);
  lifecyclePhase('container-shape');
  lifecycleGuard('parse');
  const value = JSON.parse(result.stdout);
  lifecycleGuard('name');
  requireEvidence(value.name === '/' + container);
  lifecycleGuard('project');
  requireEvidence(value.project === 'stillroom-wardrobe');
  lifecycleGuard('running');
  requireEvidence(value.running === true);
  lifecycleGuard('image-tag');
  requireEvidence(/^(?:public\.ecr\.aws\/supabase|supabase)\/storage-api:v1\.70\.3$/.test(value.image));
  lifecycleGuard('image-id');
  requireEvidence(/^sha256:[0-9a-f]{64}$/.test(value.id));
  lifecycleGuard('mount-array');
  requireEvidence(Array.isArray(value.mounts));
  lifecycleGuard('mount-count');
  requireEvidence(value.mounts.length === 1);
  lifecycleGuard('mount-type');
  requireEvidence(value.mounts[0].type === 'volume');
  lifecycleGuard('mount-name');
  requireEvidence(value.mounts[0].name === container);
  lifecycleGuard('mount-target');
  requireEvidence(value.mounts[0].target === '/mnt');
  lifecycleGuard('mount-rw');
  requireEvidence(value.mounts[0].rw === true);
  lifecycleGuard('config-array');
  requireEvidence(Array.isArray(value.config));
  lifecycleGuard('config-count');
  requireEvidence(value.config.length === 5);
  lifecycleGuard('config-backend');
  requireEvidence(value.config.includes('STORAGE_BACKEND=file'));
  lifecycleGuard('config-root');
  requireEvidence(value.config.includes('FILE_STORAGE_BACKEND_PATH=/mnt'));
  lifecycleGuard('config-tenant');
  requireEvidence(value.config.includes('TENANT_ID=stub'));
  lifecycleGuard('config-bucket');
  requireEvidence(value.config.includes('GLOBAL_S3_BUCKET=stub'));
  lifecycleGuard('config-sentinel');
  requireEvidence(value.config.includes(null));
  lifecyclePhase('image-call');
  const image = await run('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}', value.id],
    { maxOutputBytes: 4096 });
  lifecyclePhase('image-result'); lifecycleCommand(image);
  requireEvidence(image.code === 0);
  lifecyclePhase('image-shape');
  const pinned = JSON.parse(image.stdout);
  requireEvidence(pinned.id === value.id && Array.isArray(pinned.digests) && pinned.digests.length >= 1
    && pinned.digests.length <= 4 && pinned.digests.every((entry) =>
      typeof entry === 'string' && /^(?:public\.ecr\.aws\/supabase|supabase)\/storage-api@sha256:[0-9a-f]{64}$/.test(entry)));
  console.log(JSON.stringify({ i08: 'runtime-review-required', image: value.image, id: value.id, digests: pinned.digests }));
  return container;
}

// Executed only inside the verified owned FileBackend container. Its stdin is the sole credential channel.
export async function lifecycleStreamChild() {
  const phases = ['input', 'ancestors', 'item-absence', 'target-absence', 'request', 'write', 'file-poll', 'ready-check', 'ready', 'complete', 'response', 'cleanup'];
  const causes = ['refusal', 'exception', 'deadline', 'early-response', 'request-error', 'response-error', 'response-aborted', 'body-cap', 'response-contract', 'cleanup'];
  let phase = 'input', first = null;
  const observe = (cause) => { if (!first) first = {
    phase: phases.find((label) => label === phase) ?? 'OTHER', cause: causes.find((label) => label === cause) ?? 'OTHER',
  }; };
  const { request } = await import('node:http');
  const fs = await import('node:fs/promises');
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let req, response, timer, pollTimer, bytes = 0, primaryFailed = false, cleanupFailed = false;
  let requestClosed = Promise.resolve(), responseDone = Promise.resolve();
  let resolveResponse;
  let status = null, denied = false, released = false;
  const demand = (condition) => { if (!condition) { observe('refusal'); throw new Error('EVIDENCE_REQUIRED'); } };
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  const cleanup = (action) => { try { action(); } catch { observe('cleanup'); cleanupFailed = true; } };
  try {
    timer = setTimeout(() => {
      observe('deadline');
      primaryFailed = true;
      cleanup(() => req?.destroy(new Error('EVIDENCE_REQUIRED')));
      cleanup(() => response?.destroy());
      cleanup(() => lines.close());
    }, 15_000);
    const input = await iterator.next();
    demand(!input.done && Buffer.byteLength(input.value) <= 8192);
    const value = JSON.parse(input.value);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const keys = Object.keys(value).sort().join(',');
    demand((keys === 'image,item,owner,token'
      || (keys === 'image,item,owner,precondition,token' && value.precondition === 'pending-thumb-absent'))
      && uuid.test(value.owner) && uuid.test(value.item) && value.item.startsWith('1080') && uuid.test(value.image)
      && typeof value.token === 'string' && value.token.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(value.token));
    const directory = `/mnt/stub/stub/wardrobe/${value.owner}/${value.item}/${value.image}/thumb.jpg`;
    const safeDirectory = async (name) => {
      try {
        const stat = await fs.lstat(name);
        demand(stat.isDirectory() && !stat.isSymbolicLink());
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    };
    phase = 'ancestors';
    for (const name of ['/mnt', '/mnt/stub', '/mnt/stub/stub', '/mnt/stub/stub/wardrobe',
      `/mnt/stub/stub/wardrobe/${value.owner}`]) await safeDirectory(name);
    if (value.precondition === 'pending-thumb-absent') {
      demand(await safeDirectory(`/mnt/stub/stub/wardrobe/${value.owner}/${value.item}`));
      demand(await safeDirectory(`/mnt/stub/stub/wardrobe/${value.owner}/${value.item}/${value.image}`));
      phase = 'target-absence';
      demand(!await safeDirectory(directory));
    } else {
      phase = 'item-absence';
      demand(!await safeDirectory(`/mnt/stub/stub/wardrobe/${value.owner}/${value.item}`));
    }
    responseDone = new Promise((resolve) => { resolveResponse = resolve; });
    phase = 'request';
    req = request({ hostname: '127.0.0.1', port: 5000,
      path: `/object/wardrobe/${value.owner}/${value.item}/${value.image}/thumb.jpg`, method: 'POST',
      headers: { Authorization: `Bearer ${value.token}`, 'Content-Type': 'image/jpeg', 'Content-Length': '4', 'x-upsert': 'false' } });
    requestClosed = new Promise((resolve) => req.once('close', resolve));
    req.once('error', () => { observe('request-error'); primaryFailed = true; resolveResponse(); });
    req.once('response', (incoming) => {
      response = incoming; status = incoming.statusCode ?? null;
      if (!released) { observe('early-response'); primaryFailed = true; }
      const chunks = [];
      incoming.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) { observe('body-cap'); primaryFailed = true; incoming.destroy(); }
        else chunks.push(chunk);
      });
      incoming.once('error', () => { observe('response-error'); primaryFailed = true; resolveResponse(); });
      incoming.once('aborted', () => { observe('response-aborted'); primaryFailed = true; resolveResponse(); });
      incoming.once('end', () => {
        try {
          const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          denied = status === 400 && body !== null && typeof body === 'object' && !Array.isArray(body)
            && Object.keys(body).sort().join(',') === 'code,error,message,statusCode'
            && body.statusCode === '403' && body.code === 'AccessDenied' && body.error === 'Unauthorized'
            && body.message === 'Not available';
          demand(denied);
        } catch { observe('response-contract'); primaryFailed = true; }
        resolveResponse();
      });
    });
    phase = 'write';
    req.write(Buffer.from([255, 216]));
    let ready = false;
    const started = Date.now();
    phase = 'file-poll';
    for (let attempt = 0; attempt < 100 && Date.now() - started < 5000 && !primaryFailed; attempt++) {
      await safeDirectory(`/mnt/stub/stub/wardrobe/${value.owner}/${value.item}`);
      await safeDirectory(`/mnt/stub/stub/wardrobe/${value.owner}/${value.item}/${value.image}`);
      if (await safeDirectory(directory)) {
        const entries = await fs.readdir(directory);
        demand(entries.length <= 1);
        if (entries.length === 1) {
          demand(uuid.test(entries[0]));
          const stat = await fs.lstat(directory + '/' + entries[0]);
          demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2);
          if (stat.size === 2) { ready = true; break; }
        }
      }
      await new Promise((resolve) => { pollTimer = setTimeout(resolve, 50); });
    }
    phase = 'ready-check';
    demand(ready && Date.now() - started < 5000 && !primaryFailed && !response);
    phase = 'ready';
    emit({ stage: 'ready', partialBytes: 2 });
    phase = 'complete';
    const command = await iterator.next();
    demand(!command.done && command.value === 'complete' && !primaryFailed);
    released = true;
    phase = 'response';
    req.end(Buffer.from([255, 217]));
    await responseDone; await requestClosed;
    demand(denied && !primaryFailed);
  } catch { observe('exception'); primaryFailed = true; }
  phase = 'cleanup';
  cleanup(() => req?.destroy());
  cleanup(() => response?.destroy());
  if (!req) cleanup(() => resolveResponse?.());
  try { await responseDone; await requestClosed; } catch { observe('cleanup'); cleanupFailed = true; }
  cleanup(() => clearTimeout(timer));
  cleanup(() => clearTimeout(pollTimer));
  cleanup(() => lines.close());
  cleanup(() => process.stdin.destroy());
  try { emit({ stage: 'settled', status, bodyBytes: bytes > 4096 ? null : bytes, denied, failed: primaryFailed || cleanupFailed,
    ...(primaryFailed || cleanupFailed ? first : {}) }); }
  catch { cleanupFailed = true; }
  if (primaryFailed || cleanupFailed) process.exitCode = 1;
}

export async function withLifecycleLateUpload(owner, value, operation, precondition = 'item-absent') {
  const state = { phase: 'input', commandCode: null, exitCode: null, guard: null, child: {}, first: null, primitive: null };
  lifecycleActive = state; lifecycleFailure = null;
  try { return await lifecycleLateUpload(owner, value, operation, state, precondition); }
  catch (error) {
    lifecycleFirst(state, 'exception');
    lifecycleFailure = state;
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) lifecycleErrorAssociations.set(error, state);
    else state.primitive = lifecyclePrimitive(error);
    throw error;
  } finally { lifecycleActive = null; }
}

async function lifecycleLateUpload(owner, value, operation, state, precondition) {
  requireEvidence(precondition === 'item-absent' || precondition === 'pending-thumb-absent');
  assertLifecycleFixture(process.env, owner.uid, value.p_item.id);
  const claims = jwtClaims(owner.token);
  requireEvidence(claims?.role === 'authenticated' && claims.sub === owner.uid && typeof operation === 'function'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.p_image.id));
  const container = await lifecycleStorageRuntime();
  const input = JSON.stringify({ owner: owner.uid, item: value.p_item.id, image: value.p_image.id, token: owner.token,
    ...(precondition === 'pending-thumb-absent' ? { precondition } : {}) });
  requireEvidence(Buffer.byteLength(input) <= 8192);
  lifecyclePhase('spawn');
  const child = spawn('docker', ['exec', '-i', container, 'env', '-i', '/usr/local/bin/node', '--input-type=module',
    '-e', `await (${lifecycleStreamChild.toString()})();`], {
    cwd: ROOT, env: commandEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let primaryFailed = false, primaryValue, cleanupFailed = false, cleanupValue, failed = false;
  let readySeen = false, settled = false, buffer = '', outputBytes = 0, rejectReady, resolveReady, resolveClosed;
  const capture = (error) => { lifecycleFirst(state, 'cleanup'); if (!cleanupFailed) { cleanupFailed = true; cleanupValue = error; } };
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const fail = (cause) => { lifecycleFirst(state, cause); failed = true; rejectReady(new Error('EVIDENCE_REQUIRED')); };
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
    child.once('error', () => { fail('process-error'); resolve(1); });
    child.once('close', (code) => { state.exitCode = lifecycleInteger(code, 0, 255); if (!settled) fail('process-close'); resolve(code); });
  });
  const terminate = () => {
    try { if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end('cancel\n'); } catch (error) { capture(error); }
  };
  // Child independently bounds its request to 15s, even if the docker client is interrupted.
  const timer = setTimeout(() => {
    fail('deadline'); terminate();
    try { child.kill('SIGTERM'); } catch (error) { capture(error); }
    // Failure, never successful settlement: an unacknowledged closure blocks this fixture.
    resolveClosed(1);
  }, 15_000);
  child.stdin.on('error', () => fail('stdin-error'));
  child.stderr.on('data', () => fail('stderr'));
  child.stdout.on('data', (chunk) => {
    let cause = 'output-cap';
    try {
      outputBytes += chunk.length;
      requireEvidence(outputBytes <= 1024);
      cause = 'utf8';
      buffer += new TextDecoder('utf-8', { fatal: true }).decode(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        cause = 'json';
        const record = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        cause = 'protocol';
        if (!readySeen && record.stage === 'ready' && record.partialBytes === 2 && Object.keys(record).length === 2) {
          readySeen = true; resolveReady();
        } else {
          if (record !== null && typeof record === 'object' && !Array.isArray(record)
            && Object.hasOwn(record, 'stage') && record.stage === 'settled'
            && Object.hasOwn(record, 'failed') && record.failed === true && !state.first) {
            const own = (key) => Object.hasOwn(record, key) ? record[key] : undefined;
            state.child = {
              childPhase: lifecycleLabel(LIFECYCLE_CHILD_PHASES, own('phase')),
              childCause: lifecycleLabel(LIFECYCLE_CHILD_CAUSES, own('cause')),
              status: lifecycleInteger(own('status'), 100, 599), bodyBytes: lifecycleInteger(own('bodyBytes'), 0, 1024),
              denied: typeof own('denied') === 'boolean' ? own('denied') : null, failed: true,
            };
          }
          requireEvidence(!settled && readySeen && record.stage === 'settled' && Object.keys(record).sort().join(',')
            === 'bodyBytes,denied,failed,stage,status');
          settled = true;
          requireEvidence(record.status === 400 && record.denied === true && record.failed === false
            && Number.isSafeInteger(record.bodyBytes) && record.bodyBytes >= 0 && record.bodyBytes <= 4096);
        }
      }
    } catch { fail(cause); terminate(); }
  });
  try {
    lifecyclePhase('input-write');
    child.stdin.write(input + '\n');
    lifecyclePhase('await-ready');
    await ready;
    lifecyclePhase('callback');
    await operation();
    requireEvidence(!failed);
    lifecyclePhase('settlement');
    child.stdin.end('complete\n');
    requireEvidence(await closed === 0 && settled && !failed && buffer === '');
  } catch (error) { lifecycleFirst(state, 'exception'); primaryFailed = true; primaryValue = error; }
  lifecyclePhase('cleanup');
  if (primaryFailed) terminate();
  try { requireEvidence(await closed === 0 && settled && !failed); } catch (error) { capture(error); }
  try { clearTimeout(timer); } catch (error) { capture(error); }
  if (cleanupFailed) {
    try { console.error('FAIL: I08 late-upload child settlement'); } catch (error) { capture(error); }
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
  requireHistory(['base', 'prior-main', 'azure-target', 'target'].includes(stage), 'inventory-mismatch');
  const priorMainIndex = MIGRATIONS.findIndex((entry) => entry.version === PRIOR_MAIN_VERSION);
  const azureIndex = MIGRATIONS.findIndex((entry) => entry.version === AZURE_TARGET_VERSION);
  requireHistory(priorMainIndex >= 0 && azureIndex === priorMainIndex + 1, 'inventory-mismatch');
  const inventory = parseMigrationHistory(output);
  const expected = stage === 'base'
    ? { applied: [MIGRATIONS[0].version], pending: MIGRATIONS.slice(1).map((entry) => entry.version) }
    : stage === 'prior-main'
      ? { applied: MIGRATIONS.slice(0, priorMainIndex + 1).map((entry) => entry.version),
        pending: MIGRATIONS.slice(priorMainIndex + 1).map((entry) => entry.version) }
      : stage === 'azure-target'
        ? { applied: MIGRATIONS.slice(0, azureIndex + 1).map((entry) => entry.version),
          pending: MIGRATIONS.slice(azureIndex + 1).map((entry) => entry.version) }
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

export function preservationStagePath(run) {
  requireEvidence(typeof run === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run));
  return path.join(ROOT, '.supabase', `preservation-stage-${run}`);
}

async function sameDatabaseIdentity() {
  await requireLocalContainer();
  const result = await runCommand('docker', ['container', 'inspect', '--format', '{{.Id}}', DB_CONTAINER], {
    env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096,
  });
  requireEvidence(result.code === 0 && result.stderr === '' && /^[0-9a-f]{64}\r?\n?$/.test(result.stdout));
  return result.stdout.trim();
}

// Copy-only ten-migration workdir: the existing CLI helper remains ROOT-bound.
export async function migrateToAzureTarget(run, from) {
  assertRehearsalEnvironment(process.env, []);
  assertCiStorageGuardInstall();
  requireEvidence(['base', 'prior-main'].includes(from));
  const directory = preservationStagePath(run), cache = path.dirname(directory);
  const cacheInfo = await lstat(cache);
  requireEvidence(cacheInfo.isDirectory() && !cacheInfo.isSymbolicLink());
  await assertProjectConfig(); await assertMigrationInventory(); await history(from);
  const container = await sameDatabaseIdentity();
  const configPath = path.join(ROOT, 'supabase', 'config.toml'), configInfo = await lstat(configPath);
  requireEvidence(configInfo.isFile() && !configInfo.isSymbolicLink() && configInfo.size <= 32768);
  const config = await readFile(configPath);
  const last = MIGRATIONS.findIndex((entry) => entry.version === AZURE_TARGET_VERSION);
  requireEvidence(last === 9);
  const prefix = MIGRATIONS.slice(0, last + 1);
  const files = await Promise.all(prefix.map(async (entry) => {
    const bytes = await readFile(path.join(ROOT, 'supabase', 'migrations', entry.name));
    requireEvidence(bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256);
    return { ...entry, content: bytes };
  }));
  // Non-recursive mkdir rejects any existing file, directory or symlink.
  await mkdir(directory);
  const created = await lstat(directory);
  let primary, failed = false;
  try {
    await mkdir(path.join(directory, 'supabase'));
    await mkdir(path.join(directory, 'supabase', 'migrations'));
    await writeFile(path.join(directory, 'supabase', 'config.toml'), config, { flag: 'wx' });
    for (const entry of files) await writeFile(path.join(directory, 'supabase', 'migrations', entry.name), entry.content, { flag: 'wx' });
    const inventory = await readdir(path.join(directory, 'supabase', 'migrations'), { withFileTypes: true });
    requireEvidence(inventory.every((entry) => entry.isFile() && !entry.isSymbolicLink())
      && JSON.stringify(inventory.map((entry) => entry.name).sort()) === JSON.stringify(prefix.map((entry) => entry.name)));
    requireEvidence((await readFile(path.join(directory, 'supabase', 'config.toml'))).equals(config));
    for (const entry of files) requireEvidence((await readFile(path.join(directory, 'supabase', 'migrations', entry.name))).equals(entry.content));
    requireEvidence(JSON.stringify((await readdir(directory)).sort()) === '["supabase"]'
      && JSON.stringify((await readdir(path.join(directory, 'supabase'))).sort()) === '["config.toml","migrations"]');
    const require = createRequire(import.meta.url), packagePath = require.resolve('supabase/package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    requireEvidence(pkg.version === '2.116.0' && typeof pkg.bin?.supabase === 'string');
    const entrypoint = path.join(path.dirname(packagePath), pkg.bin.supabase);
    const version = await runCommand(process.execPath, [entrypoint, '--agent', 'no', '--version']);
    requireEvidence(version.code === 0 && version.stdout.trim() === '2.116.0');
    await history(from); requireEvidence(await sameDatabaseIdentity() === container);
    const result = await runCommand(process.execPath, [entrypoint, '--agent', 'no', '--workdir', directory, 'migration', 'up', '--local'], {
      timeout: 120_000,
    });
    requireEvidence(result.code === 0);
    await history('azure-target'); requireEvidence(await sameDatabaseIdentity() === container);
    await assertMigrationInventory();
  } catch (error) { failed = true; primary = error; }
  try {
    const owned = await lstat(directory);
    requireEvidence(owned.isDirectory() && !owned.isSymbolicLink() && directory === preservationStagePath(run)
      && owned.dev === created.dev && owned.ino === created.ino);
    await rm(directory, { recursive: true, force: false });
  } catch (error) {
    console.error('FAIL: exact owned preservation stage cleanup; EVIDENCE_REQUIRED');
    if (!failed) { failed = true; primary = error; }
    process.exitCode = 1;
  }
  if (failed) throw primary;
}

async function main() {
  try { assertCiStorageGuardInstall(); }
  catch (error) { reportError(error); return; }
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
    await migrateToAzureTarget(run, 'base');
    stage = 'S3-storage-guard';
    await installCiStorageGuard();
    await verifyCiStorageGuard();
    stage = 'S3-target-history';
    await history('azure-target');
    stage = 'S4-verify';
    await child('verify');
    stage = 'S4-checked-save-catalog';
    const catalog = JSON.parse(await privilegedLocalSql(ITEM_SAVE_CATALOG_SQL));
    requireEvidence(Object.keys(catalog).length === 8 && Object.values(catalog).every((value) => value === true));
    console.log('PASS: checked Save catalog protections/profile cascade; account-deletion journey NOT RUN');
    stage = 'S4-item-lifecycle-catalog';
    const lifecycleCatalog = JSON.parse(await privilegedLocalSql(ITEM_LIFECYCLE_CATALOG_SQL));
    requireEvidence(Object.keys(lifecycleCatalog).length === 19 && Object.values(lifecycleCatalog).every((value) => value === true));
    requireStorageCatalogInventory(JSON.parse(await privilegedLocalSql(STORAGE_CATALOG_INVENTORY_SQL)));
    console.log('PASS: I08 private claims, privileged fresh guards and narrow Storage policy catalog');
    stage = 'S4-item-lifecycle-fixtures';
    const { lifecycleFixtureCases, lifecyclePublicationCases } = await import('../tests/integration/item-lifecycle.sessions.mjs');
    await lifecycleFixtureCases(env, { withLifecycleParentLock });
    await lifecyclePublicationCases(env, { withLifecycleCatalogMarker, withLifecycleLateUpload, requireLifecyclePrefixEmpty, requireLifecycleClaimFence });
    console.log('PASS: I08 CI-only exact-parent overlap and catalog-marker setup; ordinary-owner assertions; no physical erasure claim');
    console.log('PASS: populated base-to-target preservation and bounded post-comparison probes');
    stage = 'AZ1-prior-main-reset';
    requireEvidence((await cli(['db', 'reset', '--local', '--no-seed', '--yes', '--version', PRIOR_MAIN_VERSION], 10 * 60_000)).code === 0);
    await history('prior-main');
    await installCiStorageGuard(); await verifyCiStorageGuard();
    requireEvidence((await runCommand(process.execPath, [path.join(ROOT, 'scripts', 'provision-test-users.mjs')])).code === 0);
    const azureEnv = normalSessionEnvironment(process.env, await readCredentialCache());
    validateSessionEnvironment(azureEnv);
    stage = 'AZ1-prior-main-capture';
    const finalizer = await startAnalysisServer();
    try {
      finalizer.assertRunning();
      const priorMain = await captureAzurePreservation(azureEnv, privilegedLocalSql);
      await assertMigrationInventory(); await history('prior-main');
      stage = 'AZ1-upgrade';
      await migrateToAzureTarget(run, 'prior-main');
      await history('azure-target');
      stage = 'AZ1-preservation';
      await verifyAzurePreservation(priorMain, privilegedLocalSql, true);
      console.log('PASS: populated prior-main9/azure-target10 historical preservation; Google proof retained for next upgrade');
      stage = 'I10b-ten-capture';
      const ten = await captureImageChangePreservation(priorMain, privilegedLocalSql);
      await assertMigrationInventory(); await history('azure-target');
      const container = await sameDatabaseIdentity();
      stage = 'I10b-ten-to-eleven';
      requireEvidence((await cli(['migration', 'up', '--local'])).code === 0);
      requireEvidence(await sameDatabaseIdentity() === container);
      await history('target');
      await installCiStorageGuard(); await verifyCiStorageGuard();
      stage = 'I10b-preservation';
      await verifyImageChangePreservation(ten, privilegedLocalSql, (label) => { stage = `I10b-preservation-${label}`; });
      stage = 'I10b-publication-races';
      const { imageDeletionCases, imageChangePagedDeletion, imageChangeOrphanDeletion } = await import('../tests/integration/image-replacement.sessions.mjs');
      await imageDeletionCases(azureEnv, { withLifecycleLateUpload, requireLifecyclePrefixEmpty, withLifecycleParentLock,
        mark: (label) => { stage = `I10b-publication-races-${label}`; } });
      stage = 'I10b-owner-paging-orphans';
      await imageChangePagedDeletion(azureEnv); await imageChangeOrphanDeletion(azureEnv);
      finalizer.assertRunning();
    } finally { await finalizer.stop(); }
    console.log('PASS: exact prior-main9/target10; old Google held/estimated/confirmed/dispatched and frozen Save preserved; late settlement and ordinary-owner finalizer; no provider calls');
    console.log('PASS: populated10/target11; exact Google/Azure private proof, public fields/history and bytes preserved; frozen pending Azure Save completed after opt-out/expiry; projection DDL rolled back');
  } catch (error) {
    console.error(`FAIL: preservation ${stage}; EVIDENCE_REQUIRED${historyFailureDetail(error)}${lifecycleFailureDetail(error)}; subsequent stages NOT RUN`);
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
