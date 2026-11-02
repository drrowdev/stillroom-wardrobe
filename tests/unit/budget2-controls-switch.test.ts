import { describe, expect, it } from 'vitest';
import { switchControlsSql, SWITCH_PROFILES, CURRENT_PERIOD_SQL } from '../../scripts/budget2-controls-switch.mjs';

const OWNER = '00000000-0000-4000-8000-000000000001';
const strip = (sql: string) => sql.replace(/\s+/g, ' ');

describe('BUDGET2 guarded owner-controls switch', () => {
  it('builds one transaction that refuses before any write', () => {
    for (const direction of ['forward', 'rollback'] as const) {
      const sql = switchControlsSql(OWNER, direction);
      expect(sql.startsWith('begin;\ndo $switch$')).toBe(true);
      expect(sql.trimEnd().endsWith('commit;')).toBe(true);
      expect(sql).not.toContain('\r');
      // Profile then controls, both locked, before any read that decides.
      expect(sql.indexOf('from public.profiles')).toBeLessThan(sql.indexOf('from private.ai_controls'));
      expect(sql.match(/for update/g)).toHaveLength(2);
      expect(sql.match(/raise exception 'BLOCKED/g)!.length).toBe(6);
      // The only write is the manifest and the hold amount: never activation, consent, notice, prompt or allowance.
      expect(sql.match(/\bupdate private\./g)).toHaveLength(1);
      expect(strip(sql)).toMatch(/update private\.ai_controls set execution_manifest_id='[^']+',max_request_micro=\d+, updated_at=clock_timestamp\(\) where owner_id=p\.owner_id;/);
      expect(sql).not.toMatch(/\bdelete\b|\binsert\b|activated\s*=|notice_revision\s*=|monthly_allowance_micro\s*=/);
    }
  });
  it('uses the same quiescence guards in both directions, in the same order, before the only write', () => {
    const guards = (direction: 'forward' | 'rollback') => {
      const sql = switchControlsSql(OWNER, direction);
      return sql.slice(sql.indexOf('select * into c'), sql.indexOf('update private.ai_controls'))
        .replace(/'azure-eu-terra-devtest-v\d'|c\.max_request_micro<>\d+/g, '<row>');
    };
    expect(guards('rollback')).toBe(guards('forward'));
    const text = guards('forward');
    const order = ['<row>', 'item_save_attempts', 'image_change_attempts', "status='ready'", 'a request of this account is still alive',
      "charge_state in ('reserved','held')"];
    let at = -1;
    for (const needle of order) { const next = text.indexOf(needle, at + 1); expect(next, needle).toBeGreaterThan(at); at = next; }
  });
  it('tells a frozen Save, an unsaved ready analysis, a live request and a held charge apart', () => {
    const sql = strip(switchControlsSql(OWNER, 'rollback'));
    for (const message of ['a frozen analysed Save or image replacement is still in progress', 'an unsaved ready analysis is still alive',
      'a request of this account is still alive', 'reserved or held charge exists', 'the controls are not the expected current row'])
      expect(sql).toContain(`raise exception 'BLOCKED: ${message}`);
    expect(sql).toContain("a.manifest_id is not null and s.state='reserved'");
    expect(sql).toContain('from private.ai_requests where owner_id=p.owner_id and expires_at>v_now');
  });
  it('ignores only the closed Azure v2 anomaly hold of an earlier month and nothing else', () => {
    for (const direction of ['forward', 'rollback'] as const) {
      const sql = strip(switchControlsSql(OWNER, direction));
      const start = sql.indexOf('if exists(select 1 from private.ai_usage u');
      const guard = sql.slice(start, sql.indexOf('raise exception', start));
      // Every part of the exemption is required: one unmet part keeps the row blocking.
      for (const part of ["u.charge_state in ('reserved','held')", "not (u.charge_state='held' and u.purpose='analysis'",
        `u.period<${CURRENT_PERIOD_SQL}`, 'u.closed_reason is not null',
        'and not exists(select 1 from private.ai_requests r where r.owner_id=u.owner_id and r.request_id=u.request_id)',
        `and exists(select 1 from private.ai_usage_evidence e where e.owner_id=u.owner_id and e.request_id=u.request_id and e.manifest_id='${SWITCH_PROFILES.v2.manifest}' and e.anomaly and e.normalized_usage is null)`])
        expect(guard, part).toContain(part);
      expect(guard.match(/ or /g) ?? []).toEqual([]);
    }
  });
  it('derives the period and the liveness cutoff from one timestamp taken after both locks, in UTC', () => {
    const sql = switchControlsSql(OWNER, 'forward');
    expect(CURRENT_PERIOD_SQL).toBe("to_char(v_now at time zone 'UTC','YYYY-MM')");
    expect(sql.match(/v_now := clock_timestamp\(\);/g)).toHaveLength(1);
    expect(sql.indexOf('v_now := clock_timestamp()')).toBeGreaterThan(sql.indexOf('from private.ai_controls where owner_id=p.owner_id for update'));
    expect(sql.indexOf('v_now := clock_timestamp()')).toBeLessThan(sql.indexOf('item_save_attempts'));
    expect(sql.match(/expires_at>v_now/g)).toHaveLength(2);
    // The only other clock read is the written updated_at.
    expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/current_date|now\(\)|local ?time|current_timestamp/i);
  });
  it('forward needs the exact v2 row and restores nothing else', () => {
    const sql = strip(switchControlsSql(OWNER, 'forward'));
    expect(sql).toContain(`c.execution_manifest_id is distinct from '${SWITCH_PROFILES.v2.manifest}' or c.max_request_micro<>4097351`);
    expect(sql).toContain("set execution_manifest_id='azure-eu-terra-devtest-v3',max_request_micro=1,");
  });
  it('rollback needs the exact v3 row and restores v2 at 4,097,351', () => {
    const sql = strip(switchControlsSql(OWNER, 'rollback'));
    expect(sql).toContain(`c.execution_manifest_id is distinct from '${SWITCH_PROFILES.v3.manifest}' or c.max_request_micro<>1`);
    expect(sql).toContain("charge_state in ('reserved','held')");
    expect(sql).toContain("set execution_manifest_id='azure-eu-terra-devtest-v2',max_request_micro=4097351,");
  });
  it('accepts only a canonical owner id and a known direction', () => {
    for (const bad of ['', 'x', '0000000A-0000-4000-8000-000000000001', `${OWNER}'; drop table x; --`, null, 1]) {
      expect(() => switchControlsSql(bad as string, 'forward')).toThrow();
    }
    expect(() => switchControlsSql(OWNER, 'sideways' as 'forward')).toThrow();
  });
});
