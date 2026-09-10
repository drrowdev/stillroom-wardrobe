import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import { garmentFields, editGarmentField, newGarmentDraft } from '../../src/domain/garment-fields';
import { provenanceFields } from '../../src/domain/attribute-provenance';
import { newSaveAttempt, saveItem } from '../../src/images/upload';
// @ts-expect-error Executable normal-session JavaScript has no TypeScript declaration.
import { intent, denied, boundedRace, manualFields, equalAiStatusState } from '../integration/item-save.sessions.mjs';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { ITEM_SAVE_CATALOG_SQL } from '../../scripts/preservation-rehearsal.mjs';

const sql = await readFile(new URL('../../supabase/migrations/20260910070000_checked_item_save.sql', import.meta.url), 'utf8');
describe('checked manual Save source contract (not database execution)', () => {
  it('uses the same thirty manual fields and only explicit user assertions', () => {
    const value = intent();
    expect(Object.keys(value.p_item).sort()).toEqual([...garmentFields, 'id', 'field_provenance'].sort());
    expect(manualFields).toEqual(provenanceFields);
    expect(value.p_item.field_provenance).toEqual({ title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } });
    expect(value.p_image.alt_text).toBe('');
    expect(intent().p_item.id).not.toBe(value.p_item.id);
    expect(intent().p_image.id).not.toBe(value.p_image.id);
    for (const field of garmentFields) expect(sql).toContain(`'${field}'`);
  });
  it('keeps the A1 marker to exactly three non-null UUIDs and owner-local keys', () => {
    const marker = sql.match(/create table private\.item_save_used_ids \(([\s\S]*?)\n\);/)?.[1];
    expect(marker).toBeDefined();
    expect([...marker!.matchAll(/^\s+(\w+) uuid not null/gm)].map((match) => match[1]))
      .toEqual(['owner_id', 'item_id', 'image_id']);
    expect(marker).toContain('primary key(owner_id,item_id)');
    expect(marker).toContain('unique(owner_id,image_id)');
    expect(marker).toContain('references public.profiles(owner_id) on delete cascade');
    expect(marker).not.toMatch(/timestamp|fingerprint|status|ordinal|count|public\.items|public\.item_images/);
  });
  it('cascades content but nulls only the actual image link on media cleanup', () => {
    const attempts = sql.match(/create table private\.item_save_attempts \(([\s\S]*?)\n\);/)?.[1];
    expect(attempts).toContain('references public.items(owner_id,id) on delete cascade');
    expect(attempts).toContain('references public.item_images(owner_id,item_id,id)');
    expect(attempts).toContain('on delete set null(image_id)');
    expect(attempts).not.toContain('references private.item_save_used_ids');
    expect(attempts).not.toMatch(/\b(title|caption|field_provenance|model|facts)\b/);
  });
  it('moves rather than rewrites the legacy helper and preserves its existing grants', () => {
    expect(sql).toContain('alter function public.commit_image(uuid) set schema private');
    expect(sql).toContain('alter function private.commit_image(uuid) rename to commit_item_save_image');
    expect(sql).toContain('revoke all on function private.commit_item_save_image(uuid) from public,anon,authenticated');
    expect(sql).toContain('grant execute on function public.commit_image(uuid) to service_role');
    expect(sql).not.toMatch(/revoke (?:insert|update|delete) on public\.(?:items|item_images)/);
    expect(sql).not.toMatch(/set_config|current_setting|create extension|public\.ai_/);
  });
  it('guards both used identities, completed objects, exact counters and bounded lock conflicts', () => {
    expect(sql).toContain('u.owner_id=v_owner and (u.item_id=im.item_id or u.image_id=im.id)');
    expect(sql).toContain('u.owner_id=v_owner and (u.item_id=i.id or u.image_id=im.id)');
    expect(sql).toContain('im.description_version<>1');
    expect(sql).toContain('i.version<>1 or i.deleted_at is not null');
    expect(sql).toContain("if a.state='completed' then");
    expect(sql).toContain('for share nowait');
    expect(sql).toContain("set lock_timeout = '2s'");
    expect(sql).not.toMatch(/when others|on conflict.*do nothing/i);
  });
  it('statically keeps the IF state CASE parenthesized (not real SQL execution proof)', () => {
    const current = sql.match(/create function private\.item_save_current\b[\s\S]*?\$\$;/)?.[0];
    expect(current).toContain("or im.state<>(case a.state when 'reserved' then 'pending' else 'ready' end) then");
  });
  it('statically waits for legacy ready media before target and parent locks, retaining later NOWAIT checks', () => {
    const wrapper = sql.match(/create function public\.commit_image\b[\s\S]*?\$\$;/)?.[0];
    expect(wrapper).toBeDefined();
    const steps = [
      'v_owner := private.item_save_owner();',
      'select item_id into v_item_id from public.item_images where owner_id=v_owner and id=p_image_id;',
      "if not found then raise exception using errcode='42501',message='Not available'; end if;",
      "perform 1 from public.item_images where owner_id=v_owner and item_id=v_item_id and state='ready' for update;",
      'select * into im from public.item_images where owner_id=v_owner and id=p_image_id for update nowait;',
      "if not found then raise exception using errcode='42501',message='Not available'; end if;",
      'if im.owner_id is distinct from v_owner or im.item_id is distinct from v_item_id then',
      "raise exception using errcode='22023',message='Request conflict';",
      'u.owner_id=v_owner and (u.item_id=im.item_id or u.image_id=im.id)',
      'perform 1 from public.items where owner_id=v_owner and id=im.item_id for update nowait;',
      "perform 1 from public.item_images where owner_id=v_owner and item_id=im.item_id and state='ready' for update nowait;",
      'perform private.commit_item_save_image(p_image_id);',
      "exception when lock_not_available then raise exception using errcode='22023',message='Request conflict';",
    ];
    let offset = 0;
    for (const step of steps) {
      const found = wrapper!.indexOf(step, offset);
      expect(found).toBeGreaterThanOrEqual(offset);
      offset = found + step.length;
    }
    expect(wrapper).toContain("set lock_timeout = '2s'");
    expect(wrapper!.match(/for update nowait/g)).toHaveLength(3);
    expect(wrapper!.match(/for update;/g)).toHaveLength(1);
    expect(wrapper).not.toMatch(/when others|deadlock_detected|40P01|pg_sleep|\bloop\b/i);
  });
  it('keeps structural cascade checks separate from destructive fixture or user-journey claims', () => {
    expect(ITEM_SAVE_CATALOG_SQL).toContain('pg_catalog.pg_constraint');
    expect(ITEM_SAVE_CATALOG_SQL).toContain('ON DELETE CASCADE');
    expect(ITEM_SAVE_CATALOG_SQL).toContain('ON DELETE SET NULL (image_id)');
    expect(ITEM_SAVE_CATALOG_SQL).not.toMatch(/^\s*(delete|update|insert|create|alter|grant)\b/im);
    expect(ITEM_SAVE_CATALOG_SQL).not.toMatch(/from private\.item_save_used_ids|from private\.item_save_attempts/);
  });
  it('does not turn a generic server failure or partial response into a conflict pass', () => {
    const result = { ok: false, status: 400, data: { code: '22023', message: 'Request conflict', details: null, hint: null } };
    expect(() => denied(result)).not.toThrow();
    for (const changed of [{ ok: true }, { status: 500 }, { data: { ...result.data, message: 'Other' } },
      { data: { ...result.data, details: 'untrusted' } }]) expect(() => denied({ ...result, ...changed })).toThrow();
  });
  it('awaits all bounded operations and rejects non-contract errors', async () => {
    await expect(boundedRace([async () => ({ ok: true }), async () => ({ ok: true })])).resolves.toHaveLength(2);
    await expect(boundedRace([async () => ({ ok: false, status: 500 })])).rejects.toThrow();
  });
});

describe('approved-owner full AI status comparison', () => {
  const status = () => ({
    code: 'OK', period: '2026-09', serverTimeMs: 1000,
    consent: { enabled: true, noticeRevision: 1, consentedAt: '2026-09-10T00:00:00Z', profileVersion: '2' },
    policy: {
      activated: true, noticeRevision: 1, modelId: 'fictional:controls/v1', promptVersion: 1,
      maxRequestMicro: '5000', monthlyAllowanceMicro: '15000', maxRequestsPerHour: 20, resultTtlSeconds: 3600,
    },
    usage: { accountedMicro: '100', requestsLastHour: 2, warning: false },
  });

  it.each([1000, 1001, 999, 0, Number.MAX_SAFE_INTEGER])('accepts clock-only value %s without mutating either input', (clock) => {
    const left = status(), right = { ...status(), serverTimeMs: clock };
    const leftBefore = structuredClone(left), rightBefore = structuredClone(right);
    equalAiStatusState(left, right);
    expect(left).toStrictEqual(leftBefore);
    expect(right).toStrictEqual(rightBefore);
  });

  it.each([
    ['missing', {}], ['undefined', { serverTimeMs: undefined }], ['string', { serverTimeMs: '1000' }],
    ['null', { serverTimeMs: null }], ['fractional', { serverTimeMs: 1.5 }], ['negative', { serverTimeMs: -1 }],
    ['unsafe', { serverTimeMs: Number.MAX_SAFE_INTEGER + 1 }], ['NaN', { serverTimeMs: NaN }],
    ['infinite', { serverTimeMs: Infinity }], ['negative infinite', { serverTimeMs: -Infinity }],
  ])('rejects %s clocks on either side', (_label, clock) => {
    const malformed: Record<string, unknown> = status();
    delete malformed.serverTimeMs;
    Object.assign(malformed, clock);
    expect(() => equalAiStatusState(malformed, status())).toThrow('EVIDENCE_REQUIRED');
    expect(() => equalAiStatusState(status(), malformed)).toThrow('EVIDENCE_REQUIRED');
  });

  it.each([null, undefined, [], [1000], 'status', 1000, true, () => ({ serverTimeMs: 1000 })])(
    'rejects malformed input %# on either side', (malformed) => {
      expect(() => equalAiStatusState(malformed, status())).toThrow('EVIDENCE_REQUIRED');
      expect(() => equalAiStatusState(status(), malformed)).toThrow('EVIDENCE_REQUIRED');
    },
  );

  it('requires an own clock, not an inherited property', () => {
    const inherited = Object.assign(Object.create({ serverTimeMs: 1000 }), status());
    delete inherited.serverTimeMs;
    expect(() => equalAiStatusState(inherited, status())).toThrow('EVIDENCE_REQUIRED');
    expect(() => equalAiStatusState(status(), inherited)).toThrow('EVIDENCE_REQUIRED');
  });

  it('intentionally rejects code-only UNAVAILABLE responses', () => {
    expect(() => equalAiStatusState({ code: 'UNAVAILABLE' }, { code: 'UNAVAILABLE' })).toThrow('EVIDENCE_REQUIRED');
  });

  it.each([
    ['code', { code: 'INACTIVE' }], ['period', { period: '2026-10' }],
    ['consent enabled', { consent: { ...status().consent, enabled: false } }],
    ['consent notice', { consent: { ...status().consent, noticeRevision: 2 } }],
    ['consent time', { consent: { ...status().consent, consentedAt: null } }],
    ['profile version', { consent: { ...status().consent, profileVersion: '3' } }],
    ['policy', { policy: null }],
    ['policy activation', { policy: { ...status().policy, activated: false } }],
    ['policy notice', { policy: { ...status().policy, noticeRevision: 2 } }],
    ['policy model', { policy: { ...status().policy, modelId: 'fictional:controls/v2' } }],
    ['policy prompt', { policy: { ...status().policy, promptVersion: 2 } }],
    ['policy request maximum', { policy: { ...status().policy, maxRequestMicro: '5001' } }],
    ['policy monthly allowance', { policy: { ...status().policy, monthlyAllowanceMicro: '15001' } }],
    ['policy hourly maximum', { policy: { ...status().policy, maxRequestsPerHour: 21 } }],
    ['policy expiry', { policy: { ...status().policy, resultTtlSeconds: 3601 } }],
    ['accounting', { usage: { ...status().usage, accountedMicro: '101' } }],
    ['hourly count', { usage: { ...status().usage, requestsLastHour: 3 } }],
    ['warning', { usage: { ...status().usage, warning: true } }],
    ['unknown added key', { unexpected: null }],
    ['unknown nested key', { usage: { ...status().usage, unexpected: null } }],
  ])('rejects non-clock change: %s', (_label, change) => {
    const left = status(), right = { ...status(), ...change };
    const leftBefore = structuredClone(left), rightBefore = structuredClone(right);
    expect(() => equalAiStatusState(left, right)).toThrow('EVIDENCE_REQUIRED');
    expect(() => equalAiStatusState(right, left)).toThrow('EVIDENCE_REQUIRED');
    expect(left).toStrictEqual(leftBefore);
    expect(right).toStrictEqual(rightBefore);
  });

  it.each(['code', 'period', 'consent', 'policy', 'usage'])('rejects missing non-clock key %s', (key) => {
    const missing: Record<string, unknown> = status();
    delete missing[key];
    expect(() => equalAiStatusState(status(), missing)).toThrow('EVIDENCE_REQUIRED');
    expect(() => equalAiStatusState(missing, status())).toThrow('EVIDENCE_REQUIRED');
  });

  it('compares unknown nested values, missing nested keys and nested serverTimeMs exactly', () => {
    const left = { ...status(), unexpected: { serverTimeMs: 1, values: [null, { count: 2 }] } };
    for (const unexpected of [
      { serverTimeMs: 2, values: [null, { count: 2 }] },
      { serverTimeMs: 1, values: [null, { count: 3 }] },
      { serverTimeMs: 1 },
    ]) {
      const right = { ...status(), unexpected };
      expect(() => equalAiStatusState(left, right)).toThrow('EVIDENCE_REQUIRED');
      expect(() => equalAiStatusState(right, left)).toThrow('EVIDENCE_REQUIRED');
    }
    const missing = { ...status(), usage: { accountedMicro: '100', warning: false } };
    expect(() => equalAiStatusState(status(), missing)).toThrow('EVIDENCE_REQUIRED');
    expect(() => equalAiStatusState(missing, status())).toThrow('EVIDENCE_REQUIRED');
  });
});

describe('connected checked manual Save (actual SDK, synthetic HTTP)', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const reservePath = '/rest/v1/rpc/reserve_item_save', finalizePath = '/rest/v1/rpc/finalize_item_save';
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  function setup() {
    const controller = new AbortController();
    const scope: OwnerScope = { ownerId: owner, epoch: 3, signal: controller.signal };
    let draft = editGarmentField(editGarmentField(newGarmentDraft('EUR', 'fi'), 'title', 'Shirt', 'fi'), 'category', 'top', 'fi');
    draft = editGarmentField(draft, 'purchase_price', '0,10', 'fi');
    draft = editGarmentField(draft, 'warmth', '', 'fi');
    const main = new Blob(['synthetic-main'], { type: 'image/jpeg' }), thumb = new Blob(['synthetic-thumb'], { type: 'image/jpeg' });
    const attempt = newSaveAttempt(draft, '', {
      main, thumb, width: 2, height: 3,
      mainSha256: createHash('sha256').update('synthetic-main').digest('hex'),
      thumbSha256: createHash('sha256').update('synthetic-thumb').digest('hex'),
    }, scope);
    const prefix = `${owner}/${attempt.itemId}/${attempt.imageId}`, now = '2026-09-10T00:00:00Z';
    const row = {
      fingerprint: 'c'.repeat(64), state: 'reserved',
      item: { ...attempt.payload, id: attempt.itemId, owner_id: owner, version: 1, deleted_at: null, created_at: now, updated_at: now },
      image: { id: attempt.imageId, item_id: attempt.itemId, owner_id: owner, state: 'pending', retired_at: null,
        description_version: 1, alt_text: '', main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`,
        main_bytes: main.size, thumb_bytes: thumb.size, width: 2, height: 3,
        main_sha256: attempt.photo.mainSha256, thumb_sha256: attempt.photo.thumbSha256, created_at: now },
    };
    const files = new Map<string, Blob>();
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const normal = (path: string, init?: RequestInit): Response => {
      if (path === reservePath) return reply([row]);
      if (path === finalizePath) {
        row.state = 'completed'; row.image.state = 'ready';
        return new Response(null, { status: 204 });
      }
      if (!path.startsWith('/storage/v1/object/')) throw new Error('Unexpected test route');
      if (init?.method === 'POST') {
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body;
        if (!(form instanceof FormData)) throw new Error('Unexpected test body');
        expect(form.get('cacheControl')).toBe('0');
        expect(new Headers(init.headers).get('x-upsert')).toBe('false');
        const file = form.get('');
        if (!(file instanceof Blob)) throw new Error('Unexpected test file');
        expect(file.type).toBe('image/jpeg');
        if (files.has(path)) return reply({ statusCode: '409', message: 'The resource already exists' }, 409);
        files.set(path, file);
        return reply({ Key: path });
      }
      expect(init?.method).toBe('GET');
      expect(init?.cache).toBe('no-store');
      const file = files.get(path.replace('/object/authenticated/', '/object/'));
      return file ? new Response(file) : reply({}, 404);
    };
    let handler = normal;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      return handler(path, init);
    });
    const client = createClient<Database>('http://127.0.0.1:54321', 'public-fixture-only', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
    });
    return { attempt, row, scope, controller, files, calls, client, normal, setHandler: (next: typeof normal) => { handler = next; } };
  }

  it('sends exactly the closed 32/8 inputs and finalizes the frozen IDs and opaque fingerprint', async () => {
    const api = setup(), stages: string[] = [];
    await saveItem(api.client, api.scope, api.attempt, (stage) => stages.push(stage));
    expect(api.calls.map(({ path }) => path)).toEqual([
      reservePath, `/storage/v1/object/wardrobe/${api.row.image.thumb_path}`,
      `/storage/v1/object/wardrobe/${api.row.image.main_path}`, finalizePath,
    ]);
    expect(api.calls[0]!.body).toEqual({
      p_item: { ...api.attempt.payload, id: api.attempt.itemId },
      p_image: { id: api.attempt.imageId, main_bytes: api.attempt.photo.main.size, thumb_bytes: api.attempt.photo.thumb.size,
        main_sha256: api.attempt.photo.mainSha256, thumb_sha256: api.attempt.photo.thumbSha256,
        width: 2, height: 3, alt_text: '' },
    });
    expect(Object.keys(api.attempt.payload)).toHaveLength(31);
    expect(api.calls[3]!.body).toEqual({ p_item_id: api.attempt.itemId, p_image_id: api.attempt.imageId, p_fingerprint: api.row.fingerprint });
    expect(stages).toEqual(['capture.reserving', 'capture.uploading', 'capture.finishing']);
    expect(api.row.item).toMatchObject({ purchase_price: 0.1, warmth: null,
      field_provenance: { warmth: { kind: 'user', revision: 1 } } });
  });

  it('retries a lost completed reply through reservation, authenticated byte checks and finalization without new IDs', async () => {
    const api = setup();
    api.setHandler((path, init) => {
      const response = api.normal(path, init);
      return path === finalizePath ? reply({ message: 'Private upstream text' }, 503) : response;
    });
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.unavailable');
    const frozen = structuredClone(api.attempt.payload), first = api.calls[0]!.body, files = [...api.files.values()];
    api.setHandler(api.normal);
    await saveItem(api.client, api.scope, api.attempt, () => {});
    expect(api.calls.filter(({ path }) => path === reservePath).map(({ body }) => body)).toEqual([first, first]);
    expect(api.calls.filter(({ path }) => path === finalizePath)).toHaveLength(2);
    expect(api.calls.filter(({ method }) => method === 'GET')).toHaveLength(2);
    expect([...api.files.values()]).toEqual(files);
    expect(api.attempt.payload).toEqual(frozen);
    expect(api.calls.some(({ path }) => /ai_|analy|commit_image$|\/items$|\/item_images$/.test(path))).toBe(false);
  });

  it('accepts canonical price and provenance key-order equivalence without changing the frozen snapshot', async () => {
    const api = setup();
    api.setHandler((path, init) => path === reservePath ? reply([{ ...api.row, item: {
      ...api.row.item, purchase_price: '0.10',
      field_provenance: Object.fromEntries(Object.entries(api.attempt.payload.field_provenance).reverse()
        .map(([key, entry]) => [key, { revision: entry.revision, kind: entry.kind }])),
    } }]) : api.normal(path, init));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).resolves.toBeUndefined();
    expect(api.attempt.values.purchase_price).toBe('0.10');
  });

  it.each([
    ['null', null], ['empty', []], ['object', {}], ['primitive row', [true]], ['null row', [null]],
  ])('rejects malformed reservation %s before uploads', async (_name, data) => {
    const api = setup(); api.setHandler(() => reply(data));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.calls).toHaveLength(1);
  });
  it.each([
    ['multiple rows', (row: ReturnType<typeof setup>['row']) => [row, row]],
    ['item array', (row: ReturnType<typeof setup>['row']) => [{ ...row, item: [] }]],
    ['image null', (row: ReturnType<typeof setup>['row']) => [{ ...row, image: null }]],
    ['extra envelope key', (row: ReturnType<typeof setup>['row']) => [{ ...row, extra: true }]],
    ['empty fingerprint', (row: ReturnType<typeof setup>['row']) => [{ ...row, fingerprint: '' }]],
    ['invalid fingerprint', (row: ReturnType<typeof setup>['row']) => [{ ...row, fingerprint: 'Z'.repeat(64) }]],
    ['non-string fingerprint', (row: ReturnType<typeof setup>['row']) => [{ ...row, fingerprint: 1 }]],
    ['unknown state', (row: ReturnType<typeof setup>['row']) => [{ ...row, state: 'ready' }]],
    ['inconsistent completed state', (row: ReturnType<typeof setup>['row']) => [{ ...row, state: 'completed' }]],
  ] as const)('rejects %s before uploads', async (_name, alter) => {
    const api = setup(); api.setHandler(() => reply(alter(api.row)));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.calls).toHaveLength(1);
  });
  it.each([
    ['id', other], ['owner_id', other], ['version', 2], ['version', '1'], ['deleted_at', '2026-09-10T00:00:00Z'],
    ['created_at', null], ['updated_at', 'invalid'], ['unexpected', true], ['purchase_price', '0.101'],
    ['field_provenance', {}], ['field_provenance', { title: { kind: 'ai_observed', revision: 1 } }],
  ])('rejects changed or malformed item %s', async (key, value) => {
    const api = setup(); api.setHandler(() => reply([{ ...api.row, item: { ...api.row.item, [String(key)]: value } }]));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.calls).toHaveLength(1);
  });
  it.each([
    ['id', other], ['item_id', other], ['owner_id', other], ['description_version', 2], ['description_version', '1'],
    ['description_version', 0], ['description_version', 2147483648], ['retired_at', '2026-09-10T00:00:00Z'],
    ['state', 'ready'], ['state', 'retired'], ['main_path', null], ['thumb_path', 'foreign/thumb.jpg'],
    ['main_bytes', 1], ['thumb_bytes', '15'], ['main_sha256', 'd'.repeat(64)], ['thumb_sha256', null],
    ['width', 3], ['height', null], ['alt_text', 'Changed'], ['alt_text', null], ['created_at', 'invalid'], ['unexpected', true],
  ])('rejects changed or malformed image %s', async (key, value) => {
    const api = setup(); api.setHandler(() => reply([{ ...api.row, image: { ...api.row.image, [String(key)]: value } }]));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.calls).toHaveLength(1);
  });
  it.each(['reserved', 'completed'])('rejects every missing JSON row key in %s state', async (state) => {
    const template = setup().row;
    for (const section of ['item', 'image'] as const) {
      for (const key of Object.keys(template[section])) {
        const api = setup(), partial: Record<string, unknown> = { ...api.row[section] };
        delete partial[key];
        api.setHandler(() => reply([{ ...api.row, state, image: { ...api.row.image, state: state === 'reserved' ? 'pending' : 'ready' }, [section]: partial }]));
        await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
        expect(api.calls).toHaveLength(1);
      }
    }
  });
  it.each([
    ['22023', 'Request conflict', 'error.conflict'],
    ['22023', 'Upload incomplete', 'error.uploadIncomplete'],
    ['22023', 'Invalid input', 'error.unavailable'],
    ['42501', 'Not available', 'error.unavailable'],
    ['23505', 'Private SQL', 'error.unavailable'],
    ['22023', 'Private upstream text', 'error.unavailable'],
  ])('maps only closed failure %s/%s at both RPC boundaries', async (code, message, key) => {
    for (const boundary of [reservePath, finalizePath]) {
      const api = setup();
      api.setHandler((path, init) => path === boundary ? reply({ code, message, details: null, hint: null }, 400) : api.normal(path, init));
      await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow(key);
      expect(api.calls).toHaveLength(boundary === reservePath ? 1 : 4);
    }
  });
  it('does not classify embellished private errors as closed conflicts', async () => {
    const api = setup(); api.setHandler(() => reply({ code: '22023', message: 'Request conflict', details: 'Private row', hint: null }, 400));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.unavailable');
    expect(api.calls).toHaveLength(1);
  });
  it.each([{}, [], true, 'ready'])('rejects a success-shaped non-void finalization reply %#', async (data) => {
    const api = setup();
    api.setHandler((path, init) => path === finalizePath ? reply(data) : api.normal(path, init));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.calls).toHaveLength(4);
  });
  it.each([1, 2, 3, 4])('rejects abort or owner/epoch drift after async boundary %s', async (boundary) => {
    for (const change of ['abort', 'owner', 'epoch']) {
      const api = setup();
      api.setHandler((path, init) => {
        const response = api.normal(path, init);
        if (api.calls.length === boundary) {
          if (change === 'abort') api.controller.abort();
          else if (change === 'owner') api.scope.ownerId = other;
          else api.scope.epoch++;
        }
        return response;
      });
      await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow();
      expect(api.calls).toHaveLength(boundary);
    }
  });
  it('fails closed on ready reservation rejection rather than recreating missing objects', async () => {
    const api = setup();
    await saveItem(api.client, api.scope, api.attempt, () => {});
    api.files.delete(`/storage/v1/object/wardrobe/${api.row.image.main_path}`);
    api.setHandler(() => reply({ code: '22023', message: 'Upload incomplete', details: null, hint: null }, 400));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.uploadIncomplete');
    expect(api.calls).toHaveLength(5);
    expect(api.files.size).toBe(1);
  });
  it('refuses duplicate object bytes with a different SHA before main upload or finalization', async () => {
    const api = setup();
    api.files.set(`/storage/v1/object/wardrobe/${api.row.image.thumb_path}`, new Blob(['changed']));
    await expect(saveItem(api.client, api.scope, api.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(api.calls).toHaveLength(3);
    expect(api.calls.some(({ path }) => path === finalizePath)).toBe(false);
  });
});
