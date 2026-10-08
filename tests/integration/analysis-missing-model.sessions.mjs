// SAVE1: Azure photo-analysis model identity against the real schema. A reply without a model name, or with an unrecognised
// one, fails only that photo; photo AI stays on. Cache/contradictory control observations and token-envelope overruns still
// switch the account off. An unrecognised model also raises an owner-only Settings notice that lasts seven days from the
// request's dispatch. Invoked only by the CI-only preservation owner: analysisModelSeed runs on the exact prior stage
// (20261007090000), the new migration is applied alone, then analysisModelVerify compares and probes. Synthetic IDs only.
// The finisher is a service function called through privileged SQL the way the Edge handler calls it; ai_status runs as
// the signed-in owner through a role switch with the negotiated header. No provider calls.
import { randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisFacts, analysisUsage, analysisHash, analysisStatus } from './ai-analysis.sessions.mjs';
import { COLOUR_MANIFEST } from './azure-preservation.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

const MODEL_ID = 'gpt-5.6-terra-2026-07-09';
const ESTIMATE = 1034;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_KEYS = ['code', 'consent', 'period', 'policy', 'serverTimeMs', 'usage'];
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const withModel = (modelObservation, extra = {}) => ({ ...analysisUsage, modelObservation, ...extra });

function tools(snapshot, sql) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const ids = `${literal(a.uid)},${literal(b.uid)}`;
  const claim = (owner, id, manifest = COLOUR_MANIFEST.v2) => one(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},
    ${literal(id)},1,${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(manifest)});`);
  const finish = (owner, id, usage, code = 'SUCCESS', manifest = COLOUR_MANIFEST.v2, facts = analysisFacts) =>
    one(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},${literal(manifest)},${json(facts)},${json(usage)},${literal(code)});`);
  const ledger = (owner, id) => one(`select coalesce((select jsonb_build_object('usage',to_jsonb(u),'evidence',to_jsonb(e))
    from private.ai_usage u join private.ai_usage_evidence e using (owner_id,request_id)
    where u.owner_id=${literal(owner.uid)} and u.request_id=${literal(id)}),'null'::jsonb);`);
  const requestRows = async (owner, id) => Number(await sql(`select count(*) from private.ai_requests
    where owner_id=${literal(owner.uid)} and request_id=${literal(id)};`));
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const restoreControls = (owner, saved) => sql(`delete from private.ai_controls where owner_id=${literal(owner.uid)};
    insert into private.ai_controls select * from jsonb_populate_record(null::private.ai_controls,${json(saved)});`);
  const activate = (owner) => sql(`update private.ai_controls set activated=true,notice_revision=2,model_id=${literal(MODEL_ID)},
    prompt_version=2,max_request_micro=4097351,monthly_allowance_micro=100000000,max_requests_per_hour=1000,result_ttl_seconds=3600,
    execution_manifest_id=${literal(COLOUR_MANIFEST.v2)},updated_at=clock_timestamp() where owner_id=${literal(owner.uid)};`);
  const consent = async (owner) => {
    const profile = (await client.rows(owner, 'profiles'))[0];
    equal((await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: 2, p_expected_version: profile.version })).code, 'OK');
  };
  // ai_status as the signed-in owner. headerVersion null sends no request headers at all.
  const status = async (owner, headerVersion) => {
    const headers = headerVersion === null ? '' : `select set_config('request.headers',${literal(JSON.stringify({ 'x-stillroom-ai-status-version': headerVersion }))},true);`;
    const out = await sql(`begin; set local role authenticated;
      select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: owner.uid, role: 'authenticated' }))},true); ${headers}
      select 'S:'||public.ai_status()::text; commit;`);
    return JSON.parse(out.split('\n').find((line) => line.startsWith('S:')).slice(2));
  };
  const noticeUntil = async (owner) => {
    const value = await status(owner, '2');
    requireEvidence(Object.hasOwn(value, 'photoModelNoticeUntilMs'));
    return value;
  };
  const digest = () => one(`select jsonb_build_object(
    'usage',(select coalesce(jsonb_agg(to_jsonb(t) order by t.owner_id,t.request_id),'[]'::jsonb) from private.ai_usage t where t.owner_id in (${ids})),
    'evidence',(select coalesce(jsonb_agg(to_jsonb(t) order by t.owner_id,t.request_id),'[]'::jsonb) from private.ai_usage_evidence t where t.owner_id in (${ids})),
    'requests',(select coalesce(jsonb_agg(to_jsonb(t) order by t.owner_id,t.request_id),'[]'::jsonb) from private.ai_requests t where t.owner_id in (${ids})),
    'controls',(select coalesce(jsonb_agg(to_jsonb(t) order by t.owner_id),'[]'::jsonb) from private.ai_controls t where t.owner_id in (${ids})),
    'profiles',(select coalesce(jsonb_agg(jsonb_build_object('owner',t.owner_id,'on',t.ai_enabled,'rev',t.ai_notice_revision,'v',t.version) order by t.owner_id),'[]'::jsonb)
      from public.profiles t where t.owner_id in (${ids})));`);
  const envelope = async () => one(`select jsonb_build_object('input',input_envelope,'output',output_envelope)
    from private.ai_execution_manifests where id=${literal(COLOUR_MANIFEST.v2)};`);
  return { client, a, b, one, claim, finish, ledger, requestRows, controls, restoreControls, activate, consent, status, noticeUntil, digest, envelope };
}

// Prior stage: populated, normal-owner state that the new migration must leave exactly as it is.
export async function analysisModelSeed(snapshot, sql) {
  const t = tools(snapshot, sql), { a, b } = t;
  const saved = [await t.controls(a), await t.controls(b)];
  requireEvidence(saved[0] && saved[1]);
  for (const owner of [a, b]) { await t.consent(owner); await t.activate(owner); }
  const inflight = randomUUID(), ready = randomUUID(), usageOnly = randomUUID();
  requireEvidence((await t.claim(a, inflight)).claimed === true);
  requireEvidence((await t.claim(a, ready)).claimed === true);
  requireEvidence((await t.finish(a, ready, analysisUsage)).stored === true);
  requireEvidence((await t.claim(b, usageOnly)).claimed === true);
  requireEvidence((await t.finish(b, usageOnly, analysisUsage, 'USAGE_ONLY')).code === 'TERMINAL');
  const before = await t.digest();
  requireEvidence(before.usage.length >= 3 && before.requests.length >= 2);
  return { ...snapshot, before, saved, inflight, ready, usageOnly };
}

// Target stage: the new migration applied alone; compare read-only first, then probe.
export async function analysisModelVerify(seed, sql, mark = () => {}) {
  const t = tools(seed, sql), { client, a, b } = t;
  mark('compare');
  equal(await t.digest(), seed.before);
  mark('continuation');
  equal((await analysisStatus(client, a, seed.ready)).status, 'ready');
  equal((await t.ledger(b, seed.usageOnly)).usage.charge_state, 'estimated');

  mark('legacy-envelope');
  for (const header of [null, '1', '3', '']) equal(Object.keys(await t.status(a, header)).sort(), LEGACY_KEYS);
  const notice = await t.noticeUntil(a);
  equal(Object.keys(notice).sort(), [...LEGACY_KEYS, 'photoModelNoticeUntilMs'].sort());
  equal(notice.photoModelNoticeUntilMs, null);

  mark('missing-model');
  const missing = await t.finish(a, seed.inflight, withModel('response_missing_model'));
  equal([missing.code, missing.stored], ['FAILED', false]);
  let row = await t.ledger(a, seed.inflight);
  equal([row.usage.charge_state, Number(row.usage.accounted_micro), row.usage.closed_reason], ['estimated', ESTIMATE, 'FAILED']);
  equal([row.evidence.model_observation, row.evidence.anomaly, row.evidence.estimated_micro], ['response_missing_model', false, ESTIMATE]);
  equal(await t.requestRows(a, seed.inflight), 0);
  equal((await t.controls(a)).activated, true);
  equal((await t.noticeUntil(a)).photoModelNoticeUntilMs, null);
  const replay = await t.finish(a, seed.inflight, withModel('response_missing_model'));
  equal([replay.code, replay.stored], ['TERMINAL', false]);
  equal((await t.finish(a, seed.inflight, analysisUsage)).code, 'USAGE_CONFLICT');
  equal(await t.ledger(a, seed.inflight), row);

  mark('missing-model-v1');
  await sql(`update private.ai_controls set execution_manifest_id=${literal(COLOUR_MANIFEST.v1)},prompt_version=1 where owner_id=${literal(a.uid)};`);
  const v1 = randomUUID();
  requireEvidence((await t.claim(a, v1, COLOUR_MANIFEST.v1)).claimed === true);
  const v1Result = await t.finish(a, v1, withModel('response_missing_model'), 'SUCCESS', COLOUR_MANIFEST.v1);
  equal([v1Result.code, v1Result.stored], ['FAILED', false]);
  equal((await t.controls(a)).activated, true);
  await t.activate(a);

  mark('unrecognised-model');
  const first = randomUUID();
  requireEvidence((await t.claim(a, first)).claimed === true);
  const unrecognised = await t.finish(a, first, withModel('response_unrecognised_model'));
  equal([unrecognised.code, unrecognised.stored], ['FAILED', false]);
  row = await t.ledger(a, first);
  equal([row.usage.charge_state, Number(row.usage.accounted_micro)], ['estimated', ESTIMATE]);
  equal([row.evidence.model_observation, row.evidence.anomaly], ['response_unrecognised_model', false]);
  equal(await t.requestRows(a, first), 0);
  equal((await t.controls(a)).activated, true);
  const firstNotice = await t.noticeUntil(a);
  const firstUntil = firstNotice.photoModelNoticeUntilMs;
  requireEvidence(Number.isSafeInteger(firstUntil) && firstUntil - firstNotice.serverTimeMs > 6 * DAY_MS && firstUntil - firstNotice.serverTimeMs <= 7 * DAY_MS);
  equal(Number(await sql(`select floor(extract(epoch from coalesce(u.dispatched_at,u.created_at)+interval '7 days')*1000)
    from private.ai_usage u where owner_id=${literal(a.uid)} and request_id=${literal(first)};`)), firstUntil);

  mark('other-account');
  equal((await t.noticeUntil(b)).photoModelNoticeUntilMs, null);
  equal((await t.controls(b)).activated, true);
  equal(Object.keys(await t.status(b, null)).sort(), LEGACY_KEYS);

  mark('notice-window');
  // A metering-only reply counts from its own dispatch; later close, expiry and replay never move the deadline.
  const metered = randomUUID();
  requireEvidence((await t.claim(a, metered)).claimed === true);
  equal((await t.finish(a, metered, withModel('response_unrecognised_model'), 'USAGE_ONLY')).code, 'TERMINAL');
  const meteredUntil = (await t.noticeUntil(a)).photoModelNoticeUntilMs;
  requireEvidence(meteredUntil >= firstUntil);
  equal((await t.finish(a, metered, withModel('response_unrecognised_model'), 'USAGE_ONLY')).code, 'TERMINAL');
  await sql(`select pg_sleep(0.05); select private.ai_close(${literal(a.uid)},${literal(metered)},'EXPIRED',clock_timestamp());`);
  await sql(`select private.ai_expire(${literal(a.uid)},clock_timestamp()+interval '2 hours',100);`);
  requireEvidence((await t.ledger(a, metered)).usage.closed_at !== null);
  equal((await t.noticeUntil(a)).photoModelNoticeUntilMs, meteredUntil);
  equal((await t.finish(a, metered, withModel('response_unrecognised_model'), 'USAGE_ONLY')).stored, false);
  equal((await t.noticeUntil(a)).photoModelNoticeUntilMs, meteredUntil);

  mark('invalid-counters');
  const invalid = randomUUID();
  requireEvidence((await t.claim(a, invalid)).claimed === true);
  const bad = await t.finish(a, invalid, withModel('response_missing_model', { total: 1 }));
  equal([bad.code, bad.stored], ['INVALID_USAGE', false]);
  equal((await t.controls(a)).activated, true);

  mark('genuine-shutdowns');
  const { input } = await t.envelope();
  for (const [model, extra] of [
    ['response_missing_model', { controlObservation: 'cache_read' }], ['response_unrecognised_model', { controlObservation: 'contradictory' }],
    ['response_missing_model', { cacheRead: 5 }],
    ['response_unrecognised_model', { input: input + 1, total: input + 31 }], ['response_missing_model', { input: input + 1, total: input + 31 }],
    ['expected_snapshot', { controlObservation: 'cache_write' }],
  ]) {
    const id = randomUUID();
    requireEvidence((await t.claim(a, id)).claimed === true);
    const result = await t.finish(a, id, withModel(model, extra));
    equal([result.code, result.stored], ['USAGE_ANOMALY', false]);
    equal((await t.controls(a)).activated, false);
    equal((await t.controls(b)).activated, true);
    await t.activate(a);
  }

  mark('restore');
  for (const [index, owner] of [a, b].entries()) await t.restoreControls(owner, seed.saved[index]);
}
