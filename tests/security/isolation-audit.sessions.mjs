// I17 owner-isolation audit. Every isolation, unchanged-data and byte assertion uses normal sessions over HTTP.
// The only privileged steps (freeze/restore of a fixed fictional owner) are requested from the runner over IPC.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertLocalApi, validateSessionEnvironment, reportError, LocalBackendError,
} from '../../scripts/backend/local.mjs';
import {
  EXPOSED_RPCS, SERVICE_ONLY_RPCS, PUBLIC_TABLES, RELATIONSHIP_NAMES, ACCEPTED_ORACLES, worstOracle, COVERAGE_REQUIREMENTS,
  matchOutcome, outcomeOf, sameOutcome, scanLeaks, validateCoverage, applicationCode, isInconclusive, classifyOracle,
  restoreThenCleanup, tupleConstructionProblems, fullOutcome, TAKEN_ID_SURFACES, takenIdProblems, stableExport,
} from '../../scripts/isolation-catalog.mjs';
import { normalClient } from '../integration/preservation.sessions.mjs';
import { intent, saveHarness } from '../integration/item-save.sessions.mjs';
import { imageChangeHarness } from '../integration/image-replacement.sessions.mjs';
import { classifyObjectDeletion } from '../../src/data/storage-delete.ts';
import { EDGE_DELEGATIONS, delegatedLine } from './edge-delegations.mjs';

try {
  validateSessionEnvironment(process.env);
  if (typeof process.send !== 'function') throw new LocalBackendError('NOT RUN: I17 audit needs the runner freeze controller.', 2);
} catch (error) { reportError(error); process.exit(2); }

const env = process.env;
const base = assertLocalApi(env.SUPABASE_URL), key = env.SUPABASE_PUBLISHABLE_KEY;
const client = normalClient(env);
const TABLES = Object.keys(PUBLIC_TABLES);
const ORDER = { profiles: 'owner_id', style_preferences: 'owner_id', outfit_items: 'outfit_id,item_id' };
const HEX = 'a'.repeat(64);
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let stage = 'configuration', freezeRequested = false;
const problems = [], findings = [], unverified = [], oracleFailures = [], covered = new Map();
const aiSelfMutated = { A: false, B: false };
const tag = (name, value) => { if (!covered.has(name)) covered.set(name, new Set()); covered.get(name).add(value); };
const control = (owner, name, ok, detail = '') => {
  if (need(ok, `${stage}: owned control ${name} failed ${detail}`)) tag(name, `${owner.label}:control`);
  return ok;
};
const note = (text) => { if (!unverified.includes(text)) unverified.push(text); };
const delegated = new Set();
const delegate = (key) => { need(Object.hasOwn(EDGE_DELEGATIONS, key), `unknown Edge delegation ${key}`); delegated.add(key); };
const need = (condition, label) => { if (!condition) problems.push(label); return condition; };
function fatal(condition, label = stage) { if (!condition) throw new Error(`I17_FATAL:${label}`); }
const describe = (result) => {
  const o = outcomeOf(result);
  const message = typeof o.message === 'string' ? o.message.replace(uuidPattern, '<id>').slice(0, 80) : '';
  return Object.hasOwn(o, 'data') ? `${o.status}` : `${o.status}/${o.code ?? '-'}${message ? ` "${message}"` : ''}`;
};

// --- Transport ------------------------------------------------------------------------------------
async function raw(token, route, { method = 'GET', body, binary = false, headers = {}, url = base + route } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { apikey: key, ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': binary ? 'image/jpeg' : 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
  } catch { return { ok: false, status: 0, data: null, text: '', transport: true }; }
  const buffer = Buffer.from(await response.arrayBuffer());
  fatal(buffer.length <= 2 * 1024 * 1024, 'response-size');
  const text = buffer.toString('utf8');
  let data = null;
  if (route.startsWith('/storage/v1/object/authenticated/') && response.ok) data = buffer;
  else if (text.length) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: response.ok, status: response.status, data, text: response.ok && Buffer.isBuffer(data) ? '' : text,
    range: response.headers.get('content-range') };
}
const rpcRoute = (name) => `/rest/v1/rpc/${name}`;
const call = (owner, name, body) => raw(owner?.token ?? null, rpcRoute(name), { method: 'POST', body });

let victimTokens = { A: [], B: [] };
/** Attacker request: records leaks of victim tokens that the attacker did not itself send. */
async function probe(attacker, victim, route, options = {}) {
  const result = await raw(attacker?.token ?? null, route, options);
  const sent = `${route} ${options.body === undefined || options.binary ? '' : JSON.stringify(options.body)}`.toLowerCase();
  const leaked = scanLeaks(result.text, victimTokens[victim.label], victimTokens[victim.label].filter((t) => sent.includes(String(t).toLowerCase())));
  need(leaked.length === 0, `${stage}: ${route.replace(uuidPattern, '<id>')} leaked ${leaked.length} peer value(s)`);
  if (result.status >= 500 || result.transport) problems.push(`${stage}: ${route.replace(uuidPattern, '<id>')} returned ${result.status}`);
  return result;
}
const probeRpc = (attacker, victim, name, body) => probe(attacker, victim, rpcRoute(name), { method: 'POST', body });

// --- IPC phases -------------------------------------------------------------------------------------
let nextPhase = 0;
const pendingPhases = new Map();
process.on('message', (message) => {
  if (message && message.type === 'ack' && pendingPhases.has(message.id)) pendingPhases.get(message.id)(message.ok === true);
});
function phase(name, owner) {
  if (name === 'freeze') freezeRequested = true;
  return new Promise((resolve, reject) => {
    const id = ++nextPhase;
    const timer = setTimeout(() => { pendingPhases.delete(id); reject(new Error(`I17_FATAL:${name}-timeout`)); },
      name === 'barrier' ? 150_000 : 75_000);
    pendingPhases.set(id, (ok) => {
      clearTimeout(timer); pendingPhases.delete(id);
      if (ok) resolve(true); else reject(new Error(`I17_FATAL:${name}-refused`));
    });
    process.send({ type: 'phase', id, phase: name, owner });
  });
}

// --- Fixtures ---------------------------------------------------------------------------------------
// Each ownership-sensitive RPC gets a victim fixture in the state where the owner's own call would act, plus a
// successful owned control recorded as `<owner>:control` coverage.
const fixtures = {};
const cleanups = [];
async function removeObject(owner, path) {
  const result = await raw(owner.token, `/storage/v1/object/wardrobe/${path}`, { method: 'DELETE' });
  fatal(['removed', 'missing'].includes(classifyObjectDeletion(result)), 'fixture-object-remove');
}
function deletionSteps(owner, ich) {
  const trashed = async () => {
    const d = await ich.create();
    await client.rpc(owner, 'set_item_trashed', { p_item_id: d.item.id, p_expected_version: d.item.version, p_trashed: true });
    const status = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [d.item.id] }))[0];
    fatal(status && status.id === d.item.id, 'fixture-deletion-status');
    return { d, status, args: { p_item_id: d.item.id, p_request_id: randomUUID() } };
  };
  const prepare = (t) => client.rpc(owner, 'prepare_item_deletion', { ...t.args, p_expected_version: t.status.version,
    p_image_manifest_sha256: t.status.image_manifest_sha256 });
  const inventory = async (t, operation) => {
    let op = operation;
    for (let page = 0; page < 6 && op.phase === 'preparing'; page++) op = await client.rpc(owner, 'inventory_item_deletion', t.args);
    fatal(op.phase === 'prepared' && /^[0-9a-f]{64}$/.test(op.inventoryHash), 'fixture-deletion-inventory');
    return op;
  };
  const drain = async (t) => {
    for (let n = 0; n < 12; n++) {
      const target = await client.rpc(owner, 'item_deletion_next_target', t.args);
      if (target === null) return;
      await removeObject(owner, target.path);
      await client.rpc(owner, 'reconcile_item_deletion_target', { ...t.args, p_ordinal: target.ordinal });
    }
    fatal(false, 'fixture-deletion-drain');
  };
  // The known-good ordinary-owner path from the paged deletion suite; used for cleanup of advanced operations.
  const complete = async (t) => {
    let op = await client.rpc(owner, 'item_deletion_operation_status', t.args);
    if (op === null) op = await prepare(t);
    if (op.phase === 'preparing') op = await inventory(t, op);
    if (op.phase === 'prepared') op = await client.rpc(owner, 'authorize_item_deletion', { ...t.args, p_inventory_hash: op.inventoryHash });
    if (op.phase === 'authorized') { await drain(t); await client.rpc(owner, 'begin_prepared_item_deletion', t.args); }
    await drain(t);
    fatal(isDeepStrictEqual(await client.rpc(owner, 'finish_item_deletion', t.args), [{ state: 'completed' }]), 'cleanup-deletion-finish');
  };
  return { trashed, prepare, inventory, drain, complete };
}

async function buildFixture(owner) {
  const L = owner.label, sh = saveHarness(client, owner), ich = imageChangeHarness(client, owner, env);
  const f = { uid: owner.uid, paths: [] };
  stage = `fixture-${L}-legacy`;
  const v1 = intent();
  v1.p_item.title = `Isolation canary ${L} garment`;
  await client.insert(owner, 'items', v1.p_item);
  const sibling = () => ({ p_item: v1.p_item, p_image: intent().p_image });
  const v2 = sibling(), vRetire = sibling(), vForget = sibling(), vPending = sibling();
  cleanups.push(async () => { for (const value of [vPending, vRetire, v2, v1]) await sh.remove(value); await sh.deleteItem(v1); });
  for (const value of [v1, v2]) {
    await client.insert(owner, 'item_images', { ...value.p_image, item_id: v1.p_item.id });
    await sh.upload(value);
    await client.rpc(owner, 'commit_image', { p_image_id: value.p_image.id });
    f.paths.push(...sh.paths(value));
  }
  control(owner, 'commit_image', true);
  await client.insert(owner, 'item_images', { ...vRetire.p_image, item_id: v1.p_item.id });
  await sh.upload(vRetire);
  control(owner, 'retire_image', (await call(owner, 'retire_image', { p_image_id: vRetire.p_image.id })).status === 204);
  await client.insert(owner, 'item_images', { ...vForget.p_image, item_id: v1.p_item.id });
  const forgot = await call(owner, 'forget_image', { p_image_id: vForget.p_image.id });
  control(owner, 'forget_image', forgot.status === 204 && (await sh.read('item_images', vForget.p_image.id)).length === 0);
  // A pending, fully uploaded legacy image: the state in which the owner's commit/retire would act.
  await client.insert(owner, 'item_images', { ...vPending.p_image, item_id: v1.p_item.id });
  await sh.upload(vPending);
  f.paths.push(...sh.paths(vRetire), ...sh.paths(vPending));
  const described = await call(owner, 'update_image_description', { p_image_id: v2.p_image.id,
    p_expected_description_version: 1, p_alt_text: `Isolation description ${L}` });
  control(owner, 'update_image_description', described.ok && described.data?.[0]?.description_version === 2, describe(described));
  f.imageDescVersion = 2;
  f.item = v1.p_item.id; f.retired = v1.p_image.id; f.image = v2.p_image.id; f.pendingImage = vPending.p_image.id;
  f.retireOwn = vRetire.p_image.id;
  const images = await sh.read('item_images', f.retired);
  fatal(images.length === 1 && images[0].state === 'retired', `fixture-${L}-retired`);

  stage = `fixture-${L}-history`;
  const plain = await client.insert(owner, 'items', { id: randomUUID(), title: `Isolation plain ${L}`, category: 'bottom' });
  f.plain = plain.id; f.outfit = randomUUID(); f.event = randomUUID();
  cleanups.push(async () => {
    for (const [table, id] of [['wear_events', f.event], ['outfits', f.outfit], ['combination_rules', f.rule],
      ['suggestion_feedback', f.feedback], ['items', f.plain]]) {
      if (id) fatal((await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' })).ok, 'cleanup');
    }
  });
  await client.rpc(owner, 'save_outfit', { p_id: f.outfit, p_title: `Isolation outfit ${L}`, p_occasion: 'everyday',
    p_notes: '', p_favourite: false, p_item_ids: [f.item, f.plain], p_expected_version: null });
  control(owner, 'save_outfit', true);
  await client.rpc(owner, 'save_wear_event', { p_id: f.event, p_local_date: '2026-01-01', p_timezone: 'Europe/Helsinki',
    p_state: 'worn', p_label: `Isolation look ${L}`, p_outfit_id: f.outfit, p_item_ids: [f.item], p_expected_version: null });
  control(owner, 'save_wear_event', true);
  const history = await client.request(owner.token, `/rest/v1/wear_event_items?owner_id=eq.${owner.uid}&event_id=eq.${f.event}&select=*`);
  fatal(history.ok && Array.isArray(history.data) && history.data.length === 1, `fixture-${L}-wear-items`);
  f.eventItem = history.data[0].id;
  const pair = [f.item, f.plain].sort();
  for (const [table, body, field] of [['combination_rules', { item_low: pair[0], item_high: pair[1] }, 'rule'],
    ['suggestion_feedback', { item_ids: pair, vote: -1 }, 'feedback']]) {
    const result = await client.request(owner.token, `/rest/v1/${table}`, { method: 'POST',
      body: { ...body, owner_id: owner.uid }, headers: { Prefer: 'return=representation' } });
    fatal(result.ok && Array.isArray(result.data) && result.data.length === 1, `fixture-${L}-${table}`);
    f[field] = result.data[0].id;
  }

  stage = `fixture-${L}-image-change`;
  const changeBase = await ich.create();
  control(owner, 'reserve_item_save', true);
  control(owner, 'finalize_item_save', true);
  const change = ich.make(changeBase.item, changeBase.image);
  cleanups.push(async () => {
    await client.rpc(owner, 'cancel_image_change', { p_item_id: change.itemId, p_request_id: change.requestId });
    await ich.remove(change);
    await ich.remove({ itemId: changeBase.item.id, imageId: changeBase.image.id });
    await sh.deleteItem(changeBase.value);
  });
  await ich.reserve(change);
  control(owner, 'reserve_image_change', true);
  // Uploaded replacement objects: the state in which the owner's preflight (and finalize) would act.
  await ich.upload(change);
  const preflight = await call(owner, 'image_change_preflight', { p_intent: change });
  control(owner, 'image_change_preflight', preflight.ok && preflight.data?.state === 'reserved', describe(preflight));
  f.changeItem = change.itemId; f.changeRequest = change.requestId; f.changeImage = change.imageId;
  f.changeCurrent = changeBase.image.id; f.changeIntent = change;
  f.paths.push(...ich.paths({ itemId: changeBase.item.id, imageId: changeBase.image.id }), ...ich.paths(change));
  const cancelBase = await ich.create(), cancelled = ich.make(cancelBase.item, cancelBase.image);
  cleanups.push(async () => {
    await ich.remove({ itemId: cancelBase.item.id, imageId: cancelBase.image.id });
    await sh.deleteItem(cancelBase.value);
  });
  await ich.reserve(cancelled);
  const cancel = await call(owner, 'cancel_image_change', { p_item_id: cancelled.itemId, p_request_id: cancelled.requestId });
  control(owner, 'cancel_image_change', cancel.ok && cancel.data?.state === 'cancelled', describe(cancel));
  // No active reservation remains on this item: the state in which the owner's reserve_image_change would act.
  const freeItem = (await sh.read('items', cancelBase.item.id))[0], freeImage = (await sh.read('item_images', cancelBase.image.id))[0];
  fatal(freeItem && freeImage?.state === 'ready', `fixture-${L}-free-item`);
  f.freeItem = freeItem.id; f.freeVersion = freeItem.version; f.freeCurrent = freeImage.id;
  f.freeIntent = ich.make(freeItem, freeImage);
  f.paths.push(...ich.paths({ itemId: freeItem.id, imageId: freeImage.id }));

  stage = `fixture-${L}-recovery`;
  const rec = await ich.create();
  const source = { ...rec.value.p_image, id: randomUUID(), item_id: rec.item.id };
  cleanups.push(async () => {
    await ich.remove({ itemId: rec.item.id, imageId: source.id });
    await ich.remove({ itemId: rec.item.id, imageId: rec.image.id });
    await sh.deleteItem(rec.value);
  });
  await client.insert(owner, 'item_images', source);
  await ich.upload({ itemId: rec.item.id, imageId: source.id });
  await client.rpc(owner, 'retire_image', { p_image_id: source.id });
  const retiredSource = (await sh.read('item_images', source.id))[0];
  fatal(retiredSource?.state === 'retired', `fixture-${L}-recovery-source`);
  const recovery = ich.make((await sh.read('items', rec.item.id))[0], (await sh.read('item_images', rec.image.id))[0], retiredSource);
  const versions = await call(owner, 'image_recovery_versions', { p_item_id: rec.item.id, p_after: null });
  control(owner, 'image_recovery_versions', versions.ok && Array.isArray(versions.data)
    && versions.data.some((entry) => entry.image?.id === source.id));
  const recoveryCheck = await call(owner, 'image_recovery_preflight', { p_intent: recovery });
  control(owner, 'image_recovery_preflight', recoveryCheck.ok && recoveryCheck.data?.state === 'source', describe(recoveryCheck));
  f.recItem = rec.item.id; f.recCurrent = rec.image.id; f.recSource = source.id; f.recIntent = recovery;
  f.paths.push(...ich.paths({ itemId: rec.item.id, imageId: rec.image.id }), ...ich.paths({ itemId: rec.item.id, imageId: source.id }));

  stage = `fixture-${L}-deletion`;
  const del = deletionSteps(owner, ich);
  // Trashed, no operation: the owner's begin/prepare would claim it.
  const trash = await del.trashed();
  control(owner, 'set_item_trashed', true);
  cleanups.push(() => del.complete(trash));
  f.trashItem = trash.args.p_item_id; f.trashVersion = trash.status.version; f.trashManifest = trash.status.image_manifest_sha256;
  // Legacy claim, removal and finish: owned controls only.
  const legacy = await del.trashed();
  const claim = await call(owner, 'begin_item_deletion', { ...legacy.args, p_expected_version: legacy.status.version,
    p_image_manifest_sha256: legacy.status.image_manifest_sha256 });
  control(owner, 'begin_item_deletion', claim.ok, describe(claim));
  for (const path of ich.paths({ itemId: legacy.d.item.id, imageId: legacy.d.image.id })) await removeObject(owner, path);
  const finished = await call(owner, 'finish_item_deletion', legacy.args);
  control(owner, 'finish_item_deletion', matchOutcome({ status: 200, data: [{ state: 'completed' }] }, finished), describe(finished));
  // Prepared then cancelled: owned cancellation control.
  const cancelledDeletion = await del.trashed();
  const prepared = await del.prepare(cancelledDeletion);
  control(owner, 'prepare_item_deletion', prepared?.phase === 'preparing');
  const cancelDeletion = await call(owner, 'cancel_item_deletion_preparation', cancelledDeletion.args);
  control(owner, 'cancel_item_deletion_preparation', cancelDeletion.ok, describe(cancelDeletion));
  cleanups.push(async () => {
    await ich.remove({ itemId: cancelledDeletion.d.item.id, imageId: cancelledDeletion.d.image.id });
    await sh.deleteItem(cancelledDeletion.d.value);
  });
  // Preparing: the victim state for inventory, cancellation and status lookups.
  const preparing = await del.trashed();
  await del.prepare(preparing);
  cleanups.push(async () => {
    fatal((await call(owner, 'cancel_item_deletion_preparation', preparing.args)).ok, 'cleanup-deletion-cancel');
    await ich.remove({ itemId: preparing.d.item.id, imageId: preparing.d.image.id });
    await sh.deleteItem(preparing.d.value);
  });
  f.prepItem = preparing.args.p_item_id; f.prepRequest = preparing.args.p_request_id;
  // Prepared (inventoried, not authorized): the victim state for authorization with the real inventory hash.
  const ready = await del.trashed();
  cleanups.push(() => del.complete(ready));
  const inventoried = await del.inventory(ready, await del.prepare(ready));
  control(owner, 'inventory_item_deletion', true);
  f.readyItem = ready.args.p_item_id; f.readyRequest = ready.args.p_request_id; f.readyHash = inventoried.inventoryHash;
  // Removing registered targets with one removed but unreconciled target: the victim state for next-target,
  // reconcile, begin-prepared replay and finish.
  const removing = await del.trashed();
  cleanups.push(() => del.complete(removing));
  const removeInventory = await del.inventory(removing, await del.prepare(removing));
  const authorized = await call(owner, 'authorize_item_deletion', { ...removing.args, p_inventory_hash: removeInventory.inventoryHash });
  control(owner, 'authorize_item_deletion', authorized.ok && authorized.data?.phase === 'authorized', describe(authorized));
  await del.drain(removing);
  const begun = await call(owner, 'begin_prepared_item_deletion', removing.args);
  control(owner, 'begin_prepared_item_deletion', begun.ok && begun.data?.phase === 'removing_registered', describe(begun));
  const first = await call(owner, 'item_deletion_next_target', removing.args);
  const replay = await call(owner, 'item_deletion_next_target', removing.args);
  control(owner, 'item_deletion_next_target', first.ok && first.data !== null && isDeepStrictEqual(first.data, replay.data));
  fatal(first.ok && first.data !== null, `fixture-${L}-first-target`);
  await removeObject(owner, first.data.path);
  const reconciled = await call(owner, 'reconcile_item_deletion_target', { ...removing.args, p_ordinal: first.data.ordinal });
  control(owner, 'reconcile_item_deletion_target',
    matchOutcome({ status: 200, data: { ordinal: first.data.ordinal, state: 'reconciled_absent' } }, reconciled), describe(reconciled));
  const second = await call(owner, 'item_deletion_next_target', removing.args);
  fatal(second.ok && second.data !== null && second.data.ordinal !== first.data.ordinal, `fixture-${L}-second-target`);
  await removeObject(owner, second.data.path);
  f.removeItem = removing.args.p_item_id; f.removeRequest = removing.args.p_request_id; f.removeOrdinal = second.data.ordinal;

  stage = `fixture-${L}-pending-save`;
  // Reserved and fully uploaded: the owner's finalize would complete it.
  const pending = sh.track(intent());
  cleanups.push(() => sh.cleanup());
  const row = await sh.reserve(pending);
  await sh.upload(pending);
  f.saveItem = pending.p_item.id; f.saveImage = pending.p_image.id; f.saveFingerprint = row.fingerprint;

  stage = `fixture-${L}-ai`;
  f.aiRequest = randomUUID(); f.aiDraft = randomUUID();
  const aiBegin = await call(owner, 'ai_begin_request', { p_request_id: f.aiRequest, p_draft_id: f.aiDraft,
    p_generation: 1, p_image_sha256: HEX });
  f.aiBegin = outcomeOf(aiBegin);
  if (matchOutcome({ status: 200, data: { code: 'OK', status: 'reserved', replayed: false } }, aiBegin)) {
    control(owner, 'ai_begin_request', true);
    cleanups.push(async () => {
      const discarded = await call(owner, 'ai_request_control', { p_request_id: f.aiRequest, p_action: 'discard' });
      fatal(applicationCode(discarded) === 'TERMINAL', 'cleanup-ai-discard');
    });
  } else {
    note(`AI fixture ${L}: own ai_begin_request returned ${applicationCode(aiBegin) ?? describe(aiBegin)}; AI request surfaces not ownership-verified`);
    f.aiRequest = null;
  }
  f.itemVersion = (await sh.read('items', f.item))[0].version;
  f.tokens = [owner.uid, f.item, f.retired, f.image, f.pendingImage, f.retireOwn, f.plain, f.outfit, f.event, f.eventItem,
    f.rule, f.feedback, f.changeItem, f.changeRequest, f.changeImage, f.changeCurrent, f.recItem, f.recSource,
    f.trashItem, f.trashManifest, f.prepItem, f.prepRequest, f.readyItem, f.readyRequest, f.readyHash, f.removeItem,
    f.removeRequest, f.saveItem, f.saveImage, f.saveFingerprint, f.aiRequest, f.aiDraft, f.freeItem, f.freeCurrent,
    f.recCurrent, `Isolation canary ${L}`,
    `Isolation plain ${L}`, `Isolation outfit ${L}`, `Isolation look ${L}`, `Isolation description ${L}`].filter(Boolean);
  return f;
}

// --- Owner state (normal session only) --------------------------------------------------------------
async function readAll(owner, table, token = owner.token) {
  const rows = [];
  for (let offset = 0; ; offset += 50) {
    fatal(offset <= 5000, `paginate-${table}`);
    const result = await raw(token, `/rest/v1/${table}?select=*&order=${ORDER[table] ?? 'id'}&limit=50&offset=${offset}`,
      { headers: { Prefer: 'count=exact' } });
    fatal(result.ok && Array.isArray(result.data), `read-${table}`);
    rows.push(...result.data);
    const total = Number(String(result.range ?? '').split('/')[1]);
    if (result.data.length < 50) { fatal(total === rows.length, `count-${table}`); return rows; }
  }
}
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function objectState(owner, path, token = owner.token) {
  const result = await raw(token, `/storage/v1/object/authenticated/wardrobe/${path}`);
  return result.ok && Buffer.isBuffer(result.data) ? sha(result.data) : `denied-${result.status}`;
}
async function ownerState(owner) {
  const f = fixtures[owner.label], state = { tables: {}, objects: {} };
  for (const table of TABLES) state.tables[table] = await readAll(owner, table);
  for (const path of f.paths) state.objects[path] = await objectState(owner, path);
  const exported = (await call(owner, 'export_manifest', { p_export_id: randomUUID() })).data;
  fatal(exported && typeof exported === 'object', 'state-export');
  state.export = stableExport(exported);
  const read = async (name, body) => outcomeOf(await call(owner, name, body));
  state.change = await read('image_change_status', { p_item_id: f.changeItem, p_request_id: f.changeRequest });
  state.requests = await read('image_change_requests', { p_item_id: f.changeItem });
  state.recovery = await read('image_recovery_versions', { p_item_id: f.recItem, p_after: null });
  state.attribution = [await read('item_attribution_history', { p_item_id: f.item }),
    await read('item_attribution_history', { p_item_id: f.changeItem })];
  state.operation = [];
  for (const [item, request] of [[f.prepItem, f.prepRequest], [f.readyItem, f.readyRequest], [f.removeItem, f.removeRequest]]) {
    state.operation.push(await read('item_deletion_operation_status', { p_item_id: item, p_request_id: request }));
  }
  state.deletion = await read('item_deletion_status', { p_item_ids: [f.item, f.trashItem, f.prepItem, f.readyItem, f.removeItem] });
  const ai = (await call(owner, 'ai_status', {})).data;
  if (ai && typeof ai === 'object') { const rest = { ...ai }; delete rest.serverTimeMs; state.ai = rest; } else state.ai = ai;
  state.request = f.aiRequest ? await read('ai_request_control', { p_request_id: f.aiRequest, p_action: 'status' }) : null;
  return state;
}
/** `skipAi` only excuses the owner's own AI accounting after it legitimately made its own reservation. */
function compareState(label, before, after, { skipAi = false } = {}) {
  for (const table of TABLES) need(isDeepStrictEqual(before.tables[table], after.tables[table]), `${label}: ${table} rows changed`);
  need(isDeepStrictEqual(before.objects, after.objects), `${label}: object bytes changed`);
  const parts = ['export', 'change', 'requests', 'recovery', 'attribution', 'operation', 'deletion', ...(skipAi ? [] : ['ai', 'request'])];
  for (const part of parts) need(isDeepStrictEqual(before[part], after[part]), `${label}: ${part} changed`);
}

// --- Expected outcomes ------------------------------------------------------------------------------
const NA = { status: 403, code: '42501', message: 'Not available' };
const NA_PLAIN = { status: 400, code: 'P0001', message: 'Not available' };
const CONFLICT = { status: 400, code: '22023', message: 'Request conflict' };
const CONFLICT_PLAIN = { status: 400, code: 'P0001', message: 'Request conflict' };
const SELECTION = { status: 400, code: 'P0001', message: 'Invalid selection' };
const UNAVAILABLE = { status: 200, data: { code: 'UNAVAILABLE' } };
const NULL = { status: 200, data: null }, EMPTY = { status: 200, data: [] }, VOID = { status: 204, data: null };
const expectMatch = (label, expected, result) => {
  const ok = expected.check ? result.status === expected.status && expected.check(result.data) : matchOutcome(expected, result);
  return need(ok, `${label}: expected ${expected.status}/${expected.code ?? ''}, observed ${describe(result)}`);
};
const hex64 = /^[0-9a-f]{64}$/;
const randomLike = (value) => (hex64.test(String(value)) ? randomBytes(32).toString('hex') : randomUUID());

/**
 * Per-signature foreign-reference cases. Each `refs` key is substituted on its own with the victim's value (plus
 * any `bundle` values the victim's real state needs), everything else stays the attacker's; the nonexistent
 * counterpart randomizes only that key. For `tuple` requirements the complete valid peer tuple (all refs, their
 * bundles and `tupleBundle`) is also probed against an all-random tuple. `mixed` builds an own+peer array.
 * Cases match COVERAGE_REQUIREMENTS.
 */
function foreignCases(a) {
  const n1 = randomUUID(), n2 = randomUUID();
  const one = (name, refs, build, expected, extra = {}) => ({ name, refs, build, expected, ...extra });
  const pair = (k) => (x) => ({ p_item_id: x[k[0]], p_request_id: x[k[1]] });
  const outfit = (x, k) => (k === 'outfit'
    ? { p_id: x.outfit, p_title: 'Forbidden', p_occasion: 'everyday', p_notes: '', p_favourite: false, p_item_ids: [a.item], p_expected_version: 1 }
    : { p_id: n1, p_title: 'Forbidden', p_occasion: 'everyday', p_notes: '', p_favourite: false, p_item_ids: [x.item], p_expected_version: null });
  const wear = (x, k) => ({ p_id: k === 'event' ? x.event : n1, p_local_date: '2026-01-02', p_timezone: 'Europe/Helsinki',
    p_state: 'worn', p_label: 'Forbidden', p_outfit_id: k === 'outfit' ? x.outfit : null,
    p_item_ids: k === 'item' ? [x.item] : [a.item], p_expected_version: k === 'event' ? 1 : null });
  const wearMixed = (x) => ({ ...wear(a, 'item'), p_item_ids: [a.item, x.item] });
  const ownedOne = (id) => ({ status: 200, check: (d) => Array.isArray(d) && d.length === 1 && (d[0].id ?? d[0].itemId) === id });
  // Intents start from x's own complete intent: the attacker's for single substitutions, the victim's for the
  // tuple (its `tupleBundle` carries the victim intent), so every fingerprint-bound field belongs to one owner.
  const changeIntent = (x) => { const v = structuredClone(x.changeIntent); v.requestId = x.changeRequest; v.itemId = x.changeItem;
    v.imageId = x.changeImage; v.image.id = x.changeImage; return v; };
  const recoveryIntent = (x) => { const v = structuredClone(x.recIntent); v.itemId = x.recItem; v.currentImageId = x.recCurrent;
    v.sourceImageId = x.recSource; return v; };
  const freeIntent = (x) => { const v = structuredClone(x.freeIntent); v.itemId = x.freeItem; v.expectedVersion = x.freeVersion;
    v.currentImageId = x.freeCurrent; return v; };
  const deletion = (x) => ({ p_item_id: x.trashItem, p_request_id: n1, p_expected_version: x.trashVersion, p_image_manifest_sha256: x.trashManifest });
  const trashBundle = { trashItem: ['trashVersion', 'trashManifest'] };
  return [
    one('commit_image', ['pendingImage', 'image'], (x, k) => ({ p_image_id: x[k] }), NA),
    one('retire_image', ['pendingImage', 'image'], (x, k) => ({ p_image_id: x[k] }), NA_PLAIN),
    one('forget_image', ['retired'], (x) => ({ p_image_id: x.retired }), VOID),
    one('update_image_description', ['image'], (x) => ({ p_image_id: x.image, p_expected_description_version: x.imageDescVersion,
      p_alt_text: 'Forbidden' }), NA, { bundle: { image: ['imageDescVersion'] } }),
    one('item_attribution_history', ['item', 'changeItem'], (x, k) => ({ p_item_id: x[k] }), NA),
    one('image_recovery_versions', ['recItem'], (x) => ({ p_item_id: x.recItem, p_after: null }), NA),
    one('restore_history_entry', ['event', 'item'], (x, k) => ({ p_id: n1, p_event_id: k === 'event' ? x.event : a.event,
      p_item_id: k === 'item' ? x.item : null, p_title: 'Forbidden', p_category: 'top', p_import_id: n2 }), NA),
    one('save_outfit', ['item', 'outfit'], outfit, (k) => (k === 'outfit' ? CONFLICT_PLAIN : SELECTION),
      { mixed: (x) => ({ ...outfit(a, 'item'), p_item_ids: [a.item, x.item] }), mixedKey: 'item', mixedExpected: SELECTION }),
    one('save_wear_event', ['item', 'event', 'outfit'], wear,
      (k) => (k === 'event' ? CONFLICT_PLAIN : k === 'outfit' ? { status: 409, code: '23503' } : SELECTION),
      { mixed: wearMixed, mixedKey: 'item', mixedExpected: SELECTION }),
    one('ai_request_control', ['aiRequest'], (x) => ({ p_request_id: x.aiRequest, p_action: 'status' }), UNAVAILABLE,
      { runtime: true, also: (x) => ({ p_request_id: x.aiRequest, p_action: 'discard' }) }),
    one('ai_analysis_status', ['aiRequest'], (x) => ({ p_request_id: x.aiRequest }), UNAVAILABLE, { runtime: true }),
    one('finalize_item_save', ['saveItem', 'saveImage', 'saveFingerprint'],
      (x) => ({ p_item_id: x.saveItem, p_image_id: x.saveImage, p_fingerprint: x.saveFingerprint }), CONFLICT),
    one('set_item_trashed', ['item'], (x) => ({ p_item_id: x.item, p_expected_version: x.itemVersion, p_trashed: true }), CONFLICT,
      { bundle: { item: ['itemVersion'] } }),
    one('item_deletion_status', ['item'], (x) => ({ p_item_ids: [x.item] }), EMPTY,
      { mixed: (x) => ({ p_item_ids: [a.item, x.item] }), mixedKey: 'item', mixedExpected: ownedOne(a.item) }),
    one('begin_item_deletion', ['trashItem'], deletion, CONFLICT, { bundle: trashBundle }),
    one('prepare_item_deletion', ['trashItem'], deletion, CONFLICT, { bundle: trashBundle }),
    one('finish_item_deletion', ['removeItem', 'removeRequest'], pair(['removeItem', 'removeRequest']),
      (k) => (k === 'removeItem' ? { status: 200, data: [{ state: 'absent' }] } : CONFLICT)),
    one('reserve_image_change', ['freeItem', 'freeCurrent'], (x) => ({ p_intent: freeIntent(x) }), CONFLICT,
      { bundle: { freeItem: ['freeVersion'] }, tupleBundle: ['freeIntent'], tupleIntent: 'freeIntent' }),
    one('image_change_status', ['changeItem', 'changeRequest'], pair(['changeItem', 'changeRequest']), NULL),
    one('restore_image_change_status', ['changeItem', 'changeRequest'], pair(['changeItem', 'changeRequest']), NULL),
    one('restore_item_save_status', ['saveItem'], (x) => ({ p_item_id: x.saveItem }), NULL),
    one('image_change_requests', ['changeItem'], (x) => ({ p_item_id: x.changeItem }), EMPTY),
    one('image_recovery_preflight', ['recItem', 'recCurrent', 'recSource'], (x) => ({ p_intent: recoveryIntent(x) }), CONFLICT,
      { tupleBundle: ['recIntent'], tupleIntent: 'recIntent' }),
    one('image_change_preflight', ['changeRequest', 'changeItem', 'changeImage'], (x) => ({ p_intent: changeIntent(x) }), CONFLICT,
      { tupleBundle: ['changeIntent'], tupleIntent: 'changeIntent' }),
    one('cancel_image_change', ['changeItem', 'changeRequest'], pair(['changeItem', 'changeRequest']), NULL),
    one('item_deletion_operation_status', ['prepItem', 'prepRequest'], pair(['prepItem', 'prepRequest']), NULL),
    one('item_deletion_operations', ['prepItem'], (x) => ({ p_item_ids: [x.prepItem] }), EMPTY,
      { mixed: (x) => ({ p_item_ids: [a.prepItem, x.prepItem] }), mixedKey: 'prepItem', mixedExpected: ownedOne(a.prepItem) }),
    one('inventory_item_deletion', ['prepItem', 'prepRequest'], pair(['prepItem', 'prepRequest']), CONFLICT),
    one('cancel_item_deletion_preparation', ['prepItem', 'prepRequest'], pair(['prepItem', 'prepRequest']), CONFLICT),
    one('authorize_item_deletion', ['readyItem', 'readyRequest', 'readyHash'],
      (x) => ({ p_item_id: x.readyItem, p_request_id: x.readyRequest, p_inventory_hash: x.readyHash }), CONFLICT),
    one('item_deletion_next_target', ['removeItem', 'removeRequest'], pair(['removeItem', 'removeRequest']), CONFLICT),
    one('reconcile_item_deletion_target', ['removeItem', 'removeRequest'],
      (x) => ({ p_item_id: x.removeItem, p_request_id: x.removeRequest, p_ordinal: x.removeOrdinal }), CONFLICT,
      { tupleBundle: ['removeOrdinal'] }),
    one('begin_prepared_item_deletion', ['removeItem', 'removeRequest'], pair(['removeItem', 'removeRequest']), CONFLICT),
  ];
}

async function foreignMatrix(attacker, victim) {
  const a = fixtures[attacker.label], v = fixtures[victim.label], d = `${attacker.label}>${victim.label}`;
  for (const test of foreignCases(a)) {
    const controlled = covered.get(test.name)?.has(`${attacker.label}:control`) === true;
    const runnable = test.refs.every((k) => v[k] !== null && v[k] !== undefined && a[k] !== null && a[k] !== undefined);
    if (test.runtime && (!controlled || !runnable)) {
      tag(test.name, `${d}:unverified`);
      if (test.name === 'ai_analysis_status') { delegate('analysis-status-owned'); delegate('analyze-foreign'); }
      else note(`${test.name} ${d}: no successful owned control in this job; foreign lookups asserted but not counted as ownership proof`);
    }
    need(runnable || test.runtime, `matrix-${d}-${test.name}: fixture reference missing`);
    if (!runnable) continue;
    for (const k of test.refs) {
      stage = `matrix-${d}-${test.name}-${k}`;
      const bundle = Object.fromEntries((test.bundle?.[k] ?? []).map((key) => [key, v[key]]));
      const foreignX = { ...a, ...bundle, [k]: v[k] }, missingX = { ...a, ...bundle, [k]: randomLike(v[k]) };
      const expected = typeof test.expected === 'function' ? test.expected(k) : test.expected;
      const builds = [test.build, ...(test.also ? [test.also] : [])];
      let ok = true;
      for (const build of builds) {
        const foreign = await probeRpc(attacker, victim, test.name, build(foreignX, k));
        const missing = await probeRpc(attacker, victim, test.name, build(missingX, k));
        ok = expectMatch(`${stage} foreign`, expected, foreign) && ok;
        ok = expectMatch(`${stage} nonexistent`, expected, missing) && ok;
        ok = need(sameOutcome(foreign, missing, [v[k]], [missingX[k]]),
          `${stage}: foreign ${describe(foreign)} differs from nonexistent ${describe(missing)}`) && ok;
      }
      if (ok && !(test.runtime && !controlled)) tag(test.name, `${d}:ref:${k}`);
    }
    if (COVERAGE_REQUIREMENTS[test.name]?.tuple) {
      // The complete valid peer tuple names a real peer row; mixed pairs alone cannot prove the owner predicate.
      stage = `matrix-${d}-${test.name}-tuple`;
      const keys = [...test.refs, ...test.refs.flatMap((k) => test.bundle?.[k] ?? []), ...(test.tupleBundle ?? [])];
      const foreignX = { ...a, ...Object.fromEntries(keys.map((key) => [key, v[key]])) };
      const missingX = { ...foreignX, ...Object.fromEntries(test.refs.map((k) => [k, randomLike(v[k])])) };
      const expected = test.tupleExpected ?? (typeof test.expected === 'function' ? test.expected(test.refs[0]) : test.expected);
      let ok = true;
      for (const build of [test.build, ...(test.also ? [test.also] : [])]) {
        const payload = build(foreignX, test.refs[0]);
        const construction = tupleConstructionProblems(test.name, payload, a, v, test.tupleIntent);
        ok = need(construction.length === 0, `${stage}: ${construction.join('; ')}`) && ok;
        if (construction.length) continue;
        const foreign = await probeRpc(attacker, victim, test.name, payload);
        const missing = await probeRpc(attacker, victim, test.name, build(missingX, test.refs[0]));
        ok = expectMatch(`${stage} foreign`, expected, foreign) && ok;
        ok = expectMatch(`${stage} nonexistent`, expected, missing) && ok;
        ok = need(sameOutcome(foreign, missing, test.refs.map((k) => v[k]), test.refs.map((k) => missingX[k])),
          `${stage}: foreign ${describe(foreign)} differs from nonexistent ${describe(missing)}`) && ok;
      }
      if (ok && !(test.runtime && !controlled)) tag(test.name, `${d}:tuple`);
    }
    if (test.mixed) {
      stage = `matrix-${d}-${test.name}-mixed`;
      const random = randomUUID();
      const foreign = await probeRpc(attacker, victim, test.name, test.mixed(v));
      const missing = await probeRpc(attacker, victim, test.name, test.mixed({ ...v, [test.mixedKey]: random }));
      const foreignOk = expectMatch(`${stage} foreign`, test.mixedExpected, foreign);
      const missingOk = expectMatch(`${stage} nonexistent`, test.mixedExpected, missing);
      const same = need(sameOutcome(foreign, missing, [v[test.mixedKey]], [random]),
        `${stage}: foreign ${describe(foreign)} differs from nonexistent ${describe(missing)}`);
      if (foreignOk && missingOk && same) tag(test.name, `${d}:mixed`);
    }
  }
  await analyzedSaveProbes(attacker, victim);
  stage = `matrix-${d}-owner-only`;
  const exported = await probeRpc(attacker, victim, 'export_manifest', { p_export_id: randomUUID() });
  if (exportShape(attacker, exported)) { control(attacker, 'export_manifest', true); tag('export_manifest', `${d}:owner-only`); }
  const status = await probeRpc(attacker, victim, 'ai_status', {});
  if (control(attacker, 'ai_status', status.ok && status.data !== null && typeof status.data === 'object'
    && applicationCode(status) !== 'UNAVAILABLE', describe(status))) tag('ai_status', `${d}:owner-only`);
  // The caller's own job only: neither owner has one here, so both directions must read `none`.
  const deletion = await probeRpc(attacker, victim, 'deletion_status', {});
  if (control(attacker, 'deletion_status', deletion.ok && isDeepStrictEqual(deletion.data, { state: 'none' }), describe(deletion))) {
    tag('deletion_status', `${d}:owner-only`);
  }
  // A stale expected version reaches the owner's own version check and must return the HTTP-200 CONFLICT envelope.
  const consent = await probeRpc(attacker, victim, 'ai_set_consent', { p_enabled: false, p_notice_revision: null, p_expected_version: 999_999_999 });
  if (control(attacker, 'ai_set_consent', matchOutcome({ status: 200, data: { code: 'CONFLICT' } }, consent), describe(consent))) {
    tag('ai_set_consent', `${d}:owner-only`);
  }
}

/** Analyzed Save needs a provider-completed claim; these assertions stay, but carry no coverage credit. */
async function analyzedSaveProbes(attacker, victim) {
  const v = fixtures[victim.label], d = `${attacker.label}>${victim.label}`;
  stage = `matrix-${d}-analyzed-save`;
  const value = intent();
  const claimed = await probeRpc(attacker, victim, 'reserve_analyzed_item_save', { ...value, p_claim: {
    requestId: v.aiRequest ?? randomUUID(), draftId: randomUUID(), generation: 1, imageSha256: value.p_image.main_sha256 } });
  need(!claimed.ok && claimed.status === 400 && claimed.data?.code === '22023', `${stage}: peer claim ${describe(claimed)}`);
  for (const name of ['analyzed_item_save_preflight', 'cancel_analyzed_item_save']) {
    const result = await probeRpc(attacker, victim, name, { p_item_id: v.saveItem, p_image_id: v.saveImage, p_fingerprint: v.saveFingerprint });
    expectMatch(`${stage} ${name}`, CONFLICT, result);
  }
  // An owned analyzed claim needs a served provider path; PR-3b's EDGE-RUNTIME gate proves it (test:edge).
  delegate('analyzed-save-owned');
}

function exportShape(owner, result) {
  const f = fixtures[owner.label], data = result.data;
  if (!need(result.ok && data && typeof data === 'object' && !Array.isArray(data), `${stage}: export ${describe(result)}`)) return false;
  let ok = need(isDeepStrictEqual(Object.keys(data).sort(), ['created_at', 'export_id', 'owner_id', 'schema_version', 'tables']), `${stage}: export keys`);
  ok = need(data.owner_id === owner.uid && data.schema_version === 2, `${stage}: export owner/schema`) && ok;
  ok = need(isDeepStrictEqual(Object.keys(data.tables ?? {}).sort(), [...TABLES].sort()), `${stage}: export table keys`) && ok;
  for (const table of TABLES) {
    const rows = data.tables?.[table];
    ok = need(Array.isArray(rows) && rows.every((row) => row.owner_id === owner.uid), `${stage}: export ${table} ownership`) && ok;
  }
  const ids = (table, field = 'id') => new Set((data.tables?.[table] ?? []).map((row) => row[field]));
  for (const [table, field, id] of [['items', 'id', f.item], ['items', 'id', f.plain], ['items', 'id', f.recItem],
    ['item_images', 'id', f.image], ['item_images', 'id', f.retired], ['item_images', 'id', f.pendingImage],
    ['item_images', 'id', f.recSource], ['outfits', 'id', f.outfit], ['outfit_items', 'outfit_id', f.outfit],
    ['wear_events', 'id', f.event], ['wear_event_items', 'id', f.eventItem], ['combination_rules', 'id', f.rule],
    ['suggestion_feedback', 'id', f.feedback], ['profiles', 'owner_id', owner.uid], ['style_preferences', 'owner_id', owner.uid]]) {
    ok = need(ids(table, field).has(id), `${stage}: export lacks the ${table} fixture`) && ok;
  }
  ok = need(scanLeaks(JSON.stringify(data), victimTokens[owner.label === 'A' ? 'B' : 'A']).length === 0, `${stage}: export contains peer values`) && ok;
  return ok;
}

// --- Existence oracles on create-ID collisions --------------------------------------------------------
const pairOf = (foreign, missing, foreignIds = [], missingIds = []) => ({
  differs: !sameOutcome(foreign, missing, foreignIds, missingIds), foreign: outcomeOf(foreign), missing: outcomeOf(missing) });
/** `pairs`: one `{ differs, foreign, missing }` per probe (outcome shapes); the worst verdict decides the surface. */
function reportOracle(surface, d, pairs, detail) {
  const verdict = worstOracle(pairs.map((p) => classifyOracle(surface, p.differs, p.foreign, p.missing)));
  if (verdict === 'fail') oracleFailures.push(`${surface} ${d}: ${detail} (not allowlisted)`);
  else if (verdict === 'changed') oracleFailures.push(`${surface} ${d}: ${detail} (allowlisted pair changed; pinned ${JSON.stringify(ACCEPTED_ORACLES[surface].foreign)} vs ${JSON.stringify(ACCEPTED_ORACLES[surface].missing)})`);
  else if (verdict === 'accepted') findings.push(`(accepted residual) ${surface} ${d}: ${detail} [${ACCEPTED_ORACLES[surface].summary}]`);
  else if (verdict === 'accepted-not-reproduced') note(`accepted oracle ${surface} ${d} no longer reproduces; remove its allowlist entry`);
}
const takenRecords = {};
/**
 * Conflict-response normalization for create IDs. Per surface: an otherwise-valid create with the victim's ID
 * (foreign), the same create with the attacker's own taken ID (own conflict) and with a fresh ID. Foreign and own
 * must match the pinned full response; the fresh create must succeed and read back. Rejections must leave the
 * caller's parent and link rows unchanged. Foreign vs fresh stays the accepted create-ID residual.
 */
async function oracles(attacker, victim) {
  const a = fixtures[attacker.label], v = fixtures[victim.label], d = `${attacker.label}>${victim.label}`;
  const rows = async (table, filter) => {
    const result = await raw(attacker.token, `/rest/v1/${table}?${filter}&select=*&order=${ORDER[table] ?? 'id'}`);
    fatal(result.ok && Array.isArray(result.data), `oracle-read-${table}`);
    return result.data;
  };
  const del = (table, id) => async () => fatal((await raw(attacker.token, `/rest/v1/${table}?owner_id=eq.${attacker.uid}&id=eq.${id}`, { method: 'DELETE' })).ok, 'oracle-cleanup');
  const rpc = (name, build) => ({ route: rpcRoute(name), request: (id) => ({ method: 'POST', body: build(id) }) });
  const rest = (table, build) => ({ route: `/rest/v1/${table}`, request: (id) => ({ method: 'POST', body: { id, owner_id: attacker.uid, ...build() } }) });
  const outfit = (id) => ({ p_id: id, p_title: 'Isolation oracle', p_occasion: 'everyday', p_notes: '', p_favourite: false,
    p_item_ids: [a.plain], p_expected_version: null });
  const wear = (id) => ({ p_id: id, p_local_date: '2026-01-03', p_timezone: 'Europe/Helsinki', p_state: 'worn', p_label: 'Isolation oracle',
    p_outfit_id: null, p_item_ids: [a.plain], p_expected_version: null });
  const importId = randomUUID();
  const history = (id) => ({ p_id: id, p_event_id: a.event, p_item_id: null, p_title: 'Isolation oracle', p_category: 'top', p_import_id: importId });
  const reserveOf = (id) => { const value = intent(); value.p_item.id = id; return value; };
  const inList = (ids) => `in.(${ids.join(',')})`;
  const outfitState = (ids) => async () => ({ parent: await rows('outfits', `id=${inList(ids)}`),
    links: await rows('outfit_items', `outfit_id=${inList(ids)}`) });
  const wearState = (ids) => async () => ({ parent: await rows('wear_events', `id=${inList(ids)}`),
    links: await rows('wear_event_items', `event_id=${inList(ids)}`) });
  const itemState = (ids) => async () => ({ parent: await rows('items', `id=${inList(ids)}`),
    links: await rows('item_images', `item_id=${inList(ids)}`) });
  const byId = (table) => (ids) => async () => ({ parent: await rows(table, `id=${inList(ids)}`) });
  const one = async (table, id) => rows(table, `id=eq.${id}`);
  // Surface 5 covers both an existing save attempt (saveItem) and a plain REST-created item; each fresh reserve is
  // tracked by its own harness so cleanup removes exactly that attempt.
  const reserve = (surface, foreignId, ownId, name = 'reserve_item_save') => {
    const h = saveHarness(client, attacker);
    return { surface, name, foreignId, ownId, route: rpcRoute(name),
      request: (id, kind) => ({ method: 'POST', body: kind === 'fresh' ? h.track(reserveOf(id)) : reserveOf(id) }),
      state: itemState, cleanup: () => h.cleanup(),
      persisted: async (id, result) => Array.isArray(result.data) && result.data.length === 1 && result.data[0].item?.id === id
        && (await one('items', id)).length === 1 };
  };
  const surfaces = [
    { surface: 'save_outfit p_id', name: 'save_outfit', foreignId: v.outfit, ownId: a.outfit, ...rpc('save_outfit', outfit),
      state: outfitState, cleanup: (id) => del('outfits', id)(),
      persisted: async (id) => { const s = await outfitState([id])();
        return s.parent.length === 1 && s.parent[0].title === 'Isolation oracle' && s.parent[0].version === 1
          && isDeepStrictEqual(s.links.map((l) => [l.item_id, l.position]), [[a.plain, 0]]); } },
    { surface: 'save_wear_event p_id', name: 'save_wear_event', foreignId: v.event, ownId: a.event, ...rpc('save_wear_event', wear),
      state: wearState, cleanup: (id) => del('wear_events', id)(),
      persisted: async (id) => { const s = await wearState([id])();
        return s.parent.length === 1 && s.parent[0].label === 'Isolation oracle' && s.parent[0].version === 1
          && isDeepStrictEqual(s.links.map((l) => l.item_id), [a.plain]); } },
    { surface: 'restore_history_entry p_id', name: 'restore_history_entry', foreignId: v.eventItem, ownId: a.eventItem,
      ...rpc('restore_history_entry', history), state: byId('wear_event_items'), cleanup: (id) => del('wear_event_items', id)(),
      persisted: async (id) => { const r = await one('wear_event_items', id);
        return r.length === 1 && r[0].event_id === a.event && r[0].title_snapshot === 'Isolation oracle' && r[0].import_id === importId; } },
    reserve('reserve_item_save p_item.id (save attempt)', v.saveItem, a.saveItem),
    reserve('reserve_item_save p_item.id (plain item)', v.plain, a.plain),
    // The restored save (P6b) shares the checked Save chain and must answer a taken ID exactly the same way.
    reserve('reserve_restored_item_save p_item.id (save attempt)', v.saveItem, a.saveItem, 'reserve_restored_item_save'),
    reserve('reserve_restored_item_save p_item.id (plain item)', v.plain, a.plain, 'reserve_restored_item_save'),
    { surface: 'REST items id', foreignId: v.item, ownId: a.item, ...rest('items', () => ({ title: 'Isolation oracle', category: 'top' })),
      state: itemState, cleanup: (id) => del('items', id)(), persisted: async (id) => (await one('items', id)).length === 1 },
    { surface: 'REST outfits id', foreignId: v.outfit, ownId: a.outfit, ...rest('outfits', () => ({ title: 'Isolation oracle' })),
      state: outfitState, cleanup: (id) => del('outfits', id)(), persisted: async (id) => (await one('outfits', id)).length === 1 },
    { surface: 'REST wear_events id', foreignId: v.event, ownId: a.event, ...rest('wear_events', () => ({ local_date: '2026-01-03' })),
      state: wearState, cleanup: (id) => del('wear_events', id)(), persisted: async (id) => (await one('wear_events', id)).length === 1 },
    { surface: 'REST wear_event_items id', foreignId: v.eventItem, ownId: a.eventItem,
      // A real owned item in an unused (event_id, item_id) pair: wear_snapshot accepts it and only the PK can collide.
      ...rest('wear_event_items', () => ({ event_id: a.event, item_id: a.plain, title_snapshot: 'Isolation oracle', category_snapshot: 'top' })),
      state: byId('wear_event_items'), cleanup: (id) => del('wear_event_items', id)(),
      persisted: async (id) => { const r = await one('wear_event_items', id);
        return r.length === 1 && r[0].event_id === a.event && r[0].item_id === a.plain && r[0].import_id === null; } },
  ];
  const pairs = {};
  for (const s of surfaces) {
    stage = `oracle-${d}-${s.surface}`;
    need(Boolean(s.foreignId && s.ownId), `${stage}: fixture reference missing`);
    if (!s.foreignId || !s.ownId) continue;
    const fresh = randomUUID(), state = s.state([s.ownId, s.foreignId]);
    const before = await state();
    const foreign = await probe(attacker, victim, s.route, s.request(s.foreignId, 'foreign'));
    const own = await raw(attacker.token, s.route, s.request(s.ownId, 'own'));
    need(isDeepStrictEqual(await state(), before), `${stage}: a rejected create changed parent or link rows`);
    const made = await raw(attacker.token, s.route, s.request(fresh, 'fresh'));
    const persisted = made.ok && await s.persisted(fresh, made) === true;
    if (made.ok) {
      await s.cleanup(fresh);
      need(Object.values(await s.state([fresh])()).every((list) => list.length === 0), `${stage}: a fresh control row was left behind`);
    }
    takenRecords[`${s.surface} ${d}`] = { foreign: fullOutcome(foreign, [s.foreignId]), own: fullOutcome(own, [s.ownId]),
      fresh: fullOutcome(made, [fresh]), persisted };
    const pin = TAKEN_ID_SURFACES[s.surface];
    const normalized = isDeepStrictEqual(fullOutcome(foreign, [s.foreignId]), pin.conflict)
      && isDeepStrictEqual(fullOutcome(own, [s.ownId]), pin.conflict);
    if (s.name && persisted) control(attacker, s.name, true);
    if (s.name && normalized && persisted) tag(s.name, `${d}:collision`);
    if (made.ok) (pairs[pin.oracle] ??= []).push({ ...pairOf(foreign, made), detail: `a peer-owned ID returns ${describe(foreign)}, a new ID ${describe(made)}` });
  }
  for (const [surface, list] of Object.entries(pairs)) reportOracle(surface, d, list, list.map((p) => p.detail).join('; '));
  await unrelatedErrors(attacker, rows);
  await aiCollision(attacker, victim);
}

/** Only the parent primary-key violation is normalized: other errors on the create path keep their own response. */
async function unrelatedErrors(attacker, rows) {
  const a = fixtures[attacker.label], d = attacker.label;
  const cases = [
    ['save_outfit', 'outfits', (id) => ({ p_id: id, p_title: '', p_occasion: 'everyday', p_notes: '', p_favourite: false,
      p_item_ids: [a.plain], p_expected_version: null }), 'new row for relation "outfits" violates check constraint "outfits_title_check"'],
    ['save_wear_event', 'wear_events', (id) => ({ p_id: id, p_local_date: '2026-01-03', p_timezone: 'Europe/Helsinki', p_state: 'unknown',
      p_label: 'Isolation oracle', p_outfit_id: null, p_item_ids: [a.plain], p_expected_version: null }),
    'new row for relation "wear_events" violates check constraint "wear_events_state_check"'],
  ];
  for (const [name, table, build, message] of cases) {
    stage = `oracle-${d}-${name}-unrelated`;
    const id = randomUUID();
    const result = await call(attacker, name, build(id));
    const body = result.data && typeof result.data === 'object' ? result.data : {};
    need(!result.ok && result.status === 400 && isDeepStrictEqual(Object.keys(body).sort(), ['code', 'details', 'hint', 'message'])
      && body.code === '23514' && body.message === message && body.details === null && body.hint === null,
    `${stage}: a check violation must stay 23514, observed ${describe(result)}`);
    need((await rows(table, `id=eq.${id}`)).length === 0, `${stage}: a failed create left a row`);
  }
  const race = randomUUID();
  stage = `oracle-${d}-save_wear_event-foreign-key`;
  const missingOutfit = await call(attacker, 'save_wear_event', { p_id: race, p_local_date: '2026-01-03', p_timezone: 'Europe/Helsinki',
    p_state: 'worn', p_label: 'Isolation oracle', p_outfit_id: randomUUID(), p_item_ids: [a.plain], p_expected_version: null });
  need(!missingOutfit.ok && missingOutfit.status === 409 && missingOutfit.data?.code === '23503',
    `${stage}: a foreign-key violation must stay 23503, observed ${describe(missingOutfit)}`);
  need((await rows('wear_events', `id=eq.${race}`)).length === 0, `${stage}: a failed create left a row`);
}

/** AI request keys are owner-scoped: a peer's request ID must behave exactly like the attacker's own new ID. */
async function aiCollision(attacker, victim) {
  const a = fixtures[attacker.label], v = fixtures[victim.label], d = `${attacker.label}>${victim.label}`;
  stage = `oracle-${d}-ai_begin_request`;
  if (!a.aiRequest || !v.aiRequest) {
    tag('ai_begin_request', `${d}:unverified`);
    note(`ai_begin_request ${d}: no owned reservation control in this job; collision not ownership-verified`);
    return;
  }
  const foreign = await probeRpc(attacker, victim, 'ai_begin_request', { p_request_id: v.aiRequest, p_draft_id: randomUUID(),
    p_generation: 1, p_image_sha256: HEX });
  if (isInconclusive(foreign)) {
    tag('ai_begin_request', `${d}:unverified`);
    note(`ai_begin_request ${d}: owner-local ${applicationCode(foreign)} decided the peer-ID probe; not ownership proof`);
    return;
  }
  const expected = { status: 200, data: { code: 'OK', status: 'reserved', replayed: false } };
  if (matchOutcome(expected, foreign)) {
    aiSelfMutated[attacker.label] = true;
    const discarded = await call(attacker, 'ai_request_control', { p_request_id: v.aiRequest, p_action: 'discard' });
    fatal(applicationCode(discarded) === 'TERMINAL', 'oracle-ai-discard');
  }
  if (need(matchOutcome(expected, a.aiBegin) && foreign.status === 200, `${stage}: peer ID ${describe(foreign)} ${JSON.stringify(foreign.data)}`)) {
    tag('ai_begin_request', `${d}:collision`);
    reportOracle('ai_begin_request p_request_id', d,
      [{ differs: !isDeepStrictEqual(outcomeOf(foreign), a.aiBegin), foreign: outcomeOf(foreign), missing: a.aiBegin }],
      `a peer-owned request ID returns ${JSON.stringify(foreign.data)}, the owner's new ID ${JSON.stringify(a.aiBegin.data)}`);
  }
}

// --- REST, export, Storage, discovery and Edge ---------------------------------------------------------
async function restIsolation(attacker, victim) {
  const a = fixtures[attacker.label], v = fixtures[victim.label], direction = `${attacker.label}>${victim.label}`;
  const present = { items: [a.item, a.plain], item_images: [a.image, a.retired], outfits: [a.outfit], wear_events: [a.event],
    wear_event_items: [a.eventItem], combination_rules: [a.rule], suggestion_feedback: [a.feedback] };
  for (const table of TABLES) {
    stage = `rest-${direction}-${table}`;
    const rows = await readAll(attacker, table);
    need(rows.length > 0 && rows.every((row) => row.owner_id === attacker.uid), `${stage}: rows outside the owner`);
    need(scanLeaks(JSON.stringify(rows), v.tokens).length === 0, `${stage}: peer values in own rows`);
    const field = table === 'outfit_items' ? 'outfit_id' : ['profiles', 'style_preferences'].includes(table) ? 'owner_id' : 'id';
    for (const id of present[table] ?? (table === 'outfit_items' ? [a.outfit] : [attacker.uid])) {
      need(rows.some((row) => row[field] === id), `${stage}: own fixture missing (positive control)`);
    }
    const filtered = await probe(attacker, victim, `/rest/v1/${table}?owner_id=eq.${victim.uid}&select=*`);
    need(filtered.ok && isDeepStrictEqual(filtered.data, []), `${stage}: peer filter ${describe(filtered)}`);
  }
  stage = `rest-${direction}-writes`;
  for (const [table, id] of [['items', v.item], ['outfits', v.outfit], ['wear_events', v.event], ['combination_rules', v.rule],
    ['suggestion_feedback', v.feedback], ['wear_event_items', v.eventItem]]) {
    const read = await probe(attacker, victim, `/rest/v1/${table}?id=eq.${id}&select=*`);
    need(read.ok && isDeepStrictEqual(read.data, []), `${stage}: ${table} read by ID ${describe(read)}`);
    for (const method of ['PATCH', 'DELETE']) {
      const result = await probe(attacker, victim, `/rest/v1/${table}?id=eq.${id}`, { method,
        ...(method === 'PATCH' ? { body: { owner_id: attacker.uid } } : {}),
        headers: { Prefer: 'return=representation' } });
      need((result.ok && isDeepStrictEqual(result.data, [])) || (!result.ok && result.status < 500),
        `${stage}: ${method} ${table} ${describe(result)}`);
    }
  }
  const spoof = await probe(attacker, victim, '/rest/v1/items', { method: 'POST',
    body: { id: randomUUID(), owner_id: victim.uid, title: 'Forbidden', category: 'top' } });
  need(matchOutcome({ status: 403, code: '42501' }, spoof), `${stage}: spoofed owner insert ${describe(spoof)}`);
  stage = `rest-${direction}-private-schema`;
  for (const token of [attacker, null]) {
    const result = await probe(token, victim, '/rest/v1/approved_accounts?select=*', { headers: { 'Accept-Profile': 'private' } });
    need(matchOutcome({ status: 406, code: 'PGRST106' }, result), `${stage}: private profile ${describe(result)}`);
    const helper = await probe(token, victim, rpcRoute('is_approved'), { method: 'POST', body: {}, headers: { 'Content-Profile': 'private' } });
    need(matchOutcome({ status: 406, code: 'PGRST106' }, helper), `${stage}: private helper ${describe(helper)}`);
  }
}

async function storageIsolation(attacker, victim) {
  const v = fixtures[victim.label], direction = `${attacker.label}>${victim.label}`;
  const missingPath = `${v.uid}/${v.item}/${randomUUID()}/main.jpg`;
  const deletePairs = [];
  let deleteDetail = '';
  for (const path of v.paths) {
    stage = `storage-${direction}`;
    const masked = [path.split('/')[2]], random = [missingPath.split('/')[2]];
    const download = await probe(attacker, victim, `/storage/v1/object/authenticated/wardrobe/${path}`);
    const absent = await probe(attacker, victim, `/storage/v1/object/authenticated/wardrobe/${missingPath}`);
    need(!download.ok, `${stage}: peer download ${describe(download)}`);
    need(sameOutcome(download, absent, masked, random), `${stage}: download foreign ${describe(download)} vs nonexistent ${describe(absent)}`);
    const sign = await probe(attacker, victim, `/storage/v1/object/sign/wardrobe/${path}`, { method: 'POST', body: { expiresIn: 60 } });
    const signAbsent = await probe(attacker, victim, `/storage/v1/object/sign/wardrobe/${missingPath}`, { method: 'POST', body: { expiresIn: 60 } });
    need(!sign.ok && sameOutcome(sign, signAbsent, masked, random), `${stage}: sign foreign ${describe(sign)} vs ${describe(signAbsent)}`);
    const upload = await probe(attacker, victim, `/storage/v1/object/wardrobe/${path}`, { method: 'POST', binary: true,
      body: Buffer.from([255, 216, 255, 217]), headers: { 'x-upsert': 'true' } });
    need(!upload.ok, `${stage}: peer overwrite ${describe(upload)}`);
    const remove = await probe(attacker, victim, `/storage/v1/object/wardrobe/${path}`, { method: 'DELETE' });
    const removeAbsent = await probe(attacker, victim, `/storage/v1/object/wardrobe/${missingPath}`, { method: 'DELETE' });
    need(!remove.ok && !removeAbsent.ok, `${stage}: peer delete ${describe(remove)} / ${describe(removeAbsent)}`);
    deletePairs.push(pairOf(remove, removeAbsent, masked, random));
    deleteDetail = `a peer-owned object returns ${describe(remove)}, a nonexistent one ${describe(removeAbsent)}`;
  }
  reportOracle('Storage DELETE object', direction, deletePairs, deleteDetail);
  const listed = await probe(attacker, victim, '/storage/v1/object/list/wardrobe', { method: 'POST',
    body: { prefix: `${v.uid}/`, limit: 100, offset: 0 } });
  need(listed.ok && isDeepStrictEqual(listed.data, []), `${stage}: peer prefix listing ${describe(listed)}`);
}

async function discovery(attacker, victim) {
  const direction = `${attacker.label}>${victim.label}`;
  stage = `openapi-${direction}`;
  const openapi = await probe(attacker, victim, '/rest/v1/', { headers: { Accept: 'application/openapi+json' } });
  if (openapi.ok && openapi.data && typeof openapi.data === 'object' && openapi.data.paths) {
    const paths = Object.keys(openapi.data.paths);
    const rpcs = paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)).sort();
    const tables = paths.filter((p) => p !== '/' && !p.startsWith('/rpc/')).map((p) => p.slice(1)).sort();
    need(isDeepStrictEqual(rpcs, EXPOSED_RPCS.map((f) => f.name).sort()), `${stage}: OpenAPI RPCs differ from the exposed subset`);
    need(isDeepStrictEqual(tables, [...TABLES].sort()), `${stage}: OpenAPI tables differ`);
  } else if (!unverified.includes(`OpenAPI description refused (${openapi.status})`)) unverified.push(`OpenAPI description refused (${openapi.status})`);
  stage = `graphql-${direction}`;
  const graphql = (query, variables = {}) => probe(attacker, victim, '/graphql/v1', { method: 'POST', body: { query, variables } });
  const schema = await graphql('{ __schema { types { name } } }');
  const types = schema.ok && Array.isArray(schema.data?.data?.__schema?.types) ? schema.data.data.__schema.types.map((t) => t.name) : null;
  if (!types) { if (!unverified.includes('GraphQL introspection unavailable')) unverified.push('GraphQL introspection unavailable'); return; }
  for (const name of types) {
    if (name.startsWith('__')) continue;
    const base = name.replace(/(Connection|Edge|InsertResponse|UpdateResponse|DeleteResponse|InsertInput|UpdateInput|Filter|OrderBy)$/, '');
    need(!RELATIONSHIP_NAMES.test(base), `${stage}: relationship-like GraphQL type ${base}`);
  }
  for (const table of TABLES) {
    let after = null;
    for (let page = 0; page < 40; page++) {
      const result = await graphql(`query($after: Cursor) { ${table}Collection(first: 30, after: $after) { edges { node { owner_id } } pageInfo { hasNextPage endCursor } } }`, { after });
      const connection = result.data?.data?.[`${table}Collection`];
      if (!result.ok || !connection) { if (page === 0 && !unverified.includes(`GraphQL ${table} collection unavailable`)) unverified.push(`GraphQL ${table} collection unavailable`); break; }
      need(connection.edges.every((edge) => edge.node.owner_id === attacker.uid), `${stage}: ${table} edge outside the owner`);
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
  }
}

async function edgeProbes(attacker, victim) {
  const v = fixtures[victim.label], direction = `${attacker.label}>${victim.label}`;
  for (const [name, body] of [
    ['finalize-image-change', { action: 'complete', intent: v.changeIntent }],
    ['finalize-analyzed-item', { itemId: v.saveItem, imageId: v.saveImage, fingerprint: v.saveFingerprint }],
  ]) {
    stage = `edge-${direction}-${name}`;
    const result = await raw(attacker.token, `/functions/v1/${name}`, { method: 'POST', body });
    // The security job serves these functions; a missing or failing function fails, never UNVERIFIED.
    need(!result.transport && result.status < 500 && result.status !== 404 && !/UNCONFIGURED/.test(result.text),
      `${stage}: function not served (${result.transport ? 'no response' : result.status})`);
    need(!result.ok, `${stage}: peer request accepted (${result.status})`);
    need(scanLeaks(result.text, v.tokens, v.tokens.filter((t) => JSON.stringify(body).includes(t))).length === 0, `${stage}: leaked peer values`);
  }
  // The stack runtime has no provider configuration; analyze-clothing ownership runs in PR-3b's isolated
  // EDGE-RUNTIME / PROVIDER-DOUBLE gate (test:edge), which fails unless these delegations pass.
  delegate('analyze-foreign');
  // Mandatory, never UNVERIFIED: the security job serves the functions, so a missing or unconfigured
  // delete-account function fails this gate. The owner comes only from the caller's session; a body naming
  // another owner is refused as INVALID_INPUT before re-authentication, and no deletion job starts.
  stage = `edge-${direction}-delete-account`;
  const body = { password: 'fictional-wrong-password', ownerId: victim.uid };
  const refused = await raw(attacker.token, '/functions/v1/delete-account', { method: 'POST', body });
  need(refused.status === 400 && isDeepStrictEqual(refused.data, { code: 'INVALID_INPUT' }),
    `${stage}: expected exactly 400 INVALID_INPUT, got ${refused.transport ? 'no response' : refused.status}`);
  need(scanLeaks(refused.text, v.tokens, v.tokens.filter((t) => JSON.stringify(body).includes(t))).length === 0, `${stage}: leaked peer values`);
  for (const owner of [attacker, victim]) {
    const status = await call(owner, 'deletion_status', {});
    need(status.ok && isDeepStrictEqual(status.data, { state: 'none' }), `${stage}: ${owner.label} deletion state changed ${describe(status)}`);
  }
}

async function anonymousAndService(owners) {
  stage = 'anonymous';
  for (const f of EXPOSED_RPCS) {
    const result = await call(null, f.name, Object.fromEntries(f.params.map((p) => [p, null])));
    if (need(matchOutcome({ status: 401, code: '42501' }, result), `anonymous ${f.name}: ${describe(result)}`)) tag(f.name, 'anon');
  }
  stage = 'service-only';
  for (const f of SERVICE_ONLY_RPCS) {
    for (const [label, owner, target] of [['anon', null, owners[0]], ['normal-A', owners[0], owners[1]], ['normal-B', owners[1], owners[0]]]) {
      const result = await call(owner, f.name, Object.fromEntries(f.params.map((p) => [p, p === 'p_owner_id' ? target.uid : null])));
      const expected = owner ? { status: 403, code: '42501' } : { status: 401, code: '42501' };
      if (need(matchOutcome(expected, result), `${label} ${f.name}: ${describe(result)}`)) tag(f.name, label);
    }
  }
}


async function ownPositiveControls(owner) {
  const f = fixtures[owner.label];
  stage = `positive-${owner.label}`;
  const checks = [
    ['item_deletion_status', { p_item_ids: [f.item] }, (d) => Array.isArray(d) && d.length === 1 && d[0].id === f.item],
    ['item_deletion_operations', { p_item_ids: [f.prepItem] }, (d) => Array.isArray(d) && d.length === 1 && d[0].itemId === f.prepItem],
    ['item_deletion_operation_status', { p_item_id: f.prepItem, p_request_id: f.prepRequest }, (d) => d?.phase === 'preparing'],
    ['image_change_status', { p_item_id: f.changeItem, p_request_id: f.changeRequest }, (d) => d?.requestId === f.changeRequest && d.state === 'reserved'],
    ['image_change_requests', { p_item_id: f.changeItem }, (d) => Array.isArray(d) && d.length === 1 && d[0].requestId === f.changeRequest],
    ['restore_image_change_status', { p_item_id: f.changeItem, p_request_id: f.changeRequest }, (d) => d?.requestId === f.changeRequest
      && d.state === 'reserved' && Number.isInteger(d.expectedVersion) && typeof d.currentImageId === 'string' && d.image?.state === 'pending'],
    ['restore_item_save_status', { p_item_id: f.saveItem }, (d) => d?.itemId === f.saveItem && d.imageId === f.saveImage
      && ['reserved', 'completed'].includes(d.state)],
    ['item_attribution_history', { p_item_id: f.item }, (d) => Array.isArray(d)],
  ];
  for (const [name, body, check] of checks) {
    const result = await call(owner, name, body);
    control(owner, name, result.ok && check(result.data), describe(result));
  }
  if (f.aiRequest) {
    const status = await call(owner, 'ai_request_control', { p_request_id: f.aiRequest, p_action: 'status' });
    if (applicationCode(status) === 'OK' && status.data.status === 'reserved') control(owner, 'ai_request_control', true);
    else note(`own ai_request_control ${owner.label} returned ${applicationCode(status) ?? describe(status)}; not ownership-verified`);
    const analysis = await call(owner, 'ai_analysis_status', { p_request_id: f.aiRequest });
    if (applicationCode(analysis) === 'OK') control(owner, 'ai_analysis_status', true);
    else delegate('analysis-status-owned');
  }
  delegate('attribution-populated');
}

// --- Freeze (A4): same issued token before, during and after --------------------------------------------
async function freezeCase(frozen, other) {
  const f = fixtures[frozen.label], o = fixtures[other.label], direction = `freeze-${frozen.label}`;
  stage = `${direction}-before`;
  const ownBefore = await ownerState(frozen);
  const otherBefore = await ownerState(other);
  fatal(ownBefore.tables.items.some((row) => row.id === f.item), `${direction}-positive`);
  await phase('freeze', frozen.label);
  try {
    stage = `${direction}-during`;
    for (const table of TABLES) {
      const rows = await raw(frozen.token, `/rest/v1/${table}?select=*`);
      need(rows.ok && isDeepStrictEqual(rows.data, []), `${stage}: frozen ${table} read ${describe(rows)}`);
    }
    const insert = await raw(frozen.token, '/rest/v1/items', { method: 'POST', body: { id: randomUUID(), owner_id: frozen.uid, title: 'Frozen', category: 'top' } });
    need(matchOutcome({ status: 403, code: '42501' }, insert), `${stage}: frozen insert ${describe(insert)}`);
    for (const [name, body, expected] of [
      ['export_manifest', { p_export_id: randomUUID() }, NULL],
      ['item_deletion_status', { p_item_ids: [f.item] }, { status: 403, code: '42501' }],
      ['image_change_status', { p_item_id: f.changeItem, p_request_id: f.changeRequest }, { status: 403, code: '42501' }],
      ['ai_request_control', { p_request_id: f.aiRequest ?? randomUUID(), p_action: 'status' }, UNAVAILABLE],
    ]) expectMatch(`${stage}: frozen ${name}`, expected, await call(frozen, name, body));
    const ai = await call(frozen, 'ai_status', {});
    need(!ai.ok || ai.data?.code === 'UNAVAILABLE' || ai.data?.available === false || ai.data?.approved === false,
      `${stage}: frozen ai_status ${describe(ai)}`);
    for (const path of f.paths.slice(0, 2)) need((await objectState(frozen, path)).startsWith('denied-'), `${stage}: frozen own download`);
    // Cross-direction: the unaffected owner still cannot see the frozen owner's data, and vice versa.
    for (const table of ['items', 'item_images']) {
      const peer = await raw(other.token, `/rest/v1/${table}?owner_id=eq.${frozen.uid}&select=id`);
      need(peer.ok && isDeepStrictEqual(peer.data, []), `${stage}: unaffected owner sees frozen ${table}`);
      const reverse = await raw(frozen.token, `/rest/v1/${table}?owner_id=eq.${other.uid}&select=id`);
      need(reverse.ok && isDeepStrictEqual(reverse.data, []), `${stage}: frozen owner sees peer ${table}`);
    }
    const login = await raw(null, '/auth/v1/token?grant_type=password', { method: 'POST',
      body: { email: env[`TEST_${frozen.label}_EMAIL`], password: env[`TEST_${frozen.label}_PASSWORD`] } });
    if (login.ok && typeof login.data?.access_token === 'string') {
      const fresh = await raw(login.data.access_token, '/rest/v1/items?select=id');
      need(fresh.ok && isDeepStrictEqual(fresh.data, []), `${stage}: fresh frozen login reads data`);
      findings.push(`freeze ${frozen.label}: a fresh password login still issues a token; its data access is denied`);
    } else findings.push(`freeze ${frozen.label}: fresh login refused (${login.status})`);
    const scratch = randomUUID();
    const write = await raw(other.token, '/rest/v1/items', { method: 'POST', body: { id: scratch, owner_id: other.uid, title: 'Isolation scratch', category: 'top' } });
    need(write.ok, `${stage}: unaffected scratch write ${describe(write)}`);
    if (write.ok) fatal((await raw(other.token, `/rest/v1/items?owner_id=eq.${other.uid}&id=eq.${scratch}`, { method: 'DELETE' })).ok, 'scratch-cleanup');
    compareState(`${stage}: unaffected ${other.label}`, otherBefore, await ownerState(other));
    for (const path of o.paths) need(otherBefore.objects[path] === await objectState(other, path), `${stage}: unaffected bytes`);
  } finally {
    stage = `${direction}-restore`;
    await phase('restore', frozen.label);
  }
  stage = `${direction}-after`;
  compareState(`${stage}: restored ${frozen.label}`, ownBefore, await ownerState(frozen));
  compareState(`${stage}: unaffected ${other.label}`, otherBefore, await ownerState(other));
}

// --- Main -----------------------------------------------------------------------------------------------
let exitCode = 0;
async function runCleanups() {
  let failed = false;
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { failed = true; }
  }
  if (failed) throw new Error('I17_FATAL:cleanup');
}
try {
  stage = 'sign-in';
  const owners = [await client.signIn('A'), await client.signIn('B')];
  fatal(owners[0].uid !== owners[1].uid, 'distinct-owners');
  for (const owner of owners) fixtures[owner.label] = await buildFixture(owner);
  victimTokens = { A: fixtures.A.tokens, B: fixtures.B.tokens };
  for (const owner of owners) await ownPositiveControls(owner);
  stage = 'baseline';
  const baseline = { A: await ownerState(owners[0]), B: await ownerState(owners[1]) };
  await anonymousAndService(owners);
  for (const [attacker, victim] of [[owners[0], owners[1]], [owners[1], owners[0]]]) {
    const d = `${attacker.label}>${victim.label}`;
    stage = `victim-before-${d}`;
    const victimBefore = await ownerState(victim);
    await foreignMatrix(attacker, victim);
    await restIsolation(attacker, victim);
    await storageIsolation(attacker, victim);
    await discovery(attacker, victim);
    await edgeProbes(attacker, victim);
    await oracles(attacker, victim);
    stage = `victim-after-${d}`;
    compareState(`victim ${victim.label} after ${d} probes`, victimBefore, await ownerState(victim));
  }
  stage = 'owner-postconditions';
  for (const owner of owners) {
    compareState(`owner ${owner.label} after all probes`, baseline[owner.label], await ownerState(owner),
      { skipAi: aiSelfMutated[owner.label] });
  }
  problems.push(...validateCoverage(covered));
  oracleFailures.push(...takenIdProblems(takenRecords));
  await freezeCase(owners[0], owners[1]);
  await freezeCase(owners[1], owners[0]);
} catch (error) {
  const label = error instanceof Error && error.message.startsWith('I17_FATAL:') ? error.message.slice(10) : stage;
  console.error(`FAIL: I17 isolation audit stopped at ${label.replace(uuidPattern, '<id>')}; private evidence withheld`);
  exitCode = 1;
} finally {
  stage = 'cleanup';
  const barrier = async () => { try { return await phase('barrier', null); } catch { return false; } };
  const outcome = await restoreThenCleanup(freezeRequested, barrier, runCleanups);
  if (!outcome.cleaned) {
    console.error('FAIL: I17 approval restore was not confirmed; fixture cleanup withheld while approval may be disabled');
    exitCode = 1;
  }
  if (outcome.errors.includes('cleanup')) { console.error('FAIL: I17 fixture cleanup incomplete'); exitCode = 1; }
}
for (const text of findings.slice(0, 40)) console.log(`FINDING: ${text}`);
for (const text of unverified.slice(0, 40)) console.log(`UNVERIFIED: ${text}`);
for (const key of delegated) console.log(delegatedLine(key));
for (const text of oracleFailures) console.error(`FAIL: existence oracle ${text.replace(uuidPattern, '<id>')}`);
if (oracleFailures.length) exitCode = 1;
if (problems.length) {
  for (const problem of problems.slice(0, 120)) console.error(`MISMATCH: ${problem.replace(uuidPattern, '<id>')}`);
  if (problems.length > 120) console.error(`MISMATCH: ${problems.length - 120} more withheld`);
  exitCode = 1;
}
if (exitCode === 0) console.log(`PASS: I17 owner isolation; ${EXPOSED_RPCS.length} RPCs in both directions, anonymous and service denials, REST/export/Storage and freeze`);
else console.error('FAIL: I17 owner isolation audit');
process.exitCode = exitCode;
process.disconnect?.();
