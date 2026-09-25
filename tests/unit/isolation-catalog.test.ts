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
    expect(catalog.EXPOSED_RPCS).toHaveLength(42);
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

  type Requirement = { refs: string[]; tuple?: boolean; alternatives?: boolean; mixed?: boolean; collision?: boolean; ownerOnly?: boolean; runtime?: boolean; unverified?: string };
  const requirements = catalog.COVERAGE_REQUIREMENTS as Record<string, Requirement>;
  const fullCoverage = () => {
    const map = new Map<string, Set<string>>();
    for (const f of catalog.EXPOSED_RPCS as { name: string }[]) {
      const r = requirements[f.name]!, tags = new Set(['anon']);
      if (!r.unverified) {
        for (const [a, v] of [['A', 'B'], ['B', 'A']]) {
          const d = `${a}>${v}`;
          tags.add(`${a}:control`);
          for (const ref of r.refs) tags.add(`${d}:ref:${ref}`);
          if (r.tuple) tags.add(`${d}:tuple`);
          if (r.mixed) tags.add(`${d}:mixed`);
          if (r.collision) tags.add(`${d}:collision`);
          if (r.ownerOnly) tags.add(`${d}:owner-only`);
        }
      }
      map.set(f.name, tags);
    }
    for (const f of catalog.SERVICE_ONLY_RPCS as { name: string }[]) map.set(f.name, new Set(['normal-A', 'normal-B', 'anon']));
    return map;
  };
  const without = (map: Map<string, Set<string>>, name: string, tag: string) => {
    const next = new Map(map);
    next.set(name, new Set([...(map.get(name) ?? [])].filter((t) => t !== tag)));
    return next;
  };
  const withTag = (map: Map<string, Set<string>>, name: string, ...tags: string[]) => {
    const next = new Map(map);
    next.set(name, new Set([...(map.get(name) ?? []), ...tags]));
    return next;
  };

  it('keeps one coverage requirement per exposed RPC', () => {
    expect(Object.keys(requirements).sort()).toEqual((catalog.EXPOSED_RPCS as { name: string }[]).map((f) => f.name).sort());
    expect(catalog.validateCoverage(fullCoverage())).toEqual([]);
    const fewer = { ...requirements };
    delete fewer.commit_image;
    expect(catalog.validateCoverage(fullCoverage(), fewer)).toContain('coverage requirements differ from the exposed RPCs');
  });

  it('rejects a missing successful owned control', () => {
    expect(catalog.validateCoverage(without(fullCoverage(), 'commit_image', 'A:control')))
      .toContain('commit_image A>B lacks a successful owned control');
  });

  it('requires each reference substituted on its own and mixed arrays', () => {
    expect(catalog.validateCoverage(without(fullCoverage(), 'image_recovery_preflight', 'B>A:ref:recSource')))
      .toContain('image_recovery_preflight lacks B>A:ref:recSource coverage');
    expect(catalog.validateCoverage(without(fullCoverage(), 'item_deletion_status', 'A>B:mixed')))
      .toContain('item_deletion_status lacks A>B:mixed coverage');
    expect(catalog.validateCoverage(without(fullCoverage(), 'save_outfit', 'A>B:collision')))
      .toContain('save_outfit lacks A>B:collision coverage');
    expect(catalog.validateCoverage(withTag(fullCoverage(), 'commit_image', 'A>B:ref:everything')))
      .toContain('commit_image has unexpected A>B:ref:everything credit');
  });

  it('requires the complete valid peer tuple for composite references', () => {
    expect(catalog.validateCoverage(without(fullCoverage(), 'image_change_status', 'A>B:tuple')))
      .toContain('image_change_status lacks A>B:tuple coverage');
    expect(catalog.validateCoverage(without(fullCoverage(), 'reconcile_item_deletion_target', 'B>A:tuple')))
      .toContain('reconcile_item_deletion_target lacks B>A:tuple coverage');
    expect(catalog.validateCoverage(withTag(fullCoverage(), 'commit_image', 'A>B:tuple')))
      .toContain('commit_image has unexpected A>B:tuple credit');
  });

  it('rejects a complete tuple built from attacker data', () => {
    const attacker = { changeItem: 'a0000000-0000-4000-8000-000000000001', changeIntent: { itemId: 'a0000000-0000-4000-8000-000000000001',
      currentImageId: 'a0000000-0000-4000-8000-000000000002' } };
    const victim = { changeItem: 'b0000000-0000-4000-8000-000000000001', changeIntent: { itemId: 'b0000000-0000-4000-8000-000000000001',
      currentImageId: 'b0000000-0000-4000-8000-000000000002' } };
    const good = { p_intent: structuredClone(victim.changeIntent) };
    expect(catalog.tupleConstructionProblems('image_change_preflight', good, attacker, victim, 'changeIntent')).toEqual([]);
    const cloned = { p_intent: { ...victim.changeIntent, currentImageId: attacker.changeIntent.currentImageId } };
    expect(catalog.tupleConstructionProblems('image_change_preflight', cloned, attacker, victim, 'changeIntent')).toEqual([
      'image_change_preflight tuple carries 1 attacker-only value(s)',
      "image_change_preflight tuple intent differs from the victim's accepted changeIntent",
    ]);
    expect(catalog.tupleConstructionProblems('image_change_status',
      { p_item_id: victim.changeItem, p_request_id: attacker.changeItem }, attacker, victim))
      .toEqual(['image_change_status tuple carries 1 attacker-only value(s)']);
  });

  it('builds intent tuples from the victim intent', async () => {
    const source = await readFile(path.resolve('tests/security/isolation-audit.sessions.mjs'), 'utf8');
    expect(source).not.toMatch(/structuredClone\(a\./);
    for (const key of ['freeIntent', 'recIntent', 'changeIntent']) expect(source).toContain(`tupleIntent: '${key}'`);
  });

  it('forces every multi-reference requirement to declare tuple or alternatives', () => {
    for (const [name, r] of Object.entries(requirements)) {
      expect(r.refs.length > 1 ? Boolean(r.tuple) !== Boolean(r.alternatives) : !r.tuple && !r.alternatives).toBe(true);
      if (r.tuple) expect(name).not.toBe('commit_image');
    }
    const undeclared = { ...requirements.image_change_status! };
    delete undeclared.tuple;
    expect(catalog.validateCoverage(fullCoverage(), { ...requirements, image_change_status: undeclared }))
      .toContain('image_change_status must declare its references as exactly one of tuple or alternatives');
    expect(catalog.validateCoverage(fullCoverage(), { ...requirements, forget_image: { ...requirements.forget_image!, tuple: true } }))
      .toContain('forget_image must declare its references as exactly one of tuple or alternatives');
  });

  it('never credits unreachable states and keeps runtime UNVERIFIED separate from credit', () => {
    expect(catalog.validateCoverage(withTag(fullCoverage(), 'reserve_analyzed_item_save', 'A>B:ref:aiRequest')))
      .toContain('reserve_analyzed_item_save A>B claims coverage for an unreachable state');
    const blocked = new Map(fullCoverage());
    blocked.set('ai_request_control', new Set(['anon', 'A>B:unverified', 'B>A:unverified']));
    expect(catalog.validateCoverage(blocked)).toEqual([]);
    expect(catalog.validateCoverage(withTag(blocked, 'ai_request_control', 'A>B:ref:aiRequest')))
      .toContain('ai_request_control A>B mixes UNVERIFIED with coverage credit');
    expect(catalog.validateCoverage(withTag(fullCoverage(), 'commit_image', 'A>B:unverified')))
      .toContain('commit_image A>B is UNVERIFIED but has no runtime allowance');
  });

  it('fails on missing anonymous or service denials and unknown entries', () => {
    const partial = without(fullCoverage(), 'commit_image', 'anon');
    partial.delete('deletion_control');
    partial.set('share_wardrobe', new Set(['A>B:owner-only']));
    partial.set('forget_image', new Set([...(partial.get('forget_image') ?? []), 'A>B']));
    expect(catalog.validateCoverage(partial)).toEqual(expect.arrayContaining([
      'commit_image lacks anon coverage', 'deletion_control lacks normal-A denial', 'coverage for unknown RPC share_wardrobe',
      'forget_image has malformed tag A>B']));
  });

  it('reads application errors from HTTP-200 envelopes, not transport errors', () => {
    const conflict = success(200, { code: 'CONFLICT' });
    expect(catalog.applicationCode(conflict)).toBe('CONFLICT');
    expect(catalog.matchOutcome({ status: 200, data: { code: 'CONFLICT' } }, conflict)).toBe(true);
    expect(catalog.matchOutcome({ status: 200, data: { code: 'CONFLICT' } }, success(200, { code: 'INVALID_INPUT' }))).toBe(false);
    expect(catalog.matchOutcome({ status: 200, data: { code: 'CONFLICT' } }, error(400, '22023', 'Request conflict'))).toBe(false);
    expect(catalog.applicationCode(error(400, 'CONFLICT', 'x'))).toBeNull();
    expect(catalog.applicationCode(success(200, [{ code: 'OK' }]))).toBeNull();
    expect(catalog.applicationCode(success(200, null))).toBeNull();
  });

  it('never treats owner-local refusals as ownership evidence', () => {
    for (const code of ['ALLOWANCE', 'RATE_LIMIT', 'UNCONFIGURED', 'UNAVAILABLE']) {
      expect(catalog.isInconclusive(success(200, { code }))).toBe(true);
    }
    expect(catalog.isInconclusive(success(200, { code: 'OK', status: 'reserved', replayed: false }))).toBe(false);
    expect(catalog.isInconclusive(error(400, '22023', 'Request conflict'))).toBe(false);
  });
});

describe('I17 existence oracles and restore ordering', () => {
  const err = (status: number, code: string, message: string) => ({ status, code, message });
  const ok = (status: number, data: unknown = null) => ({ status, data });
  const dup = (constraint: string) => err(409, '23505', `duplicate key value violates unique constraint "${constraint}"`);

  it('keeps every create-ID residual and Storage in the accepted inventory with exact pinned pairs', () => {
    expect(Object.keys(catalog.ACCEPTED_ORACLES).sort()).toEqual(['REST items id', 'REST outfits id', 'REST wear_event_items id',
      'REST wear_events id', 'Storage DELETE object', 'reserve_item_save p_item.id', 'reserve_restored_item_save p_item.id',
      'restore_history_entry p_id', 'save_outfit p_id', 'save_wear_event p_id']);
    const cases: [string, object, object][] = [
      ['save_outfit p_id', err(400, 'P0001', 'Request conflict'), ok(200, 1)],
      ['save_wear_event p_id', err(400, 'P0001', 'Request conflict'), ok(200, 1)],
      ['REST items id', dup('items_pkey'), ok(201, [])],
      ['REST outfits id', dup('outfits_pkey'), ok(201)],
      ['REST wear_events id', dup('wear_events_pkey'), ok(201)],
      ['REST wear_event_items id', dup('wear_event_items_pkey'), ok(201)],
      ['restore_history_entry p_id', err(400, 'P0001', 'Request conflict'), ok(204)],
      ['reserve_item_save p_item.id', err(400, '22023', 'Request conflict'), ok(200, {})],
      ['reserve_restored_item_save p_item.id', err(400, '22023', 'Request conflict'), ok(200, {})],
      ['Storage DELETE object', err(400, 'AccessDenied', 'Access denied'), err(400, 'NoSuchKey', 'Object not found')],
    ];
    for (const [surface, foreign, missing] of cases) {
      expect(catalog.classifyOracle(surface, true, foreign, missing)).toBe('accepted');
      expect(catalog.classifyOracle(surface, false, foreign, foreign)).toBe('accepted-not-reproduced');
    }
    for (const [surface, entry] of Object.entries(catalog.ACCEPTED_ORACLES as Record<string, { summary: string }>)) {
      expect(entry.summary).toContain(surface === 'Storage DELETE object' ? 'no policy-only fix for that execution path' : 'needs a candidate UUID');
      expect(entry.summary).not.toMatch(/no owner information/i);
    }
  });

  it('fails a changed pair on an accepted surface and any surface outside the allowlist', () => {
    // The pre-normalization 23505 response on save_outfit/save_wear_event is no longer accepted.
    expect(catalog.classifyOracle('save_outfit p_id', true, dup('outfits_pkey'), ok(200))).toBe('changed');
    expect(catalog.classifyOracle('save_wear_event p_id', true, dup('wear_events_pkey'), ok(200))).toBe('changed');
    expect(catalog.classifyOracle('save_outfit p_id', true, dup('items_pkey'), ok(200))).toBe('changed');
    expect(catalog.classifyOracle('save_outfit p_id', true, err(400, 'P0001', 'Request conflict'), ok(201))).toBe('changed');
    expect(catalog.classifyOracle('restore_history_entry p_id', true, err(400, 'P0001', 'Not available'), ok(204))).toBe('changed');
    expect(catalog.classifyOracle('Storage DELETE object', true, err(403, 'AccessDenied', 'Access denied'),
      err(400, 'NoSuchKey', 'Object not found'))).toBe('changed');
    expect(catalog.classifyOracle('Storage DELETE object', true, err(400, 'AccessDenied', 'Access denied'), ok(200))).toBe('changed');
    expect(catalog.classifyOracle('reserve_item_save p_item.id', true, err(400, '22023', 'Request conflict'),
      err(400, '22023', 'Request conflict'))).toBe('changed');
    expect(catalog.classifyOracle('ai_begin_request p_request_id', true, ok(200, {}), ok(200, { code: 'OK' }))).toBe('fail');
    expect(catalog.classifyOracle('ai_begin_request p_request_id', false, ok(200), ok(200))).toBe('equivalent');
  });

  it('lets the worst verdict decide a surface probed several times', () => {
    expect(catalog.worstOracle(['equivalent', 'accepted', 'accepted-not-reproduced'])).toBe('accepted');
    expect(catalog.worstOracle(['accepted', 'changed', 'accepted'])).toBe('changed');
    expect(catalog.worstOracle(['changed', 'fail'])).toBe('fail');
    expect(catalog.worstOracle([])).toBe('equivalent');
  });

  it('keeps an owner marked until its restore succeeds', () => {
    const touched = new Set<string>();
    catalog.trackPhase(touched, 'freeze', 'A', 'before');
    expect([...touched]).toEqual(['A']);
    catalog.trackPhase(touched, 'restore', 'A', 'after', 1);
    expect([...touched]).toEqual(['A']);
    catalog.trackPhase(touched, 'restore', 'A', 'after', 0);
    expect([...touched]).toEqual([]);
  });

  it('runs cleanup only after a confirmed restore barrier', async () => {
    const order: string[] = [];
    const cleanup = vi.fn(async () => { order.push('cleanup'); });
    expect(await catalog.restoreThenCleanup(true, async () => false, cleanup))
      .toEqual({ cleaned: false, errors: ['restore-barrier-unconfirmed'] });
    expect(await catalog.restoreThenCleanup(true, async () => { throw new Error('timeout'); }, cleanup))
      .toEqual({ cleaned: false, errors: ['restore-barrier-unconfirmed'] });
    expect(cleanup).not.toHaveBeenCalled();
    expect(await catalog.restoreThenCleanup(true, async () => { order.push('barrier'); return true; }, cleanup))
      .toEqual({ cleaned: true, errors: [] });
    expect(order).toEqual(['barrier', 'cleanup']);
    const barrier = vi.fn(async () => true);
    expect(await catalog.restoreThenCleanup(false, barrier, async () => { throw new Error('x'); }))
      .toEqual({ cleaned: true, errors: ['cleanup'] });
    expect(barrier).not.toHaveBeenCalled();
  });
});

describe('I17 taken-ID conflict-response normalization', () => {
  const peer = '11111111-1111-4111-8111-111111111111', own = '22222222-2222-4222-8222-222222222222';
  const fresh = '33333333-3333-4333-8333-333333333333';
  type Body = Record<string, unknown>;
  const failure = (status: number, body: Body): Result => ({ ok: false, status, data: body });
  const conflict = (code = 'P0001'): Body => ({ code, details: null, hint: null, message: 'Request conflict' });
  const duplicate = (constraint: string): Body => ({ code: '23505', details: null, hint: null,
    message: `duplicate key value violates unique constraint "${constraint}"` });
  const surfaces = catalog.TAKEN_ID_SURFACES as Record<string, { conflict: { status: number; body: Body }; fresh: { status: number; data?: unknown } }>;
  const good = (surface: string) => {
    const pin = surfaces[surface]!;
    const body = () => (pin.conflict.status === 409 ? duplicate(String(pin.conflict.body.message).match(/"(.+)"/)![1]!) : conflict(String(pin.conflict.body.code)));
    const freshResult: Result = { ok: true, status: pin.fresh.status, data: Object.hasOwn(pin.fresh, 'data') ? pin.fresh.data : [{ item: { id: fresh } }] };
    return {
      foreign: catalog.fullOutcome(failure(pin.conflict.status, body()), [peer]),
      own: catalog.fullOutcome(failure(pin.conflict.status, body()), [own]),
      fresh: catalog.fullOutcome(freshResult, [fresh]), persisted: true,
    };
  };
  const complete = () => {
    const records: Record<string, ReturnType<typeof good>> = {};
    for (const surface of Object.keys(surfaces)) for (const d of ['A>B', 'B>A']) records[`${surface} ${d}`] = good(surface);
    return records;
  };

  it('keeps a closed, frozen inventory covering every create-ID RPC and REST insert that is probed', () => {
    expect(Object.isFrozen(catalog.TAKEN_ID_SURFACES)).toBe(true);
    expect(Object.keys(surfaces).sort()).toEqual(['REST items id', 'REST outfits id', 'REST wear_event_items id', 'REST wear_events id',
      'reserve_item_save p_item.id (plain item)', 'reserve_item_save p_item.id (save attempt)',
      'reserve_restored_item_save p_item.id (plain item)', 'reserve_restored_item_save p_item.id (save attempt)', 'restore_history_entry p_id',
      'save_outfit p_id', 'save_wear_event p_id']);
    for (const pin of Object.values(surfaces)) expect(Object.isFrozen(pin.conflict)).toBe(true);
    expect(surfaces['save_outfit p_id']!.conflict).toEqual({ status: 400, body: conflict() });
    expect(surfaces['reserve_item_save p_item.id (plain item)']!.conflict).toEqual({ status: 400, body: conflict('22023') });
    expect(surfaces['REST items id']!.conflict).toEqual({ status: 409, body: duplicate('items_pkey') });
  });

  it('passes only when foreign and own conflicts equal the pinned full response and the fresh create reads back', () => {
    expect(catalog.takenIdProblems(complete())).toEqual([]);
  });

  it('keeps missing and null fields distinct and masks only the substituted IDs', () => {
    const withNull = catalog.fullOutcome(failure(400, conflict()), [peer]);
    const without = catalog.fullOutcome(failure(400, { code: 'P0001', hint: null, message: 'Request conflict' }), [peer]);
    expect(withNull).not.toEqual(without);
    const keyed = (id: string): Body => ({ ...duplicate('outfits_pkey'), details: `Key (id)=(${id}) already exists.` });
    const masked = catalog.fullOutcome(failure(409, keyed(peer)), [peer]);
    expect(masked).toEqual({ status: 409, body: keyed('<ID>') });
    expect(catalog.fullOutcome(failure(409, keyed(peer)), [])).not.toEqual(masked);
  });

  it.each([
    ['details only', { details: 'Key (id) exists' }],
    ['hint only', { hint: 'Try another ID' }],
    ['message only', { message: 'Request rejected' }],
    ['code only', { code: '23505' }],
    ['a missing field', { details: undefined }],
    ['an extra field', { owner: 'hidden' }],
  ])('fails when the foreign response differs from the own conflict by %s', (_label, change) => {
    const records = complete();
    const key = 'save_outfit p_id A>B';
    const body = { ...conflict(), ...change } as Body;
    for (const [field, value] of Object.entries(change)) if (value === undefined) delete body[field];
    records[key] = { ...records[key]!, foreign: catalog.fullOutcome(failure(400, body), [peer]) };
    const problems = catalog.takenIdProblems(records);
    expect(problems).toContain(`${key}: foreign ID response differs from the own conflicting create`);
    expect(problems.some((p: string) => p.startsWith(`${key}: foreign ID `) && p.includes('differs from the pinned'))).toBe(true);
  });

  it('fails identical but wrong responses, such as the old 23505 on both sides', () => {
    const records = complete();
    const key = 'save_outfit p_id B>A';
    const old = (id: string) => catalog.fullOutcome(failure(409, duplicate('outfits_pkey')), [id]);
    records[key] = { ...records[key]!, foreign: old(peer), own: old(own) };
    const problems = catalog.takenIdProblems(records);
    expect(problems).not.toContain(`${key}: foreign ID response differs from the own conflicting create`);
    expect(problems.filter((p: string) => p.startsWith(key))).toHaveLength(2);
  });

  it('fails a REST duplicate that exposes a key DETAIL, even when both sides match', () => {
    const records = complete();
    const key = 'REST items id A>B';
    const keyed = (id: string) => catalog.fullOutcome(failure(409, { ...duplicate('items_pkey'), details: `Key (id)=(${id}) already exists.` }), [id]);
    records[key] = { ...records[key]!, foreign: keyed(peer), own: keyed(own) };
    expect(catalog.takenIdProblems(records).filter((p: string) => p.startsWith(key))).toHaveLength(2);
  });
  it('fails a missing control, a missing direction, an unread fresh create or an unknown surface', () => {
    const missingOwn = complete();
    const key = 'REST outfits id A>B';
    delete (missingOwn[key] as Partial<ReturnType<typeof good>>).own;
    expect(catalog.takenIdProblems(missingOwn)).toContain(`${key}: missing own control`);
    const missingDirection = complete();
    delete missingDirection['reserve_item_save p_item.id (plain item) B>A'];
    expect(catalog.takenIdProblems(missingDirection)).toContain('reserve_item_save p_item.id (plain item) B>A: no taken-ID probes');
    const unread = complete();
    unread['save_wear_event p_id A>B'] = { ...unread['save_wear_event p_id A>B']!, persisted: false };
    expect(catalog.takenIdProblems(unread)).toContain('save_wear_event p_id A>B: fresh create was not read back');
    const failedFresh = complete();
    failedFresh['restore_history_entry p_id A>B'] = { ...failedFresh['restore_history_entry p_id A>B']!,
      fresh: catalog.fullOutcome(failure(400, conflict()), [fresh]) };
    expect(catalog.takenIdProblems(failedFresh).some((p: string) => p.startsWith('restore_history_entry p_id A>B: fresh ID'))).toBe(true);
    const unknown = { ...complete(), 'REST items id A>C': good('REST items id') };
    expect(catalog.takenIdProblems(unknown)).toContain('REST items id A>C: unknown taken-ID surface');
    expect(catalog.takenIdProblems({})).toHaveLength(Object.keys(surfaces).length * 2);
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

describe('export snapshot comparison', () => {
  const row = (id: string, title: string) => ({ id, owner_id: 'o', title, tags: ['b', 'a'] });
  const exported = (items: unknown[]) => ({ schema_version: 2, export_id: crypto.randomUUID(), owner_id: 'o',
    created_at: new Date().toISOString(), tables: { items, outfits: [] } });
  it('ignores only aggregate row order and the per-call export identity', () => {
    const before = catalog.stableExport(exported([row('1', 'A'), row('2', 'B')]));
    expect(catalog.stableExport(exported([row('2', 'B'), row('1', 'A')]))).toEqual(before);
    expect(before).not.toHaveProperty('export_id');
    expect(before).not.toHaveProperty('created_at');
  });
  it('catches a leftover, missing or altered control row', () => {
    const before = catalog.stableExport(exported([row('1', 'A'), row('2', 'B')]));
    expect(catalog.stableExport(exported([row('1', 'A'), row('2', 'B'), row('3', 'Isolation oracle')]))).not.toEqual(before);
    expect(catalog.stableExport(exported([row('1', 'A')]))).not.toEqual(before);
    expect(catalog.stableExport(exported([row('1', 'A'), row('2', 'C')]))).not.toEqual(before);
    expect(catalog.stableExport(exported([row('1', 'A'), { ...row('2', 'B'), tags: ['a', 'b'] }]))).not.toEqual(before);
  });
});
