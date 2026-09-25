import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as guard from '../../scripts/backend/ci-storage-guard.mjs';
import { DB_CONTAINER, PROJECT_ID, commandEnvironment, normalSessionEnvironment, TEST_EMAILS } from '../../scripts/backend/local.mjs';

type Outcome = { code: number; stdout: string; stderr: string };
type Options = { input?: string; env?: Record<string, string>; timeout?: number; maxOutputBytes?: number };
const mocks = vi.hoisted(() => ({
  project: vi.fn<() => Promise<void>>(), docker: vi.fn<() => Promise<void>>(),
  container: vi.fn<() => Promise<void>>(), sql: vi.fn<(sql: string) => Promise<string>>(),
  run: vi.fn<(command: string, args: string[], options?: Options) => Promise<Outcome>>(),
}));
vi.mock('../../scripts/backend/local.mjs', async () => ({
  ...await vi.importActual<Record<string, unknown>>('../../scripts/backend/local.mjs'),
  assertProjectConfig: mocks.project, requireDocker: mocks.docker,
  requireLocalContainer: mocks.container, privilegedLocalSql: mocks.sql, runCommand: mocks.run,
}));

const scope = {
  ALLOW_CI_DATABASE_MUTATION: '1', CI: 'true', GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe', GITHUB_JOB: 'database',
};
const image = 'public.ecr.aws/supabase/postgres:17.6.1.165';
const metadata = () => ({ name: `/${DB_CONTAINER}`, project: PROJECT_ID, image, running: true });
const inspection = (): Outcome => ({ code: 0, stdout: JSON.stringify(metadata()), stderr: '' });
const receipt = (): Outcome => ({ code: 0, stdout: 'CI_STORAGE_GUARD_VERIFIED\n', stderr: '' });
const versions = ['20260905000000', '20260906000000', '20260909070000', '20260909110000', '20260909180000',
  '20260910070000', '20260911040000', '20260911200000', '20260913120000', '20260921193000', '20260922020000',
  '20260924100000', '20260924100100', '20260925090000', '20260925100000'];
const read = (name: string) => readFile(new URL('../../' + name, import.meta.url), 'utf8');
function ordered(source: string, steps: string[]) {
  let offset = 0;
  for (const step of steps) {
    const index = source.indexOf(step, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + step.length;
  }
}
async function verificationSql(): Promise<string> {
  await guard.verifyCiStorageGuard();
  const call = mocks.run.mock.calls.find(([, , options]) => options?.input?.includes('do $guard$'));
  if (!call?.[2]?.input) throw new Error('Missing fixed verification SQL');
  return call[2].input;
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(scope)) vi.stubEnv(key, value);
  for (const key of Object.keys(process.env)) {
    if (/(?:SERVICE[_-]?ROLE|SECRET[_-]?KEY|SUPABASE.*(?:SERVICE|SECRET|TOKEN)|DATABASE_URL|DB_PASSWORD|PGPASSWORD)/i.test(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  mocks.project.mockResolvedValue(undefined);
  mocks.docker.mockResolvedValue(undefined);
  mocks.container.mockResolvedValue(undefined);
  mocks.sql.mockRejectedValue(new Error('Generic SQL transport is forbidden'));
  mocks.run.mockImplementation(async (_command, args, options) => args[0] !== 'exec' ? inspection()
    : options?.input?.includes('supabase_migrations.schema_migrations')
      ? { code: 0, stdout: JSON.stringify(versions.slice(0, 10)), stderr: '' } : receipt());
});
afterEach(() => vi.unstubAllEnvs());

describe('CI Storage guard scope and transport (mocked, no backend proof)', () => {
  it('exports only a zero-argument mutation preflight and read-only verifier plus exact body pins', () => {
    expect(Object.keys(guard).sort()).toEqual([
      'IMAGE_CHANGE_PUBLICATION_BODY_MD5', 'PUBLICATION_BODY_MD5', 'assertCiDatabaseMutationAllowed', 'verifyCiStorageGuard',
    ]);
    for (const name of ['assertCiDatabaseMutationAllowed', 'verifyCiStorageGuard']) {
      expect(guard[name].length).toBe(0);
    }
    expect(() => guard.assertCiDatabaseMutationAllowed('extra')).toThrow(/NOT RUN/);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('preflights purely, without filesystem, Docker or SQL operations', () => {
    guard.assertCiDatabaseMutationAllowed();
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it('does not admit mutation with the removed installer flag alone', () => {
    vi.stubEnv('ALLOW_CI_DATABASE_MUTATION', undefined);
    vi.stubEnv('ALLOW_CI_STORAGE_GUARD_INSTALL', '1');
    expect(() => guard.assertCiDatabaseMutationAllowed()).toThrow(/NOT RUN/);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(Object.keys(scope))('refuses every nonliteral %s before process or SQL work', async (key) => {
    for (const value of [undefined, '', '0', 'false', 'TRUE', '1 ', ' true ', 'app', 'another/repository']) {
      vi.stubEnv(key, value);
      expect(() => guard.assertCiDatabaseMutationAllowed()).toThrow(/NOT RUN/);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(['SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'DATABASE_URL', 'PGPASSWORD'])(
    'refuses %s before privileged transport', async (name) => {
      vi.stubEnv(name, 'PRIVATE_CANARY');
      expect(() => guard.assertCiDatabaseMutationAllowed()).toThrow(/REFUSED/);
      await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.sql).not.toHaveBeenCalled();
    },
  );
  it.each(['project', 'docker', 'container'] as const)('refuses a failed %s guard without SQL or fallback', async (key) => {
    mocks[key].mockRejectedValue(new Error('PRIVATE_CANARY'));
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it.each([
    null, [], {}, { ...metadata(), name: '/other' }, { ...metadata(), project: 'other' },
    { ...metadata(), running: false }, { ...metadata(), running: 'true' },
    { ...metadata(), image: 'supabase/postgres:17.6.1.164' },
    { ...metadata(), image: 'supabase/postgres:latest' },
    { ...metadata(), image: 'other.test/supabase/postgres:17.6.1.165' },
    { ...metadata(), image: `${image}@sha256:${'a'.repeat(64)}` },
    { ...metadata(), image: `${image}\n` }, { ...metadata(), extra: 'PRIVATE_CANARY' },
  ].map((value) => ({ value })))('refuses nonmatching container metadata %# before postgres SQL', async ({ value }) => {
    mocks.run.mockResolvedValue({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it.each([
    { code: 1, stdout: JSON.stringify(metadata()), stderr: '' },
    { code: 0, stdout: '{PRIVATE_CANARY', stderr: '' },
    { code: 0, stdout: ' '.repeat(4097), stderr: '' },
    { code: 0, stdout: JSON.stringify(metadata()), stderr: 'PRIVATE_CANARY' },
  ])('rejects malformed, failed or oversized inspection %# without echoing output', async (result) => {
    mocks.run.mockResolvedValue(result);
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it.each([image, 'ghcr.io/supabase/postgres:17.6.1.165', 'supabase/postgres:17.6.1.165'])(
    'recognizes only the pinned CLI default image candidate %s, without pulling', async (candidate) => {
      mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ...metadata(), image: candidate }), stderr: '' });
      await guard.verifyCiStorageGuard();
      expect(mocks.run).toHaveBeenCalledTimes(3);
    },
  );
  it('bounds BOTH fixed read-only postgres calls with stripped environment and SQL stdin', async () => {
    const sql = await verificationSql();
    expect(mocks.project.mock.invocationCallOrder[0]).toBeLessThan(mocks.docker.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.docker.mock.invocationCallOrder[0]).toBeLessThan(mocks.container.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.container.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0] ?? 0);
    const argv = [
      'exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password', '-h', '127.0.0.1',
      '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
    ];
    expect(mocks.run).toHaveBeenNthCalledWith(3, 'docker', argv,
      { input: sql, env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096 });
    const history = mocks.run.mock.calls[1]?.[2]?.input;
    expect(mocks.run).toHaveBeenNthCalledWith(2, 'docker', argv,
      { input: history, env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 1024 });
    expect(history).toContain('begin read only;');
    expect(history).toContain('supabase_migrations.schema_migrations');
    expect(history).toContain('commit;');
    for (const query of [history, sql]) for (const deadline of [
      "set local statement_timeout = '10s';", "set local lock_timeout = '2s';",
      "set local idle_in_transaction_session_timeout = '10s';",
    ]) expect(query).toContain(deadline);
    expect(mocks.run.mock.calls[0]?.[2]).toEqual({
      env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096,
    });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it.each([
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_VERIFIED\nextra', stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_VERIFIED\nCI_STORAGE_GUARD_VERIFIED', stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_VERIFIED\u0000', stderr: '' },
    { code: 0, stdout: `${' '.repeat(4096)}CI_STORAGE_GUARD_VERIFIED`, stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_VERIFIED', stderr: ' ' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_VERIFIED', stderr: 'PRIVATE_CANARY' },
    { code: 1, stdout: 'CI_STORAGE_GUARD_VERIFIED', stderr: '' },
    { code: 2, stdout: '', stderr: '' },
  ])('rejects incomplete, failed, timed-out or malformed verifier receipt %# without retry', async (result) => {
    mocks.run.mockResolvedValueOnce(inspection())
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(versions), stderr: '' }).mockResolvedValueOnce(result);
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it('sanitizes thrown transport errors without a retry or generic SQL fallback', async () => {
    mocks.run.mockResolvedValueOnce(inspection()).mockRejectedValueOnce(new Error('PRIVATE_CANARY'));
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it('requires O plus its own postgres origin session, separately from identity A, without mutation permission', async () => {
    for (const key of Object.keys(scope)) vi.stubEnv(key, undefined);
    const sql = await verificationSql();
    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(sql).toContain('begin read only;');
    expect(sql).toContain("observed->>'actor' is distinct from 'postgres'");
    expect(sql).toContain("observed->>'session' is distinct from 'postgres'");
    expect(sql).toContain("observed#>>'{trigger,tgenabled}' is distinct from 'O'");
    expect(sql).toContain("observed->>'replication' is distinct from 'origin'");
    expect(sql).toContain("t.tgenabled='A'");
    expect(sql).toContain("where t.tgname='item_image_identity_guard'");
    expect(sql).not.toMatch(/\b(?:alter|lock table|set role|grant|revoke|insert|delete|update)\b/i);
  });
  it.each(['', 'O', 'A', 'D', 'R', 'null', 'CI_STORAGE_GUARD_OK', 'CI_STORAGE_GUARD_VERIFIED\nextra'])(
    'does not turn an unverified catalog reply %s into readiness', async (value) => {
      mocks.run.mockResolvedValueOnce(inspection())
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(versions), stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: value, stderr: '' });
      await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
      expect(mocks.run).toHaveBeenCalledTimes(3);
      expect(mocks.sql).not.toHaveBeenCalled();
    },
  );
  it('sanitizes verifier errors and rejects extra arguments before target work', async () => {
    expect(() => guard.assertCiDatabaseMutationAllowed('other actor')).toThrow(/NOT RUN/);
    await expect(guard.verifyCiStorageGuard('other SQL')).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.run.mockRejectedValue(new Error('PRIVATE_CANARY'));
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(
      'FAIL: Storage guard O/origin contract was not verified; readiness is blocked.',
    );
  });
  it('strips all scope flags through both unchanged child environment helpers', () => {
    const source = { ...scope, ALLOW_SECURITY_TESTS: '1', HOME: '/fictional', PATH: '/fictional',
      GITHUB_TOKEN: 'PRIVATE_CANARY', GITHUB_RUN_ID: 'fictional', GITHUB_WORKSPACE: '/fictional' };
    const credentials = {
      SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fictional',
      TEST_A_EMAIL: TEST_EMAILS[0], TEST_A_PASSWORD: 'A'.repeat(32),
      TEST_B_EMAIL: TEST_EMAILS[1], TEST_B_PASSWORD: 'B'.repeat(32),
    };
    for (const env of [commandEnvironment(source), normalSessionEnvironment(source, credentials)]) {
      for (const key of Object.keys(scope)) expect(env).not.toHaveProperty(key);
      for (const key of ['GITHUB_TOKEN', 'GITHUB_RUN_ID', 'GITHUB_WORKSPACE']) expect(env).not.toHaveProperty(key);
    }
  });
});

describe('fixed SQL/source contracts (not executed PostgreSQL assertions)', () => {
  it.each([9, 10, 11, 12, 13, 14, 15])('selects the single exact trigger/body pair only from history length %s', async (length) => {
    mocks.run.mockResolvedValueOnce(inspection())
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(versions.slice(0, length)), stderr: '' });
    const sql = await verificationSql();
    expect(sql).toContain(`t.tgtype=${length >= 11 ? 29 : 21}`);
    expect(sql).not.toContain(`t.tgtype=${length >= 11 ? 21 : 29}`);
    expect(sql).toContain(`pg_catalog.md5(p.prosrc)='${length >= 11 ? guard.IMAGE_CHANGE_PUBLICATION_BODY_MD5 : guard.PUBLICATION_BODY_MD5}'`);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it.each([[], versions.slice(1), [...versions, '20260923000000'], versions.slice(0, 6), versions.slice(0, 7), versions.slice(0, 8),
    [...versions.slice(0, 9), versions[10]], [...versions.slice(0, 9), versions[8]], null, {},
    [...versions.slice(0, 11), versions[12]], [...versions.slice(0, 10), versions[11]], [...versions.slice(0, 11), versions[10]],
    [...versions.slice(0, 11), versions[12], versions[11]], [...versions.slice(0, 12), versions[11]], [...versions.slice(0, 12), versions[13]], [...versions.slice(0, 13), versions[14]], [...versions.slice(0, 5), ...versions.slice(6)]])(
    'rejects unsupported history %# before catalog verification without observed-body fallback', async (value) => {
      mocks.run.mockResolvedValueOnce(inspection())
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(value), stderr: '' });
      await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
      expect(mocks.run).toHaveBeenCalledTimes(2);
      expect(mocks.sql).not.toHaveBeenCalled();
    },
  );
  it.each([
    { code: 0, stdout: '{PRIVATE_CANARY', stderr: '' },
    { code: 0, stdout: ' '.repeat(1025), stderr: '' },
    { code: 1, stdout: JSON.stringify(versions), stderr: '' },
    { code: 0, stdout: JSON.stringify(versions), stderr: ' ' },
    { code: 0, stdout: JSON.stringify(versions) + '\nextra', stderr: '' },
  ])('rejects failed, malformed, excessive or noisy history transport %#', async (result) => {
    mocks.run.mockResolvedValueOnce(inspection()).mockResolvedValueOnce(result);
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it('pins the replacement-aware body independently from the immutable legacy migration', async () => {
    const migration = await read('supabase/migrations/20260922020000_checked_image_changes.sql');
    const body = migration.match(/create or replace function private\.guard_item_object_publication\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/)?.[1];
    if (!body) throw new Error('Missing target publication body');
    expect(createHash('md5').update(body).digest('hex')).toBe(guard.IMAGE_CHANGE_PUBLICATION_BODY_MD5);
  });
  it('bounds one read-only transaction and emits only a fixed receipt after commit', async () => {
    const sql = await verificationSql();
    ordered(sql, ['begin read only;', 'set local search_path = pg_catalog;',
      "set local statement_timeout = '10s';", "set local lock_timeout = '2s';",
      "set local idle_in_transaction_session_timeout = '10s';",
      'into observed',
      "observed->>'valid' is distinct from 'true'",
      "observed->>'replication' is distinct from 'origin'",
      "observed#>>'{trigger,tgenabled}' is distinct from 'O'",
      'commit;', "select 'CI_STORAGE_GUARD_VERIFIED';",
    ]);
    expect(sql).not.toMatch(/\balter table\b|\block table\b|select observed|select.*prosrc/i);
    expect(sql.match(/\bbegin read only;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/(?:set(?: local)? role|set session|session authorization|set(?: local)? session_replication_role|\bgrant\b|\brevoke\b|\bowner to\b|create(?: or replace)? function|execute\s+format|pg_get_triggerdef|private\.\w+\([^)]*\)::regprocedure)/i);
    expect(sql).not.toMatch(/\bfrom\s+(?:private|public|storage)\./i);
  });
  it('rejects absent, ALWAYS, disabled, replica-only and null publication modes without repair', async () => {
    const sql = await verificationSql();
    expect(sql).toContain("observed#>>'{trigger,tgenabled}' is distinct from 'O'");
    expect(sql.match(/raise exception 'CI_STORAGE_GUARD_INVALID'/g)).toHaveLength(1);
    expect(sql).toContain("join pg_catalog.pg_trigger t on t.tgrelid=c.oid and t.tgname='item_object_publication_guard'");
    expect(sql).toContain("observed->>'valid' is distinct from 'true'");
    expect(sql).not.toMatch(/in \([^)]*'(?:A|D|R)'/);
  });
  it('checks exact metadata and fails closed for wrong owners, body, config, ACL or trigger structure', async () => {
    const sql = await verificationSql();
    for (const fragment of [
      "observed->>'database' is distinct from 'postgres'",
      "observed->>'actor' is distinct from 'postgres'",
      "observed->>'session' is distinct from 'postgres'",
      "ro.rolname='supabase_storage_admin'", "c.relkind='r'", "c.relpersistence='p'",
      "select count(*)=1 from pg_catalog.pg_trigger x where x.tgname='item_object_publication_guard'",
      't.tgtype=21', 'not t.tgisinternal', 'not t.tgdeferrable', 'not t.tginitdeferred',
      't.tgparentid=0', 't.tgconstraint=0', 't.tgconstrrelid=0', 't.tgconstrindid=0',
      't.tgnargs=0', 'pg_catalog.octet_length(t.tgargs)=0', "t.tgattr=''::pg_catalog.int2vector",
      't.tgqual is null', 't.tgoldtable is null', 't.tgnewtable is null',
      "pn.nspname='private'", "p.proname='guard_item_object_publication'",
      "po.rolname='postgres'", "l.lanname='plpgsql'", "p.prokind='f'", 'p.pronargs=0',
      'p.pronargdefaults=0', 'p.provariadic=0', "p.proargtypes=''::pg_catalog.oidvector",
      'p.proallargtypes is null', 'p.proargmodes is null', 'p.proargnames is null', 'p.proargdefaults is null',
      "p.prorettype='pg_catalog.trigger'::pg_catalog.regtype", 'p.prosecdef', 'not p.proisstrict', 'not p.proretset',
      'not p.proleakproof', "p.provolatile='v'", "p.proparallel='u'",
      `p.proconfig=array['search_path=""','lock_timeout=2s']::text[]`,
      `pg_catalog.md5(p.prosrc)='${guard.PUBLICATION_BODY_MD5}'`,
      'count(*)=1 and bool_and(a.grantor=p.proowner and a.grantee=p.proowner',
      "a.privilege_type='EXECUTE' and not a.is_grantable", ',false)',
      "'owner',c.relowner,'acl',c.relacl", "'replicaIdentity',c.relreplident",
      "'function',pg_catalog.to_jsonb(p),'trigger',pg_catalog.to_jsonb(t)",
      "'replication',pg_catalog.current_setting('session_replication_role')",
    ]) expect(sql).toContain(fragment);
  });
  it('pins unchanged publication bodies and separates publication O from identity A', async () => {
    const migration = await read('supabase/migrations/20260913120000_item_lifecycle.sql');
    const body = migration.match(/create function private\.guard_item_object_publication\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/)?.[1];
    if (!body) throw new Error('Missing publication body');
    expect(createHash('md5').update(body).digest('hex')).toBe(guard.PUBLICATION_BODY_MD5);
    const source = await read('scripts/preservation-rehearsal.mjs');
    expect(source).toContain("('private.guard_item_object_publication()','${PUBLICATION_BODY_MD5}')");
    expect(source).not.toContain(guard.PUBLICATION_BODY_MD5);
    expect(source).toContain("'publicationTrigger',(select count(*)=1 and bool_and(t.tgenabled='O'");
    expect(source).toContain("'identityTrigger',(select count(*)=1 and bool_and(t.tgenabled='A'");
    expect(source).toContain("t.tgtype=10 and t.tgenabled in('O','A')");
    expect(migration).not.toContain('alter table storage.objects enable always trigger item_object_publication_guard;');
    expect(migration).toContain('alter table public.item_images enable always trigger item_image_identity_guard;');
  });
  it('puts start/reset verification before readiness/provisioning and retains mutation preflight', async () => {
    const source = await read('scripts/db.mjs');
    const start = source.slice(source.indexOf("if (action === 'start')"), source.indexOf("if (action === 'reset')"));
    const reset = source.slice(source.indexOf("if (action === 'reset')"), source.indexOf('const generationStarted'));
    ordered(source, ["if (action !== 'types') assertCiDatabaseMutationAllowed();", 'await assertProjectConfig();', 'await requireDocker();', "await cli(['start'"]);
    ordered(start, ["await cli(['start'", 'if (started.code !== 0) fail(',
      'await verifyCiStorageGuard();', 'await localStatus();', 'await fetch(', "console.log('PASS:"]);
    ordered(reset, ["await cli(['db', 'reset'", 'if (reset.code !== 0) fail(',
      'await verifyCiStorageGuard();', "'provision-test-users.mjs'", "'provision-ai-control-fixtures.mjs'", "console.log('PASS:"]);
    expect(source).not.toContain('installCiStorageGuard');
    expect(source).toContain("  await verifyCiStorageGuard();\n  const generationStarted");
    const verifier = await read('scripts/backend/ci-storage-guard.mjs');
    expect(verifier).not.toMatch(/installCiStorageGuard|privilegedLocalSql|enable always|set role|set session_replication_role/i);
    expect(verifier).not.toContain("'-U', 'supabase_storage_admin'");
  });
  it('imports without I/O and rejects unapproved start/reset before reaching any CLI or project mutation', () => {
    const moduleUrl = new URL('../../scripts/backend/ci-storage-guard.mjs', import.meta.url).href;
    const dbUrl = new URL('../../scripts/db.mjs', import.meta.url).href;
    const refusal = `
      import child from 'node:child_process';
      import fsp from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const refuse = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };
      for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']) child[key] = refuse;
      for (const key of ['open', 'readFile', 'writeFile', 'mkdir', 'rename', 'rm']) fsp[key] = refuse;
      globalThis.fetch = refuse;
      syncBuiltinESMExports();
    `;
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `${refusal} await import(${JSON.stringify(moduleUrl)}); console.log('IMPORT_SAFE');`],
    { cwd: tmpdir(), env: commandEnvironment(), encoding: 'utf8', timeout: 15_000 });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('IMPORT_SAFE\n');
    expect(imported.stderr).toBe('');
    for (const action of ['start', 'reset', 'preservation']) {
      const url = action === 'preservation'
        ? new URL('../../scripts/preservation-rehearsal.mjs', import.meta.url).href : dbUrl;
      const argv = JSON.stringify([process.execPath, fileURLToPath(url), ...(action === 'preservation' ? [] : [action])]);
      const refused = spawnSync(process.execPath, ['--input-type=module', '-e',
        `${refusal} process.argv = ${argv}; await import(${JSON.stringify(url)});`],
      { cwd: tmpdir(), env: commandEnvironment(), encoding: 'utf8', timeout: 15_000 });
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toBe('NOT RUN: database mutation requires the explicitly approved disposable CI database job.\n');
    }
  });
});
