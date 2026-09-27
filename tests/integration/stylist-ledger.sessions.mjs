// ST1a: the stylist ledger functions against the real schema at the full migration inventory. Invoked only by the
// CI-only preservation owner after the P6d probes (a database reset follows). stylist_claim, stylist_finish,
// stylist_expire_due and stylist_direct_allocation are service/operator functions, called here through privileged SQL the
// way the Edge handler and cron call them; every access assertion uses the ordinary A/B sessions. No provider calls.
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisHash } from './ai-analysis.sessions.mjs';
import { imageChangeHarness } from './image-replacement.sessions.mjs';
import { COLOUR_MANIFEST } from './azure-preservation.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

const MANIFEST = 'azure-eu-terra-stylist-v1';
const RESERVED = 129360;
const TAG_RESERVATION = 4097351;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// ceil((1000*220 + 200*1320)/100) = 4840 micro-USD.
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', controlObservation: 'ordinary', input: 1000, output: 200,
  total: 1200, reasoning: 50, cacheRead: 0, cacheWrite: 0 });
// The Edge handler's marker for an unusable 200 response (supabase/functions/stylist-chat/azure.ts).
const UNUSABLE = Object.freeze({ modelObservation: 'not_observed', controlObservation: 'ordinary', input: null, output: null,
  total: null, reasoning: null, cacheRead: null, cacheWrite: null });

export async function stylistLedgerProbes(snapshot, sql, mark) {
  const { client, owners: [a, b], env } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const claim = (owner, id) => one(`select public.stylist_claim(${literal(owner.uid)},${literal(id)},${literal(MANIFEST)});`);
  const finish = (owner, id, code, usage) => one(`select public.stylist_finish(${literal(owner.uid)},${literal(id)},${literal(code)},
    ${usage === null ? 'null::jsonb' : json(usage)});`);
  const ledger = (owner, id) => one(`select coalesce((select jsonb_build_object('usage',to_jsonb(u),'evidence',to_jsonb(e))
    from private.ai_usage u join private.ai_usage_evidence e using (owner_id,request_id)
    where u.owner_id=${literal(owner.uid)} and u.request_id=${literal(id)}),'null'::jsonb);`);
  const rowCount = async (owner) => Number(await sql(`select count(*) from private.ai_usage where owner_id=${literal(owner.uid)};`));
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const status = (owner) => client.rpc(owner, 'stylist_status', {});
  const activate = (where) => sql(`update private.ai_controls set stylist_activated=true,stylist_notice_revision=1,
    stylist_manifest_id=${literal(MANIFEST)},stylist_max_request_micro=${RESERVED},stylist_monthly_allowance_micro=10000000,
    stylist_max_requests_per_hour=1000,monthly_allowance_micro=100000000,max_requests_per_hour=1000,updated_at=clock_timestamp()
    where ${where};`);
  const reactivate = (owner) => activate(`owner_id=${literal(owner.uid)}`);
  const settled = async (owner, usage = VALID, code = 'OK') => {
    const id = randomUUID();
    requireEvidence((await claim(owner, id)).claimed === true);
    return { id, finished: await finish(owner, id, code, usage) };
  };
  const tagClaim = (owner, id) => one(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
    ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(COLOUR_MANIFEST.v2)});`);
  // One uncommitted transaction runs `statement`, then sleeps. Resolves once the sleep is observed, with { done }, the
  // transaction's output promise (wrapped, so awaiting hold() does not wait for the transaction to end).
  const hold = async (statement, seconds, end = 'commit') => {
    const marker = `pg_sleep(${seconds})`;
    const held = sql(`begin; ${statement}; select 'HELD'; select ${marker}; ${end}; select 'DONE';`);
    for (const until = Date.now() + 5000; ;) {
      if (await sql(`select count(*) from pg_stat_activity where wait_event='PgSleep' and query like ${literal(`%${marker}%`)}
        and pid<>pg_backend_pid();`) === '1') return { done: held };
      requireEvidence(Date.now() < until);
      await delay(25);
    }
  };

  mark('structure');
  // Runtime ACL, definer and search_path: claim/finish only for service_role, status/consent only for authenticated,
  // expiry and the operator allocation for none of them.
  equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
      not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),
      has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('authenticated',p.oid,'EXECUTE'),
      has_function_privilege('service_role',p.oid,'EXECUTE')))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'stylist\\_%';`), {
    stylist_claim: [true, true, false, false, true], stylist_finish: [true, true, false, false, true],
    stylist_status: [true, true, false, true, false], stylist_set_consent: [true, true, false, true, false],
    stylist_expire_due: [true, true, false, false, false], stylist_direct_allocation: [true, true, false, false, false] });

  mark('setup');
  await activate(`owner_id in (${literal(a.uid)},${literal(b.uid)})`);
  for (const owner of [a, b]) {
    const consent = await client.rpc(owner, 'stylist_set_consent', { p_enabled: true, p_notice_revision: 1 });
    requireEvidence(consent?.code === 'OK' && consent.consent?.enabled === true && consent.policy?.manifestId === MANIFEST);
  }
  const ichA = imageChangeHarness(client, a, env);
  const eligible = await ichA.create();
  const exportTables = async () => (await client.rpc(a, 'export_manifest', { p_export_id: randomUUID() })).tables;
  const exportBefore = await exportTables();

  mark('normal-denied');
  // Ordinary sessions (and anonymous) cannot reach the service/operator functions, for their own or the other owner.
  const other = randomUUID();
  for (const token of [a.token, b.token, null]) {
    for (const [name, body] of [
      ['stylist_claim', { p_owner_id: a.uid, p_request_id: other, p_manifest_id: MANIFEST }],
      ['stylist_finish', { p_owner_id: a.uid, p_request_id: other, p_code: 'OK', p_usage: VALID }],
      ['stylist_expire_due', { p_limit: 10 }],
      ['stylist_direct_allocation', { p_owner_id: a.uid, p_allocation_micro: 1, p_expected_total_micro: 100000000 }]]) {
      const denied = await client.request(token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
      requireEvidence(!denied.ok && [401, 403, 404].includes(denied.status));
    }
  }
  requireEvidence(await ledger(a, other) === null);

  mark('observed');
  const obs = await settled(a);
  equal(obs.finished.code, 'OK');
  const observed = await ledger(a, obs.id);
  requireEvidence(observed.usage.charge_state === 'estimated' && observed.usage.accounted_micro === 4840
    && observed.usage.reserved_micro === RESERVED && observed.usage.purpose === 'stylist' && observed.usage.closed_reason === null
    && observed.evidence.settlement_origin === 'observed' && observed.evidence.stylist_code === 'OK'
    && isDeepStrictEqual(observed.evidence.normalized_usage, VALID) && observed.evidence.estimated_micro === 4840
    && /^[0-9a-f]{64}$/.test(observed.evidence.settlement_digest));
  const replay = await finish(a, obs.id, 'OK', VALID);
  requireEvidence(replay.code === 'OK' && replay.replayed === true);
  equal((await finish(a, obs.id, 'OK', { ...VALID, output: 201, total: 1201 })).code, 'USAGE_CONFLICT');
  equal((await finish(a, obs.id, 'NOT_DISPATCHED', null)).code, 'USAGE_CONFLICT');
  equal(await ledger(a, obs.id), observed);
  // Input shape: NOT_DISPATCHED needs no usage, every other code needs usage.
  const shape = randomUUID();
  requireEvidence((await claim(a, shape)).claimed === true);
  equal((await finish(a, shape, 'NOT_DISPATCHED', VALID)).code, 'INVALID_INPUT');
  equal((await finish(a, shape, 'OK', null)).code, 'INVALID_INPUT');
  equal((await finish(a, shape, 'MAYBE', VALID)).code, 'INVALID_INPUT');
  equal((await ledger(a, shape)).usage.charge_state, 'held');
  equal((await finish(a, shape, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');

  mark('terminal');
  // Invalid usage outranks a bad observation, which outranks an overrun. Each disables only the stylist.
  const tagging = (await controls(a)).activated;
  const terminal = async (usage, code, accounted, normalized) => {
    const t = await settled(a, usage);
    equal(t.finished.code, code);
    const row = await ledger(a, t.id);
    requireEvidence(row.usage.charge_state === 'estimated' && row.usage.accounted_micro === accounted
      && row.evidence.settlement_origin === 'terminal_anomaly' && row.evidence.anomaly === true
      && isDeepStrictEqual(row.evidence.normalized_usage, normalized));
    const after = await controls(a);
    requireEvidence(after.stylist_activated === false && after.activated === tagging);
    equal((await status(a)).code, 'INACTIVE');
    const refused = randomUUID();
    equal(await claim(a, refused), { code: 'INACTIVE', claimed: false });
    requireEvidence(await ledger(a, refused) === null);
    equal((await finish(a, t.id, 'OK', usage)).replayed, true);
    await reactivate(a);
    return row;
  };
  await terminal(UNUSABLE, 'INVALID_USAGE', RESERVED, null);
  await terminal({ ...VALID, total: 1199 }, 'INVALID_USAGE', RESERVED, null);
  const bad = { ...VALID, modelObservation: 'response_unrecognised_model' };
  await terminal(bad, 'USAGE_ANOMALY', RESERVED, bad);
  await terminal({ ...VALID, cacheRead: 1 }, 'USAGE_ANOMALY', RESERVED, { ...VALID, cacheRead: 1 });
  await terminal({ ...bad, modelObservation: 'response_missing_model', total: 1 }, 'INVALID_USAGE', RESERVED, null);
  // An overrun keeps its observed estimate above the reservation: ceil((30000*220 + 5000*1320)/100) = 132000.
  const overrun = { ...VALID, input: 30000, output: 5000, total: 35000 };
  const over = await terminal(overrun, 'USAGE_ANOMALY', 132000, overrun);
  requireEvidence(over.usage.accounted_micro > over.usage.reserved_micro);

  mark('non-dispatch');
  const nd = await settled(a, null, 'NOT_DISPATCHED');
  equal(nd.finished.code, 'NOT_DISPATCHED');
  const ndRow = await ledger(a, nd.id);
  requireEvidence(ndRow.usage.charge_state === 'estimated' && ndRow.usage.accounted_micro === RESERVED
    && ndRow.usage.closed_reason === 'UNAVAILABLE' && ndRow.evidence.settlement_origin === 'non_dispatch');

  mark('expiry');
  // Scheduled expiry closes a held row at its reservation without any later stylist call; a valid finish then
  // replaces the provisional estimate. A settled row is never expired.
  const late = randomUUID(), early = await settled(a);
  requireEvidence((await claim(a, late)).claimed === true);
  await sql(`update private.ai_usage set dispatched_at=dispatched_at-interval '3 minutes'
    where owner_id=${literal(a.uid)} and request_id in (${literal(late)},${literal(early.id)});`);
  const earlyRow = await ledger(a, early.id);
  const expired = await one(`select public.stylist_expire_due(1000);`);
  requireEvidence(expired.code === 'OK' && expired.expired >= 1);
  const provisional = await ledger(a, late);
  requireEvidence(provisional.usage.charge_state === 'estimated' && provisional.usage.accounted_micro === RESERVED
    && provisional.usage.closed_reason === 'EXPIRED' && provisional.evidence.settlement_origin === 'provisional_expiry'
    && provisional.evidence.stylist_code === 'EXPIRED' && provisional.evidence.settlement_digest === null);
  equal(await ledger(a, early.id), earlyRow);
  equal((await finish(a, late, 'OK', VALID)).code, 'EXPIRED');
  const replaced = await ledger(a, late);
  requireEvidence(replaced.usage.accounted_micro === 4840 && replaced.usage.closed_reason === 'EXPIRED'
    && replaced.evidence.settlement_origin === 'observed');
  equal((await finish(a, late, 'OK', VALID)).replayed, true);
  equal((await one(`select public.stylist_expire_due(0);`)).code, 'INVALID_INPUT');

  mark('month');
  // A settled row stops counting at the UTC month boundary; an open reservation keeps counting until it closes.
  const micro = async (owner) => BigInt((await status(owner)).usage.stylistMicro);
  const startMicro = await micro(a);
  const month = await settled(a);
  requireEvidence(await micro(a) === startMicro + 4840n);
  const previous = `to_char((clock_timestamp() at time zone 'UTC') - interval '1 month','YYYY-MM')`;
  await sql(`update private.ai_usage set period=${previous} where owner_id=${literal(a.uid)} and request_id=${literal(month.id)};`);
  requireEvidence(await micro(a) === startMicro);
  const open = randomUUID();
  requireEvidence((await claim(a, open)).claimed === true);
  await sql(`update private.ai_usage set period=${previous} where owner_id=${literal(a.uid)} and request_id=${literal(open)};`);
  requireEvidence(await micro(a) === startMicro + BigInt(RESERVED));
  equal((await finish(a, open, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
  requireEvidence(await micro(a) === startMicro);

  mark('allowance');
  const used = async (owner, purpose) => BigInt(await sql(`select coalesce(sum(accounted_micro),0) from private.ai_usage
    where owner_id=${literal(owner.uid)} and (period=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM') or charge_state in ('reserved','held'))
    ${purpose ? `and purpose=${literal(purpose)}` : ''};`));
  const limit = (owner, total, stylist) => sql(`update private.ai_controls set monthly_allowance_micro=${total},
    stylist_monthly_allowance_micro=${stylist} where owner_id=${literal(owner.uid)};`);
  let rows = await rowCount(a);
  const total = await used(a), stylistUsed = await used(a, 'stylist');
  requireEvidence(stylistUsed > 0n);
  await limit(a, 100000000, stylistUsed + BigInt(RESERVED) - 1n);
  equal(await claim(a, randomUUID()), { code: 'ALLOWANCE', claimed: false });
  await limit(a, total + BigInt(RESERVED) - 1n, total + BigInt(RESERVED) - 1n);
  equal(await claim(a, randomUUID()), { code: 'ALLOWANCE', claimed: false });
  // Tagging alone would fit, but its unchanged admission counts the stylist rows in the shared ledger.
  const tagOnly = total - stylistUsed + BigInt(TAG_RESERVATION);
  await limit(a, tagOnly, tagOnly);
  equal((await tagClaim(a, randomUUID())).code, 'ALLOWANCE');
  requireEvidence(await rowCount(a) === rows);
  await reactivate(a);

  mark('shared-limit');
  // Binding M5: tagging and stylist claims near the shared limit. The first holds the profile and controls locks in an
  // open transaction; the second (tagging waits, stylist refuses NOWAIT with BUSY) is decided only after the first
  // commits, so only the affordable reservation is taken. Room is left for exactly one of the two.
  for (const first of ['tagging', 'stylist']) {
    const current = await used(a);
    const room = current + BigInt(TAG_RESERVATION) + BigInt(RESERVED) - 1n;
    await limit(a, room, room);
    rows = await rowCount(a);
    const tagId = randomUUID(), styId = randomUUID();
    const tagSql = `select 'TAG:'||public.ai_claim_analysis(${literal(a.uid)},${literal(tagId)},${literal(tagId)},1,
      ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(COLOUR_MANIFEST.v2)})::text`;
    const stySql = `select 'STY:'||public.stylist_claim(${literal(a.uid)},${literal(styId)},${literal(MANIFEST)})::text`;
    const held = await hold(first === 'tagging' ? tagSql : stySql, first === 'tagging' ? 1.011 : 1.013);
    const second = sql(`${first === 'tagging' ? stySql : tagSql};`);
    const [heldOut, secondOut] = await Promise.all([held.done, second]);
    const parse = (out, prefix) => JSON.parse(out.split('\n').find((line) => line.startsWith(prefix)).slice(prefix.length));
    const firstResult = parse(heldOut, first === 'tagging' ? 'TAG:' : 'STY:');
    let secondResult = parse(secondOut, first === 'tagging' ? 'STY:' : 'TAG:');
    requireEvidence(firstResult.claimed === true);
    if (first === 'tagging') {
      requireEvidence(['BUSY', 'ALLOWANCE'].includes(secondResult.code) && secondResult.claimed === false);
      if (secondResult.code === 'BUSY') secondResult = await claim(a, styId);
    }
    equal(secondResult, { code: 'ALLOWANCE', claimed: false });
    requireEvidence(await rowCount(a) === rows + 1 && await used(a) <= room);
    requireEvidence(await ledger(a, first === 'tagging' ? styId : tagId) === null);
  }
  await reactivate(a);

  mark('allocation');
  // D1: the operator allocation is guarded by the expected previous total, so a rerun cannot subtract twice.
  const totalB = BigInt((await controls(b)).monthly_allowance_micro);
  const allocated = await one(`select public.stylist_direct_allocation(${literal(b.uid)},2060000,${totalB});`);
  equal(allocated, { code: 'OK', previousTotalMicro: String(totalB), newTotalMicro: String(totalB - 2060000n) });
  equal(await one(`select public.stylist_direct_allocation(${literal(b.uid)},2060000,${totalB});`), { code: 'CONFLICT' });
  const lowered = totalB - 2060000n;
  equal((await one(`select public.stylist_direct_allocation(${literal(b.uid)},${lowered - 1n},${lowered});`)).code, 'DEFER');
  equal(BigInt((await controls(b)).monthly_allowance_micro), lowered);
  equal((await one(`select public.stylist_direct_allocation(${literal(b.uid)},0,${lowered});`)).code, 'INVALID_INPUT');
  await reactivate(b);
  // Headroom: the new total clears the per-request minimum but is below the used (accounted plus held) total. A has
  // usage; its per-request minimum is lowered inside a rolled-back transaction, so only the used-total rule can DEFER.
  const beforeA = await controls(a);
  const usedA = await used(a);
  requireEvidence(usedA > 2n);
  const headroom = BigInt(beforeA.monthly_allowance_micro) - (usedA - 1n);
  const deferred = await sql(`begin; update private.ai_controls set max_request_micro=1 where owner_id=${literal(a.uid)};
    select 'ALLOC:'||public.stylist_direct_allocation(${literal(a.uid)},${headroom},${beforeA.monthly_allowance_micro})::text; rollback;`);
  const result = JSON.parse(deferred.split('\n').find((line) => line.startsWith('ALLOC:')).slice('ALLOC:'.length));
  equal(result, { code: 'DEFER', usedMicro: String(usedA), newTotalMicro: String(usedA - 1n) });
  requireEvidence(usedA - 1n >= 1n);
  equal(await controls(a), beforeA);

  mark('cross-request');
  // Request IDs are owner-scoped and purpose-checked: a tagging request cannot be claimed or settled as a stylist request,
  // and A's owner cannot settle B's stylist request.
  const tagRequest = randomUUID();
  requireEvidence((await tagClaim(a, tagRequest)).claimed === true);
  const tagRow = await one(`select to_jsonb(u) from private.ai_usage u where owner_id=${literal(a.uid)} and request_id=${literal(tagRequest)};`);
  equal(await claim(a, tagRequest), { code: 'TERMINAL', claimed: false });
  equal((await finish(a, tagRequest, 'OK', VALID)).code, 'INVALID_INPUT');
  equal(await one(`select to_jsonb(u) from private.ai_usage u where owner_id=${literal(a.uid)} and request_id=${literal(tagRequest)};`), tagRow);
  const bRequest = randomUUID();
  requireEvidence((await claim(b, bRequest)).claimed === true);
  const bRow = await ledger(b, bRequest);
  equal((await finish(a, bRequest, 'OK', VALID)).code, 'INVALID_INPUT');
  // The same request ID under A's owner is A's own separate row; B's row is untouched.
  requireEvidence((await claim(a, bRequest)).claimed === true);
  equal((await ledger(a, bRequest)).usage.owner_id, a.uid);
  equal((await finish(a, bRequest, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
  equal(await ledger(b, bRequest), bRow);
  equal((await finish(b, bRequest, 'OK', VALID)).code, 'OK');
  const bStatus = await status(b), aStatus = await status(a);
  requireEvidence(bStatus.code === 'OK' && aStatus.code === 'OK' && bStatus.usage.stylistMicro !== undefined);

  mark('context');
  // The claim projection, inside a rolled-back transaction: weather facts only with confirmed provenance, lower coverage
  // also when observed; an active deletion fence excludes the item. The item is forced eligible in the same transaction.
  const item = eligible.item.id;
  const project = async (provenance, fence = false) => {
    const out = await sql(`begin;
      set local session_replication_role = replica;
      update public.items set deleted_at=null,lifecycle='active',availability='ready',exclude_suggestions=false,
        warmth=3,min_temp=-5,max_temp=10,rain_rating=2,windproof=true,upper_coverage=2,lower_coverage=2,
        field_provenance=(field_provenance-array['warmth','min_temp','max_temp','rain_rating','windproof','lower_coverage'])||${json(provenance)}
        where owner_id=${literal(a.uid)} and id=${literal(item)};
      set local session_replication_role = origin;
      ${fence ? `insert into private.item_deletion_operations(owner_id,request_id,item_id,phase)
        values(${literal(a.uid)},gen_random_uuid(),${literal(item)},'removing_registered');` : ''}
      select 'CLAIM:'||public.stylist_claim(${literal(a.uid)},gen_random_uuid(),${literal(MANIFEST)})::text;
      rollback;`);
    const result = JSON.parse(out.split('\n').find((line) => line.startsWith('CLAIM:')).slice(6));
    requireEvidence(result.claimed === true && Array.isArray(result.items));
    return result.items.find((entry) => entry.id === item) ?? null;
  };
  const kinds = (kind) => Object.fromEntries(['warmth', 'min_temp', 'max_temp', 'rain_rating', 'windproof', 'lower_coverage']
    .map((field) => [field, { kind, revision: 1 }]));
  const weather = (entry) => entry && [entry.warmth, entry.min_temp, entry.max_temp, entry.rain_rating, entry.windproof,
    entry.upper_coverage, entry.lower_coverage];
  const rowsBeforeContext = await rowCount(a);
  equal(weather(await project({})), [null, null, null, null, null, 2, null]);
  equal(weather(await project(kinds('unknown'))), [null, null, null, null, null, 2, null]);
  equal(weather(await project(kinds('ai_observed'))), [null, null, null, null, null, 2, 2]);
  equal(weather(await project(kinds('user'))), [3, -5, 10, 2, true, 2, 2]);
  equal(await project(kinds('user'), true), null);
  requireEvidence(await rowCount(a) === rowsBeforeContext);

  mark('freeze');
  // Binding D6: an account freeze that overlaps the claim transaction. While the freeze holds the approved-account row
  // the claim refuses (BUSY) and reserves nothing; once the freeze commits the claim is UNAVAILABLE. A freeze committed
  // between claim and finish suppresses the content (UNAVAILABLE) while the observed usage stays accounted.
  const freezeB = `update private.approved_accounts set enabled=false where user_id=${literal(b.uid)} and enabled`;
  const unfreezeB = () => sql(`update private.approved_accounts set enabled=true where user_id=${literal(b.uid)};`);
  const rowsB = await rowCount(b);
  const overlapping = await hold(freezeB, 1.017, 'rollback');
  equal(await claim(b, randomUUID()), { code: 'BUSY', claimed: false });
  await overlapping.done;
  requireEvidence(await rowCount(b) === rowsB);
  const frozenClaim = randomUUID();
  try {
    await sql(`${freezeB};`);
    equal(await claim(b, frozenClaim), { code: 'UNAVAILABLE', claimed: false });
    equal((await status(b)).code, 'UNAVAILABLE');
  } finally { await unfreezeB(); }
  requireEvidence(await ledger(b, frozenClaim) === null && await rowCount(b) === rowsB);
  const inFlight = randomUUID();
  requireEvidence((await claim(b, inFlight)).claimed === true);
  try {
    // The finish waits for the freeze transaction (FOR SHARE), then sees the account frozen.
    const freezing = await hold(freezeB, 1.019);
    const [, frozenFinish] = await Promise.all([freezing.done, finish(b, inFlight, 'OK', VALID)]);
    equal(frozenFinish.code, 'UNAVAILABLE');
  } finally { await unfreezeB(); }
  const suppressed = await ledger(b, inFlight);
  requireEvidence(suppressed.usage.accounted_micro === 4840 && suppressed.usage.closed_reason === 'UNAVAILABLE'
    && suppressed.evidence.settlement_origin === 'observed');
  equal((await status(b)).code, 'OK');

  mark('export');
  // No stylist state reaches the owner's export, and none of the above changed an exported table.
  const exportAfter = await exportTables();
  equal(exportAfter, exportBefore);
  requireEvidence(!JSON.stringify(exportAfter).includes('stylist'));
}
