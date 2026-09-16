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
    const keys = [...projection.matchAll(/'([a-z_][a-z0-9_]*)',(?:im\.[a-z_][a-z0-9_]*|timezone\('UTC',im\.(?:created_at|retired_at)\))/g)]
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
    const memberKeys = /'([a-z_][a-z0-9_]*)',(?:member\.[a-z_][a-z0-9_]*|timezone\('UTC',member\.created_at\))/g;
    const catalogStart = 'objects := objects || jsonb_build_array(jsonb_build_object(';
    const start = evidence.indexOf(catalogStart);
    const end = evidence.indexOf("if kind='orphan' then", start);
    expect(start).toBeGreaterThan(-1);
    expect(evidence.split(catalogStart)).toHaveLength(2);
    expect(end).toBeGreaterThan(start);
    const catalog = evidence.slice(start, end);
    expect([...evidence.matchAll(memberKeys)].map((match) => match[1]))
      .toEqual(['id', 'name', 'version', 'created_at', 'orphan']);
    expect([...catalog.matchAll(memberKeys)].map((match) => match[1]))
      .toEqual(['id', 'name', 'version', 'created_at']);
    const orphanAgeCall = "private.image_cleanup_old_enough('orphan',member.created_at,p_now)";
    expect(catalog).not.toContain(orphanAgeCall);
    expect(evidence.slice(end)).toContain(orphanAgeCall);
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
    expect(call).toBeLessThan(rehearsal.indexOf('const expected = [empty, adoptable, pending, retired'));
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

  it('preflights and reuses the real profile-lock fixture before tracking or control', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const start = rehearsal.indexOf('await withCleanupOwners(async ([owner, peer]) => {');
    const end = rehearsal.indexOf('  }, env);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callback = rehearsal.slice(start, end);
    expect(callback).toContain([
      'await withCleanupOwners(async ([owner, peer]) => {',
      '    const itemId = `b229${randomUUID().slice(4)}`;',
      '    const imageId = `b229${randomUUID().slice(4)}`;',
      '    const empty = newCleanupFixture(owner.uid, { itemId, imageId });',
      "    requireCleanup(empty !== null && typeof empty === 'object'",
      '      && empty.ownerId === owner.uid && empty.itemId === itemId && empty.imageId === imageId',
      '      && empty.main === `${owner.uid}/${itemId}/${imageId}/main.jpg`',
      "      && empty.thumb === `${owner.uid}/${itemId}/${imageId}/thumb.jpg`, 'profile-lock-fixture-contract');",
      '    const fixtures = [{ actor: owner, value: empty }];',
    ].join('\n'));
    expect(callback.match(/const empty =/g)).toHaveLength(1);
    expect(callback.match(/newCleanupFixture\(owner\.uid, \{ itemId, imageId \}\)/g)).toHaveLength(1);
    expect(callback).not.toContain('const empty = track(');
    const admitted = callback.indexOf('const fixtures = [{ actor: owner, value: empty }];');
    for (const boundary of ['const track =', 'try {', 'await ageBoundaries(', 'await control(']) {
      expect(callback.indexOf(boundary)).toBeGreaterThan(admitted);
    }
    expect(callback).toContain('[owner, empty, { upload: false }]');
    expect(callback).toContain('await createCleanupFixture(actor, value, options);');
    expect(callback).toContain("await ageFixture(empty, 'pending', deadline);");
    expect(callback).toContain('await housekeeping(owner, ready, empty, deadline);');
    expect(rehearsal).toContain("await withAnalyzedSaveFixtureLock(owner.uid, pending.itemId, pending.imageId, 'profile', async () => {");
    expect(callback).toContain('Array.from({ length: 21 }, () => track(owner, { itemId: empty.itemId }))');
    expect(callback).toContain('candidates.length === expected.length && expected.every');
    expect(callback).toContain('claimPage.claims.length === 20');
    expect(callback).toContain('claimTail.claims.length === 1 && claimTail.next === null');
    expect(callback).toContain('const lateA = track(owner, { itemId: `1080${randomUUID().slice(4)}` });');
    expect(callback).toContain('const lateB = track(peer, { itemId: `1080${randomUUID().slice(4)}` });');
    expect(callback).toContain('[[owner, lateA], [peer, lateB]]');
    expect(callback).toContain('for (const { actor, value } of [...fixtures].reverse())');
    expect(callback).toContain('await destroyCleanupFixture(actor, value);');
    expect(rehearsal).toContain('const TOTAL_MS = 480_000;');
    expect(rehearsal).toContain('const TEARDOWN_MS = 120_000;');
  });
});

describe('I10a failure-only rehearsal diagnostic source contract', () => {
  const checks = [
    'adoption-claim-precondition', 'adoption-owned-pending', 'incomplete-upload-refusal',
    'forget-owned-pending', 'claim-guard-delete-refusal', 'forget-pending-preserved',
    'claim-guard-adoption-refusal', 'adoption-pending-preserved', 'adoption-claim-preserved',
    'used-id-adoption-refusal', 'claimed-manual-finalize-refusal', 'claimed-analyzed-preflight-refusal',
    'direct-image-owned-pending', 'direct-image-update-refusal', 'direct-image-delete-refusal',
    'direct-image-preserved', 'unrelated-field-edit',
    'fixture-field-restore', 'trash-during-cleanup', 'item-begin-during-cleanup',
  ];
  const phases = [
    'age-boundaries', 'fixture-allocation', 'base-fixtures', 'orphan-setup', 'historical-orphans',
    'registered-setup', 'retention', 'timezone', 'mixed-age', 'disabled-owner', 'housekeeping',
    'pagination-setup', 'preview-baseline', 'orphan-claim', 'registered-claims', 'claim-pagination',
    'preservation-checks', 'mixed-unsupported', 'late-owner', 'late-peer', 'item-claim',
    'insertion-metadata', 'insertion-cleanup', 'insertion-concurrent', 'final-summary',
  ];

  it('assigns only fixed phases at existing callback boundaries and preserves the tuple loops', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const start = rehearsal.indexOf('await withCleanupOwners(async ([owner, peer]) => {');
    const end = rehearsal.indexOf('  }, env);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callback = rehearsal.slice(start, end);
    expect(callback).toContain("let phase = 'age-boundaries';");
    expect(callback.match(/\bphase = 'age-boundaries';/g)).toHaveLength(1);
    expect(callback).toContain('let primaryPhase = null;');
    expect(callback.indexOf("let phase = 'age-boundaries';")).toBeGreaterThan(
      callback.indexOf('const fixtures = [{ actor: owner, value: empty }];'));
    expect(callback).toContain('try {\n      await ageBoundaries(deadline);');
    const assignments = [...callback.matchAll(/\bphase = ([\s\S]*?);/g)].map((match) => match[1]);
    expect(assignments).toEqual([
      ...phases.slice(0, 18).map((phase) => `'${phase}'`),
      "actor === owner ? 'late-owner' : 'late-peer'",
      "'item-claim'",
      "first === 'metadata' ? 'insertion-metadata'\n          : first === 'cleanup' ? 'insertion-cleanup' : 'insertion-concurrent'",
      "'final-summary'",
    ]);
    const boundaries = [
      ['fixture-allocation', 'const ready = track(owner);'],
      ['base-fixtures', 'for (const [actor, value, options] of ['],
      ['orphan-setup', 'for (const value of [orphan, unmarked, mixed]) {'],
      ['historical-orphans', 'for (const value of [historicalA, historicalB]) {'],
      ['registered-setup', '// A currently registered third prefix must not hide either distinct historical orphan.'],
      ['retention', 'await seedRetention(pending, retired, deadline);'],
      ['timezone', 'await timezoneDeterminism(pending, retired, deadline);'],
      ['mixed-age', "await control(`update storage.objects set created_at=clock_timestamp()-interval '1 day'"],
      ['disabled-owner', 'await disabledOwner(peer, deadline);'],
      ['housekeeping', 'await housekeeping(owner, ready, empty, deadline);'],
      ['pagination-setup', 'for (const value of pagination) {'],
      ['preview-baseline', 'const expected = [empty, adoptable, pending, retired, orphan, unmarked, historicalA, historicalB, ...pagination];'],
      ['orphan-claim', 'const oldPreview = await candidateFor(owner, orphan);'],
      ['registered-claims', 'for (const value of [empty, adoptable, pending, retired, unmarked, historicalA, historicalB]) {'],
      ['claim-pagination', 'for (const value of pagination) await beginFixture(owner, value);'],
      ['preservation-checks', "const readyAfter = await owner.client.from('items').select('*').eq('id', ready.itemId).single();"],
      ['mixed-unsupported', "const mixedBefore = await owner.client.storage.from('wardrobe').remove([mixed.main, mixed.thumb]);"],
      ['item-claim', 'await reverseItemClaim(owner, itemFirst, deadline);'],
      ['final-summary', 'budget(deadline);'],
    ];
    for (const [phase, boundary] of boundaries) {
      expect(callback).toContain(`phase = '${phase}';\n      ${boundary}`);
    }
    expect(callback).toContain([
      'for (const [actor, value] of [[owner, lateA], [peer, lateB]]) {',
      "        phase = actor === owner ? 'late-owner' : 'late-peer';",
      '        budget(deadline);',
      '        await latePublication(actor, value, deadline);',
    ].join('\n'));
    expect(callback).toContain([
      "for (const [value, first] of [[insertFirst, 'metadata'], [cleanupFirst, 'cleanup'], [concurrentInsert, 'concurrent']]) {",
      "        phase = first === 'metadata' ? 'insertion-metadata'",
      "          : first === 'cleanup' ? 'insertion-cleanup' : 'insertion-concurrent';",
      '        historical.push(value);',
      '        budget(deadline);',
      '        await orphanInsertionOrder(owner, value, first, deadline);',
    ].join('\n'));
    expect(callback.match(/const [a-zA-Z]+ = track\(/g)).toHaveLength(17);
    expect(callback).toContain('const fixtures = [{ actor: owner, value: empty }];');
    expect(callback).toContain('Array.from({ length: 21 }, () => track(owner, { itemId: empty.itemId }))');
  });

  it('qualifies rebound success and separates incomplete, claimed and used-ID adoption refusals', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const start = rehearsal.indexOf('await withCleanupOwners(async ([owner, peer]) => {');
    const end = rehearsal.indexOf('  }, env);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callback = rehearsal.slice(start, end);
    expect(callback).toContain('[owner, ready, { ready: true }], [owner, retired, { newItem: false }]');
    expect(callback).toContain('const retired = track(owner, { itemId: ready.itemId });');
    expect(callback).toContain('const rebound = track(owner, { imageId: historicalA.imageId });');
    expect(callback).toContain('const adoptable = track(owner);');
    expect(callback.match(/const adoptable = track\(owner\);/g)).toHaveLength(1);
    expect(callback).toContain('[owner, adoptable, {}]');
    expect(callback).toContain("await ageFixture(adoptable, 'pending', deadline);");
    expect(callback).toContain('await seedRetention(pending, retired, deadline);');
    expect(callback).not.toMatch(/seedRetention\([^;]*adoptable/);
    const positiveStart = callback.indexOf("phase = 'registered-setup';");
    const positiveEnd = callback.indexOf("await ageFixture(empty, 'pending', deadline);", positiveStart);
    expect(positiveStart).toBeGreaterThan(-1);
    expect(positiveEnd).toBeGreaterThan(positiveStart);
    const positive = callback.slice(positiveStart, positiveEnd);
    expect(positive).toContain('await createCleanupFixture(owner, rebound, {});');
    expect(positive).not.toContain('createCleanupFixture(owner, rebound, { ready: true })');
    expect(positive).toContain('[ready, historicalA, historicalB, adoptable].every((value) => value.itemId !== rebound.itemId)');
    expect(positive).toContain('rebound.imageId === historicalA.imageId && rebound.imageId === historicalB.imageId');
    for (const [variable, state] of [['reboundBefore', 'pending'], ['reboundAfter', 'ready']]) {
      expect(positive).toContain(`!${variable}.error && ${variable}.data`);
      expect(positive).toContain(`${variable}.data.id === rebound.imageId && ${variable}.data.owner_id === owner.uid`);
      expect(positive).toContain(`${variable}.data.item_id === rebound.itemId && ${variable}.data.state === '${state}'`);
      for (const role of ['main', 'thumb']) {
        expect(positive).toContain(`${variable}.data.${role}_path === \`\${owner.uid}/\${rebound.itemId}/\${rebound.imageId}/${role}.jpg\``);
      }
    }
    expect(positive.match(/\.eq\('owner_id', owner\.uid\)\.eq\('item_id', rebound\.itemId\)\.eq\('id', rebound\.imageId\)\.single\(\)/g)).toHaveLength(2);
    expect(positive).toContain('private.item_save_used_ids where owner_id=${identity(owner.uid)}\n      and (item_id=${identity(rebound.itemId)} or image_id=${identity(rebound.imageId)})');
    expect(positive).toContain("private.image_cleanup_claims where owner_id=${identity(owner.uid)}\n      and item_id=${identity(rebound.itemId)} and image_id=${identity(rebound.imageId)} and state='active'");
    expect(positive).toContain('private.item_deletion_claims where owner_id=${identity(owner.uid)}\n      and item_id=${identity(rebound.itemId)}');
    expect(positive).toContain("const promoted = await owner.client.rpc('commit_image', { p_image_id: rebound.imageId });");
    expect(positive.match(/\.rpc\('commit_image'/g)).toHaveLength(1);
    expect(positive).toContain("requireCleanup(promoted.error === null || promoted.error === undefined, 'rebound-public-adoption');");
    expect(positive.indexOf("'rebound-pending-identity'")).toBeLessThan(positive.indexOf('await control('));
    expect(positive.indexOf('await control(')).toBeLessThan(positive.indexOf('const promoted'));
    expect(positive.indexOf("'rebound-public-adoption'")).toBeLessThan(positive.indexOf('const reboundAfter'));
    const claimsStart = callback.indexOf("phase = 'registered-claims';");
    const claimsEnd = callback.indexOf("phase = 'claim-pagination';", claimsStart);
    expect(claimsStart).toBeGreaterThan(positiveEnd);
    expect(claimsEnd).toBeGreaterThan(claimsStart);
    const claims = callback.slice(claimsStart, claimsEnd);
    expect(claims).toContain('if (value === empty || value === adoptable)');
    expect(claims).toContain("claimed.state === 'active' && claimed.kind === 'pending'");
    expect(claims).toContain("afterClaim.state === 'active' && afterClaim.kind === 'pending'");
    expect(claims).toContain('afterClaim.item_id === value.itemId && afterClaim.image_id === value.imageId');
    for (const variable of ['claimed', 'afterClaim']) {
      expect(claims).toContain(`${variable}.paths.length === 2 && ${variable}.paths.every((path, index) =>`);
    }
    expect(claims.match(/path\.role === \['main', 'thumb'\]\[index\]/g)).toHaveLength(2);
    expect(claims.match(/path\.present === \(value === adoptable\)/g)).toHaveLength(2);
    expect(claims.match(/path\.path === `\$\{owner\.uid\}\/\$\{value\.itemId\}\/\$\{value\.imageId\}\/\$\{path\.role\}\.jpg`/g)).toHaveLength(2);
    expect(claims).toContain('private.item_save_used_ids where owner_id=${identity(owner.uid)}\n    and (item_id=${identity(value.itemId)} or image_id=${identity(value.imageId)})');
    const adoptionOpen = 'await control(`do $adoption$';
    const adoptionClose = '$adoption$;`, deadline);';
    const adoptionStart = claims.indexOf(adoptionOpen);
    const adoptionEnd = claims.indexOf(adoptionClose, adoptionStart);
    expect(adoptionStart).toBeGreaterThan(-1);
    expect(adoptionEnd).toBeGreaterThan(adoptionStart);
    expect(claims.split(adoptionOpen)).toHaveLength(2);
    expect(claims.split(adoptionClose)).toHaveLength(2);
    const adoptionControl = claims.slice(adoptionStart, adoptionEnd + adoptionClose.length);
    expect(adoptionControl).toContain('from private.item_save_used_ids where owner_id=${identity(owner.uid)}\n    and (item_id=${identity(value.itemId)} or image_id=${identity(value.imageId)})');
    expect(adoptionControl).not.toMatch(/from private\.(?:image_cleanup_claims|item_deletion_claims|image_cleanup_delete_context)/);
    expect(claims).toContain("raise exception 'I10A_NEGATIVE_ADOPTION_PRECONDITION'");
    for (const variable of ['before', 'after']) {
      expect(claims).toContain(`!${variable}.error && ${variable}.data && ${variable}.data.id === value.imageId`);
      expect(claims).toContain(`${variable}.data.owner_id === owner.uid && ${variable}.data.item_id === value.itemId`);
      expect(claims).toContain(`${variable}.data.state === 'pending'`);
    }
    expect(claims).toContain("'adoption-owned-pending');\n          const adoption = await owner.client.rpc('commit_image', { p_image_id: value.imageId });");
    const emptyOpen = 'if (value === empty) {';
    const adoptableOpen = "          } else {\n            requireRegistered(adoption.error?.code === '22023', 'claim-guard-adoption-refusal');";
    const emptyStart = claims.indexOf(emptyOpen);
    const adoptableStart = claims.indexOf(adoptableOpen, emptyStart);
    const afterClaimStart = claims.indexOf('          const afterClaim =', adoptableStart);
    expect(emptyStart).toBeGreaterThan(adoptionEnd);
    expect(adoptableStart).toBeGreaterThan(emptyStart);
    expect(afterClaimStart).toBeGreaterThan(adoptableStart);
    expect(claims.split(emptyOpen)).toHaveLength(2);
    expect(claims.split(adoptableOpen)).toHaveLength(2);
    const emptyArm = claims.slice(emptyStart + emptyOpen.length, adoptableStart);
    const adoptableArm = claims.slice(adoptableStart, afterClaimStart);
    expect(emptyArm).toMatch(/^\n {12}requireRegistered\(adoption\.error\?\.code === 'P0001', 'incomplete-upload-refusal'\);/);
    expect(emptyArm).toContain("owner.client.rpc('forget_image', {");
    expect(emptyArm.match(/\.rpc\('forget_image'/g)).toHaveLength(1);
    expect(claims.match(/\.rpc\('forget_image'/g)).toHaveLength(1);
    expect(emptyArm).not.toMatch(/\b(?:if|for|while|switch|catch)\s*\(|\belse\b/);
    expect(adoptableArm).toContain("'adoption-pending-preserved');");
    expect(adoptableArm).not.toContain('forget_image');
    expect(afterClaimStart).toBeLessThan(claims.indexOf('await resumeCleanupFixture(owner, value);'));
    expect(claims).toContain("} else if (value === pending || value === retired) {\n          requireRegistered((await owner.client.rpc('commit_image', { p_image_id: value.imageId })).error?.code === '22023', 'used-id-adoption-refusal');");
    expect(claims).not.toContain('claimed-adoption-refusal');
    expect(claims).toContain("const afterClaim = checkCleanupStatus(await cleanupRpc(owner, 'image_cleanup_status', {");
    expect(claims.indexOf("'adoption-claim-preserved'")).toBeLessThan(claims.indexOf('await resumeCleanupFixture(owner, value);'));
    expect(claims).toContain('if (value === pending) {');
    expect(claims).toContain('if (value === retired) {');
    expect(claims).toContain('if (value === pending || value === retired) await checkRetention(value, value === retired, deadline);');
    expect(claims).toContain('await resumeCleanupFixture(owner, value);\n        await requireAbsentBytes(owner, value);');
    expect(claims).not.toMatch(/if \(value === adoptable\).*checkRetention/);
  });

  it('qualifies the empty public delete and brackets direct privilege refusals with combined preservation', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const claimsStart = rehearsal.indexOf("      phase = 'registered-claims';");
    const claimsEnd = rehearsal.indexOf("      phase = 'claim-pagination';", claimsStart);
    expect(claimsStart).toBeGreaterThan(-1);
    expect(claimsEnd).toBeGreaterThan(claimsStart);
    const claims = rehearsal.slice(claimsStart, claimsEnd);
    const emptyStart = claims.indexOf('          if (value === empty) {');
    const emptyEnd = claims.indexOf("          } else {\n            requireRegistered(adoption.error?.code === '22023'", emptyStart);
    expect(emptyStart).toBeGreaterThan(-1);
    expect(emptyEnd).toBeGreaterThan(emptyStart);
    const empty = claims.slice(emptyStart, emptyEnd);
    const forgetOpen = 'await control(`do $forget$';
    const forgetClose = '$forget$;`, deadline);';
    const forgetStart = empty.indexOf(forgetOpen);
    const forgetEnd = empty.indexOf(forgetClose, forgetStart);
    expect(forgetStart).toBeGreaterThan(empty.indexOf("'incomplete-upload-refusal'"));
    expect(forgetEnd).toBeGreaterThan(forgetStart);
    expect(claims.split(forgetOpen)).toHaveLength(2);
    expect(claims.split(forgetClose)).toHaveLength(2);
    const forgetControl = empty.slice(forgetStart, forgetEnd + forgetClose.length);
    expect(forgetControl).toBe([
      'await control(`do $forget$',
      'begin',
      '  if exists(select 1 from storage.objects where ${storageTarget(value)})',
      '    or exists(select 1 from private.item_deletion_claims where owner_id=${identity(owner.uid)}',
      '      and item_id=${identity(value.itemId)})',
      '    or exists(select 1 from private.image_cleanup_delete_context where owner_id=${identity(owner.uid)}',
      '      and item_id=${identity(value.itemId)} and image_id=${identity(value.imageId)}) then',
      "    raise exception 'I10A_FORGET_PRECONDITION';",
      '  end if;',
      'end;',
      '$forget$;`, deadline);',
    ].join('\n'));
    expect(forgetControl).not.toMatch(/private\.image_cleanup_claims|\b(?:insert|update|delete)\b/i);
    expect(empty).toContain('value.main === `${owner.uid}/${value.itemId}/${value.imageId}/main.jpg`');
    expect(empty).toContain('value.thumb === `${owner.uid}/${value.itemId}/${value.imageId}/thumb.jpg`');
    expect(empty).toContain('forgetBefore.data.main_path === value.main && forgetBefore.data.thumb_path === value.thumb');
    const forgetCall = [
      "requireRegistered((await owner.client.rpc('forget_image', {",
      '              p_image_id: value.imageId,',
      "            })).error?.code === '22023', 'claim-guard-delete-refusal');",
    ].join('\n');
    expect(empty).toContain(forgetCall);
    expect(claims.match(/\.rpc\('forget_image'/g)).toHaveLength(1);
    expect(empty.indexOf('const forgetBefore =')).toBeGreaterThan(forgetEnd + forgetClose.length);
    expect(empty.indexOf("'forget-owned-pending'")).toBeGreaterThan(empty.indexOf('const forgetBefore ='));
    expect(empty.indexOf(forgetCall)).toBeGreaterThan(empty.indexOf("'forget-owned-pending'"));
    expect(empty.indexOf('const forgetAfter =')).toBeGreaterThan(empty.indexOf(forgetCall));
    expect(empty.indexOf("'forget-pending-preserved'")).toBeGreaterThan(empty.indexOf('const forgetAfter ='));
    expect(claims.indexOf('const afterClaim =')).toBeGreaterThan(emptyEnd);
    expect(claims).toContain("path.present === (value === adoptable)), 'adoption-claim-preserved');");
    expect(claims.indexOf('await resumeCleanupFixture(owner, value);')).toBeGreaterThan(claims.indexOf("'adoption-claim-preserved'"));

    const pendingStart = claims.indexOf('        if (value === pending) {');
    const pendingEnd = claims.indexOf('        if (value === retired) {', pendingStart);
    expect(pendingStart).toBeGreaterThan(emptyEnd);
    expect(pendingEnd).toBeGreaterThan(pendingStart);
    const pending = claims.slice(pendingStart, pendingEnd);
    const directCalls = [
      "requireRegistered((await owner.client.from('item_images').update({ alt_text: 'Refused fixture edit' })",
      "            .eq('id', value.imageId).eq('owner_id', owner.uid)).error?.code === '42501', 'direct-image-update-refusal');",
      "          requireRegistered((await owner.client.from('item_images').delete()",
      "            .eq('id', value.imageId).eq('owner_id', owner.uid)).error?.code === '42501', 'direct-image-delete-refusal');",
    ].join('\n');
    expect(pending).toContain(directCalls);
    expect(pending.indexOf('const directBefore =')).toBeGreaterThan(pending.indexOf("'claimed-analyzed-preflight-refusal'"));
    expect(pending.indexOf("'direct-image-owned-pending'")).toBeGreaterThan(pending.indexOf('const directBefore ='));
    expect(pending.indexOf(directCalls)).toBeGreaterThan(pending.indexOf("'direct-image-owned-pending'"));
    expect(pending.indexOf('const directAfter =')).toBeGreaterThan(pending.indexOf(directCalls));
    expect(pending.indexOf("'direct-image-preserved'")).toBeGreaterThan(pending.indexOf('const directAfter ='));
    expect(pending).not.toMatch(/claimed-image-(?:edit|delete)-refusal|update_image_description|forget_image/);
    for (const role of ['main', 'thumb']) {
      expect(pending).toContain(`directBefore.data.${role}_path === \`\${owner.uid}/\${value.itemId}/\${value.imageId}/${role}.jpg\``);
    }
    for (const [region, prefix, indent] of [[empty, 'forget', '              '], [pending, 'direct', '            ']]) {
      for (const suffix of ['Before', 'After']) {
        const variable = `${prefix}${suffix}`;
        expect(region).toContain([
          `const ${variable} = await owner.client.from('item_images')`,
          `${indent}.select('id,owner_id,item_id,state,main_path,thumb_path,alt_text,description_version')`,
          `${indent}.eq('owner_id', owner.uid).eq('item_id', value.itemId).eq('id', value.imageId).single();`,
        ].join('\n'));
        expect(region).toContain(`!${variable}.error && ${variable}.data`);
        expect(region).toContain(`${variable}.data.id === value.imageId && ${variable}.data.owner_id === owner.uid`);
        expect(region).toContain(`${variable}.data.item_id === value.itemId && ${variable}.data.state === 'pending'`);
      }
      for (const field of ['main_path', 'thumb_path', 'alt_text', 'description_version']) {
        expect(region).toContain(`${prefix}After.data.${field} === ${prefix}Before.data.${field}`);
      }
      expect(region).not.toMatch(/console\.|JSON\.stringify/);
    }
  });

  it('retains primary values and all teardown attempts with one closed nine-key failure record', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const start = rehearsal.indexOf('await withCleanupOwners(async ([owner, peer]) => {');
    const end = rehearsal.indexOf('  }, env);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callback = rehearsal.slice(start, end);
    const catchStart = callback.indexOf('    } catch (error) {');
    const finallyStart = callback.indexOf('    } finally {', catchStart);
    const diagnosticStart = callback.indexOf('    if (failed || teardownFailed) {', finallyStart);
    const branchesStart = callback.indexOf('    if (failed && teardownFailed)', diagnosticStart);
    expect(catchStart).toBeGreaterThan(-1);
    expect(finallyStart).toBeGreaterThan(catchStart);
    expect(diagnosticStart).toBeGreaterThan(finallyStart);
    expect(branchesStart).toBeGreaterThan(diagnosticStart);
    expect(callback.slice(catchStart, finallyStart)).toBe([
      '    } catch (error) {',
      '      primaryPhase = phase;',
      "      primaryCheck = phase === 'registered-claims' ? registeredCheck : null;",
      "      primaryClaimOrdinal = phase === 'registered-claims' ? claimOrdinal : null;",
      '      primary = error;',
      '      failed = true;',
      '',
    ].join('\n'));
    for (const declaration of [
      'let primaryPhase = null;', 'let firstFixtureSlot = null;', 'let fixtureDestroyFailures = 0;',
      'let markerRestoreFailed = false;', 'let fixtureDestroyFailed = false;', 'let absenceCheckFailed = false;',
      'let registeredCheck = null;', 'let claimOrdinal = null;',
      'let primaryCheck = null;', 'let primaryClaimOrdinal = null;',
    ]) expect(callback).toContain(declaration);
    const teardown = callback.slice(finallyStart, diagnosticStart);
    expect(teardown.match(/\bcatch\b/g)).toHaveLength(3);
    expect(teardown.match(/teardownFailed = true;/g)).toHaveLength(3);
    expect(teardown).toContain('teardownFailed = true;\n          markerRestoreFailed = true;');
    expect(teardown).toContain([
      'let fixtureSlot = fixtures.length;',
      '      for (const { actor, value } of [...fixtures].reverse()) {',
      '        fixtureSlot -= 1;',
      '        try {',
      '          budget(deadline, true);',
      '          await destroyCleanupFixture(actor, value);',
      '        } catch {',
      '          teardownFailed = true;',
      '          fixtureDestroyFailed = true;',
      '          fixtureDestroyFailures += 1;',
      '          if (firstFixtureSlot === null) firstFixtureSlot = fixtureSlot;',
      '        }',
    ].join('\n'));
    expect(teardown.match(/fixtureSlot -= 1;/g)).toHaveLength(1);
    expect(teardown.match(/fixtureDestroyFailures \+= 1;/g)).toHaveLength(1);
    expect(teardown.match(/firstFixtureSlot = fixtureSlot;/g)).toHaveLength(1);
    expect(teardown).toContain('teardownFailed = true;\n        absenceCheckFailed = true;');
    expect(teardown).toContain('for (const value of historical) {');
    expect(teardown).toContain('if (fixtures.length) await control(`do $teardown$');
    expect(teardown).not.toMatch(/\bcontinue\b|\bbreak\b/);
    const diagnostic = callback.slice(diagnosticStart, branchesStart);
    expect(diagnostic).toBe([
      '    if (failed || teardownFailed) {',
      '      console.error(`I10A-CLEANUP-FAILURE ${JSON.stringify({',
      '        schemaVersion: 2,',
      '        primaryPhase: primaryPhase ?? null,',
      '        markerRestoreFailed,',
      '        fixtureDestroyFailed,',
      '        fixtureDestroyFailures,',
      '        firstFixtureSlot: firstFixtureSlot ?? null,',
      '        absenceCheckFailed,',
      '        primaryCheck: primaryCheck ?? null,',
      '        primaryClaimOrdinal: primaryClaimOrdinal ?? null,',
      '      })}`);',
      '    }',
      '',
    ].join('\n'));
    expect(callback.match(/I10A-CLEANUP-FAILURE/g)).toHaveLength(1);
    expect(callback.match(/console\.error\(/g)).toHaveLength(1);
    expect(diagnostic.replace('console.error(', '')).not.toMatch(/\b(?:error|primary)\b|\.message|\.stack|\.cause|\.name|\bprocess\b|\bowner\b|\bpeer\b|\bvalue\b/);
    expect(diagnostic).not.toContain('|| null');
    expect(callback.slice(branchesStart)).toContain([
      "    if (failed && teardownFailed) fail('FAIL: image cleanup rehearsal primary and fixture teardown.', 1);",
      "    if (teardownFailed) fail('FAIL: image cleanup rehearsal fixture teardown.', 1);",
      '    if (failed) throw primary;',
      '    console.log(`PASS: image cleanup fixture teardown; ${retainedClaims} minimal completed claims and generated used identities retained by production lifetime.`);',
    ].join('\n'));
    expect(checks).toHaveLength(20);
    expect((phases.length + 1) * (checks.length + 1) * 3 * 3 * 2).toBe(9828);
    for (const primaryPhase of [null, ...phases]) {
      for (const primaryCheck of [null, ...checks]) {
        for (const primaryClaimOrdinal of [null, 0, 6]) {
          for (const firstFixtureSlot of [null, 0, 38]) {
            for (const fixtureDestroyFailures of [0, 39]) {
              const record = {
                schemaVersion: 2, primaryPhase,
                markerRestoreFailed: false, fixtureDestroyFailed: false, fixtureDestroyFailures,
                firstFixtureSlot, absenceCheckFailed: false, primaryCheck, primaryClaimOrdinal,
              };
              expect(Object.keys(record)).toEqual([
                'schemaVersion', 'primaryPhase', 'markerRestoreFailed', 'fixtureDestroyFailed',
                'fixtureDestroyFailures', 'firstFixtureSlot', 'absenceCheckFailed',
                'primaryCheck', 'primaryClaimOrdinal',
              ]);
              expect(record.firstFixtureSlot ?? null).toBe(firstFixtureSlot);
              expect(record.primaryClaimOrdinal ?? null).toBe(primaryClaimOrdinal);
              expect(Buffer.byteLength(`I10A-CLEANUP-FAILURE ${JSON.stringify(record)}\n`, 'utf8')).toBeLessThan(512);
            }
          }
        }
      }
    }
  });

  it('records only registered literal checks and a separate seven-case claim ordinal', () => {
    const rehearsal = source('scripts/image-cleanup-rehearsal.mjs');
    const start = rehearsal.indexOf('await withCleanupOwners(async ([owner, peer]) => {');
    const end = rehearsal.indexOf('  }, env);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callback = rehearsal.slice(start, end);
    expect(callback).toContain([
      'const requireRegistered = (condition, label) => {',
      '      if (!condition) registeredCheck = label;',
      '      requireCleanup(condition, label);',
      '    };',
    ].join('\n'));
    const claimsStart = callback.indexOf("phase = 'registered-claims';");
    const claimsEnd = callback.indexOf("phase = 'claim-pagination';", claimsStart);
    expect(claimsStart).toBeGreaterThan(-1);
    expect(claimsEnd).toBeGreaterThan(claimsStart);
    const claims = callback.slice(claimsStart, claimsEnd);
    expect(claims).toContain([
      'for (const value of [empty, adoptable, pending, retired, unmarked, historicalA, historicalB]) {',
      '        claimOrdinal = claimOrdinal === null ? 0 : claimOrdinal + 1;',
      '        budget(deadline);',
      '        const claimed = await beginFixture(owner, value);',
    ].join('\n'));
    expect(callback.match(/claimOrdinal = claimOrdinal === null \? 0 : claimOrdinal \+ 1;/g)).toHaveLength(1);
    expect(callback.slice(0, claimsStart)).not.toContain('requireRegistered(');
    expect(callback.slice(claimsEnd)).not.toContain('requireRegistered(');
    expect(claims).not.toContain('requireCleanup(');
    const labels = [...claims.matchAll(/requireRegistered\([\s\S]*?, '([a-z-]+)'\);/g)].map((match) => match[1]);
    expect(labels).toEqual(checks);
    expect(claims.match(/requireRegistered\(/g)).toHaveLength(checks.length);
    for (const label of checks) {
      expect(label).toMatch(/^[a-z-]+$/);
      expect(label.length).toBeLessThanOrEqual(64);
    }
    const recorderStart = callback.indexOf('const requireRegistered =');
    const recorderEnd = callback.indexOf('    let retainedClaims', recorderStart);
    expect(recorderEnd).toBeGreaterThan(recorderStart);
    expect(callback.slice(recorderStart, recorderEnd)).not.toMatch(/\berror\b|\.message|\.code|\.stack|\.cause|\.name|JSON|console|\bcatch\b/);
    expect(claims).not.toContain('fixtureSlot');
  });
});

describe('I10a public fixture contract', () => {
  it.skipIf(process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true')(
    'retains both requested profile-lock identities and their canonical paths',
    async () => {
      // @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
      const { newCleanupFixture } = await import('../integration/image-cleanup.sessions.mjs');
      const ownerId = '10000000-0000-4000-8000-000000000001';
      const itemId = 'b2290000-0000-4000-8000-000000000002';
      const imageId = 'b2290000-0000-4000-8000-000000000003';
      const value = newCleanupFixture(ownerId, { itemId, imageId });
      expect(value !== null && typeof value === 'object').toBe(true);
      expect(value.ownerId === ownerId).toBe(true);
      expect(value.itemId === itemId).toBe(true);
      expect(value.imageId === imageId).toBe(true);
      expect(value.main === `${ownerId}/${itemId}/${imageId}/main.jpg`).toBe(true);
      expect(value.thumb === `${ownerId}/${itemId}/${imageId}/thumb.jpg`).toBe(true);
    },
  );
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

describe('I10a Linux runner lifetime characterization', () => {
  it.skipIf(process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux')(
    'characterizes direct timeout and inherited-pipe late settlement without claiming browser quiescence',
    { timeout: 10000, retry: 0 },
    async () => {
      const { runCommand } = await import('../../scripts/backend/local.mjs');
      const { isAbsolute } = await import('node:path');
      expect(isAbsolute(process.execPath), 'runner-absolute-node').toBe(true);

      function emit(kind: 'direct' | 'inherited', elapsedMs: number) {
        expect(Number.isInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 9999, 'runner-record-domain').toBe(true);
        const line = `I10A-RUNNER-LIFETIME ${JSON.stringify({
          schemaVersion: 1,
          platform: 'linux',
          case: kind,
          requestedTimeoutMs: kind === 'direct' ? 2000 : 1000,
          elapsedMs,
          resultCode: 2,
          readySeen: true,
          endSeen: kind === 'inherited',
        })}`;
        expect(Buffer.byteLength(`${line}\n`, 'utf8') < 512, 'runner-record-bound').toBe(true);
        console.log(line);
      }

      const directSource = `
const { writeSync } = require('node:fs');
writeSync(1, 'DIRECT_READY\\n');
setTimeout(() => process.exit(0), 8000);
`;
      const directStarted = performance.now();
      let direct;
      try {
        direct = await runCommand(process.execPath, ['-e', directSource], {
          env: {}, timeout: 2000, maxOutputBytes: 1024,
        });
      } catch {
        throw new Error('runner-direct-integrity');
      }
      const directElapsed = Math.ceil(performance.now() - directStarted);
      expect(direct.stdout === 'DIRECT_READY\n' && direct.stderr === '', 'runner-direct-integrity').toBe(true);
      expect(direct.code === 2 && Number.isInteger(directElapsed)
        && directElapsed >= 2000 && directElapsed < 8000, 'runner-direct-characterization').toBe(true);
      emit('direct', directElapsed);

      const leafSource = `
const { writeSync } = require('node:fs');
writeSync(1, 'LEAF_READY\\n');
setTimeout(() => {
  writeSync(1, 'LEAF_END\\n');
  process.exit(0);
}, 2500);
`;
      const inheritedSource = `
const { writeSync } = require('node:fs');
const { spawn } = require('node:child_process');
const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(leafSource)}], {
  env: {}, stdio: ['ignore', 'inherit', 'inherit'], shell: false, windowsHide: true,
});
leaf.once('error', () => {
  writeSync(1, 'LEAF_SPAWN_FAILED\\n');
  process.exit(1);
});
leaf.once('spawn', () => {
  writeSync(1, 'DIRECT_EXIT\\n');
  process.exit(0);
});
`;
      const inheritedStarted = performance.now();
      let inherited;
      try {
        inherited = await runCommand(process.execPath, ['-e', inheritedSource], {
          env: {}, timeout: 1000, maxOutputBytes: 1024,
        });
      } catch {
        throw new Error('runner-inherited-integrity');
      }
      const inheritedElapsed = Math.ceil(performance.now() - inheritedStarted);
      const inheritedLines = inherited.stdout === 'DIRECT_EXIT\nLEAF_READY\nLEAF_END\n'
        || inherited.stdout === 'LEAF_READY\nDIRECT_EXIT\nLEAF_END\n';
      expect(inheritedLines && inherited.stderr === '', 'runner-inherited-integrity').toBe(true);
      expect(inherited.code === 2 && Number.isInteger(inheritedElapsed)
        && inheritedElapsed >= 2000 && inheritedElapsed < 10000, 'runner-inherited-characterization').toBe(true);
      emit('inherited', inheritedElapsed);
    },
  );
});
