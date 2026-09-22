import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import { editGarmentField, newGarmentDraft } from '../../src/domain/garment-fields';
import { newSaveAttempt, saveItem } from '../../src/images/upload';
import { classifyObjectDeletion, deleteWardrobeObject, wardrobeDeleteRoute } from '../../src/data/storage-delete';
import type { DeleteReply, DeleteRequest } from '../../src/data/storage-delete';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { ITEM_LIFECYCLE_CATALOG_SQL, assertLifecycleFixture, MIGRATIONS, withLifecycleParentLock, withLifecycleCatalogMarker as catalogMarker, lifecycleStorageRuntime, withLifecycleLateUpload, requireStorageCatalogInventory } from '../../scripts/preservation-rehearsal.mjs';
// @ts-expect-error Executable normal-session JavaScript has no TypeScript declaration.
import { one, lifecycleObservation, serializeLifecycleObservation, readLifecycleUploadResponse, requireLifecycleUploadConflict, lifecycleFixtureCases, lifecyclePublicationCases, legacyOrphanCase } from '../integration/item-lifecycle.sessions.mjs';
// @ts-expect-error Executable normal-session JavaScript has no TypeScript declaration.
import { securityObservation, serializeSecurityObservation } from '../security/item-lifecycle.sessions.mjs';

const fixtureMocks = vi.hoisted(() => ({
  spawn: vi.fn(), requireLocalContainer: vi.fn(), privilegedLocalSql: vi.fn(), commandEnvironment: vi.fn(), saveClients: vi.fn(),
  markerRemove: vi.fn(), runCommand: vi.fn(), requireDocker: vi.fn(),
}));
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<Record<string, unknown>>('node:child_process'), spawn: fixtureMocks.spawn,
}));
vi.mock('../../scripts/backend/local.mjs', async () => ({
  ...await vi.importActual<Record<string, unknown>>('../../scripts/backend/local.mjs'),
  requireLocalContainer: fixtureMocks.requireLocalContainer,
  privilegedLocalSql: fixtureMocks.privilegedLocalSql, commandEnvironment: fixtureMocks.commandEnvironment,
  runCommand: fixtureMocks.runCommand, requireDocker: fixtureMocks.requireDocker,
}));
vi.mock('../integration/item-save.sessions.mjs', async () => ({
  ...await vi.importActual<Record<string, unknown>>('../integration/item-save.sessions.mjs'), saveClients: fixtureMocks.saveClients,
}));

const read = (name: string) => readFile(new URL('../../' + name, import.meta.url), 'utf8');
const sql = await read('supabase/migrations/20260913120000_item_lifecycle.sql');
function routine(name: string): string {
  const value = sql.match(new RegExp(`create function ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$\\$;`))?.[0];
  if (!value) throw new Error('Missing source routine');
  return value;
}
function ordered(source: string, steps: string[]) {
  let offset = 0;
  for (const step of steps) {
    const index = source.indexOf(step, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + step.length;
  }
}

describe('singular Storage deletion protocol (no backend execution)', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  const path = `${owner}/10800000-0000-4000-8000-000000000002/10000000-0000-4000-8000-000000000003/main.jpg`;
  const success: DeleteReply = { status: 200, ok: true, data: { message: 'Successfully deleted' } };
  const missing: DeleteReply = { status: 400, ok: false,
    data: { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' } };
  const denial: DeleteReply = { status: 400, ok: false,
    data: { statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied' } };
  it('distinguishes acknowledged removal, exact missing, and hard denial', () => {
    expect(classifyObjectDeletion(success)).toBe('removed');
    expect(classifyObjectDeletion(missing)).toBe('missing');
    expect(() => classifyObjectDeletion(denial)).toThrow('error.notAvailable');
  });
  it.each<DeleteReply>([
    { ...missing, data: { statusCode: '404', code: 'NoSuchKey', error: 'NoSuchKey', message: 'Object not found' } },
    { ...denial, data: { statusCode: '403', code: 'AccessDenied', error: 'AccessDenied', message: 'Access denied' } },
    { ...missing, data: { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Access denied' } },
    { ...denial, data: { statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Object not found' } },
    { ...missing, data: { statusCode: 404, code: 'NoSuchKey', error: 'not_found', message: 'Object not found' } },
    { ...denial, data: { statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Not available' } },
    { ...success, data: [] }, { ...success, status: 204 }, { ...success, ok: false },
    { ...success, data: { message: 'Successfully deleted', extra: true } },
    { ...missing, status: 404 }, { ...missing, ok: true },
    { ...missing, data: { code: 'NoSuchKey' } }, { ...missing, data: null },
    { ...missing, data: 'Private upstream content' }, { ...missing, data: { statusCode: 404, code: 'NoSuchKey', error: 'NoSuchKey', message: 'Object not found' } },
    { ...missing, data: { statusCode: '404', code: 'NoSuchKey', error: 'NoSuchKey', message: 'Other' } },
    { ...denial, data: { statusCode: '403', code: 'AccessDenied', error: 'AccessDenied', message: 'Other' } },
    ...[500, 502, 503, 599].flatMap((status) => [success, missing, denial].map((reply) => ({ ...reply, status }))),
  ])('refuses unexpected/5xx response %# rather than inventing missing or success', (reply) => {
    expect(() => classifyObjectDeletion(reply)).toThrow('error.unavailable');
  });
  it('makes one fixed singular request; no bulk, inference or retry', async () => {
    const request = vi.fn<DeleteRequest>().mockResolvedValue(success);
    expect(await deleteWardrobeObject(request, owner, path)).toBe('removed');
    expect(request).toHaveBeenCalledExactlyOnceWith(`/storage/v1/object/wardrobe/${path}`, { method: 'DELETE' });
  });
  it('accepts the existing adapter range field without broadening the body contract', () => {
    const reply = { ...missing, range: null };
    expect(classifyObjectDeletion(reply)).toBe('missing');
    expect(classifyObjectDeletion({ ...reply, ...success })).toBe('removed');
  });
  it.each([new Error('Primary'), undefined, null, false, 0, ''])('retains exact adapter failure %#', async (primary) => {
    const request = vi.fn<DeleteRequest>().mockRejectedValue(primary);
    const result = await deleteWardrobeObject(request, owner, path).then(() => ({ rejected: false, value: null }),
      (value: unknown) => ({ rejected: true, value }));
    expect(result).toEqual({ rejected: true, value: primary }); expect(request).toHaveBeenCalledOnce();
  });
  it('rejects traversal, foreign owner, query/fragment and endpoint escapes before transport', async () => {
    const request = vi.fn<DeleteRequest>();
    expect(() => Reflect.apply(wardrobeDeleteRoute, undefined, [owner, { toString: () => path }])).toThrow('error.unavailable');
    for (const changed of [path.replace(owner, '20000000-0000-4000-8000-000000000001'), path + '?x', path + '#x',
      path.replace('/main.jpg', '/../main.jpg'), path.replace('/main.jpg', '/main.jpg%2f'), 'https://example.test/' + path]) {
      expect(() => wardrobeDeleteRoute(owner, changed)).toThrow('error.unavailable');
      await expect(deleteWardrobeObject(request, owner, changed)).rejects.toThrow('error.unavailable');
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe('late-upload child orchestration (mock-only, not byte-phase acceptance)', () => {
  const uid = '10000000-0000-4000-8000-000000000001';
  const owner = { uid, token: ['unit', Buffer.from(JSON.stringify({ sub: uid, role: 'authenticated' })).toString('base64url'), 'unit'].join('.') };
  const value = { p_item: { id: '10800000-0000-4000-8000-000000000002' }, p_image: { id: '10000000-0000-4000-8000-000000000003' } };
  const container = 'supabase_storage_stillroom-wardrobe', imageId = 'sha256:' + 'a'.repeat(64);
  const runtime = { name: '/' + container, project: 'stillroom-wardrobe', running: true, image: 'supabase/storage-api:v1.70.3', id: imageId,
    mounts: [{ type: 'volume', name: container, target: '/mnt', rw: true }],
    config: ['STORAGE_BACKEND=file', 'FILE_STORAGE_BACKEND_PATH=/mnt', 'TENANT_ID=stub', 'GLOBAL_S3_BUCKET=stub', null] };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CI', 'true'); vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('ALLOW_PRESERVATION_REHEARSAL', '1'); vi.stubEnv('ALLOW_SECURITY_TESTS', '1');
    fixtureMocks.runCommand.mockReset(); fixtureMocks.spawn.mockReset();
    fixtureMocks.requireDocker.mockResolvedValue(undefined); fixtureMocks.commandEnvironment.mockReturnValue({});
    fixtureMocks.runCommand.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(runtime) })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ id: imageId, digests: ['supabase/storage-api@' + imageId] }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
  });
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled(); }
    finally { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });
  function child(reply: unknown = { stage: 'settled', status: 400, bodyBytes: 91, denied: true, failed: false },
    endFailure?: { value: unknown }) {
    const proc = new EventEmitter(), stdin = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    const write = vi.fn(() => { queueMicrotask(() => stdout.emit('data', Buffer.from('{"stage":"ready","partialBytes":2}\n'))); return true; });
    const end = vi.fn((command: string) => {
      queueMicrotask(() => {
        if (command === 'complete\n') stdout.emit('data', Buffer.from(JSON.stringify(reply) + '\n'));
        proc.emit('close', command === 'complete\n' ? 0 : 1);
      });
      if (endFailure) throw endFailure.value;
    });
    const kill = vi.fn(() => { queueMicrotask(() => proc.emit('close', 1)); return true; });
    fixtureMocks.spawn.mockReturnValue(Object.assign(proc, {
      stdin: Object.assign(stdin, { write, end, writableEnded: false, destroyed: false }), stdout, stderr, kill,
    }));
    return { write, end, kill, stdout, proc };
  }
  it('sends only stdin credentials, waits for readiness, completes once and joins before resolving', async () => {
    const c = child(), operation = vi.fn(async () => { expect(c.end).not.toHaveBeenCalled(); });
    await withLifecycleLateUpload(owner, value, operation);
    expect(operation).toHaveBeenCalledOnce();
    expect(c.end).toHaveBeenCalledExactlyOnceWith('complete\n');
    expect(c.write).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixtureMocks.spawn.mock.calls)).not.toContain(owner.token);
    expect(fixtureMocks.runCommand).toHaveBeenCalledTimes(2);
    expect(c.kill).not.toHaveBeenCalled();
  });
  it.each([new Error('Primary'), undefined, null, false, 0, ''])('joins cancellation without masking exact/falsy operation failure %#', async (primary) => {
    const c = child(undefined, { value: new Error('Secondary') });
    const result = await withLifecycleLateUpload(owner, value, async () => { throw primary; })
      .then(() => ({ rejected: false, value: null }), (value: unknown) => ({ rejected: true, value }));
    expect(result).toEqual({ rejected: true, value: primary }); expect(c.end).toHaveBeenCalledWith('cancel\n');
  });
  it.each([
    { stage: 'settled', status: 500, bodyBytes: 73, denied: false, failed: true },
    { stage: 'settled', status: 200, bodyBytes: 4, denied: true, failed: false },
    { stage: 'settled', status: 400, bodyBytes: null, denied: true, failed: false },
    { stage: 'settled', status: 400, bodyBytes: 4097, denied: true, failed: false },
    { stage: 'settled', status: 400, bodyBytes: 90, denied: true, failed: false, extra: true },
  ])('rejects malformed, overflow and unknown/5xx settlement %#', async (reply) => {
    child(reply);
    await expect(withLifecycleLateUpload(owner, value, async () => {})).rejects.toThrow('EVIDENCE_REQUIRED');
  });
  it('fails an unacknowledged deadline, cancels and terminates the exact child', async () => {
    const c = child();
    await expect(withLifecycleLateUpload(owner, value, async () => { await vi.advanceTimersByTimeAsync(15_000); }))
      .rejects.toThrow('EVIDENCE_REQUIRED');
    expect(c.end).toHaveBeenCalledWith('cancel\n'); expect(c.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it.each([
    { project: 'different' }, { running: false }, { image: 'supabase/storage-api:latest' },
    { mounts: [{ type: 'bind', name: container, target: '/mnt', rw: true }] },
    { config: ['STORAGE_BACKEND=s3'] }, { id: 'unverified' },
  ])('refuses owned-runtime mismatch %# without a child/upload', async (change) => {
    fixtureMocks.runCommand.mockReset().mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ...runtime, ...change }) });
    await expect(lifecycleStorageRuntime()).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(fixtureMocks.spawn).not.toHaveBeenCalled();
  });
  it('does not bless absent, excessive or incompatible catalog observations', () => {
    for (const input of [null, {}, { deleteProtected: true }, { triggers: new Array(17).fill({}) }]) {
      expect(() => requireStorageCatalogInventory(input)).toThrow('EVIDENCE_REQUIRED');
    }
  });
});

describe('I08 SQL source contract, not live database proof', () => {
  it('has only four public RPCs and no public table/fingerprint/export edits', () => {
    expect([...sql.matchAll(/create function public\.(\w+)/g)].map((match) => match[1])).toEqual([
      'set_item_trashed', 'item_deletion_status', 'begin_item_deletion', 'finish_item_deletion',
    ]);
    expect(sql).not.toMatch(/alter table public.*(?:add|drop|disable)|create (?:or replace )?function public\.(?:export|reserve|commit|finalize)|set_config|current_setting|when others|pg_sleep|\bloop\b/i);
    expect(sql.match(/private\.ai_\w+/g)).toEqual(['private.ai_item_save_attempts']);
    expect(sql).not.toMatch(/revoke .*on public\.(?:items|item_images)|lock table|references public\.profiles/);
    expect(sql).toContain('foreign key (owner_id,item_id) references public.items(owner_id,id) on delete cascade');
    const claim = sql.slice(sql.indexOf('create table private.item_deletion_claims'), sql.indexOf('alter table private.item_deletion_claims'));
    expect(claim).toContain('primary key (owner_id,item_id)');
    expect(claim).toContain('unique (owner_id,request_id)');
    expect(claim).not.toMatch(/fingerprint|title|manifest|image_id|jsonb|expires|completed/);
    expect(sql).toContain('alter table private.item_deletion_claims enable row level security');
    expect(sql).toContain('revoke all on private.item_deletion_claims from public,anon,authenticated');
  });
  it('uses explicit fresh definer visibility for every protected-state invariant', () => {
    for (const name of ['private.guard_item_deletion', 'private.guard_item_image_deletion',
      'private.may_create_item_object', 'private.item_lifecycle_owner',
      'public.set_item_trashed', 'public.item_deletion_status', 'public.begin_item_deletion', 'public.finish_item_deletion']) {
      expect(routine(name)).toContain("language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s'");
    }
    for (const name of ['private.guard_item_deletion', 'private.guard_item_image_deletion']) {
      expect(routine(name)).not.toMatch(/auth\.uid|current_user|session_user|pg_trigger_depth|set_config/);
    }
    expect(routine('private.guard_item_deletion')).toContain("starts_with(o.name,old.owner_id::text || '/' || old.id::text || '/')");
    expect(routine('private.guard_item_image_deletion')).toContain('and exists(select 1 from public.items i where i.owner_id=old.owner_id and i.id=old.item_id)');
  });
  it('takes parent KEY SHARE explicitly before fresh claim and pending-path checks', () => {
    ordered(routine('private.guard_item_image_deletion'), [
      "if tg_op='INSERT' then", 'for key share nowait;', 'from private.item_deletion_claims',
    ]);
    ordered(routine('private.may_create_item_object'), [
      'select im.item_id into target', "im.state='pending'", 'p_name in(im.main_path,im.thumb_path)',
      'for key share nowait;', 'return private.is_approved()', "im.state='pending'", 'from private.item_deletion_claims',
    ]);
    expect(routine('private.may_create_item_object')).not.toMatch(/::uuid|split_part/);
    expect(routine('private.may_create_item_object')).toContain("errcode='55P03',message='The resource is locked'");
    expect(sql).toContain("storage.allow_only_operation('storage.object.upload')");
    expect(sql).toContain("storage.allow_only_operation('storage.object.delete')");
    expect(sql).toContain("with check (bucket_id='wardrobe' and private.may_create_item_object(name))");
  });
  it('replaces exactly three policies, admitting orphan SELECT only for the existing singular DELETE predicate', () => {
    expect(sql.match(/(?:drop|create) policy\b[^;]+;/gi)).toEqual([
      'drop policy wardrobe_read on storage.objects;',
      "create policy wardrobe_read on storage.objects for select to authenticated\n"
        + "using (bucket_id='wardrobe' and (private.owns_storage_path(name,false)\n"
        + "  or (private.may_delete_storage(name)\n"
        + "    and storage.allow_only_operation('storage.object.delete'))));",
      'drop policy wardrobe_create on storage.objects;',
      "create policy wardrobe_create on storage.objects for insert to authenticated\n"
        + "with check (bucket_id='wardrobe' and private.may_create_item_object(name));",
      'drop policy wardrobe_delete on storage.objects;',
      "create policy wardrobe_delete on storage.objects for delete to authenticated\n"
        + "using (bucket_id='wardrobe' and private.may_delete_storage(name)\n"
        + "  and storage.allow_only_operation('storage.object.delete'));",
    ]);
    expect(sql.match(/drop policy\b/gi)).toHaveLength(3);
    expect(sql.match(/create policy\b/gi)).toHaveLength(3);
    expect(sql).not.toMatch(/\balter policy\b|\bfor (?:update|all) to\b|\bgrant\b[^;]*\bon (?:table )?storage\./i);
  });
  it('pins read/delete catalog shape, derived qualifiers and the complete three-policy set separately', () => {
    const catalog = ITEM_LIFECYCLE_CATALOG_SQL as string;
    expect([...catalog.matchAll(/^ {2}'(\w+)',/gm)]).toHaveLength(19);
    const guard = catalog.slice(catalog.indexOf("  'storageReadDelete',"));
    expect(guard).toBe(`  'storageReadDelete',(select count(*)=2 and bool_and(
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
);`);
  });
  it('orders profile, images, parent UPDATE, full image reread and claim locks', () => {
    for (const name of ['public.begin_item_deletion', 'public.finish_item_deletion']) {
      ordered(routine(name), [
        'u := private.item_lifecycle_owner();',
        'order by im.id for update nowait;',
        'select i.* into item from public.items i where i.owner_id=u and i.id=p_item_id for update nowait;',
        'order by im.id for update nowait;',
        'select c.* into claim from private.item_deletion_claims',
      ]);
      expect(routine(name)).not.toContain('for no key update');
      expect(routine(name)).toContain("message='Request conflict'");
    }
    ordered(routine('public.begin_item_deletion'), [
      'if found then', 'claim.request_id<>p_request_id', 'claim.expected_version<>p_expected_version',
      'item.version<>claim.expected_version+1', 'manifest<>p_image_manifest_sha256',
      'return;', 'item.version<>p_expected_version', "im.state='pending'",
      'from storage.objects', 'update public.items i', 'insert into private.item_deletion_claims',
    ]);
    ordered(routine('public.finish_item_deletion'), [
      'claim.request_id<>p_request_id', 'from storage.objects', 'order by o.name for share nowait;',
      "if found then raise exception", 'delete from public.items', "'completed'::text",
    ]);
    expect(routine('public.finish_item_deletion')).toContain("'absent'::text");
    expect(routine('public.finish_item_deletion')).not.toMatch(/delete from (?:storage|public\.item_images)|forget_image/);
  });
  it('fences all-role publication with transaction-held SHARE locks, not admission or expiry', async () => {
    const publication = routine('private.guard_item_object_publication');
    expect(publication).toContain("volatile security definer set search_path = '' set lock_timeout = '2s'");
    ordered(publication, ['from public.profiles p where p.owner_id=u for share nowait',
      'from private.approved_accounts a where a.user_id=u for share nowait',
      'from public.item_images im where im.owner_id=u and im.id=image_id for share nowait',
      'from public.items i where i.owner_id=u and i.id=parent_id for share nowait',
      'select im.* into image', 'select i.* into item', 'and a.enabled',
      "image.state is distinct from 'pending'", 'from private.item_deletion_claims', 'and a.cancelled']);
    expect(publication).toContain('new.owner_id is distinct from u::text');
    expect(publication).toContain('(new.owner is not null and new.owner<>u)');
    expect(publication).toContain('new.version is distinct from old.version');
    for (const field of ['id', 'bucket_id', 'name', 'owner', 'owner_id', 'archived_at', 'is_delete_marker', 'is_versioned']) {
      expect(publication).toContain(`new.${field}`);
      expect(publication).toContain(`old.${field}`);
    }
    expect(publication).not.toMatch(/auth\.uid|current_user|session_user|pg_trigger_depth|for key share|::uuid|ai_enabled|expires_at|clock_timestamp/);
    expect(sql).toContain('after insert or update on storage.objects');
    expect(sql).not.toContain('alter table storage.objects enable always trigger item_object_publication_guard;');
    const installer = await read('scripts/backend/ci-storage-guard.mjs');
    expect(installer).toContain('alter table storage.objects enable always trigger item_object_publication_guard;');
    expect(installer).toContain("observed#>>'{trigger,tgenabled}' is distinct from 'A'");
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain("tgenabled='A'");
    expect(sql).toContain('revoke all on function private.guard_item_object_publication() from public,anon,authenticated');
  });
  it('retains only the approved owner/image pair until actual Auth deletion and records transactionally', () => {
    const table = sql.slice(sql.indexOf('create table private.item_image_used_ids'), sql.indexOf('alter table private.item_image_used_ids'));
    expect(table).toContain('references auth.users(id) on delete cascade');
    expect(table).toContain('primary key (owner_id,image_id)');
    expect(table).not.toMatch(/time|path|hash|state|content|item_id|profile|email/);
    expect(sql).toContain('union select owner_id,image_id from private.item_save_used_ids');
    expect(routine('private.record_item_image_identity')).toContain('insert into private.item_image_used_ids');
    expect(routine('private.record_item_image_identity')).not.toMatch(/on conflict do nothing|auth.uid|current_user/);
    expect(sql).toContain('enable always trigger item_image_identity_guard');
  });
  it('keeps status read-only in one relation-read statement and manifest independent of bytes', () => {
    const status = routine('public.item_deletion_status');
    expect(status.match(/return query/g)).toHaveLength(1);
    expect(status).toContain('with owned as materialized');
    expect(status).toContain('images as materialized');
    expect(status).not.toMatch(/for update|for share|for key share|\b(?:insert into|update public|delete from|perform)\b/);
    expect(status).toContain('cardinality(p_item_ids) not between 1 and 40');
    expect(status).toContain('count(distinct x)');
    expect(status).toContain('c.request_id,c.expected_version,c.started_at');
    expect(status).toContain('i.title,i.version,i.deleted_at');
    const manifest = routine('private.item_lifecycle_manifest');
    expect(manifest).toContain('language sql immutable');
    expect(manifest).not.toMatch(/storage\.|from public\.|from private\.|alt_text|created_at|retired_at/);
    expect(manifest).toContain("order by im->>'id'");
    expect(manifest).toContain("im->'description_version'");
    expect(manifest).toContain('sha256(convert_to');
  });
  it('uses server time and positive safe counters, retaining exactly the seven-day window', () => {
    const trash = routine('public.set_item_trashed');
    expect(trash).toContain("item.deleted_at<clock_timestamp()-interval '7 days'");
    expect(trash).toContain('item.deleted_at>clock_timestamp()');
    expect(trash).toContain('case when p_trashed then clock_timestamp() else null end');
    expect(trash).toContain("im.state='ready'");
    expect(trash).toContain('p_expected_version not between 1 and 9007199254740990');
    expect(trash).toContain('from private.item_deletion_claims');
  });
  it('pins actual ninth bytes and preserves literal privileges plus positive catalog assertions', () => {
    const entries = MIGRATIONS as Array<{ name: string; bytes: number; sha256: string }>;
    expect(entries).toHaveLength(10);
    const entry = entries[8];
    if (!entry) throw new Error('Missing migration');
    expect(entry.name).toBe('20260913120000_item_lifecycle.sql');
    expect(entry.bytes).toBe(Buffer.byteLength(sql));
    expect(entry.sha256).toBe(createHash('sha256').update(sql).digest('hex'));
    expect(sql.match(/grant execute on function private\./g)).toHaveLength(1);
    expect(sql).toContain('grant execute on function private.may_create_item_object(text) to authenticated');
    expect(sql.match(/grant execute on function public\./g)).toHaveLength(4);
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain('p.prosecdef');
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain("p.provolatile='v'");
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain('aclexplode');
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain('c.relrowsecurity');
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain("cmd in ('UPDATE','ALL')");
    expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain('private.may_delete_storage(name)');
    expect(ITEM_LIFECYCLE_CATALOG_SQL).not.toMatch(/^\s*(delete|update|insert|create|alter|grant)\b/im);
    for (const match of sql.matchAll(/create function ([\w.]+)\((.*?)\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/g)) {
      const body = match[3];
      if (body === undefined) throw new Error('Missing routine body');
      expect(ITEM_LIFECYCLE_CATALOG_SQL).toContain(createHash('md5').update(body).digest('hex'));
    }
  });
  it('runs new ordinary suites additively without granting normal children CI fixture authority', async () => {
    const runner = await read('scripts/run-local-tests.mjs');
    ordered(runner, ["'analyzed-save.sessions.mjs'", "'item-lifecycle.sessions.mjs'", "if (suite === 'integration')"]);
    expect(runner).toContain('if (lifecycleCode !== 0)');
    expect(runner).not.toContain('withLifecycleParentLock');
    const source = await read('scripts/preservation-rehearsal.mjs');
    ordered(source, ["await child('verify');", "'S4-item-lifecycle-catalog'", "'S4-item-lifecycle-fixtures'"]);
    expect(source).toContain("output.trim() === 'I08_PARENT_HELD'");
    expect(source).toContain("setTimeout(reject, 15_000)");
    expect(source).not.toContain('withAnalyzedSaveFixtureLock');
    const tests = await read('tests/integration/item-lifecycle.sessions.mjs');
    expect(tests).not.toMatch(/privilegedLocalSql|spawn\(|withAnalyzedSaveFixtureLock/);
    expect(tests).toContain('eq(value, retainedIntent)');
    expect(tests).toContain("phase = 'explicit-retry'");
    expect(tests).toContain('dbConflict || wrappedConflict');
  });
});

describe('closed source-only fixture and response helpers', () => {
  const owner = '10000000-0000-4000-8000-000000000001', item = '10800000-0000-4000-8000-000000000002';
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', ALLOW_PRESERVATION_REHEARSAL: '1', ALLOW_SECURITY_TESTS: '1' };
  it('rejects missing CI opt-ins, malformed identities and B2 namespace substitution', () => {
    expect(() => assertLifecycleFixture(env, owner, item)).not.toThrow();
    for (const key of Object.keys(env)) expect(() => assertLifecycleFixture({ ...env, [key]: '' }, owner, item)).toThrow();
    for (const id of ['', owner, 'b229' + item.slice(4), item + "'"]) expect(() => assertLifecycleFixture(env, owner, id)).toThrow();
    expect(() => assertLifecycleFixture({ ...env, SERVICE_ROLE_KEY: 'refused' }, owner, item)).toThrow();
  });
  it('rejects affirmative-shaped failures, missing/extra rows and unexpected fields', () => {
    const result = { ok: true, status: 200, data: [{ state: 'completed' }] };
    expect(one(result, ['state'])).toEqual({ state: 'completed' });
    for (const change of [{ ok: false }, { status: 204 }, { data: [] }, { data: [{ state: 'completed', extra: true }] },
      { data: [{ state: 'completed' }, { state: 'completed' }] }]) {
      expect(() => one({ ...result, ...change }, ['state'])).toThrow();
    }
  });
});

it('keeps a generic upload failure unavailable, retains the draft/IDs and retries only explicitly (SDK with synthetic HTTP)', async () => {
  const scope: OwnerScope = { ownerId: '10000000-0000-4000-8000-000000000001', epoch: 3, signal: new AbortController().signal };
  const draft = editGarmentField(editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'Fictional shirt', 'en'), 'category', 'top', 'en');
  const photo = new Blob(['synthetic'], { type: 'image/jpeg' }), hash = createHash('sha256').update('synthetic').digest('hex');
  const attempt = newSaveAttempt(draft, '', { main: photo, thumb: photo, mainSha256: hash, thumbSha256: hash, width: 2, height: 2 }, scope);
  const prefix = `${scope.ownerId}/${attempt.itemId}/${attempt.imageId}`, now = '2026-09-13T12:00:00Z';
  const reservation = {
    fingerprint: 'b'.repeat(64), state: 'reserved',
    item: { ...attempt.payload, id: attempt.itemId, owner_id: scope.ownerId, version: 1, deleted_at: null, created_at: now, updated_at: now },
    image: { id: attempt.imageId, owner_id: scope.ownerId, item_id: attempt.itemId, state: 'pending', retired_at: null,
      main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`, main_bytes: photo.size, thumb_bytes: photo.size,
      main_sha256: hash, thumb_sha256: hash, width: 2, height: 2, alt_text: '', description_version: 1, created_at: now },
  };
  const calls: Array<{ path: string; body: unknown }> = [];
  let unavailable = true;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (path.endsWith('/reserve_item_save')) return reply([reservation]);
    if (path.startsWith('/storage/v1/object/wardrobe/')) {
      expect(new Headers(init?.headers).get('x-upsert')).toBe('false');
      // Synthetic transport category only; the CI test observes the real wrapper.
      return unavailable ? reply({ statusCode: '400', error: 'Fixture unavailable', message: 'Request conflict' }, 400) : reply({ Key: path });
    }
    if (path.endsWith('/finalize_item_save')) return new Response(null, { status: 204 });
    throw new Error('Unexpected fixture request');
  });
  const client = createClient<Database>('http://127.0.0.1:54321', 'public-fixture-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  const retainedPayload = structuredClone(attempt.payload), ids = [attempt.itemId, attempt.imageId];
  await expect(saveItem(client, scope, attempt, () => {})).rejects.toThrow('error.unavailable');
  expect(calls).toHaveLength(2);
  expect(attempt.payload).toEqual(retainedPayload); expect([attempt.itemId, attempt.imageId]).toEqual(ids);
  expect(attempt.photo.main).toBe(photo); expect(attempt.photo.thumb).toBe(photo);
  unavailable = false;
  await saveItem(client, scope, attempt, () => {});
  expect(calls.filter(({ path }) => path.endsWith('/reserve_item_save')).map(({ body }) => body)).toEqual([calls[0]?.body, calls[0]?.body]);
  expect(calls.filter(({ path }) => path.endsWith('/finalize_item_save'))).toHaveLength(1);
  expect(calls.some(({ path }) => /analy|ai_|\/items$/.test(path))).toBe(false);
  const capture = await read('src/features/wardrobe/add-item.tsx');
  expect(capture).toContain('capture.retryNote');
  expect(capture).toContain('const current = attempt ??');
  expect(capture).toContain('setAttempt(current)');
});

describe('I08 fixture failure precedence (mock-only; no Docker, SQL or network)', () => {
  const owner = '10000000-0000-4000-8000-000000000001', item = '10800000-0000-4000-8000-000000000002';
  const privateError = new Error('Private operation SQL/token must not be logged');
  const cleanupError = new Error('Private cleanup SQL/token must not be logged');
  const primaryValues: unknown[] = [privateError, undefined, null, false, 0, ''];
  const lockNotice = 'FAIL: I08 exact parent-lock release';
  const markerNotice = 'FAIL: I08 exact catalog-marker cleanup';
  const markerPhases = (primary: string, cleanup: string) =>
    `FAIL: I08 catalog-marker primary=${primary}; cleanup=${cleanup}`;
  const markerImage = '10000000-0000-4000-8000-000000000003';
  const withLifecycleCatalogMarker = (ownerId: string, itemId: string, operation: () => Promise<unknown>) =>
    catalogMarker(ownerId, itemId, operation, { imageId: markerImage, remove: fixtureMocks.markerRemove });
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubEnv('CI', 'true'); vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('ALLOW_PRESERVATION_REHEARSAL', '1'); vi.stubEnv('ALLOW_SECURITY_TESTS', '1');
    for (const mock of Object.values(fixtureMocks)) mock.mockReset();
    fixtureMocks.spawn.mockImplementation(() => { throw new Error('Unexpected process request'); });
    fixtureMocks.requireLocalContainer.mockResolvedValue(undefined);
    fixtureMocks.commandEnvironment.mockReturnValue({});
    fixtureMocks.privilegedLocalSql.mockImplementation(() => { throw new Error('Unexpected SQL request'); });
    fixtureMocks.markerRemove.mockResolvedValue('removed');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    }
  });

  function parent(mode: 'ok' | 'status' | 'end-throw' | 'child-error' = 'ok', setup?: { error: unknown }) {
    const child = new EventEmitter(), stdin = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    let closed = false;
    const close = () => queueMicrotask(() => {
      if (!closed) { closed = true; child.emit('close', mode === 'status' ? 1 : 0); }
    });
    const write = vi.fn(() => {
      if (setup) throw setup.error;
      queueMicrotask(() => stdout.emit('data', Buffer.from('I08_PARENT_HELD\n')));
      return true;
    });
    const end = vi.fn(() => {
      if (mode === 'end-throw') throw cleanupError;
      if (mode === 'child-error') queueMicrotask(() => child.emit('error', cleanupError));
      else close();
    });
    const kill = vi.fn(() => { close(); return true; });
    fixtureMocks.spawn.mockReturnValue(Object.assign(child, {
      stdin: Object.assign(stdin, { write, end, writableEnded: false, destroyed: false }), stdout, stderr, kill,
    }));
    return {
      child, end, kill,
      assertReleased() {
        expect(closed).toBe(true);
        expect(end).toHaveBeenCalledExactlyOnceWith('rollback;\n');
        expect(vi.getTimerCount()).toBe(0);
        expect(fixtureMocks.requireLocalContainer).toHaveBeenCalledOnce();
        expect(fixtureMocks.spawn).toHaveBeenCalledOnce();
        expect(fixtureMocks.privilegedLocalSql).not.toHaveBeenCalled();
        if (mode === 'end-throw' || mode === 'child-error') expect(kill).toHaveBeenCalledWith('SIGTERM');
      },
    };
  }
  async function rejection(promise: Promise<unknown>, expected: unknown) {
    const outcome = await promise.then(() => ({ rejected: false, reason: undefined }), (reason: unknown) => ({ rejected: true, reason }));
    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBe(expected);
  }

  it('releases the parent and timer after success', async () => {
    const child = parent(), operation = vi.fn(async () => {});
    await expect(withLifecycleParentLock(owner, item, 'update', operation)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledOnce(); child.assertReleased(); expect(log).not.toHaveBeenCalled();
  });
  it.each(primaryValues)('preserves exact parent operation rejection %# with successful cleanup', async (primary) => {
    const child = parent();
    await rejection(withLifecycleParentLock(owner, item, 'key share', async () => { throw primary; }), primary);
    child.assertReleased(); expect(log).not.toHaveBeenCalled();
  });
  it.each(['status', 'end-throw', 'child-error'] as const)('rejects parent cleanup-only %s and still closes/clears the timer', async (mode) => {
    const child = parent(mode);
    await expect(withLifecycleParentLock(owner, item, 'update', async () => {})).rejects.toThrow(
      mode === 'end-throw' ? cleanupError.message : 'EVIDENCE_REQUIRED',
    );
    child.assertReleased(); expect(log.mock.calls).toEqual([[lockNotice]]);
  });
  for (const mode of ['status', 'end-throw', 'child-error'] as const) {
    it.each(primaryValues)(`preserves falsy/exact parent operation rejection %# through ${mode}`, async (primary) => {
      const child = parent(mode);
      await rejection(withLifecycleParentLock(owner, item, 'update', async () => { throw primary; }), primary);
      child.assertReleased(); expect(log.mock.calls).toEqual([[lockNotice]]);
    });
  }
  it.each(primaryValues)('preserves parent setup write failure %# despite throwing release', async (primary) => {
    const child = parent('end-throw', { error: primary }), operation = vi.fn();
    await rejection(withLifecycleParentLock(owner, item, 'update', operation), primary);
    child.assertReleased(); expect(operation).not.toHaveBeenCalled(); expect(log.mock.calls).toEqual([[lockNotice]]);
  });
  it.each(primaryValues)('observes readiness rejection after setup failure %# and asynchronous child error', async (primary) => {
    const child = parent('child-error', { error: primary }), operation = vi.fn(), unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await rejection(withLifecycleParentLock(owner, item, 'update', operation), primary);
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.assertReleased(); expect(operation).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([[lockNotice]]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
  it('retains the bounded deadline failure and closes the mocked child', async () => {
    const child = parent();
    await expect(withLifecycleParentLock(owner, item, 'update', async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    })).rejects.toThrow('EVIDENCE_REQUIRED');
    child.assertReleased(); expect(log.mock.calls).toEqual([[lockNotice]]);
  });

  type MarkerMode = 'ok' | 'delete-throw' | 'delete-reject' | 'delete-count' | 'absence-throw' | 'absence-reject' | 'absence-count';
  function marker(mode: MarkerMode = 'ok', setup?: { error: unknown }, setupCount = '0') {
    const statements: string[] = [];
    fixtureMocks.privilegedLocalSql.mockImplementation((statement: string) => {
      statements.push(statement);
      if (statements.length === 1) {
        if (setup) return Promise.reject(setup.error);
        return Promise.resolve('I08_MARKER_CREATED');
      }
      if (statements.length === 2) {
        if (mode === 'delete-throw') throw cleanupError;
        if (mode === 'delete-reject') return Promise.reject(cleanupError);
        return Promise.resolve(mode === 'delete-count' ? '2' : setup ? setupCount : '1');
      }
      if (statements.length === 3) {
        if (mode === 'absence-throw') throw cleanupError;
        if (mode === 'absence-reject') return Promise.reject(cleanupError);
        return Promise.resolve(mode === 'absence-count' ? '1' : '0');
      }
      throw new Error('Unexpected SQL request');
    });
    return {
      assertCleaned() {
        expect(statements).toHaveLength(3);
        expect(statements[0]).toContain('insert into storage.objects');
        expect(statements[1]).toContain('select count(*) from storage.objects');
        expect(statements.join('\n')).not.toMatch(/delete from storage\.objects|set_config|allow_delete_query/);
        if (!setup && !mode.startsWith('delete')) {
          expect(fixtureMocks.markerRemove).toHaveBeenCalledExactlyOnceWith(`${owner}/${item}/${markerImage}/thumb.jpg`);
        }
        expect(statements[2]).toContain('select count(*) from storage.objects');
        const markerId = statements[0]?.match(/values\('([0-9a-f-]+)'/)?.[1];
        expect(markerId).toBeDefined();
        for (const statement of statements.slice(1)) {
          expect(statement).toContain(`id='${markerId}'`);
          expect(statement).toContain(`${owner}/${item}/${markerImage}/thumb.jpg`);
        }
        expect(fixtureMocks.spawn).not.toHaveBeenCalled();
        expect(fixtureMocks.requireLocalContainer).not.toHaveBeenCalled();
      },
    };
  }
  const markerFailures: MarkerMode[] = ['delete-throw', 'delete-reject', 'delete-count', 'absence-throw', 'absence-reject', 'absence-count'];
  const markerCleanupPhase = (mode: MarkerMode) => mode.startsWith('delete') ? 'cleanup-count' : 'final-absence';
  it('removes and verifies the exact marker after success', async () => {
    const fixture = marker(), operation = vi.fn(async () => {});
    await expect(withLifecycleCatalogMarker(owner, item, operation)).resolves.toBeUndefined();
    fixture.assertCleaned(); expect(operation).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
  });
  it.each(primaryValues)('preserves exact marker operation rejection %# with successful cleanup', async (primary) => {
    const fixture = marker();
    await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
    fixture.assertCleaned(); expect(log.mock.calls).toEqual([[markerPhases('callback', 'none')]]);
  });
  it.each(markerFailures)('rejects marker cleanup-only %s, retaining deletion and absence checks', async (mode) => {
    const fixture = marker(mode);
    await expect(withLifecycleCatalogMarker(owner, item, async () => {})).rejects.toThrow(
      mode.endsWith('count') ? 'EVIDENCE_REQUIRED' : cleanupError.message,
    );
    fixture.assertCleaned(); expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('none', markerCleanupPhase(mode))]]);
  });
  for (const mode of markerFailures) {
    it.each(primaryValues)(`preserves exact/falsy marker operation rejection %# through ${mode}`, async (primary) => {
      const fixture = marker(mode);
      await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
      fixture.assertCleaned(); expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('callback', markerCleanupPhase(mode))]]);
    });
  }
  for (const mode of ['ok', ...markerFailures] as MarkerMode[]) {
    it.each(primaryValues)(`preserves marker setup rejection %# through ${mode}`, async (primary) => {
      const fixture = marker(mode, { error: primary }), operation = vi.fn();
      await rejection(withLifecycleCatalogMarker(owner, item, operation), primary);
      fixture.assertCleaned(); expect(operation).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual(mode === 'ok' ? [[markerPhases('setup', 'none')]]
        : [[markerNotice], [markerPhases('setup', markerCleanupPhase(mode))]]);
    });
  }
  it.each(['0', '1'])('retains strict uncertain-setup cleanup count %s', async (count) => {
    const fixture = marker('ok', { error: privateError }, count);
    await rejection(withLifecycleCatalogMarker(owner, item, vi.fn()), privateError);
    fixture.assertCleaned(); expect(log.mock.calls).toEqual([[markerPhases('setup', 'none')]]);
  });
  it.each(primaryValues)('retains first exact/falsy parent cleanup failure %# when termination and logging throw', async (first) => {
    const fixture = parent();
    fixture.end.mockImplementation(() => { throw first; });
    fixture.kill.mockImplementation(() => {
      queueMicrotask(() => fixture.child.emit('close', 0));
      throw cleanupError;
    });
    log.mockImplementation(() => { throw privateError; });
    await rejection(withLifecycleParentLock(owner, item, 'update', async () => {}), first);
    expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(primaryValues)('retains exact/falsy primary %# when parent cleanup notice itself throws', async (primary) => {
    const child = parent('status');
    log.mockImplementation(() => { throw cleanupError; });
    await rejection(withLifecycleParentLock(owner, item, 'update', async () => { throw primary; }), primary);
    child.assertReleased();
  });
  it('bounds closure failure when termination throws and no close event arrives', async () => {
    const child = new EventEmitter(), stdin = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    const end = vi.fn(() => { throw cleanupError; }), kill = vi.fn(() => { throw privateError; });
    fixtureMocks.spawn.mockReturnValue(Object.assign(child, {
      stdin: Object.assign(stdin, { write: () => stdout.emit('data', Buffer.from('I08_PARENT_HELD\n')), end }), stdout, stderr, kill,
    }));
    const pending = rejection(withLifecycleParentLock(owner, item, 'update', async () => {}), cleanupError);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(end).toHaveBeenCalledOnce(); expect(kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); expect(log.mock.calls).toEqual([[lockNotice]]);
  });
  it.each(primaryValues)('retains first exact/falsy marker cleanup %# through later absence and notice errors', async (first) => {
    marker();
    fixtureMocks.privilegedLocalSql.mockResolvedValueOnce('I08_MARKER_CREATED')
      .mockRejectedValueOnce(first).mockRejectedValueOnce(cleanupError);
    log.mockImplementation(() => { throw privateError; });
    await rejection(withLifecycleCatalogMarker(owner, item, async () => {}), first);
    expect(fixtureMocks.privilegedLocalSql).toHaveBeenCalledTimes(3);
    expect(fixtureMocks.privilegedLocalSql.mock.calls[2]?.[0]).toContain('select count(*) from storage.objects');
    expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('none', 'cleanup-count')]]);
  });
  it.each(primaryValues)('retains marker primary %# when cleanup and its notice both fail', async (primary) => {
    const fixture = marker('absence-reject');
    log.mockImplementation(() => { throw cleanupError; });
    await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
    fixture.assertCleaned();
    expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('callback', 'final-absence')]]);
  });
  it.each(primaryValues)('preserves singular-API cleanup failure %# and still verifies catalog absence', async (first) => {
    marker();
    fixtureMocks.markerRemove.mockRejectedValueOnce(first);
    fixtureMocks.privilegedLocalSql.mockResolvedValueOnce('I08_MARKER_CREATED').mockResolvedValueOnce('1')
      .mockRejectedValueOnce(cleanupError);
    log.mockImplementation(() => { throw privateError; });
    await rejection(withLifecycleCatalogMarker(owner, item, async () => {}), first);
    expect(fixtureMocks.markerRemove).toHaveBeenCalledOnce();
    expect(fixtureMocks.privilegedLocalSql).toHaveBeenCalledTimes(3);
    expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('none', 'removal')]]);
  });
  it.each(['missing', 'denied', undefined])('never treats marker API %s as acknowledged deletion', async (result) => {
    marker(); fixtureMocks.markerRemove.mockResolvedValueOnce(result);
    await expect(withLifecycleCatalogMarker(owner, item, async () => {})).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(fixtureMocks.privilegedLocalSql).toHaveBeenCalledTimes(3);
    expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('none', 'removal')]]);
  });
  it.each(primaryValues)('retains callback failure %# when only its new phase notice fails', async (primary) => {
    const fixture = marker();
    log.mockImplementation(() => { throw cleanupError; });
    await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
    fixture.assertCleaned();
    expect(log.mock.calls).toEqual([[markerPhases('callback', 'none')]]);
  });
  it('records callback and removal failures separately without private values', async () => {
    marker();
    fixtureMocks.markerRemove.mockRejectedValueOnce(cleanupError);
    await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw privateError; }), privateError);
    expect(log.mock.calls).toEqual([[markerNotice], [markerPhases('callback', 'removal')]]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Private|[0-9a-f]{8}-|storage\.objects/);
  });
});

describe('T29 real-orphan assertion definitions (mock-only; no backend)', () => {
  const owner = { uid: '10000000-0000-4000-8000-000000000001', token: 'ordinary-owner' };
  const other = { uid: '10000000-0000-4000-8000-000000000002', token: 'ordinary-peer' };
  const value = { p_item: { id: '10800000-0000-4000-8000-000000000003' },
    p_image: { id: '10800000-0000-4000-8000-000000000004' } };
  const paths = (attempt: typeof value) => ['thumb', 'main'].map((part) =>
    `${owner.uid}/${attempt.p_item.id}/${attempt.p_image.id}/${part}.jpg`);
  type Reply = { ok: boolean; status: number; data: unknown };
  type Options = { method?: string; body?: unknown; headers?: Record<string, string> };
  type Boundary = 'read' | 'sign' | 'list' | 'bulk' | 'foreign-delete' | 'anonymous-delete' | 'owner-delete' | 'absence';
  function fixture(fault?: { boundary: Boundary; reply: Reply }) {
    const events: string[] = [], removed = new Set<string>();
    const status = { photo_count: 0, unmanifested_count: 2, cleanup_blocked: true, version: 2 };
    const before = { items: [{ id: value.p_item.id }], images: [], status };
    const request = vi.fn(async (token: string | null, route: string, options: Options = {}): Promise<Reply> => {
      let boundary: Boundary;
      if (route.startsWith('/storage/v1/object/authenticated/')) boundary = 'read';
      else if (route.startsWith('/storage/v1/object/sign/')) boundary = 'sign';
      else if (route === '/storage/v1/object/list/wardrobe') boundary = 'list';
      else if (route === '/storage/v1/object/wardrobe') boundary = 'bulk';
      else {
        expect(route).toMatch(/^\/storage\/v1\/object\/wardrobe\/(?:[0-9a-f-]+\/){3}(?:main|thumb)\.jpg$/);
        expect(options.method).toBe('DELETE');
        boundary = token === null ? 'anonymous-delete' : token === other.token ? 'foreign-delete'
          : removed.has(route) ? 'absence' : 'owner-delete';
      }
      events.push(boundary);
      if (fault?.boundary === boundary) return fault.reply;
      if (boundary === 'list' || boundary === 'bulk') return { ok: true, status: 200, data: [] };
      if (boundary === 'owner-delete') {
        removed.add(route);
        return { ok: true, status: 200, data: { message: 'Successfully deleted' } };
      }
      if (boundary === 'absence') return { ok: false, status: 400,
        data: { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' } };
      return { ok: false, status: 400, data: { statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied' } };
    });
    const h = {
      create: vi.fn(async () => value), paths, download: vi.fn(async () => {}),
      deleteItem: vi.fn(async () => {}), track: (attempt: typeof value) => attempt,
      upload: vi.fn(async () => {}), trash: vi.fn(async () => ({ deleted_at: null })),
      snapshot: vi.fn(async () => structuredClone(before)), unchanged: vi.fn(async () => {}),
      status: vi.fn(async () => removed.size ? { ...status, unmanifested_count: 0, cleanup_blocked: false } : { ...status }),
      beginArgs: vi.fn(() => ({})),
      call: vi.fn(async () => ({ ok: false, status: 400,
        data: { code: '22023', message: 'Request conflict', details: null, hint: null } })),
      read: vi.fn(async (table: string, id: string) => table === 'items' ? before.items : id === value.p_image.id ? [] : [{ id }]),
      remove: vi.fn(async (attempt: typeof value) => {
        for (const path of paths(attempt)) expect(await deleteWardrobeObject(
          (route, options) => request(owner.token, route, options), owner.uid, path)).toBe('removed');
      }),
    };
    return { h, request, events, client: { request, insert: vi.fn(async () => {}), rpc: vi.fn(async () => {}) } };
  }
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); })); });
  afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
  it('uses all three normal principals and both header sets, then exact owner removal and independent absence', async () => {
    const f = fixture();
    await legacyOrphanCase(f.client, owner, other, f.h);
    expect(f.h.create).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.h.download.mock.calls.slice(0, 2)).toEqual(paths(value).map((path) => [path]));
    expect(f.h.unchanged).toHaveBeenCalledTimes(3);
    expect(f.request).toHaveBeenCalledTimes(44);
    for (const boundary of ['read', 'sign', 'list'] as const) {
      const calls = f.request.mock.calls.filter((_, index) => f.events[index] === boundary);
      expect(new Set(calls.map(([token]) => token))).toEqual(new Set([owner.token, other.token, null]));
      expect(new Set(calls.map(([, , options]) => JSON.stringify(options?.headers)))).toEqual(new Set([
        '{}', JSON.stringify({ 'storage.operation': 'storage.object.delete',
          'x-storage-operation': 'storage.object.delete', 'x-http-method-override': 'DELETE' }),
      ]));
    }
    expect(f.events.filter((event) => event === 'bulk')).toHaveLength(2);
    expect(f.events.filter((event) => event === 'foreign-delete')).toHaveLength(4);
    expect(f.events.filter((event) => event === 'anonymous-delete')).toHaveLength(4);
    expect(f.events.slice(-4)).toEqual(['owner-delete', 'owner-delete', 'absence', 'absence']);
    expect(f.h.remove).toHaveBeenCalledExactlyOnceWith(value);
  });
  it.each(['read', 'sign', 'list', 'bulk', 'foreign-delete', 'anonymous-delete', 'owner-delete', 'absence'] as const)(
    'never accepts server error at %s as privacy or deletion evidence', async (boundary) => {
      const f = fixture({ boundary, reply: { ok: false, status: 500, data: {} } });
      await expect(legacyOrphanCase(f.client, owner, other, f.h)).rejects.toThrow();
      expect(f.events.at(-1)).toBe(boundary);
    },
  );
  it.each([
    ['read', { exposed: true }], ['sign', { signedURL: 'unexpected' }], ['list', [{ name: 'main.jpg' }]],
    ['bulk', [{ name: 'main.jpg' }]], ['foreign-delete', { message: 'Successfully deleted' }],
    ['anonymous-delete', { message: 'Successfully deleted' }], ['owner-delete', {}], ['absence', {}],
  ] as const)('rejects disclosure, off-route deletion or malformed success at %s', async (boundary, data) => {
    const f = fixture({ boundary, reply: { ok: true, status: 200, data } });
    await expect(legacyOrphanCase(f.client, owner, other, f.h)).rejects.toThrow();
  });
  it('does not count pre-existing absence as successful owner deletion', async () => {
    const f = fixture({ boundary: 'owner-delete', reply: { ok: false, status: 400,
      data: { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' } } });
    await expect(legacyOrphanCase(f.client, owner, other, f.h)).rejects.toThrow();
    expect(f.events.at(-1)).toBe('owner-delete');
  });
});

describe('T29 marker caller phases (mock-only; no SQL, backend or process)', () => {
  const owner = { uid: '10000000-0000-4000-8000-000000000001', token: 'ordinary-owner' };
  const other = { uid: '10000000-0000-4000-8000-000000000002', token: 'ordinary-peer' };
  const phases = ['item-insert', 'image-insert', 'setup', 'legacy-delete', 'item-reinsert', 'image-reinsert',
    'upload', 'commit-image', 'trash', 'snapshot', 'begin-refusal', 'unchanged', 'restore', 'removal'] as const;
  const cleanupError = new Error('Private cleanup'), primaryValues = [new Error('Private primary'), undefined, null, false, 0, ''];
  let notices: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fixtureMocks.saveClients.mockReset();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
    notices = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  function fixture(at: typeof phases[number], primary: unknown) {
    let item: Record<string, unknown> = {}, image: Record<string, unknown> = {};
    let inserts = 0, callbackFailed = false, outerCleanup = false, begun = false;
    const events: string[] = [];
    function step(name: typeof phases[number]) {
      if (events.at(-1) !== name) events.push(name);
      if (at === name && !callbackFailed) { callbackFailed = true; throw primary; }
    }
    const request = vi.fn(async (token: string, route: string, options: { method?: string; body?: Record<string, unknown> } = {}) => {
      expect(token).toBe(owner.token);
      if (outerCleanup) {
        if (route.startsWith('/storage/v1/object/wardrobe/')) return { ok: true, status: 200, data: { message: 'Successfully deleted' } };
        if (route.startsWith('/storage/v1/object/authenticated/')) return { ok: false, status: 400, data: {} };
        if (options.method === 'DELETE') throw cleanupError;
        throw new Error('Unexpected later cleanup request');
      }
      if (route.startsWith('/storage/v1/object/wardrobe/')) {
        if (options.method === 'DELETE') { step('removal'); throw cleanupError; }
        step('upload'); return { ok: true, status: 200, data: {} };
      }
      if (options.method === 'DELETE') { step('legacy-delete'); return { ok: true, status: 204, data: null }; }
      if (route.endsWith('/set_item_trashed')) {
        step(options.body?.p_trashed ? 'trash' : 'restore');
        item = { ...item, version: options.body?.p_trashed ? 2 : 3,
          deleted_at: options.body?.p_trashed ? '2026-09-14T00:00:00Z' : null };
        return { ok: true, status: 200, data: [{ id: item.id, owner_id: owner.uid, version: item.version, deleted_at: item.deleted_at }] };
      }
      if (route.endsWith('/begin_item_deletion')) {
        step('begin-refusal'); begun = true;
        return { ok: false, status: 400, data: { code: '22023', message: 'Request conflict', details: null, hint: null } };
      }
      step(begun ? 'unchanged' : 'snapshot');
      if (route.startsWith('/rest/v1/items?')) return { ok: true, status: 200, data: [item] };
      if (route.startsWith('/rest/v1/item_images?')) return { ok: true, status: 200, data: [image] };
      expect(route).toBe('/rest/v1/rpc/item_deletion_status');
      return { ok: true, status: 200, data: [{
        id: item.id, owner_id: owner.uid, title: item.title, version: item.version, deleted_at: item.deleted_at,
        photo_count: 1, current_image_id: image.id, current_thumb_path: 'unused', image_manifest_sha256: 'a'.repeat(64),
        cleanup_blocked: true, unmanifested_count: 1, request_id: null, expected_version: null, started_at: null,
      }] };
    });
    const client = { request, insert: vi.fn(async (_owner: unknown, table: string, body: Record<string, unknown>) => {
      const phase = (['item-insert', 'image-insert', 'item-reinsert', 'image-reinsert'] as const)[inserts++];
      if (!phase) throw new Error('Unexpected insert');
      step(phase);
      if (table === 'items') item = { ...body, owner_id: owner.uid, version: 1, deleted_at: null };
      else image = { ...body, owner_id: owner.uid };
    }), rpc: vi.fn(async () => { step('commit-image'); }) };
    fixtureMocks.saveClients.mockResolvedValue({ client, owners: [owner, other] });
    const withLifecycleCatalogMarker = vi.fn(async (_owner: string, _item: string, operation: () => Promise<void>,
      options: { imageId: string; remove: (path: string) => Promise<unknown> }) => {
      let failed = false, first: unknown;
      try { step('setup'); await operation(); } catch (error) { failed = true; first = error; }
      try { await options.remove(`${_owner}/${_item}/${options.imageId}/thumb.jpg`); }
      catch (error) { if (!failed) { failed = true; first = error; } }
      outerCleanup = true;
      if (failed) throw first;
    });
    // Setup failures before the helper still enter the unchanged outer cleanup.
    notices.mockImplementation(() => { outerCleanup = true; throw cleanupError; });
    return { events, request, client, withLifecycleCatalogMarker,
      withLifecycleLateUpload: vi.fn(() => { throw new Error('Unexpected late-upload fixture'); }),
      requireLifecyclePrefixEmpty: vi.fn(), requireLifecycleClaimFence: vi.fn() };
  }
  it.each(phases)('retains the exact/falsy %s failure despite marker removal and outer cleanup failures', async (at) => {
    for (const primary of primaryValues) {
      notices.mockClear();
      const f = fixture(at, primary);
      const result = await lifecyclePublicationCases({}, f).then(
        () => ({ failed: false, value: null }), (value: unknown) => ({ failed: true, value }));
      expect(result.failed).toBe(true); expect(result.value).toBe(primary);
      expect(notices.mock.calls).toEqual([
        [`FAIL: I08 fixture catalog-marker-${at}; ordinary-session evidence required`],
        ['FAIL: I08 exact lifecycle fixture cleanup'],
      ]);
      expect(f.withLifecycleLateUpload).not.toHaveBeenCalled();
      expect(f.requireLifecyclePrefixEmpty).not.toHaveBeenCalled();
      expect(f.events.filter((event) => event !== 'removal')).toEqual(phases.slice(0, phases.indexOf(at) + 1).filter((event) => event !== 'removal'));
      expect(JSON.stringify(notices.mock.calls)).not.toContain('Private');
    }
  });
});

describe('R3 bounded held-upload response and closed evidence (mock-only)', () => {
  const env = {
    ALLOW_SECURITY_TESTS: '1', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_fixture',
    TEST_A_EMAIL: 'user-a@example.test', TEST_B_EMAIL: 'user-b@example.test',
    TEST_A_PASSWORD: 'a'.repeat(24), TEST_B_PASSWORD: 'b'.repeat(24),
  };
  const uid = '10000000-0000-4000-8000-000000000001';
  const token = ['unit', Buffer.from(JSON.stringify({ role: 'authenticated', sub: uid })).toString('base64url'), 'unit'].join('.');
  const owner = { label: 'A', uid, token };
  const value = { p_item: { id: '10800000-0000-4000-8000-000000000002' }, p_image: { id: '10000000-0000-4000-8000-000000000003' } };
  const conflict = { code: '22023', message: 'Request conflict' };
  const primaryValues: unknown[] = [new Error('Private primary'), undefined, null, false, 0, ''];
  const cleanupError = new Error('Private secondary');
  const response = (data: unknown, status = 400) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  let fetchMock: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', fetchMock);
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('R3 held-phase records and outer cleanup (fully mocked ordinary clients)', () => {
    const env = {
      ALLOW_SECURITY_TESTS: '1', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_fixture',
      TEST_A_EMAIL: 'user-a@example.test', TEST_B_EMAIL: 'user-b@example.test',
      TEST_A_PASSWORD: 'a'.repeat(24), TEST_B_PASSWORD: 'b'.repeat(24),
    };
    const owners = [1, 2].map((index) => {
      const uid = `10000000-0000-4000-8000-00000000000${index}`;
      return { label: index === 1 ? 'A' : 'B', uid,
        token: ['unit', Buffer.from(JSON.stringify({ role: 'authenticated', sub: uid })).toString('base64url'), 'unit'].join('.') };
    });
    const primaryValues: unknown[] = [new Error('Private primary'), undefined, null, false, 0, ''];
    const secondary = new Error('Private secondary');
    const lifecyclePhases = ['begin-held', 'begin-held-denial', 'begin-held-unchanged', 'begin-holder-release',
      'begin-released', 'singular-removal', 'finish-held', 'finish-held-denial', 'finish-holder-release',
      'finish-released', 'final-rows'] as const;
    type LifecyclePhase = typeof lifecyclePhases[number];
    let output: MockInstance<(...args: unknown[]) => void>, notices: MockInstance<(...args: unknown[]) => void>;
    beforeEach(() => {
      fixtureMocks.saveClients.mockReset();
      output = vi.spyOn(console, 'log').mockImplementation(() => {});
      notices = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: '22023', message: 'Request conflict' }), { status: 400 })));
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
    function object(value: unknown): Record<string, unknown> {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid mock object');
      return value as Record<string, unknown>;
    }
    function fixture(fault?: { at: 'before' | 'rows' | 'insert' | 'status' | 'release' | 'reserve' | LifecyclePhase; value: unknown },
      cleanup?: { value: unknown }) {
      const rows = new Map<string, { item: Record<string, unknown>; image: Record<string, unknown>;
        reservation: Record<string, unknown>; requestId: unknown; expected: unknown }>();
      const events: string[] = [];
      let held: string | null = null, marker = false, cleanupStarted = false;
      const lifecycleEvents: LifecyclePhase[] = [];
      let lifecycleFailed = false, keyShareCalls = 0, requestCount = 0, failureRequestCount = 0;
      const removed = new Set<string>();
      const conflict = () => ({ ok: false, status: 400, data: { code: '22023', message: 'Request conflict', details: null, hint: null } });
      const request = vi.fn(async (token: string, route: string, options: { method?: string; body?: unknown } = {}) => {
        requestCount++;
        const owner = owners.find((candidate) => candidate.token === token);
        if (!owner) throw new Error('Unexpected mock owner');
        const body = options.body === undefined ? {} : object(options.body);
        let row = rows.get(owner.uid);
        if (owner.uid === owners[0]!.uid && !lifecycleFailed && !cleanupStarted) {
          let step: LifecyclePhase | undefined;
          if (route.endsWith('/begin_item_deletion')) step = held ? 'begin-held-denial' : 'begin-released';
          else if (route.endsWith('/finish_item_deletion')) step = held ? 'finish-held-denial' : 'finish-released';
          else if (route.startsWith('/storage/v1/object/wardrobe/') && options.method === 'DELETE' && row?.requestId) {
            step = 'singular-removal';
          } else if (route.startsWith('/rest/v1/items?') || route.startsWith('/rest/v1/item_images?')) {
            if (held === 'key share' && !row?.requestId) step = 'begin-held-unchanged';
            else if (!row && ['finish-released', 'final-rows'].includes(lifecycleEvents.at(-1) ?? '')) step = 'final-rows';
          }
          if (step && lifecycleEvents.at(-1) !== step) {
            lifecycleEvents.push(step);
            if (fault?.at === step) { lifecycleFailed = true; failureRequestCount = requestCount; throw fault.value; }
          }
        }
        if (route.endsWith('/reserve_item_save')) {
          if (fault?.at === 'reserve') throw fault.value;
          if (!row) {
            const item: Record<string, unknown> = { ...object(body.p_item), owner_id: owner.uid, version: 1, deleted_at: null };
            const image: Record<string, unknown> = { ...object(body.p_image), owner_id: owner.uid, item_id: item.id, description_version: 1,
              retired_at: null, state: 'pending', thumb_path: `${owner.uid}/${item.id}/${object(body.p_image).id}/thumb.jpg` };
            row = { item, image, reservation: { fingerprint: 'a'.repeat(64), state: 'reserved', item, image }, requestId: null, expected: null };
            rows.set(owner.uid, row);
          }
          return { ok: true, status: 200, data: [structuredClone(row.reservation)] };
        }
        if (route.startsWith('/storage/v1/object/wardrobe/')) {
          const path = route.slice('/storage/v1/object/wardrobe/'.length);
          if (options.method === 'DELETE') {
            const missing = removed.has(path); removed.add(path);
            return missing ? { ok: false, status: 400, data: { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' } }
              : { ok: true, status: 200, data: { message: 'Successfully deleted' } };
          }
          removed.delete(path);
          return { ok: true, status: 200, data: {} };
        }
        if (route.startsWith('/storage/v1/object/authenticated/wardrobe/')
          && removed.has(route.slice('/storage/v1/object/authenticated/wardrobe/'.length))) {
          return { ok: false, status: 400, data: { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' } };
        }
        if (options.method === 'DELETE') {
          if (marker) return conflict();
          events.push('cleanup'); cleanupStarted = true;
          if (cleanup) throw cleanup.value;
          rows.delete(owner.uid);
          return { ok: true, status: 200, data: [] };
        }
        if (route.startsWith('/rest/v1/items?') || route.startsWith('/rest/v1/item_images?')) {
          if (held === 'update' && fault?.at === 'rows') throw fault.value;
          return { ok: true, status: 200, data: row ? [structuredClone(route.startsWith('/rest/v1/items?') ? row.item : row.image)] : [] };
        }
        if (!row) throw new Error('Missing mock item');
        if (route === '/rest/v1/item_images' && options.method === 'POST') {
          if (fault?.at === 'insert') throw fault.value;
          return conflict();
        }
        if (route.endsWith('/finalize_item_save')) {
          row.image = { ...row.image, state: 'ready' };
          return { ok: true, status: 204, data: null };
        }
        if (route.startsWith('/storage/v1/object/authenticated/')) {
          return { ok: true, status: 200, data: Buffer.from([255, 216, 255, 217]) };
        }
        if (route.endsWith('/set_item_trashed')) {
          row.item = { ...row.item, version: 2, deleted_at: '2026-09-13T12:00:00Z' };
          return { ok: true, status: 200, data: [{ id: row.item.id, owner_id: owner.uid, version: 2, deleted_at: row.item.deleted_at }] };
        }
        if (route.endsWith('/item_deletion_status')) {
          if (held === 'update' && fault?.at === 'status') throw fault.value;
          return { ok: true, status: 200, data: [{
            id: row.item.id, owner_id: owner.uid, title: row.item.title, version: row.item.version, deleted_at: row.item.deleted_at,
            photo_count: 1, current_image_id: row.image.id, current_thumb_path: row.image.thumb_path,
            image_manifest_sha256: 'a'.repeat(64), cleanup_blocked: marker, unmanifested_count: marker ? 1 : 0,
            request_id: row.requestId, expected_version: row.expected, started_at: row.requestId ? '2026-09-13T12:00:00Z' : null,
          }] };
        }
        if (route.endsWith('/begin_item_deletion')) {
          if (held) return conflict();
          row.requestId = body.p_request_id; row.expected = body.p_expected_version;
          row.item = { ...row.item, version: 3 };
          return { ok: true, status: 200, data: [{
            request_id: row.requestId, expected_version: row.expected, version: 3,
            started_at: '2026-09-13T12:00:00Z', image_manifest_sha256: 'a'.repeat(64),
          }] };
        }
        if (route.endsWith('/finish_item_deletion')) {
          if (held || marker) return conflict();
          rows.delete(owner.uid);
          return { ok: true, status: 200, data: [{ state: 'completed' }] };
        }
        throw new Error('Unexpected mock request');
      });
      fixtureMocks.saveClients.mockResolvedValue({ client: { request }, owners });
      const withLifecycleParentLock = vi.fn(async (_owner: string, _item: string, mode: string, operation: () => Promise<void>) => {
        if (fault?.at === 'before') { events.push('holder-failed'); throw fault.value; }
        const lifecycleStep = mode === 'key share' && _owner === owners[0]!.uid
          ? (++keyShareCalls === 1 ? 'begin-held' : 'finish-held') : undefined;
        if (lifecycleStep) {
          lifecycleEvents.push(lifecycleStep);
          if (fault?.at === lifecycleStep) { lifecycleFailed = true; failureRequestCount = requestCount; throw fault.value; }
        }
        held = mode;
        try { await operation(); } finally { held = null; events.push('holder-settled'); }
        if (fault?.at === 'release') throw fault.value;
        if (lifecycleStep) {
          const released = lifecycleStep === 'begin-held' ? 'begin-holder-release' : 'finish-holder-release';
          lifecycleEvents.push(released);
          if (fault?.at === released) { lifecycleFailed = true; failureRequestCount = requestCount; throw fault.value; }
        }
      });
      const withLifecycleCatalogMarker = vi.fn(async (_owner: string, _item: string, operation: () => Promise<void>) => {
        marker = true;
        try { await operation(); } finally { marker = false; }
      });
      return { request, events, lifecycleEvents, withLifecycleParentLock, withLifecycleCatalogMarker,
        isHeld: () => held !== null, cleanupStarted: () => cleanupStarted, failureRequestCount: () => failureRequestCount };
    }
    function records(): Record<string, unknown>[] {
      return output.mock.calls.map(([line]) => line)
        .filter((line): line is string => typeof line === 'string' && line.startsWith('{'))
        .map((line) => {
          const parsed: unknown = JSON.parse(line);
          return object(parsed);
        });
    }
    async function rejection(promise: Promise<unknown>, expected: unknown) {
      const result = await promise.then(() => ({ rejected: false, value: undefined }), (value: unknown) => ({ rejected: true, value }));
      expect(result.rejected).toBe(true); expect(result.value).toBe(expected);
    }
    it.each(primaryValues)('emits once after holder failure %# and before cleanup, retaining primary through output/cleanup errors', async (primary) => {
      const f = fixture({ at: 'before', value: primary }, { value: secondary }), seen: string[] = [];
      output.mockImplementation((line: unknown) => {
        expect(f.isHeld()).toBe(false); expect(f.cleanupStarted()).toBe(false);
        if (typeof line === 'string') seen.push(line);
        throw secondary;
      });
      notices.mockImplementation(() => { throw secondary; });
      await rejection(lifecycleFixtureCases(env, f), primary);
      expect(seen).toHaveLength(1);
      expect(JSON.parse(seen[0]!)).toMatchObject({ stage: 'before-holder', status: null, code: null, bodyBytes: null });
      expect(f.events).toEqual(['holder-failed', 'cleanup']);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it('emits no invented record if reservation fails before a held phase', async () => {
      const primary = new Error('Private reserve');
      const f = fixture({ at: 'reserve', value: primary });
      await rejection(lifecycleFixtureCases(env, f), primary);
      expect(records()).toHaveLength(0); expect(f.withLifecycleParentLock).not.toHaveBeenCalled();
    });
    it.each([
      ['rows', 'classified'], ['insert', 'intent-and-rows'], ['status', 'image-insert-denied'], ['release', 'status-read'],
    ] as const)('retains last reached stage after %s failure, not a fabricated release', async (at, stage) => {
      const primary = new Error('Private assertion'), f = fixture({ at, value: primary });
      await rejection(lifecycleFixtureCases(env, f), primary);
      expect(records()).toHaveLength(1); expect(records()[0]).toMatchObject({ stage, status: 400, code: '22023' });
      expect(f.events).toEqual(['holder-settled', 'cleanup']);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    it('observes an exact-conflict 500 but fails rather than running subsequent functional checks', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: '22023', message: 'Request conflict' }), { status: 500 }));
      const f = fixture();
      await expect(lifecycleFixtureCases(env, f)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(records()).toHaveLength(1); expect(records()[0]).toMatchObject({ status: 500, stage: 'response-read', exactRequestConflict: true });
      expect(f.events).toEqual(['holder-settled', 'cleanup']);
      expect(output.mock.calls.some(([line]) => typeof line === 'string' && line.startsWith('PASS:'))).toBe(false);
    });
    it('emits exactly two complete records for two successful attempted owner phases, each outside the lock before cleanup', async () => {
      const f = fixture();
      output.mockImplementation((line: unknown) => {
        if (typeof line === 'string' && line.startsWith('{')) {
          expect(f.isHeld()).toBe(false); f.events.push('record');
          expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024);
        }
      });
      await expect(lifecycleFixtureCases(env, f)).resolves.toBeUndefined();
      expect(records().map((row) => [row.ownerOrdinal, row.stage, row.status])).toEqual([[1, 'released', 400], [2, 'released', 400]]);
      expect(f.events).toEqual(['holder-settled', 'record', 'holder-settled', 'holder-settled', 'cleanup',
        'holder-settled', 'record', 'holder-settled', 'holder-settled', 'cleanup']);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(f.withLifecycleCatalogMarker).not.toHaveBeenCalled();
      expect(f.request.mock.calls.filter(([, route]) => route.endsWith('/finish_item_deletion'))).toHaveLength(4);
    });
    it('retains two records when the second owner fails after the first passes, without another request or retry', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: '22023', message: 'Request conflict' }), { status: 400 }))
        .mockRejectedValueOnce(secondary);
      const f = fixture();
      await rejection(lifecycleFixtureCases(env, f), secondary);
      expect(records().map((row) => [row.ownerOrdinal, row.stage, row.status])).toEqual([[1, 'released', 400], [2, 'request-sent', null]]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(f.events.filter((event) => event === 'cleanup')).toHaveLength(2);
    });
    it.each(lifecyclePhases)('labels %s without later operations and preserves exact primary through cleanup failure', async (at) => {
      for (const primary of primaryValues) {
        notices.mockClear();
        notices.mockImplementation(() => { throw secondary; });
        const f = fixture({ at, value: primary }, { value: secondary });
        await rejection(lifecycleFixtureCases(env, f), primary);
        expect(f.lifecycleEvents).toEqual(lifecyclePhases.slice(0, lifecyclePhases.indexOf(at) + 1));
        expect(f.withLifecycleParentLock).toHaveBeenCalledTimes(lifecyclePhases.indexOf(at) < 6 ? 2 : 3);
        expect(f.isHeld()).toBe(false);
        expect(f.events.filter((event) => event === 'cleanup')).toEqual(['cleanup']);
        expect(new Set(f.request.mock.calls.map(([token]) => token))).toEqual(new Set([owners[0]!.token]));
        expect(f.request.mock.calls.slice(f.failureRequestCount()).map(([, route, options]) => [route, options?.method ?? 'GET']))
          .toEqual([
            [expect.stringMatching(/^\/storage\/v1\/object\/wardrobe\/[^?]+\/thumb\.jpg$/), 'DELETE'],
            [expect.stringMatching(/^\/storage\/v1\/object\/authenticated\/wardrobe\/[^?]+\/thumb\.jpg$/), 'GET'],
            [expect.stringMatching(/^\/storage\/v1\/object\/wardrobe\/[^?]+\/main\.jpg$/), 'DELETE'],
            [expect.stringMatching(/^\/storage\/v1\/object\/authenticated\/wardrobe\/[^?]+\/main\.jpg$/), 'GET'],
            [expect.stringMatching(/^\/rest\/v1\/items\?owner_id=eq\.[^&]+&id=eq\.[^&]+$/), 'DELETE'],
          ]);
        expect(notices.mock.calls).toEqual([
          [`FAIL: I08 fixture ${at}; ordinary-session evidence required`],
          ['FAIL: I08 exact lifecycle fixture cleanup'],
        ]);
        expect(JSON.stringify(notices.mock.calls)).not.toContain('Private');
      }
    });
    it.each(primaryValues)('retains exact/falsy cleanup-only rejection %# without a success-shaped outer result', async (first) => {
      const f = fixture(undefined, { value: first });
      notices.mockImplementation(() => { throw secondary; });
      await rejection(lifecycleFixtureCases(env, f), first);
      expect(records()).toHaveLength(1); expect(object(records()[0]).stage).toBe('released');
      expect(f.events.filter((event) => event === 'cleanup')).toHaveLength(1);
    });
    it.each(primaryValues)('preserves exact/falsy record-output failure %# and still runs outer cleanup', async (first) => {
      const f = fixture(undefined, { value: secondary });
      output.mockImplementation((line: unknown) => {
        if (typeof line === 'string' && line.startsWith('{')) throw first;
      });
      notices.mockImplementation(() => { throw secondary; });
      await rejection(lifecycleFixtureCases(env, f), first);
      expect(records()).toHaveLength(1);
      expect(f.events).toEqual(['holder-settled', 'cleanup']);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  async function rejection(promise: Promise<unknown>, expected: unknown) {
    const result = await promise.then(() => ({ rejected: false, value: undefined }), (value: unknown) => ({ rejected: true, value }));
    expect(result.rejected).toBe(true); expect(result.value).toBe(expected);
  }
  it('makes precisely the original local ordinary POST, with the same bytes/headers and 15s signal', async () => {
    const reply = response(conflict), reader = reply.body!.getReader();
    const cancel = vi.spyOn(reader, 'cancel'), release = vi.spyOn(reader, 'releaseLock');
    vi.spyOn(reply.body!, 'getReader').mockReturnValue(reader);
    fetchMock.mockResolvedValue(reply);
    const timeout = vi.spyOn(AbortSignal, 'timeout'), observation = lifecycleObservation(1);
    const result = await readLifecycleUploadResponse(env, owner, value, observation);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:54321/storage/v1/object/wardrobe/${uid}/${value.p_item.id}/${value.p_image.id}/thumb.jpg`);
    expect(init).toEqual({
      method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      body: new Uint8Array([255, 216, 255, 217]),
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(cancel).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    expect(observation).toMatchObject({ status: 400, ok: false, bodyType: 'object', captureError: 'none',
      bodyBytes: Buffer.byteLength(JSON.stringify(conflict)), truncated: false, cancelFailed: false, releaseFailed: false });
    expect(() => requireLifecycleUploadConflict(result)).not.toThrow();
  });
  it('requires the exact native 55P03 wrapper and records its closed code without accepting 5xx', async () => {
    const locked = { statusCode: '423', code: 'ResourceLocked', error: 'ResourceLocked', message: 'The resource is locked' };
    fetchMock.mockResolvedValue(response(locked));
    const observation = lifecycleObservation(1);
    const result = await readLifecycleUploadResponse(env, owner, value, observation);
    expect(observation).toMatchObject({ code: 'ResourceLocked', status: 400, statusCodeMatches: false, exactRequestConflict: false });
    expect(() => serializeLifecycleObservation(observation)).not.toThrow();
    expect(() => requireLifecycleUploadConflict(result)).not.toThrow();
    for (const changed of [{ ...result, status: 500 }, { ...result, elapsedMs: 5000 },
      { ...result, data: { ...locked, extra: true } }, { ...result, data: { ...locked, statusCode: '400' } },
      { ...result, data: { ...locked, message: 'Other' } }]) {
      expect(() => requireLifecycleUploadConflict(changed)).toThrow('EVIDENCE_REQUIRED');
    }
  });
  it('refuses endpoint, identity and credential escapes before any request', async () => {
    for (const change of [
      { SUPABASE_URL: 'https://example.test' }, { SUPABASE_URL: 'http://127.0.0.1:54322' },
      { SUPABASE_URL: 'http://127.0.0.1:54321/path' }, { SUPABASE_URL: 'http://127.0.0.1:54321@elsewhere.test' },
      { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_refused' }, { ALLOW_SECURITY_TESTS: '' }, { SERVICE_ROLE_KEY: 'refused' },
      { TEST_A_EMAIL: 'elsewhere@example.test' },
    ]) await expect(readLifecycleUploadResponse({ ...env, ...change }, owner, value, lifecycleObservation(1))).rejects.toThrow();
    for (const changed of [{ ...owner, uid: 'bad/path' }, { ...owner, token: 'bad\r\nheader' }, { ...owner, token: 'service-role' },
      { ...owner, uid: value.p_image.id }]) {
      await expect(readLifecycleUploadResponse(env, changed, value, lifecycleObservation(1))).rejects.toThrow();
    }
    for (const changed of [{ ...value, p_item: { id: uid } }, { ...value, p_image: { id: '../other' } }]) {
      await expect(readLifecycleUploadResponse(env, owner, changed, lifecycleObservation(1))).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires exact existing conflicts and excludes every 5xx even with an exact conflict envelope', async () => {
    for (const [data, status, passes] of [
      [conflict, 400, true], [{ error: 'Private wrapper', statusCode: '409', message: 'Request conflict' }, 409, true],
      [conflict, 500, false], [conflict, 503, false], [{ error: 'Private', statusCode: '500', message: 'Request conflict' }, 500, false],
      [{ message: 'Private server failure' }, 500, false], [{ code: '22023', message: 'prefix Request conflict' }, 400, false],
      [{ code: '55P03', message: 'Request conflict' }, 400, false], [{ error: 'Private', statusCode: '401', message: 'Request conflict' }, 400, false],
      [{ error: 1, statusCode: 400, message: 'Request conflict' }, 400, false], [conflict, 200, false],
    ] as const) {
      fetchMock.mockResolvedValueOnce(response(data, status));
      const observation = lifecycleObservation(1), result = await readLifecycleUploadResponse(env, owner, value, observation);
      expect(observation.status).toBe(status);
      if (passes) expect(() => requireLifecycleUploadConflict(result)).not.toThrow();
      else expect(() => requireLifecycleUploadConflict(result)).toThrow('EVIDENCE_REQUIRED');
      expect(serializeLifecycleObservation(observation)).not.toContain('Private');
    }
    expect(() => requireLifecycleUploadConflict({ ok: false, status: 400, elapsedMs: 5000, data: conflict })).toThrow();
    expect(() => requireLifecycleUploadConflict({ ok: false, status: 400, elapsedMs: 4999.999, data: conflict })).not.toThrow();
  });
  it('retains null for missing response and records headers before missing/empty/body-shape failures', async () => {
    fetchMock.mockRejectedValueOnce(cleanupError);
    const absent = lifecycleObservation(1);
    await rejection(readLifecycleUploadResponse(env, owner, value, absent), cleanupError);
    expect(absent).toMatchObject({ status: null, ok: null, bodyBytes: null, code: null, captureError: 'request' });
    for (const reply of [new Response(null, { status: 204 }), new Response(null, { status: 500 }), new Response('', { status: 400 })]) {
      fetchMock.mockResolvedValueOnce(reply);
      const observation = lifecycleObservation(1), result = await readLifecycleUploadResponse(env, owner, value, observation);
      expect(observation.status).toBe(reply.status); expect(observation.code).toBeNull();
      expect(() => requireLifecycleUploadConflict(result)).toThrow();
    }
    for (const [body, bodyType, captureError] of [
      ['not JSON', 'invalid-json', 'json'], ['{', 'invalid-json', 'json'], ['[]', 'array', 'shape'],
      ['null', 'primitive', 'shape'], ['1', 'primitive', 'shape'], ['"Private"', 'primitive', 'shape'],
      [new Uint8Array([0xff]), 'invalid-utf8', 'decode'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 500, headers: { 'content-type': 'text/plain' } }));
      const observation = lifecycleObservation(1);
      await expect(readLifecycleUploadResponse(env, owner, value, observation)).rejects.toThrow();
      expect(observation).toMatchObject({ status: 500, ok: false, contentType: 'other', bodyType, captureError, code: null });
      expect(serializeLifecycleObservation(observation)).not.toContain('Private');
    }
  });
  it('counts actual incremental bytes, accepts 4096 and refuses overflow without clamping or retaining its chunk', async () => {
    const text = JSON.stringify(conflict).padEnd(4096, ' ');
    fetchMock.mockResolvedValueOnce(new Response(text, { status: 400, headers: { 'content-length': '1' } }));
    const exact = lifecycleObservation(1);
    const result = await readLifecycleUploadResponse(env, owner, value, exact);
    requireLifecycleUploadConflict(result);
    expect(exact.bodyBytes).toBe(4096);
    for (const chunks of [[new Uint8Array(4097)], [new Uint8Array(4096), new Uint8Array(1)]]) {
      const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); }, cancel,
      });
      const reply = new Response(stream, { status: 500, headers: { 'content-length': '4096' } });
      const reader = stream.getReader(), release = vi.spyOn(reader, 'releaseLock');
      vi.spyOn(stream, 'getReader').mockReturnValue(reader); fetchMock.mockResolvedValueOnce(reply);
      const observation = lifecycleObservation(1);
      await expect(readLifecycleUploadResponse(env, owner, value, observation)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(observation).toMatchObject({ status: 500, bodyBytes: null, truncated: true, captureError: 'overflow', code: null });
      expect(cancel).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    }
  });
  for (const mode of ['read', 'cancel', 'release'] as const) {
    it.each(primaryValues)(`preserves exact/falsy ${mode} failure %# and attempts every reader cleanup`, async (first) => {
      const reply = response(conflict), reader = reply.body!.getReader();
      vi.spyOn(reply.body!, 'getReader').mockReturnValue(reader);
      const cancel = vi.spyOn(reader, 'cancel'), release = vi.spyOn(reader, 'releaseLock');
      if (mode === 'read') vi.spyOn(reader, 'read').mockRejectedValueOnce(first);
      if (mode !== 'release') cancel.mockRejectedValueOnce(mode === 'cancel' ? first : cleanupError);
      release.mockImplementationOnce(() => { throw mode === 'release' ? first : cleanupError; });
      log.mockImplementation(() => { throw new Error('Private output failure'); });
      fetchMock.mockResolvedValueOnce(reply);
      const observation = lifecycleObservation(1);
      await rejection(readLifecycleUploadResponse(env, owner, value, observation), first);
      expect(cancel).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
      expect(observation.cancelFailed).toBe(mode !== 'release'); expect(observation.releaseFailed).toBe(true);
      expect(serializeLifecycleObservation(observation)).not.toContain('Private');
      release.mockRestore(); reader.releaseLock();
    });
  }
  it('rejects a failed getReader and retains its observed status without invented body observations', async () => {
    const reply = response(conflict); vi.spyOn(reply.body!, 'getReader').mockImplementation(() => { throw cleanupError; });
    fetchMock.mockResolvedValueOnce(reply);
    const observation = lifecycleObservation(1);
    await rejection(readLifecycleUploadResponse(env, owner, value, observation), cleanupError);
    expect(observation).toMatchObject({ status: 400, captureError: 'read', bodyBytes: null, truncated: null, cancelFailed: false, releaseFailed: null });
  });
  it.each(primaryValues)('preserves header failure %# through body cancellation failure without inventing a parsed object', async (primary) => {
    const reply = response(conflict);
    vi.spyOn(reply.headers, 'get').mockImplementation(() => { throw primary; });
    const cancel = vi.spyOn(reply.body!, 'cancel').mockRejectedValueOnce(cleanupError);
    fetchMock.mockResolvedValueOnce(reply);
    const observation = lifecycleObservation(1);
    await rejection(readLifecycleUploadResponse(env, owner, value, observation), primary);
    expect(cancel).toHaveBeenCalledOnce();
    expect(observation).toMatchObject({ status: 400, captureError: 'headers', bodyBytes: null, code: null, cancelFailed: true, releaseFailed: null });
  });
  it.each(primaryValues)('does not let elapsed observation failure replace primary %#', async (primary) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockImplementationOnce(() => { throw cleanupError; });
    fetchMock.mockRejectedValueOnce(primary);
    const observation = lifecycleObservation(1);
    await rejection(readLifecycleUploadResponse(env, owner, value, observation), primary);
    expect(observation.elapsedMs).toBeNull(); expect(clock).toHaveBeenCalledTimes(2);
  });
  it('enforces closed keys/types/enums/bounds without serializing private properties or invoking accessors', () => {
    const initial = lifecycleObservation(1), text = serializeLifecycleObservation(initial);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(text).not.toMatch(/[\r\n]/); expect(JSON.parse(text)).toEqual(initial);
    for (const change of [
      { private: 'Private' }, { stage: 'Private' }, { ownerOrdinal: 0 }, { ownerOrdinal: 3 }, { status: 99 }, { status: 600 },
      { elapsedMs: -1 }, { elapsedMs: 600001 }, { elapsedMs: 1.1 }, { elapsedMs: NaN }, { bodyBytes: 4097 },
      { bodyBytes: 4096, truncated: true }, { code: 'Private' }, { ok: 'Private' }, { bodyType: 'Private' },
      { captureError: 'Private' }, { code: 'missing' }, { messagePresent: false },
    ]) expect(() => serializeLifecycleObservation({ ...initial, ...change })).toThrow();
    const getter = vi.fn(() => 'Private'), accessor = { ...initial };
    Object.defineProperty(accessor, 'stage', { enumerable: true, get: getter });
    expect(() => serializeLifecycleObservation(accessor)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const stringify = vi.spyOn(JSON, 'stringify');
    stringify.mockReturnValueOnce('x'.repeat(1025));
    expect(() => serializeLifecycleObservation(initial)).toThrow();
    stringify.mockReturnValueOnce('bad\nline');
    expect(() => serializeLifecycleObservation(initial)).toThrow();
    stringify.mockReturnValueOnce('not JSON');
    expect(() => serializeLifecycleObservation(initial)).toThrow();
    stringify.mockReturnValueOnce('{}');
    expect(() => serializeLifecycleObservation(initial)).toThrow();
    stringify.mockImplementationOnce(() => { throw cleanupError; });
    expect(() => serializeLifecycleObservation(initial)).toThrow(cleanupError);
  });
});

describe('I08 bounded security observation definitions (not native/main execution)', () => {
  const cases = ['setup', 'bulk-plain', 'bulk-spoofed', 'alternate-put', 'alternate-copy', 'alternate-move',
    'alternate-sign-upload', 'alternate-tus', 'pending-roundtrip', 'claim-setup'];
  const direct = ['bulk-request', 'alternate-request', 'pending-absence'];
  const opaque = ['track-pending', 'reserve-pending', 'catalog', 'download-owned', 'prepare-alternates',
    'upload-pending', 'remove-pending', 'reupload-pending', 'trash-own', 'trash-peer', 'status-own', 'status-peer',
    'begin-args', 'begin-peer', 'snapshot-peer'];
  const keys = ['schemaVersion', 'ownerOrdinal', 'case', 'stage', 'status', 'ok'];
  afterEach(() => vi.restoreAllMocks());

  it('creates fresh six-field owner-local defaults and rejects all other owner values', () => {
    for (const ownerOrdinal of [1, 2]) {
      const value = securityObservation(ownerOrdinal);
      expect(Reflect.ownKeys(value)).toEqual(keys);
      expect(value).toEqual({ schemaVersion: 1, ownerOrdinal, case: null, stage: null, status: null, ok: null });
      expect(JSON.parse(serializeSecurityObservation(value))).toEqual(value);
      value.status = 400; value.ok = false;
      expect(securityObservation(ownerOrdinal)).toMatchObject({ case: null, stage: null, status: null, ok: null });
    }
    for (const owner of [undefined, null, 0, 3, -1, 1.1, NaN, Infinity, '1', true, {}, []]) {
      expect(() => securityObservation(owner)).toThrow('EVIDENCE_REQUIRED');
    }
  });
  it('pins all ten cases, three direct stages and fifteen opaque stages without borrowing a response', () => {
    expect(cases).toHaveLength(10); expect(direct).toHaveLength(3); expect(opaque).toHaveLength(15);
    for (const caseName of [null, ...cases]) {
      for (const stage of [null, ...direct, ...opaque]) {
        const value = { ...securityObservation(2), case: caseName, stage };
        expect(JSON.parse(serializeSecurityObservation(value))).toEqual(value);
        const returned = { ...value, status: 400, ok: false };
        if (stage !== null && direct.includes(stage)) {
          expect(JSON.parse(serializeSecurityObservation(returned))).toEqual(returned);
        } else expect(() => serializeSecurityObservation(returned)).toThrow('EVIDENCE_REQUIRED');
      }
    }
    for (const status of [100, 200, 400, 499, 500, 599]) {
      for (const ok of [true, false]) {
        const value = { ...securityObservation(1), case: 'bulk-plain', stage: 'bulk-request', status, ok };
        expect(JSON.parse(serializeSecurityObservation(value))).toEqual(value);
      }
    }
  });
  it('rejects invalid scalars, mismatched null pairs, private/extra/symbol/missing keys before serialization', () => {
    const base = { ...securityObservation(1), case: 'bulk-plain', stage: 'bulk-request', status: 400, ok: false };
    const stringify = vi.spyOn(JSON, 'stringify');
    for (const change of [
      { schemaVersion: 2 }, { schemaVersion: '1' }, { ownerOrdinal: null }, { ownerOrdinal: 0 }, { ownerOrdinal: 3 },
      { ownerOrdinal: '1' }, { case: 'Private owner/path' }, { case: 1 }, { stage: 'Private token/body' }, { stage: {} },
      { status: undefined }, { status: '400' }, { status: true }, { status: 99 }, { status: 600 },
      { status: 400.1 }, { status: NaN }, { status: Infinity }, { status: -Infinity },
      { ok: undefined }, { ok: 'false' }, { ok: 0 }, { ok: {} }, { status: null }, { ok: null },
      { private: 'Private token/UUID/URL/body/image' }, { [Symbol('Private')]: 'Private' },
    ]) expect(() => serializeSecurityObservation({ ...base, ...change })).toThrow('EVIDENCE_REQUIRED');
    for (const value of [null, undefined, 1, true, 'Private', [], Object.create(base)]) {
      expect(() => serializeSecurityObservation(value)).toThrow('EVIDENCE_REQUIRED');
    }
    for (const key of keys) {
      const missing = { ...base };
      Reflect.deleteProperty(missing, key);
      expect(() => serializeSecurityObservation(missing)).toThrow('EVIDENCE_REQUIRED');
      const getter = vi.fn(() => 'Private'), accessor = { ...base };
      Object.defineProperty(accessor, key, { enumerable: true, get: getter });
      expect(() => serializeSecurityObservation(accessor)).toThrow('EVIDENCE_REQUIRED');
      expect(getter).not.toHaveBeenCalled();
    }
    const hidden = { ...base };
    Object.defineProperty(hidden, 'private', { value: 'Private', enumerable: false });
    expect(() => serializeSecurityObservation(hidden)).toThrow('EVIDENCE_REQUIRED');
    expect(stringify).not.toHaveBeenCalled();
  });
  it('bounds the longest real enums and rejects serializer/size/newline/round-trip failures', () => {
    const value = { ...securityObservation(2), case: 'alternate-sign-upload', stage: 'prepare-alternates' };
    for (const longest of [value, { ...value, stage: 'alternate-request', status: 599, ok: false }]) {
      const text = serializeSecurityObservation(longest);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512);
      expect(text).not.toMatch(/[\r\n]/); expect(JSON.parse(text)).toEqual(longest);
    }
    const stringify = vi.spyOn(JSON, 'stringify');
    for (const bad of ['x'.repeat(513), '\u00e9'.repeat(257), 'bad\nline', 'bad\rline', 'not JSON', '{}', 'null']) {
      stringify.mockReturnValueOnce(bad);
      expect(() => serializeSecurityObservation(value)).toThrow();
    }
    const privateError = new Error('Private serializer failure');
    stringify.mockImplementationOnce(() => { throw privateError; });
    expect(() => serializeSecurityObservation(value)).toThrow(privateError);
  });
  it.each([new Error('Private failure'), undefined, null, false, 0, ''])(
    'illustrates null reset and exact/falsy stub propagation without invoking the runner %#', async (primary) => {
      const value = { ...securityObservation(1), case: 'bulk-plain', stage: 'bulk-request', status: 200, ok: true };
      const stub = vi.fn().mockRejectedValueOnce(primary);
      const flow = (async () => {
        Object.assign(value, { case: 'alternate-put', stage: 'alternate-request', status: null, ok: null });
        const result = await stub();
        Object.assign(value, { status: result.status, ok: result.ok });
      })();
      await expect(flow).rejects.toBe(primary);
      expect(stub).toHaveBeenCalledOnce();
      expect(JSON.parse(serializeSecurityObservation(value))).toMatchObject({
        case: 'alternate-put', stage: 'alternate-request', status: null, ok: null,
      });
    },
  );
  it('illustrates returned-result assertion evidence followed by opaque-call clearing, not native execution', async () => {
    const value = securityObservation(2), primary = new Error('Private assertion');
    const stub = vi.fn().mockResolvedValueOnce({ status: 400, ok: false });
    const flow = (async () => {
      Object.assign(value, { case: 'bulk-spoofed', stage: 'bulk-request', status: null, ok: null });
      const result = await stub();
      Object.assign(value, { status: result.status, ok: result.ok });
      throw primary;
    })();
    await expect(flow).rejects.toBe(primary);
    expect(JSON.parse(serializeSecurityObservation(value))).toMatchObject({ status: 400, ok: false });
    Object.assign(value, { case: 'bulk-spoofed', stage: 'download-owned', status: null, ok: null });
    expect(JSON.parse(serializeSecurityObservation(value))).toMatchObject({ stage: 'download-owned', status: null, ok: null });
  });
  it('pins per-owner reset, boundary operations, direct captures and opaque helper stages in actual source', async () => {
    const source = await read('tests/security/item-lifecycle.sessions.mjs');
    const body = source.slice(source.indexOf('async function main()'));
    const boundary = body.slice(body.indexOf("      phase = 'native-operation-boundary';"), body.indexOf("      phase = 'foreign-and-absent';"));
    const reset = (caseName: string, stage: string) =>
      `Object.assign(observation, { case: ${caseName}, stage: '${stage}', status: null, ok: null });`;
    ordered(body, [
      'let observation = null;', 'for (const [index, owner] of owners.entries())',
      "phase = 'legacy-orphan-privacy';", 'await legacyOrphanCase(client, owner, owners[1 - index], h);',
      'const own = await h.create(), foreign = await peer.create();', "phase = 'native-operation-boundary';",
      'observation = null;', 'observation = securityObservation(index + 1);',
    ]);
    ordered(boundary, [
      reset("'setup'", 'track-pending'), 'const pending = h.track(intent());',
      reset("'setup'", 'reserve-pending'), 'await h.reserve(pending);',
      reset("'setup'", 'catalog'), 'const originalCatalog = await catalog();',
      "const caseName = ['bulk-plain', 'bulk-spoofed'][bulkIndex];", reset('caseName', 'bulk-request'),
      "const bulk = await client.request(owner.token, '/storage/v1/object/wardrobe',",
      "requireEvidence(Number.isInteger(bulk.status) && bulk.status >= 100 && bulk.status <= 599 && typeof bulk.ok === 'boolean');",
      'Object.assign(observation, { status: bulk.status, ok: bulk.ok });',
      'requireEvidence(bulk.status < 500);', 'if (bulk.ok) eq(bulk.data, []);',
      reset('caseName', 'download-owned'), 'for (const path of h.paths(own)) {',
      reset('caseName', 'download-owned'), 'await h.download(path);',
      reset('caseName', 'catalog'), 'eq(await catalog(), originalCatalog);',
      reset("'setup'", 'prepare-alternates'), 'const alternates = [',
      'requireEvidence(alternates.length === 5 && alternateCases.length === 5);',
      'for (const [alternateIndex, [route, options]] of alternates.entries())',
      'const caseName = alternateCases[alternateIndex];', reset('caseName', 'alternate-request'),
      'const response = await client.request(owner.token, route, { ...options, headers: {',
      "requireEvidence(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 && typeof response.ok === 'boolean');",
      'Object.assign(observation, { status: response.status, ok: response.ok });',
      'requireEvidence(!response.ok && response.status < 500);',
      reset('caseName', 'download-owned'), 'for (const path of h.paths(own)) {',
      reset('caseName', 'download-owned'), 'await h.download(path);',
      reset('caseName', 'catalog'), 'eq(await catalog(), originalCatalog);',
      reset('caseName', 'pending-absence'),
      'const absent = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${h.paths(pending)[0]}`);',
      "requireEvidence(Number.isInteger(absent.status) && absent.status >= 100 && absent.status <= 599 && typeof absent.ok === 'boolean');",
      'Object.assign(observation, { status: absent.status, ok: absent.ok });', 'requireEvidence(!absent.ok);',
      reset("'pending-roundtrip'", 'upload-pending'), 'await h.upload(pending);',
      reset("'pending-roundtrip'", 'remove-pending'),
      'for (const path of h.paths(pending)) {', reset("'pending-roundtrip'", 'remove-pending'),
      "eq(await deleteWardrobeObject((route, options) => client.request(owner.token, route, options), owner.uid, path), 'removed');",
      reset("'pending-roundtrip'", 'reupload-pending'), 'await h.upload(pending);',
      reset("'claim-setup'", 'trash-own'), 'await h.trash(own, 1);',
      reset("'claim-setup'", 'trash-peer'), 'await peer.trash(foreign, 1);',
      reset("'claim-setup'", 'status-own'), 'const ownPreview = await h.status(own);',
      reset("'claim-setup'", 'status-peer'), 'const foreignPreview = await peer.status(foreign);',
      reset("'claim-setup'", 'begin-args'), 'const peerArgs = peer.beginArgs(foreign, foreignPreview);',
      reset("'claim-setup'", 'begin-peer'), 'await peer.begin(peerArgs);',
      reset("'claim-setup'", 'snapshot-peer'), 'const foreignBefore = await peer.snapshot(foreign);',
    ]);
    expect(boundary).not.toMatch(/\bcatch\b|\btry\b|\.catch\s*\(|\bfetch\s*\(|console\./);
    expect([...boundary.matchAll(/Object\.assign\(observation, \{ status:/g)]).toHaveLength(3);
    expect(source).toContain("const alternateCases = ['alternate-put', 'alternate-copy', 'alternate-move', 'alternate-sign-upload', 'alternate-tus'];");
    expect(source).toContain("const securityCases = ['setup', 'bulk-plain', 'bulk-spoofed', ...alternateCases, 'pending-roundtrip', 'claim-setup'];");
    expect(source).toContain(`const directStages = ['${direct.join("', '")}'];`);
    expect(source).toContain(`const opaqueStages = ['${opaque.slice(0, 5).join("', '")}',\n  '${opaque.slice(5, 12).join("', '")}',\n  '${opaque.slice(12).join("', '")}'];`);
    expect(boundary.slice(boundary.indexOf('      const catalog = async () => {'), boundary.indexOf(reset("'setup'", 'catalog'))).trimEnd()).toBe([
      '      const catalog = async () => {',
      "        const result = await client.request(owner.token, '/storage/v1/object/list/wardrobe', {",
      "          method: 'POST', body: { prefix: `${owner.uid}/${own.p_item.id}/${own.p_image.id}/`, limit: 10, offset: 0 },",
      '        });',
      '        requireEvidence(result.ok && Array.isArray(result.data) && result.data.length === 2);',
      '        return result.data.map(({ id, name, metadata }) => ({ id, name, metadata })).sort((a, b) => a.name.localeCompare(b.name));',
      '      };',
    ].join('\n'));
    expect([...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]))
      .toEqual(['securityObservation', 'serializeSecurityObservation']);
  });
  it('pins guarded failure-only capture without masking coarse failure, exit or original cleanup', async () => {
    const source = await read('tests/security/item-lifecycle.sessions.mjs');
    expect(source.slice(source.lastIndexOf('  } catch {'))).toBe(`  } catch {
    console.error(\`FAIL: I08 security \${phase}; evidence required; private details suppressed\`);
    process.exitCode = 1;
    if (phase === 'native-operation-boundary' && observation !== null) {
      try { console.error(\`I08 security observation: \${serializeSecurityObservation(observation)}\`); } catch {
        try { console.error('FAIL: I08 security observation capture'); } catch {
          // The primary failure is already reported; diagnostics must not prevent cleanup.
        }
      }
    }
  } finally {
    for (const h of harnesses) {
      try { await h.cleanup(); } catch { console.error('FAIL: I08 exact security cleanup'); process.exitCode = 1; }
    }
  }
}
if (isMain(import.meta.url)) await main();
`);
    expect([...source.matchAll(/serializeSecurityObservation\(observation\)/g)]).toHaveLength(2);
    expect(source).not.toMatch(/catch\s*\([^)]*\)/);
  });
});
