// AD1a: admin AI limits and app-recorded spending against the real schema at the full migration inventory. Invoked only
// by the CI-only preservation owner after the BG2b probes (a database reset follows). The operator grant, fixture
// usage rows and overlapping transactions use privileged SQL, the way the runbook and the Edge/cron callers write them;
// every RPC assertion uses the ordinary A/B sessions. A is made the admin inside this probe and the grant, controls,
// admissions and fixtures are restored in finally. Audit rows are append-only, so they stay until the reset. No
// provider calls.
import { createHash, randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';

const STYLIST = 'azure-eu-terra-stylist-v1';
const STYLIST_RESERVATION = 129360;
const TAG_RESERVATION = 4097351;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const UNAVAILABLE = Object.freeze({ code: 'UNAVAILABLE' });
const LIMIT_COLUMNS = ['monthly_allowance_micro', 'max_request_micro', 'max_requests_per_hour', 'stylist_monthly_allowance_micro',
  'stylist_max_request_micro', 'stylist_max_requests_per_hour', 'enhance_monthly_allowance_micro', 'enhance_max_request_micro',
  'enhance_max_requests_per_hour'];
// Every key the spending view may contain (ADR27). Anything else, at any depth, is a disclosure failure.
const ALLOWED_KEYS = new Set(['code', 'asOf', 'months', 'accounts', 'admissionNo', 'enabled', 'accountVersion', 'features',
  'analysis', 'stylist', 'enhancement', 'configured', 'activated', 'limits', 'shared', 'monthlyAllowanceMicro', 'maxRequestMicro',
  'maxRequestsPerHour', 'history', 'month', 'tryOn', 'available', 'confirmedMicro', 'estimatedMicro', 'reservedMicro', 'totalMicro',
  'requests', 'current', 'period', 'usedMicro', 'lastHour', 'openAllocations', 'enhancementProbe', 'count', 'allocationMicro', 'maxCalls']);
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, out);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { out.add(key); keysOf(entry, out); }
  return out;
};
const feature = (monthly, request, hour) => ({ monthlyAllowanceMicro: monthly, maxRequestMicro: request, maxRequestsPerHour: hour });

export async function adminLimitsProbes(snapshot, sql, mark) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  // A statement that must fail with exactly `state`; success or any other error fails the privileged step.
  const refused = (statement, state) => sql(`do $$ begin ${statement}; raise exception using errcode='P0T99',message='NOT_REFUSED';
    exception when sqlstate '${state}' then null; end $$;`);
  const admission = (owner) => one(`select jsonb_build_object('no',admission_no,'generation',generation::text)
    from private.approved_accounts where user_id=${literal(owner.uid)};`);
  const version = (x) => createHash('sha256').update(`${x.no}:${x.generation}`).digest('hex');
  const limitsOf = (owner) => one(`select private.admin_limits(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const nonLimit = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !LIMIT_COLUMNS.includes(key) && key !== 'updated_at'));
  const audits = async () => Number(await scalar('select count(*) from private.ai_limit_audit;'));
  const lastAudit = () => one(`select to_jsonb(x)-'id'-'created_at' from private.ai_limit_audit x order by created_at desc limit 1;`);
  const status = (owner) => client.rpc(owner, 'admin_status', {});
  const spending = (owner, months) => client.rpc(owner, 'admin_ai_spending', months === undefined ? {} : { p_months: months });
  const setLimits = (owner, body) => client.rpc(owner, 'admin_set_ai_limits', body);
  const write = (target, targetAdmission, expected, limits, reason = null) => setLimits(a, { p_admission_no: targetAdmission.no,
    p_account_version: version(targetAdmission), p_expected: expected, p_limits: limits, p_reason_code: reason });
  const accountOf = (view, no) => { const found = view.accounts.find((x) => x.admissionNo === no); requireEvidence(found); return found; };
  const exportTables = async (owner) => (await client.rpc(owner, 'export_manifest', { p_export_id: randomUUID() })).tables;
  const hold = async (statement, seconds, end = 'commit') => {
    const marker = `pg_sleep(${seconds})`;
    const held = sql(`begin; ${statement}; select 'HELD'; select ${marker}; ${end}; select 'DONE';`);
    for (const until = Date.now() + 5000; ;) {
      if (await stillHeld(marker)) return { done: held, marker };
      requireEvidence(Date.now() < until);
      await delay(25);
    }
  };
  const stillHeld = async (marker) => await scalar(`select count(*) from pg_stat_activity where wait_event='PgSleep'
    and query like ${literal(`%${marker}%`)} and pid<>pg_backend_pid();`) === '1';
  const asA = (text) => `set local role authenticated;
    select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: a.uid, role: 'authenticated' }))},true); ${text}`;

  const originalA = await admission(a), originalB = await admission(b);
  const savedA = await controls(a), savedB = await controls(b);
  requireEvidence(savedA && savedB && originalA.no !== originalB.no);
  // Whole-row restore: earlier stages (the BG2b probes) leave their own limits, so the positive probes set explicit
  // fixtures for both accounts and put every column back afterwards.
  const restoreControls = (owner, saved) => sql(`delete from private.ai_controls where owner_id=${literal(owner.uid)};
    insert into private.ai_controls select * from jsonb_populate_record(null::private.ai_controls,${json(saved)});`);
  // The tagging reservation: at least the active manifest's floor, so an unchanged value always passes the floor check.
  const tagFloor = async (owner) => scalar(`select greatest(${TAG_RESERVATION},coalesce(m.reservation_micro,0))
    from private.ai_controls c left join private.ai_execution_manifests m on m.id=c.execution_manifest_id
    where c.owner_id=${literal(owner.uid)};`);
  const fixture = async (owner) => sql(`update private.ai_controls set monthly_allowance_micro=20000000,
    max_request_micro=${await tagFloor(owner)},max_requests_per_hour=1000,stylist_manifest_id=${literal(STYLIST)},
    stylist_monthly_allowance_micro=5000000,stylist_max_request_micro=${STYLIST_RESERVATION},stylist_max_requests_per_hour=1000,
    enhance_activated=false,enhance_monthly_allowance_micro=null,enhance_max_request_micro=null,enhance_max_requests_per_hour=null,
    updated_at=clock_timestamp() where owner_id=${literal(owner.uid)};`);

  mark('structure');
  // Definer with an empty search_path, no PUBLIC grant, and EXECUTE for authenticated only.
  equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
      not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),
      has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('authenticated',p.oid,'EXECUTE'),
      has_function_privilege('service_role',p.oid,'EXECUTE')))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'admin\\_%';`), {
    admin_status: [true, true, false, true, false], admin_ai_spending: [true, true, false, true, false],
    admin_set_ai_limits: [true, true, false, true, false] });
  equal(await one(`select jsonb_object_agg(c.relname,jsonb_build_array(c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
    from pg_class c where c.relnamespace='private'::regnamespace and c.relname in ('app_admins','ai_limit_audit');`), {
    app_admins: [true, false, false, false], ai_limit_audit: [true, false, false, false] });
  equal(await scalar('select count(*) from private.app_admins;'), '0');
  const exportBefore = { a: await exportTables(a), b: await exportTables(b) };
  const auditStart = await audits();

  try {
    mark('non-admin');
    // Without a grant nobody is the admin: all three RPCs are exactly UNAVAILABLE for own, peer and unknown admissions,
    // including shape-invalid input, and nothing is written.
    const anyLimits = { shared: feature('1000000', '100000', 10), stylist: feature(null, null, null), enhancement: feature(null, null, null) };
    const deniedCalls = (targetNo) => [['admin_status', {}], ['admin_ai_spending', {}], ['admin_ai_spending', { p_months: 0 }],
      ['admin_set_ai_limits', { p_admission_no: targetNo, p_account_version: 'f'.repeat(64), p_expected: anyLimits, p_limits: anyLimits }],
      ['admin_set_ai_limits', { p_admission_no: targetNo, p_account_version: 'bad', p_expected: {}, p_limits: [], p_reason_code: 'FREE' }]];
    for (const owner of [a, b]) {
      for (const targetNo of [originalA.no, originalB.no, 3]) {
        for (const [name, body] of deniedCalls(targetNo)) equal(await client.rpc(owner, name, body), UNAVAILABLE);
      }
    }
    for (const token of [null]) {
      const anon = await client.request(token, '/rest/v1/rpc/admin_status', { method: 'POST', body: {} });
      requireEvidence(!anon.ok && anon.status === 401);
    }
    requireEvidence(await audits() === auditStart);

    mark('direct-access');
    // The private tables are not reachable through the API (schema not exposed), nor by authenticated or service_role SQL.
    for (const owner of [a, b]) {
      for (const table of ['app_admins', 'ai_limit_audit']) {
        const read = await client.request(owner.token, `/rest/v1/${table}?select=*`, { headers: { 'Accept-Profile': 'private' } });
        requireEvidence(!read.ok && read.status === 406);
        const insert = await client.request(owner.token, `/rest/v1/${table}`, { method: 'POST', headers: { 'Content-Profile': 'private' },
          body: { owner_id: owner.uid, admission_no: 1, admission_generation: randomUUID() } });
        requireEvidence(!insert.ok && insert.status === 406);
      }
    }
    for (const role of ['authenticated', 'service_role']) {
      await refused(`set local role ${role}; perform 1 from private.app_admins`, '42501');
      await refused(`set local role ${role}; insert into private.app_admins(owner_id,admission_no,admission_generation)
        values (${literal(b.uid)},${originalB.no},${literal(originalB.generation)})`, '42501');
      await refused(`set local role ${role}; perform 1 from private.ai_limit_audit`, '42501');
    }

    mark('self-promotion');
    // Account metadata cannot make B the admin: only the operator row counts.
    const promoted = await client.request(b.token, '/auth/v1/user', { method: 'PUT', body: { data: { admin: true, role: 'admin' } } });
    requireEvidence(promoted.ok);
    equal(await status(b), UNAVAILABLE);
    // Nor can B's own profile: it has no admin field, so a profile write naming one is refused and changes nothing.
    const profileBefore = await one(`select to_jsonb(p) from public.profiles p where owner_id=${literal(b.uid)};`);
    for (const body of [{ is_admin: true }, { role: 'admin' }, { admin: true }, { app_admin: true, display_name: 'admin' }]) {
      const patched = await client.request(b.token, `/rest/v1/profiles?owner_id=eq.${b.uid}`, { method: 'PATCH', body });
      requireEvidence(!patched.ok && [400, 401, 403].includes(patched.status));
    }
    equal(await one(`select to_jsonb(p) from public.profiles p where owner_id=${literal(b.uid)};`), profileBefore);
    equal(await status(b), UNAVAILABLE);
    equal(await scalar('select count(*) from private.app_admins;'), '0');

    mark('operator-grant');
    // The operator row must name the current, enabled admission generation of the same account; only one row exists.
    await refused(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      values (${literal(a.uid)},${originalA.no},gen_random_uuid())`, '23514');
    await refused(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      values (${literal(b.uid)},${originalA.no},${literal(originalA.generation)})`, '23514');
    await sql(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      select user_id,admission_no,generation from private.approved_accounts where user_id=${literal(a.uid)};`);
    await refused(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      values (${literal(b.uid)},${originalB.no},${literal(originalB.generation)})`, '23505');
    await refused(`update private.app_admins set admission_generation=gen_random_uuid()`, '23514');
    equal(await status(a), { code: 'OK' });
    for (const [name, body] of deniedCalls(originalA.no)) equal(await client.rpc(b, name, body), UNAVAILABLE);
    // A re-invitation of the admin's own admission ends its authority until the operator binds the new generation.
    await sql(`update private.approved_accounts set generation=gen_random_uuid() where user_id=${literal(a.uid)};`);
    equal(await status(a), UNAVAILABLE);
    equal(await spending(a), UNAVAILABLE);
    await sql(`update private.approved_accounts set generation=${literal(originalA.generation)}::uuid where user_id=${literal(a.uid)};`);
    equal(await status(a), { code: 'OK' });

    mark('setup');
    // Explicit, valid nine-field fixtures for both accounts; B's stylist is also activated and consented.
    await fixture(a);
    await fixture(b);
    await sql(`update private.ai_controls set stylist_activated=true,stylist_notice_revision=1,updated_at=clock_timestamp()
      where owner_id=${literal(b.uid)};`);
    const tagB = await tagFloor(b);
    const consent = await client.rpc(b, 'stylist_set_consent', { p_enabled: true, p_notice_revision: 1 });
    requireEvidence(consent?.code === 'OK' && consent.consent?.enabled === true);
    const baseB = await limitsOf(b);
    equal(baseB, { shared: feature('20000000', tagB, 1000),
      stylist: feature('5000000', String(STYLIST_RESERVATION), 1000), enhancement: feature(null, null, null) });

    mark('spending-shape');
    for (const months of [0, 13, null, -1]) equal(await spending(a, months), { code: 'INVALID_INPUT' });
    const twelve = await spending(a, 12);
    requireEvidence(twelve.code === 'OK' && twelve.months.length === 12);
    const view = await spending(a);
    requireEvidence(view.code === 'OK' && Number.isSafeInteger(view.asOf) && view.months.length === 6
      && view.months.every((month) => /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)) && view.months[0] > view.months[5]);
    equal(view.months[0], await scalar(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM');`));
    const viewA = accountOf(view, originalA.no), viewB = accountOf(view, originalB.no);
    equal(viewA.accountVersion, version(originalA));
    equal(viewB.accountVersion, version(originalB));
    equal(viewB.limits, baseB);
    equal(viewB.features.stylist, { configured: true, activated: true });
    equal(viewB.features.enhancement, { configured: false, activated: false });
    requireEvidence(viewB.history.length === 6 && viewB.history.every((entry, index) => entry.month === view.months[index]
      && JSON.stringify(entry.tryOn) === '{"available":false}'));

    mark('disclosure');
    // An open probe authorisation shows only as aggregate amounts; no email, user ID or approval reference appears.
    const probeRef = `AD1-disclosure-${randomUUID()}`;
    await sql(`insert into private.enhancement_probe_authorisations(id,owner_id,deployment_key,manifest_id,max_calls,allocation_micro,
      approval_ref,expires_at,created_at) values (gen_random_uuid(),${literal(b.uid)},
      'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08','azure-global-image25-sunburst-enhance-v1',2,600000,
      ${literal(probeRef)},now()+interval '1 day',now());`);
    const disclosed = await spending(a);
    const openB = accountOf(disclosed, originalB.no).openAllocations.enhancementProbe;
    requireEvidence(Number(openB.count) >= 1 && BigInt(openB.allocationMicro) >= 600000n && Number(openB.maxCalls) >= 2);
    const unknownKeys = [...keysOf(disclosed)].filter((key) => !ALLOWED_KEYS.has(key));
    equal(unknownKeys, []);
    const text = JSON.stringify(disclosed);
    const emails = (await scalar(`select string_agg(email,',') from private.approved_accounts;`)).split(',').filter(Boolean);
    for (const secret of [a.uid, b.uid, probeRef, ...emails]) requireEvidence(!text.toLowerCase().includes(secret.toLowerCase()));
    requireEvidence(!text.includes('@'));
    await sql(`update private.enhancement_probe_authorisations set stopped_at=now(),stopped_reason='OPERATOR'
      where approval_ref=${literal(probeRef)};`);

    mark('history');
    // Months by the row's own period: confirmed, estimated and reserved apart, released excluded; an old hold appears
    // only in its own month but still counts towards current consumption.
    const monthsBack = (n) => `to_char(date_trunc('month',clock_timestamp() at time zone 'UTC')-interval '${n} month','YYYY-MM')`;
    const before = accountOf(await spending(a), originalB.no);
    const row = (period, purpose, state, micro, created, dispatched = true) => `(${literal(b.uid)},gen_random_uuid(),${period},
      ${created},${Math.max(micro, 1)},${micro},'${state}',${dispatched ? created : 'null'},'${purpose}')`;
    await sql(`insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,
      dispatched_at,purpose) values
      ${row(monthsBack(0), 'analysis', 'settled', 1000, 'clock_timestamp()')},
      ${row(monthsBack(0), 'analysis', 'estimated', 2000, 'clock_timestamp()')},
      ${row(monthsBack(0), 'analysis', 'released', 0, "clock_timestamp()-interval '2 hours'", false)},
      ${row(monthsBack(0), 'stylist', 'estimated', 4840, "clock_timestamp()-interval '2 hours'")},
      ${row(monthsBack(1), 'analysis', 'settled', 3000, "clock_timestamp()-interval '40 days'")},
      ${row(monthsBack(2), 'analysis', 'reserved', TAG_RESERVATION, "clock_timestamp()-interval '70 days'", false)};`);
    const after = accountOf(await spending(a), originalB.no);
    const delta = (x, y, path) => { const get = (o) => path.reduce((v, k) => v[k], o); return BigInt(get(y)) - BigInt(get(x)); };
    const monthDelta = (index, purpose) => Object.fromEntries(['confirmedMicro', 'estimatedMicro', 'reservedMicro', 'totalMicro', 'requests']
      .map((key) => [key, delta(before, after, ['history', index, purpose, key])]));
    equal(monthDelta(0, 'analysis'), { confirmedMicro: 1000n, estimatedMicro: 2000n, reservedMicro: 0n, totalMicro: 3000n, requests: 2n });
    equal(monthDelta(0, 'stylist'), { confirmedMicro: 0n, estimatedMicro: 4840n, reservedMicro: 0n, totalMicro: 4840n, requests: 1n });
    equal(monthDelta(1, 'analysis'), { confirmedMicro: 3000n, estimatedMicro: 0n, reservedMicro: 0n, totalMicro: 3000n, requests: 1n });
    equal(monthDelta(2, 'analysis'), { confirmedMicro: 0n, estimatedMicro: 0n, reservedMicro: BigInt(TAG_RESERVATION),
      totalMicro: BigInt(TAG_RESERVATION), requests: 1n });
    equal(delta(before, after, ['current', 'analysis', 'usedMicro']), 3000n + BigInt(TAG_RESERVATION));
    equal(delta(before, after, ['current', 'stylist', 'usedMicro']), 4840n);
    equal(delta(before, after, ['current', 'shared', 'usedMicro']), 3000n + 4840n + BigInt(TAG_RESERVATION));
    equal(delta(before, after, ['current', 'analysis', 'lastHour']), 2n);
    // Usage history stays visible without a controls row: limits are null and the history is unchanged.
    const currentB = await controls(b);
    await sql(`delete from private.ai_controls where owner_id=${literal(b.uid)};`);
    try {
      const absent = accountOf(await spending(a), originalB.no);
      equal(absent.limits, null);
      equal(absent.history, after.history);
    } finally {
      await sql(`insert into private.ai_controls select * from jsonb_populate_record(null::private.ai_controls,${json(currentB)});`);
    }
    equal(await controls(b), currentB);

    mark('write-validation');
    const auditBefore = await audits();
    const change = (patch) => ({ shared: { ...baseB.shared, ...patch.shared }, stylist: { ...baseB.stylist, ...patch.stylist },
      enhancement: { ...baseB.enhancement, ...patch.enhancement } });
    const invalid = (field, reason) => ({ code: 'INVALID_LIMITS', field, reason });
    for (const [patch, expected] of [
      [{ shared: { monthlyAllowanceMicro: '50000001' } }, invalid('shared.monthlyAllowanceMicro', 'APP_LIMIT')],
      [{ shared: { monthlyAllowanceMicro: '0' } }, invalid('shared.monthlyAllowanceMicro', 'NOT_POSITIVE')],
      [{ shared: { monthlyAllowanceMicro: null } }, invalid('shared.monthlyAllowanceMicro', 'REQUIRED')],
      [{ shared: { maxRequestMicro: '20000001' } }, invalid('shared.maxRequestMicro', 'ABOVE_MONTHLY')],
      [{ shared: { maxRequestsPerHour: 0 } }, invalid('shared.maxRequestsPerHour', 'RANGE')],
      [{ shared: { maxRequestsPerHour: 1001 } }, invalid('shared.maxRequestsPerHour', 'RANGE')],
      [{ stylist: { monthlyAllowanceMicro: '20000001' } }, invalid('stylist.monthlyAllowanceMicro', 'ABOVE_SHARED')],
      [{ shared: { monthlyAllowanceMicro: '4999999' } }, invalid('stylist.monthlyAllowanceMicro', 'ABOVE_SHARED')],
      [{ stylist: { maxRequestMicro: String(STYLIST_RESERVATION - 1) } }, invalid('stylist.maxRequestMicro', 'BELOW_RESERVATION')],
      [{ enhancement: { monthlyAllowanceMicro: '1000000' } }, invalid('enhancement.monthlyAllowanceMicro', 'REQUIRED')],
    ]) equal(await write(b, originalB, baseB, change(patch)), expected);
    for (const limits of [
      change({ shared: { monthlyAllowanceMicro: '1000000000000' } }), change({ shared: { monthlyAllowanceMicro: '01' } }),
      change({ shared: { monthlyAllowanceMicro: 5 } }), change({ shared: { monthlyAllowanceMicro: '1.5' } }),
      change({ shared: { monthlyAllowanceMicro: '-1' } }), change({ shared: { maxRequestsPerHour: 1.5 } }),
      change({ shared: { maxRequestsPerHour: '10' } }), { ...baseB, extra: {} }, { shared: baseB.shared, stylist: baseB.stylist },
      change({ shared: { extra: '1' } }), change({ shared: { maxRequestsPerHour: 99999999999 } }),
    ]) equal(await write(b, originalB, baseB, limits), { code: 'INVALID_INPUT' });
    equal(await write(b, originalB, baseB, change({}), 'FREE'), { code: 'INVALID_INPUT' });
    for (const no of [0, 3, null]) equal(await setLimits(a, { p_admission_no: no, p_account_version: version(originalB),
      p_expected: baseB, p_limits: baseB }), { code: 'INVALID_INPUT' });
    equal(await setLimits(a, { p_admission_no: originalB.no, p_account_version: version(originalB).toUpperCase(),
      p_expected: baseB, p_limits: baseB }), { code: 'INVALID_INPUT' });
    // A wrong version and a stale expected value are conflicts; the current limits come back only for the latter.
    equal(await setLimits(a, { p_admission_no: originalB.no, p_account_version: 'a'.repeat(64), p_expected: baseB, p_limits: baseB }),
      { code: 'CONFLICT' });
    equal(await write(b, originalB, change({ shared: { maxRequestsPerHour: 999 } }), baseB), { code: 'CONFLICT', limits: baseB });
    equal(await write(b, originalB, baseB, baseB), { code: 'UNCHANGED', limits: baseB });
    requireEvidence(await audits() === auditBefore);
    equal(await limitsOf(b), baseB);

    mark('reservation-floor');
    // A stored reservation already below its manifest floor is refused even when only another field changes.
    await sql(`update private.ai_controls set stylist_max_request_micro=${STYLIST_RESERVATION - 1} where owner_id=${literal(b.uid)};`);
    try {
      const below = await limitsOf(b), rowBelow = await controls(b);
      equal(below.stylist.maxRequestMicro, String(STYLIST_RESERVATION - 1));
      equal(await write(b, originalB, below, { ...below, stylist: { ...below.stylist, maxRequestsPerHour: 999 } }),
        invalid('stylist.maxRequestMicro', 'BELOW_RESERVATION'));
      equal(await controls(b), rowBelow);
      requireEvidence(await audits() === auditBefore);
    } finally {
      await sql(`update private.ai_controls set stylist_max_request_micro=${STYLIST_RESERVATION} where owner_id=${literal(b.uid)};`);
    }
    equal(await limitsOf(b), baseB);

    mark('write');
    // The 50,000,000 per-account app limit is accepted; untouched exact reservations round-trip unchanged.
    const nonLimitBefore = nonLimit(await controls(b));
    const raised = change({ shared: { monthlyAllowanceMicro: '50000000', maxRequestsPerHour: 999 } });
    equal(await write(b, originalB, baseB, raised, 'RAISE'), { code: 'OK', limits: raised, belowUse: false });
    equal(await limitsOf(b), raised);
    equal(nonLimit(await controls(b)), nonLimitBefore);
    equal(await lastAudit(), { owner_id: b.uid, target_admission_no: originalB.no, actor_owner_id: a.uid, old_limits: baseB,
      new_limits: raised, reason_code: 'RAISE' });
    requireEvidence(await audits() === auditBefore + 1);
    // PAUSE is only a label: the limits are validated and stored like any other change; activation is untouched.
    const paused = { ...raised, stylist: feature(String(STYLIST_RESERVATION), String(STYLIST_RESERVATION), 1) };
    const pausedResult = await write(b, originalB, raised, paused, 'PAUSE');
    equal(pausedResult, { code: 'OK', limits: paused, belowUse: true });
    equal(nonLimit(await controls(b)), nonLimitBefore);
    equal(await write(b, originalB, paused, { ...paused, stylist: feature('0', '0', 1) }, 'PAUSE'),
      invalid('stylist.monthlyAllowanceMicro', 'NOT_POSITIVE'));
    equal(await write(b, originalB, paused, baseB, 'RESTORE'), { code: 'OK', limits: baseB, belowUse: false });
    requireEvidence(await audits() === auditBefore + 3);

    mark('enhancement-clamp');
    // With enhancement configured, lowering the shared limit below it is refused before the clamp trigger could change it.
    await sql(`update private.ai_controls set enhance_monthly_allowance_micro=10000000,enhance_max_request_micro=300000,
      enhance_max_requests_per_hour=10,updated_at=clock_timestamp() where owner_id=${literal(b.uid)};`);
    const withEnhance = await limitsOf(b);
    equal(withEnhance.enhancement, feature('10000000', '300000', 10));
    equal(await write(b, originalB, withEnhance, { ...withEnhance, shared: { ...withEnhance.shared, monthlyAllowanceMicro: '9999999' },
      stylist: { ...withEnhance.stylist, monthlyAllowanceMicro: '5000000' } }), invalid('enhancement.monthlyAllowanceMicro', 'ABOVE_SHARED'));
    equal(await limitsOf(b), withEnhance);
    const lowered = { ...withEnhance, shared: { ...withEnhance.shared, monthlyAllowanceMicro: '10000000' } };
    equal(await write(b, originalB, withEnhance, lowered, 'LOWER'), { code: 'OK', limits: lowered, belowUse: false });
    equal(await limitsOf(b), lowered);

    mark('self-edit');
    // The admin may edit its own admission; the audit row names it as both target and actor.
    const ownBase = await limitsOf(a);
    const ownChange = { ...ownBase, shared: { ...ownBase.shared,
      maxRequestsPerHour: ownBase.shared.maxRequestsPerHour === 1000 ? 999 : ownBase.shared.maxRequestsPerHour + 1 } };
    equal((await write(a, originalA, ownBase, ownChange, 'CORRECTION')).code, 'OK');
    equal(await lastAudit(), { owner_id: a.uid, target_admission_no: originalA.no, actor_owner_id: a.uid, old_limits: ownBase,
      new_limits: ownChange, reason_code: 'CORRECTION' });
    equal((await write(a, originalA, ownChange, ownBase)).code, 'OK');

    mark('audit-append-only');
    await refused('delete from private.ai_limit_audit', '42501');
    await refused('update private.ai_limit_audit set actor_owner_id=null', '42501');
    await refused(`update private.ai_limit_audit set reason_code='LOWER'`, '42501');
    await refused('truncate private.ai_limit_audit', '42501');

    mark('overlap-freeze');
    // A freeze holding the target admission refuses at once; once committed the target is not available.
    const current = await limitsOf(b);
    const next = { ...current, shared: { ...current.shared, maxRequestsPerHour: current.shared.maxRequestsPerHour === 1000 ? 999 : 1000 } };
    const freezeB = `update private.approved_accounts set enabled=false where user_id=${literal(b.uid)} and enabled`;
    const unfreezeB = () => sql(`update private.approved_accounts set enabled=true where user_id=${literal(b.uid)};`);
    const freezing = await hold(freezeB, 1.021, 'rollback');
    equal(await write(b, originalB, current, next), { code: 'CONFLICT' });
    await freezing.done;
    try {
      await sql(`${freezeB};`);
      equal(await write(b, originalB, current, next), UNAVAILABLE);
    } finally { await unfreezeB(); }
    await sql(`insert into private.deletion_jobs(owner_id,stage,admission_no,admission_generation)
      select user_id,'storage',admission_no,generation from private.approved_accounts where user_id=${literal(b.uid)};`);
    try {
      equal(await write(b, originalB, current, next), UNAVAILABLE);
    } finally { await sql(`delete from private.deletion_jobs where owner_id=${literal(b.uid)};`); }
    equal(await limitsOf(b), current);

    mark('overlap-revocation');
    // Revocation committed while the write waits for the admin row: the write then refuses as UNAVAILABLE.
    const revoking = await hold('delete from private.app_admins', 1.023);
    equal(await write(b, originalB, current, next), UNAVAILABLE);
    await revoking.done;
    equal(await status(a), UNAVAILABLE);
    equal(await limitsOf(b), current);
    await sql(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      select user_id,admission_no,generation from private.approved_accounts where user_id=${literal(a.uid)};`);
    equal(await status(a), { code: 'OK' });

    mark('overlap-reinvite');
    // A re-invited target keeps identical limits, but the old version no longer matches.
    await sql(`update private.approved_accounts set generation=gen_random_uuid() where user_id=${literal(b.uid)};`);
    try {
      equal(await write(b, originalB, current, current), { code: 'CONFLICT' });
      const reinvited = await admission(b);
      equal(accountOf(await spending(a), originalB.no).accountVersion, version(reinvited));
      equal(await write(b, reinvited, current, current), { code: 'UNCHANGED', limits: current });
    } finally {
      await sql(`update private.approved_accounts set generation=${literal(originalB.generation)}::uuid where user_id=${literal(b.uid)};`);
    }

    mark('overlap-locked-non-admin');
    // A non-admin call returns at once while the target's admission and profile are locked.
    const locking = await hold(`select 1 from private.approved_accounts where user_id=${literal(a.uid)} for update;
      select 1 from public.profiles where owner_id=${literal(a.uid)} for update`, 1.027, 'rollback');
    equal(await setLimits(b, { p_admission_no: originalA.no, p_account_version: version(originalA), p_expected: current,
      p_limits: next }), UNAVAILABLE);
    requireEvidence(await stillHeld(locking.marker));
    await locking.done;

    mark('overlap-claim');
    // A stylist claim racing a limit reduction: it waits or refuses BUSY while the write holds the target, and is then
    // decided against the new limit, so no reservation exceeds it.
    requireEvidence((await one(`select public.stylist_claim(${literal(b.uid)},${literal(randomUUID())},${literal(STYLIST)});`))
      .claimed === true);
    const used = BigInt(await scalar(`select stylist_micro from private.stylist_usage(${literal(b.uid)},clock_timestamp());`));
    const base = await limitsOf(b);
    const reduced = { ...base, stylist: { ...base.stylist, monthlyAllowanceMicro: String(used + BigInt(STYLIST_RESERVATION) - 1n) } };
    const heldRows = async () => Number(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(b.uid)}
      and purpose='stylist' and charge_state='held';`));
    const rowsBefore = await heldRows();
    const writing = await hold(asA(`select 'W:'||public.admin_set_ai_limits(${originalB.no}::smallint,${literal(version(originalB))},
      ${json(base)},${json(reduced)},'LOWER')::text`), 1.029);
    const raced = await one(`select public.stylist_claim(${literal(b.uid)},${literal(randomUUID())},${literal(STYLIST)});`);
    const heldOut = await writing.done;
    const written = JSON.parse(heldOut.split('\n').find((line) => line.startsWith('W:')).slice(2));
    equal(written.code, 'OK');
    requireEvidence(['BUSY', 'ALLOWANCE'].includes(raced.code) && raced.claimed === false);
    equal((await one(`select public.stylist_claim(${literal(b.uid)},${literal(randomUUID())},${literal(STYLIST)});`)).code, 'ALLOWANCE');
    requireEvidence(await heldRows() === rowsBefore);
    equal(await limitsOf(b), reduced);

    mark('export');
    // Nothing above reaches either owner's export.
    equal(await exportTables(a), exportBefore.a);
    equal(await exportTables(b), exportBefore.b);
  } finally {
    await sql(`delete from private.app_admins;
      update private.approved_accounts set enabled=true,generation=${literal(originalB.generation)}::uuid where user_id=${literal(b.uid)};
      update private.approved_accounts set generation=${literal(originalA.generation)}::uuid where user_id=${literal(a.uid)};
      delete from private.deletion_jobs where owner_id in (${literal(a.uid)},${literal(b.uid)}) and stage='storage' and completed_at is null;`);
    await restoreControls(a, savedA);
    await restoreControls(b, savedB);
  }
  equal(await controls(a), savedA);
  equal(await controls(b), savedB);
  equal(await scalar('select count(*) from private.app_admins;'), '0');
}
