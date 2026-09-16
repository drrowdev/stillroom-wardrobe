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
  ALLOW_CI_STORAGE_GUARD_INSTALL: '1', CI: 'true', GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe', GITHUB_JOB: 'database',
};
const image = 'public.ecr.aws/supabase/postgres:17.6.1.165';
const metadata = () => ({ name: `/${DB_CONTAINER}`, project: PROJECT_ID, image, running: true });
const inspection = (): Outcome => ({ code: 0, stdout: JSON.stringify(metadata()), stderr: '' });
const receipt = (): Outcome => ({ code: 0, stdout: 'CI_STORAGE_GUARD_OK\n', stderr: '' });
const read = (name: string) => readFile(new URL('../../' + name, import.meta.url), 'utf8');
function ordered(source: string, steps: string[]) {
  let offset = 0;
  for (const step of steps) {
    const index = source.indexOf(step, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + step.length;
  }
}
async function installSql(): Promise<string> {
  await guard.installCiStorageGuard();
  const call = mocks.run.mock.calls.find(([, args]) => args[0] === 'exec');
  if (!call?.[2]?.input) throw new Error('Missing fixed installer SQL');
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
  mocks.sql.mockResolvedValue('CI_STORAGE_GUARD_VERIFIED');
  mocks.run.mockImplementation(async (_command, args) => args[0] === 'exec' ? receipt() : inspection());
});
afterEach(() => vi.unstubAllEnvs());

describe('CI Storage guard scope and transport (mocked, no backend proof)', () => {
  it('exports only three zero-argument operations and one immutable shared body pin', () => {
    expect(Object.keys(guard).sort()).toEqual([
      'PUBLICATION_BODY_MD5', 'assertCiStorageGuardInstall', 'installCiStorageGuard', 'verifyCiStorageGuard',
    ]);
    for (const name of ['assertCiStorageGuardInstall', 'installCiStorageGuard', 'verifyCiStorageGuard']) {
      expect(guard[name].length).toBe(0);
    }
    expect(() => guard.assertCiStorageGuardInstall('extra')).toThrow(/NOT RUN/);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('preflights purely, without filesystem, Docker or SQL operations', () => {
    guard.assertCiStorageGuardInstall();
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(Object.keys(scope))('refuses every nonliteral %s before process or SQL work', async (key) => {
    for (const value of [undefined, '', '0', 'false', 'TRUE', '1 ', ' true ', 'app', 'another/repository']) {
      vi.stubEnv(key, value);
      expect(() => guard.assertCiStorageGuardInstall()).toThrow(/NOT RUN/);
      await expect(guard.installCiStorageGuard()).rejects.toThrow(/NOT RUN/);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(['SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'DATABASE_URL', 'PGPASSWORD'])(
    'refuses %s before privileged transport', async (name) => {
      vi.stubEnv(name, 'PRIVATE_CANARY');
      expect(() => guard.assertCiStorageGuardInstall()).toThrow(/REFUSED/);
      await expect(guard.installCiStorageGuard()).rejects.toThrow(/REFUSED/);
      await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.sql).not.toHaveBeenCalled();
    },
  );
  it.each(['project', 'docker', 'container'] as const)('refuses a failed %s guard without SQL or fallback', async (key) => {
    mocks[key].mockRejectedValue(new Error('PRIVATE_CANARY'));
    await expect(guard.installCiStorageGuard()).rejects.toThrow(
      'FAIL: CI Storage guard finalization was not verified; readiness is blocked.',
    );
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
  ].map((value) => ({ value })))('refuses nonmatching container metadata %# before owner SQL', async ({ value }) => {
    mocks.run.mockResolvedValue({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    await expect(guard.installCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
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
    await expect(guard.installCiStorageGuard()).rejects.toThrow(
      'FAIL: CI Storage guard finalization was not verified; readiness is blocked.',
    );
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it.each([image, 'ghcr.io/supabase/postgres:17.6.1.165', 'supabase/postgres:17.6.1.165'])(
    'recognizes only the pinned CLI default image candidate %s, without pulling', async (candidate) => {
      mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ...metadata(), image: candidate }), stderr: '' })
        .mockResolvedValueOnce(receipt());
      await guard.installCiStorageGuard();
      expect(mocks.run).toHaveBeenCalledTimes(2);
    },
  );
  it('uses fixed loopback owner argv, stripped environment, stdin and independent bounds', async () => {
    const sql = await installSql();
    expect(mocks.project.mock.invocationCallOrder[0]).toBeLessThan(mocks.docker.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.docker.mock.invocationCallOrder[0]).toBeLessThan(mocks.container.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.container.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.run).toHaveBeenNthCalledWith(2, 'docker', [
      'exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password', '-h', '127.0.0.1',
      '-p', '5432', '-U', 'supabase_storage_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
    ], { input: sql, env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096 });
    expect(mocks.run.mock.calls[0]?.[2]).toEqual({
      env: commandEnvironment(), timeout: 30_000, maxOutputBytes: 4096,
    });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it.each([
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_OK\nextra', stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_OK\nCI_STORAGE_GUARD_OK', stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_OK\u0000', stderr: '' },
    { code: 0, stdout: `${' '.repeat(4096)}CI_STORAGE_GUARD_OK`, stderr: '' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_OK', stderr: ' ' },
    { code: 0, stdout: 'CI_STORAGE_GUARD_OK', stderr: 'PRIVATE_CANARY' },
    { code: 1, stdout: 'CI_STORAGE_GUARD_OK', stderr: '' },
    { code: 2, stdout: '', stderr: '' },
  ])('rejects incomplete, failed, timed-out or malformed owner receipt %# without retry', async (result) => {
    mocks.run.mockResolvedValueOnce(inspection()).mockResolvedValueOnce(result);
    await expect(guard.installCiStorageGuard()).rejects.toThrow(
      'FAIL: CI Storage guard finalization was not verified; readiness is blocked.',
    );
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it('sanitizes thrown transport errors without a retry or generic SQL fallback', async () => {
    mocks.run.mockResolvedValueOnce(inspection()).mockRejectedValueOnce(new Error('PRIVATE_CANARY'));
    await expect(guard.installCiStorageGuard()).rejects.toThrow(
      'FAIL: CI Storage guard finalization was not verified; readiness is blocked.',
    );
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it('keeps verification read-only, under postgres, without installation permission', async () => {
    for (const key of Object.keys(scope)) vi.stubEnv(key, undefined);
    await guard.verifyCiStorageGuard();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    const sql = mocks.sql.mock.calls[0]?.[0];
    expect(sql).toContain('begin read only;');
    expect(sql).toContain("observed->>'actor' is distinct from 'postgres'");
    expect(sql).toContain("observed->>'session' is distinct from 'postgres'");
    expect(sql).toContain("observed#>>'{trigger,tgenabled}' is distinct from 'A'");
    expect(sql).not.toMatch(/\b(?:alter|lock table|set role|grant|revoke|insert|delete|update)\b/i);
  });
  it.each(['', 'O', 'D', 'R', 'null', 'CI_STORAGE_GUARD_OK', 'CI_STORAGE_GUARD_VERIFIED\nextra'])(
    'does not turn an unverified catalog reply %s into readiness', async (value) => {
      mocks.sql.mockResolvedValue(value);
      await expect(guard.verifyCiStorageGuard()).rejects.toThrow(/readiness is blocked/);
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.sql).toHaveBeenCalledTimes(1);
    },
  );
  it('sanitizes verifier errors and rejects extra arguments before target work', async () => {
    await expect(guard.installCiStorageGuard('other actor')).rejects.toThrow(/NOT RUN/);
    await expect(guard.verifyCiStorageGuard('other SQL')).rejects.toThrow(/readiness is blocked/);
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.sql.mockRejectedValue(new Error('PRIVATE_CANARY'));
    await expect(guard.verifyCiStorageGuard()).rejects.toThrow(
      'FAIL: Storage guard ALWAYS installation was not verified; readiness is blocked.',
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
  it('bounds one transaction, locks before catalog reads, permits only O-to-A or unchanged A, commits before marker', async () => {
    const sql = await installSql();
    ordered(sql, ['begin;', 'set local search_path = pg_catalog;',
      "set local statement_timeout = '10s';", "set local lock_timeout = '2s';",
      "set local idle_in_transaction_session_timeout = '10s';",
      'lock table storage.objects in share row exclusive mode;', 'into observed',
      "observed->>'valid' is distinct from 'true'",
      "coalesce(observed#>>'{trigger,tgenabled}','') not in ('O','A')",
      "before_state := observed #- '{trigger,tgenabled}';",
      "if observed#>>'{trigger,tgenabled}'='O' then",
      'alter table storage.objects enable always trigger item_object_publication_guard;',
      'into observed', "observed#>>'{trigger,tgenabled}' is distinct from 'A'",
      "(observed #- '{trigger,tgenabled}') is distinct from before_state",
      'commit;', "select 'CI_STORAGE_GUARD_OK';",
    ]);
    expect(sql.match(/\balter table\b/g)).toHaveLength(1);
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/(?:set(?: local)? role|set session|session authorization|set(?: local)? session_replication_role|\bgrant\b|\brevoke\b|\bowner to\b|create(?: or replace)? function|execute\s+format|pg_get_triggerdef|private\.\w+\([^)]*\)::regprocedure)/i);
    expect(sql).not.toMatch(/\bfrom\s+(?:private|public|storage)\./i);
  });
  it('rejects absent, disabled, replica-only and null triggers rather than treating them as reinstallable', async () => {
    const sql = await installSql();
    expect(sql).toContain("coalesce(observed#>>'{trigger,tgenabled}','') not in ('O','A')");
    expect(sql.match(/raise exception 'CI_STORAGE_GUARD_INVALID'/g)).toHaveLength(2);
    expect(sql).toContain("join pg_catalog.pg_trigger t on t.tgrelid=c.oid and t.tgname='item_object_publication_guard'");
    expect(sql).toContain("observed->>'valid' is distinct from 'true'");
    expect(sql).not.toMatch(/in \([^)]*'(?:D|R)'/);
  });
  it('checks exact metadata and fails closed for wrong owners, body, config, ACL or trigger structure', async () => {
    const sql = await installSql();
    for (const fragment of [
      "observed->>'database' is distinct from 'postgres'",
      "observed->>'actor' is distinct from 'supabase_storage_admin'",
      "observed->>'session' is distinct from 'supabase_storage_admin'",
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
  it('pins the current publication body once and keeps strict ALWAYS catalog semantics', async () => {
    const current = await read('supabase/migrations/20260916100000_image_cleanup.sql');
    const body = current.match(/create or replace function private\.guard_item_object_publication\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/)?.[1];
    if (!body) throw new Error('Missing publication body');
    expect(createHash('md5').update(body).digest('hex')).toBe(guard.PUBLICATION_BODY_MD5);
    const source = await read('scripts/preservation-rehearsal.mjs');
    expect(source).toContain("('private.guard_item_object_publication()','${PUBLICATION_BODY_MD5}')");
    expect(source).not.toContain(guard.PUBLICATION_BODY_MD5);
    expect(source).toContain("tgenabled='A'");
    const migration = await read('supabase/migrations/20260913120000_item_lifecycle.sql');
    expect(migration).not.toContain('alter table storage.objects enable always trigger item_object_publication_guard;');
    expect(migration).toContain('alter table public.item_images enable always trigger item_image_identity_guard;');
  });
  it('puts start/reset finalization before readiness/provisioning and keeps types verification-only', async () => {
    const source = await read('scripts/db.mjs');
    const start = source.slice(source.indexOf("if (action === 'start')"), source.indexOf("if (action === 'reset')"));
    const reset = source.slice(source.indexOf("if (action === 'reset')"), source.indexOf('const generationStarted'));
    ordered(source, ["if (action !== 'types') assertCiStorageGuardInstall();", 'await assertProjectConfig();', 'await requireDocker();', "await cli(['start'"]);
    ordered(start, ["await cli(['start'", 'if (started.code !== 0) fail(', 'await installCiStorageGuard();',
      'await verifyCiStorageGuard();', 'await localStatus();', 'await fetch(', "console.log('PASS:"]);
    ordered(reset, ["await cli(['db', 'reset'", 'if (reset.code !== 0) fail(', 'await installCiStorageGuard();',
      'await verifyCiStorageGuard();', "'provision-test-users.mjs'", "'provision-ai-control-fixtures.mjs'", "console.log('PASS:"]);
    expect(source.match(/await installCiStorageGuard\(\);/g)).toHaveLength(2);
    expect(source).toContain("  await verifyCiStorageGuard();\n  const generationStarted");
    expect(source.slice(source.indexOf('const generationStarted'))).not.toContain('installCiStorageGuard');
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
      expect(refused.stderr).toBe('NOT RUN: Storage guard installation requires the explicitly approved disposable CI database job.\n');
    }
  });
});
