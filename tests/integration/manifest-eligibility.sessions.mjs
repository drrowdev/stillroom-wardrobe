// Scoped manifest eligibility for the CI-only preservation rehearsal.
//
// The frozen historical Stylist (review date 2026-12-01), photo clean-up, try-on and legacy Google (2027-01-01) function bodies
// refuse with UNCONFIGURED once their manifest's review_expires_at has passed. The real app has no such check since
// 20261101080000_persistent_ai_availability, but the historical stages below it replay the frozen bodies, so after a date the
// populated fixtures they build could no longer be produced.
//
// During a behavioural phase only, the review_expires_at of the explicitly named non-Azure manifests is moved into the future
// in the disposable rehearsal database, then restored exactly before the phase ends. The move is the single allowlisted UPDATE
// below, run in a privileged local transaction with session_replication_role = replica only around that statement (the
// manifest immutability trigger stays installed and enabled; it is skipped for that one statement and for nothing else). Every
// behavioural call in the phase is unchanged: the real historical functions and RPCs, the normal transports and all triggers.
// This is a synthetic manifest eligibility fixture, not a claim that the privileged step is immutable: the ordinary update and
// delete refusal is asserted before, during and after each phase, and the full manifest rows are compared with the snapshot
// taken before the move. The Azure analysis manifests (21 October 2026) are handled by synthetic-analysis.sessions.mjs.
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export const ELIGIBILITY_LABEL = 'synthetic manifest eligibility; real historical functions/RPCs';
export const ELIGIBLE_UNTIL = '2099-01-01T00:00:00Z';

// The allowlist: the exact original dates (pinned against the migrations by tests/unit/manifest-eligibility.test.ts).
export const MANIFEST_DATES = Object.freeze({
  'google-eu-3.8-v1': '2027-01-01T00:00:00Z',
  'azure-eu-terra-stylist-v1': '2026-12-01T00:00:00Z',
  'azure-eu-terra-stylist-v2': '2026-12-01T00:00:00Z',
  'azure-global-image25-sunburst-enhance-v1': '2027-01-01T00:00:00Z',
  'azure-global-image25-sunburst-cleanup-v1': '2027-01-01T00:00:00Z',
  'azure-global-image25-sunburst-tryon-v1': '2027-01-01T00:00:00Z',
});

export const SNAPSHOT_SQL = `select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from private.ai_execution_manifests m;`;

const TRIGGER_STATE = `select t.tgenabled from pg_trigger t where t.tgrelid='private.ai_execution_manifests'::regclass
      and t.tgname='ai_manifest_immutable' and not t.tgisinternal`;

// One atomic move of the allowlisted rows. Preconditions, the role restore and the row count are checked inside the
// transaction, so any deviation aborts it with nothing changed.
export function moveSql(direction, dates = MANIFEST_DATES) {
  requireEvidence(direction === 'advance' || direction === 'restore');
  const ids = Object.keys(dates);
  const rows = ids.map((id) => {
    const [from, to] = direction === 'advance' ? [dates[id], ELIGIBLE_UNTIL] : [ELIGIBLE_UNTIL, dates[id]];
    return `(${literal(id)},${literal(from)}::timestamptz,${literal(to)}::timestamptz)`;
  });
  return `begin;
set local lock_timeout='5s'; set local statement_timeout='30s';
do $eligibility$
declare v_role text := current_setting('session_replication_role'); v_trigger "char"; v_expected integer; v_moved integer;
begin
  ${TRIGGER_STATE.replace('select t.tgenabled', 'select t.tgenabled into v_trigger')};
  if v_role<>'origin' or v_trigger is distinct from 'O' then raise exception 'ELIGIBILITY_PRECONDITION'; end if;
  select count(*) into v_expected from private.ai_execution_manifests where id in (${ids.map(literal).join(',')});
  perform set_config('session_replication_role','replica',true);
  update private.ai_execution_manifests m set review_expires_at=v.to_at
    from (values ${rows.join(',')}) v(id,from_at,to_at) where m.id=v.id and m.review_expires_at=v.from_at;
  get diagnostics v_moved = row_count;
  perform set_config('session_replication_role',v_role,true);
  if current_setting('session_replication_role') is distinct from 'origin' then raise exception 'ELIGIBILITY_ROLE_NOT_RESTORED'; end if;
  if v_moved<>v_expected then raise exception 'ELIGIBILITY_ROWS_NOT_AS_EXPECTED'; end if;
  if (${TRIGGER_STATE}) is distinct from v_trigger then raise exception 'ELIGIBILITY_TRIGGER_CHANGED'; end if;
  perform set_config('eligibility.moved',v_moved::text,true);
end $eligibility$;
select 'MOVED:'||current_setting('eligibility.moved');
commit;`;
}

// The ordinary refusal with the trigger active: an update and a delete of a manifest row are both refused, and rolled back.
export const IMMUTABLE_SQL = `begin;
do $immutable$
declare v_id text; v_update text; v_delete text;
begin
  select id into v_id from private.ai_execution_manifests order by id limit 1;
  begin update private.ai_execution_manifests set maximum_side=maximum_side where id=v_id; v_update:='NOT_REFUSED';
  exception when insufficient_privilege then v_update:=sqlerrm; end;
  begin delete from private.ai_execution_manifests where id=v_id; v_delete:='NOT_REFUSED';
  exception when insufficient_privilege then v_delete:=sqlerrm; end;
  perform set_config('eligibility.refusal',v_update||'|'||v_delete,true);
end $immutable$;
select 'REFUSAL:'||current_setting('eligibility.refusal');
rollback;`;

const line = (output, prefix) => String(output).split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));

export function createManifestEligibility(sql, { dates = MANIFEST_DATES, log = console.log, mark = () => {} } = {}) {
  let broken = false, active = false;
  const snapshot = async () => {
    const rows = JSON.parse(await sql(SNAPSHOT_SQL));
    requireEvidence(Array.isArray(rows));
    return rows;
  };
  const presentIn = (rows) => Object.keys(dates).filter((id) => rows.some((row) => row.id === id));
  const exactDates = (rows, expected) => {
    for (const id of presentIn(rows)) {
      requireEvidence(Date.parse(rows.find((row) => row.id === id).review_expires_at) === Date.parse(expected(id)));
    }
  };
  const refusal = async () => requireEvidence(line(await sql(IMMUTABLE_SQL), 'REFUSAL:') === 'REFUSAL:Not available|Not available');
  const move = async (direction, count) => {
    requireEvidence(line(await sql(moveSql(direction, dates)), 'MOVED:') === `MOVED:${count}`);
  };

  // Moves the dates, runs the phase, and always restores them before returning; a failed restoration aborts the rehearsal.
  async function run(phase, fn) {
    requireEvidence(!broken && !active);
    active = true;
    mark(phase, 'snapshot');
    const before = await snapshot();
    const ids = presentIn(before);
    mark(phase, 'original-dates');
    exactDates(before, (id) => dates[id]);
    mark(phase, 'refusal-before');
    await refusal();
    let value, failure, failed = false;
    try {
      mark(phase, 'advance');
      await move('advance', ids.length);
      mark(phase, 'advanced-dates');
      exactDates(await snapshot(), () => ELIGIBLE_UNTIL);
      mark(phase, 'refusal-during');
      await refusal();
      mark(phase, 'phase');
      value = await fn();
    } catch (error) { failed = true; failure = error; }
    try {
      mark(phase, 'restore');
      // After a failed advance nothing moved (the transaction is atomic), so the restore is a no-op count of what moved.
      const current = await snapshot();
      const moved = presentIn(current).filter((id) => Date.parse(current.find((row) => row.id === id).review_expires_at) === Date.parse(ELIGIBLE_UNTIL));
      if (moved.length > 0) await move('restore', ids.length);
      const after = await snapshot();
      mark(phase, 'compare');
      requireEvidence(isDeepStrictEqual(after, before));
      exactDates(after, (id) => dates[id]);
      mark(phase, 'refusal-after');
      await refusal();
    } catch {
      broken = true; active = false;
      throw new Error('ELIGIBILITY_RESTORE_FAILED');
    }
    active = false;
    mark(phase, 'done');
    if (failed) throw failure;
    log(`PASS: ${phase}: ${ELIGIBILITY_LABEL}; ${ids.length} manifest date(s) moved and restored exactly; the immutability trigger refused update and delete before, during and after`);
    return value;
  }

  return { run, snapshot, refusal };
}

// ---- Real-function refusal probes -------------------------------------------------------------------------------------------
// With the original dates in place, on rows that are rolled back: the real historical function must answer exactly
// UNCONFIGURED once the real clock is past the family's date, and must pass the date gate before it (so a configuration that
// stopped being valid cannot hide behind the refusal).
const AZURE_V2 = 'azure-eu-terra-devtest-v2';
const baseControls = (uid) => `insert into private.ai_controls(owner_id,activated,notice_revision,model_id,prompt_version,max_request_micro,
    monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds,execution_manifest_id)
  values(${literal(uid)},true,2,'gpt-5.6-terra-2026-07-09',2,4097351,100000000,200,3600,${literal(AZURE_V2)})
  on conflict (owner_id) do update set activated=true,notice_revision=2,model_id=excluded.model_id,prompt_version=excluded.prompt_version,
    max_request_micro=excluded.max_request_micro,monthly_allowance_micro=excluded.monthly_allowance_micro,
    max_requests_per_hour=excluded.max_requests_per_hour,result_ttl_seconds=excluded.result_ttl_seconds,
    execution_manifest_id=excluded.execution_manifest_id;`;
export const PROBES = Object.freeze({
  stylist: Object.freeze({ id: 'azure-eu-terra-stylist-v2', setup: (uid) => `${baseControls(uid)}
    update private.ai_controls set stylist_activated=true,stylist_notice_revision=1,stylist_manifest_id='azure-eu-terra-stylist-v2',
      stylist_max_request_micro=129360,stylist_monthly_allowance_micro=10000000,stylist_max_requests_per_hour=1000,
      stylist_consent_revision=1,stylist_consented_at=clock_timestamp(),max_requests_per_hour=1000 where owner_id=${literal(uid)};`,
  call: (uid) => `public.stylist_claim(${literal(uid)},gen_random_uuid(),'azure-eu-terra-stylist-v2')` }),
  enhance: Object.freeze({ id: 'azure-global-image25-sunburst-cleanup-v1', setup: (uid) => `${baseControls(uid)}
    update private.ai_controls set enhance_activated=true,enhance_notice_revision=2,enhance_manifest_id='azure-global-image25-sunburst-cleanup-v1',
      enhance_max_request_micro=300000,enhance_max_requests_per_hour=1000,enhance_consent_revision=2,enhance_consented_at=clock_timestamp()
      where owner_id=${literal(uid)};`,
  call: (uid) => `public.enhance_claim(${literal(uid)},gen_random_uuid(),'azure-global-image25-sunburst-cleanup-v1',repeat('a',64),null::uuid)` }),
  tryon: Object.freeze({ id: 'azure-global-image25-sunburst-tryon-v1', setup: (uid) => `${baseControls(uid)}
    update private.ai_controls set tryon_activated=true,tryon_notice_revision=2,tryon_manifest_id='azure-global-image25-sunburst-tryon-v1',
      tryon_max_request_micro=800000,tryon_monthly_allowance_micro=100000000,tryon_max_requests_per_hour=1000,
      tryon_consent_revision=2,tryon_consented_at=clock_timestamp() where owner_id=${literal(uid)};`,
  call: (uid) => `public.tryon_claim(p_owner_id=>${literal(uid)},p_chain_id=>gen_random_uuid(),p_step=>1,p_request_id=>gen_random_uuid(),
    p_manifest_id=>'azure-global-image25-sunburst-tryon-v1',p_outfit_id=>gen_random_uuid(),p_person_sha256=>null::text,p_probe_id=>null::uuid)` }),
  google: Object.freeze({ id: 'google-eu-3.8-v1', setup: (uid) => `update public.profiles set ai_enabled=true,ai_notice_revision=1,ai_consented_at=clock_timestamp()
      where owner_id=${literal(uid)};
    insert into private.ai_controls(owner_id,activated,notice_revision,model_id,prompt_version,max_request_micro,monthly_allowance_micro,
      max_requests_per_hour,result_ttl_seconds,execution_manifest_id)
      values(${literal(uid)},true,1,'gemini-3.8-flash',1,2270823,100000000,200,3600,'google-eu-3.8-v1')
      on conflict (owner_id) do update set activated=true,notice_revision=1,model_id='gemini-3.8-flash',prompt_version=1,
        max_request_micro=2270823,monthly_allowance_micro=100000000,max_requests_per_hour=200,result_ttl_seconds=3600,
        execution_manifest_id='google-eu-3.8-v1';`,
  call: (uid) => `public.ai_claim_analysis(${literal(uid)},gen_random_uuid(),gen_random_uuid(),1,repeat('a',64),1000,120,80,'google-eu-3.8-v1')` }),
});

const reply = (output) => {
  const text = line(output, 'R:');
  requireEvidence(text !== undefined);
  return JSON.parse(text.slice(2));
};

// uid: an approved owner of the disposable database. A family is checked at the stage whose historical bodies it replays.
export async function realRefusalProbes(sql, uid, families, { dates = MANIFEST_DATES, log = console.log } = {}) {
  const out = [];
  for (const family of families) {
    const probe = PROBES[family];
    requireEvidence(probe !== undefined && Object.hasOwn(dates, probe.id));
    const past = (await sql(`select (clock_timestamp()>=${literal(dates[probe.id])}::timestamptz)::text;`)).trim();
    requireEvidence(past === 'true' || past === 'false');
    const result = reply(await sql(`begin;\n${probe.setup(uid)}\nselect 'R:'||(${probe.call(uid)})::text;\nrollback;`));
    if (past === 'true') requireEvidence(result.code === 'UNCONFIGURED' && result.claimed !== true);
    else requireEvidence(result.code !== 'UNCONFIGURED');
    out.push(`${family} ${past === 'true' ? 'refuses with UNCONFIGURED' : 'passes the date gate'}`);
  }
  log(`PASS: real historical gates on rolled-back rows (${out.join('; ')})`);
  return out;
}
