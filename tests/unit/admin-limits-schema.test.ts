import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for AD1a (plan rev2 with the coordinator's binding notes). The CI preservation, deletion and security jobs
// prove the migration applies and behaves; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261001090000_admin_limits.sql';
const between = (sql: string, start: string, end: string) => {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = sql.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return sql.slice(from, to);
};

describe('admin limits migration (AD1a)', () => {
  it('stays one LF transaction after M8 and replaces only the deletion inventory', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- AD1a')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.indexOf(MAIN)).toBeGreaterThan(names.indexOf('20260929090100_enhance_expire_schedule.sql'));
    const replaced = [...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((match) => match[1]);
    expect(replaced).toEqual(['private.deletion_owner_rows_absent']);
    expect(sql).not.toMatch(/\bdrop (function|table|trigger)\b/);
    expect(sql).not.toMatch(/\balter table (public|private)\.(ai_controls|ai_usage|approved_accounts|profiles)\b/);
  });

  it('exposes three definer RPCs with an empty search path to authenticated only', async () => {
    const sql = await read(MAIN);
    for (const name of ['admin_status(', 'admin_ai_spending(', 'admin_set_ai_limits(']) {
      const body = between(sql, `create function public.${name}`, '$$');
      expect(body, name).toContain('security definer');
      expect(body, name).toContain("set search_path = ''");
    }
    expect(sql).toContain('grant execute on function public.admin_status(),public.admin_ai_spending(integer),\n'
      + '  public.admin_set_ai_limits(smallint,text,jsonb,jsonb,text) to authenticated;');
    expect([...sql.matchAll(/\bgrant\b[^;]*;/g)]).toHaveLength(1);
    expect(sql).toContain('revoke all on private.app_admins from public,anon,authenticated,service_role;');
    expect(sql).toContain('revoke all on private.ai_limit_audit from public,anon,authenticated,service_role;');
  });

  it('never grants admin authority from a function and binds the operator row to the current admission', async () => {
    for (const name of (await readdir(DIR)).filter((file) => file.endsWith('.sql'))) {
      expect(await read(name), name).not.toMatch(/(insert into|update|delete from)\s+private\.app_admins\b/);
    }
    const binding = between(await read(MAIN), 'create function private.app_admin_binding()', '\n$$;');
    expect(binding).toContain('s.generation=new.admission_generation and s.user_id=new.owner_id and s.enabled');
  });

  it('checks the caller before any target work and locks admissions before profiles and controls', async () => {
    const write = between(await read(MAIN), 'create function public.admin_set_ai_limits(', '\n$$;');
    const order = ["if v_actor is null then return jsonb_build_object('code','UNAVAILABLE')",
      'order by admission_no for share nowait', 'from private.app_admins where singleton for share',
      'private.admin_authority() is distinct from v_actor', 'private.admin_account_version(t.admission_no,t.generation)<>p_account_version',
      'from public.profiles where owner_id=t.user_id for update', 'from public.profiles where owner_id=v_actor for key share',
      'from private.ai_controls where owner_id=t.user_id for update', 'update private.ai_controls set'];
    const positions = order.map((text) => write.indexOf(text));
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(write.indexOf('private.admin_authority()')).toBeLessThan(write.indexOf('approved_accounts'));
  });

  it('writes only the nine limits, verifies them and audits a fixed label', async () => {
    const write = between(await read(MAIN), 'create function public.admin_set_ai_limits(', '\n$$;');
    const update = between(write, 'update private.ai_controls set', 'returning * into c;');
    const columns = [...update.matchAll(/\b([a-z_]+)=\(/g)].map((match) => match[1]);
    expect(columns).toEqual(['monthly_allowance_micro', 'max_request_micro', 'max_requests_per_hour',
      'stylist_monthly_allowance_micro', 'stylist_max_request_micro', 'stylist_max_requests_per_hour',
      'enhance_monthly_allowance_micro', 'enhance_max_request_micro', 'enhance_max_requests_per_hour']);
    expect(update).not.toMatch(/(enabled|consent|notice|manifest|activated|approval)/);
    expect(write).toContain("if v_saved<>p_limits then raise exception");
    expect(write).toContain('v_monthly>50000000');
    expect(write).toContain("p_reason_code not in ('RAISE','LOWER','PAUSE','RESTORE','CORRECTION')");
    // Reason labels are recorded only: they never appear in a validation or activation branch.
    expect(write.match(/'PAUSE'/g)).toHaveLength(1);
    expect(write.match(/'RESTORE'/g)).toHaveLength(1);
  });

  it('keeps the audit append-only except for the two profile foreign-key actions', async () => {
    const guard = between(await read(MAIN), 'create function private.ai_limit_audit_guard()', '\n$$;');
    expect(guard).toContain("if pg_trigger_depth()>1 and not exists(select 1 from public.profiles where owner_id=old.owner_id)");
    expect(guard).toContain("(to_jsonb(new)-'actor_owner_id')=(to_jsonb(old)-'actor_owner_id')");
    expect(guard).toContain('not exists(select 1 from public.profiles where owner_id=old.actor_owner_id)');
    expect(guard).toContain("raise exception using errcode='42501'");
    const sql = await read(MAIN);
    expect(sql).toContain('owner_id uuid not null references public.profiles(owner_id) on delete cascade,\n  target_admission_no');
    expect(sql).toContain('actor_owner_id uuid references public.profiles(owner_id) on delete set null');
    expect(sql).toContain('before truncate on private.ai_limit_audit');
  });

  it('adds the admin row and both audit columns to the deletion inventory', async () => {
    const inventory = between(await read(MAIN), 'create or replace function private.deletion_owner_rows_absent(', '\n$$;');
    for (const clause of ['private.app_admins where owner_id=p_owner', 'private.ai_limit_audit where owner_id=p_owner',
      'private.ai_limit_audit where actor_owner_id=p_owner']) expect(inventory, clause).toContain(clause);
  });

  it('discloses no email, user ID, approval reference or private content', async () => {
    const sql = await read(MAIN);
    const readers = ['admin_status(', 'admin_ai_spending(', 'admin_month(', 'admin_account(', 'admin_limits(']
      .map((name) => between(sql, `function ${name.includes('status') || name.includes('spending') ? 'public' : 'private'}.${name}`, '\n$$;'))
      .join('\n');
    expect(readers).not.toMatch(/'(email|userId|user_id|ownerId|approvalRef)'/);
    expect(readers).not.toMatch(/\b(email|approval_ref)\b/);
    expect(readers).not.toMatch(/public\.(items|item_images|outfits|style_preferences)\b/);
  });
});
