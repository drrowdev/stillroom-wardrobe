import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { garmentFields } from '../../src/domain/garment-fields';
import { provenanceFields } from '../../src/domain/attribute-provenance';
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
