import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import * as catalog from '../../scripts/isolation-catalog.mjs';

type Grant = { table: string[]; columns: Record<string, string[]> };
type Fn = { schema: string; name: string; args: string; kind: string; definer: boolean; extension: boolean;
  public: boolean; anon: boolean; authenticated: boolean; md5: string | null };
type Relation = { schema: string; name: string; kind: string; rls: boolean; columns: string[]; grants: Record<string, Grant> };
type PolicyDef = { name: string; cmd: string; qual: string | null; check: string | null };
type Policy = PolicyDef & { schema: string; table: string; roles: string[]; permissive: string };
type Expected = { kind: string; public?: boolean; anon?: boolean; authenticated?: boolean };
type Snapshot = {
  functions: Fn[]; relations: Relation[]; policies: Policy[];
  schemas: Record<string, Record<string, { USAGE: boolean; CREATE: boolean }>>;
  buckets: { id: string; public: boolean }[]; storage: { objectsRls: boolean }; publications: string[];
  foreignKeys: { table: string; name: string; def: string }[];
};
type Result = { ok: boolean; status: number; data: unknown };
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const helperMd5 = { is_approved: 'h1', owns_storage_path: 'h2', may_delete_storage: 'h3', may_create_item_object: 'h4' };
const none = (): Grant => ({ table: [], columns: {} });

function validSnapshot(): Snapshot {
  const functions: Fn[] = [];
  for (const [signature, want] of catalog.expectedFunctions() as Map<string, Expected>) {
    const schema = signature.slice(0, signature.indexOf('.'));
    const name = signature.slice(schema.length + 1, signature.indexOf('('));
    const args = signature.slice(signature.indexOf('(') + 1, -1);
    functions.push({ schema, name, args, kind: 'f', definer: true, extension: false,
      public: want.public ?? false, anon: want.anon ?? true, authenticated: want.authenticated ?? true,
      md5: want.kind === 'helper' ? (helperMd5 as Record<string, string>)[name] ?? null : null });
  }
  const relations: Relation[] = [];
  for (const [name, grant] of Object.entries(catalog.PUBLIC_TABLES as Record<string, Grant>)) {
    relations.push({ schema: 'public', name, kind: 'r', rls: true, columns: ['id', 'owner_id'],
      grants: { public: none(), anon: none(), authenticated: { table: [...grant.table], columns: structuredClone(grant.columns) } } });
  }
  for (const name of catalog.PRIVATE_TABLES as string[]) {
    relations.push({ schema: 'private', name, kind: 'r', rls: true, columns: ['owner_id'],
      grants: { public: none(), anon: none(), authenticated: none() } });
  }
  const policy = (schema: string, table: string, p: PolicyDef): Policy => ({ schema, table, name: p.name, cmd: p.cmd,
    roles: ['authenticated'], permissive: 'PERMISSIVE', qual: p.qual, check: p.check });
  const policies = [
    ...Object.keys(catalog.PUBLIC_TABLES).flatMap((table) => (catalog.OWNER_POLICIES as PolicyDef[]).map((p) => policy('public', table, p))),
    ...(catalog.STORAGE_POLICIES as PolicyDef[]).map((p) => policy('storage', 'objects', p)),
  ];
  const schemaGrant = (usage: boolean) => ({ public: { USAGE: true, CREATE: false }, private: { USAGE: usage, CREATE: false } });
  return {
    functions, relations, policies,
    schemas: { public: schemaGrant(false), anon: schemaGrant(false), authenticated: schemaGrant(true) },
    buckets: [{ id: 'wardrobe', public: false }], storage: { objectsRls: true }, publications: [],
    foreignKeys: [
      { table: 'public.items', name: 'items_owner_id_fkey', def: 'FOREIGN KEY (owner_id) REFERENCES private.approved_accounts(user_id)' },
      { table: 'public.item_images', name: 'item_images_item_fkey', def: 'FOREIGN KEY (owner_id, item_id) REFERENCES public.items(owner_id, id) ON DELETE CASCADE' },
    ],
  };
}
function fn(snapshot: Snapshot, signature: string): Fn {
  const found = snapshot.functions.find((f) => `${f.schema}.${f.name}(${f.args})` === signature);
  if (!found) throw new Error(`fixture lacks ${signature}`);
  return found;
}
function table(snapshot: Snapshot, name: string): Relation {
  const found = snapshot.relations.find((r) => `${r.schema}.${r.name}` === name);
  if (!found) throw new Error(`fixture lacks ${name}`);
  return found;
}
function grant(relation: Relation, role: string): Grant {
  const found = relation.grants[role];
  if (!found) throw new Error(`fixture lacks ${role} grants`);
  return found;
}
function policyOf(snapshot: Snapshot, tableName: string, name: string): Policy {
  const found = snapshot.policies.find((p) => p.table === tableName && p.name === name);
  if (!found) throw new Error(`fixture lacks ${tableName}.${name}`);
  return found;
}

describe('I17 isolation catalogue validator', () => {
  it('accepts the reviewed inventory and separates its families', () => {
    expect(catalog.validateCatalog(validSnapshot(), helperMd5)).toEqual([]);
    expect(catalog.EXPOSED_RPCS).toHaveLength(39);
    expect(catalog.SERVICE_ONLY_RPCS).toHaveLength(9);
    expect(catalog.PRIVATE_TABLES).toHaveLength(21);
    expect(Object.keys(catalog.PUBLIC_TABLES)).toHaveLength(10);
    const kinds = [...(catalog.expectedFunctions() as Map<string, Expected>).values()].map((v) => v.kind);
    expect(kinds.filter((k) => k === 'helper')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'provider')).toHaveLength(1);
  });

  it.each([
    ['an unexpected function', (s: Snapshot) => s.functions.push({ ...fn(s, 'public.ai_status()'), name: 'share_item' }), 'unexpected function public.share_item'],
    ['a missing exposed RPC', (s: Snapshot) => { s.functions = s.functions.filter((f) => f.name !== 'commit_image'); }, 'missing function public.commit_image(uuid)'],
    ['anonymous EXECUTE', (s: Snapshot) => { fn(s, 'public.export_manifest(uuid)').anon = true; }, 'EXECUTE for anon'],
    ['PUBLIC EXECUTE inherited by everyone', (s: Snapshot) => { fn(s, 'public.ai_status()').public = true; }, 'EXECUTE for public'],
    ['a normal-session grant on a service-only function', (s: Snapshot) => { fn(s, 'public.ai_purge_expired(integer)').authenticated = true; }, 'EXECUTE for authenticated'],
    ['EXECUTE on a private internal function', (s: Snapshot) => { fn(s, 'private.item_save_owner()').authenticated = true; }, 'private.item_save_owner()'],
    ['a changed policy helper body', (s: Snapshot) => { fn(s, 'private.may_delete_storage(text)').md5 = 'other'; }, 'body differs'],
    ['an extension-owned function', (s: Snapshot) => { fn(s, 'public.ai_status()').extension = true; }, 'extension-owned'],
    ['an unexpected view', (s: Snapshot) => s.relations.push({ schema: 'public', name: 'wardrobe_view', kind: 'v', rls: false, columns: [], grants: {} }), 'unexpected relation public.wardrobe_view'],
    ['a missing private table', (s: Snapshot) => { s.relations = s.relations.filter((r) => r.name !== 'ai_usage'); }, 'missing table private.ai_usage'],
    ['disabled RLS', (s: Snapshot) => { table(s, 'public.items').rls = false; }, 'public.items has RLS disabled'],
    ['an anonymous table privilege', (s: Snapshot) => { table(s, 'public.outfits').grants.anon = { table: ['SELECT'], columns: {} }; }, 'public.outfits anon table privileges'],
    ['a leaked column grant', (s: Snapshot) => { grant(table(s, 'public.item_images'), 'authenticated').columns.UPDATE = ['alt_text']; }, 'public.item_images authenticated column privileges'],
    ['a private table grant', (s: Snapshot) => { table(s, 'private.ai_requests').grants.authenticated = { table: ['SELECT'], columns: {} }; }, 'private.ai_requests authenticated table privileges'],
    ['a relationship-like column', (s: Snapshot) => { table(s, 'public.items').columns.push('recipient_id'); }, 'relationship-like column public.items.recipient_id'],
    ['a widened owner policy', (s: Snapshot) => { policyOf(s, 'items', 'owner_read').qual = 'true'; }, 'public.items.owner_read USING'],
    ['an extra public-table policy', (s: Snapshot) => s.policies.push({ ...policyOf(s, 'profiles', 'owner_read'), name: 'shared_read' }), 'public.profiles policies'],
    ['a missing Storage INSERT policy', (s: Snapshot) => { s.policies = s.policies.filter((p) => p.name !== 'wardrobe_create'); }, 'storage.objects policies'],
    ['a policy on a private table', (s: Snapshot) => s.policies.push({ ...policyOf(s, 'profiles', 'owner_read'), schema: 'private', table: 'ai_usage' }), 'unexpected policies on private.ai_usage'],
    ['a public bucket', (s: Snapshot) => { s.buckets = [{ id: 'wardrobe', public: true }]; }, 'buckets'],
    ['Storage RLS off', (s: Snapshot) => { s.storage.objectsRls = false; }, 'storage.objects RLS disabled'],
    ['a realtime publication', (s: Snapshot) => s.publications.push('public.items'), 'published tables'],
    ['private schema USAGE for anon', (s: Snapshot) => { s.schemas.anon = { public: { USAGE: true, CREATE: false }, private: { USAGE: true, CREATE: false } }; }, 'private USAGE for anon'],
    ['CREATE on public', (s: Snapshot) => { s.schemas.authenticated = { public: { USAGE: true, CREATE: true }, private: { USAGE: true, CREATE: false } }; }, 'public CREATE for authenticated'],
    ['a cross-owner foreign key', (s: Snapshot) => s.foreignKeys.push({ table: 'public.outfit_items', name: 'x', def: 'FOREIGN KEY (item_id) REFERENCES public.items(id)' }), 'not owner-scoped'],
  ])('rejects %s', (_label, mutate, message) => {
    const snapshot = validSnapshot();
    mutate(snapshot);
    const problems = catalog.validateCatalog(snapshot, helperMd5) as string[];
    expect(problems.some((problem) => problem.includes(message))).toBe(true);
  });

  it('rejects malformed snapshots', () => {
    expect(catalog.validateCatalog(null)).toEqual(['snapshot is not an object']);
    expect(catalog.validateCatalog({ functions: [] })).toContain('snapshot lacks relations');
  });

  it('accepts only owner-scoped foreign keys', () => {
    expect(catalog.ownerScopedForeignKey('FOREIGN KEY (owner_id, outfit_id) REFERENCES public.outfits(owner_id, id)')).toBe(true);
    expect(catalog.ownerScopedForeignKey('FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE')).toBe(true);
    expect(catalog.ownerScopedForeignKey('FOREIGN KEY (outfit_id, owner_id) REFERENCES public.outfits(owner_id, id)')).toBe(false);
    expect(catalog.ownerScopedForeignKey('FOREIGN KEY (owner_id) REFERENCES public.items(id)')).toBe(false);
  });

  it('pins policy helper bodies to their latest migration definition', async () => {
    const md5 = await catalog.helperBodyMd5(ROOT) as Record<string, string>;
    expect(Object.keys(md5).sort()).toEqual(['is_approved', 'may_create_item_object', 'may_delete_storage', 'owns_storage_path']);
    expect(md5.may_delete_storage).toBe('507ef6c28f1732df5d6141f730258062');
    expect(md5.may_create_item_object).toBe('93443dd83aaec31f8696ca844331dd83');
    const source = await readFile(path.join(ROOT, 'supabase', 'migrations', '20260922020000_checked_image_changes.sql'), 'utf8');
    expect(catalog.extractFunctionBody([source.replace(/\n/g, '\r\n')], 'private.may_delete_storage'))
      .toBe(catalog.extractFunctionBody([source], 'private.may_delete_storage'));
    expect(catalog.extractFunctionBody(['create function private.other() returns void as $$ select 1 $$;'], 'private.may_delete_storage')).toBeNull();
  });
});

describe('I17 response validators', () => {
  const error = (status: number, code: string, message: string): Result => ({ ok: false, status, data: { code, message, details: null, hint: null } });
  const success = (status: number, data: unknown): Result => ({ ok: true, status, data });

  it('requires the exact expected error class', () => {
    const expected = { status: 403, code: '42501', message: 'Not available' };
    expect(catalog.matchOutcome(expected, error(403, '42501', 'Not available'))).toBe(true);
    expect(catalog.matchOutcome(expected, error(400, '22023', 'Request conflict'))).toBe(false);
    expect(catalog.matchOutcome(expected, error(403, '42501', 'permission denied'))).toBe(false);
    expect(catalog.matchOutcome(expected, success(200, []))).toBe(false);
    expect(catalog.matchOutcome({ status: 200, data: null }, success(200, null))).toBe(true);
    expect(catalog.matchOutcome({ status: 200, data: [] }, success(200, [{ id: 'leaked' }]))).toBe(false);
    expect(catalog.matchOutcome({ status: 409, code: '23503' }, error(409, '23503', 'any message'))).toBe(true);
  });

  it('treats a peer ID like a nonexistent ID only after masking the substituted IDs', () => {
    const peer = '11111111-1111-4111-8111-111111111111', random = '22222222-2222-4222-8222-222222222222';
    expect(catalog.sameOutcome(error(409, '23505', `Key (id)=(${peer})`), error(409, '23505', `Key (id)=(${random})`), [peer], [random])).toBe(true);
    expect(catalog.sameOutcome(error(409, '23505', 'duplicate'), success(200, 1), [peer], [random])).toBe(false);
    expect(catalog.sameOutcome(success(200, [{ id: 'own' }]), success(200, [{ id: 'own' }, { id: 'peer' }]), [], [])).toBe(false);
  });

  it('detects leaked peer values and exempts only reflected inputs', () => {
    const peer = '11111111-1111-4111-8111-111111111111';
    expect(catalog.scanLeaks({ rows: [{ owner_id: peer }] }, [peer])).toEqual([peer]);
    expect(catalog.scanLeaks(`{"export_id":"${peer.toUpperCase()}"}`, [peer], [peer])).toEqual([]);
    expect(catalog.scanLeaks('Isolation canary B garment', ['Isolation canary B'])).toEqual(['Isolation canary B']);
    expect(catalog.scanLeaks('short', ['abc'])).toEqual([]);
  });

  it('fails on missing coverage and unknown entries', () => {
    const complete = new Map<string, Set<string>>();
    for (const f of catalog.EXPOSED_RPCS) complete.set(f.name, new Set(['A>B', 'B>A', 'anon']));
    for (const f of catalog.SERVICE_ONLY_RPCS) complete.set(f.name, new Set(['normal-A', 'normal-B', 'anon']));
    expect(catalog.validateCoverage(complete)).toEqual([]);
    const partial = new Map(complete);
    partial.set('commit_image', new Set(['A>B', 'anon']));
    partial.delete('deletion_control');
    partial.set('share_wardrobe', new Set(['A>B']));
    expect(catalog.validateCoverage(partial)).toEqual(expect.arrayContaining([
      'commit_image lacks B>A coverage', 'deletion_control lacks normal-A denial', 'coverage for unknown RPC share_wardrobe']));
  });
});

describe('I17 closed privileged control', () => {
  const ciEnv = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe', GITHUB_JOB: 'database',
    ALLOW_CI_DATABASE_MUTATION: '1', ALLOW_SECURITY_TESTS: '1', PATH: process.env.PATH ?? '' };
  const config = 'project_id = "stillroom-wardrobe"\n[api]\nschemas = ["public", "graphql_public"]\n';
  const container = JSON.stringify({ name: '/supabase_db_stillroom-wardrobe', project: 'stillroom-wardrobe',
    image: 'public.ecr.aws/supabase/postgres:17.6.1.165', running: true });
  function fakeRun({ endpoint = 'unix:///var/run/docker.sock', inspect = container } = {}) {
    type Run = (command: string, args: string[], options?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
    return vi.fn<Run>(async (_command, args) => {
      if (args[0] === 'context') return { code: 0, stdout: `${endpoint}\n`, stderr: '' };
      if (args[0] === 'info') return { code: 0, stdout: '27.0.0\n', stderr: '' };
      if (args[0] === 'container') return { code: 0, stdout: inspect, stderr: '' };
      if (args[0] === 'exec') return { code: 0, stdout: 'I17_FREEZE_OK\n', stderr: '' };
      return { code: 2, stdout: '', stderr: '' };
    });
  }
  const execCalls = (run: ReturnType<typeof fakeRun>) => run.mock.calls.filter(([, args]) => args[0] === 'exec');
  const attempt = (env: Record<string, string>, run: ReturnType<typeof fakeRun>, readConfig = async () => config, args = ['freeze', 'A']) =>
    catalog.privilegedOperation(args, { env, run, readConfig });

  it.each([
    ['a service secret', { ...ciEnv, SUPABASE_SERVICE_ROLE_KEY: 'x' }, 'REFUSED'],
    ['missing CI authorization', { ...ciEnv, GITHUB_JOB: 'lint' }, 'NOT RUN'],
    ['a missing security opt-in', { ...ciEnv, ALLOW_SECURITY_TESTS: '' }, 'NOT RUN'],
    ['a Docker host override', { ...ciEnv, DOCKER_HOST: 'tcp://remote:2375' }, 'REFUSED'],
    ['a PostgreSQL endpoint override', { ...ciEnv, PGHOST: 'remote.example' }, 'REFUSED'],
    ['a remote API', { ...ciEnv, SUPABASE_URL: 'https://example.supabase.co' }, 'REFUSED'],
  ])('refuses %s before any SQL', async (_label, env, message) => {
    const run = fakeRun();
    await expect(attempt(env, run)).rejects.toThrow(message);
    expect(execCalls(run)).toHaveLength(0);
  });

  it.each([
    ['a different project config', { readConfig: async () => 'project_id = "other"\n' }],
    ['a remote Docker endpoint', { endpoint: 'tcp://10.0.0.5:2376' }],
    ['a wrong container', { inspect: JSON.stringify({ name: '/other', project: 'stillroom-wardrobe', image: 'supabase/postgres:17.6.1.165', running: true }) }],
    ['an unexpected image', { inspect: JSON.stringify({ name: '/supabase_db_stillroom-wardrobe', project: 'stillroom-wardrobe', image: 'postgres:latest', running: true }) }],
    ['extra inspect keys', { inspect: JSON.stringify({ ...JSON.parse(container), extra: 1 }) }],
  ])('refuses %s before any SQL', async (_label, options: { endpoint?: string; inspect?: string; readConfig?: () => Promise<string> }) => {
    const run = fakeRun(options);
    await expect(attempt(ciEnv, run, options.readConfig)).rejects.toThrow('REFUSED');
    expect(execCalls(run)).toHaveLength(0);
  });

  it.each([[['freeze', 'C']], [['freeze']], [['catalog', 'A']], [['restore', 'A', 'extra']], [['select 1']], [['freeze', 'user-a@example.test']]])(
    'accepts no caller SQL or identity: %j', async (args) => {
      const run = fakeRun();
      await expect(attempt(ciEnv, run, undefined, args)).rejects.toThrow('REFUSED');
      expect(run).not.toHaveBeenCalled();
    });

  it('runs only fixed SQL for a fixed fictional owner after every guard', async () => {
    const run = fakeRun();
    await expect(attempt(ciEnv, run)).resolves.toEqual({ operation: 'freeze', label: 'A', problems: [] });
    const [exec] = execCalls(run);
    if (!exec) throw new Error('no exec call');
    expect(exec[1]).toEqual(expect.arrayContaining(['exec', '-i', 'supabase_db_stillroom-wardrobe', 'psql', '-h', '127.0.0.1']));
    expect(exec[2]?.input).toBe(catalog.freezeSql('A'));
    expect(catalog.freezeSql('A')).toContain("email='user-a@example.test'");
    expect(catalog.freezeSql('A')).toContain("email='user-b@example.test' and enabled");
    expect(catalog.restoreSql('B')).toContain("set enabled=true where email='user-b@example.test'");
    expect(() => catalog.freezeSql('C')).toThrow('REFUSED');
    expect(catalog.CATALOG_SQL).toMatch(/^begin read only;/);
  });

  it('passes guard flags but no credentials to the privileged child', () => {
    const child = catalog.privilegedEnvironment({ ...ciEnv, TEST_A_PASSWORD: 'x'.repeat(30), SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', DOCKER_HOST: 'tcp://x' });
    expect(child).toMatchObject({ GITHUB_JOB: 'database', ALLOW_SECURITY_TESTS: '1', ALLOW_CI_DATABASE_MUTATION: '1' });
    expect(child).not.toHaveProperty('TEST_A_PASSWORD');
    expect(child).not.toHaveProperty('SUPABASE_PUBLISHABLE_KEY');
    expect(child).not.toHaveProperty('DOCKER_HOST');
    expect(() => catalog.privilegedEnvironment({ ...ciEnv, SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow('REFUSED');
  });
});
