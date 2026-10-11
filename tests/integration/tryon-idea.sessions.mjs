// TRYON-IDEA1: try on an unsaved Today idea against the real schema after 20261011090000. Invoked only by the CI-only
// preservation owner, after the frozen checks ran at the exact prior inventory. tryon_claim, tryon_dispatch and tryon_finish
// are service functions, called through privileged SQL the way the Edge handler calls them; every owner read, cancel and
// isolation assertion uses the ordinary A/B sessions. Capacity, controls and consent are opened only inside this probe and
// restored in finally. The garments are the owners' own fictional items. No provider calls.
import { createHash, randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';
import { intent, saveHarness } from './item-save.sessions.mjs';

const MANIFEST = 'azure-global-image25-sunburst-tryon-v1';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const RESERVED = 360000;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const orNull = (value, cast) => (value === null ? `null::${cast}` : `${literal(value)}::${cast}`);
const uuids = (ids) => (ids === null ? 'null::uuid[]' : `array[${ids.map((id) => `${literal(id)}::uuid`).join(',')}]::uuid[]`);
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', input: 9000, output: 6000, total: 15000, inputText: 200,
  inputImage: 8800 });
const output = (label) => {
  const bytes = Buffer.from(`synthetic idea try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
};

export async function tryonIdeaProbes(snapshot, sql, mark) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = (owner, name, body) => client.rpc(owner, name, body);
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
  // One full step: claim, mark, finish OK. The last step sends the picture.
  const runStep = async (owner, chain, n, { items = null, person = null, last = false } = {}) => {
    const id = randomUUID();
    const claimed = await claim(owner, chain, n, id, { items: n === 1 ? items : null, person });
    requireEvidence(claimed.code === 'OK' && claimed.last === last);
    equal((await dispatch(owner, id)).code, 'AUTHORISED');
    const out = output(`${n}`);
    const done = await finish(owner, id, 'OK', { out, send: last });
    requireEvidence(done.code === 'OK' && done.last === last);
    return { id, out, done, claimed };
  };

  const before = { a: await controls(a), b: await controls(b) };
  requireEvidence(before.a.tryon_activated === false && before.b.tryon_activated === false);
  const sh = saveHarness(client, a), shB = saveHarness(client, b);
  const chains = [];
  try {
    mark('setup');
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
    const garment = async (harness, category) => {
      const value = harness.track(intent());
      value.p_item.category = category;
      value.p_item.title = `Fictional idea ${category}`;
      const row = await harness.reserve(value);
      await harness.upload(value);
      await harness.finalize(value, row);
      return value.p_item.id;
    };
    const top = await garment(sh, 'top'), top2 = await garment(sh, 'top'), bottom = await garment(sh, 'bottom');
    const shoes = await garment(sh, 'footwear'), onePiece = await garment(sh, 'one_piece'), coat = await garment(sh, 'outerwear');
    const peerTop = await garment(shB, 'top');
    const fresh = () => { const id = randomUUID(); chains.push(id); return id; };

    mark('input');
    // Exactly one of an outfit and an item list names a new chain; every id is this owner's own; no row is written.
    const none = await rows(a);
    for (const options of [{}, { outfit: randomUUID(), items: [top] }, { items: [] }, { items: [top, top] },
      { items: Array.from({ length: 9 }, () => randomUUID()) }]) {
      equal(await claim(a, randomUUID(), 1, randomUUID(), options), { code: 'INVALID_INPUT', claimed: false });
    }
    await freeSlots();
    equal(await one(`select public.tryon_claim(${literal(a.uid)},${literal(randomUUID())},1,${literal(randomUUID())},${literal(MANIFEST)},
      null::uuid,null::text,null::uuid,array[${literal(top)}::uuid,null::uuid]::uuid[]);`), { code: 'INVALID_INPUT', claimed: false });
    equal(await claim(a, randomUUID(), 1, randomUUID(), { items: [top, randomUUID()] }), { code: 'NOT_FOUND', claimed: false });
    equal(await claim(a, randomUUID(), 1, randomUUID(), { items: [top, peerTop] }), { code: 'NOT_FOUND', claimed: false });
    equal(await claim(a, randomUUID(), 1, randomUUID(), { items: [coat] }), { code: 'NO_GARMENTS', claimed: false });
    equal(await rows(a), none);
    // The old eight-argument call shape still resolves (an old Edge): an outfit is required there.
    equal(await one(`select ${claimCall(a, randomUUID(), 1, randomUUID(), { legacy: true })};`), { code: 'INVALID_INPUT', claimed: false });

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
    const listed = await rpc(a, 'tryon_results_v1', {});
    requireEvidence(listed.code === 'OK' && listed.results.length === 1 && listed.results[0].id === final.done.resultId
      && listed.results[0].outfitId === null && JSON.stringify(listed.results[0].itemIds) === JSON.stringify([top, bottom, shoes])
      && listed.results[0].expiresAtMs - listed.results[0].completedAtMs === 7 * 24 * 3600 * 1000);
    const image = await rpc(a, 'tryon_result_image_v1', { p_result_id: final.done.resultId });
    requireEvidence(image.code === 'OK' && Buffer.from(image.jpegBase64, 'base64').equals(final.out.bytes));
    // Only the owner sees it: B's list is empty and B's read, delete and cancel all answer as if it did not exist.
    equal((await rpc(b, 'tryon_results_v1', {})).results, []);
    equal(await rpc(b, 'tryon_result_image_v1', { p_result_id: final.done.resultId }), { code: 'NOT_FOUND' });
    equal(await rpc(b, 'tryon_delete_result', { p_result_id: final.done.resultId }), { code: 'NOT_FOUND' });
    equal((await rpc(b, 'tryon_cancel', { p_chain_id: chain })).code, 'CANCELLED');
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: chain }), { code: 'COMPLETED', resultId: final.done.resultId });
    // The result belongs to no outfit, so deleting it is the owner's own action and it disappears from the list.
    equal(await rpc(a, 'tryon_delete_result', { p_result_id: final.done.resultId }), { code: 'OK' });
    equal((await rpc(a, 'tryon_results_v1', {})).results, []);

    mark('identity');
    // A retry of step 1 repeats the idea's identity; a different list, or an outfit, on the same chain is refused.
    const held = fresh(), heldId = randomUUID();
    equal((await claim(a, held, 1, heldId, { items: [top, bottom] })).code, 'OK');
    await release(a, heldId);
    equal(await claim(a, held, 1, randomUUID(), { items: [top2, bottom] }), { code: 'INVALID_INPUT', claimed: false });
    equal(await claim(a, held, 1, randomUUID(), { outfit: randomUUID() }), { code: 'INVALID_INPUT', claimed: false });
    const retry = randomUUID();
    equal((await claim(a, held, 1, retry, { items: [top, bottom] })).code, 'OK');
    await release(a, retry);
    // Stop ends the idea chain and frees its reserved result; a stopped chain never claims again.
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: held }), { code: 'CANCELLED' });
    equal(await claim(a, held, 1, randomUUID(), { items: [top, bottom] }), { code: 'CANCELLED', claimed: false });
    equal((await rows(a)).results, 0);

    mark('selection');
    // The listed order picks the garment of each slot; a one-piece replaces top and bottom; layers are never tried on.
    const order = fresh(), orderId = randomUUID();
    const picked = await claim(a, order, 1, orderId, { items: [top2, top, bottom, shoes] });
    requireEvidence(picked.code === 'OK' && picked.steps === 3);
    await release(a, orderId);
    equal((await one(`select steps->0->>'itemId' as item from private.tryon_chains where owner_id=${literal(a.uid)}
      and chain_id=${literal(order)};`)).item, top2);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: order }), { code: 'CANCELLED' });
    const dress = fresh(), dressId = randomUUID();
    const one2 = await claim(a, dress, 1, dressId, { items: [top, onePiece, coat, shoes] });
    requireEvidence(one2.code === 'OK' && one2.steps === 2 && one2.slot === 'one_piece');
    await release(a, dressId);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: dress }), { code: 'CANCELLED' });

    mark('withdrawal');
    // Turning try-on off ends a running idea chain and the next claim for it is refused.
    const gone = fresh(), goneId = randomUUID();
    equal((await claim(a, gone, 1, goneId, { items: [top, bottom] })).code, 'OK');
    await release(a, goneId);
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).code, 'CONSENT_REQUIRED');
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: gone })).state, 'withdrawn');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    equal(await claim(a, gone, 1, randomUUID(), { items: [top, bottom] }), { code: 'WITHDRAWN', claimed: false });

    mark('outfit-unchanged');
    // A saved outfit is claimed exactly as before, with the new argument omitted.
    const outfit = randomUUID();
    await rpc(a, 'save_outfit', { p_id: outfit, p_title: 'Fictional idea outfit', p_occasion: 'everyday', p_notes: '',
      p_favourite: false, p_item_ids: [top, bottom, shoes], p_expected_version: null, });
    const saved = fresh(), savedId = randomUUID();
    const viaOutfit = await claim(a, saved, 1, savedId, { outfit });
    requireEvidence(viaOutfit.code === 'OK' && viaOutfit.steps === 3);
    await release(a, savedId);
    const row = await chainRow(a, saved);
    requireEvidence(row.outfit_id === outfit && row.idea_item_ids === null);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: saved }), { code: 'CANCELLED' });
    await sql(`delete from public.outfit_items where owner_id=${literal(a.uid)} and outfit_id=${literal(outfit)};
      delete from public.outfits where owner_id=${literal(a.uid)} and id=${literal(outfit)};`);
  } finally {
    await sql(`delete from private.tryon_results where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chains where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chain_stops where owner_id in (${literal(a.uid)},${literal(b.uid)})
        and chain_id in (${chains.length ? chains.map((id) => `${literal(id)}::uuid`).join(',') : 'null::uuid'});`);
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
  }
  equal(Number(await scalar(`select count(*) from private.ai_usage where purpose='try_on' and charge_state='held';`)), 0);
}
