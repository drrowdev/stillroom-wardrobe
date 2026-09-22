import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = readFile(new URL('../../supabase/migrations/20260922020000_checked_image_changes.sql', import.meta.url), 'utf8');
function body(sql: string, name: string) {
  const escaped = name.replaceAll('.', '\\.');
  const result = new RegExp(`create(?: or replace)? function ${escaped}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql)?.[1];
  if (!result) throw new Error(`Missing definition ${name}`);
  return result;
}
describe('I10b SQL source contracts (not PostgreSQL execution evidence)', () => {
  it('adds only the five approved private RLS tables, no public row shape or provider activation', async () => {
    const sql = await source;
    expect([...sql.matchAll(/create table ([\w.]+)/g)].map((m) => m[1])).toEqual([
      'private.image_change_attempts', 'private.image_change_context', 'private.image_change_history',
      'private.item_deletion_operations', 'private.item_deletion_targets',
    ]);
    for (const name of ['image_change_attempts', 'image_change_context', 'image_change_history', 'item_deletion_operations', 'item_deletion_targets']) {
      expect(sql).toContain(`alter table private.${name} enable row level security;`);
    }
    expect(sql).not.toMatch(/alter table public\.|delete from storage\.|update private\.ai_controls|insert into private\.ai_execution_manifests/);
    expect(sql).toMatch(/^--[^\n]+\nbegin;[\s\S]*\ncommit;\n$/);
  });
  it('keeps Auth-lifetime tombstones separate from item-lifetime ordered provenance', async () => {
    const sql = await source;
    expect(sql.match(/references auth\.users\(id\) on delete cascade/g)).toHaveLength(2);
    expect(sql).toContain('foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade');
    expect(sql).toContain('on delete set null(source_image_id)');
    const history = body(sql, 'public.item_attribution_history');
    expect(history.match(/jsonb_build_object\('source_image_id'/g)).toHaveLength(2);
    expect(history).not.toMatch(/to_jsonb|jsonb_strip_nulls/);
    expect(history).toContain('order by h.version,h.rank,h.request_id nulls first');
    expect(history).toContain('1::bigint version,0 rank,null::uuid request_id');
    expect(sql).not.toMatch(/alter table private\.item_attribution_history/);
  });
  it('consumes exact single-use context inside the same failure/rollback scope as each mutation', async () => {
    const sql = await source, consume = body(sql, 'private.consume_image_change_context');
    expect(consume).toContain('delete from private.image_change_context c');
    expect(consume).toContain('c.transaction_id=pg_current_xact_id()');
    for (const predicate of ['c.owner_id=p_owner', 'c.item_id=p_item', 'c.target_id=p_target',
      'c.purpose=p_purpose', 'c.expected_version is not distinct from p_version',
      'c.old_hash=private.image_change_hash(p_old)', 'c.new_hash is not distinct from private.image_change_hash(p_new)']) {
      expect(consume).toContain(predicate);
    }
    expect(consume).toContain('returning c.request_id into consumed');
    expect(consume).toContain('return found;');
    for (const name of ['public.complete_image_change', 'public.begin_prepared_item_deletion', 'public.finish_item_deletion']) {
      const definition = body(sql, name);
      expect(definition).toContain('insert into private.image_change_context');
      expect(definition).toContain('exists(select 1 from private.image_change_context');
      expect(definition).not.toMatch(/when others|\nexception[\s\S]*return/);
    }
    expect(body(sql, 'private.guard_image_change_item')).toContain("'begin_deletion'");
    expect(body(sql, 'private.item_field_provenance')).toContain("'replacement'");
  });
  it('uses shared admission locks for ordinary mutations and conflicting short fence transitions, never a sentinel insert', async () => {
    const sql = await source, lock = body(sql, 'private.image_change_lock');
    expect(lock).toContain("current_setting('transaction_isolation')<>'read committed'");
    expect(lock).toContain('for no key update nowait'); expect(lock).toContain('for share nowait');
    expect(lock).not.toContain('insert into');
    const reserve = body(sql, 'public.reserve_analyzed_item_save');
    expect(reserve.indexOf('private.image_change_lock')).toBeLessThan(reserve.indexOf('private.item_save_owner'));
    expect(reserve.indexOf('private.item_save_owner')).toBeLessThan(reserve.indexOf('private.image_change_attempts'));
    expect(reserve.indexOf('private.image_change_attempts')).toBeLessThan(reserve.indexOf('private.reserve_analyzed_item_save_v10'));
    expect(body(sql, 'private.reserve_image_change')).toContain('private.ai_save_used_receipts');
  });
  it('fences all native publication/update/delete events and both image bindings without SQL byte removal', async () => {
    const sql = await source, guard = body(sql, 'private.guard_item_object_publication');
    expect(sql).toContain('create or replace trigger item_object_publication_guard after insert or update or delete on storage.objects');
    expect(guard).toContain('perform private.image_change_lock(u)');
    expect(guard).toContain("storage.allow_only_operation('storage.object.delete')");
    expect(guard).toContain('row(object.id,object.version,object.owner_id,object.owner)');
    expect(guard).toContain('and authorized and not reconciled_absent');
    expect(body(sql, 'private.guard_image_change_image')).toContain('row(new.owner_id,new.item_id,new.id) is distinct from row(old.owner_id,old.item_id,old.id)');
    expect(sql).not.toMatch(/disable trigger|session_replication_role|delete from storage\.objects/);
  });
  it('retains inclusive seven-day source acceptance and does not recheck accepted recovery age', async () => {
    const sql = await source, reserve = body(sql, 'private.reserve_image_change');
    expect(reserve.indexOf("return private.image_change_receipt(a)")).toBeLessThan(reserve.indexOf("interval '7 days'"));
    expect(reserve).toContain("source.retired_at<clock_timestamp()-interval '7 days'");
    expect(reserve).toContain("source.retired_at>clock_timestamp()");
    expect(body(sql, 'public.complete_image_change')).not.toContain("interval '7 days'");
    expect(body(sql, 'public.image_recovery_versions')).toContain('order by id limit 40');
  });
  it('keeps read-policy admission nonlocking while the authoritative native mutation guard retains its lock', async () => {
    const sql = await source, policy = body(sql, 'private.may_delete_storage');
    expect(policy).not.toMatch(/image_change_lock|\bfor (?:share|update|no key update|key share)\b/i);
    expect(policy).toContain("u is null or not private.is_approved() or not starts_with(p_name,u::text||'/')");
    expect(policy).toContain("and phase<>'cancelled'");
    expect(policy).toContain("return d.phase in ('authorized','removing_registered')");
    expect(policy).toContain('t.authorized and not t.reconciled_absent');
    expect(policy).toContain("return p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(main|thumb)\\.jpg$'");
    const guard = body(sql, 'private.guard_item_object_publication');
    expect(guard.indexOf('perform private.image_change_lock(u)')).toBeLessThan(guard.indexOf('select * into d'));
    expect(guard).toContain("if tg_op<>'DELETE' or d.phase not in ('authorized','removing_registered')");
    expect(guard).toContain("storage.allow_only_operation('storage.object.delete')");
    expect(guard).toContain('is distinct from row(t.object_id,t.object_version,t.object_owner,t.legacy_owner)');
  });
  it('normalizes authorization row-lock failure without a success fallback and declares only reachable phases', async () => {
    const sql = await source, authorize = body(sql, 'public.authorize_item_deletion');
    expect(authorize).toContain("exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';");
    expect(authorize).not.toMatch(/when others|\nexception[\s\S]*return/);
    expect(sql).not.toContain('removing_extras');
    expect(sql).toContain("'preparing','blocked_preflight','prepared','authorized','removing_registered','completed','cancelled'");
  });
  it('preserves irreversible authorization and checked BEGIN/FINISH instead of trusting client DELETE observations', async () => {
    const sql = await source;
    expect(body(sql, 'public.authorize_item_deletion')).toContain("d.phase='prepared'");
    expect(body(sql, 'public.cancel_item_deletion_preparation')).toContain("d.phase not in ('preparing','blocked_preflight','prepared','cancelled')");
    const begin = body(sql, 'public.begin_prepared_item_deletion');
    expect(begin).toContain('select * into receipt from public.begin_item_deletion(p_item_id,i.version,p_request_id,manifest)');
    expect(begin).toContain('private.item_lifecycle_manifest');
    expect(begin).toContain("and category='pending' and reconciled_absent)<>2");
    const finish = body(sql, 'public.finish_item_deletion');
    expect(finish).toContain("if not found then return query select 'absent'::text; return; end if");
    expect(finish).toContain('private.finish_item_deletion_v9');
    expect(finish).toContain("phase='completed'");
    expect(body(sql, 'public.reconcile_item_deletion_target')).not.toMatch(/p_removed|p_success|p_verified|p_status/);
  });
  it('contains explicit byte verification metadata comparisons at preflight and service completion', async () => {
    const sql = await source;
    for (const name of ['public.image_change_preflight', 'public.complete_image_change']) {
      expect(body(sql, name)).toContain("is distinct from p_intent->'image'");
      expect(body(sql, name)).toContain('private.image_change_objects');
    }
    const installer = await readFile(new URL('../../scripts/backend/ci-storage-guard.mjs', import.meta.url), 'utf8');
    const md5 = createHash('md5').update(body(sql, 'private.guard_item_object_publication')).digest('hex');
    expect(installer).toContain(`IMAGE_CHANGE_PUBLICATION_BODY_MD5 = '${md5}'`);
    const policyMd5 = createHash('md5').update(body(sql, 'private.may_delete_storage')).digest('hex');
    expect(installer).toContain(`pg_catalog.md5(x.prosrc)='${policyMd5}'`);
  });
});
