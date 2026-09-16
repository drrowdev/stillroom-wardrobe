import {
  DB_CONTAINER, PROJECT_ID, assertNoServiceSecrets, assertProjectConfig,
  requireDocker, requireLocalContainer, commandEnvironment, runCommand, privilegedLocalSql, fail,
} from './local.mjs';

export const PUBLICATION_BODY_MD5 = '5e886ec32267f7992e963a4a0e952708';

const NOT_RUN = 'NOT RUN: Storage guard installation requires the explicitly approved disposable CI database job.';
const INSTALL_FAILED = 'FAIL: CI Storage guard finalization was not verified; readiness is blocked.';
const VERIFY_FAILED = 'FAIL: Storage guard ALWAYS installation was not verified; readiness is blocked.';
const DEADLINES = `
set local search_path = pg_catalog;
set local statement_timeout = '10s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '10s';`;

// Catalog joins require no USAGE on private. No application row or function body is returned to Node.
const READ_CATALOG = `
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
    and t.tgtype=21 and not t.tgisinternal and not t.tgdeferrable and not t.tginitdeferred
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
    and pg_catalog.md5(p.prosrc)='${PUBLICATION_BODY_MD5}'
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

const INSTALL_SQL = `
begin;
${DEADLINES}
lock table storage.objects in share row exclusive mode;
do $guard$
declare observed jsonb; before_state jsonb;
begin
  ${READ_CATALOG}
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
  ${READ_CATALOG}
  if observed->>'valid' is distinct from 'true'
    or observed#>>'{trigger,tgenabled}' is distinct from 'A'
    or (observed #- '{trigger,tgenabled}') is distinct from before_state then
    raise exception 'CI_STORAGE_GUARD_INVALID';
  end if;
end;
$guard$;
commit;
select 'CI_STORAGE_GUARD_OK';`;

const VERIFY_SQL = `
begin read only;
${DEADLINES}
do $guard$
declare observed jsonb;
begin
  ${READ_CATALOG}
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
    const result = await runCommand('docker', [
      'exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password', '-h', '127.0.0.1',
      '-p', '5432', '-U', 'supabase_storage_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
    ], { input: INSTALL_SQL, env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096 });
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
    if (await privilegedLocalSql(VERIFY_SQL) !== 'CI_STORAGE_GUARD_VERIFIED') fail(VERIFY_FAILED, 1);
  } catch {
    fail(VERIFY_FAILED, 1);
  }
}
