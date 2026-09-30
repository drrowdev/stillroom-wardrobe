import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for FILT1 (plan rev3, approved by 001cb8ee). The integration, security and rehearsal jobs prove the
// behaviour; these checks keep each replaced body equal to the installed body plus only the named insertions, and
// pin the one-transaction shape, the restrictive drops, the gates and the grants.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261005090000_provider_refusal.sql';
const cut = (text: string, start: string) => {
  const i = text.indexOf(start);
  expect(i, start).toBeGreaterThan(-1);
  const j = text.indexOf('\n$$;\n', i);
  return text.slice(i, j + 5);
};
const once = (text: string, from: string, to: string) => {
  expect(text.split(from).length - 1, from).toBe(1);
  return text.replace(from, to);
};

const KINDS = "('rai_input','rai_output','unknown_filter','unverified_filter')";
const QUALIFYING = "('rai_input','rai_output','unknown_filter')";
const VALIDATION = `    or (p_refusal_kind is not null and p_refusal_kind not in ${KINDS})
    or (p_code<>'FILTERED' and (p_refusal_kind is not null or p_usage_absent is not null))
    or (p_usage_absent is not null and (p_usage is not null or p_refusal_kind is null))
`;
const OLD_DIGEST = `v_digest := encode(sha256(convert_to(jsonb_build_object('code',p_code,'usage',p_usage,'outputSha256',p_output_sha256,
    'outputBytes',p_output_bytes)::text,'UTF8')),'hex');`;
const NEW_DIGEST = `v_digest := encode(sha256(convert_to((jsonb_build_object('code',p_code,'usage',p_usage,'outputSha256',p_output_sha256,
    'outputBytes',p_output_bytes)||jsonb_strip_nulls(jsonb_build_object('refusalKind',p_refusal_kind,
    'usageAbsent',p_usage_absent)))::text,'UTF8')),'hex');`;
const UNMETERED_EVIDENCE = `update private.ai_usage_evidence set anomaly=true,enhance_code=p_code,enhance_settlement_origin='unmetered',
      enhance_settlement_digest=v_digest
      where owner_id=p_owner_id and request_id=p_request_id;
    if a.id is not null and a.stopped_at is null then`;
const UNMETERED_EVIDENCE_NEW = `update private.ai_usage_evidence set anomaly=true,enhance_code=p_code,enhance_settlement_origin='unmetered',
      enhance_settlement_digest=v_digest,provider_refusal=p_refusal_kind,usage_absent=p_usage_absent
      where owner_id=p_owner_id and request_id=p_request_id;
    if a.id is not null and a.stopped_at is null then`;
const TERMINAL = `enhance_code=p_code,enhance_settlement_origin='terminal_anomaly',enhance_settlement_digest=v_digest
      where owner_id=p_owner_id and request_id=p_request_id;`;
const TERMINAL_NEW = `enhance_code=p_code,enhance_settlement_origin='terminal_anomaly',enhance_settlement_digest=v_digest,
      provider_refusal=p_refusal_kind
      where owner_id=p_owner_id and request_id=p_request_id;`;
const OBSERVED = `enhance_code=p_code,enhance_settlement_origin='observed',enhance_settlement_digest=v_digest
    where owner_id=p_owner_id and request_id=p_request_id;`;
const OBSERVED_NEW = `enhance_code=p_code,enhance_settlement_origin='observed',enhance_settlement_digest=v_digest,
    provider_refusal=p_refusal_kind
    where owner_id=p_owner_id and request_id=p_request_id;`;
const filteredBranch = (probeTable: string, close: string) => `  -- FILT1: a proven content-filter refusal with genuinely absent metering. Charged the full reservation like
  -- unmetered, but not an anomaly; a probe authorisation still stops (missing usage). The switch and activation stay.
  if p_usage is null and p_code='FILTERED' and p_usage_absent and p_refusal_kind in ${QUALIFYING} then
    update private.ai_usage set charge_state='estimated',accounted_micro=greatest(accounted_micro,reserved_micro),
      closed_reason=coalesce(closed_reason,'FAILED'),closed_at=coalesce(closed_at,v_now)
      where owner_id=p_owner_id and request_id=p_request_id returning * into u;
    update private.ai_usage_evidence set anomaly=false,enhance_code=p_code,enhance_settlement_origin='filtered_unmetered',
      enhance_settlement_digest=v_digest,provider_refusal=p_refusal_kind,usage_absent=true
      where owner_id=p_owner_id and request_id=p_request_id;
    if a.id is not null and a.stopped_at is null then
      update private.${probeTable} set stopped_at=v_now,stopped_reason='MISSING_USAGE' where id=a.id;
    end if;
${close}    return jsonb_build_object('code',p_code,'accounting',private.ai_accounting(u));
  end if;
  if p_usage is null and p_code<>'OK' then`;


const OLD_TRYON = 'public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean)';
const NEW_TRYON = 'public.tryon_finish(uuid,uuid,text,jsonb,text,integer,bytea,boolean,boolean,boolean,text,boolean)';
const OLD_ENH = 'public.enhance_finish(uuid,uuid,text,jsonb,text,integer)';
const NEW_ENH = 'public.enhance_finish(uuid,uuid,text,jsonb,text,integer,text,boolean)';

const expected = async () => {
  const tryon = await read('20261003090000_try_on.sql');
  const enh = await read('20260929090000_photo_enhancement.sql');
  // try-on
  let tr = cut(tryon, 'create function private.tryon_replay(');
  tr = once(tr, 'create function private.tryon_replay(', 'create or replace function private.tryon_replay(');
  tr = once(tr, `    when e.enhance_settlement_origin='unmetered' then e.enhance_code\n`,
    `    when e.enhance_settlement_origin='unmetered' then e.enhance_code\n    when e.enhance_settlement_origin='filtered_unmetered' then 'FILTERED'\n`);
  let tf = cut(tryon, 'create function public.tryon_finish(');
  tf = once(tf, 'p_output bytea,p_fetch_started boolean,p_client_live_at_fetch boolean,p_client_gone boolean)\n',
    'p_output bytea,p_fetch_started boolean,p_client_live_at_fetch boolean,p_client_gone boolean,\n  p_refusal_kind text default null,p_usage_absent boolean default null)\n');
  tf = once(tf, '    or p_fetch_started is null or p_client_gone is null\n', '    or p_fetch_started is null or p_client_gone is null\n' + VALIDATION);
  tf = once(tf, OLD_DIGEST, NEW_DIGEST);
  tf = once(tf, `if e.enhance_settlement_origin in ('observed','unmetered','terminal_anomaly','non_dispatch','pre_dispatch') then`,
    `if e.enhance_settlement_origin in ('observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch','pre_dispatch') then`);
  tf = once(tf, '  if p_usage is null and p_code<>\'OK\' then', filteredBranch('tryon_probe_authorisations',
    "    perform private.tryon_close_attempt(p_owner_id,p_request_id,'failed',v_now);\n"));
  tf = once(tf, UNMETERED_EVIDENCE, UNMETERED_EVIDENCE_NEW);
  tf = once(tf, TERMINAL, TERMINAL_NEW);
  tf = once(tf, OBSERVED, OBSERVED_NEW);
  
  // enhance
  let er = cut(enh, 'create function private.enhance_replay(');
  er = once(er, 'create function private.enhance_replay(', 'create or replace function private.enhance_replay(');
  er = once(er, `    when e.enhance_settlement_origin='unmetered' then e.enhance_code\n`,
    `    when e.enhance_settlement_origin='unmetered' then e.enhance_code\n    when e.enhance_settlement_origin='filtered_unmetered' then 'FILTERED'\n`);
  let ef = cut(enh, 'create function public.enhance_finish(');
  ef = once(ef, '  p_output_sha256 text,p_output_bytes integer) returns jsonb\n',
    '  p_output_sha256 text,p_output_bytes integer,p_refusal_kind text default null,p_usage_absent boolean default null)\nreturns jsonb\n');
  ef = once(ef, "    or (p_code='NOT_DISPATCHED' and p_usage is not null)\n", "    or (p_code='NOT_DISPATCHED' and p_usage is not null)\n" + VALIDATION);
  ef = once(ef, OLD_DIGEST, NEW_DIGEST);
  ef = once(ef, `if e.enhance_settlement_origin in ('observed','unmetered','terminal_anomaly','non_dispatch') then`,
    `if e.enhance_settlement_origin in ('observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch') then`);
  ef = once(ef, '  if p_usage is null and p_code<>\'OK\' then', filteredBranch('enhancement_probe_authorisations', ''));
  ef = once(ef, UNMETERED_EVIDENCE, UNMETERED_EVIDENCE_NEW);
  ef = once(ef, TERMINAL, TERMINAL_NEW);
  ef = once(ef, OBSERVED, OBSERVED_NEW);
  
  return { tr, er, tf, ef };
};
const count = (text: string, part: string) => text.split(part).length - 1;

describe('FILT1 provider refusal migration (source pins)', () => {
  it('is one LF transaction marked FILT1, with restrictive drops and no cascade', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- FILT1:')).toBe(true);
    expect(sql).not.toContain('\r');
    expect(sql.toLowerCase()).not.toContain('cascade');
    expect(count(sql, '\nbegin;\n')).toBe(1);
    expect(sql.endsWith('\ncommit;\n')).toBe(true);
    expect(count(sql, '\ncommit;')).toBe(1);
    expect(sql.indexOf('\nbegin;\n')).toBeLessThan(sql.indexOf('do $$'));
    expect(count(sql, `drop function ${OLD_TRYON} restrict;`)).toBe(1);
    expect(count(sql, `drop function ${OLD_ENH} restrict;`)).toBe(1);
    expect(count(sql, 'drop function ')).toBe(2);
  });

  it('checks properties and dependants before replacing, and properties after', async () => {
    const sql = await read(MAIN);
    const pre = sql.indexOf("raise exception 'FILT1 precondition: % properties not as expected'");
    const deps = sql.indexOf("raise exception 'FILT1 precondition: the finish functions have dependants'");
    const cron = sql.indexOf("raise exception 'FILT1 precondition: a scheduled job calls a finish function'");
    const alter = sql.indexOf('alter table private.ai_usage_evidence');
    const drop = sql.indexOf('drop function ');
    const post = sql.indexOf("raise exception 'FILT1 postcondition: % properties not as expected'");
    for (const at of [pre, deps, cron, alter, drop, post]) expect(at).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(alter);
    expect(deps).toBeLessThan(alter);
    expect(cron).toBeLessThan(alter);
    expect(alter).toBeLessThan(drop);
    expect(drop).toBeLessThan(post);
    expect(sql).toContain("raise exception 'FILT1 postcondition: an old finish signature remains'");
    expect(sql).toContain("raise exception 'FILT1 postcondition: a constraint is not validated'");
    expect(count(sql, "<>array['lock_timeout=2s','search_path=\"\"']")).toBe(2);
    expect(count(sql, "and x.grantee not in (p.proowner,'service_role'::regrole)")).toBe(2);
    expect(count(sql, "'public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)'::regprocedure")).toBe(2);
  });

  it('adds the bounded columns and widens only the origin and digest checks', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain(`  drop constraint ai_usage_evidence_enhance_settlement_origin_check,
  drop constraint ai_usage_evidence_enhance_digest;`);
    expect(count(sql, 'drop constraint')).toBe(2);
    expect(sql).toContain('  add column provider_refusal text,\n  add column usage_absent boolean,\n');
    expect(sql).toContain(`('provisional_expiry','observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch','pre_dispatch')`);
    expect(sql).toContain(`((enhance_settlement_origin in ('observed','unmetered','filtered_unmetered','terminal_anomaly','non_dispatch','pre_dispatch'))`);
    expect(sql).toContain(`add constraint ai_usage_evidence_refusal_kind check (provider_refusal in ${KINDS}),`);
    expect(sql).toContain("add constraint ai_usage_evidence_refusal_filtered check (provider_refusal is null or enhance_code='FILTERED'),");
    expect(sql).toContain(`or (enhance_code is not distinct from 'FILTERED' and provider_refusal is not null and provider_refusal in ${QUALIFYING}
      and usage_absent is true and normalized_usage is null and anomaly is false));`);
  });

  it('keeps each replaced body equal to the installed body plus only the named insertions', async () => {
    const sql = await read(MAIN);
    const { tr, er, tf, ef } = await expected();
    for (const part of [tr, er, tf, ef]) expect(count(sql, part)).toBe(1);
    expect(tf).toContain("p_refusal_kind text default null,p_usage_absent boolean default null)\nreturns jsonb\nlanguage plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$");
    expect(ef).toContain("p_refusal_kind text default null,p_usage_absent boolean default null)\nreturns jsonb\nlanguage plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$");
    expect(sql.indexOf(`drop function ${OLD_TRYON} restrict;\n${tf}`)).toBeGreaterThan(-1);
    expect(sql.indexOf(`drop function ${OLD_ENH} restrict;\n${ef}`)).toBeGreaterThan(-1);
    // The filtered branch sits before unmetered and never touches the switch or activation.
    for (const body of [tf, ef]) {
      const branch = body.slice(body.indexOf('-- FILT1:'), body.indexOf("  if p_usage is null and p_code<>'OK' then"));
      expect(branch).toContain("enhance_settlement_origin='filtered_unmetered'");
      expect(branch).toContain('anomaly=false');
      expect(branch).toContain("stopped_reason='MISSING_USAGE'");
      expect(branch).not.toMatch(/provider_capacity|_activated/);
    }
    expect(sql).not.toContain('create function public.stylist_finish');
  });

  it('grants execute on the new signatures to service_role only', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain(`revoke all on function ${NEW_TRYON},${NEW_ENH} from public,anon,authenticated,service_role;
grant execute on function ${NEW_TRYON},${NEW_ENH} to service_role;`);
    expect(count(sql, 'grant execute')).toBe(1);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
  });
});
