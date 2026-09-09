import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ROOT, PROJECT_ID, MIGRATION_HASH, TEST_EMAILS, validateSessionEnvironment, assertLocalApi, jwtClaims,
} from '../../scripts/backend/local.mjs';
import { isMain } from '../../scripts/quality/files.mjs';

export const SOURCE_HASHES = Object.freeze({
  base: MIGRATION_HASH, target: '4060e963bc5a986857f31bc9b528dd6d7ea8caee720336de8499d59e8f8c3f92',
});
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const hash = /^[0-9a-f]{64}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const NEW_COLUMNS = Object.freeze(['pattern', 'sleeve_length', 'garment_length', 'field_provenance']);
export const COLUMNS = Object.freeze({
  profiles: 'owner_id display_name ui_language timezone currency weather_enabled weather_city latitude longitude created_at updated_at version',
  style_preferences: 'owner_id preferred_colours style_tags excluded_categories minimum_upper_coverage minimum_lower_coverage cold_sensitivity repeat_gap_days created_at updated_at version',
  items: 'id owner_id title category subcategory colours brand size_label material seasons formality warmth min_temp max_temp rain_rating windproof upper_coverage lower_coverage style_tags tags purchase_date purchase_price currency notes favourite availability lifecycle exclude_suggestions wear_more deleted_at created_at updated_at version',
  item_images: 'id owner_id item_id state retired_at main_path thumb_path main_bytes thumb_bytes main_sha256 thumb_sha256 width height alt_text created_at',
  outfits: 'id owner_id title occasion notes favourite deleted_at created_at updated_at version',
  outfit_items: 'owner_id outfit_id item_id position',
  wear_events: 'id owner_id outfit_id local_date timezone state label deleted_at created_at updated_at version',
  wear_event_items: 'id owner_id event_id item_id import_id title_snapshot category_snapshot',
  combination_rules: 'id owner_id item_low item_high created_at',
  suggestion_feedback: 'id owner_id item_ids signature vote created_at',
});
export const TABLES = Object.freeze(Object.keys(COLUMNS));
export const COUNTS = Object.freeze([1, 1, 3, 2, 1, 2, 1, 2, 1, 1]);
export const IMPLICIT_FACTS = Object.freeze({
  formality: 1, warmth: 1, rain_rating: 0, windproof: false, upper_coverage: 0, lower_coverage: 0,
});
export const EXPLICIT_FACTS = Object.freeze({
  formality: 4, warmth: 3, rain_rating: 2, windproof: true, upper_coverage: 2, lower_coverage: 1,
});

export function requireEvidence(condition) {
  if (!condition) throw new Error('EVIDENCE_REQUIRED');
}

function closed(value, keys) {
  requireEvidence(record(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()));
}

export function parsePhaseArguments(args) {
  requireEvidence(Array.isArray(args) && args.length === 2 && ['capture', 'verify'].includes(args[0])
    && typeof args[1] === 'string' && uuid.test(args[1]));
  return { phase: args[0], run: args[1] };
}

export function snapshotPath(run) {
  requireEvidence(typeof run === 'string' && uuid.test(run));
  return path.join(ROOT, '.supabase', `preservation-${run}.json`);
}

export function assertSnapshotPath(filename, run) {
  requireEvidence(filename === snapshotPath(run));
}

async function snapshotDirectory() {
  const info = await lstat(path.join(ROOT, '.supabase'));
  requireEvidence(info.isDirectory() && !info.isSymbolicLink());
}

export async function assertSnapshotAbsent(run) {
  await snapshotDirectory();
  try { await lstat(snapshotPath(run)); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  requireEvidence(false);
}

export function validateSnapshotStat(info) {
  requireEvidence(info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    && info.size > 0 && info.size <= MAX_SNAPSHOT_BYTES && (info.mode & 0o777) === 0o600);
}

function noCredentials(value, depth = 0) {
  requireEvidence(depth <= 10);
  if (typeof value === 'string') {
    requireEvidence(value.length <= 4000
      && !/(?:bearer\s|eyJ[\w-]*\.[\w-]+\.[\w-]+|sb_(?:secret|publishable)_|gh[pousr]_|github_pat_|-----BEGIN .*PRIVATE KEY)/i.test(value));
  } else if (Array.isArray(value)) {
    requireEvidence(value.length <= 32);
    for (const child of value) noCredentials(child, depth + 1);
  } else if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireEvidence(!/(?:password|token|secret|credential|authorization|api.?key|auth.?response|session)/i.test(key));
      noCredentials(child, depth + 1);
    }
  } else requireEvidence(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)));
}

export function rowIdentity(table, row) {
  requireEvidence(TABLES.includes(table) && record(row));
  const keys = ['profiles', 'style_preferences'].includes(table) ? ['owner_id']
    : table === 'outfit_items' ? ['outfit_id', 'item_id'] : ['id'];
  requireEvidence(keys.every((key) => typeof row[key] === 'string' && uuid.test(row[key])));
  return keys.map((key) => row[key]).join('/');
}

export function canonicalRows(table, rows) {
  requireEvidence(Array.isArray(rows) && rows.length <= 32);
  const entries = rows.map((row) => [rowIdentity(table, row), row]);
  requireEvidence(new Set(entries.map(([id]) => id)).size === entries.length);
  return entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
}

function validateTables(tables, owner) {
  closed(tables, TABLES);
  for (const [index, table] of TABLES.entries()) {
    const rows = canonicalRows(table, tables[table]);
    requireEvidence(rows.length === COUNTS[index]);
    for (const row of rows) {
      closed(row, COLUMNS[table].split(' '));
      requireEvidence(row.owner_id === owner);
      for (const [key, value] of Object.entries(row)) {
        const nullable = ['ui_language', 'weather_city', 'latitude', 'longitude', 'subcategory', 'brand',
          'size_label', 'material', 'min_temp', 'max_temp', 'purchase_date', 'purchase_price', 'deleted_at', 'retired_at', 'import_id'].includes(key)
          || (table === 'wear_events' && key === 'outfit_id') || (table === 'wear_event_items' && key === 'item_id');
        if (value === null) { requireEvidence(nullable); continue; }
        if (key.endsWith('_at')) requireEvidence(typeof value === 'string' && timestamp.test(value));
        else if (key === 'id' || key.endsWith('_id') || ['item_low', 'item_high'].includes(key)) requireEvidence(typeof value === 'string' && uuid.test(value));
        else if (key === 'version') requireEvidence(Number.isSafeInteger(value) && value >= 2);
        else if (['purchase_date', 'local_date'].includes(key)) requireEvidence(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
        else if (['colours', 'seasons', 'style_tags', 'tags', 'preferred_colours', 'excluded_categories', 'item_ids'].includes(key)) {
          requireEvidence(Array.isArray(value) && value.every((entry) => typeof entry === 'string' && (key !== 'item_ids' || uuid.test(entry))));
        } else if (['weather_enabled', 'windproof', 'favourite', 'exclude_suggestions', 'wear_more'].includes(key)) requireEvidence(typeof value === 'boolean');
        else if (['latitude', 'longitude', 'purchase_price'].includes(key)) requireEvidence(typeof value === 'number' && Number.isFinite(value));
        else if (['minimum_upper_coverage', 'minimum_lower_coverage', 'cold_sensitivity', 'repeat_gap_days',
          'formality', 'warmth', 'min_temp', 'max_temp', 'rain_rating', 'upper_coverage', 'lower_coverage',
          'main_bytes', 'thumb_bytes', 'width', 'height', 'position', 'vote'].includes(key)) requireEvidence(Number.isSafeInteger(value));
        else requireEvidence(typeof value === 'string');
      }
    }
  }
  const implicit = tables.items.filter((row) => row.title === 'Fictional implicit facts');
  const explicit = tables.items.filter((row) => row.title === 'Fictional explicit facts');
  const imageless = tables.items.filter((row) => row.title === 'Fictional imageless item');
  requireEvidence(implicit.length === 1 && explicit.length === 1 && imageless.length === 1);
  for (const [row, facts] of [[implicit[0], IMPLICIT_FACTS], [explicit[0], EXPLICIT_FACTS]]) {
    for (const [field, value] of Object.entries(facts)) requireEvidence(row[field] === value);
  }
  requireEvidence(isDeepStrictEqual(implicit[0].colours, ['unknown'])
    && isDeepStrictEqual(implicit[0].seasons, ['spring', 'summer', 'autumn', 'winter'])
    && implicit[0].notes === '' && implicit[0].brand === null && implicit[0].purchase_price === null);
  requireEvidence(explicit[0].purchase_price === 123.45 && explicit[0].currency === 'SEK'
    && explicit[0].purchase_date === '2024-02-29' && explicit[0].notes === 'Fictional note\nSecond line 🌿'
    && isDeepStrictEqual(explicit[0].colours, ['green', 'blue'])
    && isDeepStrictEqual(explicit[0].tags, ['fictional', 'preservation']));
  requireEvidence(tables.item_images.every((image) => image.item_id === explicit[0].id)
    && tables.item_images.filter((image) => image.state === 'ready' && image.retired_at === null).length === 1
    && tables.item_images.filter((image) => image.state === 'retired' && typeof image.retired_at === 'string').length === 1);
}

export function validateSnapshot(snapshot, run, owners) {
  requireEvidence(typeof run === 'string' && uuid.test(run) && Array.isArray(owners)
    && owners.length === 2 && owners.every((id) => typeof id === 'string' && uuid.test(id)) && owners[0] !== owners[1]);
  requireEvidence(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES);
  noCredentials(snapshot);
  closed(snapshot, ['schemaVersion', 'projectId', 'stage', 'run', 'sources', 'owners', 'data']);
  requireEvidence(snapshot.schemaVersion === 1 && snapshot.projectId === PROJECT_ID
    && snapshot.stage === 'base' && snapshot.run === run);
  requireEvidence(isDeepStrictEqual(snapshot.sources, SOURCE_HASHES) && isDeepStrictEqual(snapshot.owners, owners));
  requireEvidence(Array.isArray(snapshot.data) && snapshot.data.length === 2);
  for (const [index, data] of snapshot.data.entries()) {
    closed(data, ['label', 'ownerId', 'tables', 'objects']);
    requireEvidence(data.label === ['A', 'B'][index] && data.ownerId === owners[index]);
    validateTables(data.tables, data.ownerId);
    requireEvidence(Array.isArray(data.objects) && data.objects.length === 4);
    const expected = new Map();
    for (const image of data.tables.item_images) {
      for (const variant of ['main', 'thumb']) {
        const objectPath = `${data.ownerId}/${image.item_id}/${image.id}/${variant}.jpg`;
        requireEvidence(image[`${variant}_path`] === objectPath && image[`${variant}_bytes`] === 632
          && typeof image[`${variant}_sha256`] === 'string' && hash.test(image[`${variant}_sha256`]));
        expected.set(objectPath, image[`${variant}_sha256`]);
      }
    }
    for (const object of data.objects) {
      closed(object, ['path', 'bytes', 'sha256']);
      requireEvidence(expected.has(object.path) && object.bytes === 632 && object.sha256 === expected.get(object.path));
      expected.delete(object.path);
    }
    requireEvidence(expected.size === 0);
  }
  return snapshot;
}

export function comparePreservation(before, after, run, owners) {
  validateSnapshot(before, run, owners);
  closed(after, ['schemaVersion', 'projectId', 'stage', 'run', 'sources', 'owners', 'data']);
  const oldShape = structuredClone(after);
  requireEvidence(Array.isArray(oldShape.data) && oldShape.data.length === 2);
  for (const data of oldShape.data) {
    requireEvidence(record(data.tables) && Array.isArray(data.tables.items));
    for (const row of data.tables.items) {
      for (const column of NEW_COLUMNS) {
        requireEvidence(Object.hasOwn(row, column) && isDeepStrictEqual(row[column], column === 'field_provenance' ? {} : null));
        delete row[column];
      }
    }
  }
  validateSnapshot(oldShape, run, owners);
  for (const [index, data] of oldShape.data.entries()) {
    for (const table of TABLES) {
      requireEvidence(isDeepStrictEqual(canonicalRows(table, before.data[index].tables[table]), canonicalRows(table, data.tables[table])));
    }
    const sortObjects = (objects) => [...objects].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    requireEvidence(isDeepStrictEqual(sortObjects(before.data[index].objects), sortObjects(data.objects)));
  }
}

async function readSnapshotFile(run) {
  await snapshotDirectory();
  const filename = snapshotPath(run);
  const stat = await lstat(filename);
  validateSnapshotStat(stat);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    validateSnapshotStat(opened);
    requireEvidence(opened.ino === stat.ino && opened.dev === stat.dev);
    const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireEvidence(bytesRead === opened.size && bytesRead <= MAX_SNAPSHOT_BYTES);
    return { snapshot: JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), stat: opened };
  } finally { await file.close(); }
}

export async function writeSnapshot(snapshot, run, owners) {
  validateSnapshot(snapshot, run, owners);
  await assertSnapshotAbsent(run);
  const file = await open(snapshotPath(run), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(snapshot));
    validateSnapshotStat(await file.stat());
  } finally { await file.close(); }
}

export async function readSnapshot(run, owners) {
  return validateSnapshot((await readSnapshotFile(run)).snapshot, run, owners);
}

export async function cleanupSnapshot(run) {
  await snapshotDirectory();
  const filename = snapshotPath(run);
  let stat;
  try { stat = await lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  // An interrupted write may be empty; remove only the exact run's regular file.
  requireEvidence(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
  await unlink(filename);
}

export function normalClient(env) {
  validateSessionEnvironment(env);
  const base = assertLocalApi(env.SUPABASE_URL), key = env.SUPABASE_PUBLISHABLE_KEY;
  async function request(token, route, { method = 'GET', body, binary = false, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { apikey: key, ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Content-Type': binary ? 'image/jpeg' : 'application/json', ...headers },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
    requireEvidence(response.status < 500);
    if (response.status === 204) {
      requireEvidence(response.body === null);
      return { ok: response.ok, status: response.status, data: null, range: response.headers.get('content-range') };
    }
    requireEvidence(response.body !== null);
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        requireEvidence(length <= MAX_SNAPSHOT_BYTES);
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const raw = Buffer.concat(chunks);
    let data = raw;
    if (!route.startsWith('/storage/v1/object/authenticated/')) {
      try { data = JSON.parse(raw.toString('utf8')); } catch { requireEvidence(raw.length === 0); data = null; }
    }
    return { ok: response.ok, status: response.status, data, range: response.headers.get('content-range') };
  }
  const rpc = async (owner, name, body) => {
    const result = await request(owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
    requireEvidence(result.ok && (name === 'commit_image'
      ? result.status === 204 && result.data === null
      : result.status === 200 && result.data !== null));
    return result.data;
  };
  const rows = async (owner, table) => {
    requireEvidence(TABLES.includes(table));
    const order = table === 'outfit_items' ? 'outfit_id,item_id' : ['profiles', 'style_preferences'].includes(table) ? 'owner_id' : 'id';
    const result = await request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&select=*&order=${order}&limit=33`, {
      headers: { Prefer: 'count=exact' },
    });
    requireEvidence(result.ok && Array.isArray(result.data) && result.data.length <= 32);
    requireEvidence(typeof result.range === 'string' && /\/\d+$/.test(result.range)
      && Number(result.range.split('/')[1]) === result.data.length);
    return canonicalRows(table, result.data);
  };
  const insert = async (owner, table, body) => {
    const result = await request(owner.token, `/rest/v1/${table}`, {
      method: 'POST', body: { ...body, owner_id: owner.uid }, headers: { Prefer: 'return=representation' },
    });
    requireEvidence(result.ok && Array.isArray(result.data) && result.data.length === 1);
    rowIdentity(table, result.data[0]);
    requireEvidence(result.data[0].owner_id === owner.uid);
    return result.data[0];
  };
  const patch = async (owner, table, row, body) => request(owner.token,
    `/rest/v1/${table}?owner_id=eq.${owner.uid}${row.id ? `&id=eq.${row.id}` : ''}&version=eq.${row.version}`,
    { method: 'PATCH', body, headers: { Prefer: 'return=representation' } });
  const save = async (owner, table, row, body) => {
    const result = await patch(owner, table, row, body);
    requireEvidence(result.ok && Array.isArray(result.data) && result.data.length === 1
      && record(result.data[0]) && result.data[0].version === row.version + 1
      && result.data[0].created_at === row.created_at);
    for (const [field, value] of Object.entries(body)) requireEvidence(isDeepStrictEqual(result.data[0][field], value));
    return result.data[0];
  };
  const signIn = async (label) => {
    const login = await request(null, '/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: env[`TEST_${label}_EMAIL`], password: env[`TEST_${label}_PASSWORD`] },
    });
    requireEvidence(login.ok && record(login.data) && typeof login.data.access_token === 'string');
    const token = login.data.access_token;
    const user = await request(token, '/auth/v1/user');
    const claims = jwtClaims(token);
    requireEvidence(user.ok && record(user.data) && uuid.test(user.data.id) && user.data.email === TEST_EMAILS[['A', 'B'].indexOf(label)]
      && user.data.is_anonymous === false && claims.role === 'authenticated' && claims.sub === user.data.id);
    return { label, uid: user.data.id, token };
  };
  return { request, rpc, rows, insert, patch, save, signIn };
}

async function seed(client, owner) {
  const { request, rpc, rows, insert, save } = client;
  for (const table of TABLES) requireEvidence((await rows(owner, table)).length === (['profiles', 'style_preferences'].includes(table) ? 1 : 0));
  const absent = await request(owner.token, '/rest/v1/items?select=field_provenance&limit=1');
  requireEvidence(!absent.ok && absent.status === 400 && absent.data.code === '42703');
  let profile = (await rows(owner, 'profiles'))[0];
  profile = await save(owner, 'profiles', profile, { display_name: 'Fictional preservation owner', timezone: 'Europe/Stockholm', currency: 'SEK' });
  await save(owner, 'profiles', profile, { ui_language: owner.label === 'A' ? 'fi' : 'sv' });
  await save(owner, 'style_preferences', (await rows(owner, 'style_preferences'))[0], {
    preferred_colours: ['green', 'blue'], style_tags: ['fictional', 'relaxed'], excluded_categories: ['accessory'],
    minimum_upper_coverage: 1, minimum_lower_coverage: 2, cold_sensitivity: -1, repeat_gap_days: 7,
  });
  let implicit = await insert(owner, 'items', { id: randomUUID(), title: 'Fictional implicit facts', category: 'top' });
  let explicit = await insert(owner, 'items', {
    id: randomUUID(), title: 'Fictional explicit facts', category: 'outerwear', subcategory: 'coat',
    ...EXPLICIT_FACTS, colours: ['green', 'blue'], seasons: ['autumn', 'winter'], brand: 'Fictional',
    size_label: 'M', material: 'Owner supplied', min_temp: -10, max_temp: 15, style_tags: ['relaxed'],
    tags: ['fictional', 'preservation'], purchase_price: 123.45, purchase_date: '2024-02-29', currency: 'SEK',
    notes: 'Fictional note\nSecond line 🌿', availability: 'laundry', lifecycle: 'archived', exclude_suggestions: true,
  });
  const imageless = await insert(owner, 'items', { id: randomUUID(), title: 'Fictional imageless item', category: 'bottom' });
  implicit = await save(owner, 'items', implicit, { wear_more: true });
  explicit = await save(owner, 'items', explicit, { favourite: true });
  await save(owner, 'items', imageless, { favourite: true });
  const jpg = await readFile(new URL('../security/fixture.jpg', import.meta.url));
  requireEvidence(jpg.length === 632);
  for (let index = 0; index < 2; index += 1) {
    const image = await insert(owner, 'item_images', {
      id: randomUUID(), item_id: explicit.id, main_bytes: jpg.length, thumb_bytes: jpg.length,
      main_sha256: sha256(jpg), thumb_sha256: sha256(jpg), width: 2, height: 2, alt_text: 'Fictional preservation image',
    });
    for (const variant of ['main', 'thumb']) {
      const expected = `${owner.uid}/${explicit.id}/${image.id}/${variant}.jpg`;
      requireEvidence(image[`${variant}_path`] === expected);
      requireEvidence((await request(owner.token, `/storage/v1/object/wardrobe/${expected}`, {
        method: 'POST', body: jpg, binary: true, headers: { 'Cache-Control': 'max-age=0', 'x-upsert': 'false' },
      })).ok);
    }
    await rpc(owner, 'commit_image', { p_image_id: image.id });
  }
  const outfit = { p_id: randomUUID(), p_title: 'Fictional preservation outfit', p_occasion: 'everyday',
    p_notes: 'Fictional outfit note', p_favourite: false, p_item_ids: [explicit.id, implicit.id], p_expected_version: null };
  const outfitVersion = await rpc(owner, 'save_outfit', outfit);
  requireEvidence(await rpc(owner, 'save_outfit', { ...outfit, p_favourite: true, p_expected_version: outfitVersion }) === outfitVersion + 1);
  const event = { p_id: randomUUID(), p_local_date: '2024-02-29', p_timezone: 'Europe/Stockholm',
    p_state: 'planned', p_label: 'Fictional worn history', p_outfit_id: outfit.p_id,
    p_item_ids: [implicit.id, explicit.id], p_expected_version: null };
  const eventVersion = await rpc(owner, 'save_wear_event', event);
  requireEvidence(await rpc(owner, 'save_wear_event', { ...event, p_state: 'worn', p_expected_version: eventVersion }) === eventVersion + 1);
  const [low, high] = [implicit.id, explicit.id].sort();
  await insert(owner, 'combination_rules', { id: randomUUID(), item_low: low, item_high: high });
  await insert(owner, 'suggestion_feedback', { id: randomUUID(), item_ids: [explicit.id, implicit.id], vote: -1 });
}

export async function captureData(client, owners, run) {
  const data = [];
  for (const owner of owners) {
    const tables = {};
    for (const table of TABLES) tables[table] = await client.rows(owner, table);
    const objects = [];
    for (const image of tables.item_images) {
      for (const variant of ['main', 'thumb']) {
        const objectPath = `${owner.uid}/${image.item_id}/${image.id}/${variant}.jpg`;
        requireEvidence(image[`${variant}_path`] === objectPath);
        const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${objectPath}`);
        requireEvidence(result.ok && Buffer.isBuffer(result.data));
        const object = { path: objectPath, bytes: result.data.length, sha256: sha256(result.data) };
        requireEvidence(object.bytes === image[`${variant}_bytes`] && object.sha256 === image[`${variant}_sha256`]);
        objects.push(object);
      }
    }
    data.push({ label: owner.label, ownerId: owner.uid, tables, objects });
  }
  return { schemaVersion: 1, projectId: PROJECT_ID, stage: 'base', run, sources: SOURCE_HASHES, owners: owners.map((owner) => owner.uid), data };
}

export async function functionalProbes(client, owners, after) {
  for (const [index, owner] of owners.entries()) {
    const other = owners[1 - index], tables = after.data[index].tables, row = tables.items[0];
    for (const body of [{ warmth: 5 }, { rain_rating: -1 }, { pattern: 'invalid' }]) {
      const result = await client.patch(owner, 'items', row, body);
      requireEvidence(!result.ok && result.status === 400);
      requireEvidence(isDeepStrictEqual(await client.rows(owner, 'items'), canonicalRows('items', tables.items)));
    }
    for (const token of [other.token, null]) {
      for (const table of TABLES) {
        const result = await client.request(token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&select=*`);
        requireEvidence(token ? result.ok && isDeepStrictEqual(result.data, []) : !result.ok && [401, 403].includes(result.status));
      }
      const denied = await client.request(token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${row.id}&version=eq.${row.version}`, {
        method: 'PATCH', body: { notes: 'Must not change' }, headers: { Prefer: 'return=representation' },
      });
      requireEvidence(token ? denied.ok && isDeepStrictEqual(denied.data, []) : !denied.ok && [401, 403].includes(denied.status));
      const image = tables.item_images[0];
      const download = await client.request(token, `/storage/v1/object/authenticated/wardrobe/${image.main_path}`);
      requireEvidence(!download.ok && [400, 401, 403, 404].includes(download.status));
    }
    requireEvidence(isDeepStrictEqual(await client.rows(owner, 'items'), canonicalRows('items', tables.items)));
    const exportId = randomUUID(), manifest = await client.rpc(owner, 'export_manifest', { p_export_id: exportId });
    closed(manifest, ['schema_version', 'export_id', 'owner_id', 'created_at', 'tables']);
    requireEvidence(manifest.schema_version === 2 && manifest.export_id === exportId && manifest.owner_id === owner.uid
      && typeof manifest.created_at === 'string' && timestamp.test(manifest.created_at));
    closed(manifest.tables, TABLES);
    for (const table of TABLES) requireEvidence(isDeepStrictEqual(canonicalRows(table, manifest.tables[table]), canonicalRows(table, tables[table])));
  }
}

async function main() {
  let stage = 'arguments';
  try {
    const { phase, run } = parsePhaseArguments(process.argv.slice(2));
    stage = `${phase}-normal-auth`;
    const client = normalClient(process.env);
    const owners = [await client.signIn('A'), await client.signIn('B')];
    requireEvidence(owners[0].uid !== owners[1].uid && owners[0].token !== owners[1].token);
    const ids = owners.map((owner) => owner.uid);
    if (phase === 'capture') {
      stage = 'capture-base-fixtures';
      await assertSnapshotAbsent(run);
      for (const owner of owners) await seed(client, owner);
      stage = 'capture-snapshot';
      await writeSnapshot(await captureData(client, owners, run), run, ids);
    } else {
      stage = 'verify-read-only-comparison';
      const before = await readSnapshot(run, ids);
      const after = await captureData(client, owners, run);
      comparePreservation(before, after, run, ids);
      stage = 'verify-post-comparison-probes';
      await functionalProbes(client, owners, after);
    }
    console.log(`PASS: preservation ${phase}; owners=2 tables=10 rows=30 objects=8`);
  } catch {
    console.error(`FAIL: preservation ${stage}; EVIDENCE_REQUIRED`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
