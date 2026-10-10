// BUDGET1: the one monthly AI budget against the real schema after 20261010090000. Invoked only by the CI-only
// preservation owner, after every frozen historical check ran at the exact prior inventory (20261009090000). Claims,
// probe authorisations and the allocation are service/operator functions, called through privileged SQL the way the Edge
// handlers and the operator call them; every owner-facing assertion uses the ordinary A/B sessions (which send
// X-Stillroom-AI-Budget-Contract: 2) or a simulated ordinary session with the header absent or unsupported. Fixture rows
// are removed and the controls, consent, capacity switch and admin grant are restored in finally. No provider calls.
import { createHash, randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';
import { beginArgs } from './ai-controls.sessions.mjs';

const STYLIST = 'azure-eu-terra-stylist-v2';
const STYLIST_RESERVE = 129360;
const CLEANUP = 'azure-global-image25-sunburst-cleanup-v1';
const CLEANUP_RESERVE = 300000;
const TRYON = 'azure-global-image25-sunburst-tryon-v1';
const TRYON_RESERVE = 360000;
const LEGACY_MAX = 5000;
const DRAIN = 50;
const HEADER = 'x-stillroom-ai-budget-contract';
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const UNAVAILABLE = Object.freeze({ code: 'UNAVAILABLE' });
const PUBLIC_NAMES = ['ai_status', 'ai_set_consent', 'stylist_status', 'enhance_status', 'tryon_status', 'stylist_set_consent', 'enhance_set_consent',
  'tryon_set_consent', 'stylist_claim', 'enhance_claim', 'tryon_claim', 'enhance_probe_authorise', 'tryon_probe_authorise',
  'tryon_bootstrap', 'stylist_direct_allocation', 'admin_ai_spending', 'admin_set_ai_limits', 'admin_ai_spending_v2',
  'admin_set_ai_limits_v2'];
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, out);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { out.add(key); keysOf(entry, out); }
  return out;
};

export async function sharedBudgetProbes(snapshot, sql, mark) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const ids = [];
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const allowanceOf = (owner) => scalar(`select monthly_allowance_micro::text from private.ai_controls where owner_id=${literal(owner.uid)};`);
  const profileAi = (owner) => one(`select jsonb_build_object('enabled',ai_enabled,'notice',ai_notice_revision,'at',ai_consented_at)
    from public.profiles where owner_id=${literal(owner.uid)};`);
  const used = async (owner, at = 'clock_timestamp()') => BigInt(await scalar(`select private.ai_budget_used(${literal(owner.uid)},${at});`));
  const nextMonth = `((date_trunc('month',clock_timestamp() at time zone 'UTC')+interval '1 month') at time zone 'UTC')`;
  const setAllowance = (owner, micro) => sql(`update private.ai_controls set monthly_allowance_micro=${micro},
    updated_at=clock_timestamp() where owner_id=${literal(owner.uid)};`);
  const asOwner = async (owner, headers, call) => {
    const out = await sql(`begin; set local role authenticated;
      select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: owner.uid, role: 'authenticated' }))},true);
      select set_config('request.headers',${literal(JSON.stringify(headers))},true);
      select 'R:'||(${call})::text; commit;`);
    const line = out.split('\n').find((entry) => entry.startsWith('R:'));
    requireEvidence(line !== undefined);
    return JSON.parse(line.slice(2));
  };
  const supported = { [HEADER]: '2' };
  const unsupported = [{}, { [HEADER]: '1' }, { [HEADER]: '3' }, { [HEADER]: '' }, { [HEADER]: '2 ' }];
  const activate = (owner, allowance) => sql(`update private.ai_controls set activated=true,notice_revision=1,
    model_id='fictional:controls/v1',prompt_version=1,max_request_micro=${LEGACY_MAX},monthly_allowance_micro=${allowance},
    max_requests_per_hour=1,result_ttl_seconds=3600,execution_manifest_id=null,
    stylist_activated=true,stylist_notice_revision=1,stylist_manifest_id=${literal(STYLIST)},stylist_max_request_micro=${STYLIST_RESERVE},
    stylist_max_requests_per_hour=1,enhance_activated=true,enhance_notice_revision=2,enhance_manifest_id=${literal(CLEANUP)},
    enhance_max_request_micro=${CLEANUP_RESERVE},enhance_max_requests_per_hour=1,tryon_activated=true,tryon_notice_revision=1,
    tryon_manifest_id=${literal(TRYON)},tryon_max_request_micro=${TRYON_RESERVE},tryon_max_requests_per_hour=1,
    updated_at=clock_timestamp() where owner_id=${literal(owner.uid)};`);
  const deployment = (manifest) => scalar(`select deployment_key from private.provider_deployments where manifest_id=${literal(manifest)};`);
  const cleanupKey = await deployment(CLEANUP), tryonKey = await deployment(TRYON);
  requireEvidence(cleanupKey !== '' && tryonKey !== '');
  const insertUsage = async (owner, purpose, state, micro) => {
    const id = randomUUID();
    ids.push(id);
    const slotKey = purpose === 'enhancement' ? cleanupKey : purpose === 'try_on' ? tryonKey : null;
    await sql(`${slotKey === null ? '' : `with s as (insert into private.provider_slots(slot_id,deployment_key,held_until)
      values (gen_random_uuid(),${literal(slotKey)},clock_timestamp()-interval '1 hour') returning slot_id)`}
      insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,
        dispatched_at,purpose,provider_slot_id,tryon_chain_id,tryon_step) values (${literal(owner.uid)},${literal(id)},
        to_char(clock_timestamp() at time zone 'UTC','YYYY-MM'),clock_timestamp(),${Math.max(micro, 1)},${micro},'${state}',
        ${state === 'released' ? 'null' : 'clock_timestamp()'},'${purpose}',${slotKey === null ? 'null::uuid' : '(select slot_id from s)'},
        ${purpose === 'try_on' ? 'gen_random_uuid(),1::smallint' : 'null::uuid,null::smallint'});`);
  };
  const rowCount = async (owner) => Number(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(owner.uid)};`));
  const claimStylist = (owner, id = randomUUID()) => one(`select public.stylist_claim(${literal(owner.uid)},${literal(id)},${literal(STYLIST)});`);
  const finishStylist = (owner, id) => one(`select public.stylist_finish(${literal(owner.uid)},${literal(id)},'NOT_DISPATCHED',null::jsonb);`);
  const status = (owner, name) => client.rpc(owner, name, {});
  const aiConsent = async (owner, enabled) => {
    const profile = (await client.rows(owner, 'profiles'))[0];
    return client.rpc(owner, 'ai_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? 1 : null, p_expected_version: profile.version });
  };
  // An enabled feature replies with the budget contract's envelope, whatever its permission code is at this point.
  const enabled = (reply) => reply?.code !== 'UNAVAILABLE' && reply?.consent?.enabled === true && Object.hasOwn(reply, 'budget');

  const saved = { a: await controls(a), b: await controls(b), profileA: await profileAi(a), profileB: await profileAi(b),
    capacity: await one(`select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(cleanupKey)};`),
    admin: Number(await scalar('select count(*) from private.app_admins;')) };
  requireEvidence(saved.a && saved.b && saved.admin === 0);
  const restoreControls = (owner, row) => sql(`delete from private.ai_controls where owner_id=${literal(owner.uid)};
    insert into private.ai_controls select * from jsonb_populate_record(null::private.ai_controls,${json(row)});`);

  try {
    mark('structure');
    // Same-signature replacement: one overload per name, jsonb in and out, no new public RPC name.
    equal(await one(`select jsonb_object_agg(x.proname,jsonb_build_array(x.n,x.definer,x.jsonb)) from (
        select p.proname,count(*) n,bool_and(p.prosecdef) definer,bool_and(p.prorettype='jsonb'::regtype) jsonb
        from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any(array[${PUBLIC_NAMES.map(literal).join(',')}])
        group by p.proname) x;`), Object.fromEntries(PUBLIC_NAMES.map((name) => [name, [1, true, true]])));
    equal(await scalar(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%budget%';`), '0');
    equal(await one(`select jsonb_agg(has_function_privilege('authenticated',f::regprocedure,'EXECUTE')
        or has_function_privilege('anon',f::regprocedure,'EXECUTE') or has_function_privilege('service_role',f::regprocedure,'EXECUTE'))
      from unnest(array['private.ai_budget_contract()','private.ai_budget_used(uuid,timestamptz)','private.ai_budget_json(bigint,numeric)',
        'private.admin_account_v3(private.approved_accounts,timestamptz,text[])','private.admin_budget_shape(jsonb)',
        'private.admin_set_budget(smallint,text,jsonb,jsonb,text)']) f;`), [false, false, false, false, false, false]);
    equal(await scalar(`select count(*) from pg_constraint where conrelid='private.ai_controls'::regclass
      and conname in ('ai_controls_stylist_allowance','ai_controls_enhance_allowance','ai_controls_tryon_allowance');`), '0');
    equal(await scalar(`select count(*) from pg_trigger where tgrelid='private.ai_controls'::regclass
      and tgname in ('ai_controls_enhance_clamp','ai_controls_tryon_clamp');`), '0');

    mark('fixtures');
    await activate(a, 100_000_000);
    await activate(b, 100_000_000);
    for (const owner of [a, b]) {
      requireEvidence(enabled(await client.rpc(owner, 'stylist_set_consent', { p_enabled: true, p_notice_revision: 1 })));
      requireEvidence(enabled(await client.rpc(owner, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 2 })));
      requireEvidence(enabled(await client.rpc(owner, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })));
      equal((await aiConsent(owner, true)).code, 'OK');
    }

    mark('status-contract');
    for (const [name, owner] of [['ai_status', a], ['stylist_status', a], ['enhance_status', a], ['tryon_status', a], ['ai_status', b]]) {
      const reply = await status(owner, name);
      equal(Object.keys(reply.budget).sort(), ['monthlyAllowanceMicro', 'remainingMicro', 'usedMicro', 'warning']);
      equal(reply.budget.monthlyAllowanceMicro, '100000000');
      equal(reply.budget.usedMicro, String(await used(owner)));
      requireEvidence(!Object.hasOwn(reply, 'usage'));
      requireEvidence(!/allowance|hour/i.test(JSON.stringify(reply.policy ?? {})));
      requireEvidence(!JSON.stringify(reply).includes(owner === a ? b.uid : a.uid));
    }
    // A database that does not see the contract header (an old client or Edge) answers with no limit values at all.
    for (const headers of unsupported) {
      const ai = await asOwner(a, headers, 'public.ai_status()');
      equal(ai.code, 'UNAVAILABLE');
      equal(ai.policy, null);
      requireEvidence(!Object.hasOwn(ai, 'budget'));
      for (const name of ['stylist_status', 'enhance_status', 'tryon_status']) equal(await asOwner(a, headers, `public.${name}()`), UNAVAILABLE);
    }
    // SAVE1's status-version header keeps its field alongside the budget.
    const versioned = await asOwner(a, { ...supported, 'x-stillroom-ai-status-version': '2' }, 'public.ai_status()');
    requireEvidence(Object.hasOwn(versioned, 'photoModelNoticeUntilMs') && Object.hasOwn(versioned, 'budget'));
    requireEvidence(!Object.hasOwn(await asOwner(a, supported, 'public.ai_status()'), 'photoModelNoticeUntilMs'));

    mark('one-sum');
    // One money sum across analysis, Stylist, cleanup and try-on: the current UTC month's charges plus open holds.
    const before = await used(a);
    const futureBefore = await used(a, nextMonth);
    for (const [purpose, state, micro] of [['analysis', 'settled', 1000], ['stylist', 'estimated', 2000],
      ['enhancement', 'estimated', 3000], ['try_on', 'estimated', 4000], ['analysis', 'released', 0]]) await insertUsage(a, purpose, state, micro);
    equal(await used(a), before + 10_000n);
    equal(await used(a, `${nextMonth}-interval '1 second'`), before + 10_000n);
    // No carry-forward: after the UTC rollover every terminal charge is gone and nothing else changed.
    equal(await used(a, nextMonth), futureBefore);
    equal((await status(a, 'tryon_status')).budget.usedMicro, String(before + 10_000n));
    equal((await status(a, 'enhance_status')).budget.usedMicro, String(before + 10_000n));
    const base = await used(a);

    mark('claims');
    // Cleanup and try-on money count against Stylist: the claim refuses by the whole sum, writing nothing.
    await setAllowance(a, base + BigInt(STYLIST_RESERVE) - 1n);
    const rows = await rowCount(a);
    equal(await claimStylist(a), { code: 'ALLOWANCE', claimed: false });
    equal(await rowCount(a), rows);
    await setAllowance(a, base + BigInt(STYLIST_RESERVE));
    const first = randomUUID();
    equal((await claimStylist(a, first)).claimed, true);
    ids.push(first);
    equal(await claimStylist(a), { code: 'ALLOWANCE', claimed: false });
    equal(await used(a), base + BigInt(STYLIST_RESERVE));
    // A closed request without a provider call stays charged at its reservation, so the budget has no room left.
    equal((await finishStylist(a, first)).code, 'NOT_DISPATCHED');
    equal(await used(a), base + BigInt(STYLIST_RESERVE));
    equal(await claimStylist(a), { code: 'ALLOWANCE', claimed: false });
    // Two claims race for the room of exactly one: never two holds.
    await setAllowance(a, base + 2n * BigInt(STYLIST_RESERVE));
    const raced = await Promise.all([claimStylist(a), claimStylist(a)]);
    equal(raced.filter((reply) => reply.claimed === true).length, 1);
    requireEvidence(raced.every((reply) => reply.claimed === true || ['ALLOWANCE', 'BUSY'].includes(reply.code)));
    ids.push(...(await one(`select coalesce(jsonb_agg(request_id),'[]'::jsonb) from private.ai_usage where owner_id=${literal(a.uid)}
      and purpose='stylist' and charge_state='held';`)));

    mark('analysis-admission');
    // The analysis admission uses the same sum; 50 admissions inside the hour are not limited by any request count
    // (max_requests_per_hour is 1 here), and the 51st is refused by money alone.
    const baseB = await used(b);
    await setAllowance(b, baseB + BigInt(DRAIN * LEGACY_MAX));
    const drainIds = Array.from({ length: DRAIN }, () => randomUUID());
    for (const id of drainIds) {
      equal(await client.rpc(b, 'ai_begin_request', beginArgs(id, 'B')), { code: 'OK', status: 'reserved', replayed: false });
      ids.push(id);
    }
    equal(await used(b), baseB + BigInt(DRAIN * LEGACY_MAX));
    equal(await client.rpc(b, 'ai_begin_request', beginArgs(randomUUID(), 'B')), { code: 'ALLOWANCE' });
    for (const id of drainIds) {
      equal(await client.rpc(b, 'ai_request_control', { p_request_id: id, p_action: 'discard' }), { code: 'TERMINAL', reason: 'DISCARDED' });
    }
    equal(await used(b), baseB);

    mark('cleanup-capacity');
    // Cleanup: money is checked before capacity; a full shared deployment is BUSY, never a quota code.
    equal(await one(`select public.enhance_provider_control(${literal(cleanupKey)},true,null::text);`), { code: 'OK', dispatchEnabled: true });
    await sql(`update private.provider_capacity set max_dispatch=1,updated_at=clock_timestamp() where deployment_key=${literal(cleanupKey)};
      update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
        where deployment_key=${literal(cleanupKey)} and held_until>clock_timestamp();`);
    const input = createHash('sha256').update(randomUUID()).digest('hex');
    const enhance = (owner) => one(`select public.enhance_claim(${literal(owner.uid)},${literal(randomUUID())},${literal(CLEANUP)},
      ${literal(input)},null::uuid);`);
    const baseCleanup = await used(b);
    await setAllowance(b, baseCleanup + BigInt(CLEANUP_RESERVE) - 1n);
    equal(await enhance(b), { code: 'ALLOWANCE', claimed: false });
    await setAllowance(b, baseCleanup + BigInt(CLEANUP_RESERVE));
    const slot = randomUUID();
    await sql(`insert into private.provider_slots(slot_id,deployment_key,held_until)
      values (${literal(slot)},${literal(cleanupKey)},clock_timestamp()+interval '1 minute');`);
    equal(await enhance(b), { code: 'BUSY', claimed: false });
    await sql(`delete from private.provider_slots where slot_id=${literal(slot)};`);
    equal(await used(b), baseCleanup);

    mark('probe-authorisation');
    // An on-ledger probe authorisation must fit the one budget now and subtracts nothing: ordinary claims keep the room.
    const baseProbe = await used(b);
    await setAllowance(b, baseProbe + 700_000n);
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const authorise = (name, manifest, id, ref, allocation, calls = 2) => one(`select public.${name}(${literal(id)},${literal(b.uid)},
      ${literal(manifest)},${calls},${allocation},${literal(ref)},${literal(expires)}::timestamptz);`);
    const enhanceId = randomUUID(), enhanceRef = `BUDGET1-enhance-${randomUUID()}`;
    equal((await authorise('enhance_probe_authorise', CLEANUP, enhanceId, enhanceRef, 600_000)).code, 'OK');
    equal(await authorise('enhance_probe_authorise', CLEANUP, enhanceId, enhanceRef, 600_000), {
      code: 'OK', replayed: true, id: enhanceId, deploymentKey: cleanupKey });
    equal((await authorise('enhance_probe_authorise', CLEANUP, enhanceId, enhanceRef, 600_001)).code, 'CONFLICT');
    equal(await authorise('enhance_probe_authorise', CLEANUP, randomUUID(), `BUDGET1-enhance-${randomUUID()}`, 800_000),
      { code: 'DEFER', totalMicro: String(baseProbe) });
    equal(await allowanceOf(b), String(baseProbe + 700_000n));
    equal((await status(b, 'stylist_status')).budget.remainingMicro, '700000');
    const afterProbe = randomUUID();
    equal((await claimStylist(b, afterProbe)).claimed, true);
    ids.push(afterProbe);
    equal((await finishStylist(b, afterProbe)).code, 'NOT_DISPATCHED');
    await sql(`update private.enhancement_probe_authorisations set stopped_at=now(),stopped_reason='OPERATOR'
      where owner_id=${literal(b.uid)} and approval_ref like 'BUDGET1-%' and stopped_at is null;`);
    const tryonId = randomUUID(), tryonRef = `BUDGET1-tryon-${randomUUID()}`;
    await setAllowance(b, (await used(b)) + 900_000n);
    equal((await authorise('tryon_probe_authorise', TRYON, tryonId, tryonRef, 800_000, 3)).code, 'OK');
    equal((await authorise('tryon_probe_authorise', TRYON, tryonId, tryonRef, 800_000, 3)).replayed, true);
    equal((await authorise('tryon_probe_authorise', TRYON, randomUUID(), `BUDGET1-tryon-${randomUUID()}`, 1_000_000, 3)).code, 'DEFER');
    await sql(`update private.tryon_probe_authorisations set stopped_at=now(),stopped_reason='OPERATOR'
      where owner_id=${literal(b.uid)} and approval_ref like 'BUDGET1-%' and stopped_at is null;`);
    // The operator's direct-call allocation remains the one separate conservative subtraction.
    const total = (await used(b)) + 900_000n;
    equal((await one(`select public.stylist_direct_allocation(${literal(b.uid)},400000,${total});`)).code, 'OK');
    equal(await allowanceOf(b), String(total - 400_000n));
    equal((await one(`select public.stylist_direct_allocation(${literal(b.uid)},400000,${total});`)).code, 'CONFLICT');
    // Bootstrap fills only null try-on settings; the retired amount and hourly arguments never constrain the budget.
    await sql(`update private.ai_controls set tryon_activated=false,tryon_manifest_id=null,tryon_notice_revision=null,
      tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,tryon_max_requests_per_hour=null,tryon_consent_revision=null,
      tryon_consented_at=null,monthly_allowance_micro=1000,updated_at=clock_timestamp() where owner_id=${literal(b.uid)};`);
    const boot = (max) => one(`select public.tryon_bootstrap(${literal(b.uid)},${literal(TRYON)},1,${max},null::bigint,null::integer);`);
    equal(await boot(TRYON_RESERVE), { code: 'OK', replayed: false });
    equal(await boot(TRYON_RESERVE), { code: 'OK', replayed: true });
    equal(await boot(TRYON_RESERVE + 1), { code: 'CONFLICT' });

    mark('withdrawal');
    // Without the header enabling refuses before any change, and withdrawal still takes effect.
    await activate(a, 100_000_000);
    const consentColumns = { stylist: 'stylist_consent_revision', enhance: 'enhance_consent_revision', tryon: 'tryon_consent_revision' };
    const revisions = { stylist: 1, enhance: 2, tryon: 1 };
    const consented = (feature) => scalar(`select (${consentColumns[feature]} is not null)::text from private.ai_controls where owner_id=${literal(a.uid)};`);
    for (const feature of ['stylist', 'enhance', 'tryon']) {
      equal(await consented(feature), 'true');
      equal(await asOwner(a, {}, `public.${feature}_set_consent(false,null)`), UNAVAILABLE);
      equal(await consented(feature), 'false');
      for (const headers of unsupported) {
        equal(await asOwner(a, headers, `public.${feature}_set_consent(true,${revisions[feature]})`), UNAVAILABLE);
        equal(await consented(feature), 'false');
      }
      requireEvidence(enabled(await client.rpc(a, `${feature}_set_consent`, { p_enabled: true, p_notice_revision: revisions[feature] })));
      equal(await consented(feature), 'true');
    }

    // Analysis consent: enabling without the contract header changes neither the consent nor the profile version.
    const profileState = (owner) => one(`select jsonb_build_object('v',version::text,'on',ai_enabled,'rev',ai_notice_revision,'at',ai_consented_at)
      from public.profiles where owner_id=${literal(owner.uid)};`);
    equal((await aiConsent(a, false)).code, 'OK');
    const off = await profileState(a);
    equal(off.on, false);
    for (const headers of unsupported) {
      equal(await asOwner(a, headers, `public.ai_set_consent(true,1,${off.v})`), UNAVAILABLE);
      equal(await profileState(a), off);
    }
    equal((await aiConsent(a, true)).code, 'OK');
    const on = await profileState(a);
    equal(on.on, true);
    // Withdrawal needs no header and takes effect.
    equal((await asOwner(a, {}, `public.ai_set_consent(false,null,${on.v})`)).code, 'OK');
    equal((await profileState(a)).on, false);
    equal((await aiConsent(a, true)).code, 'OK');

    mark('admin');
    const admission = (owner) => one(`select jsonb_build_object('no',admission_no,'generation',generation::text)
      from private.approved_accounts where user_id=${literal(owner.uid)};`);
    const version = (x) => createHash('sha256').update(`${x.no}:${x.generation}`).digest('hex');
    await sql(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      select user_id,admission_no,generation from private.approved_accounts where user_id=${literal(a.uid)};`);
    const target = await admission(b);
    const audits = async () => Number(await scalar('select count(*) from private.ai_limit_audit;'));
    const amount = (micro) => ({ monthlyAllowanceMicro: String(micro) });
    const write = (expected, limits, reason = null) => client.rpc(a, 'admin_set_ai_limits_v2', { p_admission_no: target.no,
      p_account_version: version(target), p_expected: expected, p_limits: limits, p_reason_code: reason });
    // The v1 pair fails closed for everyone; the v2 pair needs the header.
    equal(await client.rpc(a, 'admin_ai_spending', {}), UNAVAILABLE);
    equal(await client.rpc(a, 'admin_set_ai_limits', { p_admission_no: target.no, p_account_version: version(target),
      p_expected: amount(1), p_limits: amount(2) }), UNAVAILABLE);
    const auditsBefore = await audits();
    const before1 = await allowanceOf(b);
    for (const headers of unsupported) {
      equal(await asOwner(a, headers, 'public.admin_ai_spending_v2()'), UNAVAILABLE);
      equal(await asOwner(a, headers, `public.admin_set_ai_limits_v2(${target.no}::smallint,${literal(version(target))},
        ${json(amount(before1))},${json(amount(2))},null)`), UNAVAILABLE);
    }
    equal(await allowanceOf(b), before1);
    equal(await audits(), auditsBefore);
    const view = await client.rpc(a, 'admin_ai_spending_v2', {});
    equal(view.code, 'OK');
    const accountB = view.accounts.find((entry) => entry.admissionNo === target.no);
    requireEvidence(accountB !== undefined);
    equal(accountB.limits, amount(before1));
    for (const key of ['shared', 'analysis', 'stylist', 'enhancement', 'tryOn']) equal(Object.keys(accountB.current[key]), ['usedMicro']);
    const names = keysOf(view);
    for (const retired of ['maxRequestMicro', 'maxRequestsPerHour', 'lastHour']) requireEvidence(!names.has(retired));
    requireEvidence(!JSON.stringify(view).includes('@'));
    // Validation, the optimistic check and the audit row.
    const current = amount(before1);
    equal(await write(current, amount(0)), { code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'NOT_POSITIVE' });
    equal(await write(current, amount(50_000_001)), { code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'APP_LIMIT' });
    equal((await write(current, { shared: { monthlyAllowanceMicro: '5' } })).code, 'INVALID_INPUT');
    equal((await write(current, current, 'NOT_A_REASON')).code, 'INVALID_INPUT');
    equal(await write(current, current), { code: 'UNCHANGED', limits: current });
    equal((await write(amount(1), amount(2))).code, 'CONFLICT');
    equal(await audits(), auditsBefore);
    equal(await write(current, amount(20_000_000), 'RAISE'), { code: 'OK', limits: amount(20_000_000), belowUse: false });
    equal(await audits(), auditsBefore + 1);
    equal(await one(`select jsonb_build_object('old',old_limits,'new',new_limits,'reason',reason_code)
      from private.ai_limit_audit order by created_at desc limit 1;`), { old: current, new: amount(20_000_000), reason: 'RAISE' });
    // A value below current use is accepted and flagged; it refuses new claims and shows nothing remaining.
    await insertUsage(b, 'analysis', 'settled', 5000);
    const lower = (await used(b)) - 1n;
    equal(await write(amount(20_000_000), amount(lower), 'LOWER'), { code: 'OK', limits: amount(lower), belowUse: true });
    equal(await claimStylist(b), { code: 'ALLOWANCE', claimed: false });
    const over = (await status(b, 'stylist_status')).budget;
    equal([over.remainingMicro, over.warning], ['0', true]);
    equal((await write(amount(lower), amount(20_000_000), 'RESTORE')).belowUse, false);
    await sql('delete from private.app_admins;');
    equal(await client.rpc(a, 'admin_ai_spending_v2', {}), UNAVAILABLE);
  } finally {
    await sql('delete from private.app_admins;');
    const list = [...ids, randomUUID()].map(literal).join(',');
    const slots = await one(`select coalesce(jsonb_agg(provider_slot_id),'[]'::jsonb) from private.ai_usage
      where request_id in (${list}) and provider_slot_id is not null;`);
    await sql(`delete from private.ai_usage where request_id in (${list});`);
    if (slots.length) await sql(`delete from private.provider_slots where slot_id in (${slots.map(literal).join(',')});`);
    const k = saved.capacity;
    await sql(`delete from private.provider_slots where deployment_key=${literal(cleanupKey)} and held_until>clock_timestamp();
      update private.provider_capacity set dispatch_enabled=${k.dispatch_enabled},
        disabled_reason=${k.disabled_reason === null ? 'null' : literal(k.disabled_reason)},
        disabled_at=${k.disabled_at === null ? 'null' : `${literal(k.disabled_at)}::timestamptz`},
        max_dispatch=${k.max_dispatch},updated_at=clock_timestamp() where deployment_key=${literal(cleanupKey)};
      update private.enhancement_probe_authorisations set stopped_at=now(),stopped_reason='OPERATOR'
        where approval_ref like 'BUDGET1-%' and stopped_at is null;
      update private.tryon_probe_authorisations set stopped_at=now(),stopped_reason='OPERATOR'
        where approval_ref like 'BUDGET1-%' and stopped_at is null;`);
    await restoreControls(a, saved.a);
    await restoreControls(b, saved.b);
    for (const [owner, profile] of [[a, saved.profileA], [b, saved.profileB]]) {
      await sql(`update public.profiles set ai_enabled=${profile.enabled},
        ai_notice_revision=${profile.notice === null ? 'null' : profile.notice},
        ai_consented_at=${profile.at === null ? 'null' : `${literal(profile.at)}::timestamptz`} where owner_id=${literal(owner.uid)};`);
    }
  }
}
