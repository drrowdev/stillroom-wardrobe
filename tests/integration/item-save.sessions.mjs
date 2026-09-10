import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from '../../scripts/quality/files.mjs';
import { normalClient, requireEvidence } from './preservation.sessions.mjs';

export const eq = (left, right) => requireEvidence(isDeepStrictEqual(left, right));
export function equalAiStatusState(left, right) {
  requireEvidence(left !== null && typeof left === 'object' && !Array.isArray(left)
    && right !== null && typeof right === 'object' && !Array.isArray(right));
  requireEvidence(Object.hasOwn(left, 'serverTimeMs') && Object.hasOwn(right, 'serverTimeMs'));
  const { serverTimeMs: leftClock, ...leftState } = left;
  const { serverTimeMs: rightClock, ...rightState } = right;
  requireEvidence(Number.isSafeInteger(leftClock) && leftClock >= 0
    && Number.isSafeInteger(rightClock) && rightClock >= 0);
  eq(leftState, rightState);
}
let phase = 'arguments';
// Tiny synthetic transport bytes prove object presence, not valid camera/JPEG processing.
export const bytes = new Uint8Array([255, 216, 255, 217]);
const hash = createHash('sha256').update(bytes).digest('hex');
export const manualFields = [
  'title','category','subcategory','colours','pattern','sleeve_length','garment_length',
  'brand','size_label','material','seasons','formality','warmth','min_temp','max_temp',
  'rain_rating','windproof','upper_coverage','lower_coverage','style_tags','tags',
  'purchase_date','purchase_price','notes',
];
export function intent() {
  return {
    p_item: {
      id: randomUUID(), title: 'Fictional checked garment', category: 'top', subcategory: null,
      colours: [], pattern: null, sleeve_length: null, garment_length: null,
      brand: null, size_label: null, material: null, seasons: [], formality: null, warmth: null,
      min_temp: null, max_temp: null, rain_rating: null, windproof: null, upper_coverage: null,
      lower_coverage: null, style_tags: [], tags: [], purchase_date: null, purchase_price: null, notes: '',
      currency: 'EUR', favourite: false, availability: 'ready', lifecycle: 'active',
      exclude_suggestions: false, wear_more: false,
      field_provenance: { title: { kind: 'user', revision: 1 }, category: { kind: 'user', revision: 1 } },
    },
    p_image: { id: randomUUID(), main_bytes: bytes.length, thumb_bytes: bytes.length,
      main_sha256: hash, thumb_sha256: hash, width: 2, height: 2, alt_text: '' },
  };
}
export async function saveClients(env) {
  const client = normalClient(env);
  const owners = [await client.signIn('A'), await client.signIn('B')];
  requireEvidence(owners[0].uid !== owners[1].uid && owners[0].token !== owners[1].token);
  return { client, owners };
}
export function saveHarness(client, owner) {
  const attempts = [];
  const call = (name, body, token = owner.token) => client.request(token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
  const read = async (table, id) => {
    const result = await client.request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&id=eq.${id}&select=*`);
    requireEvidence(result.ok && Array.isArray(result.data));
    return result.data;
  };
  const track = (value = intent()) => { attempts.push(value); return value; };
  const reserve = async (value) => {
    const result = await call('reserve_item_save', value);
    requireEvidence(result.ok && result.status === 200 && Array.isArray(result.data) && result.data.length === 1);
    const row = result.data[0];
    requireEvidence(/^[0-9a-f]{64}$/.test(row.fingerprint) && ['reserved', 'completed'].includes(row.state));
    for (const [key, expected] of Object.entries(value.p_item)) eq(row.item[key], expected);
    for (const [key, expected] of Object.entries(value.p_image)) eq(row.image[key], expected);
    eq(row.item.owner_id, owner.uid); eq(row.image.owner_id, owner.uid);
    eq(row.image.item_id, value.p_item.id); eq(row.item.version, 1); eq(row.item.deleted_at, null);
    eq(row.image.description_version, 1); eq(row.image.retired_at, null);
    eq(await read('items', value.p_item.id), [row.item]);
    eq(await read('item_images', value.p_image.id), [row.image]);
    return row;
  };
  const paths = (value) => ['thumb', 'main'].map((variant) =>
    `${owner.uid}/${value.p_item.id}/${value.p_image.id}/${variant}.jpg`);
  const upload = async (value) => {
    for (const path of paths(value)) {
      const result = await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`,
        { method: 'POST', body: bytes, binary: true, headers: { 'x-upsert': 'false', 'cache-control': '0' } });
      requireEvidence(result.ok);
    }
  };
  const remove = async (value) => {
    const result = await client.request(owner.token, '/storage/v1/object/wardrobe',
      { method: 'DELETE', body: { prefixes: paths(value) } });
    requireEvidence(result.ok);
  };
  const deleteItem = async (value) => {
    const result = await client.request(owner.token,
      `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${value.p_item.id}`, { method: 'DELETE' });
    requireEvidence(result.ok);
  };
  const finalizeArgs = (value, row) => ({ p_item_id: value.p_item.id, p_image_id: value.p_image.id, p_fingerprint: row.fingerprint });
  const finalize = async (value, row) => {
    const result = await call('finalize_item_save', finalizeArgs(value, row));
    requireEvidence(result.ok && result.status === 204 && result.data === null);
  };
  const cleanup = async () => {
    for (const value of attempts) { await remove(value); await deleteItem(value); }
  };
  return { call, read, track, reserve, paths, upload, remove, deleteItem, finalizeArgs, finalize, cleanup };
}
export function denied(result, message = 'Request conflict') {
  requireEvidence(!result.ok && result.status === 400 && result.data.code === '22023');
  eq(result.data.message, message);
  requireEvidence(result.data.details === null && result.data.hint === null);
}
export async function boundedRace(operations) {
  const start = performance.now();
  const result = await Promise.all(operations.map((operation) => operation()));
  requireEvidence(performance.now() - start < 15_000);
  for (const response of result) if (!response.ok) denied(response);
  return result;
}

async function legacyReplacementCases(client, owner, h) {
  // One request pair of each kind per owner; this does not force database overlap.
  for (const kind of ['description', 'retire']) {
    const old = h.track(), replacement = h.track();
    replacement.p_item = { ...old.p_item };
    const item = await client.insert(owner, 'items', old.p_item);
    const original = await client.insert(owner, 'item_images', { ...old.p_image, item_id: item.id });
    eq(original.state, 'pending'); eq(original.description_version, 1); eq(original.retired_at, null);
    await h.upload(old);
    await client.rpc(owner, 'commit_image', { p_image_id: original.id });
    let ready = { ...original, state: 'ready' };
    eq(await h.read('item_images', original.id), [ready]);
    const pending = await client.insert(owner, 'item_images', { ...replacement.p_image, item_id: item.id });
    eq(pending.state, 'pending'); eq(pending.description_version, 1); eq(pending.retired_at, null);
    await h.upload(replacement);
    eq(await h.read('items', item.id), [item]);
    const start = performance.now();
    const [change, commit] = await Promise.all([
      kind === 'description' ? h.call('update_image_description', {
        p_image_id: ready.id, p_expected_description_version: ready.description_version,
        p_alt_text: 'Fictional legacy correction',
      }) : h.call('retire_image', { p_image_id: ready.id }),
      h.call('commit_image', { p_image_id: pending.id }),
    ]);
    requireEvidence(performance.now() - start < 15_000);
    requireEvidence(commit.ok && commit.status === 204 && commit.data === null);
    if (kind === 'description') {
      if (change.ok) {
        eq(change.status, 200);
        ready = { ...ready, alt_text: 'Fictional legacy correction', description_version: ready.description_version + 1 };
        eq(change.data, [{
          id: ready.id, owner_id: owner.uid, item_id: item.id,
          alt_text: ready.alt_text, description_version: ready.description_version,
        }]);
      } else {
        requireEvidence(change.status === 403);
        eq(change.data, { code: '42501', message: 'Not available', details: null, hint: null });
      }
    } else requireEvidence(change.ok && change.status === 204 && change.data === null);
    const retiredRows = await h.read('item_images', ready.id);
    requireEvidence(retiredRows.length === 1 && typeof retiredRows[0].retired_at === 'string'
      && Number.isFinite(Date.parse(retiredRows[0].retired_at)));
    eq(retiredRows, [{ ...ready, state: 'retired', retired_at: retiredRows[0].retired_at }]);
    eq(await h.read('item_images', pending.id), [{ ...pending, state: 'ready' }]);
    eq(await h.read('items', item.id), [item]);
    for (const path of [...h.paths(old), ...h.paths(replacement)]) {
      const download = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
      requireEvidence(download.ok && download.status === 200 && Buffer.isBuffer(download.data));
      eq(download.data.length, bytes.length);
      eq(createHash('sha256').update(download.data).digest('hex'), hash);
      eq(download.data, Buffer.from(bytes));
    }
  }
}

async function ownerCases(client, owner) {
  const h = saveHarness(client, owner);
  try {
    phase = 'initial-profile-status';
    const profileBefore = await client.rows(owner, 'profiles');
    const aiBefore = await client.rpc(owner, 'ai_status', {});
    phase = 'first-reserve-replay';
    const value = h.track(), reserved = await h.reserve(value);
    eq(await h.reserve(value), reserved);
    phase = 'incomplete-upload-state';
    denied(await h.call('finalize_item_save', h.finalizeArgs(value, reserved)), 'Upload incomplete');
    eq((await h.read('item_images', value.p_image.id))[0].state, 'pending');
    phase = 'upload-raw-bypass-finalize-completed-replay';
    await h.upload(value);
    denied(await h.call('commit_image', { p_image_id: value.p_image.id }));
    await h.finalize(value, reserved);
    const completed = await h.reserve(value);
    eq(completed.state, 'completed'); eq(completed.image.state, 'ready');
    await h.finalize(value, completed);
    eq(await h.reserve(value), completed);
    phase = 'unchanged-profile-ai';
    eq(await client.rows(owner, 'profiles'), profileBefore);
    equalAiStatusState(await client.rpc(owner, 'ai_status', {}), aiBefore);

    phase = 'full-fields-canonical-equivalence-mutated-intents';
    const all = h.track();
    Object.assign(all.p_item, {
      subcategory: 'shirt', colours: ['green'], pattern: 'solid', sleeve_length: 'long',
      garment_length: 'regular', brand: 'Fictional', size_label: 'M', material: 'Owner supplied',
      seasons: ['summer'], formality: 2, warmth: 2, min_temp: -5, max_temp: 25, rain_rating: 1,
      windproof: false, upper_coverage: 2, lower_coverage: 1, style_tags: ['relaxed'], tags: ['fictional'],
      purchase_date: '2024-02-29', purchase_price: 12.5, notes: 'Fictional\n🌿', currency: 'SEK',
      favourite: true, availability: 'laundry', lifecycle: 'archived', exclude_suggestions: true, wear_more: true,
      field_provenance: Object.fromEntries(manualFields.map((field) => [field, { kind: 'user', revision: 1 }])),
    });
    all.p_image.alt_text = 'Fictional caption';
    const full = await h.reserve(all);
    const reordered = { p_item: Object.fromEntries(Object.entries(all.p_item).reverse()), p_image: { ...all.p_image } };
    eq(await h.reserve(reordered), full);
    const numeric = structuredClone(all);
    numeric.p_item.purchase_price = JSON.rawJSON('12.50');
    numeric.p_item.field_provenance.title.revision = JSON.rawJSON('1.0');
    const semantic = await h.call('reserve_item_save', numeric);
    requireEvidence(semantic.ok); eq(semantic.data, [full]);
    for (const key of Object.keys(all.p_item).filter((key) => key !== 'id')) {
      const changed = structuredClone(all);
      const old = changed.p_item[key];
      changed.p_item[key] = Array.isArray(old) ? [] : typeof old === 'boolean' ? !old
        : typeof old === 'number' ? old + 1 : key === 'field_provenance' ? {} : null;
      const result = await h.call('reserve_item_save', changed);
      requireEvidence(!result.ok);
      eq(await h.reserve(all), full);
    }
    for (const key of Object.keys(all.p_image).filter((key) => key !== 'id')) {
      const changed = structuredClone(all);
      changed.p_image[key] = key.endsWith('sha256') ? 'b'.repeat(64)
        : typeof changed.p_image[key] === 'number' ? changed.p_image[key] + 1 : '';
      denied(await h.call('reserve_item_save', changed));
    }

    // Failed first transaction must not claim either identity.
    phase = 'invalid-first-rollback';
    for (const change of [
      (v) => { v.p_image.width = 0; }, (v) => { v.p_item.category = 'invalid'; },
      (v) => { v.p_item.purchase_date = '2026-02-30'; v.p_item.field_provenance.purchase_date = { kind: 'user', revision: 1 }; },
    ]) {
      const valid = h.track(), bad = structuredClone(valid); change(bad);
      denied(await h.call('reserve_item_save', bad), 'Invalid input');
      eq(await h.read('items', valid.p_item.id), []); eq(await h.read('item_images', valid.p_image.id), []);
      await h.reserve(valid);
    }

    // Permanent deletion removes live content, not the owner-local used identities.
    phase = 'deletion';
    const pending = h.track(); await h.reserve(pending); await h.deleteItem(pending);
    denied(await h.call('reserve_item_save', pending));
    for (const combination of [
      { p_item: { ...pending.p_item }, p_image: { ...pending.p_image, id: randomUUID() } },
      { p_item: { ...pending.p_item, id: randomUUID() }, p_image: { ...pending.p_image } },
    ]) { h.track(combination); denied(await h.call('reserve_item_save', combination)); }
    await h.remove(value);
    denied(await h.call('reserve_item_save', value), 'Upload incomplete');
    denied(await h.call('finalize_item_save', h.finalizeArgs(value, completed)), 'Upload incomplete');
    requireEvidence((await h.call('forget_image', { p_image_id: value.p_image.id })).ok);
    denied(await h.call('reserve_item_save', value));
    denied(await h.call('finalize_item_save', h.finalizeArgs(value, completed)));
    await h.deleteItem(value);
    denied(await h.call('reserve_item_save', value));

    phase = 'stale-state';
    for (const mutation of ['field', 'version', 'soft-delete', 'caption', 'counter', 'retire', 'cleanup']) {
      const current = h.track(), row = await h.reserve(current);
      await h.upload(current); await h.finalize(current, row);
      if (['field', 'version', 'soft-delete'].includes(mutation)) {
        const body = mutation === 'field' ? { title: 'Changed' } : mutation === 'version' ? { favourite: false }
          : { deleted_at: '2026-09-10T00:00:00Z' };
        const patched = await client.patch(owner, 'items', row.item, body); requireEvidence(patched.ok);
      } else if (mutation === 'caption' || mutation === 'counter') {
        requireEvidence((await h.call('update_image_description', {
          p_image_id: current.p_image.id, p_expected_description_version: 1,
          p_alt_text: mutation === 'caption' ? 'Changed' : '',
        })).ok);
      } else if (mutation === 'retire') {
        requireEvidence((await h.call('retire_image', { p_image_id: current.p_image.id })).ok);
      } else {
        await h.remove(current); requireEvidence((await h.call('forget_image', { p_image_id: current.p_image.id })).ok);
      }
      denied(await h.call('reserve_item_save', current));
      denied(await h.call('finalize_item_save', h.finalizeArgs(current, row)));
    }

    // Actual ordinary PostgREST overlap, bounded failure rather than a lock-graph claim.
    phase = 'race-groups';
    for (const kind of ['reserve', 'finalize', 'delete-reserve', 'delete-finalize', 'retire-finalize', 'description-finalize']) {
      const current = h.track(), row = kind === 'reserve' ? null : await h.reserve(current);
      if (kind !== 'reserve') await h.upload(current);
      if (kind === 'description-finalize') await h.finalize(current, row);
      const reserve = () => h.call('reserve_item_save', current);
      const finalize = () => h.call('finalize_item_save', h.finalizeArgs(current, row));
      const deletion = () => client.request(owner.token,
        `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${current.p_item.id}`, { method: 'DELETE' });
      if (kind === 'reserve') {
        const results = await boundedRace([reserve, reserve]);
        requireEvidence(results.some((result) => result.ok)); await h.reserve(current);
      } else if (kind === 'finalize') {
        const results = await boundedRace([finalize, finalize]);
        requireEvidence(results.some((result) => result.ok)); eq((await h.reserve(current)).state, 'completed');
      } else if (kind.startsWith('delete')) {
        const results = await boundedRace([deletion, kind === 'delete-reserve' ? reserve : finalize]);
        requireEvidence(results[0].ok);
        eq(await h.read('items', current.p_item.id), []); eq(await h.read('item_images', current.p_image.id), []);
        denied(await reserve()); denied(await finalize());
      } else if (kind === 'retire-finalize') {
        const results = await boundedRace([() => h.call('retire_image', { p_image_id: current.p_image.id }), finalize]);
        requireEvidence(results[0].ok);
        eq((await h.read('item_images', current.p_image.id))[0].state, 'retired');
        denied(await reserve()); denied(await finalize());
      } else {
        const results = await boundedRace([() => h.call('update_image_description', {
          p_image_id: current.p_image.id, p_expected_description_version: 1, p_alt_text: '',
        }), finalize]);
        requireEvidence(results[0].ok);
        eq((await h.read('item_images', current.p_image.id))[0].description_version, 2);
        denied(await reserve()); denied(await finalize());
      }
    }
    phase = 'legacy-cases';
    await legacyReplacementCases(client, owner, h);
  } finally {
    const priorPhase = phase;
    phase = 'cleanup';
    await h.cleanup();
    phase = priorPhase;
  }
}
async function main() {
  try {
    phase = 'arguments';
    requireEvidence(process.argv.length === 2);
    phase = 'sign-in';
    const { client, owners } = await saveClients(process.env);
    for (const owner of owners) await ownerCases(client, owner);
    console.log('PASS: checked manual Save integration; normal owners=2; exact replay, deletion, state, objects and bounded races');
  } catch {
    console.error(`FAIL: checked manual Save integration; phase=${phase}; normal-session evidence required; no private details logged`);
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
