// TRYON-LIMITS1: six garments per try-on, results kept until the owner deletes them, the v2 manifest and notice revision 3,
// against the real schema. Invoked only by the CI-only preservation owner, after the AVAIL1 checks ran unchanged at their own exact
// inventory (20261101080000). tryon_claim, tryon_dispatch and tryon_finish are service functions, called through privileged SQL the
// way the Edge handler calls them; every owner read, Stop, withdrawal and isolation assertion uses the ordinary A/B sessions.
// Capacity, controls and consent are opened only inside these probes and restored in finally. No provider calls.
//   limitsUpgradeSeed / limitsUpgradeVerify: populated cutover. At the prior inventory both owners are configured at the v1 manifest
//     and notice 2 with consent at 2 and a saved reference photo, and results are written directly (one past its old 7-day mark that
//     the purge has not removed). After the migration every result is byte-for-byte present, the owners moved to v2 and notice 3
//     with consent left at 2, the saved photo was removed by the existing guard, and consenting to 3 allows a new photo.
//   tryonLimitsProbes: the new contract at the full inventory.
import { createHash, randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { isDeepStrictEqual } from 'node:util';
import { intent, saveHarness } from './item-save.sessions.mjs';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures.ts';

// The harness prints only the stage on failure; this prints the failing line with expected and actual (fictional data only, bounded).
function equal(actual, expected, label = '') {
  if (isDeepStrictEqual(actual, expected)) return;
  const at = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/^at /, '').split(/[\\\\/]/).pop() ?? '';
  const text = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v))?.slice(0, 600);
  console.log(`LIMITS1-MISMATCH ${label} (${at}) expected ${text(expected)} actual ${text(actual)}`);
  requireEvidence(false);
}
const V1 = 'azure-global-image25-sunburst-tryon-v1';
const V2 = 'azure-global-image25-sunburst-tryon-v2';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const RESERVED = 360000;
const RESULTS_HEADER = { 'X-Stillroom-TryOn-Results-Contract': '2' };
const SLOTS = ['top', 'bottom', 'layer', 'outerwear', 'footwear', 'accessory'];
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const orNull = (value, cast) => (value === null ? `null::${cast}` : `${literal(value)}::${cast}`);
const uuids = (ids) => (ids === null ? 'null::uuid[]' : `array[${ids.map((id) => `${literal(id)}::uuid`).join(',')}]::uuid[]`);
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', input: 9000, output: 6000, total: 15000, inputText: 200,
  inputImage: 8800 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const output = (label) => {
  const bytes = Buffer.from(`synthetic limits try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: sha(bytes) };
};
const PHOTO = flatJpeg({ width: 1024, height: 1280 });
const heldReply = (out) => JSON.parse(out.split('\n').map((line) => line.trim()).find((line) => line.startsWith('R:')).slice(2));

function helpers(snapshot, sql) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = (owner, name, body) => client.rpc(owner, name, body);
  const rpcWith = async (owner, name, body, headers) => {
    const reply = await client.request(owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body, headers });
    requireEvidence(reply.ok);
    return reply.data;
  };
  const freeSlots = () => sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
    where deployment_key=${literal(KEY)} and held_until>clock_timestamp();`);
  const claim = async (owner, chain, step, id, { outfit = null, items = null, person = null } = {}) => {
    await freeSlots();
    return one(`select public.tryon_claim(${literal(owner.uid)},${literal(chain)},${step},${literal(id)},${literal(V2)},
      ${orNull(outfit, 'uuid')},${orNull(person, 'text')},null::uuid,${uuids(items)});`);
  };
  const dispatch = (owner, id) => one(`select public.tryon_dispatch(${literal(owner.uid)},${literal(id)},true);`);
  const finish = (owner, id, code, { usage = VALID, out = null, send = false, fetched = true } = {}) => one(`select public.tryon_finish(
    ${literal(owner.uid)},${literal(id)},${literal(code)},${usage === null ? 'null::jsonb' : json(usage)},
    ${orNull(out?.sha ?? null, 'text')},${out === null ? 'null::integer' : out.bytes.length},
    ${send ? `decode(${literal(out.bytes.toString('hex'))},'hex')` : 'null::bytea'},${fetched},${fetched ? 'true' : 'null::boolean'},false);`);
  const release = (owner, id) => finish(owner, id, 'PRE_DISPATCH', { usage: null, fetched: false });
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const resultCount = (owner) => scalar(`select count(*) from private.tryon_results where owner_id=${literal(owner.uid)};`).then(Number);
  const chainState = (owner, chain) => scalar(`select coalesce((select state from private.tryon_chains
    where owner_id=${literal(owner.uid)} and chain_id=${literal(chain)}),'none');`);
  const photoRows = () => scalar(`select count(*) from private.tryon_person_photos where owner_id in (${literal(a.uid)},${literal(b.uid)});`).then(Number);
  const putPhoto = (owner, bytes = PHOTO) => rpc(owner, 'tryon_person_photo_put_v1', { p_jpeg_base64: b64(bytes), p_sha256: sha(bytes) });
  // Results written directly: `days` old, kept or purgeable by the schema in force. `ago` is a SQL interval.
  const insertReady = (owner, { count = 1, ago = '400 days', outfit = null, items = 1 } = {}) => sql(`with t as (select clock_timestamp()-interval '${ago}' c)
    insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,jpeg,created_at,completed_at)
    select ${literal(owner.uid)},gen_random_uuid(),gen_random_uuid(),${orNull(outfit, 'uuid')},'ready',
      array(select gen_random_uuid() from generate_series(1,${items})),decode('ffd8ffd9','hex'),t.c,t.c from generate_series(1,${count}),t;`);
  const runStep = async (owner, chain, n, { outfit = null, items = null, person = null, last = false } = {}) => {
    const id = randomUUID();
    const claimed = await claim(owner, chain, n, id, { outfit: n === 1 ? outfit : null, items: n === 1 ? items : null, person });
    requireEvidence(claimed.code === 'OK' && claimed.last === last);
    equal((await dispatch(owner, id)).code, 'AUTHORISED');
    const out = output(`${n}`);
    const done = await finish(owner, id, 'OK', { out, send: last });
    requireEvidence(done.code === 'OK' && done.last === last);
    return { id, out, done, claimed };
  };
  const chains = [];
  const fresh = () => { const id = randomUUID(); chains.push(id); return id; };
  const sh = saveHarness(client, a), shB = saveHarness(client, b);
  const garment = async (harness, category) => {
    const value = harness.track(intent());
    value.p_item.category = category;
    value.p_item.title = `Fictional limits ${category}`;
    const row = await harness.reserve(value);
    await harness.upload(value);
    await harness.finalize(value, row);
    return value.p_item.id;
  };
  const outfits = [];
  const saveOutfit = async (owner, ids, title) => {
    const id = randomUUID();
    await rpc(owner, 'save_outfit', { p_id: id, p_title: title, p_occasion: 'everyday', p_notes: '', p_favourite: false,
      p_item_ids: ids, p_expected_version: null });
    outfits.push([owner, id]);
    return id;
  };
  // Both owners configured, activated and consenting at `notice`; `restore` puts every touched control back.
  const configure = async (manifest, notice) => {
    const before = { a: await controls(a), b: await controls(b),
      capacity: await one(`select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(KEY)};`) };
    requireEvidence(before.a.tryon_activated === false && before.b.tryon_activated === false);
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    for (const owner of [a, b]) {
      equal((await one(`select public.tryon_bootstrap(${literal(owner.uid)},${literal(manifest)},${notice},${RESERVED},5000000,1000);`)).code, 'OK');
    }
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});
      update private.provider_capacity set dispatch_enabled=true,disabled_reason=null,disabled_at=null,updated_at=clock_timestamp()
      where deployment_key=${literal(KEY)};`);
    for (const owner of [a, b]) equal((await rpc(owner, 'tryon_set_consent', { p_enabled: true, p_notice_revision: notice })).code, 'OK');
    return before;
  };
  const restore = async (before) => {
    await sql(`delete from private.tryon_results where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chains where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_person_photos where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_probe_authorisations where approval_ref like '#limits-test/%';
      delete from private.tryon_chain_stops where owner_id in (${literal(a.uid)},${literal(b.uid)})
        and chain_id in (${chains.length ? chains.map((id) => `${literal(id)}::uuid`).join(',') : 'null::uuid'});`);
    for (const [owner, id] of outfits) {
      await sql(`delete from public.outfit_items where owner_id=${literal(owner.uid)} and outfit_id=${literal(id)};
        delete from public.outfits where owner_id=${literal(owner.uid)} and id=${literal(id)};`);
    }
    await sh.cleanup();
    await shB.cleanup();
    const c = before.capacity;
    await sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second' where deployment_key=${literal(KEY)};
      update private.provider_capacity set dispatch_enabled=${c.dispatch_enabled},disabled_reason=${orNull(c.disabled_reason, 'text')},
        disabled_at=${orNull(c.disabled_at, 'timestamptz')},updated_at=clock_timestamp() where deployment_key=${literal(KEY)};`);
    for (const [owner, was] of [[a, before.a], [b, before.b]]) {
      await sql(`update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${was.monthly_allowance_micro},updated_at=clock_timestamp()
        where owner_id=${literal(owner.uid)};`);
    }
    equal(Number(await scalar(`select count(*) from private.ai_usage where purpose='try_on' and charge_state='held';`)), 0);
  };
  return { a, b, client, one, scalar, rpc, rpcWith, freeSlots, claim, dispatch, finish, release, controls, resultCount, chainState,
    photoRows, putPhoto, insertReady, runStep, fresh, sh, shB, garment, saveOutfit, configure, restore };
}

const STORED = (ids) => `select coalesce(jsonb_object_agg(result_id,jsonb_build_object('owner',owner_id,'sha',encode(sha256(jpeg),'hex'),
  'bytes',octet_length(jpeg),'chain',chain_id,'items',item_ids,'state',state,'created',extract(epoch from created_at)::text,
  'completed',extract(epoch from completed_at)::text)),'{}'::jsonb) from private.tryon_results where result_id in (${ids.map(literal).join(',')});`;
const without = (c, keys) => Object.fromEntries(Object.entries(c).filter(([key]) => !keys.includes(key)));

export async function limitsUpgradeSeed(snapshot, sql) {
  const h = helpers(snapshot, sql);
  const { a, b } = h;
  // The prior inventory: no v2 manifest, and the results still carry their expiry.
  equal(await h.one(`select jsonb_build_array(not exists(select 1 from private.ai_execution_manifests where id=${literal(V2)}),
    exists(select 1 from pg_attribute where attrelid='private.tryon_results'::regclass and attname='expires_at' and not attisdropped));`), [true, true]);
  const manifestV1 = await h.one(`select to_jsonb(m) from private.ai_execution_manifests m where id=${literal(V1)};`);
  const before = await h.configure(V1, 2);
  try {
    for (const owner of [a, b]) equal((await h.putPhoto(owner)).code, 'OK');
    requireEvidence(await h.photoRows() === 2);
    // Fresh, past its old 7-day mark (the purge has not removed it yet), and another owner's.
    const ids = {};
    for (const [label, owner, days] of [['fresh', a, 0], ['pastExpiry', a, 8], ['other', b, 1]]) {
      ids[label] = randomUUID();
      await sql(`with t as (select clock_timestamp()-interval '${days} days' c)
        insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,jpeg,created_at,completed_at,expires_at)
        select ${literal(owner.uid)},${literal(ids[label])},gen_random_uuid(),null,'ready',array[gen_random_uuid()],
          decode(${literal(Buffer.from(`seeded ${label} ${randomUUID()}`).toString('hex'))},'hex'),t.c-interval '1 minute',t.c,t.c+interval '7 days' from t;`);
    }
    const stored = await h.one(STORED(Object.values(ids)));
    requireEvidence(Object.keys(stored).length === 3);
    // The old reads already hide the past-expiry row; it is still stored.
    const listed = await h.rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER);
    equal(listed.results.map((row) => row.id), [ids.fresh]);
    const seeded = { a: await h.controls(a), b: await h.controls(b) };
    for (const c of [seeded.a, seeded.b]) {
      requireEvidence(c.tryon_activated === true && c.tryon_manifest_id === V1 && c.tryon_notice_revision === 2
        && c.tryon_consent_revision === 2 && c.tryon_consented_at !== null);
    }
    return { h, before, manifestV1, ids, stored, seeded };
  } catch (error) {
    await h.restore(before).catch(() => {});
    throw error;
  }
}

export async function limitsUpgradeVerify(seed, mark = () => {}) {
  const { h, before, manifestV1, ids, stored, seeded } = seed;
  const { a, b } = h;
  try {
    mark('structure');
    equal(await h.one(`select jsonb_build_array(
      not exists(select 1 from pg_attribute where attrelid='private.tryon_results'::regclass and attname='expires_at' and not attisdropped),
      (select prompt_version from private.ai_execution_manifests where id=${literal(V2)}),
      (select model_id from private.ai_execution_manifests where id=${literal(V2)})=(select model_id from private.ai_execution_manifests where id=${literal(V1)}),
      (select count(distinct deployment_key) from private.provider_deployments where manifest_id in (${literal(V1)},${literal(V2)})),
      (select count(*) from private.ai_execution_manifests where id like 'azure-global-image25-sunburst-tryon-%'));`), [true, 2, true, 1, 2]);
    // The v1 row is exactly what it was.
    equal(await h.one(`select to_jsonb(m) from private.ai_execution_manifests m where id=${literal(V1)};`), manifestV1);

    mark('results-kept');
    // Nothing was deleted, including the row that was already past its old 7-day mark: every row is byte for byte as seeded.
    equal(await h.one(STORED(Object.values(ids))), stored);

    mark('controls');
    for (const [owner, was] of [[a, seeded.a], [b, seeded.b]]) {
      const now = await h.controls(owner);
      requireEvidence(now.tryon_manifest_id === V2 && now.tryon_notice_revision === 3);
      // Consent was never written: it is still 2 and now mismatches. Everything else is as seeded.
      requireEvidence(now.tryon_consent_revision === 2 && now.tryon_consented_at === was.tryon_consented_at && now.tryon_activated === true);
      equal(without(now, ['updated_at', 'tryon_manifest_id', 'tryon_notice_revision']), without(was, ['updated_at', 'tryon_manifest_id', 'tryon_notice_revision']));
    }
    const status = await h.rpc(a, 'tryon_status', {});
    requireEvidence(status.code === 'CONSENT_REQUIRED' && status.results === 2);
    equal(Object.keys(status.policy).sort(), ['activated', 'manifestId', 'maxRequestMicro', 'maxResults', 'maxSteps', 'modelId',
      'noticeRevision', 'providerAvailable']);
    requireEvidence(status.policy.manifestId === V2 && status.policy.noticeRevision === 3 && status.policy.maxSteps === 6 && status.policy.maxResults === 200);

    mark('owner-reads');
    const listed = await h.rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER);
    equal(listed.results.map((row) => row.id).sort(), [ids.fresh, ids.pastExpiry].sort());
    for (const row of listed.results) equal(Object.keys(row).sort(), ['bytes', 'completedAtMs', 'id', 'itemIds', 'outfitId']);
    const old = await h.rpcWith(a, 'tryon_result_image_v1', { p_result_id: ids.pastExpiry }, RESULTS_HEADER);
    requireEvidence(old.code === 'OK' && old.bytes === stored[ids.pastExpiry].bytes);
    equal((await h.rpcWith(b, 'tryon_results_v1', {}, RESULTS_HEADER)).results.map((row) => row.id), [ids.other]);
    equal((await h.rpcWith(a, 'tryon_result_image_v1', { p_result_id: ids.other }, RESULTS_HEADER)).code, 'NOT_FOUND');

    mark('maintenance');
    // The scheduled job no longer deletes by age: the old row and the others stay.
    const due = await h.one('select public.tryon_expire_due(500);');
    requireEvidence(due.code === 'OK' && !Object.hasOwn(due, 'resultsPurged'));
    equal(await h.one(STORED(Object.values(ids))), stored);

    mark('saved-photo');
    // The existing guard removed each saved photo when the notice moved; a new one needs consent to the new revision.
    equal(await h.photoRows(), 0);
    equal((await h.putPhoto(a)).code, 'CONSENT_REQUIRED');
    equal((await h.rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).code, 'CONFIG_CHANGED');
    equal((await h.rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 3 })).consent.noticeRevision, 3);
    equal((await h.putPhoto(a)).code, 'OK');
    equal(await h.photoRows(), 1);
    equal((await h.rpc(b, 'tryon_person_photo_status_v1', {})), { code: 'OK', saved: false });
  } finally {
    await h.restore(before);
  }
}

export async function tryonLimitsProbes(snapshot, sql, mark) {
  const h = helpers(snapshot, sql);
  const { a, b, one, scalar, rpc, rpcWith, claim, release, runStep, fresh, resultCount, chainState, insertReady } = h;
  const before = await h.configure(V2, 3);
  try {
    mark('structure');
    equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
        not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),has_function_privilege('anon',p.oid,'EXECUTE'),
        has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE')))
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('tryon_claim','tryon_finish','tryon_probe_authorise',
        'tryon_purge_health','tryon_status','tryon_chain_status','tryon_cancel','tryon_results_v1','tryon_result_image_v1',
        'tryon_expire_due','tryon_bootstrap','tryon_person_photo_put_v1');`), {
      tryon_claim: [true, true, false, false, true], tryon_finish: [true, true, false, false, true],
      tryon_probe_authorise: [true, true, false, false, true], tryon_purge_health: [true, true, false, false, true],
      tryon_status: [true, true, false, true, false], tryon_chain_status: [true, true, false, true, false],
      tryon_cancel: [true, true, false, true, false], tryon_results_v1: [true, true, false, true, false],
      tryon_result_image_v1: [true, true, false, true, false], tryon_expire_due: [true, true, false, false, false],
      tryon_bootstrap: [true, true, false, false, false], tryon_person_photo_put_v1: [true, true, false, true, false],
    });
    const defs = await one(`select jsonb_object_agg(conname,pg_get_constraintdef(oid)) from pg_constraint where conname in
      ('tryon_chains_steps_count','tryon_chains_next_step','tryon_attempts_step_range','ai_usage_tryon_step_range',
       'tryon_results_item_count','tryon_probe_authorisations_calls');`);
    for (const [name, bound] of [['tryon_chains_steps_count', 6], ['tryon_chains_next_step', 7], ['tryon_attempts_step_range', 6],
      ['ai_usage_tryon_step_range', 6], ['tryon_results_item_count', 6], ['tryon_probe_authorisations_calls', 6]]) {
      requireEvidence(new RegExp(`<= ${bound}\\)`).test(defs[name] ?? ''));
    }

    mark('status');
    const status = await rpc(a, 'tryon_status', {});
    requireEvidence(status.code === 'OK' && status.policy.maxSteps === 6 && status.policy.maxResults === 200
      && status.policy.manifestId === V2 && status.policy.noticeRevision === 3 && !Object.hasOwn(status.policy, 'resultDays'));

    mark('garments');
    const g = {};
    for (const category of ['top', 'bottom', 'layer', 'outerwear', 'footwear', 'accessory']) g[category] = await h.garment(h.sh, category);
    const spare = await h.garment(h.sh, 'accessory'), onePiece = await h.garment(h.sh, 'one_piece');
    const full = await h.saveOutfit(a, [spare, g.accessory, g.outerwear, g.footwear, g.layer, g.bottom, g.top], 'Fictional six-step outfit');
    const dress = await h.saveOutfit(a, [g.top, g.bottom, g.layer, onePiece, g.footwear], 'Fictional one-piece outfit');

    mark('six-step-chain');
    const chain = fresh();
    let person = null, last = null;
    const slots = [];
    for (let step = 1; step <= 6; step += 1) {
      const ran = await runStep(a, chain, step, { outfit: full, person, last: step === 6 });
      requireEvidence(ran.claimed.steps === 6 && ran.claimed.garment.path.startsWith(`${a.uid}/`));
      slots.push(ran.claimed.slot);
      person = ran.out.sha;
      last = ran;
    }
    // One garment per slot in the fixed order; the first accessory in the saved order, the second is not used.
    equal(slots, SLOTS);
    const stored = await one(`select jsonb_build_object('items',(select item_ids from private.tryon_results where owner_id=${literal(a.uid)}
      and result_id=${literal(last.done.resultId)}),'steps',(select steps from private.tryon_chains where owner_id=${literal(a.uid)}
      and chain_id=${literal(chain)}));`);
    equal(stored.items, [g.top, g.bottom, g.layer, g.outerwear, g.footwear, spare]);
    equal(stored.steps.map((step) => step.slot), SLOTS);
    const status6 = await rpc(a, 'tryon_chain_status', { p_chain_id: chain });
    requireEvidence(status6.state === 'complete' && status6.nextStep === 7 && status6.steps.length === 6 && status6.resultId === last.done.resultId);
    const listed = await rpc(a, 'tryon_results_v1', {});
    requireEvidence(listed.results.some((row) => row.id === last.done.resultId && row.itemIds.length === 6 && row.outfitId === full));
    // A seventh step does not exist, for a new chain or a finished one.
    equal(await claim(a, fresh(), 7, randomUUID(), { outfit: full }), { code: 'INVALID_INPUT', claimed: false });
    equal((await claim(a, chain, 7, randomUUID(), { person })).code, 'INVALID_INPUT');

    mark('other-chains');
    // A one-piece keeps layer and shoes after it and drops top and bottom; an idea picks the first garment of each slot in its order.
    const dressChain = fresh(), dressId = randomUUID(), dressClaim = await claim(a, dressChain, 1, dressId, { outfit: dress });
    requireEvidence(dressClaim.code === 'OK' && dressClaim.steps === 3 && dressClaim.slot === 'one_piece');
    await release(a, dressId);
    equal((await rpc(a, 'tryon_cancel', { p_chain_id: dressChain })).code, 'CANCELLED');
    const ideaChain = fresh(), ideaId = randomUUID();
    const ideaClaim = await claim(a, ideaChain, 1, ideaId, { items: [spare, g.accessory, g.outerwear, g.top, g.layer, g.bottom, g.footwear] });
    requireEvidence(ideaClaim.code === 'OK' && ideaClaim.steps === 6 && ideaClaim.slot === 'top');
    equal((await one(`select steps from private.tryon_chains where owner_id=${literal(a.uid)} and chain_id=${literal(ideaChain)};`))
      .map((step) => step.itemId), [g.top, g.bottom, g.layer, g.outerwear, g.footwear, spare]);
    await release(a, ideaId);
    equal((await rpc(a, 'tryon_cancel', { p_chain_id: ideaChain })).code, 'CANCELLED');

    mark('result-cap');
    // 200 stored or reserved results per owner. 199 stored plus the chain's own reserved slot is the 200th; one more is refused.
    await sql(`delete from private.tryon_results where owner_id=${literal(a.uid)};`);
    await insertReady(a, { count: 199 });
    const capId = randomUUID(), capChain = fresh();
    equal((await claim(a, capChain, 1, capId, { items: [g.top] })).code, 'OK');
    equal(await resultCount(a), 200);
    await release(a, capId);
    equal((await rpc(a, 'tryon_cancel', { p_chain_id: capChain })).code, 'CANCELLED');
    equal(await resultCount(a), 199);
    await insertReady(a, { count: 1 });
    equal(await claim(a, fresh(), 1, randomUUID(), { items: [g.top] }), { code: 'RESULTS_FULL', claimed: false });
    equal(await resultCount(b), 0);
    // The cap is per owner: the other owner still claims.
    const peerId = randomUUID(), peerChain = fresh();
    equal((await claim(b, peerChain, 1, peerId, { items: [await h.garment(h.shB, 'top')] })).code, 'OK');
    await release(b, peerId);
    equal((await rpc(b, 'tryon_cancel', { p_chain_id: peerChain })).code, 'CANCELLED');

    mark('largest-list');
    // 200 results of six items each, the longest list the server can send, stay under the client's bounded allowance.
    await sql(`delete from private.tryon_results where owner_id=${literal(a.uid)};`);
    await insertReady(a, { count: 200, ago: '1 hour', outfit: full, items: 6 });
    const all = await rpc(a, 'tryon_results_v1', {});
    equal(all.results.length, 200);
    const size = heldReply(await sql(`begin; set local role authenticated;
      select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: a.uid, role: 'authenticated' }))},true);
      select 'R:'||length(public.tryon_results_v1()::text); commit;`));
    requireEvidence(size > 60_000 && size < 131_072);
    await sql(`delete from private.tryon_results where owner_id=${literal(a.uid)};`);

    mark('kept-until-deleted');
    // A result a year old stays: the maintenance job and the new-chain safeguard ignore age; an orphaned reserved slot is purged.
    await insertReady(a, { count: 1, ago: '400 days' });
    const [old] = await one(`select coalesce(jsonb_agg(result_id),'[]'::jsonb) from private.tryon_results where owner_id=${literal(a.uid)};`);
    const orphan = randomUUID();
    await sql(`insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,created_at)
      values(${literal(a.uid)},${literal(orphan)},gen_random_uuid(),null,'reserved',array[gen_random_uuid()],clock_timestamp()-interval '2 hours');`);
    const due = await one('select public.tryon_expire_due(500);');
    requireEvidence(due.code === 'OK' && due.slotsPurged >= 1 && !Object.hasOwn(due, 'resultsPurged'));
    equal(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)} and result_id=${literal(old)};`), '1');
    equal(await scalar(`select count(*) from private.tryon_results where result_id=${literal(orphan)};`), '0');
    const health = await one('select public.tryon_purge_health();');
    equal(Object.keys(health).sort(), ['code', 'heldUsage', 'overdueChains', 'safeguard']);
    requireEvidence(health.code === 'OK' && health.safeguard === false);
    const image = await rpcWith(a, 'tryon_result_image_v1', { p_result_id: old }, RESULTS_HEADER);
    requireEvidence(image.code === 'OK');
    // The new-chain safeguard ignores result age too: a chain still starts.
    const ageId = randomUUID(), ageChain = fresh();
    equal((await claim(a, ageChain, 1, ageId, { items: [g.top] })).code, 'OK');
    await release(a, ageId);
    equal((await rpc(a, 'tryon_cancel', { p_chain_id: ageChain })).code, 'CANCELLED');
    equal((await rpc(a, 'tryon_delete_result', { p_result_id: old })), { code: 'OK' });
    equal(await scalar(`select count(*) from private.tryon_results where result_id=${literal(old)};`), '0');
    equal((await rpc(a, 'tryon_delete_result', { p_result_id: old })), { code: 'NOT_FOUND' });

    mark('withdrawal-and-stop');
    // Withdrawal ends a running chain and keeps every stored result; Stop ends one and frees its reserved slot.
    await insertReady(a, { count: 2, ago: '3 days' });
    const kept = await resultCount(a);
    const running = fresh(), runId = randomUUID();
    equal((await claim(a, running, 1, runId, { items: [g.top, g.bottom] })).code, 'OK');
    await release(a, runId);
    requireEvidence((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).consent.enabled === false);
    equal(await chainState(a, running), 'withdrawn');
    equal(await resultCount(a), kept);
    equal((await rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER)).results.length, kept);
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).code, 'CONFIG_CHANGED');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 3 })).consent.noticeRevision, 3);
    const stopped = fresh(), stopId = randomUUID();
    equal((await claim(a, stopped, 1, stopId, { items: [g.top] })).code, 'OK');
    await release(a, stopId);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: stopped }), { code: 'CANCELLED' });
    equal(await resultCount(a), kept);

    mark('reference-photo');
    // The saved photo needs the configured notice at revision 2 or later and consent equal to it.
    const setRevisions = (notice, consent) => sql(`update private.ai_controls set tryon_notice_revision=${notice},
      tryon_consent_revision=${consent},tryon_consented_at=clock_timestamp(),updated_at=clock_timestamp() where owner_id=${literal(a.uid)};`);
    await setRevisions(3, 3);
    equal((await h.putPhoto(a)).code, 'OK');
    equal(await h.photoRows(), 1);
    await setRevisions(3, 2);
    equal(await h.photoRows(), 0);
    equal((await h.putPhoto(a)).code, 'CONSENT_REQUIRED');
    await setRevisions(2, 2);
    equal((await h.putPhoto(a)).code, 'OK');
    // Consent equal to a notice that does not state the photo (revision 1) is refused; the saved photo is left as it was.
    await setRevisions(1, 1);
    equal((await h.putPhoto(a, flatJpeg({ width: 1024, height: 1280, colour: [20, 90, 200] }))).code, 'CONSENT_REQUIRED');
    await setRevisions(3, 3);

    mark('probe-calls');
    // A probe may cover a full six-garment chain; seven is refused before anything else is looked at.
    const authorise = (calls) => one(`select public.tryon_probe_authorise(${literal(randomUUID())},${literal(a.uid)},${literal(V2)},${calls},
      ${RESERVED * 6},${literal(`#limits-test/${randomUUID()}`)},clock_timestamp()+interval '1 day');`);
    equal((await authorise(7)).code, 'INVALID_INPUT');
    requireEvidence((await authorise(6)).code !== 'INVALID_INPUT');
    // The v1 manifest is no longer accepted for new configuration or claims.
    equal(await one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(V1)},3,${RESERVED},5000000,1000);`), { code: 'UNCONFIGURED' });
    const oldManifest = randomUUID();
    equal(await one(`select public.tryon_claim(${literal(a.uid)},${literal(fresh())},1,${literal(oldManifest)},${literal(V1)},null::uuid,
      null::text,null::uuid,${uuids([g.top])});`), { code: 'UNCONFIGURED', claimed: false });
    equal(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)} and request_id=${literal(oldManifest)};`), '0');
  } finally {
    await h.restore(before);
  }
}
