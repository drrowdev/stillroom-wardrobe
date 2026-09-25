// PR-3b EDGE-RUNTIME gate (normal sessions only). Spawned by `scripts/run-local-tests.mjs edge` after the privileged
// controller built the isolated fixture; it holds the fictional owners' tokens and never receives credentials.
// Labels: EDGE-RUNTIME / PROVIDER-DOUBLE = production analyze-clothing handler in the pinned edge-runtime image,
// provider replaced only through its injected azureTransport; EDGE-RUNTIME = the stack's own served functions.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LOCAL_API } from '../../scripts/backend/local.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { normalClient, requireEvidence, TABLES } from '../integration/preservation.sessions.mjs';
import { analysisHash } from '../integration/ai-analysis.sessions.mjs';
import { analyzedIntent, analyzedHarness } from '../integration/analyzed-save.sessions.mjs';
import { imageChangeHarness } from '../integration/image-replacement.sessions.mjs';
import { READY_FACTS } from '../edge-fixtures/provider-double.mjs';
import { EDGE_DELEGATIONS } from './edge-delegations.mjs';

const PROVIDER = 'EDGE-RUNTIME / PROVIDER-DOUBLE', STACK = 'EDGE-RUNTIME';
const results = [], passed = new Set();
let stage = 'entry';
function check(label, name, condition, observed) {
  results.push({ label, name, ok: condition === true });
  if (condition === true) { passed.add(name); console.log(`PASS: ${label} ${name}`); }
  else console.log(`FAIL: ${label} ${name}${observed === undefined ? '' : ` observed=${JSON.stringify(observed).slice(0, 300)}`}`);
  return condition === true;
}
export const gateId = (label, n, kind = '0') => {
  requireEvidence(['A', 'B'].includes(label) && Number.isInteger(n) && n >= 1 && n <= 99 && /^[0-9a-d]$/.test(kind));
  return `e3b0${label.toLowerCase()}${kind}00-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
/** Removes per-request identity and time values so a foreign-ID result can be compared with its fresh twin. */
export function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['requestId', 'draftId'].includes(key)
    && !/(At|AtMs|Ms|expires)$/i.test(key)).map(([key, entry]) => [key, normalized(entry)]));
}
const summary = (r) => (r ? { status: r.status, code: r.data?.code ?? r.data?.state ?? null } : null);

let pending = new Map(), nextId = 1, ingress = null;
process.on('message', (message) => {
  if (message?.type === 'start' && typeof message.ingress === 'string') { ingress = message.ingress; pending.get('start')?.(); return; }
  if (message?.type === 'result' && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
function op(name, owner) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false }); }, 90_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    process.send({ type: 'op', id, op: name, ...(owner ? { owner } : {}) });
  });
}

async function main() {
  requireEvidence(typeof process.send === 'function' && process.argv.length === 2);
  await new Promise((resolve) => { if (ingress) resolve(); else pending.set('start', resolve); });
  pending.delete('start');
  requireEvidence(/^http:\/\/(?:[0-9]{1,3}\.){3}[0-9]{1,3}:8081$/.test(ingress));
  const env = process.env, client = normalClient(env);
  const A = await client.signIn('A'), B = await client.signIn('B');
  requireEvidence(A.uid !== B.uid);
  const frozen = new Set();
  const freeze = async (owner) => { frozen.add(owner.label); requireEvidence((await op('freeze', owner.label)).ok === true); };
  const unfreeze = async (owner) => { requireEvidence((await op('restore', owner.label)).ok === true); frozen.delete(owner.label); };
  const count = async () => { const r = await op('count'); requireEvidence(r.ok === true && r.data); return r.data; };
  try {
    stage = 'consent';
    for (const owner of [A, B]) {
      const before = (await client.rows(owner, 'profiles'))[0];
      requireEvidence(isDeepStrictEqual(await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: 2,
        p_expected_version: before.version }), { code: 'OK', profileVersion: String(before.version + 1) }));
    }
    const analyze = async (token, requestId, draftId, body = jpegHeaderFixture()) => {
      const response = await fetch(`${ingress}/functions/v1/analyze-clothing`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
        headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), apikey: env.SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'image/jpeg', 'X-Stillroom-Request-Id': requestId, 'X-Stillroom-Draft-Id': draftId,
          'X-Stillroom-Generation': '1' },
        body,
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* compared as null */ }
      return { status: response.status, data, noStore: response.headers.get('cache-control') === 'no-store' };
    };
    const ready = (r, requestId, draftId, outcome = 'ready') => r.status === 200 && r.noStore && r.data?.code === 'OK'
      && r.data.status === 'ready' && r.data.result?.requestId === requestId && r.data.result?.draftId === draftId
      && r.data.result?.imageSha256 !== undefined && r.data.result?.facts?.outcome === outcome;
    const status = (owner, id) => client.rpc(owner, 'ai_analysis_status', { p_request_id: id });
    const start = await count();
    check(PROVIDER, 'double-clean-start', start.served === 0 && start.rejected === 0 && start.refused === 0, start);

    stage = 'analyze-fresh';
    const a1 = gateId('A', 1), b1 = gateId('B', 1);
    const rA1 = await analyze(A.token, a1, a1), rB1 = await analyze(B.token, b1, b1);
    check(PROVIDER, 'analyze-owned-A', ready(rA1, a1, a1) && isDeepStrictEqual(rA1.data.result.facts, READY_FACTS)
      && rA1.data.result.imageSha256 === analysisHash, summary(rA1));
    check(PROVIDER, 'analyze-owned-B', ready(rB1, b1, b1) && isDeepStrictEqual(rB1.data.result.facts, READY_FACTS), summary(rB1));
    const ownStatus = await status(A, a1);
    check(PROVIDER, 'analysis-status-owned', ownStatus?.code === 'OK' && ownStatus.status === 'ready'
      && ownStatus.result?.requestId === a1, { code: ownStatus?.code });
    stage = 'analyze-replay';
    const replay = await analyze(A.token, a1, a1);
    check(PROVIDER, 'analyze-replay-identical', replay.status === 200 && isDeepStrictEqual(replay.data, rA1.data), summary(replay));
    let counted = await count();
    check(PROVIDER, 'analyze-replay-no-dispatch', counted.served === 2, counted.served);

    stage = 'analyze-foreign';
    const foreign = [];
    for (const [attacker, victim, victimId, n] of [[A, B, b1, 4], [B, A, a1, 5]]) {
      const victimBefore = await status(victim, victimId);
      const draft = gateId(attacker.label, n, 'd'), twinId = gateId(attacker.label, n), twinDraft = gateId(attacker.label, n, 'c');
      const substituted = await analyze(attacker.token, victimId, draft);
      const twin = await analyze(attacker.token, twinId, twinDraft);
      const victimAfter = await status(victim, victimId);
      const ok = ready(substituted, victimId, draft) && ready(twin, twinId, twinDraft)
        && isDeepStrictEqual(normalized(substituted.data), normalized(twin.data))
        && isDeepStrictEqual(victimBefore, victimAfter) && victimAfter?.result?.draftId === victimId;
      foreign.push(check(PROVIDER, `analyze-foreign-id-${attacker.label}>${victim.label}`, ok,
        { substituted: summary(substituted), twin: summary(twin), victimUnchanged: isDeepStrictEqual(victimBefore, victimAfter) }));
    }
    stage = 'analysis-status-foreign';
    for (const [attacker, victimOnly, missing] of [[B, gateId('A', 4), gateId('B', 90)], [A, gateId('B', 5), gateId('A', 90)]]) {
      const peer = await status(attacker, victimOnly), none = await status(attacker, missing);
      foreign.push(check(PROVIDER, `analysis-status-foreign-${attacker.label}`, isDeepStrictEqual(peer, none)
        && isDeepStrictEqual(peer, { code: 'UNAVAILABLE' }), { peer: peer?.code, none: none?.code }));
    }
    stage = 'analyze-anonymous';
    const anon = await analyze(null, gateId('A', 6), gateId('A', 6));
    const invalid = await analyze('invalid.jwt.token', gateId('A', 7), gateId('A', 7));
    foreign.push(check(PROVIDER, 'analyze-anonymous', anon.status === 401 && isDeepStrictEqual(anon.data, { code: 'UNAUTHENTICATED' }), summary(anon)));
    foreign.push(check(PROVIDER, 'analyze-invalid-token', invalid.status === 401 && isDeepStrictEqual(invalid.data, { code: 'UNAUTHENTICATED' }), summary(invalid)));
    counted = await count();
    check(PROVIDER, 'analyze-foreign-dispatch-count', counted.served === 6, counted.served);

    stage = 'analyze-frozen';
    await freeze(A);
    const frozenFresh = await analyze(A.token, gateId('A', 8), gateId('A', 8));
    const frozenReplay = await analyze(A.token, a1, a1);
    const otherDuring = await analyze(B.token, b1, b1);
    await unfreeze(A);
    const restoredReplay = await analyze(A.token, a1, a1);
    const denied = (r) => r.status === 403 && isDeepStrictEqual(r.data, { code: 'UNAVAILABLE' });
    foreign.push(check(PROVIDER, 'analyze-frozen-same-token', denied(frozenFresh) && denied(frozenReplay),
      { fresh: summary(frozenFresh), replay: summary(frozenReplay) }));
    check(PROVIDER, 'analyze-frozen-other-owner-unaffected', otherDuring.status === 200 && isDeepStrictEqual(otherDuring.data, rB1.data), summary(otherDuring));
    check(PROVIDER, 'analyze-restored-replay', restoredReplay.status === 200 && isDeepStrictEqual(restoredReplay.data, rA1.data), summary(restoredReplay));
    counted = await count();
    check(PROVIDER, 'analyze-frozen-no-dispatch', counted.served === 6, counted.served);
    if (foreign.every(Boolean)) passed.add('analyze-foreign');

    stage = 'analyze-for-save';
    // The Save runs while synthetic activation is in place; the anomaly cases come after it.
    const a20 = gateId('A', 20);
    const forSave = await analyze(A.token, a20, a20);
    check(PROVIDER, 'analyze-owned-for-save', ready(forSave, a20, a20) && forSave.data.result.imageSha256 === analysisHash, summary(forSave));
    counted = await count();
    check(PROVIDER, 'analyze-for-save-dispatch-count', counted.served === 7 && counted.refused === 0, counted);

    stage = 'finalize-analyzed-item';
    const tableRows = async (owner) => {
      const data = {};
      for (const table of TABLES) {
        const order = table === 'outfit_items' ? 'outfit_id,item_id' : ['profiles', 'style_preferences'].includes(table) ? 'owner_id' : 'id';
        const result = await client.request(owner.token, `/rest/v1/${table}?select=*&order=${order}&limit=1000`);
        requireEvidence(result.ok && Array.isArray(result.data) && result.data.length < 1000);
        data[table] = result.data;
      }
      return data;
    };
    const download = async (owner, objectPath) => {
      const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${objectPath}`);
      return [objectPath, result.status, result.ok && Buffer.isBuffer(result.data) ? createHash('sha256').update(result.data).digest('hex') : null];
    };
    // Victim state for review finding 3: every row, every image object's status and SHA-256, AI usage/consent and the
    // named receipts, read with the victim's own normal session immediately before and after each negative request.
    const victimState = async (owner, receipts, extraPaths) => {
      const data = await tableRows(owner);
      data.objects = [];
      const paths = new Set([...data.item_images.flatMap((image) => [image.main_path, image.thumb_path]), ...extraPaths]);
      for (const objectPath of [...paths].sort()) data.objects.push(await download(owner, objectPath));
      data.ai = normalized(await client.rpc(owner, 'ai_status', {}));
      data.deletion = await client.rpc(owner, 'deletion_status', {});
      data.receipts = [];
      for (const [name, args] of receipts) data.receipts.push([name, normalized(await client.rpc(owner, name, args))]);
      return data;
    };
    const guard = (owner, receipts, extraPaths = []) => {
      const states = [];
      return {
        states,
        start: async () => { states.push(await victimState(owner, receipts, extraPaths)); },
        run: async (call) => { const result = await call(); states.push(await victimState(owner, receipts, extraPaths)); return result; },
        unchanged: (expected) => states.length === expected && states.every((state) => isDeepStrictEqual(state, states[0])),
      };
    };
    const frozenCall = (owner, call) => async () => { await freeze(owner); try { return await call(); } finally { await unfreeze(owner); } };
    // Direct calls so every outcome (including a 5xx) is reported in the check line instead of thrown by a harness.
    const edgeCall = async (name, token, body) => {
      const response = await fetch(`${LOCAL_API}/functions/v1/${name}`, {
        method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: 'Bearer '.concat(token), apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = (await response.text()).slice(0, 16_384);
      let data;
      try { data = text === '' ? null : JSON.parse(text); } catch { data = 'non-json'; }
      return { status: response.status, data };
    };
    {
      const h = analyzedHarness(client, A, env);
      const value = analyzedIntent(A, 21);
      value.p_item.id = gateId('A', 21, 'a'); value.p_image.id = gateId('A', 21, 'b');
      value.p_claim = { ...value.p_claim, requestId: a20, draftId: a20, imageSha256: analysisHash };
      h.track(value);
      stage = 'finalize-analyzed-item-reserve';
      const reserved = await h.call('reserve_analyzed_item_save', value);
      const reservedRow = Array.isArray(reserved.data) ? reserved.data[0] : null;
      check(STACK, 'finalize-analyzed-reserve-owned', reserved.ok && reserved.data.length === 1 && reservedRow?.state === 'reserved',
        { status: reserved.status, code: reserved.data?.code, message: reserved.data?.message, state: reservedRow?.state });
      const row = await h.reserve(value);
      stage = 'finalize-analyzed-item-upload';
      await h.upload(value);
      stage = 'finalize-analyzed-item-negatives';
      const body = (v) => ({ itemId: v.p_item.id, imageId: v.p_image.id, fingerprint: row.fingerprint });
      const missing = structuredClone(value);
      missing.p_item.id = randomUUID(); missing.p_image.id = randomUUID();
      const victim = guard(A, [['ai_analysis_status', { p_request_id: a20 }]], h.paths(value));
      await victim.start();
      const seeded = victim.states[0];
      check(STACK, 'finalize-analyzed-victim-populated', seeded.items.some((item) => item.id === value.p_item.id)
        && seeded.item_images.some((image) => image.id === value.p_image.id)
        && h.paths(value).every((objectPath) => seeded.objects.some(([p, s, hash]) => p === objectPath && s === 200 && hash !== null))
        && seeded.receipts[0][1]?.code === 'OK', { items: seeded.items.length, objects: seeded.objects.length });
      const peer = await victim.run(() => edgeCall('finalize-analyzed-item', B.token, body(value)));
      const none = await victim.run(() => edgeCall('finalize-analyzed-item', B.token, body(missing)));
      const anonymous = await victim.run(() => edgeCall('finalize-analyzed-item', '', body(value)));
      check(STACK, 'finalize-analyzed-foreign-equals-missing', isDeepStrictEqual(peer, none) && peer.status >= 400 && peer.status < 500,
        { peer, none });
      check(STACK, 'finalize-analyzed-anonymous', anonymous.status === 401, anonymous);
      const frozenResult = await victim.run(frozenCall(A, () => edgeCall('finalize-analyzed-item', A.token, body(value))));
      check(STACK, 'finalize-analyzed-frozen-same-token', frozenResult.status === 403, frozenResult);
      check(STACK, 'finalize-analyzed-victim-unchanged', victim.unchanged(5), victim.states.length);
      stage = 'finalize-analyzed-item-owned';
      const done = await edgeCall('finalize-analyzed-item', A.token, body(value));
      const saved = await h.read('items', value.p_item.id);
      const peerView = await client.request(B.token, `/rest/v1/items?id=eq.${value.p_item.id}&select=id`);
      check(STACK, 'analyzed-save-owned', done.status === 204 && saved.length === 1 && saved[0].owner_id === A.uid
        && peerView.ok && isDeepStrictEqual(peerView.data, []), { done: summary(done), peer: peerView.data });
      stage = 'finalize-analyzed-item-attribution';
      const history = await client.request(A.token, '/rest/v1/rpc/item_attribution_history', { method: 'POST', body: { p_item_id: value.p_item.id } });
      const peerHistory = await client.request(B.token, '/rest/v1/rpc/item_attribution_history', { method: 'POST', body: { p_item_id: value.p_item.id } });
      const noneHistory = await client.request(B.token, '/rest/v1/rpc/item_attribution_history', { method: 'POST', body: { p_item_id: randomUUID() } });
      check(STACK, 'attribution-populated', history.ok && Array.isArray(history.data) && history.data.length > 0
        && isDeepStrictEqual({ s: peerHistory.status, d: peerHistory.data }, { s: noneHistory.status, d: noneHistory.data })
        && !JSON.stringify(peerHistory.data).includes(value.p_item.id),
      { own: Array.isArray(history.data) ? history.data.length : history.status, peer: summary(peerHistory), none: summary(noneHistory) });
      await h.cleanup();
    }

    stage = 'analyze-modes';
    // Runs after the analyzed Save: a provider-usage anomaly deactivates the owner's AI controls.
    const unclear = await analyze(A.token, gateId('A', 9), gateId('A', 9), jpegHeaderFixture(121, 80));
    const malformed = await analyze(A.token, gateId('A', 10), gateId('A', 10), jpegHeaderFixture(122, 80));
    const serverError = await analyze(A.token, gateId('A', 11), gateId('A', 11), jpegHeaderFixture(123, 80));
    check(PROVIDER, 'analyze-unclear', ready(unclear, gateId('A', 9), gateId('A', 9), 'unclear'), summary(unclear));
    const failed = (r) => r.status === 502 && isDeepStrictEqual(r.data, { code: 'ANALYSIS_FAILED' });
    check(PROVIDER, 'analyze-malformed-provider-response', failed(malformed), summary(malformed));
    check(PROVIDER, 'analyze-provider-5xx', failed(serverError), summary(serverError));
    const afterAnomaly = await analyze(A.token, gateId('A', 13), gateId('A', 13));
    check(PROVIDER, 'analyze-inactive-after-anomaly', afterAnomaly.status === 503 && isDeepStrictEqual(afterAnomaly.data, { code: 'INACTIVE' }),
      summary(afterAnomaly));
    counted = await count();
    check(PROVIDER, 'double-totals', counted.served === 10 && counted.rejected === 0 && counted.refused === 0
      && isDeepStrictEqual(counted.modes, { ready: 7, unclear: 1, malformed: 1, 'server-error': 1 }), counted);

    stage = 'finalize-image-change';
    {
      const h = imageChangeHarness(client, A, env);
      stage = 'finalize-image-change-setup';
      const created = await h.create();
      const value = h.make(created.item, created.image);
      await h.reserve(value);
      await h.upload(value);
      stage = 'finalize-image-change-negatives';
      const missing = structuredClone(value);
      Object.assign(missing, { requestId: randomUUID(), itemId: randomUUID(), imageId: randomUUID(), currentImageId: randomUUID() });
      missing.image.id = missing.imageId;
      const call = (token, intent) => edgeCall('finalize-image-change', token, { action: 'complete', intent });
      const newPaths = h.paths(value), oldPaths = h.paths({ itemId: value.itemId, imageId: value.currentImageId });
      const victim = guard(A, [['image_change_status', { p_item_id: value.itemId, p_request_id: value.requestId }]], newPaths);
      await victim.start();
      const seeded = victim.states[0];
      check(STACK, 'finalize-image-change-victim-populated', seeded.items.some((item) => item.id === value.itemId)
        && seeded.item_images.some((image) => image.id === value.currentImageId)
        && [...newPaths, ...oldPaths].every((objectPath) => seeded.objects.some(([p, s, hash]) => p === objectPath && s === 200 && hash !== null))
        && seeded.receipts[0][1] !== null, { items: seeded.items.length, objects: seeded.objects.length, receipt: seeded.receipts[0][1] });
      const peer = await victim.run(() => call(B.token, value)), none = await victim.run(() => call(B.token, missing));
      const anonymous = await victim.run(() => call('', value));
      check(STACK, 'finalize-image-change-foreign-equals-missing', isDeepStrictEqual(peer, none) && peer.status >= 400 && peer.status < 500,
        { peer, none });
      check(STACK, 'finalize-image-change-anonymous', anonymous.status === 401, anonymous);
      const frozenResult = await victim.run(frozenCall(A, () => call(A.token, value)));
      check(STACK, 'finalize-image-change-frozen-same-token', frozenResult.status === 403, frozenResult);
      check(STACK, 'finalize-image-change-victim-unchanged', victim.unchanged(5), victim.states.length);
      stage = 'finalize-image-change-owned';
      const done = await call(A.token, value);
      check(STACK, 'finalize-image-change-owned', done.status === 204, done);
      stage = 'finalize-image-change-cleanup';
      await h.remove(value);
      await h.remove({ itemId: created.value.p_item.id, imageId: created.value.p_image.id });
      await h.deleteItem(created.value);
    }

    stage = 'delete-account';
    // Strict inventory for the deletion case: every row plus every image object, each of which must download.
    const inventory = async (owner) => {
      const data = await tableRows(owner);
      data.objects = [];
      for (const image of data.item_images) {
        for (const objectPath of [image.main_path, image.thumb_path]) {
          const entry = await download(owner, objectPath);
          requireEvidence(entry[1] === 200 && entry[2] !== null);
          data.objects.push([entry[0], entry[2]]);
        }
      }
      data.deletion = await client.rpc(owner, 'deletion_status', {});
      return data;
    };
    stage = 'delete-account-seed';
    const seededFor = {};
    for (const owner of [A, B]) {
      const h = imageChangeHarness(client, owner, env);
      const created = await h.create();
      seededFor[owner.label] = { h, created, paths: h.paths({ itemId: created.item.id, imageId: created.image.id }) };
    }
    const populated = (data, owner) => {
      const seed = seededFor[owner.label];
      return data.items.some((item) => item.id === seed.created.item.id && item.owner_id === owner.uid)
        && data.item_images.some((image) => image.id === seed.created.image.id && image.owner_id === owner.uid)
        && data.profiles.length === 1 && data.profiles[0].owner_id === owner.uid
        && seed.paths.every((objectPath) => data.objects.some(([p]) => p === objectPath))
        && data.objects.length === 2 * data.item_images.length;
    };
    const baseA = await inventory(A), baseB = await inventory(B);
    check(STACK, 'delete-account-fixtures-populated', populated(baseA, A) && populated(baseB, B),
      { A: { items: baseA.items.length, objects: baseA.objects.length }, B: { items: baseB.items.length, objects: baseB.objects.length } });
    stage = 'delete-account-negatives';
    const deleteAccount = (token, body) => fetch(`${LOCAL_API}/functions/v1/delete-account`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000),
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), apikey: env.SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, data: await response.json().catch(() => null) }));
    // Both owners are snapshotted immediately before and after every negative: A is the caller, B the target.
    const both = async () => ({ A: await inventory(A), B: await inventory(B) });
    const deletionStates = [{ A: baseA, B: baseB }];
    const around = async (call) => { const result = await call(); deletionStates.push(await both()); return result; };
    const wrong = await around(() => deleteAccount(A.token, { password: 'fictional-wrong-password-000000' }));
    const crossed = await around(() => deleteAccount(A.token, { password: env.TEST_B_PASSWORD }));
    const extra = await around(() => deleteAccount(A.token, { password: env.TEST_A_PASSWORD, ownerId: B.uid }));
    const anonymous = await around(() => deleteAccount(null, { password: env.TEST_B_PASSWORD }));
    check(STACK, 'delete-account-wrong-password', wrong.status === 403 && isDeepStrictEqual(wrong.data, { code: 'PASSWORD' }), summary(wrong));
    check(STACK, 'delete-account-other-owner-password', crossed.status === 403 && isDeepStrictEqual(crossed.data, { code: 'PASSWORD' }), summary(crossed));
    check(STACK, 'delete-account-owner-in-body', extra.status === 400 && isDeepStrictEqual(extra.data, { code: 'INVALID_INPUT' }), summary(extra));
    check(STACK, 'delete-account-anonymous', anonymous.status === 401, summary(anonymous));
    const frozenDelete = await around(frozenCall(B, () => deleteAccount(B.token, { password: env.TEST_B_PASSWORD })));
    check(STACK, 'delete-account-frozen-same-token', frozenDelete.status === 403
      && isDeepStrictEqual(frozenDelete.data, { state: 'not_available' }), summary(frozenDelete));
    check(STACK, 'delete-account-negatives-change-nothing', deletionStates.length === 6
      && deletionStates.every((state) => isDeepStrictEqual(state, deletionStates[0]))
      && isDeepStrictEqual(baseA.deletion, { state: 'none' }) && isDeepStrictEqual(baseB.deletion, { state: 'none' }), deletionStates.length);
    stage = 'delete-account-owned';
    const victimBefore = await inventory(A);
    const first = await deleteAccount(B.token, { password: env.TEST_B_PASSWORD });
    let gone = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const verified = await op('verify-deleted');
      if (verified.ok && verified.data.authUser === 0 && verified.data.objects === 0 && verified.data.profiles === 0
        && verified.data.items === 0 && verified.data.images === 0) { gone = verified.data; break; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const login = await client.request(null, '/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: env.TEST_B_EMAIL, password: env.TEST_B_PASSWORD } });
    const oldTokenItems = await client.request(B.token, `/rest/v1/items?id=eq.${seededFor.B.created.item.id}&select=id`);
    const oldTokenObject = await download(B, seededFor.B.paths[0]);
    check(STACK, 'delete-account-owned', [200, 202].includes(first.status)
      && ['complete', 'in_progress'].includes(first.data?.state) && gone !== null && gone.survivorAuth === 1 && !login.ok
      && (!oldTokenItems.ok || isDeepStrictEqual(oldTokenItems.data, [])) && oldTokenObject[2] === null,
    { first: summary(first), gone, login: login.status, items: oldTokenItems.status, object: oldTokenObject[1] });
    check(STACK, 'delete-account-victim-unchanged', isDeepStrictEqual(await inventory(A), victimBefore)
      && isDeepStrictEqual(victimBefore, baseA));
    stage = 'delete-account-cleanup';
    await seededFor.A.h.deleteItem(seededFor.A.created.value);
  } catch (error) {
    check(STACK, `stopped-at-${stage}`, false, error instanceof Error ? error.message.slice(0, 120) : 'error');
  } finally {
    for (const label of [...frozen]) {
      const restored = await op('restore', label);
      check(STACK, `restore-${label}`, restored.ok === true);
    }
  }
  for (const key of Object.keys(EDGE_DELEGATIONS)) {
    if (!passed.has(key)) check(STACK, `delegated-${key}`, false, 'the I17 audit delegated this surface here');
  }
  const failedCount = results.filter((r) => !r.ok).length;
  if (failedCount === 0) console.log(`PASS: EDGE-RUNTIME gate; ${results.length} labelled cases, all I17 delegations covered`);
  else console.error(`FAIL: EDGE-RUNTIME gate; ${failedCount} of ${results.length} cases failed`);
  process.exitCode = failedCount === 0 ? 0 : 1;
  process.disconnect?.();
}
main().catch(() => { console.error(`FAIL: EDGE-RUNTIME gate stopped at ${stage}`); process.exitCode = 1; process.disconnect?.(); });
