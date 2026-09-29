import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for VTO-1 (plan rev4 with the critic's binding amendments). The CI preservation, deletion and security
// jobs prove the migration applies and behaves; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261003090000_try_on.sql';
const SCHEDULE = '20261003090100_tryon_expire_schedule.sql';
const between = (sql: string, start: string, end: string) => {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = sql.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return sql.slice(from, to);
};
const ordered = (text: string, steps: string[]) => {
  let offset = 0;
  for (const step of steps) {
    const next = text.indexOf(step, offset);
    expect(next, step).toBeGreaterThan(-1);
    offset = next + step.length;
  }
};
const OWNER_RPCS = ['tryon_status()', 'tryon_set_consent(boolean,integer)', 'tryon_chain_status(uuid)', 'tryon_cancel(uuid)',
  'tryon_results_v1()', 'tryon_result_image_v1(uuid)', 'tryon_delete_result(uuid)'];
const SERVICE_RPCS = ['tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)', 'tryon_dispatch(uuid,uuid,boolean)',
  'tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean)', 'tryon_purge_health()',
  'tryon_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz)'];
const OWNER_ONLY = ['tryon_expire_due(integer)', 'tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)',
  'tryon_discard_transient()'];

describe('try-on migration (VTO-1)', () => {
  it('is one LF transaction after AD1, followed only by its schedule', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- VTO-1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.slice(-3)).toEqual(['20261002090000_photo_cleanup_manifest.sql', MAIN, SCHEDULE]);
    const replaced = [...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((match) => match[1]);
    expect(replaced).toEqual(['public.admin_set_ai_limits', 'private.deletion_owner_rows_absent']);
    expect(sql).not.toMatch(/\bdrop (function|table|trigger)\b/);
  });

  it('adds four private RLS tables with no grants and owner-composite keys', async () => {
    const sql = await read(MAIN);
    for (const table of ['tryon_chains', 'tryon_attempts', 'tryon_results', 'tryon_probe_authorisations']) {
      expect(sql).toContain(`create table private.${table} (`);
      expect(sql).toContain(`alter table private.${table} enable row level security;`);
    }
    expect(sql).toContain('revoke all on private.tryon_chains,private.tryon_attempts,private.tryon_results,'
      + 'private.tryon_probe_authorisations\n  from public,anon,authenticated,service_role;');
    expect(sql).not.toMatch(/grant [^;]* on (table )?private\.tryon_/);
    const chains = between(sql, 'create table private.tryon_chains (', '\n);');
    expect(chains).toContain('foreign key(owner_id,outfit_id) references public.outfits(owner_id,id) on delete cascade');
    const attempts = between(sql, 'create table private.tryon_attempts (', '\n);');
    expect(attempts).toContain('foreign key(owner_id,chain_id) references private.tryon_chains(owner_id,chain_id) on delete cascade');
    const results = between(sql, 'create table private.tryon_results (', '\n);');
    expect(results).toContain('foreign key(owner_id,outfit_id) references public.outfits(owner_id,id) on delete cascade');
    expect(results).toContain("expires_at = completed_at + interval '7 days'");
    expect(results).toContain('octet_length(jpeg) between 1 and 512000');
    expect(results).not.toContain('chain_id) references');
  });

  it('stores no body-photo byte or hash', async () => {
    const sql = await read(MAIN);
    const claim = between(sql, 'create function public.tryon_claim(', '\n$$;');
    expect(claim).toContain('(p_step=1 and p_person_sha256 is not null)');
    expect(claim).toContain('p_person_sha256 is distinct from t.last_output_sha256');
    expect(sql).toContain('or (enhance_input_sha256 is null and enhance_probe_id is null and stylist_code is null)');
    const chains = between(sql, 'create table private.tryon_chains (', '\n);');
    expect(chains).toContain("check (state='running' or (active_request_id is null and last_output_sha256 is null");
    for (const table of ['tryon_chains', 'tryon_attempts', 'tryon_results', 'tryon_probe_authorisations']) {
      expect(between(sql, `create table private.${table} (`, '\n);')).not.toMatch(/person|body/);
    }
    expect(between(sql, 'alter table private.ai_usage_evidence\n  add column', ';')).not.toMatch(/person|body/);
  });

  it('keeps evidence immutable: the cutoff, probe and a set authorisation never change', async () => {
    const guard = between(await read(MAIN), 'create function private.tryon_evidence_guard()', '\n$$;');
    for (const text of ['new.tryon_dispatch_before is distinct from old.tryon_dispatch_before',
      'new.tryon_probe_id is distinct from old.tryon_probe_id',
      'old.tryon_dispatch_authorised_at is not null\n      and new.tryon_dispatch_authorised_at is distinct from old.tryon_dispatch_authorised_at',
      "raise exception using errcode='42501',message='Try-on evidence is immutable'"]) expect(guard).toContain(text);
    expect(await read(MAIN)).toContain('create trigger ai_usage_evidence_tryon_guard before insert or update on private.ai_usage_evidence');
  });

  it('authorises dispatch once, before the cutoff, rechecked after the locks', async () => {
    const dispatch = between(await read(MAIN), 'create function public.tryon_dispatch(', '\n$$;');
    ordered(dispatch, ['perform private.image_change_lock(p_owner_id)', 'from public.profiles where owner_id=p_owner_id for update nowait',
      'from private.ai_controls where owner_id=p_owner_id for update nowait', 'from private.tryon_chains where',
      'from private.provider_capacity where', 'from private.ai_usage where', 'from private.ai_usage_evidence where',
      "if e.tryon_dispatch_authorised_at is not null then\n    return jsonb_build_object('code','ALREADY_AUTHORISED')",
      "if p_client_present is not true then return jsonb_build_object('code','CLIENT_GONE')",
      'v_auth := clock_timestamp();', "if v_auth>=e.tryon_dispatch_before then return jsonb_build_object('code','EXPIRED')",
      'update private.ai_usage_evidence set tryon_dispatch_authorised_at=v_auth']);
    expect(dispatch).not.toMatch(/tryon_dispatch_authorised_at\s*=\s*null/);
  });

  it('settles from durable evidence only, never inferring non-dispatch from a missing attempt', async () => {
    const finish = between(await read(MAIN), 'create function public.tryon_finish(', '\n$$;');
    ordered(finish, ["if p_fetch_started and e.tryon_dispatch_authorised_at is null then",
      "if p_code='PRE_DISPATCH' then", 'if e.tryon_dispatch_authorised_at is null then',
      "charge_state='released'", "enhance_settlement_origin='unmetered'", "return jsonb_build_object('code','NOT_DISPATCHED'"]);
    expect(finish).not.toMatch(/from private\.tryon_attempts/);
    const expiry = between(await read(MAIN), 'create function private.tryon_expire_accounting(', '\n$$;');
    expect(expiry).toContain("e.tryon_dispatch_authorised_at<=p_now-interval '3 minutes'");
    expect(expiry).toContain('e.tryon_dispatch_authorised_at is null and e.tryon_dispatch_before<p_now');
    expect(expiry).not.toMatch(/join private\.tryon_(chains|attempts)/);
  });

  it('publishes only for the running chain\'s active attempt and never resurrects a deleted result', async () => {
    const finish = between(await read(MAIN), 'create function public.tryon_finish(', '\n$$;');
    expect(finish).toContain("v_active := t.chain_id is not null and t.state='running' and t.expires_at>v_now");
    // Both deadlines are applied under the finish locks before any settlement or publication is decided.
    ordered(finish, ['perform private.tryon_expire_owner(p_owner_id,clock_timestamp(),100);',
      'select * into u from private.ai_usage where owner_id=p_owner_id and request_id=p_request_id;', 'v_digest :=']);
    // A replayed intermediate is delivered only while it is still the running chain's current output.
    ordered(finish, ["if v_code='OK' and (v_last or", "if t.chain_id is null or t.state<>'running' or t.expires_at<=v_now",
      "return jsonb_build_object('code','LATE','replayed',true"]);
    ordered(finish, ['if not v_active then', "return jsonb_build_object('code','LATE'", "update private.tryon_results set state='ready'"]);
    expect(finish).toContain('No resurrection: a deleted or expired');
  });

  it('rechecks the frozen garment at every step claim and never substitutes', async () => {
    const sql = await read(MAIN);
    const current = between(sql, 'create function private.tryon_garment_current(', '\n$$;');
    for (const text of ["i.lifecycle='active' and i.deleted_at is null", "im.state='ready' and im.main_sha256=p_sha and im.main_bytes=p_bytes",
      'private.item_deletion_claims', "o.phase<>'cancelled'", "j.stage<>'complete'"]) expect(current).toContain(text);
    const claim = between(sql, 'create function public.tryon_claim(', '\n$$;');
    ordered(claim, ['if not private.tryon_garment_current(', "perform private.tryon_end_chain(p.owner_id,t.chain_id,'stale','CHAIN_MISMATCH',v_now)",
      "return jsonb_build_object('code','CHAIN_MISMATCH'", 'insert into private.ai_usage(']);
  });

  it('claims in the documented lock order and blocks new chains while purge is overdue', async () => {
    const claim = between(await read(MAIN), 'create function public.tryon_claim(', '\n$$;');
    ordered(claim, ['perform private.image_change_lock(p_owner_id)', 'from public.profiles where owner_id=p_owner_id for update nowait',
      'from private.ai_controls where owner_id=p_owner_id for update nowait', 'from private.tryon_probe_authorisations where',
      'from private.tryon_chains where', 'join private.provider_deployments d', 'perform private.tryon_expire_owner(',
      "if private.tryon_purge_overdue(v_now) then return jsonb_build_object('code','UNAVAILABLE'"]);
    expect(claim).toContain("(state='reserved' or expires_at>v_now))>=20");
  });

  it('grants seven owner RPCs and the admin v2 pair to authenticated, five to the service role, and none of the maintenance steps', async () => {
    const sql = await read(MAIN);
    const grants = [...sql.matchAll(/\bgrant execute on function ([^;]*) to (\w+);/g)];
    expect(grants.map((grant) => grant[2])).toEqual(['authenticated', 'service_role']);
    const list = (text: string) => text.replace(/\s+/g, '').split(/,(?=public\.)/).map((name) => name.replace(/^public\./, ''));
    expect(list(grants[0]?.[1] ?? '')).toEqual([...OWNER_RPCS, 'admin_set_ai_limits(smallint,text,jsonb,jsonb,text)',
      'admin_set_ai_limits_v2(smallint,text,jsonb,jsonb,text)', 'admin_ai_spending_v2(integer)']);
    expect(list(grants[1]?.[1] ?? '')).toEqual(SERVICE_RPCS);
    for (const name of OWNER_ONLY) {
      expect(sql).toContain(`public.${name}`);
      expect(grants.some((grant) => grant[1]?.replace(/\s+/g, '').includes(name))).toBe(false);
    }
    for (const name of [...OWNER_RPCS, ...SERVICE_RPCS, ...OWNER_ONLY]) {
      const body = between(sql, `create function public.${name.slice(0, name.indexOf('('))}(`, '$$');
      expect(body, name).toContain('security definer');
      expect(body, name).toContain("set search_path = ''");
    }
  });

  it('adds the four tables to the deletion inventory and keeps the admin disclosure to amounts and limits', async () => {
    const sql = await read(MAIN);
    const absent = between(sql, 'create or replace function private.deletion_owner_rows_absent(', '\n$$;');
    for (const table of ['tryon_chains', 'tryon_attempts', 'tryon_results', 'tryon_probe_authorisations']) {
      expect(absent).toContain(`exists(select 1 from private.${table} where owner_id=p_owner)`);
    }
    const account = between(sql, 'create function private.admin_account_v2(', '\n$$;');
    expect(account).not.toMatch(/jpeg|result_id|chain_id|sha256|consent/);
    const write = between(sql, 'create function private.admin_set_limits(', '\n$$;');
    ordered(write, ["if v_actor is null then return jsonb_build_object('code','UNAVAILABLE')",
      'order by admission_no for share nowait', 'private.admin_account_version(t.admission_no,t.generation)<>p_account_version',
      'from private.ai_controls where owner_id=t.user_id for update', 'update private.ai_controls set',
      'insert into private.ai_limit_audit(']);
    expect(write).toContain('if not p_v2 and c.tryon_monthly_allowance_micro is not null and v_shared<c.tryon_monthly_allowance_micro then');
  });

  it('schedules one active expiry job that only calls the bounded maintenance function', async () => {
    const sql = await read(SCHEDULE);
    expect(sql).toContain("perform cron.schedule('stillroom-tryon-expire', '*/15 * * * *', 'select public.tryon_expire_due(500)');");
    expect(sql).not.toContain('active := false');
    expect([...sql.matchAll(/perform cron\.\w+\(/g)]).toHaveLength(1);
  });
});
