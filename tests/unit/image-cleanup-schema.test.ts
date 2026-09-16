import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { MIGRATIONS, ITEM_LIFECYCLE_CATALOG_SQL, IMAGE_CLEANUP_CATALOG_SQL } from '../../scripts/preservation-rehearsal.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { PUBLICATION_BODY_MD5 } from '../../scripts/backend/ci-storage-guard.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { checkCleanupPage, checkCleanupStatus } from '../integration/image-cleanup.sessions.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { assertImageCleanupRehearsal } from '../../scripts/image-cleanup-rehearsal.mjs';

const sql = readFileSync('supabase/migrations/20260916100000_image_cleanup.sql', 'utf8');
const old = readFileSync('supabase/migrations/20260913120000_item_lifecycle.sql', 'utf8');
const source = (path: string) => readFileSync(path, 'utf8');
function routine(name: string) {
  const escaped = name.replaceAll('.', '\\.');
  const match = new RegExp(`create(?: or replace)? function ${escaped}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql);
  if (!match) throw new Error(`Missing cleanup routine: ${name}`);
  return match[0];
}

describe('I10a checked image cleanup SQL source contract', () => {
  it('binds the tenth bytes and each actual replacement body to its exact evaluated live tuple', () => {
    const migrations = MIGRATIONS as Array<{ name: string; bytes: number; sha256: string }>;
    expect(migrations).toHaveLength(10);
    expect(migrations[9]).toMatchObject({
      name: '20260916100000_image_cleanup.sql', bytes: Buffer.byteLength(sql),
      sha256: createHash('sha256').update(sql).digest('hex'),
    });
    const current = new Map([
      ['private.guard_item_image_deletion', 'private.guard_item_image_deletion()'],
      ['private.may_create_item_object', 'private.may_create_item_object(text)'],
      ['private.guard_item_object_publication', 'private.guard_item_object_publication()'],
      ['public.begin_item_deletion', 'public.begin_item_deletion(uuid,bigint,uuid,text)'],
    ]);
    const overrides = [...sql.matchAll(/create or replace function ([\w.]+)\(/g)].map((m) => m[1]);
    expect(overrides.sort()).toEqual([...current.keys()].sort());
    const catalog = ITEM_LIFECYCLE_CATALOG_SQL as string;
    const pins = [...catalog.matchAll(/\('([^']+)','([0-9a-f]{32})'\)/g)]
      .map((m) => ({ identity: m[1], hash: m[2] }));
    expect(pins).toHaveLength(11);
    expect(new Set(pins.map((p) => p.identity)).size).toBe(11);
    expect(catalog).toContain('count(*)=11 and bool_and(md5(p.prosrc)=expected.hash)');
    expect(catalog).toContain('p.oid=expected.identity::regprocedure');
    for (const [name, signature] of current) {
      const body = routine(name).match(/as \$\$([\s\S]*?)\$\$;/)?.[1];
      if (body === undefined) throw new Error('Missing current SQL body');
      const actualHash = createHash('md5').update(body).digest('hex');
      expect(pins.filter((p) => p.identity === signature)).toEqual([{ identity: signature, hash: actualHash }]);
      if (name === 'private.guard_item_object_publication') expect(PUBLICATION_BODY_MD5).toBe(actualHash);
    }
  });

  it('keeps positive cleanup catalog checks alongside all existing lifecycle/native checks', () => {
    const catalog = IMAGE_CLEANUP_CATALOG_SQL as string;
    for (const key of ['tables', 'noPolicies', 'noTableGrants', 'claimColumns', 'claimKeys', 'contextColumns',
      'contextKeys', 'rpc', 'privateDenied', 'pureAge', 'boundedWrites', 'contextEmpty']) {
      expect(catalog).toContain(`'${key}',`);
    }
    expect(catalog).toContain('count(*)=5 and bool_and(p.prosecdef');
    expect(catalog).toContain("'anon','authenticated','service_role'");
    expect(catalog).toContain('aclexplode');
    expect(catalog).toContain("'lock_timeout=2s'=any(p.proconfig)");
    const rehearsal = source('scripts/preservation-rehearsal.mjs');
    expect(rehearsal).toContain('Object.keys(cleanupCatalog).length === 12');
    expect(rehearsal).toContain('Object.keys(lifecycleCatalog).length === 19');
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain("tgenabled='A'");
  });

  it('adds only private durable claims/context, with no destructive expiry or client table access', () => {
    expect(sql.match(/create table /g)).toHaveLength(2);
    expect(sql).toContain('primary key(owner_id,request_id)');
    expect(sql).toContain('unique(owner_id,item_id,image_id)');
    expect(sql).toContain('owner_id uuid not null references public.profiles(owner_id) on delete cascade');
    expect(sql).not.toMatch(/references public\.(items|item_images)/);
    expect(sql).toContain("state='completed' and kind is null and started_at is null and eligibility_at is null");
    expect(sql).toContain('manifest_sha256 is null and objects is null');
    expect(sql).toContain("jsonb_array_length(objects)<=2 and octet_length(convert_to(objects::text,'UTF8'))<=16384");
    for (const table of ['image_cleanup_claims', 'image_cleanup_delete_context']) {
      expect(sql).toContain(`alter table private.${table} enable row level security`);
    }
    expect(sql).toContain('revoke all on private.image_cleanup_claims,private.image_cleanup_delete_context from public,anon,authenticated,service_role');
    expect(sql).not.toMatch(/create policy|grant .* on (?:table )?private\.image_cleanup|set_config|session_replication_role|disable trigger|create extension/i);
    expect(sql).not.toMatch(/delete from private\.image_cleanup_claims|expires_at|cancel_image_cleanup|release_image_cleanup/);
  });

  it('uses the same private pure strict-age predicate in production and exact-boundary fixtures', () => {
    const age = routine('private.image_cleanup_old_enough');
    expect(age).toContain('language sql immutable');
    expect(age).toContain("timezone('UTC',p_time)<timezone('UTC',p_now)-interval '24 hours'");
    expect(age).toContain("timezone('UTC',p_time)<timezone('UTC',p_now)-interval '7 days'");
    expect(age).not.toContain('p_time<p_now-interval');
    expect(age).toContain('isfinite(p_time) and isfinite(p_now) and p_time<=p_now');
    expect(age).toContain('else false');
    const evidence = routine('private.image_cleanup_evidence');
    expect(evidence).toContain('private.image_cleanup_old_enough(kind,age,p_now)');
    expect(evidence).toContain("private.image_cleanup_old_enough('orphan',member.created_at,p_now)");
    expect(evidence).toContain("kind in ('pending','retired')");
    expect(evidence).toContain("kind='orphan' and jsonb_array_length(objects)=0");
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    expect(rehearsal).toContain("instant-duration-interval '1 microsecond'");
    expect(rehearsal).toContain("private.image_cleanup_old_enough(kind,instant-duration,instant)");
    expect(rehearsal).toContain("private.image_cleanup_old_enough(kind,'infinity',instant)");
    expect(rehearsal).toContain("private.image_cleanup_old_enough(kind,null,instant)");
  });

  it('pins the closed registered-image and catalog manifest projections', () => {
    const projection = routine('private.image_cleanup_image');
    const keys = [...projection.matchAll(/'([a-z_]+)',(?:im\.[a-z_]+|timezone\('UTC',im\.(?:created_at|retired_at)\))/g)]
      .map((match) => match[1]);
    expect(keys).toEqual([
      'owner_id', 'item_id', 'id', 'state', 'created_at', 'retired_at', 'description_version',
      'main_path', 'thumb_path', 'main_bytes', 'thumb_bytes', 'main_sha256', 'thumb_sha256',
      'width', 'height', 'alt_text',
    ]);
    expect(projection).not.toContain('to_jsonb');
    for (const field of ['created_at', 'retired_at']) {
      expect(projection).toContain(`'${field}',timezone('UTC',im.${field})`);
      expect(projection).not.toContain(`'${field}',im.${field}`);
    }
    const evidence = routine('private.image_cleanup_evidence');
    expect([...evidence.matchAll(/'([a-z_]+)',(?:member\.[a-z_]+|timezone\('UTC',member\.created_at\))/g)].map((match) => match[1]))
      .toEqual(['id', 'name', 'version', 'created_at']);
    expect(evidence).toContain("'created_at',timezone('UTC',member.created_at)");
    expect(evidence).not.toContain("'created_at',member.created_at");
    for (const field of ['created_at', 'retired_at']) {
      expect(evidence).toContain(`timezone('UTC',(image->>'${field}')::timestamp)`);
      expect(evidence).not.toContain(`(image->>'${field}')::timestamptz`);
    }
    expect(evidence).toContain('order by o.name');
    expect(evidence).toContain("octet_length(convert_to(member.version,'UTF8'))>1024");
    expect(evidence).not.toMatch(/coalesce\(member\.(id|version|created_at)/);
    expect(evidence).not.toMatch(/updated_at|last_accessed_at|user_metadata|to_jsonb\(o/);
    expect(routine('private.image_cleanup_manifest')).toContain("convert_to(jsonb_build_object(");
  });

  it('declares fixed-elapsed DST expectations and non-null cross-zone manifest regressions within control ownership', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const start = rehearsal.indexOf('async function timezoneDeterminism(');
    const end = rehearsal.indexOf('async function checkRetention(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const regression = rehearsal.slice(start, end);
    expect(regression).toContain('await control(`do $timezone$');
    expect(regression).toContain('$timezone$;`, deadline)');
    expect(regression).not.toMatch(/\bcommit\b|set_config\([^;]*,false\)|set\s+(?:session|global)|alter\s+(?:database|role)/i);
    for (const anchor of ['2026-11-02T12:00:00+00', '2026-03-09T12:00:00+00']) {
      expect(regression).toContain(`'${anchor}'::timestamptz`);
    }
    expect(regression).toContain("interval '24 hours' else interval '168 hours'");
    expect(regression).toContain('boundary := anchor-elapsed');
    expect(regression).toContain('array[-1,0,1]');
    expect(regression).toContain("sample := boundary+offset_us*interval '1 microsecond'");
    expect(regression).toContain('expected := offset_us<0');
    expect(regression).toContain('actual is distinct from expected');
    expect(regression).toContain('actual is distinct from utc_result');
    expect(regression).toContain("array['UTC','America/Los_Angeles']");
    expect(regression).toContain("set_config('TimeZone',zone,true)");
    expect(regression.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(regression).toContain('fixture.image_id,observed)');
    for (const guard of [
      "image is null or image->>'created_at' is null",
      "fixture.kind='retired' and image->>'retired_at' is null",
      "(evidence->>'eligible')::boolean is distinct from true",
      "evidence->>'manifest_sha256' is null",
      "jsonb_array_length(evidence->'objects') is distinct from 2",
      "where o->>'created_at' is null",
      "image is distinct from utc_image",
      "evidence->'objects' is distinct from utc_objects",
      "evidence->>'manifest_sha256' is distinct from utc_manifest",
    ]) expect(regression).toContain(guard);
    const call = rehearsal.indexOf('await timezoneDeterminism(pending, retired, deadline)');
    expect(call).toBeGreaterThan(rehearsal.indexOf("await ageFixture(retired, 'retired', deadline)"));
    expect(call).toBeLessThan(rehearsal.indexOf('const expected = [empty, pending, retired'));
  });

  it('binds exact owned tuples and stored references, not a global image-ID absence guess', () => {
    const evidence = routine('private.image_cleanup_evidence');
    expect(evidence).toContain("image->>'main_path' is distinct from prefix || 'main.jpg'");
    expect(evidence).toContain("image->>'thumb_path' is distinct from prefix || 'thumb.jpg'");
    expect(evidence).toContain('im.owner_id=p_owner');
    expect(evidence).toContain("im.main_path in(prefix || 'main.jpg',prefix || 'thumb.jpg')");
    expect(evidence).toContain("im.thumb_path in(prefix || 'main.jpg',prefix || 'thumb.jpg')");
    expect(routine('private.image_cleanup_image')).toContain('im.owner_id=p_owner and im.item_id=p_item and im.id=p_image');
    const page = routine('public.image_cleanup_page');
    expect(page).toContain('with canonical as materialized');
    expect(page).toContain('union select split_part');
    expect(page).toContain('order by item_id,image_id');
    expect(page).toContain('jsonb_array_length(candidates)<20');
    expect(page).toContain('has_more := true');
    expect(page).toContain("case when has_more then next_cursor else null end");
    expect(page).toContain("'review_reasons',jsonb_build_object('unsupported_paths',unsupported,'unverifiable_metadata',invalid)");
    expect(page).toContain("'pending_grace',grace");
    expect(page).not.toContain("'review_required'");
  });

  it('locks before acceptance, rechecks after burning the marker, and keeps exact replay', () => {
    const begin = routine('public.begin_image_cleanup');
    expect(begin).toContain("set lock_timeout = '2s'");
    expect(begin.indexOf('private.item_lifecycle_owner()')).toBeLessThan(begin.indexOf('for update nowait'));
    expect(begin.match(/private.image_cleanup_evidence\(/g)).toHaveLength(2);
    const marker = begin.indexOf('insert into private.item_image_used_ids');
    expect(marker).toBeGreaterThan(begin.indexOf('private.image_cleanup_evidence('));
    expect(marker).toBeLessThan(begin.lastIndexOf('private.image_cleanup_evidence('));
    expect(begin).toContain('on conflict do nothing');
    expect(begin).toContain('claim.item_id<>p_item_id or claim.image_id<>p_image_id');
    expect(begin).toContain("claim.state='active' and claim.manifest_sha256<>p_manifest_sha256");
    expect(begin).toContain('exception when lock_not_available or unique_violation');
    expect(begin).toContain("s.image_id=p_image_id and s.state='reserved'");
    expect(begin).toContain('update private.ai_item_save_attempts a set cancelled=true');
    expect(begin).not.toContain("set state='cancelled'");
  });

  it('uses frozen eligibility but current immutable identity after acceptance', () => {
    const status = routine('private.image_cleanup_checked_status');
    expect(status).toContain('p_claim.kind,image,p_claim.objects');
    expect(status).toContain("frozen->>'name'=member.name");
    expect(status).toContain("(frozen->>'id')::uuid=member.id");
    expect(status).toContain("frozen->>'version' is not distinct from member.version");
    expect(status).not.toMatch(/o\.created_at|member\.created_at|clock_timestamp|image_cleanup_old_enough/);
    expect(status).toContain("where o.bucket_id='wardrobe'");
    expect(status).toContain("from (values ('main',1),('thumb',2))");
    const finish = routine('public.finish_image_cleanup');
    expect(finish.indexOf('private.image_cleanup_checked_status(claim);', finish.indexOf('prefix :=')))
      .toBeLessThan(finish.indexOf('delete from public.item_images'));
    expect(finish).toContain("where (p->>'present')::boolean");
    expect(finish).toContain('insert into private.image_cleanup_delete_context');
    expect(finish).toContain('delete from private.image_cleanup_delete_context');
    expect(finish).toContain("set state='completed',kind=null,started_at=null,eligibility_at=null");
    expect(finish).not.toMatch(/delete from storage\.objects|delete from public\.items|update public\.items/);
  });

  it('preserves UPDATE immutability without profile locks and keeps INSERT publication locks', () => {
    const publication = routine('private.guard_item_object_publication');
    const update = publication.slice(publication.indexOf("if tg_op='UPDATE'"), publication.indexOf("if new.bucket_id<>'wardrobe'"));
    expect(update).toContain('row(new.id,new.bucket_id,new.name,new.owner,new.owner_id,new.archived_at,new.is_delete_marker,new.is_versioned)');
    expect(update).toContain('new.version is distinct from old.version');
    expect(update).toContain("errcode='23505'");
    expect(update).toContain("errcode='42501',message='Not available'");
    expect(update).toContain('private.image_cleanup_claims');
    expect(update).not.toMatch(/for (?:share|update|key share)|public\.profiles|approved_accounts|state='pending'/);
    expect(publication.match(/for share nowait/g)).toHaveLength(4);
    expect(publication).toContain('c.image_id=image.id');
    expect(publication).toContain('and a.cancelled');
    expect(publication).toContain("image.state is distinct from 'pending'");
    expect(sql).not.toMatch(/create trigger|alter table storage\.objects/);
  });

  it('preserves I08 status and validated replay before excluding a new whole-item claim', () => {
    expect(sql).not.toMatch(/create(?: or replace)? function public\.(item_deletion_status|finish_item_deletion|set_item_trashed)/);
    const begin = routine('public.begin_item_deletion');
    const resume = begin.indexOf('return query select claim.request_id');
    expect(resume).toBeGreaterThan(begin.indexOf('manifest<>p_image_manifest_sha256'));
    expect(resume).toBeLessThan(begin.indexOf('private.image_cleanup_claims'));
    expect(routine('public.begin_image_cleanup')).toContain('private.item_deletion_claims');
    const guard = routine('private.guard_item_image_deletion');
    expect(guard).toContain("tg_op='DELETE' and exists");
    expect(guard).toContain('c.item_id=d.item_id and c.image_id=d.image_id');
    expect(guard).toContain('private.item_deletion_claims');
    expect(guard).toContain('for key share nowait');
    expect(createHash('sha256').update(old).digest('hex')).toBe('8cc0fc1207737d63b7e1d000fc7471a9941a4833aaebebc75979c498a4d6c476');
  });

  it('grants exactly the five owner RPCs and explicitly removes default service privileges', () => {
    const publicNames = [...sql.matchAll(/create function public\.([a-z_]+)\(/g)].map((match) => match[1]);
    expect(publicNames.sort()).toEqual([
      'begin_image_cleanup', 'finish_image_cleanup', 'image_cleanup_claims', 'image_cleanup_page', 'image_cleanup_status',
    ]);
    for (const name of publicNames) {
      const body = routine(`public.${name}`);
      expect(body).toContain("security definer set search_path = ''");
      expect(body).toMatch(/private\.is_approved\(\)|private\.item_lifecycle_owner\(\)/);
    }
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain('public.image_cleanup_status(uuid),public.image_cleanup_claims(uuid),public.finish_image_cleanup(uuid) to authenticated');
    expect(routine('public.image_cleanup_claims')).toContain('limit 21');
    expect(routine('public.image_cleanup_claims')).toContain('limit 20');
    expect(routine('public.image_cleanup_claims')).not.toContain('image_cleanup_checked_status');
  });

  it('keeps stage1 execution isolated and finite, with original UI and ungenerated types untouched', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    expect(rehearsal).toContain('const TOTAL_MS = 480_000');
    expect(rehearsal).toContain('const TEARDOWN_MS = 120_000');
    expect(rehearsal).toContain("env.ALLOW_IMAGE_CLEANUP_REHEARSAL === '1'");
    expect(rehearsal).toContain("env.GITHUB_JOB === 'database'");
    expect(rehearsal).toContain('validateSessionEnvironment(env)');
    expect(rehearsal).toContain('assertNoServiceSecrets(env)');
    expect(rehearsal).toContain("['ALLOW_IMAGE_CLEANUP_REHEARSAL', 'ALLOW_PRESERVATION_REHEARSAL', 'ALLOW_CI_STORAGE_GUARD_INSTALL']");
    expect(rehearsal).toContain('finally');
    expect(rehearsal).not.toMatch(/playwright|serviceKey|replica|disable trigger|ALLOW_HOSTED_SMOKE/);
    expect(sql).not.toMatch(/ai_requests|ai_controls|ai_usage|analyze-clothing/);
    expect(source('scripts/run-local-tests.mjs')).toContain("'image-cleanup.sessions.mjs'");
  });

  it('requires both opt-ins before fixture mutation and retains two admitted slow denials through active state', () => {
    const allowed = {
      CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe',
      GITHUB_JOB: 'database', ALLOW_SECURITY_TESTS: '1',
      ALLOW_IMAGE_CLEANUP_REHEARSAL: '1', ALLOW_PRESERVATION_REHEARSAL: '1',
    };
    expect(() => assertImageCleanupRehearsal(allowed, [])).not.toThrow();
    for (const key of ['CI', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_JOB',
      'ALLOW_IMAGE_CLEANUP_REHEARSAL', 'ALLOW_PRESERVATION_REHEARSAL']) {
      for (const value of [undefined, '', 'false', '0', 'TRUE']) {
        expect(() => assertImageCleanupRehearsal({ ...allowed, [key]: value }, [])).toThrow();
      }
    }
    for (const args of [['--local'], ['--browser'], [''], null]) {
      expect(() => assertImageCleanupRehearsal(allowed, args)).toThrow();
    }
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    expect(rehearsal).toContain('assertRehearsalEnvironment(env, args)');
    expect(rehearsal).toContain('[[owner, lateA], [peer, lateB]]');
    const late = rehearsal.slice(rehearsal.indexOf('async function latePublication('),
      rehearsal.indexOf('async function housekeeping('));
    const callback = late.slice(late.indexOf('await withLifecycleLateUpload('), late.indexOf("requireCleanup(JSON.stringify(intent)"));
    expect(callback).toContain('async () =>');
    expect(callback).toContain('await beginFixture(owner, value, candidate)');
    expect(callback).not.toMatch(/finish_image_cleanup|resumeCleanupFixture|set_item_trashed|\.delete\(/);
    expect(late.indexOf('await requireLateState(')).toBeGreaterThan(late.indexOf('await withLifecycleLateUpload('));
    expect(late.indexOf('await requireAbsentBytes(')).toBeLessThan(late.indexOf('await resumeCleanupFixture('));
    expect(late).toContain('no paired unclaimed control or precise guard trace');
    const workflow = source('.github/workflows/ci.yml');
    const start = workflow.indexOf('- run: node scripts/image-cleanup-rehearsal.mjs');
    const end = workflow.indexOf('- run: npm run db:types', start);
    expect(start).toBeGreaterThan(workflow.indexOf('- run: node scripts/ai-analysis-rehearsal.mjs'));
    expect(end).toBeGreaterThan(start);
    expect(workflow.slice(start, end)).toContain("ALLOW_IMAGE_CLEANUP_REHEARSAL: '1'");
    expect(workflow.slice(start, end)).toContain("ALLOW_PRESERVATION_REHEARSAL: '1'");
  });

  it('declares joined metadata orderings, native housekeeping and both pagination boundaries', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    expect(rehearsal).toContain("[[insertFirst, 'metadata'], [cleanupFirst, 'cleanup'], [concurrentInsert, 'concurrent']]");
    expect(rehearsal).toContain('Promise.allSettled');
    expect(rehearsal).toContain("'no-dual-insertion-winner'");
    expect(rehearsal).toContain("'existing-item-resume'");
    expect(rehearsal).toContain("'profile-lock-photo-read'");
    expect(rehearsal).toContain("'claim-page-lookahead'");
    expect(rehearsal).toContain("'claim-page-keyset'");
    expect(rehearsal).toContain("'single-member-candidate'");
    expect(rehearsal).toContain('exception when insufficient_privilege then null');
    expect(rehearsal).toContain("modified.objects := '[]'::jsonb");
    expect(rehearsal).toContain('if (failed) throw primary');
    const ordinary = source('tests/integration/image-cleanup.sessions.mjs');
    expect(ordinary).toContain("'ready-missing-ineligible'");
    expect(ordinary).toContain('size <= 4096');
    expect(ordinary).toContain('AbortSignal.timeout(10_000)');
  });
});

describe('I10a ordinary response validation', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  const item = '10000000-0000-4000-8000-000000000002';
  const image = '10000000-0000-4000-8000-000000000003';
  const request = '10000000-0000-4000-8000-000000000004';
  const candidate = { item_id: item, image_id: image, kind: 'pending', object_count: 0, manifest_sha256: 'a'.repeat(64) };
  const page = {
    owner_id: owner, observed_at: '2026-09-16T00:00:00Z', candidates: [candidate], next: null,
    review_reasons: { unsupported_paths: false, unverifiable_metadata: false }, pending_grace: false,
  };
  it('rejects foreign, malformed, unordered and incomplete page acknowledgements', () => {
    expect(checkCleanupPage(page, owner)).toBe(page);
    for (const bad of [
      null, {}, { ...page, extra: true }, { ...page, owner_id: item }, { ...page, observed_at: 'invalid' },
      { ...page, candidates: [...page.candidates, ...page.candidates] }, { ...page, candidates: Array(21).fill(candidate) },
      { ...page, candidates: [{ ...candidate, kind: 'ready' }] },
      { ...page, candidates: [{ ...candidate, object_count: 3 }] },
      { ...page, candidates: [{ ...candidate, kind: 'orphan', object_count: 0 }] },
      { ...page, candidates: [{ ...candidate, manifest_sha256: 'A'.repeat(64) }] },
      { ...page, next: { item_id: item, image_id: image } },
      { ...page, review_reasons: { unsupported_paths: false } },
    ]) expect(() => checkCleanupPage(bad, owner)).toThrow();
  });
  it('accepts only exact request/target/path states without extra identity metadata', () => {
    const active = {
      owner_id: owner, request_id: request, item_id: item, image_id: image, kind: 'pending',
      state: 'active', manifest_sha256: 'a'.repeat(64),
      paths: ['main', 'thumb'].map((role) => ({ role, path: `${owner}/${item}/${image}/${role}.jpg`, present: false })),
    };
    expect(checkCleanupStatus(active, owner, request)).toBe(active);
    expect(checkCleanupStatus({ owner_id: owner, request_id: request, state: 'not_started' }, owner, request).state).toBe('not_started');
    const completed = { owner_id: owner, request_id: request, item_id: item, image_id: image, state: 'completed' };
    expect(checkCleanupStatus(completed, owner, request)).toBe(completed);
    for (const bad of [
      { ...active, owner_id: item }, { ...active, request_id: item }, { ...active, paths: [...active.paths].reverse() },
      { ...active, paths: [{ role: 'main', path: 'not-canonical', present: false }, active.paths[1]] },
      { ...active, paths: active.paths.map((p) => ({ ...p, version: null })) }, { ...completed, objects: [] },
      { owner_id: owner, request_id: request, state: 'not_started', item_id: item },
    ]) expect(() => checkCleanupStatus(bad, owner, request)).toThrow();
  });
});
