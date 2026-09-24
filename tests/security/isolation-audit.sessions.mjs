// I17 owner-isolation audit. Every isolation, unchanged-data and byte assertion uses normal sessions over HTTP.
// The only privileged steps (freeze/restore of a fixed fictional owner) are requested from the runner over IPC.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertLocalApi, validateSessionEnvironment, reportError, LocalBackendError,
} from '../../scripts/backend/local.mjs';
import {
  EXPOSED_RPCS, SERVICE_ONLY_RPCS, PUBLIC_TABLES, RELATIONSHIP_NAMES,
  matchOutcome, outcomeOf, sameOutcome, scanLeaks, validateCoverage,
} from '../../scripts/isolation-catalog.mjs';
import { normalClient } from '../integration/preservation.sessions.mjs';
import { intent, saveHarness } from '../integration/item-save.sessions.mjs';
import { imageChangeHarness } from '../integration/image-replacement.sessions.mjs';
import { AI_IDS } from '../integration/ai-controls.sessions.mjs';

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

let stage = 'configuration', aiReservationAccepted = false;
const problems = [], findings = [], unverified = [], covered = new Map();
const tag = (name, value) => { if (!covered.has(name)) covered.set(name, new Set()); covered.get(name).add(value); };
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
  return new Promise((resolve, reject) => {
    const id = ++nextPhase;
    const timer = setTimeout(() => { pendingPhases.delete(id); reject(new Error(`I17_FATAL:${name}-timeout`)); }, 75_000);
    pendingPhases.set(id, (ok) => {
      clearTimeout(timer); pendingPhases.delete(id);
      if (ok) resolve(); else reject(new Error(`I17_FATAL:${name}-refused`));
    });
    process.send({ type: 'phase', id, phase: name, owner });
  });
}

// --- Fixtures ---------------------------------------------------------------------------------------
const fixtures = {};
const cleanups = [];
async function buildFixture(owner) {
  const L = owner.label, sh = saveHarness(client, owner), ich = imageChangeHarness(client, owner, env);
  const f = { uid: owner.uid, paths: [] };
  stage = `fixture-${L}-legacy`;
  const v1 = intent();
  v1.p_item.title = `Isolation canary ${L} garment`;
  await client.insert(owner, 'items', v1.p_item);
  const v2 = { p_item: v1.p_item, p_image: intent().p_image };
  cleanups.push(async () => { await sh.remove(v2); await sh.remove(v1); await sh.deleteItem(v1); });
  for (const value of [v1, v2]) {
    await client.insert(owner, 'item_images', { ...value.p_image, item_id: value.p_item.id });
    await sh.upload(value);
    await client.rpc(owner, 'commit_image', { p_image_id: value.p_image.id });
    f.paths.push(...sh.paths(value));
  }
  f.item = v1.p_item.id; f.retired = v1.p_image.id; f.image = v2.p_image.id;
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
  await client.rpc(owner, 'save_wear_event', { p_id: f.event, p_local_date: '2026-01-01', p_timezone: 'Europe/Helsinki',
    p_state: 'worn', p_label: `Isolation look ${L}`, p_outfit_id: f.outfit, p_item_ids: [f.item], p_expected_version: null });
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
  const change = ich.make(changeBase.item, changeBase.image);
  cleanups.push(async () => {
    await client.rpc(owner, 'cancel_image_change', { p_item_id: change.itemId, p_request_id: change.requestId });
    await ich.remove(change);
    await ich.remove({ itemId: changeBase.item.id, imageId: changeBase.image.id });
    await sh.deleteItem(changeBase.value);
  });
  await ich.reserve(change);
  f.changeItem = change.itemId; f.changeRequest = change.requestId; f.changeImage = change.imageId;
  f.changeCurrent = changeBase.image.id; f.changeIntent = change;
  f.paths.push(...ich.paths({ itemId: changeBase.item.id, imageId: changeBase.image.id }));

  stage = `fixture-${L}-deletion`;
  const deletion = await ich.create();
  const deleteArgs = { p_item_id: deletion.item.id, p_request_id: randomUUID() };
  cleanups.push(async () => {
    const cancel = await call(owner, 'cancel_item_deletion_preparation', deleteArgs);
    fatal(cancel.ok, 'cleanup-deletion-cancel');
    await ich.remove({ itemId: deletion.item.id, imageId: deletion.image.id });
    await sh.deleteItem(deletion.value);
  });
  await client.rpc(owner, 'set_item_trashed', { p_item_id: deletion.item.id, p_expected_version: deletion.item.version, p_trashed: true });
  const status = (await client.rpc(owner, 'item_deletion_status', { p_item_ids: [deletion.item.id] }))[0];
  await client.rpc(owner, 'prepare_item_deletion', { ...deleteArgs, p_expected_version: status.version,
    p_image_manifest_sha256: status.image_manifest_sha256 });
  f.deleteItem = deletion.item.id; f.deleteRequest = deleteArgs.p_request_id;

  stage = `fixture-${L}-pending-save`;
  const pending = sh.track(intent());
  cleanups.push(() => sh.cleanup());
  const row = await sh.reserve(pending);
  f.saveItem = pending.p_item.id; f.saveImage = pending.p_image.id; f.saveFingerprint = row.fingerprint;
  f.aiReady = AI_IDS[L].ready;
  f.tokens = [owner.uid, f.item, f.retired, f.image, f.plain, f.outfit, f.event, f.eventItem, f.rule, f.feedback,
    f.changeItem, f.changeRequest, f.changeImage, f.changeCurrent, f.deleteItem, f.deleteRequest, f.saveItem,
    f.saveImage, f.saveFingerprint, `Isolation canary ${L}`, `Isolation plain ${L}`, `Isolation outfit ${L}`,
    `Isolation look ${L}`].filter(Boolean);
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
  const stableExport = { ...exported };
  delete stableExport.created_at;
  delete stableExport.export_id;
  state.export = stableExport;
  state.change = (await call(owner, 'image_change_status', { p_item_id: f.changeItem, p_request_id: f.changeRequest })).data;
  state.operation = (await call(owner, 'item_deletion_operation_status', { p_item_id: f.deleteItem, p_request_id: f.deleteRequest })).data;
  const ai = (await call(owner, 'ai_status', {})).data;
  if (ai && typeof ai === 'object') { const rest = { ...ai }; delete rest.serverTimeMs; state.ai = rest; } else state.ai = ai;
  state.request = (await call(owner, 'ai_analysis_status', { p_request_id: f.aiReady })).data;
  return state;
}
function compareState(label, before, after) {
  for (const table of TABLES) need(isDeepStrictEqual(before.tables[table], after.tables[table]), `${label}: ${table} rows changed`);
  need(isDeepStrictEqual(before.objects, after.objects), `${label}: object bytes changed`);
  const parts = aiReservationAccepted ? ['export', 'change', 'operation'] : ['export', 'change', 'operation', 'ai', 'request'];
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
  if (expected.any) return true;
  const ok = expected.check ? result.status === expected.status && expected.check(result.data) : matchOutcome(expected, result);
  return need(ok, `${label}: expected ${expected.status}/${expected.code ?? ''}, observed ${describe(result)}`);
};

/** Foreign-reference cases: `keys` name the victim IDs substituted, one family at a time. */
function foreignCases(a, v) {
  const n1 = randomUUID(), n2 = randomUUID();
  const intentWith = (item) => { const x = structuredClone(a.changeIntent); x.requestId = n1; x.imageId = n2; x.image.id = n2; x.itemId = item; return x; };
  return [
    ['commit_image', ['image'], (x) => ({ p_image_id: x.image }), NA],
    ['retire_image', ['image'], (x) => ({ p_image_id: x.image }), NA_PLAIN],
    ['forget_image', ['retired'], (x) => ({ p_image_id: x.retired }), VOID],
    ['update_image_description', ['image'], (x) => ({ p_image_id: x.image, p_expected_description_version: 1, p_alt_text: 'Forbidden' }), NA],
    ['item_attribution_history', ['changeItem'], (x) => ({ p_item_id: x.changeItem }), NA],
    ['image_recovery_versions', ['item'], (x) => ({ p_item_id: x.item, p_after: null }), NA],
    ['restore_history_entry', ['event'], (x) => ({ p_id: n1, p_event_id: x.event, p_item_id: null, p_title: 'Forbidden',
      p_category: 'top', p_import_id: n2 }), NA],
    ['restore_history_entry', ['item'], (x) => ({ p_id: n1, p_event_id: a.event, p_item_id: x.item, p_title: 'Forbidden',
      p_category: 'top', p_import_id: n2 }), NA],
    ['save_outfit', ['item'], (x) => ({ p_id: n1, p_title: 'Forbidden', p_occasion: 'everyday', p_notes: '', p_favourite: false,
      p_item_ids: [a.item, x.item], p_expected_version: null }), SELECTION],
    ['save_outfit', ['outfit'], (x) => ({ p_id: x.outfit, p_title: 'Forbidden', p_occasion: 'everyday', p_notes: '',
      p_favourite: false, p_item_ids: [a.item], p_expected_version: 1 }), CONFLICT_PLAIN],
    ['save_wear_event', ['item'], (x) => ({ p_id: n1, p_local_date: '2026-01-02', p_timezone: 'Europe/Helsinki', p_state: 'worn',
      p_label: 'Forbidden', p_outfit_id: null, p_item_ids: [a.item, x.item], p_expected_version: null }), SELECTION],
    ['save_wear_event', ['event'], (x) => ({ p_id: x.event, p_local_date: '2026-01-02', p_timezone: 'Europe/Helsinki',
      p_state: 'worn', p_label: 'Forbidden', p_outfit_id: null, p_item_ids: [a.item], p_expected_version: 1 }), CONFLICT_PLAIN],
    ['save_wear_event', ['outfit'], (x) => ({ p_id: n1, p_local_date: '2026-01-02', p_timezone: 'Europe/Helsinki',
      p_state: 'worn', p_label: 'Forbidden', p_outfit_id: x.outfit, p_item_ids: [a.item], p_expected_version: null }),
      { status: 409, code: '23503' }],
    ['ai_request_control', ['aiReady'], (x) => ({ p_request_id: x.aiReady, p_action: 'status' }), UNAVAILABLE],
    ['ai_request_control', ['aiReady'], (x) => ({ p_request_id: x.aiReady, p_action: 'discard' }), UNAVAILABLE],
    ['ai_analysis_status', ['aiReady'], (x) => ({ p_request_id: x.aiReady }), UNAVAILABLE],
    // Owner-local allowance/rate state decides this outcome; only equivalence and victim state count.
    ['ai_begin_request', ['aiReady'], (x) => ({ p_request_id: x.aiReady, p_draft_id: n1, p_generation: 1, p_image_sha256: HEX }), { any: true }],
    ['reserve_analyzed_item_save', ['aiReady'], (x) => {
      const value = intent(); value.p_item.id = n1; value.p_image.id = n2;
      return { ...value, p_claim: { requestId: x.aiReady, draftId: n1, generation: 1, imageSha256: value.p_image.main_sha256 } };
    }, { status: 400, code: '22023' }],
    ['finalize_item_save', ['saveItem', 'saveImage'], (x) => ({ p_item_id: x.saveItem, p_image_id: x.saveImage, p_fingerprint: v.saveFingerprint }), CONFLICT],
    ['analyzed_item_save_preflight', ['saveItem', 'saveImage'], (x) => ({ p_item_id: x.saveItem, p_image_id: x.saveImage, p_fingerprint: v.saveFingerprint }), CONFLICT],
    ['cancel_analyzed_item_save', ['saveItem', 'saveImage'], (x) => ({ p_item_id: x.saveItem, p_image_id: x.saveImage, p_fingerprint: v.saveFingerprint }), CONFLICT],
    ['set_item_trashed', ['item'], (x) => ({ p_item_id: x.item, p_expected_version: 1, p_trashed: true }), CONFLICT],
    ['item_deletion_status', ['item'], (x) => ({ p_item_ids: [x.item] }), EMPTY],
    ['item_deletion_status', ['item'], (x) => ({ p_item_ids: [a.item, x.item] }),
      { status: 200, check: (d) => Array.isArray(d) && d.length === 1 && d[0].id === a.item }],
    ['begin_item_deletion', ['item'], (x) => ({ p_item_id: x.item, p_expected_version: 1, p_request_id: n1, p_image_manifest_sha256: HEX }), CONFLICT],
    ['finish_item_deletion', ['deleteItem', 'deleteRequest'], (x) => ({ p_item_id: x.deleteItem, p_request_id: x.deleteRequest }),
      { status: 200, data: [{ state: 'absent' }] }],
    ['reserve_image_change', ['changeItem'], (x) => ({ p_intent: intentWith(x.changeItem) }), CONFLICT],
    ['image_change_status', ['changeItem', 'changeRequest'], (x) => ({ p_item_id: x.changeItem, p_request_id: x.changeRequest }), NULL],
    ['image_change_requests', ['changeItem'], (x) => ({ p_item_id: x.changeItem }), EMPTY],
    ['image_recovery_preflight', ['changeItem', 'changeRequest', 'changeImage', 'changeCurrent'], (x) => ({ p_intent: {
      ...structuredClone(v.changeIntent), itemId: x.changeItem, requestId: x.changeRequest, imageId: x.changeImage,
      currentImageId: x.changeCurrent, image: { ...v.changeIntent.image, id: x.changeImage } } }), CONFLICT],
    ['image_change_preflight', ['changeItem', 'changeRequest', 'changeImage', 'changeCurrent'], (x) => ({ p_intent: {
      ...structuredClone(v.changeIntent), itemId: x.changeItem, requestId: x.changeRequest, imageId: x.changeImage,
      currentImageId: x.changeCurrent, image: { ...v.changeIntent.image, id: x.changeImage } } }), CONFLICT],
    ['cancel_image_change', ['changeItem', 'changeRequest'], (x) => ({ p_item_id: x.changeItem, p_request_id: x.changeRequest }), NULL],
    ['item_deletion_operation_status', ['deleteItem', 'deleteRequest'], (x) => ({ p_item_id: x.deleteItem, p_request_id: x.deleteRequest }), NULL],
    ['item_deletion_operations', ['deleteItem'], (x) => ({ p_item_ids: [x.deleteItem] }), EMPTY],
    ['item_deletion_operations', ['deleteItem'], (x) => ({ p_item_ids: [a.deleteItem, x.deleteItem] }),
      { status: 200, check: (d) => Array.isArray(d) && d.length === 1 }],
    ['prepare_item_deletion', ['item'], (x) => ({ p_item_id: x.item, p_request_id: n1, p_expected_version: 1, p_image_manifest_sha256: HEX }), CONFLICT],
    ...['inventory_item_deletion', 'cancel_item_deletion_preparation', 'item_deletion_next_target', 'begin_prepared_item_deletion']
      .map((name) => [name, ['deleteItem', 'deleteRequest'], (x) => ({ p_item_id: x.deleteItem, p_request_id: x.deleteRequest }), CONFLICT]),
    ['authorize_item_deletion', ['deleteItem', 'deleteRequest'], (x) => ({ p_item_id: x.deleteItem, p_request_id: x.deleteRequest, p_inventory_hash: HEX }), CONFLICT],
    ['reconcile_item_deletion_target', ['deleteItem', 'deleteRequest'], (x) => ({ p_item_id: x.deleteItem, p_request_id: x.deleteRequest, p_ordinal: 1 }), CONFLICT],
  ].map(([name, keys, build, expected]) => ({ name, keys, build, expected }));
}

async function foreignMatrix(attacker, victim) {
  const a = fixtures[attacker.label], v = fixtures[victim.label], direction = `${attacker.label}>${victim.label}`;
  for (const test of foreignCases(a, v)) {
    stage = `matrix-${direction}-${test.name}-${test.keys.join('+')}`;
    const missingIds = Object.fromEntries(test.keys.map((k) => [k, randomUUID()]));
    const foreign = await probeRpc(attacker, victim, test.name, test.build(v));
    const missing = await probeRpc(attacker, victim, test.name, test.build({ ...v, ...missingIds }));
    expectMatch(`${stage} foreign`, test.expected, foreign);
    expectMatch(`${stage} nonexistent`, test.expected, missing);
    need(sameOutcome(foreign, missing, test.keys.map((k) => v[k]), test.keys.map((k) => missingIds[k])),
      `${stage}: foreign ${describe(foreign)} differs from nonexistent ${describe(missing)}`);
    if (test.name === 'ai_begin_request' && (foreign.ok || missing.ok)) {
      aiReservationAccepted = true;
      findings.push('ai_begin_request accepted an owner-local reservation; only equivalence and peer state are ownership evidence');
    } else if (test.name === 'ai_begin_request') {
      unverified.push(`ai_begin_request ${direction} was refused by allowance/rate state (${describe(foreign)}); not ownership proof`);
    }
    tag(test.name, direction);
  }
  stage = `matrix-${direction}-owner-only`;
  const exported = await probeRpc(attacker, victim, 'export_manifest', { p_export_id: randomUUID() });
  exportShape(attacker, exported); tag('export_manifest', direction);
  const status = await probeRpc(attacker, victim, 'ai_status', {});
  need(status.ok, `${stage}: own ai_status ${describe(status)}`); tag('ai_status', direction);
  const consent = await probeRpc(attacker, victim, 'ai_set_consent', { p_enabled: false, p_notice_revision: 1, p_expected_version: 999_999_999 });
  need(!consent.ok && consent.status < 500, `${stage}: stale consent write ${describe(consent)}`); tag('ai_set_consent', direction);
}

function exportShape(owner, result) {
  const f = fixtures[owner.label], data = result.data;
  if (!need(result.ok && data && typeof data === 'object' && !Array.isArray(data), `${stage}: export ${describe(result)}`)) return;
  need(isDeepStrictEqual(Object.keys(data).sort(), ['created_at', 'export_id', 'owner_id', 'schema_version', 'tables']), `${stage}: export keys`);
  need(data.owner_id === owner.uid && data.schema_version === 2, `${stage}: export owner/schema`);
  need(isDeepStrictEqual(Object.keys(data.tables ?? {}).sort(), [...TABLES].sort()), `${stage}: export table keys`);
  for (const table of TABLES) {
    const rows = data.tables?.[table];
    need(Array.isArray(rows) && rows.every((row) => row.owner_id === owner.uid), `${stage}: export ${table} ownership`);
  }
  const ids = (table, field = 'id') => new Set((data.tables?.[table] ?? []).map((row) => row[field]));
  for (const [table, field, id] of [['items', 'id', f.item], ['items', 'id', f.plain], ['item_images', 'id', f.image],
    ['item_images', 'id', f.retired], ['outfits', 'id', f.outfit], ['outfit_items', 'outfit_id', f.outfit],
    ['wear_events', 'id', f.event], ['wear_event_items', 'id', f.eventItem], ['combination_rules', 'id', f.rule],
    ['suggestion_feedback', 'id', f.feedback], ['profiles', 'owner_id', owner.uid], ['style_preferences', 'owner_id', owner.uid]]) {
    need(ids(table, field).has(id), `${stage}: export lacks the ${table} fixture`);
  }
}

// --- Existence oracles on create-ID collisions --------------------------------------------------------
async function oracles(attacker, victim) {
  const a = fixtures[attacker.label], v = fixtures[victim.label], direction = `${attacker.label}>${victim.label}`;
  const sh = saveHarness(client, attacker);
  const record = async (surface, expectedForeign, foreign, missing, cleanup) => {
    stage = `oracle-${direction}-${surface}`;
    expectMatch(`${stage} foreign`, expectedForeign, foreign);
    need(!foreign.ok, `${stage}: foreign create succeeded`);
    need(missing.ok, `${stage}: random control ${describe(missing)}`);
    if (missing.ok) await cleanup();
    if (!sameOutcome(foreign, missing, [], [])) findings.push(`${surface}: a peer-owned ID returns ${describe(foreign)}, a new ID ${describe(missing)} (existence oracle)`);
  };
  const outfit = (id) => ({ p_id: id, p_title: 'Isolation oracle', p_occasion: 'everyday', p_notes: '', p_favourite: false,
    p_item_ids: [a.plain], p_expected_version: null });
  const del = (table, id) => async () => fatal((await raw(attacker.token, `/rest/v1/${table}?owner_id=eq.${attacker.uid}&id=eq.${id}`, { method: 'DELETE' })).ok, 'oracle-cleanup');
  let id = randomUUID();
  await record('save_outfit p_id', { status: 409, code: '23505' }, await probeRpc(attacker, victim, 'save_outfit', outfit(v.outfit)),
    await call(attacker, 'save_outfit', outfit(id)), del('outfits', id));
  const wear = (x) => ({ p_id: x, p_local_date: '2026-01-03', p_timezone: 'Europe/Helsinki', p_state: 'worn', p_label: 'Isolation oracle',
    p_outfit_id: null, p_item_ids: [a.plain], p_expected_version: null });
  id = randomUUID();
  await record('save_wear_event p_id', { status: 409, code: '23505' }, await probeRpc(attacker, victim, 'save_wear_event', wear(v.event)),
    await call(attacker, 'save_wear_event', wear(id)), del('wear_events', id));
  id = randomUUID();
  const item = (x) => ({ method: 'POST', body: { id: x, owner_id: attacker.uid, title: 'Isolation oracle', category: 'top' } });
  await record('REST items id', { status: 409, code: '23505' }, await probe(attacker, victim, '/rest/v1/items', item(v.item)),
    await raw(attacker.token, '/rest/v1/items', item(id)), del('items', id));
  const history = (x) => ({ p_id: x, p_event_id: a.event, p_item_id: null, p_title: 'Isolation oracle', p_category: 'top', p_import_id: randomUUID() });
  id = randomUUID();
  await record('restore_history_entry p_id', CONFLICT_PLAIN, await probeRpc(attacker, victim, 'restore_history_entry', history(v.eventItem)),
    await call(attacker, 'restore_history_entry', history(id)), del('wear_event_items', id));
  const foreignSave = intent(); foreignSave.p_item.id = v.item;
  const control = sh.track(intent());
  await record('reserve_item_save p_item.id', { status: 400, code: '22023' }, await probeRpc(attacker, victim, 'reserve_item_save', foreignSave),
    await call(attacker, 'reserve_item_save', control), () => sh.cleanup());
  tag('reserve_item_save', direction);
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
    need(!remove.ok && sameOutcome(remove, removeAbsent, masked, random), `${stage}: delete foreign ${describe(remove)} vs ${describe(removeAbsent)}`);
  }
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
    ['analyze-clothing', { requestId: v.aiReady, draftId: randomUUID(), generation: 1 }],
  ]) {
    stage = `edge-${direction}-${name}`;
    const result = await raw(attacker.token, `/functions/v1/${name}`, { method: 'POST', body });
    const unconfigured = result.transport || result.status >= 500 || result.status === 404
      || /UNCONFIGURED/.test(result.text);
    if (unconfigured) { const note = `Edge ${name} not served with configuration in this job (${result.status})`; if (!unverified.includes(note)) unverified.push(note); continue; }
    need(!result.ok, `${stage}: peer request accepted (${result.status})`);
    if (name === 'analyze-clothing' && [400, 413, 415, 422].includes(result.status)) {
      const note = `Edge analyze-clothing rejected the probe input (${result.status}) before any ownership decision`;
      if (!unverified.includes(note)) unverified.push(note);
    }
    need(scanLeaks(result.text, v.tokens, v.tokens.filter((t) => JSON.stringify(body).includes(t))).length === 0, `${stage}: leaked peer values`);
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
    ['item_deletion_operations', { p_item_ids: [f.deleteItem] }, (d) => Array.isArray(d) && d.length === 1],
    ['item_deletion_operation_status', { p_item_id: f.deleteItem, p_request_id: f.deleteRequest }, (d) => d !== null],
    ['image_change_status', { p_item_id: f.changeItem, p_request_id: f.changeRequest }, (d) => d !== null && d.requestId === f.changeRequest],
    ['image_change_requests', { p_item_id: f.changeItem }, (d) => Array.isArray(d) && d.length === 1],
    ['item_attribution_history', { p_item_id: f.changeItem }, (d) => Array.isArray(d)],
    ['image_recovery_versions', { p_item_id: f.item, p_after: null }, (d) => d !== null],
  ];
  for (const [name, body, check] of checks) {
    const result = await call(owner, name, body);
    need(result.ok && check(result.data), `${stage}: own ${name} ${describe(result)}`);
  }
  const ai = await call(owner, 'ai_analysis_status', { p_request_id: f.aiReady });
  if (!(ai.ok && ai.data && ai.data.code !== 'UNAVAILABLE')) unverified.push(`own AI request fixture ${owner.label} not present here; ownership positive control is the ai-controls suite`);
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
      ['ai_request_control', { p_request_id: f.aiReady, p_action: 'status' }, UNAVAILABLE],
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
    await foreignMatrix(attacker, victim);
    await restIsolation(attacker, victim);
    exportShape(attacker, await call(attacker, 'export_manifest', { p_export_id: randomUUID() }));
    await storageIsolation(attacker, victim);
    await discovery(attacker, victim);
    await edgeProbes(attacker, victim);
    await oracles(attacker, victim);
  }
  stage = 'victim-postconditions';
  compareState('owner A after peer probes', baseline.A, await ownerState(owners[0]));
  compareState('owner B after peer probes', baseline.B, await ownerState(owners[1]));
  problems.push(...validateCoverage(covered));
  await freezeCase(owners[0], owners[1]);
  await freezeCase(owners[1], owners[0]);
} catch (error) {
  const label = error instanceof Error && error.message.startsWith('I17_FATAL:') ? error.message.slice(10) : stage;
  console.error(`FAIL: I17 isolation audit stopped at ${label.replace(uuidPattern, '<id>')}; private evidence withheld`);
  exitCode = 1;
} finally {
  stage = 'cleanup';
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { console.error('FAIL: I17 fixture cleanup incomplete'); exitCode = 1; }
  }
}
for (const note of findings.slice(0, 40)) console.log(`FINDING: ${note}`);
for (const note of unverified.slice(0, 40)) console.log(`UNVERIFIED: ${note}`);
if (problems.length) {
  for (const problem of problems.slice(0, 120)) console.error(`MISMATCH: ${problem.replace(uuidPattern, '<id>')}`);
  if (problems.length > 120) console.error(`MISMATCH: ${problems.length - 120} more withheld`);
  exitCode = 1;
}
if (exitCode === 0) console.log(`PASS: I17 owner isolation; ${EXPOSED_RPCS.length} RPCs in both directions, anonymous and service denials, REST/export/Storage and freeze`);
else console.error('FAIL: I17 owner isolation audit');
process.exitCode = exitCode;
process.disconnect?.();
