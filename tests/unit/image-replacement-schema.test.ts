import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Executable preservation fixture has no TypeScript declaration.
import { verifyImageChangePreservation } from '../integration/azure-preservation.sessions.mjs';
// @ts-expect-error Executable integration fixture has no TypeScript declaration.
import { imageChangeHarness } from '../integration/image-replacement.sessions.mjs';

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

  describe('I10b preservation failure labels (mocked transports, no SQL execution)', () => {
    const keys = ['five_private_tables', 'auth_lifetime', 'no_profile_item_cascade', 'source_only_set_null',
      'one_shot_private', 'service_completion_only', 'service_recovery_only', 'revoked_legacy',
      'empty_context', 'target_key_bounds'];
    afterEach(() => vi.restoreAllMocks());

    function fixture() {
      const stopped = new Error('synthetic-private-error-do-not-emit');
      const privateState = { preserved: 'synthetic-private-row-do-not-emit' };
      const structure: Record<string, boolean> = Object.fromEntries(keys.map((key) => [key, true]));
      const empty = { attempts: 0, context: 0, history: 0, operations: 0, targets: 0 };
      const owners = [{ uid: '10000000-0000-4000-8000-000000000001', label: 'A' },
        { uid: '10000000-0000-4000-8000-000000000002', label: 'B' }];
      const client = {
        rows: vi.fn(async (_owner: unknown, table: string) => table === 'profiles' ? [{ version: 1 }] : []),
        rpc: vi.fn(async () => { throw stopped; }),
      };
      const snapshot = { owners, client, env: {}, imageChangeBefore: {
        private: privateState,
        library: owners.map(() => ({ profile: [{ version: 1 }], items: [], images: [], histories: [], bytes: [] })),
      } };
      const sql = vi.fn(async (query: string) => {
        if (query.includes("'five_private_tables'")) return JSON.stringify(structure);
        if (query.includes("'attempts'")) return JSON.stringify(empty);
        return JSON.stringify(privateState);
      });
      const mark = vi.fn<(label: string) => void>();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      return { stopped, structure, empty, client, snapshot, sql, mark, log };
    }

    it('keeps ordinary RPC rejection and emits only fixed progress labels after unchanged preservation checks', async () => {
      const f = fixture();
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toBe(f.stopped);
      expect(f.mark.mock.calls.flat()).toEqual([
        'state-read', 'state-compare', 'structure-query', 'structure-shape', 'empty-tables', 'consent-expiry',
      ]);
      expect(f.client.rows.mock.calls.slice(0, 6).map(([, table]) => table))
        .toEqual(['items', 'item_images', 'profiles', 'items', 'item_images', 'profiles']);
      expect(f.client.rpc).toHaveBeenCalledOnce();
      expect(f.log).not.toHaveBeenCalled();
    });
    it('preserves the original state-read error without exposing its message', async () => {
      const f = fixture();
      f.client.rows.mockRejectedValueOnce(f.stopped);
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toBe(f.stopped);
      expect(f.mark.mock.calls.flat()).toEqual(['state-read']);
      expect(f.sql).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
    });
    it('still rejects changed preserved data before structure or owner operations', async () => {
      const f = fixture();
      f.snapshot.imageChangeBefore.private = { preserved: 'different-synthetic-private-row' };
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(f.mark).toHaveBeenLastCalledWith('state-compare');
      expect(f.sql).toHaveBeenCalledOnce(); expect(f.client.rpc).not.toHaveBeenCalled();
      expect(f.log).not.toHaveBeenCalled();
    });
    it('preserves an original structural-query rejection', async () => {
      const f = fixture(), original = f.sql.getMockImplementation()!;
      f.sql.mockImplementation(async (query) => {
        if (query.includes("'five_private_tables'")) throw f.stopped;
        return original(query);
      });
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toBe(f.stopped);
      expect(f.mark).toHaveBeenLastCalledWith('structure-query');
      expect(f.client.rpc).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
    });
    it.each(keys)('retains the %s structural assertion with its fixed failure label', async (key) => {
      const f = fixture();
      f.structure[key] = false;
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(f.mark).toHaveBeenLastCalledWith(`structure-${key}`);
      expect(f.sql).toHaveBeenCalledTimes(2);
      expect(f.client.rpc).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
    });
    it('retains the exact structural shape check without reporting unknown keys', async () => {
      const f = fixture();
      f.structure['synthetic-private-key-do-not-emit'] = true;
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(f.mark).toHaveBeenLastCalledWith('structure-shape');
      expect(JSON.stringify(f.mark.mock.calls)).not.toContain('synthetic-private');
      expect(f.client.rpc).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
    });
    it.each(['attempts', 'context', 'history', 'operations', 'targets'] as const)('still rejects nonempty initial %s', async (key) => {
      const f = fixture();
      f.empty[key] = 1;
      await expect(verifyImageChangePreservation(f.snapshot, f.sql, f.mark)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(f.mark).toHaveBeenLastCalledWith('empty-tables');
      expect(f.client.rpc).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
    });
    it('routes the fixed label into the existing sanitized runner failure stage', async () => {
      const runner = await readFile(new URL('../../scripts/preservation-rehearsal.mjs', import.meta.url), 'utf8');
      expect(runner).toContain('await verifyImageChangePreservation(ten, privilegedLocalSql, (label) => { stage = `I10b-preservation-${label}`; });');
      expect(runner).toContain('FAIL: preservation ${stage}; EVIDENCE_REQUIRED${historyFailureDetail(error)}${lifecycleFailureDetail(error)}; subsequent stages NOT RUN');
    });
    it('distinguishes replacement reservation from upload without advancing the label before either awaited call', async () => {
      const fixtureSource = await readFile(new URL('../integration/azure-preservation.sessions.mjs', import.meta.url), 'utf8');
      expect(fixtureSource).not.toContain("mark('replacement-reserve-upload')");
      expect(fixtureSource).toContain('replacementHarness = imageChangeHarness(client, owner, env, mark);');
      expect(fixtureSource).toMatch(/mark\('replacement-reserve'\);\s*await replacementHarness\.reserve\(replacement\);\s*mark\('replacement-upload'\);\s*await replacementHarness\.upload\(replacement\);\s*mark\('replacement-finalize'\);/);
    });
    describe('replacement failure response classes (mocked transport, no backend)', () => {
      const statuses = [200, 201, 204, 400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504];
      const codes = ['22023', '42501', '42601', '42702', '42703', '42883', '23502', '23503', '23505',
        '23514', '55P03', 'PGRST202', 'PGRST204', 'NoSuchKey', 'AccessDenied', 'Duplicate', 'InvalidKey', 'EntityTooLarge'];
      const value = { requestId: '10000000-0000-4000-8000-000000000001',
        itemId: '10000000-0000-4000-8000-000000000002', imageId: '10000000-0000-4000-8000-000000000003' };
      const owner = { uid: '10000000-0000-4000-8000-000000000004', token: 'synthetic-token-do-not-emit', label: 'A' };
      const receipt = { ...value, fingerprint: 'a'.repeat(64), completedVersion: null, kind: 'replacement', state: 'reserved' };
      type Reply = { ok: boolean; status: unknown; data?: unknown };
      const ok: Reply = { ok: true, status: 200, data: receipt };
      afterEach(() => vi.restoreAllMocks());
      function fixture(reply: Reply = ok, marked = true) {
        const request = vi.fn<(token: string, route: string, options: unknown) => Promise<Reply>>().mockResolvedValue(reply);
        const mark = vi.fn<(label: string) => void>();
        const h = marked ? imageChangeHarness({ request }, owner, {}, mark) : imageChangeHarness({ request }, owner, {});
        const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
        return { request, mark, h, logs };
      }
      it('imports the single shared status classifier rather than duplicating its allowlist', async () => {
        const [fixtureSource, clientSource] = await Promise.all([
          readFile(new URL('../integration/image-replacement.sessions.mjs', import.meta.url), 'utf8'),
          readFile(new URL('../integration/preservation.sessions.mjs', import.meta.url), 'utf8'),
        ]);
        expect(fixtureSource).toContain("import { requireEvidence, diagnosticHttpStatus } from './preservation.sessions.mjs';");
        expect(fixtureSource).toContain('const status = diagnosticHttpStatus(result.status);');
        expect(fixtureSource).not.toContain('const diagnosticStatuses');
        expect(clientSource.match(/const diagnosticStatuses = new Set/g)).toHaveLength(1);
        expect(clientSource).toContain('export function diagnosticHttpStatus(status)');
      });
      it.each(statuses)('classifies only allowed HTTP status %s immediately before the existing refusal', async (status) => {
        const f = fixture({ ok: false, status, data: { code: '22023' } });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([[`reserve-http-${status}-22023`]]);
        expect(f.request).toHaveBeenCalledExactlyOnceWith(owner.token, '/rest/v1/rpc/reserve_image_change',
          { method: 'POST', body: { p_intent: value } });
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
      it.each(codes)('classifies only allowlisted code %s without reading response detail fields', async (code) => {
        const f = fixture({ ok: false, status: 400, data: { code,
          message: 'synthetic-message-secret', details: 'synthetic-details-secret', hint: 'synthetic-hint-secret',
          data: { code: 'nested-secret', token: owner.token }, id: owner.uid, receipt } });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([[`reserve-http-400-${code}`]]);
        expect(JSON.stringify(f.mark.mock.calls)).not.toMatch(/synthetic|secret|10000000/);
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
      it.each([
        ['absent', undefined], ['null', null], ['array', [{ code: '22023' }]],
        ['string', '22023'], ['number', 22023], ['boolean', true], ['missing', {}],
        ['null code', { code: null }], ['number code', { code: 22023 }],
        ['array code', { code: ['22023'] }], ['object code', { code: { value: '22023' } }],
        ['boolean code', { code: true }], ['unknown code', { code: 'UNKNOWN' }],
        ['sensitive code', { code: owner.token }], ['long code', { code: 'sensitive'.repeat(2048) }],
        ['lowercase code', { code: '55p03' }], ['whitespace code', { code: ' 22023' }],
        ['inherited code', Object.create({ code: '22023' })],
        ['prototype key', JSON.parse('{"__proto__":{"code":"22023"}}')],
        ['constructor key', { constructor: { code: '22023' } }],
        ['prototype name code', { code: '__proto__' }], ['constructor name code', { code: 'constructor' }],
        ['nested code', { data: { code: '22023' }, message: owner.token, details: receipt, hint: owner.uid }],
      ])('maps %s to OTHER without disclosing its value or changing refusal', async (_name, data) => {
        const f = fixture({ ok: false, status: 400, data });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([['reserve-http-400-OTHER']]);
        expect(f.request).toHaveBeenCalledOnce();
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
      it.each([undefined, null, '400', 400.5, NaN, Infinity, -1, 418, {}, [400]])(
        'maps unknown/noninteger status %# to OTHER', async (status) => {
          const f = fixture({ ok: false, status, data: { code: '42501' } });
          await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
          expect(f.mark.mock.calls).toEqual([['reserve-http-OTHER-42501']]);
        });
      it('accepts an own allowlisted code on a null-prototype object', async () => {
        const data = Object.assign(Object.create(null), { code: '42702' });
        const f = fixture({ ok: false, status: 400, data });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([['reserve-http-400-42702']]);
      });
      it.each([201, 204])('still refuses an ok response with non-200 reserve status %s', async (status) => {
        const f = fixture({ ...ok, status });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([[`reserve-http-${status}-OTHER`]]);
      });
      it.each([
        ['empty object', {}], ['array', []], ['primitive', 'secret'],
        ['missing key', { ...value, fingerprint: receipt.fingerprint, kind: 'replacement', state: 'reserved' }],
        ['extra secret key', { ...receipt, 'synthetic-private-key': owner.token }],
      ])('keeps exact receipt-key refusal for %s', async (_name, data) => {
        const f = fixture({ ...ok, data });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([['reserve-receipt-keys']]);
        expect(f.request).toHaveBeenCalledOnce();
      });
      it.each([null, undefined])('preserves nullish receipt TypeError %# instead of substituting an assertion error', async (data) => {
        const f = fixture({ ...ok, data });
        await expect(f.h.reserve(value)).rejects.toBeInstanceOf(TypeError);
        expect(f.mark.mock.calls).toEqual([['reserve-receipt-keys']]);
      });
      it.each(['requestId', 'itemId', 'imageId', 'fingerprint'])('retains receipt identity refusal for %s', async (key) => {
        const f = fixture({ ...ok, data: { ...receipt, [key]: 'synthetic-private-mismatch' } });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([['reserve-receipt-identity']]);
        expect(f.request).toHaveBeenCalledOnce();
      });
      it('returns the unchanged successful receipt with no classification, regardless of key order', async () => {
        const data = Object.fromEntries(Object.entries(receipt).reverse()), f = fixture({ ...ok, data });
        await expect(f.h.reserve(value)).resolves.toBe(data);
        expect(f.mark).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
      it.each(['main', 'thumb'])('classifies only failed native %s upload and stops at the unchanged assertion', async (variant) => {
        const f = fixture({ ok: false, status: 403, data: { code: 'AccessDenied', message: owner.token } });
        if (variant === 'thumb') f.request.mockResolvedValueOnce({ ok: true, status: 201 });
        await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([
          ['upload-main-attempt'], ...(variant === 'thumb' ? [['upload-thumb-attempt']] : []),
          [`upload-${variant}-http-403-AccessDenied`],
        ]);
        expect(f.request.mock.calls.map(([, route]) => route)).toEqual(
          (variant === 'main' ? ['main'] : ['main', 'thumb']).map((part) =>
            `/storage/v1/object/wardrobe/${owner.uid}/${value.itemId}/${value.imageId}/${part}.jpg`));
        for (const [token, , options] of f.request.mock.calls) {
          expect(token).toBe(owner.token);
          expect(options).toMatchObject({ method: 'POST', binary: true, headers: { 'x-upsert': 'false' } });
        }
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
      it('uses the same OTHER classifier for an upload response without supported status/code', async () => {
        const f = fixture({ ok: false, status: 'synthetic-secret-status', data: { code: owner.token } });
        await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark.mock.calls).toEqual([['upload-main-attempt'], ['upload-main-http-OTHER-OTHER']]);
      });
      it('never interpolates an unexpected caller-supplied variant into a diagnostic label', async () => {
        const f = fixture({ ok: false, status: 400 });
        await expect(f.h.upload(value, ['synthetic-secret-variant'])).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.mark).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
      });
      it.each(['reserve', 'main', 'thumb'])('propagates the exact thrown %s transport sentinel without classification or retry', async (operation) => {
        const f = fixture(), sentinel = { message: 'synthetic-private-transport-error', token: owner.token };
        if (operation === 'thumb') f.request.mockResolvedValueOnce({ ok: true, status: 201 });
        f.request.mockRejectedValueOnce(sentinel);
        await expect(operation === 'reserve' ? f.h.reserve(value) : f.h.upload(value)).rejects.toBe(sentinel);
        expect(f.mark.mock.calls).toEqual(operation === 'reserve' ? []
          : operation === 'main' ? [['upload-main-attempt']] : [['upload-main-attempt'], ['upload-thumb-attempt']]);
        expect(f.request).toHaveBeenCalledTimes(operation === 'thumb' ? 2 : 1);
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
      it('awaits main before requesting thumb and emits no classification on success', async () => {
        const f = fixture({ ok: true, status: 201, data: { code: 'Duplicate' } });
        let release!: (reply: Reply) => void;
        f.request.mockReturnValueOnce(new Promise<Reply>((resolve) => { release = resolve; }));
        const pending = f.h.upload(value);
        expect(f.request).toHaveBeenCalledOnce();
        expect(f.mark.mock.calls).toEqual([['upload-main-attempt']]);
        release({ ok: true, status: 204 });
        await pending;
        expect(f.request).toHaveBeenCalledTimes(2);
        expect(f.request.mock.calls[0]?.[1]).toMatch(/\/main\.jpg$/);
        expect(f.request.mock.calls[1]?.[1]).toMatch(/\/thumb\.jpg$/);
        expect(f.mark.mock.calls).toEqual([['upload-main-attempt'], ['upload-thumb-attempt']]);
      });
      it('preserves successful and rejected three-argument callers without a diagnostic callback', async () => {
        const f = fixture(ok, false);
        await expect(f.h.reserve(value)).resolves.toBe(receipt);
        await expect(f.h.upload(value)).resolves.toBeUndefined();
        f.request.mockResolvedValue({ ok: false, status: 400, data: { code: '22023' } });
        await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(f.request).toHaveBeenCalledTimes(5);
        expect(f.mark).not.toHaveBeenCalled();
      });
    });
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
  it.each(['image_change_attempts', 'item_deletion_targets'])(
    'qualifies native publication image_id references in statements using %s', async (table) => {
      const guard = body(await source, 'private.guard_item_object_publication');
      const statements = guard.split(';').filter((statement) => statement.includes(`private.${table}`));
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) expect(statement).not.toMatch(/(?<![\w.])image_id\b/i);
      expect(guard).toContain('im.id=image_id');
    });
  it('qualifies native publication cancellation owner, image and state without dropping the refusal', async () => {
    const guard = body(await source, 'private.guard_item_object_publication');
    expect(guard).toContain("from private.image_change_attempts a where a.owner_id=u and a.image_id=image.id and a.state='cancelled'");
  });
  it('retains inclusive seven-day source acceptance and does not recheck accepted recovery age', async () => {
    const sql = await source, reserve = body(sql, 'private.reserve_image_change');
    expect(reserve.indexOf("return private.image_change_receipt(a)")).toBeLessThan(reserve.indexOf("interval '7 days'"));
    expect(reserve).toContain("source.retired_at<clock_timestamp()-interval '7 days'");
    expect(reserve).toContain("source.retired_at>clock_timestamp()");
    expect(body(sql, 'public.complete_image_change')).not.toContain("interval '7 days'");
    expect(body(sql, 'public.image_recovery_versions')).toContain('order by id limit 40');
  });
  it.each([
    ['private.reserve_image_change', "a.kind<>(case when recovery then 'recovery' else 'replacement' end)"],
    ['public.image_change_preflight', "image.state<>(case when a.state='reserved' then 'pending' else 'ready' end)"],
  ])('keeps CASE operands parenthesized in the PL/pgSQL IF condition of %s', async (name, comparison) => {
    const definition = body(await source, name);
    expect(definition).toContain(comparison);
    expect(definition).not.toMatch(/<>\s*case\b/i);
    const predecessor = await readFile(new URL('../../supabase/migrations/20260910070000_checked_item_save.sql', import.meta.url), 'utf8');
    expect(body(predecessor, 'private.item_save_current')).toContain("im.state<>(case a.state when 'reserved' then 'pending' else 'ready' end)");
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
