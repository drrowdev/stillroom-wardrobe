import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import { editGarmentField, newGarmentDraft } from '../../src/domain/garment-fields';
import { newSaveAttempt, saveItem } from '../../src/images/upload';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { ITEM_LIFECYCLE_CATALOG_SQL, assertLifecycleFixture, MIGRATIONS, withLifecycleParentLock, withLifecycleCatalogMarker } from '../../scripts/preservation-rehearsal.mjs';
// @ts-expect-error Executable normal-session JavaScript has no TypeScript declaration.
import { one, lifecycleObservation, serializeLifecycleObservation, readLifecycleUploadResponse, requireLifecycleUploadConflict, lifecycleFixtureCases } from '../integration/item-lifecycle.sessions.mjs';

const fixtureMocks = vi.hoisted(() => ({
  spawn: vi.fn(), requireLocalContainer: vi.fn(), privilegedLocalSql: vi.fn(), commandEnvironment: vi.fn(), saveClients: vi.fn(),
}));
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<Record<string, unknown>>('node:child_process'), spawn: fixtureMocks.spawn,
}));
vi.mock('../../scripts/backend/local.mjs', async () => ({
  ...await vi.importActual<Record<string, unknown>>('../../scripts/backend/local.mjs'),
  requireLocalContainer: fixtureMocks.requireLocalContainer,
  privilegedLocalSql: fixtureMocks.privilegedLocalSql, commandEnvironment: fixtureMocks.commandEnvironment,
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

describe('I08 SQL source contract, not live database proof', () => {
  it('has only four public RPCs and no public table/fingerprint/export edits', () => {
    expect([...sql.matchAll(/create function public\.(\w+)/g)].map((match) => match[1])).toEqual([
      'set_item_trashed', 'item_deletion_status', 'begin_item_deletion', 'finish_item_deletion',
    ]);
    expect(sql).not.toMatch(/alter table public|create (?:or replace )?function public\.(?:export|reserve|commit|finalize)|ai_|set_config|current_setting|when others|pg_sleep|\bloop\b/i);
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
    expect(routine('private.may_create_item_object')).toContain("errcode='22023',message='Request conflict'");
    expect(sql.match(/drop policy/g)).toHaveLength(1);
    expect(sql).toContain("with check (bucket_id='wardrobe' and private.may_create_item_object(name))");
    expect(sql).not.toMatch(/wardrobe_read|wardrobe_delete|owns_storage_path/);
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
    expect(entries).toHaveLength(9);
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
        expect(statements[1]).toContain('delete from storage.objects');
        expect(statements[2]).toContain('select count(*) from storage.objects');
        const markerId = statements[0]?.match(/values\('([0-9a-f-]+)'/)?.[1];
        expect(markerId).toBeDefined();
        for (const statement of statements.slice(1)) {
          expect(statement).toContain(`id='${markerId}'`);
          expect(statement).toContain(`${owner}/${item}/i08-catalog-marker`);
        }
        expect(fixtureMocks.spawn).not.toHaveBeenCalled();
        expect(fixtureMocks.requireLocalContainer).not.toHaveBeenCalled();
      },
    };
  }
  const markerFailures: MarkerMode[] = ['delete-throw', 'delete-reject', 'delete-count', 'absence-throw', 'absence-reject', 'absence-count'];
  it('removes and verifies the exact marker after success', async () => {
    const fixture = marker(), operation = vi.fn(async () => {});
    await expect(withLifecycleCatalogMarker(owner, item, operation)).resolves.toBeUndefined();
    fixture.assertCleaned(); expect(operation).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
  });
  it.each(primaryValues)('preserves exact marker operation rejection %# with successful cleanup', async (primary) => {
    const fixture = marker();
    await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
    fixture.assertCleaned(); expect(log).not.toHaveBeenCalled();
  });
  it.each(markerFailures)('rejects marker cleanup-only %s, retaining deletion and absence checks', async (mode) => {
    const fixture = marker(mode);
    await expect(withLifecycleCatalogMarker(owner, item, async () => {})).rejects.toThrow(
      mode.endsWith('count') ? 'EVIDENCE_REQUIRED' : cleanupError.message,
    );
    fixture.assertCleaned(); expect(log.mock.calls).toEqual([[markerNotice]]);
  });
  for (const mode of markerFailures) {
    it.each(primaryValues)(`preserves exact/falsy marker operation rejection %# through ${mode}`, async (primary) => {
      const fixture = marker(mode);
      await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
      fixture.assertCleaned(); expect(log.mock.calls).toEqual([[markerNotice]]);
    });
  }
  for (const mode of ['ok', ...markerFailures] as MarkerMode[]) {
    it.each(primaryValues)(`preserves marker setup rejection %# through ${mode}`, async (primary) => {
      const fixture = marker(mode, { error: primary }), operation = vi.fn();
      await rejection(withLifecycleCatalogMarker(owner, item, operation), primary);
      fixture.assertCleaned(); expect(operation).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual(mode === 'ok' ? [] : [[markerNotice]]);
    });
  }
  it.each(['0', '1'])('retains strict uncertain-setup cleanup count %s', async (count) => {
    const fixture = marker('ok', { error: privateError }, count);
    await rejection(withLifecycleCatalogMarker(owner, item, vi.fn()), privateError);
    fixture.assertCleaned(); expect(log).not.toHaveBeenCalled();
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
  });
  it.each(primaryValues)('retains marker primary %# when cleanup and its notice both fail', async (primary) => {
    const fixture = marker('absence-reject');
    log.mockImplementation(() => { throw cleanupError; });
    await rejection(withLifecycleCatalogMarker(owner, item, async () => { throw primary; }), primary);
    fixture.assertCleaned();
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
    let output: ReturnType<typeof vi.spyOn>, notices: ReturnType<typeof vi.spyOn>;
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
    function fixture(fault?: { at: 'before' | 'rows' | 'insert' | 'status' | 'release' | 'reserve'; value: unknown },
      cleanup?: { value: unknown }) {
      const rows = new Map<string, { item: Record<string, unknown>; image: Record<string, unknown>;
        reservation: Record<string, unknown>; requestId: unknown; expected: unknown }>();
      const events: string[] = [];
      let held: string | null = null, marker = false, cleanupStarted = false;
      const conflict = () => ({ ok: false, status: 400, data: { code: '22023', message: 'Request conflict', details: null, hint: null } });
      const request = vi.fn(async (token: string, route: string, options: { method?: string; body?: unknown } = {}) => {
        const owner = owners.find((candidate) => candidate.token === token);
        if (!owner) throw new Error('Unexpected mock owner');
        const body = options.body === undefined ? {} : object(options.body);
        let row = rows.get(owner.uid);
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
        if (route.startsWith('/storage/v1/object/wardrobe')) return { ok: true, status: 200, data: [] };
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
        held = mode;
        try { await operation(); } finally { held = null; events.push('holder-settled'); }
        if (fault?.at === 'release') throw fault.value;
      });
      const withLifecycleCatalogMarker = vi.fn(async (_owner: string, _item: string, operation: () => Promise<void>) => {
        marker = true;
        try { await operation(); } finally { marker = false; }
      });
      return { request, events, withLifecycleParentLock, withLifecycleCatalogMarker,
        isHeld: () => held !== null, cleanupStarted: () => cleanupStarted };
    }
    function records() {
      return output.mock.calls.filter(([line]) => typeof line === 'string' && line.startsWith('{')).map(([line]) => JSON.parse(line));
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
      expect(f.withLifecycleCatalogMarker).toHaveBeenCalledTimes(2);
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
    it.each(primaryValues)('retains exact/falsy cleanup-only rejection %# without a success-shaped outer result', async (first) => {
      const f = fixture(undefined, { value: first });
      notices.mockImplementation(() => { throw secondary; });
      await rejection(lifecycleFixtureCases(env, f), first);
      expect(records()).toHaveLength(1); expect(records()[0].stage).toBe('released');
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
