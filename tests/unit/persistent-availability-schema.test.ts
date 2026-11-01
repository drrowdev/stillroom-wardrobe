import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// AVAIL1: persistent AI availability. The CI integration, preservation and security jobs prove the migration applies and
// behaves; these checks keep each replaced body equal to the exact current active definition except the review-date term.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261101080000_persistent_ai_availability.sql';

type Target = {
  fn: string; from: string; start: string; replaces: [string, string][]; rename?: [string, string];
};
const PERMITTED_OLD = `and m.model_id=r.model_id and m.prompt_version=r.prompt_version and p_now<m.review_expires_at
        and (m.id='google-eu-3.8-v1' or c.notice_revision=2));`;
const PERMITTED_NEW = `and m.model_id=r.model_id and m.prompt_version=r.prompt_version
        and (m.id='google-eu-3.8-v1' and p_now<m.review_expires_at or m.id<>'google-eu-3.8-v1' and c.notice_revision=2));`;
const TARGETS: Target[] = [
  { fn: 'public.ai_claim_analysis', from: '20260924100100_azure_colour_manifest.sql', start: 'create or replace function public.ai_claim_analysis(',
    replaces: [['if not found or v_now>=m.review_expires_at or c.execution_manifest_id is null then', 'if not found or c.execution_manifest_id is null then']] },
  { fn: 'private.ai_analysis_permitted', from: '20260924100100_azure_colour_manifest.sql', start: 'create or replace function private.ai_analysis_permitted(',
    replaces: [[PERMITTED_OLD, PERMITTED_NEW]] },
  { fn: 'private.reserve_analyzed_item_save_v10', from: '20260921193000_azure_terra_analysis.sql',
    start: 'create or replace function public.reserve_analyzed_item_save(',
    rename: ['create or replace function public.reserve_analyzed_item_save(', 'create or replace function private.reserve_analyzed_item_save_v10('],
    replaces: [['or m.id is distinct from c.execution_manifest_id or m.review_expires_at<=clock_timestamp();', 'or m.id is distinct from c.execution_manifest_id;']] },
  { fn: 'private.reserve_image_change', from: '20260922020000_checked_image_changes.sql', start: 'create function private.reserve_image_change(',
    rename: ['create function private.reserve_image_change(', 'create or replace function private.reserve_image_change('],
    replaces: [['or m.id is distinct from c.execution_manifest_id or m.review_expires_at<=clock_timestamp();', 'or m.id is distinct from c.execution_manifest_id;']] },
  { fn: 'public.stylist_claim', from: '20261010090000_shared_ai_budget.sql', start: 'create or replace function public.stylist_claim(',
    replaces: [[`or m.review_expires_at<=v_now then\n    return jsonb_build_object('code','UNCONFIGURED'`, `then\n    return jsonb_build_object('code','UNCONFIGURED'`]] },
  { fn: 'public.enhance_claim', from: '20261010090000_shared_ai_budget.sql', start: 'create or replace function public.enhance_claim(',
    replaces: [['or m.review_expires_at<=v_now or k.deployment_key is null', 'or k.deployment_key is null']] },
  { fn: 'private.tryon_permission', from: '20261003090000_try_on.sql', start: 'create function private.tryon_permission(',
    rename: ['create function private.tryon_permission(', 'create or replace function private.tryon_permission('],
    replaces: [['m.id=p_controls.tryon_manifest_id\n      and m.review_expires_at>p_now) then', 'm.id=p_controls.tryon_manifest_id) then']] },
  { fn: 'private.tryon_probe_permission', from: '20261010090000_shared_ai_budget.sql', start: 'create or replace function private.tryon_probe_permission(',
    replaces: [['m.id=p_controls.tryon_manifest_id\n      and m.review_expires_at>p_now) then', 'm.id=p_controls.tryon_manifest_id) then']] },
  { fn: 'public.tryon_claim', from: '20261011090000_tryon_idea.sql', start: 'create function public.tryon_claim(',
    rename: ['create function public.tryon_claim(', 'create or replace function public.tryon_claim('],
    replaces: [['or m.review_expires_at<=v_now or k.deployment_key is null', 'or k.deployment_key is null']] },
];
const sqlBody = (sql: string, start: string) => {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  expect(sql.indexOf(start, from + 1), `${start} once`).toBe(-1);
  const to = sql.indexOf('\n$$;\n', from);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to + 5);
};
const once = (text: string, find: string) => {
  expect(text.split(find), find).toHaveLength(2);
};

describe('persistent AI availability migration (AVAIL1)', () => {
  it('is one LF transaction after every earlier migration and only replaces the nine active functions', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- AVAIL1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.at(-1)).toBe(MAIN);
    expect([...sql.matchAll(/create or replace function ([a-z_0-9.]+)\(/g)].map((match) => match[1])).toEqual(TARGETS.map((t) => t.fn));
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bcreate function\b|\bdrop\b|\balter\b|\bgrant\b|\brevoke\b|\btruncate\b|\bupdate private\.ai_controls\b/);
  });

  for (const target of TARGETS) {
    it(`reproduces the active ${target.fn} except the review-date term`, async () => {
      const [sql, from] = await Promise.all([read(MAIN), read(target.from)]);
      let before = sqlBody(from, target.start);
      if (target.rename) before = before.replace(target.rename[0], target.rename[1]);
      for (const [find, replacement] of target.replaces) {
        once(before, find);
        before = before.replace(find, replacement);
      }
      const after = sqlBody(sql, target.rename?.[1] ?? target.start);
      expect(after).toBe(before);
    });

    it(`has no later migration redefining ${target.fn} before this one`, async () => {
      const defines = new RegExp(`create (or replace )?function ${target.fn.replace('.', '\\.')}\\(`);
      // The v10 body was renamed into place by 20260922020000, which defines the public wrapper instead.
      const after = target.fn === 'private.reserve_analyzed_item_save_v10' ? '20260922020000_checked_image_changes.sql' : target.from;
      const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql') && name > after && name < MAIN).sort();
      for (const name of names) expect(await read(name), name).not.toMatch(defines);
    });
  }

  it('keeps the current functions free of calendar gates except the retired Google term', async () => {
    const sql = await read(MAIN);
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code.match(/review_expires_at/g)).toHaveLength(1);
    expect(sqlBody(sql, 'create or replace function private.ai_analysis_permitted(')).toContain(
      `m.id='google-eu-3.8-v1' and p_now<m.review_expires_at`);
  });

  it('keeps every operational check in the replaced bodies', async () => {
    const sql = await read(MAIN);
    for (const needle of [
      'r.expires_at<=v_now', 'private.ai_permission(p,c)', 'c.max_request_micro<m.reservation_micro',
      'private.stylist_permission(p,c)', 'v_used+c.stylist_max_request_micro>c.monthly_allowance_micro',
      'private.enhance_permission(p,c)', 'v_used+c.enhance_max_request_micro>c.monthly_allowance_micro',
      'p_auth.expires_at<=p_now', 'not k.dispatch_enabled', 'v_used+v_n*v_r>c.monthly_allowance_micro',
      'tryon_consent_revision is distinct from p_controls.tryon_notice_revision',
      `m.id<>'azure-global-image25-sunburst-tryon-v1'`, `m.id<>'azure-global-image25-sunburst-cleanup-v1'`,
      `m.id not in ('azure-eu-terra-stylist-v1','azure-eu-terra-stylist-v2')`,
    ]) expect(sql, needle).toContain(needle);
    expect(sql.match(/security definer set search_path = ''/g)!.length).toBe(6);
    expect(sql.match(/language sql stable set search_path = ''/g)).toHaveLength(3);
  });
});
