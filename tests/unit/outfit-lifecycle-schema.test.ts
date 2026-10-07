import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261007090000_outfit_lifecycle.sql', 'utf8');
describe('OUTFIT1 source contract (not live database evidence)', () => {
  it('is one LF transaction with two narrowly granted definer RPCs', () => {
    expect(sql).not.toContain('\r');
    expect(sql.startsWith('BEGIN;\n')).toBe(true); expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/create function public\./g)).toHaveLength(2);
    expect(sql.match(/security definer set search_path = '' set lock_timeout = '2s'/g)).toHaveLength(2);
    expect(sql).toContain('from public,anon,authenticated');
    expect(sql).toContain('to authenticated');
    expect(sql).not.toMatch(/alter table|create table|storage\.|grant (?:update|delete)|save_outfit/);
  });
  it('keeps the approved lock order in each function and bounded safe versions', () => {
    for (const body of sql.split('create function public.').slice(1)) {
      const admission = body.indexOf('private.image_change_lock(u)');
      const profile = body.indexOf('public.profiles');
      const controls = body.indexOf('private.ai_controls');
      const outfit = body.indexOf('select * into o from public.outfits');
      expect(admission).toBeGreaterThan(0); expect(profile).toBeGreaterThan(admission);
      expect(controls).toBeGreaterThan(profile); expect(outfit).toBeGreaterThan(controls);
      expect(body).toContain('p_expected_version not between 1 and 9007199254740991');
      expect(body).toContain("exception when lock_not_available then raise exception using errcode='22023'");
    }
  });
  it('checks lifecycle and inclusive server-clock restore and does not update child/history rows', () => {
    expect(sql).toContain("v_now := clock_timestamp()");
    expect(sql).toContain("o.deleted_at>v_now or o.deleted_at<v_now-interval '7 days'");
    expect(sql).toContain("if o.deleted_at is null then raise exception");
    expect(sql).toContain("if o.deleted_at is not null then raise exception");
    expect(sql).not.toMatch(/(?:update|delete from) public\.(?:items|item_images|outfit_items|wear_events|wear_event_items)/);
    expect(sql).not.toMatch(/(?:update|delete from) private\./);
  });
  it('permanent deletion preserves active unexpired chains and does not block on expired chains', () => {
    expect(sql).toContain("owner_id=u and outfit_id=p_id and state='running' and expires_at>clock_timestamp()");
    expect(sql).toContain("message='Try-on running'");
    expect(sql).toContain('o.version<>p_expected_version or o.deleted_at is null');
    expect(sql).toContain('delete from public.outfits where owner_id=u and id=p_id');
  });
});
