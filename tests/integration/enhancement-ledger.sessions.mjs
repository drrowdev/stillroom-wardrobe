// BG2b-1: the photo-enhancement ledger, admission and provenance against the real schema at the full migration
// inventory. Invoked only by the CI-only preservation owner after the ST1a stylist probes (a database reset follows).
// enhance_claim, enhance_finish, enhance_expire_due, enhance_probe_authorise and enhance_provider_control are
// service/operator functions, called here through privileged SQL the way the Edge handler, cron and the operator call
// them. Every access, Save and provenance assertion uses the ordinary A/B sessions. The capacity switch, slots and
// controls are opened only inside this probe and restored in finally. No provider calls.
import { createHash, randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisHash } from './ai-analysis.sessions.mjs';
import { intent, saveHarness, denied, bytes } from './item-save.sessions.mjs';
import { COLOUR_MANIFEST } from './azure-preservation.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

const MANIFEST = 'azure-global-image25-sunburst-enhance-v1';
const MODEL = 'gpt-image-2.5-sunburst';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const STYLIST = 'azure-eu-terra-stylist-v1';
const RESERVED = 300000;
const TAG_RESERVATION = 4097351;
const STYLIST_RESERVATION = 129360;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const orNull = (value, cast) => (value === null ? `null::${cast}` : `${literal(value)}::${cast}`);
const hex = () => createHash('sha256').update(randomUUID()).digest('hex');
// ceil((1000*800 + 4000*3000)/100) = 128000 micro-USD.
const VALID = Object.freeze({ modelObservation: 'not_observed', input: 1000, output: 4000, total: 5000, inputText: 100,
  inputImage: 900 });
const ESTIMATE = 128000;

export async function enhancementLedgerProbes(snapshot, sql, mark) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const claim = (owner, id, { input = hex(), probe = null, manifest = MANIFEST } = {}) => one(`select public.enhance_claim(
    ${literal(owner.uid)},${literal(id)},${literal(manifest)},${literal(input)},${orNull(probe, 'uuid')});`);
  const finish = (owner, id, code, usage, output = null) => one(`select public.enhance_finish(${literal(owner.uid)},
    ${literal(id)},${literal(code)},${usage === null ? 'null::jsonb' : json(usage)},${orNull(output?.sha ?? null, 'text')},
    ${output === null ? 'null::integer' : output.bytes});`);
  const ledger = (owner, id) => one(`select coalesce((select jsonb_build_object('usage',to_jsonb(u),'evidence',to_jsonb(e))
    from private.ai_usage u join private.ai_usage_evidence e using (owner_id,request_id)
    where u.owner_id=${literal(owner.uid)} and u.request_id=${literal(id)}),'null'::jsonb);`);
  const evidence = (owner, id) => one(`select coalesce((select to_jsonb(x) from private.image_enhancements x
    where owner_id=${literal(owner.uid)} and request_id=${literal(id)}),'null'::jsonb);`);
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const capacity = () => one(`select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(KEY)};`);
  const status = (owner) => client.rpc(owner, 'enhance_status', {});
  const control = (enabled, reason) => one(`select public.enhance_provider_control(${literal(KEY)},${enabled},${orNull(reason, 'text')});`);
  const setMax = (max) => sql(`update private.provider_capacity set max_dispatch=${max} where deployment_key=${literal(KEY)};`);
  // Test-only: end every live slot now, so a section starts with free shared capacity.
  const freeSlots = () => sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
    where deployment_key=${literal(KEY)} and held_until>clock_timestamp();`);
  const activate = (where) => sql(`update private.ai_controls set enhance_activated=true,enhance_notice_revision=1,
    enhance_manifest_id=${literal(MANIFEST)},enhance_max_request_micro=${RESERVED},monthly_allowance_micro=100000000,
    enhance_monthly_allowance_micro=50000000,enhance_max_requests_per_hour=1000,max_requests_per_hour=1000,
    updated_at=clock_timestamp() where ${where};`);
  const reactivate = (owner) => activate(`owner_id=${literal(owner.uid)}`);
  const reopen = async () => { equal(await control(true, null), { code: 'OK', dispatchEnabled: true }); };
  const enhanced = async (owner, sha = hex(), input = hex()) => {
    const id = randomUUID();
    requireEvidence((await claim(owner, id, { input })).claimed === true);
    const done = await finish(owner, id, 'OK', VALID, { sha, bytes: bytes.length });
    requireEvidence(done.code === 'OK' && Number.isSafeInteger(done.usableUntilMs));
    return { id, sha, input };
  };
  const backdate = (owner, id, interval) => sql(`update private.image_enhancements set created_at=created_at-interval '${interval}',
    usable_until=usable_until-interval '${interval}' where owner_id=${literal(owner.uid)} and request_id=${literal(id)};`);
  const binding = (owner, image) => one(`select coalesce((select to_jsonb(x)-'created_at' from private.image_enhancement_bindings x
    where owner_id=${literal(owner.uid)} and image_id=${literal(image)}),'null'::jsonb);`);
  const provenanceRow = (owner, image) => one(`select coalesce((select to_jsonb(x)-'created_at' from private.image_provenance x
    where owner_id=${literal(owner.uid)} and image_id=${literal(image)}),'null'::jsonb);`);
  const ownProvenance = async (owner, image) => (await client.rpc(owner, 'image_provenance_v1', {}))
    .find((row) => row.image_id === image) ?? null;

  mark('structure');
  equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
      not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),
      has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('authenticated',p.oid,'EXECUTE'),
      has_function_privilege('service_role',p.oid,'EXECUTE')))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'enhance\\_%';`), {
    enhance_claim: [true, true, false, false, true], enhance_finish: [true, true, false, false, true],
    enhance_probe_authorise: [true, true, false, false, true],
    enhance_status: [true, true, false, true, false], enhance_set_consent: [true, true, false, true, false],
    enhance_expire_due: [true, true, false, false, false], enhance_provider_control: [true, true, false, false, false] });
  // Inactive by default: the shared switch is off with the INITIAL reason and 2 dispatches per 60 s.
  const initial = await capacity();
  requireEvidence(initial.dispatch_enabled === false && initial.disabled_reason === 'INITIAL'
    && initial.max_dispatch === 2 && initial.window_seconds === 60);
  const before = { a: await controls(a), b: await controls(b) };
  requireEvidence(before.a.activated === true && before.a.enhance_activated === false && before.b.enhance_activated === false);

  mark('normal-denied');
  const other = randomUUID();
  for (const token of [a.token, b.token, null]) {
    for (const [name, body] of [
      ['enhance_claim', { p_owner_id: a.uid, p_request_id: other, p_manifest_id: MANIFEST, p_input_sha256: hex(), p_probe_id: null }],
      ['enhance_finish', { p_owner_id: a.uid, p_request_id: other, p_code: 'OK', p_usage: VALID, p_output_sha256: hex(), p_output_bytes: 4 }],
      ['enhance_expire_due', { p_limit: 10 }],
      ['enhance_probe_authorise', { p_id: other, p_owner_id: a.uid, p_manifest_id: MANIFEST, p_max_calls: 1,
        p_allocation_micro: RESERVED, p_approval_ref: 'denied', p_expires_at: new Date(Date.now() + 3600000).toISOString() }],
      ['enhance_provider_control', { p_deployment_key: KEY, p_enabled: true, p_reason: null }]]) {
      const refused = await client.request(token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
      requireEvidence(!refused.ok && [401, 403, 404].includes(refused.status));
    }
  }
  requireEvidence(await ledger(a, other) === null);
  equal(await capacity(), initial);

  try {
    mark('setup');
    // Unconfigured owners are refused before any row is written.
    equal(await claim(a, randomUUID()), { code: 'UNCONFIGURED', claimed: false });
    await activate(`owner_id in (${literal(a.uid)},${literal(b.uid)})`);
    for (const owner of [a, b]) {
      equal(await claim(owner, randomUUID()), { code: 'CONSENT_REQUIRED', claimed: false });
      const consent = await client.rpc(owner, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 1 });
      requireEvidence(consent?.code === 'OK' && consent.consent?.enabled === true && consent.policy?.manifestId === MANIFEST
        && consent.policy.providerAvailable === false);
    }
    equal(await claim(a, randomUUID()), { code: 'UNAVAILABLE', claimed: false });
    equal(await control(false, null), { code: 'INVALID_INPUT' });
    await setMax(100);
    await freeSlots();
    await reopen();
    requireEvidence((await status(a)).policy.providerAvailable === true);

    mark('observed');
    const obsInput = hex(), obsOutput = hex(), obs = randomUUID();
    const claimed = await claim(a, obs, { input: obsInput });
    requireEvidence(claimed.code === 'OK' && claimed.claimed === true && claimed.manifestId === MANIFEST
      && Number.isSafeInteger(claimed.dispatchBeforeMs) && claimed.requestSeconds > 0);
    const held = await ledger(a, obs);
    requireEvidence(held.usage.purpose === 'enhancement' && held.usage.charge_state === 'held'
      && held.usage.reserved_micro === RESERVED && typeof held.usage.provider_slot_id === 'string'
      && held.evidence.enhance_input_sha256 === obsInput && held.evidence.stylist_code === null
      && held.evidence.enhance_code === null && held.evidence.enhance_probe_id === null);
    // The slot is held for the latest permitted dispatch (5 s) plus the 60 s window.
    equal(Number(await scalar(`select extract(epoch from s.held_until-u.dispatched_at) from private.ai_usage u
      join private.provider_slots s on s.slot_id=u.provider_slot_id where u.owner_id=${literal(a.uid)} and u.request_id=${literal(obs)};`)), 65);
    equal(await claim(a, obs), { code: 'TERMINAL', claimed: false });
    const out = { sha: obsOutput, bytes: bytes.length };
    const done = await finish(a, obs, 'OK', VALID, out);
    requireEvidence(done.code === 'OK' && Number.isSafeInteger(done.usableUntilMs));
    const observed = await ledger(a, obs);
    requireEvidence(observed.usage.charge_state === 'estimated' && observed.usage.accounted_micro === ESTIMATE
      && observed.usage.closed_reason === null && observed.evidence.enhance_settlement_origin === 'observed'
      && observed.evidence.enhance_code === 'OK' && observed.evidence.stylist_code === null
      && /^[0-9a-f]{64}$/.test(observed.evidence.enhance_settlement_digest));
    const accepted = await evidence(a, obs);
    requireEvidence(accepted.output_sha256 === obsOutput && accepted.input_sha256 === obsInput && accepted.model_id === MODEL
      && accepted.deployment_key === KEY && accepted.output_bytes === bytes.length);
    equal(Number(await scalar(`select count(*) from private.enhancement_outputs where owner_id=${literal(a.uid)}
      and output_sha256=${literal(obsOutput)} and first_request_id=${literal(obs)};`)), 1);
    const replay = await finish(a, obs, 'OK', VALID, out);
    requireEvidence(replay.code === 'OK' && replay.replayed === true && replay.usableUntilMs === done.usableUntilMs);
    // The idempotency key covers the output hash and length as well as the code and usage.
    equal((await finish(a, obs, 'OK', VALID, { sha: hex(), bytes: bytes.length })).code, 'USAGE_CONFLICT');
    equal((await finish(a, obs, 'OK', VALID, { sha: obsOutput, bytes: bytes.length + 1 })).code, 'USAGE_CONFLICT');
    equal((await finish(a, obs, 'NOT_DISPATCHED', null)).code, 'USAGE_CONFLICT');
    equal(await ledger(a, obs), observed);
    // Input shape: OK needs an output, other codes none; NOT_DISPATCHED carries no usage.
    const shape = randomUUID();
    requireEvidence((await claim(a, shape)).claimed === true);
    equal((await finish(a, shape, 'OK', VALID)).code, 'INVALID_INPUT');
    equal((await finish(a, shape, 'FAILED', VALID, out)).code, 'INVALID_INPUT');
    equal((await finish(a, shape, 'NOT_DISPATCHED', VALID)).code, 'INVALID_INPUT');
    equal((await finish(a, shape, 'MAYBE', VALID)).code, 'INVALID_INPUT');
    equal((await finish(a, shape, 'OK', VALID, { sha: 'x', bytes: 4 })).code, 'INVALID_INPUT');
    equal((await ledger(a, shape)).usage.charge_state, 'held');
    const nd = await finish(a, shape, 'NOT_DISPATCHED', null);
    equal(nd.code, 'NOT_DISPATCHED');
    const ndRow = await ledger(a, shape);
    requireEvidence(ndRow.usage.accounted_micro === RESERVED && ndRow.usage.closed_reason === 'UNAVAILABLE'
      && ndRow.evidence.enhance_settlement_origin === 'non_dispatch' && await evidence(a, shape) === null);
    // A provider failure with usage is observed; without usage it is unmetered (no kill switch). Neither adds evidence.
    const failed = randomUUID();
    requireEvidence((await claim(a, failed)).claimed === true);
    equal((await finish(a, failed, 'FILTERED', VALID)).code, 'FILTERED');
    requireEvidence((await ledger(a, failed)).usage.closed_reason === 'FAILED' && await evidence(a, failed) === null);
    const unmetered = randomUUID();
    requireEvidence((await claim(a, unmetered)).claimed === true);
    equal((await finish(a, unmetered, 'FAILED', null)).code, 'FAILED');
    const unmeteredRow = await ledger(a, unmetered);
    requireEvidence(unmeteredRow.usage.accounted_micro === RESERVED && unmeteredRow.evidence.enhance_settlement_origin === 'unmetered'
      && unmeteredRow.evidence.anomaly === true);
    requireEvidence((await capacity()).dispatch_enabled === true && (await controls(a)).enhance_activated === true);
    // Unsupported manifests are refused.
    equal(await claim(a, randomUUID(), { manifest: STYLIST }), { code: 'UNCONFIGURED', claimed: false });
    equal(await claim(a, '00000000-0000-0000-0000-000000000000'), { code: 'INVALID_INPUT', claimed: false });

    mark('terminal');
    // Invalid usage, a bad model observation and an envelope overrun each stop the shared switch once and only the
    // anomalous owner's enhancement activation. Tagging and stylist activation and the other owner are untouched.
    const terminal = async (usage, code, accounted) => {
      await freeSlots();
      const id = randomUUID();
      requireEvidence((await claim(a, id)).claimed === true);
      const bBefore = await controls(b), aBefore = await controls(a);
      equal((await finish(a, id, 'OK', usage, { sha: hex(), bytes: bytes.length })).code, code);
      const row = await ledger(a, id);
      requireEvidence(row.usage.accounted_micro === accounted && row.evidence.enhance_settlement_origin === 'terminal_anomaly'
        && row.evidence.anomaly === true && await evidence(a, id) === null);
      const k = await capacity();
      requireEvidence(k.dispatch_enabled === false && k.disabled_reason === 'USAGE_ANOMALY');
      const after = await controls(a);
      requireEvidence(after.enhance_activated === false && after.activated === aBefore.activated
        && after.stylist_activated === aBefore.stylist_activated);
      equal(await controls(b), bBefore);
      equal(await claim(b, randomUUID()), { code: 'UNAVAILABLE', claimed: false });
      equal(await claim(a, randomUUID()), { code: 'INACTIVE', claimed: false });
      equal((await finish(a, id, 'OK', usage, null)).code, 'INVALID_INPUT');
      await reactivate(a);
      await reopen();
    };
    await terminal({ ...VALID, total: 4999 }, 'INVALID_USAGE', RESERVED);
    await terminal({ ...VALID, modelObservation: 'response_unrecognised_model' }, 'USAGE_ANOMALY', RESERVED);
    // Overrun above the 7500-token input envelope: ceil((8000*800 + 100*3000)/100) = 67000, kept as observed.
    await terminal({ ...VALID, input: 8000, inputImage: 7900, output: 100, total: 8100 }, 'USAGE_ANOMALY', 67000);
    // Simultaneous anomaly finishes for both owners: both settle, the switch goes off once and each owner's own
    // enhancement activation stops.
    await freeSlots();
    const [ra, rb] = [randomUUID(), randomUUID()];
    requireEvidence((await claim(a, ra)).claimed === true && (await claim(b, rb)).claimed === true);
    const bad = { ...VALID, modelObservation: 'response_missing_model' };
    const both = await Promise.all([finish(a, ra, 'OK', bad, { sha: hex(), bytes: 4 }), finish(b, rb, 'OK', bad, { sha: hex(), bytes: 4 })]);
    equal(both.map((r) => r.code), ['USAGE_ANOMALY', 'USAGE_ANOMALY']);
    const k = await capacity();
    requireEvidence(k.dispatch_enabled === false && k.disabled_reason === 'USAGE_ANOMALY');
    requireEvidence((await controls(a)).enhance_activated === false && (await controls(b)).enhance_activated === false);
    await activate(`owner_id in (${literal(a.uid)},${literal(b.uid)})`);
    // Operator shutdown uses the same dedicated flag.
    equal(await control(false, 'OPERATOR'), { code: 'OK', dispatchEnabled: false });
    equal((await capacity()).disabled_reason, 'OPERATOR');
    equal(await claim(a, randomUUID()), { code: 'UNAVAILABLE', claimed: false });
    await reopen();

    mark('expiry');
    // Provisional expiry three minutes after dispatch; a late valid finish replaces the estimate but never releases
    // evidence. A settled row is never expired.
    const late = randomUUID(), early = randomUUID();
    requireEvidence((await claim(a, late)).claimed === true && (await claim(a, early)).claimed === true);
    equal((await finish(a, early, 'OK', VALID, { sha: hex(), bytes: 4 })).code, 'OK');
    await sql(`update private.ai_usage set dispatched_at=dispatched_at-interval '3 minutes'
      where owner_id=${literal(a.uid)} and request_id in (${literal(late)},${literal(early)});`);
    const earlyRow = await ledger(a, early);
    const expired = await one(`select public.enhance_expire_due(1000);`);
    requireEvidence(expired.code === 'OK' && expired.expired >= 1);
    const provisional = await ledger(a, late);
    requireEvidence(provisional.usage.charge_state === 'estimated' && provisional.usage.accounted_micro === RESERVED
      && provisional.usage.closed_reason === 'EXPIRED' && provisional.evidence.enhance_settlement_origin === 'provisional_expiry'
      && provisional.evidence.enhance_code === 'EXPIRED' && provisional.evidence.enhance_settlement_digest === null);
    equal(await ledger(a, early), earlyRow);
    const lateOut = { sha: hex(), bytes: 4 };
    equal((await finish(a, late, 'OK', VALID, lateOut)).code, 'EXPIRED');
    const replaced = await ledger(a, late);
    requireEvidence(replaced.usage.accounted_micro === ESTIMATE && replaced.usage.closed_reason === 'EXPIRED'
      && replaced.evidence.enhance_settlement_origin === 'observed' && await evidence(a, late) === null);
    const lateReplay = await finish(a, late, 'OK', VALID, lateOut);
    requireEvidence(lateReplay.code === 'EXPIRED' && lateReplay.replayed === true && lateReplay.usableUntilMs === null);
    for (const limit of [0, 1001, null]) equal((await one(`select public.enhance_expire_due(${limit ?? 'null'});`)).code, 'INVALID_INPUT');

    mark('revocation');
    // Consent revoked between claim and finish, or an account freeze committed in between: the usage is accounted,
    // no evidence is released. A frozen owner cannot claim or read status.
    const revoked = randomUUID();
    requireEvidence((await claim(a, revoked)).claimed === true);
    requireEvidence((await client.rpc(a, 'enhance_set_consent', { p_enabled: false, p_notice_revision: null })).consent.enabled === false);
    equal((await finish(a, revoked, 'OK', VALID, { sha: hex(), bytes: 4 })).code, 'CONSENT_REQUIRED');
    requireEvidence((await ledger(a, revoked)).usage.accounted_micro === ESTIMATE && await evidence(a, revoked) === null);
    equal((await client.rpc(a, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 2 })).code, 'CONFIG_CHANGED');
    equal((await client.rpc(a, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    const frozen = randomUUID();
    requireEvidence((await claim(b, frozen)).claimed === true);
    const unfreezeB = () => sql(`update private.approved_accounts set enabled=true where user_id=${literal(b.uid)};`);
    try {
      await sql(`update private.approved_accounts set enabled=false where user_id=${literal(b.uid)};`);
      equal(await claim(b, randomUUID()), { code: 'UNAVAILABLE', claimed: false });
      equal((await finish(b, frozen, 'OK', VALID, { sha: hex(), bytes: 4 })).code, 'UNAVAILABLE');
      equal((await status(b)).code, 'UNAVAILABLE');
    } finally { await unfreezeB(); }
    requireEvidence((await ledger(b, frozen)).usage.accounted_micro === ESTIMATE && await evidence(b, frozen) === null);
    equal((await status(b)).code, 'OK');

    mark('global-capacity');
    // M2: capacity is shared across owners and keyed by the deployment. With one free slot, concurrent A/B claims
    // yield exactly one reservation; settling it does not release the slot; the slot's end is the boundary.
    await freeSlots();
    await setMax(1);
    const [ca, cb] = [randomUUID(), randomUUID()];
    const race = await Promise.all([claim(a, ca), claim(b, cb)]);
    requireEvidence(race.filter((r) => r.claimed === true).length === 1);
    const loserIndex = race.findIndex((r) => r.claimed !== true);
    equal(race[loserIndex], { code: 'RATE_LIMIT', claimed: false });
    const [winner, loser] = loserIndex === 0 ? [b, a] : [a, b];
    const [winnerId, loserId] = loserIndex === 0 ? [cb, ca] : [ca, cb];
    requireEvidence(await ledger(loser, loserId) === null);
    equal((await finish(winner, winnerId, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
    equal(await claim(loser, randomUUID()), { code: 'RATE_LIMIT', claimed: false });
    // Status reports only the shared boolean, never foreign counts or identifiers.
    const loserStatus = await status(loser);
    const foreign = JSON.stringify(loserStatus);
    requireEvidence(!foreign.includes(winner.uid) && !foreign.includes(winnerId) && loserStatus.policy.providerAvailable === true
      && Object.keys(loserStatus.usage).sort().join() === 'enhanceLastHour,enhanceMicro,totalMicro,warning');
    await sql(`update private.provider_slots set held_until=clock_timestamp() where slot_id=(select provider_slot_id
      from private.ai_usage where owner_id=${literal(winner.uid)} and request_id=${literal(winnerId)});`);
    const next = randomUUID();
    requireEvidence((await claim(loser, next)).claimed === true);
    equal((await finish(loser, next, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
    await setMax(100);
    await freeSlots();

    mark('mixed-admission');
    // Enhancement rows count in the shared total and hourly gate of tagging and stylist admission, and vice versa;
    // the enhancement sub-limit and its own hourly cap apply on top. The stylist settlement contract is unchanged.
    const used = async (owner, purpose) => BigInt(await scalar(`select coalesce(sum(accounted_micro),0) from private.ai_usage
      where owner_id=${literal(owner.uid)} and (period=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM') or charge_state in ('reserved','held'))
      ${purpose ? `and purpose=${literal(purpose)}` : ''};`));
    const limits = (total, enhance) => sql(`update private.ai_controls set monthly_allowance_micro=${total},
      enhance_monthly_allowance_micro=${enhance} where owner_id=${literal(a.uid)};`);
    const rows = async () => Number(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)};`));
    const hold = randomUUID();
    requireEvidence((await claim(a, hold)).claimed === true);
    const total = await used(a), enhanceUsed = await used(a, 'enhancement');
    requireEvidence(enhanceUsed >= BigInt(RESERVED));
    let count = await rows();
    await limits(100000000n, enhanceUsed + BigInt(RESERVED) - 1n);
    equal(await claim(a, randomUUID()), { code: 'ALLOWANCE', claimed: false });
    await limits(total + BigInt(RESERVED) - 1n, total + BigInt(RESERVED) - 1n);
    equal(await claim(a, randomUUID()), { code: 'ALLOWANCE', claimed: false });
    const tagId = randomUUID();
    const tagRoom = total + BigInt(TAG_RESERVATION) - 1n;
    await limits(tagRoom, enhanceUsed + BigInt(RESERVED));
    equal((await one(`select public.ai_claim_analysis(${literal(a.uid)},${literal(tagId)},${literal(tagId)},1,
      ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(COLOUR_MANIFEST.v2)});`)).code, 'ALLOWANCE');
    await limits(total + BigInt(STYLIST_RESERVATION) - 1n, total + BigInt(STYLIST_RESERVATION) - 1n);
    equal((await one(`select public.stylist_claim(${literal(a.uid)},${literal(randomUUID())},${literal(STYLIST)});`)).code, 'ALLOWANCE');
    requireEvidence(await rows() === count);
    // R1 clamp: lowering the shared total lowers the enhancement sub-limit in the same update.
    await sql(`update private.ai_controls set monthly_allowance_micro=40000000 where owner_id=${literal(a.uid)};`);
    await limits(40000000n, 40000000n);
    await sql(`update private.ai_controls set monthly_allowance_micro=1000000 where owner_id=${literal(a.uid)};`);
    equal(String((await controls(a)).enhance_monthly_allowance_micro), '1000000');
    await reactivate(a);
    // Hourly: the shared cap counts every purpose; the enhancement cap counts enhancement rows only.
    const hour = async (purpose) => Number(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)}
      and created_at>clock_timestamp()-interval '1 hour' ${purpose ? `and purpose=${literal(purpose)}` : ''};`));
    await sql(`update private.ai_controls set max_requests_per_hour=${await hour(null)} where owner_id=${literal(a.uid)};`);
    equal(await claim(a, randomUUID()), { code: 'RATE_LIMIT', claimed: false });
    await reactivate(a);
    await sql(`update private.ai_controls set enhance_max_requests_per_hour=${await hour('enhancement')} where owner_id=${literal(a.uid)};`);
    equal(await claim(a, randomUUID()), { code: 'RATE_LIMIT', claimed: false });
    await reactivate(a);
    count = await rows();
    // A stylist request still settles through its own columns with an enhancement row open alongside.
    const sty = randomUUID();
    requireEvidence((await one(`select public.stylist_claim(${literal(a.uid)},${literal(sty)},${literal(STYLIST)});`)).claimed === true);
    const styDone = await one(`select public.stylist_finish(${literal(a.uid)},${literal(sty)},'OK',${json({ modelObservation: 'expected_snapshot',
      controlObservation: 'ordinary', input: 1000, output: 200, total: 1200, reasoning: 50, cacheRead: 0, cacheWrite: 0 })});`);
    equal(styDone.code, 'OK');
    const styRow = await ledger(a, sty);
    requireEvidence(styRow.usage.purpose === 'stylist' && styRow.usage.provider_slot_id === null
      && styRow.evidence.stylist_code === 'OK' && styRow.evidence.enhance_code === null && styRow.evidence.enhance_input_sha256 === null);
    // Request IDs are purpose-checked: a stylist request cannot be settled as an enhancement.
    equal((await finish(a, sty, 'OK', VALID, { sha: hex(), bytes: 4 })).code, 'INVALID_INPUT');
    equal((await finish(b, hold, 'NOT_DISPATCHED', null)).code, 'INVALID_INPUT');
    equal((await finish(a, hold, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
    requireEvidence(await rows() === count + 1);

    mark('probe');
    // N3: operator probe authorisation on the normal ledger. It substitutes for enhancement activation and consent for
    // probe claims only, is bound to its owner, deployment, manifest, allocation and call count, and stops on
    // missing usage. Normal dispatch stays refused.
    await sql(`update private.ai_controls set enhance_activated=false where owner_id=${literal(a.uid)};`);
    requireEvidence((await client.rpc(a, 'enhance_set_consent', { p_enabled: false, p_notice_revision: null })).consent.enabled === false);
    const authorise = (id, calls, allocation, ref, expires) => one(`select public.enhance_probe_authorise(${literal(id)},
      ${literal(a.uid)},${literal(MANIFEST)},${calls},${allocation},${literal(ref)},${literal(expires)}::timestamptz);`);
    const expires = new Date(Date.now() + 86400000).toISOString();
    const probe = randomUUID();
    equal(await authorise(probe, 2, 700000, `ledger-probe-${probe}`, expires), { code: 'OK', replayed: false, id: probe, deploymentKey: KEY });
    equal(await authorise(probe, 2, 700000, `ledger-probe-${probe}`, expires), { code: 'OK', replayed: true, id: probe, deploymentKey: KEY });
    equal(await authorise(probe, 3, 700000, `ledger-probe-${probe}`, expires), { code: 'CONFLICT' });
    equal(await authorise(randomUUID(), 2, 700000, `ledger-probe-${probe}`, expires), { code: 'CONFLICT' });
    equal((await authorise(randomUUID(), 7, 700000, `ledger-bad-${probe}`, expires)).code, 'INVALID_INPUT');
    equal((await authorise(randomUUID(), 1, RESERVED - 1, `ledger-small-${probe}`, expires)).code, 'INVALID_INPUT');
    equal(await claim(a, randomUUID()), { code: 'INACTIVE', claimed: false });
    equal(await claim(b, randomUUID(), { probe }), { code: 'INACTIVE', claimed: false });
    const p1 = randomUUID();
    requireEvidence((await claim(a, p1, { probe })).claimed === true);
    equal((await ledger(a, p1)).evidence.enhance_probe_id, probe);
    equal((await finish(a, p1, 'OK', VALID, { sha: hex(), bytes: 4 })).code, 'OK');
    requireEvidence(await evidence(a, p1) !== null);
    const p2 = randomUUID();
    requireEvidence((await claim(a, p2, { probe })).claimed === true);
    equal((await finish(a, p2, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
    equal(await claim(a, randomUUID(), { probe }), { code: 'PROBE_LIMIT', claimed: false });
    const stopping = randomUUID();
    equal((await authorise(stopping, 6, 1500000, `ledger-stop-${stopping}`, expires)).code, 'OK');
    const p3 = randomUUID();
    requireEvidence((await claim(a, p3, { probe: stopping })).claimed === true);
    equal((await finish(a, p3, 'FAILED', null)).code, 'FAILED');
    equal(await one(`select jsonb_build_object('reason',stopped_reason) from private.enhancement_probe_authorisations where id=${literal(stopping)};`),
      { reason: 'MISSING_USAGE' });
    equal(await claim(a, randomUUID(), { probe: stopping }), { code: 'INACTIVE', claimed: false });
    const lapsing = randomUUID();
    equal((await authorise(lapsing, 6, 1500000, `ledger-lapse-${lapsing}`, expires)).code, 'OK');
    const p4 = randomUUID();
    requireEvidence((await claim(a, p4, { probe: lapsing })).claimed === true);
    await sql(`update private.ai_usage set dispatched_at=dispatched_at-interval '3 minutes' where owner_id=${literal(a.uid)} and request_id=${literal(p4)};`);
    requireEvidence((await one(`select public.enhance_expire_due(1000);`)).expired >= 1);
    equal(await one(`select jsonb_build_object('reason',stopped_reason) from private.enhancement_probe_authorisations where id=${literal(lapsing)};`),
      { reason: 'MISSING_USAGE' });
    await reactivate(a);
    equal((await client.rpc(a, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    await freeSlots();

    const sh = saveHarness(client, a), shB = saveHarness(client, b);
    try {
      mark('admission-evidence');
      // N2/R2/R4 through the ordinary checked Save: usable evidence binds a pending image; the binding is a snapshot,
      // so completion needs neither the evidence nor the source; attachment happens once, on pending -> ready.
      const first = await enhanced(a);
      const saveWith = (harness, sha) => { const value = harness.track(intent()); value.p_image.main_sha256 = sha; return value; };
      const v1 = saveWith(sh, first.sha);
      const r1 = await sh.reserve(v1);
      equal(await binding(a, v1.p_image.id), { owner_id: a.uid, image_id: v1.p_image.id, source_kind: 'evidence', source_image_id: null,
        origin: 'recorded', request_id: first.id, import_id: null, model_id: MODEL, manifest_id: MANIFEST, input_sha256: first.input,
        backup_sha256: null, stored_sha256: first.sha });
      requireEvidence(await provenanceRow(a, v1.p_image.id) === null);
      await backdate(a, first.id, '25 hours');
      await sh.upload(v1);
      await sh.finalize(v1, r1);
      const recorded = { owner_id: a.uid, image_id: v1.p_image.id, kind: 'ai_edited', origin: 'recorded', request_id: first.id,
        import_id: null, model_id: MODEL, manifest_id: MANIFEST, input_sha256: first.input, backup_sha256: null, stored_sha256: first.sha };
      equal(await provenanceRow(a, v1.p_image.id), recorded);
      requireEvidence(await binding(a, v1.p_image.id) === null);
      equal(await ownProvenance(a, v1.p_image.id), { image_id: v1.p_image.id, kind: 'ai_edited', origin: 'recorded', model_id: MODEL,
        manifest_id: MANIFEST, stored_sha256: first.sha, backup_sha256: null });
      // Idempotent completion changes nothing; a ready -> retired transition never attaches or consumes.
      await sh.finalize(v1, r1);
      equal(await provenanceRow(a, v1.p_image.id), recorded);
      const retired = await sql(`begin; update public.item_images set state='retired',retired_at=clock_timestamp()
        where owner_id=${literal(a.uid)} and id=${literal(v1.p_image.id)};
        select 'R:'||jsonb_build_array((select count(*) from private.image_provenance where owner_id=${literal(a.uid)} and image_id=${literal(v1.p_image.id)}),
          (select count(*) from private.image_enhancement_bindings where owner_id=${literal(a.uid)}))::text; rollback;`);
      const bindingsNow = Number(await scalar(`select count(*) from private.image_enhancement_bindings where owner_id=${literal(a.uid)};`));
      equal(JSON.parse(retired.split('\n').find((line) => line.startsWith('R:')).slice(2)), [1, bindingsNow]);

      mark('admission-copy');
      // Reuse of saved bytes with durable provenance never expires (N2): the evidence is expired, the copy binds from
      // provenance. R2: the source item is then deleted and the copy still completes from its snapshot.
      const v2 = saveWith(sh, first.sha);
      const r2 = await sh.reserve(v2);
      const recordedPayload = { ...recorded };
      delete recordedPayload.kind;
      equal(await binding(a, v2.p_image.id), { ...recordedPayload, image_id: v2.p_image.id, source_kind: 'copy', source_image_id: v1.p_image.id });
      await sh.remove(v1);
      await sh.deleteItem(v1);
      equal(Number(await scalar(`select count(*) from public.items where owner_id=${literal(a.uid)} and id=${literal(v1.p_item.id)};`)), 0);
      requireEvidence(await provenanceRow(a, v1.p_image.id) === null);
      await sh.upload(v2);
      await sh.finalize(v2, r2);
      equal(await provenanceRow(a, v2.p_image.id), { ...recorded, image_id: v2.p_image.id });

      mark('admission-expired');
      // A tombstone without usable evidence or provenance refuses the bytes, before and after the evidence purge; a
      // fresh duplicate output then binds to the usable row (usable beats expired). Expiry during the reservation does
      // not matter: the binding is the snapshot. A pending -> retired transition never attaches.
      const stale = await enhanced(a);
      await backdate(a, stale.id, '25 hours');
      const refusedSave = saveWith(sh, stale.sha);
      denied(await sh.call('reserve_item_save', refusedSave), 'Enhancement expired');
      equal(await sh.read('items', refusedSave.p_item.id), []);
      await backdate(a, stale.id, '31 days');
      requireEvidence((await one(`select public.enhance_expire_due(1000);`)).evidencePurged >= 1);
      requireEvidence(await evidence(a, stale.id) === null);
      denied(await sh.call('reserve_item_save', saveWith(sh, stale.sha)), 'Enhancement expired');
      const fresh = await enhanced(a, stale.sha);
      const v3 = saveWith(sh, stale.sha);
      const r3 = await sh.reserve(v3);
      equal((await binding(a, v3.p_image.id)).request_id, fresh.id);
      const pendingRetire = await sql(`begin; update public.item_images set state='retired',retired_at=clock_timestamp()
        where owner_id=${literal(a.uid)} and id=${literal(v3.p_image.id)};
        select 'R:'||jsonb_build_array((select count(*) from private.image_provenance where owner_id=${literal(a.uid)} and image_id=${literal(v3.p_image.id)}),
          (select count(*) from private.image_enhancement_bindings where owner_id=${literal(a.uid)} and image_id=${literal(v3.p_image.id)}))::text; rollback;`);
      equal(JSON.parse(pendingRetire.split('\n').find((line) => line.startsWith('R:')).slice(2)), [0, 1]);
      await backdate(a, fresh.id, '25 hours');
      await sh.upload(v3);
      await sh.finalize(v3, r3);
      equal((await provenanceRow(a, v3.p_image.id)).request_id, fresh.id);
      // Cross-owner: B has no evidence, provenance or tombstone for A's bytes, so B's save is ordinary and unlabelled.
      const vb = saveWith(shB, first.sha);
      const rb2 = await shB.reserve(vb);
      requireEvidence(await binding(b, vb.p_image.id) === null);
      await shB.upload(vb);
      await shB.finalize(vb, rb2);
      requireEvidence(await provenanceRow(b, vb.p_image.id) === null);
      equal(await client.rpc(b, 'image_provenance_v1', {}), []);

      mark('restore-modes');
      // R3/Q6: each restored image carries one immutable mode. Legacy auto-labels only from A's own tombstone or
      // provenance on equal bytes; v4 labels only through the checked provenance restore with backup = stored; an
      // unlabelled restore is never labelled. A v1 pending reservation resumed through v2 drops its old binding.
      const restore = async (harness, owner, sha, mode, importId = randomUUID()) => {
        const value = saveWith(harness, sha);
        const result = await harness.call('reserve_restored_item_save_v2', { ...value, p_import_id: importId, p_mode: mode });
        requireEvidence(result.ok && Array.isArray(result.data) && result.data.length === 1);
        requireEvidence(await binding(owner, value.p_image.id) === null);
        await harness.upload(value);
        await harness.finalize(value, result.data[0]);
        return { value, importId, row: result.data[0] };
      };
      const legacy = await restore(sh, a, first.sha, 'legacy');
      equal(await provenanceRow(a, legacy.value.p_image.id), { owner_id: a.uid, image_id: legacy.value.p_image.id, kind: 'ai_edited',
        origin: 'imported', request_id: null, import_id: legacy.importId, model_id: MODEL, manifest_id: MANIFEST, input_sha256: null,
        backup_sha256: first.sha, stored_sha256: first.sha });
      const legacyB = await restore(shB, b, first.sha, 'legacy');
      requireEvidence(await provenanceRow(b, legacyB.value.p_image.id) === null);
      const entry = { kind: 'ai_edited', model_id: MODEL, manifest_id: MANIFEST, backup_sha256: first.sha };
      const v4 = await restore(sh, a, first.sha, 'v4');
      requireEvidence(await provenanceRow(a, v4.value.p_image.id) === null);
      const provArgs = { p_item_id: v4.value.p_item.id, p_image_id: v4.value.p_image.id, p_import_id: v4.importId };
      denied(await sh.call('restore_image_provenance', { ...provArgs, p_entry: { ...entry, backup_sha256: hex() } }));
      equal(await client.rpc(a, 'restore_image_provenance', { ...provArgs, p_entry: entry }), { state: 'created' });
      equal(await client.rpc(a, 'restore_image_provenance', { ...provArgs, p_entry: entry }), { state: 'equal' });
      denied(await sh.call('restore_image_provenance', { ...provArgs, p_entry: { ...entry, model_id: 'other-model' } }));
      const foreignProvenance = await shB.call('restore_image_provenance', { ...provArgs, p_entry: entry });
      requireEvidence(!foreignProvenance.ok && foreignProvenance.status === 403 && foreignProvenance.data?.code === '42501');
      const unlabelled = await restore(sh, a, first.sha, 'unlabelled');
      requireEvidence(await provenanceRow(a, unlabelled.value.p_image.id) === null);
      denied(await sh.call('restore_image_provenance', { p_item_id: unlabelled.value.p_item.id, p_image_id: unlabelled.value.p_image.id,
        p_import_id: unlabelled.importId, p_entry: entry }));
      // v1 pending -> v2 resume: the v1 reservation copied a binding from A's provenance; v2 replaces it with an
      // unlabelled marker in the same transaction. Exact replay succeeds, a conflicting mode fails.
      const resumed = saveWith(sh, first.sha);
      const v1Row = await sh.call('reserve_restored_item_save', resumed);
      requireEvidence(v1Row.ok && Array.isArray(v1Row.data) && v1Row.data.length === 1);
      equal((await binding(a, resumed.p_image.id)).source_kind, 'copy');
      const importId = randomUUID();
      const resume = () => sh.call('reserve_restored_item_save_v2', { ...resumed, p_import_id: importId, p_mode: 'unlabelled' });
      const resumedRow = await resume();
      requireEvidence(resumedRow.ok && resumedRow.data[0].fingerprint === v1Row.data[0].fingerprint);
      requireEvidence(await binding(a, resumed.p_image.id) === null);
      requireEvidence((await resume()).ok);
      denied(await sh.call('reserve_restored_item_save_v2', { ...resumed, p_import_id: importId, p_mode: 'v4' }));
      await sh.upload(resumed);
      await sh.finalize(resumed, resumedRow.data[0]);
      requireEvidence(await provenanceRow(a, resumed.p_image.id) === null);
      // Duplicate provenance rows with different metadata: an ordinary reuse copies the earliest (the recorded v2).
      const reuse = saveWith(sh, first.sha);
      await sh.reserve(reuse);
      const copied = await binding(a, reuse.p_image.id);
      requireEvidence(copied.source_kind === 'copy' && copied.source_image_id === v2.p_image.id && copied.origin === 'recorded');
      // Status never names another owner and the provenance read is owner-only.
      requireEvidence((await client.rpc(b, 'image_provenance_v1', {})).length === 0);
      requireEvidence(!JSON.stringify(await status(b)).includes(a.uid));
    } finally {
      await sh.cleanup();
      await shB.cleanup();
    }
  } finally {
    // Restore the inactive state: switch off with its INITIAL reason, 2 per 60 s, no enhancement activation.
    await sql(`update private.provider_capacity set dispatch_enabled=false,disabled_reason='INITIAL',disabled_at=clock_timestamp(),
      max_dispatch=2,updated_at=clock_timestamp() where deployment_key=${literal(KEY)};
      update private.ai_controls set enhance_activated=false where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
  }
  const restored = await capacity();
  requireEvidence(restored.dispatch_enabled === false && restored.disabled_reason === 'INITIAL' && restored.max_dispatch === 2);
}
