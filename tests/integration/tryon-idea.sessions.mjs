// TRYON-IDEA1: try on an unsaved Today idea against the real schema. Invoked only by the CI-only preservation owner, after the
// frozen checks ran at the exact prior inventory (20261010090000). tryon_claim, tryon_dispatch and tryon_finish are service
// functions, called through privileged SQL the way the Edge handler calls them; every owner read, cancel, delete and isolation
// assertion uses the ordinary A/B sessions. Capacity, controls and consent are opened only inside these probes and restored in
// finally. Garments are the owners' own fictional items. No provider calls.
//   ideaUpgradeSeed / ideaUpgradeVerify: populated cutover. At the prior inventory real outfit chains, a result and their
//     ledger rows are written by the old claim/dispatch/finish; after the migration they are unchanged, an old-shaped
//     continuation still works, and nothing about them needed the new argument or header.
//   tryonIdeaProbes: the new contract at the full inventory.
import { createHash, randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';
import { intent, saveHarness } from './item-save.sessions.mjs';
import { serviceRpcOf } from './tryon.sessions.mjs';
import { selectTryOnSteps } from '../../src/domain/tryon.ts';

const MANIFEST = 'azure-global-image25-sunburst-tryon-v1';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const RESERVED = 360000;
const RESULTS_HEADER = { 'X-Stillroom-TryOn-Results-Contract': '2' };
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const orNull = (value, cast) => (value === null ? `null::${cast}` : `${literal(value)}::${cast}`);
const uuids = (ids) => (ids === null ? 'null::uuid[]' : `array[${ids.map((id) => `${literal(id)}::uuid`).join(',')}]::uuid[]`);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', input: 9000, output: 6000, total: 15000, inputText: 200,
  inputImage: 8800 });
const output = (label) => {
  const bytes = Buffer.from(`synthetic idea try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
};

function helpers(snapshot, sql) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = (owner, name, body) => client.rpc(owner, name, body);
  // The same call with extra request headers (the results-contract header of a client that parses results without an outfit).
  const rpcWith = async (owner, name, body, headers) => {
    const reply = await client.request(owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body, headers });
    requireEvidence(reply.ok);
    return reply.data;
  };
  const freeSlots = () => sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
    where deployment_key=${literal(KEY)} and held_until>clock_timestamp();`);
  const claimCall = (owner, chain, step, id, { outfit = null, items = null, person = null, legacy = false } = {}) => `public.tryon_claim(
    ${literal(owner.uid)},${literal(chain)},${step},${literal(id)},${literal(MANIFEST)},${orNull(outfit, 'uuid')},
    ${orNull(person, 'text')},null::uuid${legacy ? '' : `,${uuids(items)}`})`;
  const claim = async (owner, chain, step, id, options = {}) => {
    await freeSlots();
    return one(`select ${claimCall(owner, chain, step, id, options)};`);
  };
  const dispatch = (owner, id) => one(`select public.tryon_dispatch(${literal(owner.uid)},${literal(id)},true);`);
  const finish = (owner, id, code, { usage = VALID, out = null, send = false, fetched = true } = {}) => one(`select public.tryon_finish(
    ${literal(owner.uid)},${literal(id)},${literal(code)},${usage === null ? 'null::jsonb' : json(usage)},
    ${orNull(out?.sha ?? null, 'text')},${out === null ? 'null::integer' : out.bytes.length},
    ${send ? `decode(${literal(out.bytes.toString('hex'))},'hex')` : 'null::bytea'},${fetched},${fetched ? 'true' : 'null::boolean'},false);`);
  const release = (owner, id) => finish(owner, id, 'PRE_DISPATCH', { usage: null, fetched: false });
  const rows = (owner) => one(`select jsonb_build_object('usage',(select count(*) from private.ai_usage where owner_id=${literal(owner.uid)}
      and purpose='try_on'),'results',(select count(*) from private.tryon_results where owner_id=${literal(owner.uid)}),
      'chains',(select count(*) from private.tryon_chains where owner_id=${literal(owner.uid)}));`);
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const chainRow = (owner, chain) => one(`select to_jsonb(t)-'steps' from private.tryon_chains t
    where owner_id=${literal(owner.uid)} and chain_id=${literal(chain)};`);
  const live = (owner) => scalar(`select count(*) from private.tryon_results where owner_id=${literal(owner.uid)}
    and (state='reserved' or expires_at>clock_timestamp());`).then(Number);
  // One full step: claim, mark, finish OK. The last step sends the picture. Later steps carry no subject.
  const runStep = async (owner, chain, n, { outfit = null, items = null, person = null, last = false, legacy = false } = {}) => {
    const id = randomUUID();
    const claimed = await claim(owner, chain, n, id, { outfit: n === 1 ? outfit : null, items: n === 1 ? items : null, person, legacy });
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
    value.p_item.title = `Fictional idea ${category}`;
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
  // Try-on opened for both owners and the shared deployment switched on; `close` restores every touched control.
  const open = async () => {
    const before = { a: await controls(a), b: await controls(b) };
    requireEvidence(before.a.tryon_activated === false && before.b.tryon_activated === false);
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    for (const owner of [a, b]) {
      equal((await one(`select public.tryon_bootstrap(${literal(owner.uid)},${literal(MANIFEST)},1,${RESERVED},5000000,1000);`)).code, 'OK');
    }
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    for (const owner of [a, b]) equal((await rpc(owner, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    await sql(`update private.provider_capacity set dispatch_enabled=true,disabled_reason=null,disabled_at=null,
      updated_at=clock_timestamp() where deployment_key=${literal(KEY)};`);
    return before;
  };
  const close = async (before) => {
    await sql(`delete from private.tryon_results where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chains where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chain_stops where owner_id in (${literal(a.uid)},${literal(b.uid)})
        and chain_id in (${chains.length ? chains.map((id) => `${literal(id)}::uuid`).join(',') : 'null::uuid'});`);
    for (const [owner, id] of outfits) {
      await sql(`delete from public.outfit_items where owner_id=${literal(owner.uid)} and outfit_id=${literal(id)};
        delete from public.outfits where owner_id=${literal(owner.uid)} and id=${literal(id)};`);
    }
    await sh.cleanup();
    await shB.cleanup();
    await sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second' where deployment_key=${literal(KEY)};
      update private.provider_capacity set dispatch_enabled=false,disabled_reason='INITIAL',disabled_at=clock_timestamp(),
        updated_at=clock_timestamp() where deployment_key=${literal(KEY)};
      update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${before.a.monthly_allowance_micro},
        updated_at=clock_timestamp() where owner_id=${literal(a.uid)};
      update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${before.b.monthly_allowance_micro},
        updated_at=clock_timestamp() where owner_id=${literal(b.uid)};`);
    equal(Number(await scalar(`select count(*) from private.ai_usage where purpose='try_on' and charge_state='held';`)), 0);
  };
  return { a, b, one, scalar, rpc, rpcWith, claim, claimCall, dispatch, finish, release, rows, controls, chainRow, live,
    runStep, fresh, sh, shB, garment, saveOutfit, open, close, freeSlots };
}

// What a cutover compares: the ledger and evidence rows, the chains without the new column, the attempts, and the result
// without its bytes (a digest of them instead).
const upgradeRows = (owner, chainIds, requestIds, resultIds) => `select jsonb_build_object(
  'usage',(select coalesce(jsonb_object_agg(request_id,to_jsonb(u)),'{}'::jsonb) from private.ai_usage u
    where owner_id=${literal(owner.uid)} and request_id in (${requestIds.map(literal).join(',')})),
  'evidence',(select coalesce(jsonb_object_agg(request_id,to_jsonb(e)),'{}'::jsonb) from private.ai_usage_evidence e
    where owner_id=${literal(owner.uid)} and request_id in (${requestIds.map(literal).join(',')})),
  'chains',(select coalesce(jsonb_object_agg(chain_id,to_jsonb(t)-'idea_item_ids'),'{}'::jsonb) from private.tryon_chains t
    where owner_id=${literal(owner.uid)} and chain_id in (${chainIds.map(literal).join(',')})),
  'attempts',(select coalesce(jsonb_object_agg(request_id,to_jsonb(x)),'{}'::jsonb) from private.tryon_attempts x
    where owner_id=${literal(owner.uid)} and request_id in (${requestIds.map(literal).join(',')})),
  'results',(select coalesce(jsonb_object_agg(result_id,(to_jsonb(r)-'jpeg')||jsonb_build_object('jpegMd5',md5(r.jpeg))),'{}'::jsonb)
    from private.tryon_results r where owner_id=${literal(owner.uid)} and result_id in (${resultIds.map(literal).join(',')})));`;

export async function ideaUpgradeSeed(snapshot, sql) {
  const h = helpers(snapshot, sql);
  // The prior inventory: the eight-argument claim only, outfit required, no idea column.
  equal(await h.one(`select jsonb_build_array(to_regprocedure('public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)') is not null,
    to_regprocedure('public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])') is null,
    exists(select 1 from pg_attribute where attrelid='private.tryon_chains'::regclass and attname='idea_item_ids'),
    (select attnotnull from pg_attribute where attrelid='private.tryon_chains'::regclass and attname='outfit_id'),
    (select attnotnull from pg_attribute where attrelid='private.tryon_results'::regclass and attname='outfit_id'));`),
  [true, true, false, true, true]);
  const before = await h.open();
  try {
    const top = await h.garment(h.sh, 'top'), bottom = await h.garment(h.sh, 'bottom'), shoes = await h.garment(h.sh, 'footwear');
    const full = await h.saveOutfit(h.a, [top, bottom, shoes], 'Fictional cutover outfit');
    const single = await h.saveOutfit(h.a, [top], 'Fictional cutover single');
    // A finished one-step chain with its result, and a running three-step chain waiting for step 2 (old-shaped calls only).
    const done = h.fresh(), finished = await h.runStep(h.a, done, 1, { outfit: single, last: true, legacy: true });
    const running = h.fresh(), first = await h.runStep(h.a, running, 1, { outfit: full, legacy: true });
    const requestIds = [finished.id, first.id], chainIds = [done, running], resultIds = [finished.done.resultId];
    const stored = await h.one(upgradeRows(h.a, chainIds, requestIds, resultIds));
    requireEvidence(Object.keys(stored.usage).length === 2 && Object.keys(stored.results).length === 1
      && stored.chains[running].next_step === 2 && stored.chains[running].outfit_id === full);
    return { h, before, ids: { top, full, single }, done, running, finished, first, requestIds, chainIds, resultIds, stored };
  } catch (error) {
    await h.close(before).catch(() => {});
    throw error;
  }
}

export async function ideaUpgradeVerify(seed, mark = () => {}) {
  const { h, before, ids, done, running, finished, first, requestIds, chainIds, resultIds, stored } = seed;
  const { a, b } = h;
  try {
    mark('structure');
    equal(await h.one(`select jsonb_build_array(
      to_regprocedure('public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid)') is null,
      (select count(*) from pg_proc where proname='tryon_claim' and pronamespace='public'::regnamespace),
      (select pronargdefaults from pg_proc where proname='tryon_claim' and pronamespace='public'::regnamespace),
      (select count(*) from private.tryon_chains where owner_id=${literal(a.uid)} and idea_item_ids is not null));`), [true, 1, 1, 0]);
    mark('preserved');
    // Everything written before the migration is exactly as it was; only the new column exists, and it is null.
    equal(await h.one(upgradeRows(a, chainIds, requestIds, resultIds)), stored);
    mark('owner-reads');
    // The finished outfit result is listed and readable with and without the results header, exactly as before.
    for (const headers of [{}, RESULTS_HEADER]) {
      const listed = await h.rpcWith(a, 'tryon_results_v1', {}, headers);
      requireEvidence(listed.code === 'OK' && listed.results.length === 1 && listed.results[0].id === finished.done.resultId
        && listed.results[0].outfitId === ids.single);
      const image = await h.rpcWith(a, 'tryon_result_image_v1', { p_result_id: finished.done.resultId }, headers);
      requireEvidence(image.code === 'OK' && Buffer.from(image.jpegBase64, 'base64').equals(finished.out.bytes));
    }
    equal((await h.rpc(b, 'tryon_results_v1', {})).results, []);
    mark('continuation');
    // The old-shaped continuation: the running outfit chain goes on with the eight-argument call, then with the new shape and
    // no subject, and its result is an outfit result.
    const second = await h.runStep(a, running, 2, { person: first.out.sha, legacy: true });
    const third = await h.runStep(a, running, 3, { person: second.out.sha, last: true });
    equal(await h.rpc(a, 'tryon_cancel', { p_chain_id: running }), { code: 'COMPLETED', resultId: third.done.resultId });
    const listed = await h.rpcWith(a, 'tryon_results_v1', {}, {});
    equal(listed.results.map((row) => row.outfitId).sort(), [ids.full, ids.single].sort());
    // A retry of an outfit step 1 keeps its outfit identity: an item list or another outfit is refused.
    equal(await h.claim(a, done, 1, randomUUID(), { items: [ids.top] }), { code: 'INVALID_INPUT', claimed: false });
    equal(await h.claim(a, done, 1, randomUUID(), { outfit: ids.full }), { code: 'INVALID_INPUT', claimed: false });
    // A duplicate request id is terminal whatever it names.
    equal(await h.claim(a, h.fresh(), 1, finished.id, { items: [ids.top] }), { code: 'TERMINAL', claimed: false });
    equal(await h.claim(a, h.fresh(), 1, finished.id, { outfit: ids.full }), { code: 'TERMINAL', claimed: false });
  } finally {
    await h.close(before);
  }
}

export async function tryonIdeaProbes(snapshot, sql, mark, service) {
  const h = helpers(snapshot, sql);
  const { a, b, rpc, rpcWith, claim, release, runStep, fresh, rows, chainRow, live, one, scalar } = h;
  const before = await h.open();
  try {
    mark('garments');
    const top = await h.garment(h.sh, 'top'), top2 = await h.garment(h.sh, 'top'), bottom = await h.garment(h.sh, 'bottom');
    const shoes = await h.garment(h.sh, 'footwear'), onePiece = await h.garment(h.sh, 'one_piece'), coat = await h.garment(h.sh, 'outerwear');
    const peerTop = await h.garment(h.shB, 'top');
    const category = new Map([[top, 'top'], [top2, 'top'], [bottom, 'bottom'], [shoes, 'footwear'], [onePiece, 'one_piece'], [coat, 'outerwear']]);

    mark('readiness');
    // The operator reloads the PostgREST schema cache, then runs the old- and new-shaped non-dispatching checks over HTTP: a
    // random owner is refused UNAVAILABLE before any row, for the eight-argument and the nine-argument shape alike. Accounting
    // from earlier stages is durable and stays; the calls must leave the baseline exactly as it was.
    if (service) {
      const serviceRpc = serviceRpcOf(service);
      const baseline = async () => one(`select jsonb_build_object('mine',(select jsonb_build_object('usage',count(*)) from private.ai_usage
        where owner_id=${literal(a.uid)} and purpose='try_on'),'workflow',(select jsonb_build_object('chains',count(*),'results',
        (select count(*) from private.tryon_results),'attempts',(select count(*) from private.tryon_attempts),
        'evidence',(select count(*) from private.ai_usage_evidence where tryon_dispatch_before is not null),
        'usage',(select count(*) from private.ai_usage where purpose='try_on')) from private.tryon_chains));`);
      const quiet = await baseline();
      await sql(`notify pgrst, 'reload schema';`);
      const shape = () => ({ p_owner_id: randomUUID(), p_chain_id: randomUUID(), p_step: 1, p_request_id: randomUUID(), p_manifest_id: MANIFEST,
        p_outfit_id: randomUUID(), p_person_sha256: null, p_probe_id: null });
      for (const until = Date.now() + 20_000; ;) {
        const old = await serviceRpc('tryon_claim', shape());
        const newer = await serviceRpc('tryon_claim', { ...shape(), p_outfit_id: null, p_item_ids: [randomUUID()] });
        if ([old, newer].every((reply) => reply.status === 200 && reply.data?.code === 'UNAVAILABLE' && reply.data?.claimed === false)) break;
        requireEvidence(Date.now() < until);
        await delay(250);
      }
      equal(await baseline(), quiet);
    }

    mark('input');
    // Step 1 names exactly one of an outfit and an item list; every id is this owner's own; no row is written.
    const none = await rows(a);
    for (const options of [{}, { outfit: randomUUID(), items: [top] }, { items: [] }, { items: [top, top] },
      { items: Array.from({ length: 9 }, () => randomUUID()) }]) {
      equal(await claim(a, fresh(), 1, randomUUID(), options), { code: 'INVALID_INPUT', claimed: false });
    }
    await h.freeSlots();
    equal(await one(`select public.tryon_claim(${literal(a.uid)},${literal(fresh())},1,${literal(randomUUID())},${literal(MANIFEST)},
      null::uuid,null::text,null::uuid,array[${literal(top)}::uuid,null::uuid]::uuid[]);`), { code: 'INVALID_INPUT', claimed: false });
    equal(await claim(a, fresh(), 1, randomUUID(), { items: [top, randomUUID()] }), { code: 'NOT_FOUND', claimed: false });
    equal(await claim(a, fresh(), 1, randomUUID(), { items: [top, peerTop] }), { code: 'NOT_FOUND', claimed: false });
    equal(await claim(a, fresh(), 1, randomUUID(), { items: [coat] }), { code: 'NO_GARMENTS', claimed: false });
    // After step 1 a claim carries no subject, and a new chain cannot start on a later step.
    equal(await claim(a, fresh(), 2, randomUUID(), { items: [top], person: 'a'.repeat(64) }), { code: 'INVALID_INPUT', claimed: false });
    equal(await claim(a, fresh(), 2, randomUUID(), { person: 'a'.repeat(64) }), { code: 'INVALID_INPUT', claimed: false });
    equal(await rows(a), none);
    // The old eight-argument call shape still resolves (an old Edge): an outfit is required there.
    equal(await one(`select ${h.claimCall(a, fresh(), 1, randomUUID(), { legacy: true })};`), { code: 'INVALID_INPUT', claimed: false });

    mark('chain');
    const chain = fresh();
    let person = null, final = null;
    for (const step of [1, 2, 3]) {
      const ran = await runStep(a, chain, step, { items: [top, bottom, coat, shoes], person, last: step === 3 });
      requireEvidence(ran.claimed.steps === 3 && ran.claimed.slot === ['top', 'bottom', 'footwear'][step - 1]
        && ran.claimed.garment.path.startsWith(`${a.uid}/`));
      if (step === 1) {
        const row = await chainRow(a, chain);
        requireEvidence(row.outfit_id === null && JSON.stringify(row.idea_item_ids) === JSON.stringify([top, bottom, coat, shoes]));
      }
      if (step === 3) final = ran;
      person = ran.out.sha;
    }
    const status = await rpc(a, 'tryon_chain_status', { p_chain_id: chain });
    requireEvidence(status.code === 'OK' && status.state === 'complete' && status.resultId === final.done.resultId
      && status.steps.length === 3 && status.steps[2].slot === 'footwear');

    mark('results-contract');
    // Without the header the list is exactly what an older client parses: outfit results only. With it, an idea's result
    // (outfitId null) is listed too, and its picture is readable; the owner's delete by id needs no header.
    const outfit = await h.saveOutfit(a, [top], 'Fictional idea outfit');
    const viaOutfit = await runStep(a, fresh(), 1, { outfit, last: true });
    const plain = await rpcWith(a, 'tryon_results_v1', {}, {});
    equal(plain.results.map((row) => row.id), [viaOutfit.done.resultId]);
    requireEvidence(plain.results.every((row) => typeof row.outfitId === 'string'));
    equal(await rpcWith(a, 'tryon_result_image_v1', { p_result_id: final.done.resultId }, {}), { code: 'NOT_FOUND' });
    const opted = await rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER);
    equal(opted.results.map((row) => row.id).sort(), [final.done.resultId, viaOutfit.done.resultId].sort());
    const mine = opted.results.find((row) => row.id === final.done.resultId);
    requireEvidence(mine.outfitId === null && JSON.stringify(mine.itemIds) === JSON.stringify([top, bottom, shoes])
      && mine.expiresAtMs - mine.completedAtMs === 7 * 24 * 3600 * 1000);
    const image = await rpcWith(a, 'tryon_result_image_v1', { p_result_id: final.done.resultId }, RESULTS_HEADER);
    requireEvidence(image.code === 'OK' && Buffer.from(image.jpegBase64, 'base64').equals(final.out.bytes));
    // Only the owner sees it; a foreign read, delete or Stop answers as if it did not exist.
    equal((await rpcWith(b, 'tryon_results_v1', {}, RESULTS_HEADER)).results, []);
    equal(await rpcWith(b, 'tryon_result_image_v1', { p_result_id: final.done.resultId }, RESULTS_HEADER), { code: 'NOT_FOUND' });
    equal(await rpc(b, 'tryon_delete_result', { p_result_id: final.done.resultId }), { code: 'NOT_FOUND' });
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: chain }), { code: 'COMPLETED', resultId: final.done.resultId });

    mark('identity');
    // Step 1: exactly one subject, and a retry repeats it exactly (order included). Neither is carried after step 1.
    const held = fresh(), heldId = randomUUID();
    equal((await claim(a, held, 1, heldId, { items: [top, bottom] })).code, 'OK');
    await release(a, heldId);
    for (const options of [{ items: [bottom, top] }, { items: [top2, bottom] }, { items: [top] }, { outfit }, { items: [top, bottom], outfit },
      {}]) {
      equal(await claim(a, held, 1, randomUUID(), options), { code: 'INVALID_INPUT', claimed: false });
    }
    equal(await claim(a, held, 2, randomUUID(), { items: [top, bottom], person: 'b'.repeat(64) }), { code: 'INVALID_INPUT', claimed: false });
    const retry = randomUUID();
    equal((await claim(a, held, 1, retry, { items: [top, bottom] })).code, 'OK');
    // A request id is used once, whatever chain or subject names it.
    equal(await claim(a, fresh(), 1, retry, { items: [top2] }), { code: 'TERMINAL', claimed: false });
    await release(a, retry);
    // An outfit chain keeps its own identity the same way.
    const saved = fresh(), savedId = randomUUID();
    equal((await claim(a, saved, 1, savedId, { outfit })).code, 'OK');
    await release(a, savedId);
    for (const options of [{ items: [top] }, { outfit: randomUUID() }, { outfit, items: [top] }, {}]) {
      equal(await claim(a, saved, 1, randomUUID(), options), { code: 'INVALID_INPUT', claimed: false });
    }
    const savedRetry = randomUUID();
    equal((await claim(a, saved, 1, savedRetry, { outfit })).code, 'OK');
    await release(a, savedRetry);
    const kept = await chainRow(a, saved);
    requireEvidence(kept.outfit_id === outfit && kept.idea_item_ids === null);
    // Stop ends an idea chain and frees its reserved result; a stopped chain never claims again.
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: held }), { code: 'CANCELLED' });
    equal(await claim(a, held, 1, randomUUID(), { items: [top, bottom] }), { code: 'CANCELLED', claimed: false });
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: saved }), { code: 'CANCELLED' });
    // Stop before the claim: the marker wins over a valid idea, while an invalid shape is still refused first.
    const early = fresh();
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: early }), { code: 'CANCELLED' });
    const beforeEarly = await rows(a);
    equal(await claim(a, early, 1, randomUUID(), { items: [top, bottom] }), { code: 'CANCELLED', claimed: false });
    equal(await claim(a, early, 1, randomUUID(), { items: [top], outfit }), { code: 'INVALID_INPUT', claimed: false });
    equal(await rows(a), beforeEarly);
    // After step 1 even the chain's own outfit id is refused, before any hold: neither subject is carried on a later step.
    const trio = await h.saveOutfit(a, [top, bottom, shoes], 'Fictional continuation outfit');
    const running = fresh();
    const first = await runStep(a, running, 1, { outfit: trio });
    const heldBefore = await rows(a);
    const slotsBefore = await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)} and purpose='try_on'
      and charge_state='held';`);
    for (const options of [{ outfit: trio }, { outfit: randomUUID() }, { items: [top, bottom, shoes] }, { outfit: trio, items: [top] }]) {
      equal(await claim(a, running, 2, randomUUID(), { ...options, person: first.out.sha }), { code: 'INVALID_INPUT', claimed: false });
    }
    equal(await rows(a), heldBefore);
    equal(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)} and purpose='try_on'
      and charge_state='held';`), slotsBefore);
    // The continuation with neither subject goes on, and the chain completes.
    const second = await runStep(a, running, 2, { person: first.out.sha });
    await runStep(a, running, 3, { person: second.out.sha, last: true });

    mark('selection');
    // SQL and TypeScript pick the same garments, in the same slots, for the same list.
    const lists = [[top, bottom, shoes], [top2, top, bottom, shoes, coat], [onePiece, top, bottom, shoes], [bottom, top, shoes],
      [shoes, bottom, top], [top2, top], [onePiece], [top, onePiece, coat, shoes], [coat]];
    for (const list of lists) {
      const expected = selectTryOnSteps(list.map((id) => ({ itemId: id, category: category.get(id), lifecycle: 'active', deleted: false,
        readyImage: true }))).steps;
      const parity = fresh(), parityId = randomUUID();
      const claimed = await claim(a, parity, 1, parityId, { items: list });
      if (expected.length === 0) {
        equal(claimed, { code: 'NO_GARMENTS', claimed: false });
        continue;
      }
      requireEvidence(claimed.code === 'OK' && claimed.steps === expected.length);
      const steps = await one(`select jsonb_agg(jsonb_build_object('slot',x->>'slot','itemId',x->>'itemId') order by n)
        from private.tryon_chains t,jsonb_array_elements(t.steps) with ordinality q(x,n)
        where t.owner_id=${literal(a.uid)} and t.chain_id=${literal(parity)};`);
      equal(steps, expected);
      await release(a, parityId);
      equal(await rpc(a, 'tryon_cancel', { p_chain_id: parity }), { code: 'CANCELLED' });
    }

    mark('budget');
    // The whole selected chain must fit the one shared monthly budget now; each step then re-checks and holds on its own.
    const used = () => scalar(`select private.ai_budget_used(${literal(a.uid)},clock_timestamp());`).then(BigInt);
    const allowance = (value) => sql(`update private.ai_controls set monthly_allowance_micro=${value},updated_at=clock_timestamp()
      where owner_id=${literal(a.uid)};`);
    const start = await used();
    await allowance(start + BigInt(3 * RESERVED - 1));
    const gate = await rows(a);
    equal(await claim(a, fresh(), 1, randomUUID(), { items: [top, bottom, shoes] }), { code: 'ALLOWANCE', claimed: false });
    equal(await rows(a), gate);
    await allowance(start + BigInt(3 * RESERVED));
    const budgeted = fresh();
    const stepOne = await runStep(a, budgeted, 1, { items: [top, bottom, shoes] });
    // Step 1 settled below its reservation; leave room for one reservation less than step 2 needs.
    await allowance((await used()) + BigInt(RESERVED - 1));
    const refusedStep = await rows(a);
    equal(await claim(a, budgeted, 2, randomUUID(), { person: stepOne.out.sha }), { code: 'ALLOWANCE', claimed: false });
    equal(await rows(a), refusedStep);
    await allowance(100000000);
    const twoId = randomUUID();
    equal((await claim(a, budgeted, 2, twoId, { person: stepOne.out.sha })).code, 'OK');
    await release(a, twoId);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: budgeted }), { code: 'CANCELLED' });

    mark('cap');
    // Outfit and idea results count together toward the twenty-result cap.
    for (const id of await one(`select coalesce(jsonb_agg(result_id),'[]'::jsonb) from private.tryon_results where owner_id=${literal(a.uid)};`)) {
      equal(await rpc(a, 'tryon_delete_result', { p_result_id: id }), { code: 'OK' });
    }
    await sql(`insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,jpeg,created_at,completed_at,expires_at)
      select ${literal(a.uid)},gen_random_uuid(),gen_random_uuid(),case when n%2=0 then ${literal(outfit)}::uuid else null end,'ready',
        array[${literal(top)}::uuid],decode('ffd8ffd9','hex'),now(),now(),now()+interval '7 days' from generate_series(1,20) n;`);
    equal(await live(a), 20);
    equal(await claim(a, fresh(), 1, randomUUID(), { items: [top, bottom] }), { code: 'RESULTS_FULL', claimed: false });
    equal(await claim(a, fresh(), 1, randomUUID(), { outfit }), { code: 'RESULTS_FULL', claimed: false });
    const listedAll = await rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER);
    equal(listedAll.results.length, 20);
    equal((await rpcWith(a, 'tryon_results_v1', {}, {})).results.length, 10);
    const gone = listedAll.results.find((row) => row.outfitId === null);
    equal(await rpc(a, 'tryon_delete_result', { p_result_id: gone.id }), { code: 'OK' });
    const roomId = randomUUID(), room = fresh();
    equal((await claim(a, room, 1, roomId, { items: [top, bottom] })).code, 'OK');
    await release(a, roomId);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: room }), { code: 'CANCELLED' });

    mark('expiry');
    // Exact expiry: an idea result is gone from the reads the moment it expires, before the purge has run; the purge then
    // deletes it. Both columns move together, so the fixed seven-day rule still holds.
    const expiring = listedAll.results.find((row) => row.outfitId === null && row.id !== gone.id);
    await sql(`update private.tryon_results set completed_at=completed_at-interval '8 days',expires_at=expires_at-interval '8 days'
      where owner_id=${literal(a.uid)} and result_id=${literal(expiring.id)};`);
    requireEvidence(!(await rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER)).results.some((row) => row.id === expiring.id));
    equal(await rpcWith(a, 'tryon_result_image_v1', { p_result_id: expiring.id }, RESULTS_HEADER), { code: 'NOT_FOUND' });
    equal((await one('select public.tryon_expire_due(500);')).code, 'OK');
    equal(Number(await scalar(`select count(*) from private.tryon_results where result_id=${literal(expiring.id)};`)), 0);

    mark('withdrawal');
    // Turning try-on off ends a running idea chain; the next claim for it is refused. Reading and deleting stay possible.
    const off = fresh(), offId = randomUUID();
    equal((await claim(a, off, 1, offId, { items: [top, bottom] })).code, 'OK');
    await release(a, offId);
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).code, 'CONSENT_REQUIRED');
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: off })).state, 'withdrawn');
    const whileOff = await rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER);
    requireEvidence(whileOff.code === 'OK' && whileOff.results.some((row) => row.outfitId === null));
    const readable = whileOff.results.find((row) => row.outfitId === null);
    equal((await rpcWith(a, 'tryon_result_image_v1', { p_result_id: readable.id }, RESULTS_HEADER)).code, 'OK');
    equal(await rpc(a, 'tryon_delete_result', { p_result_id: readable.id }), { code: 'OK' });
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    equal(await claim(a, off, 1, randomUUID(), { items: [top, bottom] }), { code: 'WITHDRAWN', claimed: false });

    mark('deletion');
    // Removal paths that need no outfit: the profile and account-deletion cascades, and the owner-only transient discard.
    equal(await one(`select jsonb_build_array(
      (select jsonb_agg(c.confdeltype order by c.conname) from pg_constraint c where c.contype='f'
        and c.confrelid='public.profiles'::regclass and c.conrelid in ('private.tryon_chains'::regclass,'private.tryon_results'::regclass)),
      pg_get_functiondef('private.deletion_owner_rows_absent(uuid)'::regprocedure) like '%tryon_results%',
      pg_get_functiondef('private.deletion_owner_rows_absent(uuid)'::regprocedure) like '%tryon_chains%');`),
    [['c', 'c'], true, true]);
    const discarded = await one('select public.tryon_discard_transient();');
    requireEvidence(discarded.code === 'OK' && discarded.resultsDeleted >= 1);
    const left = await rows(a);
    requireEvidence(left.results === 0 && left.chains === 0);
    equal((await rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER)).results, []);

    mark('outfit-unchanged');
    // A saved outfit is claimed and run exactly as before, with the new argument omitted.
    const full = await h.saveOutfit(a, [top, bottom, shoes], 'Fictional idea full outfit');
    const whole = fresh();
    let carried = null;
    for (const step of [1, 2, 3]) {
      const ran = await runStep(a, whole, step, { outfit: full, person: carried, last: step === 3, legacy: true });
      carried = ran.out.sha;
    }
    const outfitRow = await chainRow(a, whole);
    requireEvidence(outfitRow.outfit_id === full && outfitRow.idea_item_ids === null && outfitRow.state === 'complete');
  } finally {
    await h.close(before);
  }
}
