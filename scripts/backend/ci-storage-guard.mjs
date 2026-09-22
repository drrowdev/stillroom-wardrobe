import {
  DB_CONTAINER, PROJECT_ID, assertNoServiceSecrets, assertProjectConfig,
  requireDocker, requireLocalContainer, commandEnvironment, runCommand, privilegedLocalSql, fail,
} from './local.mjs';

export const PUBLICATION_BODY_MD5 = 'a1e6faa7a53dd540403d8b6e831820b4';
export const IMAGE_CHANGE_PUBLICATION_BODY_MD5 = '0ac09ee7da8d61a379fc623132f63769';

const HISTORY = ['20260905000000', '20260906000000', '20260909070000', '20260909110000', '20260909180000',
  '20260910070000', '20260911040000', '20260911200000', '20260913120000', '20260921193000', '20260922020000'];
const HISTORY_SQL = 'select coalesce(json_agg(version order by version),\'[]\'::json) from supabase_migrations.schema_migrations;';
async function historyMode() {
  const output = await privilegedLocalSql(HISTORY_SQL);
  if (typeof output !== 'string' || Buffer.byteLength(output) > 1024) fail(VERIFY_FAILED, 1);
  const versions = JSON.parse(output);
  if (!Array.isArray(versions) || ![9, 10, 11].includes(versions.length)
    || JSON.stringify(versions) !== JSON.stringify(HISTORY.slice(0, versions.length))) fail(VERIFY_FAILED, 1);
  return versions.length === 11 ? 'image-change' : 'legacy';
}

const NOT_RUN = 'NOT RUN: Storage guard installation requires the explicitly approved disposable CI database job.';
const INSTALL_FAILED = 'FAIL: CI Storage guard finalization was not verified; readiness is blocked.';
const VERIFY_FAILED = 'FAIL: Storage guard ALWAYS installation was not verified; readiness is blocked.';
const DEADLINES = `
set local search_path = pg_catalog;
set local statement_timeout = '10s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '10s';`;

// Catalog joins require no USAGE on private. No application row or function body is returned to Node.
const readCatalog = (mode) => `
select pg_catalog.jsonb_build_object(
  'database',pg_catalog.current_database(),'actor',current_user,'session',session_user,
  'replication',pg_catalog.current_setting('session_replication_role'),
  'relation',pg_catalog.jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,
    'replicaIdentity',c.relreplident,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
    'kind',c.relkind,'persistence',c.relpersistence),
  'function',pg_catalog.to_jsonb(p),'trigger',pg_catalog.to_jsonb(t),
  'valid',coalesce(
    ro.rolname='supabase_storage_admin' and c.relkind='r' and c.relpersistence='p'
    and (select count(*)=1 from pg_catalog.pg_trigger x where x.tgname='item_object_publication_guard')
    and t.tgtype=${mode === 'legacy' ? 21 : 29} and not t.tgisinternal and not t.tgdeferrable and not t.tginitdeferred
    and t.tgparentid=0 and t.tgconstraint=0 and t.tgconstrrelid=0 and t.tgconstrindid=0
    and t.tgnargs=0 and pg_catalog.octet_length(t.tgargs)=0 and t.tgattr=''::pg_catalog.int2vector
    and t.tgqual is null and t.tgoldtable is null and t.tgnewtable is null
    and pn.nspname='private' and p.proname='guard_item_object_publication'
    and po.rolname='postgres' and l.lanname='plpgsql'
    and p.prokind='f' and p.pronargs=0 and p.pronargdefaults=0 and p.provariadic=0
    and p.proargtypes=''::pg_catalog.oidvector and p.proallargtypes is null
    and p.proargmodes is null and p.proargnames is null and p.proargdefaults is null
    and p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
    and p.prosecdef and not p.proisstrict and not p.proretset and not p.proleakproof
    and p.provolatile='v' and p.proparallel='u'
    and p.proconfig=array['search_path=""','lock_timeout=2s']::text[]
    and pg_catalog.md5(p.prosrc)='${mode === 'legacy' ? PUBLICATION_BODY_MD5 : IMAGE_CHANGE_PUBLICATION_BODY_MD5}'
    ${mode === 'legacy' ? '' : `and (select pg_catalog.md5(x.prosrc)='507ef6c28f1732df5d6141f730258062'
      from pg_catalog.pg_proc x join pg_catalog.pg_namespace xn on xn.oid=x.pronamespace
      where xn.nspname='private' and x.proname='may_delete_storage' and x.proargtypes='25'::pg_catalog.oidvector)
    and (select pg_catalog.array_agg(policyname::text order by policyname::text)=array['wardrobe_create','wardrobe_delete','wardrobe_read']
      from pg_catalog.pg_policies where schemaname='storage' and tablename='objects')
    and (select pg_catalog.count(*)=2 and pg_catalog.bool_and(roles=array['authenticated']::name[] and with_check is null
      and cmd=case policyname when 'wardrobe_read' then 'SELECT' else 'DELETE' end
      and qual=case policyname when 'wardrobe_read'
        then '((bucket_id = ''wardrobe''::text) AND (private.owns_storage_path(name, false) OR (private.may_delete_storage(name) AND storage.allow_only_operation(''storage.object.delete''::text))))'
        else '((bucket_id = ''wardrobe''::text) AND private.may_delete_storage(name) AND storage.allow_only_operation(''storage.object.delete''::text))' end)
      from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and policyname in ('wardrobe_read','wardrobe_delete'))`}
    and (select count(*)=1 and bool_and(a.grantor=p.proowner and a.grantee=p.proowner
        and a.privilege_type='EXECUTE' and not a.is_grantable)
      from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
  ,false)
) into observed
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
join pg_catalog.pg_roles ro on ro.oid=c.relowner
join pg_catalog.pg_trigger t on t.tgrelid=c.oid and t.tgname='item_object_publication_guard'
join pg_catalog.pg_proc p on p.oid=t.tgfoid
join pg_catalog.pg_namespace pn on pn.oid=p.pronamespace
join pg_catalog.pg_roles po on po.oid=p.proowner
join pg_catalog.pg_language l on l.oid=p.prolang
where n.nspname='storage' and c.relname='objects';`;

const installSql = (mode) => `
begin;
${DEADLINES}
lock table storage.objects in share row exclusive mode;
do $guard$
declare observed jsonb; before_state jsonb;
begin
  ${readCatalog(mode)}
  if observed->>'valid' is distinct from 'true'
    or observed->>'database' is distinct from 'postgres'
    or observed->>'actor' is distinct from 'supabase_storage_admin'
    or observed->>'session' is distinct from 'supabase_storage_admin'
    or coalesce(observed#>>'{trigger,tgenabled}','') not in ('O','A') then
    raise exception 'CI_STORAGE_GUARD_INVALID';
  end if;
  before_state := observed #- '{trigger,tgenabled}';
  if observed#>>'{trigger,tgenabled}'='O' then
    alter table storage.objects enable always trigger item_object_publication_guard;
  end if;
  ${readCatalog(mode)}
  if observed->>'valid' is distinct from 'true'
    or observed#>>'{trigger,tgenabled}' is distinct from 'A'
    or (observed #- '{trigger,tgenabled}') is distinct from before_state then
    raise exception 'CI_STORAGE_GUARD_INVALID';
  end if;
end;
$guard$;
commit;
select 'CI_STORAGE_GUARD_OK';`;

const verifySql = (mode) => `
begin read only;
${DEADLINES}
do $guard$
declare observed jsonb;
begin
  ${readCatalog(mode)}
  if observed->>'valid' is distinct from 'true'
    or observed->>'database' is distinct from 'postgres'
    or observed->>'actor' is distinct from 'postgres'
    or observed->>'session' is distinct from 'postgres'
    or observed#>>'{trigger,tgenabled}' is distinct from 'A' then
    raise exception 'CI_STORAGE_GUARD_INVALID';
  end if;
end;
$guard$;
commit;
select 'CI_STORAGE_GUARD_VERIFIED';`;

export function assertCiStorageGuardInstall() {
  if (arguments.length !== 0 || process.env.ALLOW_CI_STORAGE_GUARD_INSTALL !== '1'
    || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== 'drrowdev/stillroom-wardrobe'
    || process.env.GITHUB_JOB !== 'database') fail(NOT_RUN);
  assertNoServiceSecrets(process.env);
}

async function requireTarget() {
  assertNoServiceSecrets(process.env);
  await assertProjectConfig();
  await requireDocker();
  await requireLocalContainer();
  const template = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"image":{{json .Config.Image}},"running":{{json .State.Running}}}';
  const result = await runCommand('docker', ['container', 'inspect', '--format', template, DB_CONTAINER], {
    env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096,
  });
  if (result.code !== 0 || result.stderr !== '' || typeof result.stdout !== 'string'
    || Buffer.byteLength(result.stdout) > 4096) fail(VERIFY_FAILED, 1);
  const value = JSON.parse(result.stdout);
  // CLI 997a1e69's fixed default ECR/GHCR/Hub candidates, never a configurable mirror or tag.
  const images = ['public.ecr.aws/supabase/postgres:17.6.1.165',
    'ghcr.io/supabase/postgres:17.6.1.165', 'supabase/postgres:17.6.1.165'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'image,name,project,running'
    || value.name !== `/${DB_CONTAINER}` || value.project !== PROJECT_ID
    || value.running !== true || !images.includes(value.image)) fail(VERIFY_FAILED, 1);
}

export async function installCiStorageGuard() {
  assertCiStorageGuardInstall();
  if (arguments.length !== 0) fail(NOT_RUN);
  try {
    await requireTarget();
    const mode = await historyMode();
    const result = await runCommand('docker', [
      'exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password', '-h', '127.0.0.1',
      '-p', '5432', '-U', 'supabase_storage_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
    ], { input: installSql(mode), env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096 });
    if (result.code !== 0 || result.stderr !== '' || typeof result.stdout !== 'string'
      || Buffer.byteLength(result.stdout) > 4096 || result.stdout.trim() !== 'CI_STORAGE_GUARD_OK') {
      fail(INSTALL_FAILED, 1);
    }
  } catch {
    fail(INSTALL_FAILED, 1);
  }
}

export async function verifyCiStorageGuard() {
  if (arguments.length !== 0) fail(VERIFY_FAILED, 1);
  try {
    await requireTarget();
    const mode = await historyMode();
    if (await privilegedLocalSql(verifySql(mode)) !== 'CI_STORAGE_GUARD_VERIFIED') fail(VERIFY_FAILED, 1);
  } catch {
    fail(VERIFY_FAILED, 1);
  }
}
