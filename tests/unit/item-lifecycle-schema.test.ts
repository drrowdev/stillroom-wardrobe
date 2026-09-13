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
import { one } from '../integration/item-lifecycle.sessions.mjs';

const fixtureMocks = vi.hoisted(() => ({
  spawn: vi.fn(), requireLocalContainer: vi.fn(), privilegedLocalSql: vi.fn(), commandEnvironment: vi.fn(),
}));
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<Record<string, unknown>>('node:child_process'), spawn: fixtureMocks.spawn,
}));
vi.mock('../../scripts/backend/local.mjs', async () => ({
  ...await vi.importActual<Record<string, unknown>>('../../scripts/backend/local.mjs'),
  requireLocalContainer: fixtureMocks.requireLocalContainer,
  privilegedLocalSql: fixtureMocks.privilegedLocalSql, commandEnvironment: fixtureMocks.commandEnvironment,
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
});
