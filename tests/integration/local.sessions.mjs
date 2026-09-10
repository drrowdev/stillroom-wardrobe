import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertLocalApi, jwtClaims, validateSessionEnvironment, reportError } from '../../scripts/backend/local.mjs';

try { validateSessionEnvironment(process.env); } catch (error) { reportError(error); process.exit(2); }
const base = assertLocalApi(process.env.SUPABASE_URL);
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const passed = [], cleanups = [];
let stage = 'local normal-session configuration';

async function request(token, route, { method = 'GET', body, binary = false, headers = {} } = {}) {
  const response = await fetch(base + route, {
    method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: {
      apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': binary ? 'image/jpeg' : 'application/json', ...headers,
    },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
  });
  assert.ok(response.status < 500);
  const raw = Buffer.from(await response.arrayBuffer());
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { data = raw; }
  return { ok: response.ok, status: response.status, data };
}

async function rpc(owner, name, body) {
  const result = await request(owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
  assert.ok(result.ok);
  return result.data;
}

async function rows(owner, table, filter) {
  const result = await request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&${filter}`);
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.data));
  return result.data;
}

async function signIn(label) {
  const result = await request(null, '/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: process.env[`TEST_${label}_EMAIL`], password: process.env[`TEST_${label}_PASSWORD`] },
  });
  assert.ok(result.ok);
  assert.equal(jwtClaims(result.data.access_token).role, 'authenticated');
  assert.equal(jwtClaims(result.data.access_token).sub, result.data.user.id);
  return { token: result.data.access_token, uid: result.data.user.id };
}

async function itemProvenance(owner) {
    const ids = [];
    const fields = [
      'title', 'category', 'subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length',
      'brand', 'size_label', 'material', 'seasons', 'formality', 'warmth', 'min_temp', 'max_temp',
      'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage', 'style_tags', 'tags',
      'purchase_date', 'purchase_price', 'notes',
    ];
    const physical = ['formality', 'warmth', 'rain_rating', 'windproof', 'upper_coverage', 'lower_coverage'];
    const read = (id) => rows(owner, 'items', `id=eq.${id}&select=*`);
    const patch = (row, body) => request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${row.id}&version=eq.${row.version}`, {
      method: 'PATCH', body, headers: { Prefer: 'return=representation' },
    });
    const insert = async (body) => {
      const id = randomUUID();
      ids.push(id);
      const result = await request(owner.token, '/rest/v1/items', {
        method: 'POST', body: { id, title: 'Fictional provenance garment', category: 'top', ...body },
        headers: { Prefer: 'return=representation' },
      });
      assert.ok(result.ok); assert.equal(result.data.length, 1);
      assert.equal(result.data[0].owner_id, owner.uid);
      assert.deepEqual(await read(id), result.data);
      return result.data[0];
    };
    const save = async (row, body) => {
      const result = await patch(row, body);
      assert.ok(result.ok); assert.equal(result.data.length, 1);
      assert.equal(result.data[0].version, row.version + 1);
      assert.equal(result.data[0].created_at, row.created_at);
      assert.deepEqual(await read(row.id), result.data);
      return result.data[0];
    };
    try {
      stage = 'I29a owner insert defaults and post-migration legacy-shaped unverified fixture';
      const omitted = await insert({});
      assert.deepEqual(omitted.field_provenance, {});
      for (const field of [...physical, 'pattern', 'sleeve_length', 'garment_length']) assert.equal(omitted[field], null);
      assert.deepEqual(omitted.colours, []);
      assert.deepEqual(omitted.seasons, []);
      const retained = { formality: 1, warmth: 1, rain_rating: 0, windproof: false, upper_coverage: 0, lower_coverage: 0,
        colours: ['unknown'], seasons: ['spring', 'summer', 'autumn', 'winter'] };
      const legacyShaped = await insert(retained);
      for (const field of physical) assert.equal(legacyShaped[field], retained[field]);
      assert.deepEqual(legacyShaped.field_provenance, {});

      stage = 'I29a explicit manual insert covers all 24 fields and integral numeric JSON';
      const values = {
        title: 'Fictional confirmed garment', category: 'top', subcategory: 'shirt', colours: ['green'],
        pattern: 'solid', sleeve_length: 'long', garment_length: 'regular', brand: 'Fictional',
        size_label: 'M', material: 'Owner supplied', seasons: ['summer'], formality: 2, warmth: 2,
        min_temp: -5, max_temp: 25, rain_rating: 1, windproof: true, upper_coverage: 2,
        lower_coverage: 1, style_tags: ['relaxed'], tags: ['fictional'], purchase_date: '2026-01-01',
        purchase_price: 25, notes: 'Fictional owner note', currency: 'SEK', favourite: false,
        availability: 'laundry', lifecycle: 'archived', exclude_suggestions: true, wear_more: true,
      };
      const assertions = Object.fromEntries(fields.map((field) => [field, { kind: 'user', revision: 1 }]));
      let row = await insert({ ...values, field_provenance: { ...assertions, title: { kind: 'user', revision: JSON.rawJSON('1.0') } } });
      assert.deepEqual(row.field_provenance, assertions);
      for (const field of fields) assert.deepEqual(row[field], values[field]);
      const unchanged = row.field_provenance;
      row = await save(row, { favourite: true, version: 999999, created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' });
      assert.deepEqual(row.field_provenance, unchanged);
      assert.notEqual(row.updated_at, '2000-01-01T00:00:00Z');
      for (const body of [{ id: randomUUID() }, { owner_id: randomUUID() }]) {
        assert.ok(!(await patch(row, body)).ok);
        assert.deepEqual(await read(row.id), [row]);
      }

      stage = 'I29a same-value confirmation and permitted manual null and empty clears';
      const cleared = {
        ...values, subcategory: null, colours: [], seasons: [], pattern: null, sleeve_length: null,
        garment_length: null, brand: null, size_label: null, material: null, formality: null,
        warmth: null, min_temp: null, max_temp: null, rain_rating: null, windproof: null,
        upper_coverage: null, lower_coverage: null, style_tags: [], tags: [], purchase_date: null,
        purchase_price: null, notes: '', currency: 'EUR', favourite: false, availability: 'ready',
        lifecycle: 'active', exclude_suggestions: false, wear_more: false,
      };
      const confirmed = Object.fromEntries(fields.map((field) => [field, { kind: 'user', revision: 2 }]));
      const stale = row;
      row = await save(row, { ...cleared, field_provenance: { ...confirmed, title: { kind: 'user', revision: JSON.rawJSON('2.0') } } });
      assert.deepEqual(row.field_provenance, confirmed);
      for (const field of fields) assert.deepEqual(row[field], cleared[field]);
      const staleResult = await patch(stale, { ...cleared, field_provenance: confirmed });
      assert.ok(staleResult.ok); assert.deepEqual(staleResult.data, []);
      assert.deepEqual(await read(row.id), [row]);

      stage = 'I29a values-only invalidation, mixed intent and explicit withdrawal';
      row = await save(row, { title: 'Fictional unverified change' });
      assert.deepEqual(row.field_provenance, { ...confirmed, title: { kind: 'unknown', revision: 3 } });
      row = await save(row, {
        title: 'Fictional manually revised', warmth: 3,
        field_provenance: { ...row.field_provenance, title: { kind: 'user', revision: 4 }, notes: { kind: 'unknown', revision: 3 } },
      });
      assert.deepEqual(row.field_provenance, {
        ...confirmed, title: { kind: 'user', revision: 4 }, warmth: { kind: 'unknown', revision: 3 }, notes: { kind: 'unknown', revision: 3 },
      });
      const newlyUnknown = await save(omitted, { brand: 'Unverified value-only brand' });
      assert.deepEqual(newlyUnknown.field_provenance, { brand: { kind: 'unknown', revision: 1 } });

      stage = 'I29a finite code values and original physical ranges';
      for (const [field, codes] of [
        ['pattern', ['solid', 'striped', 'checked', 'dotted', 'floral', 'graphic', 'abstract', 'animal', 'other']],
        ['sleeve_length', ['sleeveless', 'short', 'elbow', 'three_quarter', 'long']],
        ['garment_length', ['cropped', 'short', 'regular', 'long']],
      ]) {
        for (const value of codes) {
          const revision = row.field_provenance[field].revision + 1;
          row = await save(row, { [field]: value, field_provenance: { ...row.field_provenance, [field]: { kind: 'user', revision } } });
          assert.equal(row[field], value);
          assert.deepEqual(row.field_provenance[field], { kind: 'user', revision });
        }
      }
      stage = 'I29a malformed maps and invalid transitions roll back every column and version';
      const invalidMaps = [
        null, [], 'invalid', 1, { currency: { kind: 'user', revision: 1 } },
        { title: null }, { title: [] }, { title: {} }, { title: { kind: 'user' } },
        { title: { revision: 5 } }, { title: { kind: 'user', revision: 5, extra: true } },
        { title: { kind: null, revision: 5 } }, { title: { kind: 'invented', revision: 5 } },
        { title: { kind: 'å'.repeat(4096), revision: 5 } },
        Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, { kind: 'user', revision: 1 }])),
        ...[0, -1, 1.5, 2147483648, '5', null, true].map((revision) => ({ title: { kind: 'user', revision } })),
      ];
      const removed = { ...row.field_provenance };
      delete removed.title;
      const invalidUpdates = [
        ...invalidMaps.map((field_provenance) => ({ field_provenance })),
        { field_provenance: removed },
        ...[3, 4, 6, 2147483647].map((revision) => ({ field_provenance: { ...row.field_provenance, title: { kind: 'unknown', revision } } })),
        ...['ai_observed', 'ai_estimated'].map((kind) => ({ field_provenance: { ...row.field_provenance, title: { kind, revision: 5 } } })),
        ...['pattern', 'sleeve_length', 'garment_length'].map((field) => ({ [field]: 'invalid' })),
        ...['formality', 'warmth'].flatMap((field) => [-1, 5].map((value) => ({ [field]: value }))),
        ...['rain_rating', 'upper_coverage', 'lower_coverage'].flatMap((field) => [-1, 3].map((value) => ({ [field]: value }))),
        { colours: ['black', 'white', 'green', 'blue'] }, { seasons: ['spring', 'summer', 'autumn', 'winter', 'spring'] },
        { seasons: ['monsoon'] }, { title: '' }, { category: 'invalid' }, { min_temp: -41 }, { max_temp: 51 },
        { min_temp: 10, max_temp: 9 }, { purchase_price: -1 }, { purchase_price: '10000000000.00' },
        { purchase_date: '2025-02-29' }, { currency: 'eur' }, { availability: 'unknown' }, { lifecycle: 'trash' },
        ...[['title', 100], ['subcategory', 60], ['brand', 100], ['size_label', 50], ['material', 200], ['notes', 4000]]
          .map(([field, maximum]) => ({ [field]: '🌿'.repeat(maximum + 1) })),
        { tags: Array.from({ length: 12 }, (_, index) => `${index}${'🌿'.repeat(39)}`) },
      ];
      for (const body of invalidUpdates) {
        const result = await patch(row, { favourite: false, notes: 'Must roll back', ...body });
        assert.ok(!result.ok);
        assert.deepEqual(await read(row.id), [row]);
      }
      stage = 'I29a invalid insert leaves no row';
      for (const field_provenance of [
        ...invalidMaps, { title: { kind: 'unknown', revision: 1 } },
        ...[2, 2147483647].map((revision) => ({ title: { kind: 'user', revision } })),
        ...['ai_observed', 'ai_estimated'].map((kind) => ({ title: { kind, revision: 1 } })),
      ]) {
        const id = randomUUID();
        ids.push(id);
        const result = await request(owner.token, '/rest/v1/items', {
          method: 'POST', body: { id, title: 'Must not insert', category: 'top', field_provenance },
        });
        assert.ok(!result.ok); assert.deepEqual(await read(id), []);
      }
      stage = 'I29a raw v2 snapshot contains only owned facts including intermediate imageless rows';
      const exportId = randomUUID();
      const manifest = await rpc(owner, 'export_manifest', { p_export_id: exportId });
      assert.equal(manifest.schema_version, 2); assert.equal(manifest.export_id, exportId);
      assert.equal(manifest.owner_id, owner.uid);
      for (const table of Object.values(manifest.tables)) assert.ok(table.every((entry) => entry.owner_id === owner.uid));
      for (const expected of [row, legacyShaped, newlyUnknown]) {
        assert.deepEqual(manifest.tables.items.find((entry) => entry.id === expected.id), expected);
      }
      stage = 'I29c optional collections and exact decimal zero false versus null';
      for (const price of ['0.00', '0.01', '0.10', '9999999999.99']) {
        const value = await insert({ purchase_price: price, warmth: 0, windproof: false, colours: [], seasons: [],
          field_provenance: { purchase_price: { kind: 'user', revision: 1 }, warmth: { kind: 'user', revision: 1 },
            windproof: { kind: 'user', revision: 1 }, colours: { kind: 'user', revision: 1 }, seasons: { kind: 'user', revision: 1 } } });
        assert.equal(Number(value.purchase_price).toFixed(2), price);
        assert.equal(value.warmth, 0); assert.equal(value.windproof, false);
        const empty = await save(value, { purchase_price: null, warmth: null, windproof: null, colours: [], seasons: [],
          field_provenance: Object.fromEntries(Object.keys(value.field_provenance).map((field) => [field, { kind: 'user', revision: 2 }])) });
        assert.equal(empty.purchase_price, null); assert.equal(empty.warmth, null); assert.equal(empty.windproof, null);
        assert.equal(empty.currency, value.currency); assert.deepEqual(empty.colours, []); assert.deepEqual(empty.seasons, []);
      }
      assert.ok(!manifest.tables.item_images.some((image) => ids.includes(image.item_id)));
    } finally {
      for (const id of ids) {
        const result = await request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' });
        assert.ok(result.ok); assert.deepEqual(await read(id), []);
      }
    }
  }

async function descriptionCorrections(owner, fixture, jpg, sha) {
  const readImage = async (id) => {
    const result = await rows(owner, 'item_images', `id=eq.${id}&select=*`);
    assert.equal(result.length, 1);
    return result[0];
  };
  const readItem = () => rows(owner, 'items', `id=eq.${fixture.item}&select=*`);
  const edit = (id, version, text) => request(owner.token, '/rest/v1/rpc/update_image_description', {
    method: 'POST', body: { p_image_id: id, p_expected_description_version: version, p_alt_text: text },
  });
  const denied = (result, message) => {
    assert.ok(!result.ok);
    assert.equal(result.data.code, message === 'Not available' ? '42501' : '22023');
    assert.equal(result.data.message, message);
  };
  const returned = (row) => ({
    id: row.id, owner_id: owner.uid, item_id: fixture.item,
    alt_text: row.alt_text, description_version: row.description_version,
  });
  let image = await readImage(fixture.image);
  const pending = await readImage(fixture.replacement);
  assert.equal(image.description_version, 1);
  assert.equal(pending.description_version, 1);
  assert.equal(pending.alt_text, '');
  let item = (await readItem())[0];
  stage = 'I29b ordinary name/category CAS preserves all untouched item fields';
  const provenance = { ...item.field_provenance };
  for (const field of ['title', 'category']) provenance[field] = {
    kind: 'user', revision: (provenance[field]?.revision ?? 0) + 1,
  };
  const itemChanges = { title: 'Fictional corrected layer', category: 'layer', field_provenance: provenance };
  const savedItem = await request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${item.id}&deleted_at=is.null&version=eq.${item.version}`, {
    method: 'PATCH', body: itemChanges, headers: { Prefer: 'return=representation' },
  });
  assert.ok(savedItem.ok); assert.equal(savedItem.data.length, 1);
  assert.deepEqual(savedItem.data[0], { ...item, ...itemChanges, version: item.version + 1, updated_at: savedItem.data[0].updated_at });
  assert.equal(typeof savedItem.data[0].updated_at, 'string');
  const staleItem = await request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${item.id}&version=eq.${item.version}`, {
    method: 'PATCH', body: itemChanges, headers: { Prefer: 'return=representation' },
  });
  assert.ok(staleItem.ok); assert.deepEqual(staleItem.data, []);
  item = savedItem.data[0];
  assert.deepEqual(await readItem(), [item]);
  assert.deepEqual(await readImage(image.id), image);
  const unchanged = async () => {
    assert.deepEqual(await readItem(), [item]);
    assert.deepEqual(await readImage(image.id), image);
    assert.deepEqual(await readImage(pending.id), pending);
  };
  const save = async (text) => {
    const result = await edit(image.id, image.description_version, text);
    assert.ok(result.ok);
    image = { ...image, alt_text: text, description_version: image.description_version + 1 };
    assert.deepEqual(result.data, [returned(image)]);
    await unchanged();
  };
  stage = 'I29b descriptions, clear, Unicode bound and fresh same-value counter increments';
  await save('Fictional corrected description');
  await save('');
  await save('');
  await save('🌿'.repeat(240));
  await save('Fictional corrected description');
  stage = 'I29b invalid arguments and stale equal text leave complete rows unchanged';
  for (const [id, version, text] of [
    [null, image.description_version, 'invalid'],
    [image.id, null, 'invalid'], [image.id, 0, 'invalid'], [image.id, -1, 'invalid'],
    [image.id, 2147483648, 'invalid'], [image.id, image.description_version, null],
    [image.id, image.description_version, 'x'.repeat(241)],
    [image.id, image.description_version, '🌿'.repeat(241)],
  ]) {
    denied(await edit(id, version, text), 'Invalid input');
    await unchanged();
  }
  for (const version of [image.description_version - 1, 2147483647]) {
    denied(await edit(image.id, version, image.alt_text), 'Request conflict');
    await unchanged();
  }
  for (const id of [pending.id, randomUUID()]) {
    denied(await edit(id, 1, 'Must not change'), 'Not available');
    await unchanged();
  }
  stage = 'I29b concurrent same-counter edits have exactly one success';
  const attempts = ['Fictional concurrent one', 'Fictional concurrent two'];
  const outcomes = await Promise.all(attempts.map((text) => edit(image.id, image.description_version, text)));
  assert.equal(outcomes.filter((result) => result.ok).length, 1);
  const winner = outcomes.findIndex((result) => result.ok);
  denied(outcomes[1 - winner], 'Request conflict');
  image = { ...image, alt_text: attempts[winner], description_version: image.description_version + 1 };
  assert.deepEqual(outcomes[winner].data, [returned(image)]);
  await unchanged();
  await save('');
  stage = 'I29b owned raw v2 export retains cleared text and description counter';
  const manifest = await rpc(owner, 'export_manifest', { p_export_id: randomUUID() });
  assert.equal(manifest.schema_version, 2); assert.equal(manifest.owner_id, owner.uid);
  assert.deepEqual(manifest.tables.items.find((row) => row.id === item.id), item);
  assert.deepEqual(manifest.tables.item_images.find((row) => row.id === image.id), image);
  assert.deepEqual(manifest.tables.item_images.find((row) => row.id === pending.id), pending);
  for (const table of Object.values(manifest.tables)) assert.ok(table.every((row) => row.owner_id === owner.uid));
  stage = 'I29b ready image with deleted parent is unavailable without changing description';
  for (const deleted_at of ['2026-01-01T00:00:00+00:00', null]) {
    const result = await request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${item.id}&version=eq.${item.version}`, {
      method: 'PATCH', body: { deleted_at }, headers: { Prefer: 'return=representation' },
    });
    assert.ok(result.ok); assert.equal(result.data.length, 1);
    assert.deepEqual(result.data[0], { ...item, deleted_at, version: item.version + 1, updated_at: result.data[0].updated_at });
    item = result.data[0];
    if (deleted_at !== null) denied(await edit(image.id, image.description_version, 'Must not change'), 'Not available');
    await unchanged();
  }
  stage = 'I29b replacement race stays on old image and preserves all private bytes';
  for (const objectPath of [pending.main_path, pending.thumb_path]) {
    stage = objectPath === pending.main_path
      ? 'I29b replacement main upload' : 'I29b replacement thumb upload';
    fixture.paths.push(objectPath);
    const upload = await request(owner.token, `/storage/v1/object/wardrobe/${objectPath}`, {
      method: 'POST', body: jpg, binary: true, headers: { 'Cache-Control': 'max-age=0', 'x-upsert': 'false' },
    });
    assert.ok(upload.ok);
  }
  stage = 'I29b replacement concurrent requests';
  const [correction, commit] = await Promise.all([
    edit(image.id, image.description_version, 'Fictional racing correction'),
    request(owner.token, '/rest/v1/rpc/commit_image', { method: 'POST', body: { p_image_id: pending.id } }),
  ]);
  stage = !commit.ok && commit.status === 400 && commit.data?.code === '22023' && commit.data?.message === 'Request conflict'
    ? 'I29b replacement commit assertion: exact Request conflict'
    : 'I29b replacement commit assertion: unexpected result';
  assert.ok(commit.ok);
  stage = 'I29b replacement correction response';
  if (correction.ok) {
    image = { ...image, alt_text: 'Fictional racing correction', description_version: image.description_version + 1 };
    assert.deepEqual(correction.data, [returned(image)]);
  } else denied(correction, 'Not available');
  stage = 'I29b replacement retired row';
  const retired = await readImage(image.id);
  assert.equal(typeof retired.retired_at, 'string');
  assert.deepEqual(retired, { ...image, state: 'retired', retired_at: retired.retired_at });
  stage = 'I29b replacement new ready row';
  assert.deepEqual(await readImage(pending.id), { ...pending, state: 'ready' });
  stage = 'I29b replacement retired description denial';
  denied(await edit(image.id, retired.description_version, 'Must not change'), 'Not available');
  stage = 'I29b replacement unchanged retired row';
  assert.deepEqual(await readImage(image.id), retired);
  stage = 'I29b replacement unchanged new ready row';
  assert.deepEqual(await readImage(pending.id), { ...pending, state: 'ready' });
  stage = 'I29b replacement unchanged item';
  assert.deepEqual(await readItem(), [item]);
  for (const objectPath of fixture.paths) {
    stage = 'I29b replacement private byte download';
    const download = await request(owner.token, `/storage/v1/object/authenticated/wardrobe/${objectPath}`);
    assert.ok(download.ok); assert.ok(Buffer.isBuffer(download.data));
    stage = 'I29b replacement private byte length';
    assert.equal(download.data.length, jpg.length);
    stage = 'I29b replacement private byte hash';
    assert.equal(createHash('sha256').update(download.data).digest('hex'), sha);
  }
}

async function personalSettings(owner, other, itemId) {
  const profileFields = ['display_name', 'timezone', 'currency', 'ui_language'];
  const preferenceFields = ['preferred_colours', 'style_tags', 'excluded_categories', 'minimum_upper_coverage', 'minimum_lower_coverage', 'cold_sensitivity', 'repeat_gap_days'];
  const original = {};
  const sibling = {};
  for (const table of ['profiles', 'style_preferences']) {
    original[table] = (await rows(owner, table, 'select=*'))[0];
    sibling[table] = await rows(other, table, 'select=*');
    assert.ok(original[table]);
  }
  const itemBefore = await rows(owner, 'items', `id=eq.${itemId}&select=purchase_price,currency,version`);
  async function patch(table, version, body) {
    return request(owner.token, `/rest/v1/${table}?owner_id=eq.${owner.uid}&version=eq.${version}`, {
      method: 'PATCH', body, headers: { Prefer: 'return=representation' },
    });
  }
  try {
    stage = 'I06 normal owner profile and consecutive language version saves';
    const saved = await patch('profiles', original.profiles.version, { display_name: 'Fictional Nordic 🌿', timezone: 'Europe/Stockholm', currency: 'SEK' });
    assert.ok(saved.ok); assert.equal(saved.data.length, 1);
    assert.equal(saved.data[0].version, original.profiles.version + 1);
    assert.equal(saved.data[0].ui_language, original.profiles.ui_language);
    const language = await patch('profiles', saved.data[0].version, { ui_language: 'fi' });
    assert.ok(language.ok); assert.equal(language.data.length, 1);
    assert.equal(language.data[0].version, saved.data[0].version + 1);
    assert.equal(language.data[0].timezone, 'Europe/Stockholm'); assert.equal(language.data[0].currency, 'SEK');
    const stale = await patch('profiles', original.profiles.version, { display_name: 'Must not overwrite' });
    assert.ok(stale.ok); assert.deepEqual(stale.data, []);
    assert.deepEqual((await rows(owner, 'profiles', 'select=*'))[0], language.data[0]);
    stage = 'I06 optional preferences boundaries and explicit array clears';
    const selected = {
      preferred_colours: ['black', 'white', 'grey', 'navy', 'blue', 'green', 'olive', 'beige'],
      style_tags: ['oma 🌿', 'egen', 'minimal', 'relaxed', 'classic', 'soft', 'layered', 'quiet'],
      excluded_categories: ['top', 'bottom', 'one_piece', 'footwear', 'layer', 'outerwear', 'accessory'],
      minimum_upper_coverage: 2, minimum_lower_coverage: 2, cold_sensitivity: -2, repeat_gap_days: 14,
    };
    const preferences = await patch('style_preferences', original.style_preferences.version, selected);
    assert.ok(preferences.ok); assert.equal(preferences.data.length, 1);
    assert.equal(preferences.data[0].version, original.style_preferences.version + 1);
    for (const field of preferenceFields) assert.deepEqual(preferences.data[0][field], selected[field]);
    const stalePreferences = await patch('style_preferences', original.style_preferences.version, { repeat_gap_days: 0 });
    assert.ok(stalePreferences.ok); assert.deepEqual(stalePreferences.data, []);
    const invalid = await patch('style_preferences', preferences.data[0].version, { repeat_gap_days: 15 });
    assert.ok(!invalid.ok);
    const cleared = await patch('style_preferences', preferences.data[0].version, { preferred_colours: [], style_tags: [], excluded_categories: [], minimum_upper_coverage: 0, minimum_lower_coverage: 0, cold_sensitivity: 2, repeat_gap_days: 0 });
    assert.ok(cleared.ok); assert.equal(cleared.data.length, 1);
    for (const field of ['preferred_colours', 'style_tags', 'excluded_categories']) assert.deepEqual(cleared.data[0][field], []);
    stage = 'I06 sibling records and existing item money unchanged';
    assert.deepEqual(await rows(owner, 'items', `id=eq.${itemId}&select=purchase_price,currency,version`), itemBefore);
    for (const table of ['profiles', 'style_preferences']) assert.deepEqual(await rows(other, table, 'select=*'), sibling[table]);
  } finally {
    for (const [table, fields] of [['profiles', profileFields], ['style_preferences', preferenceFields]]) {
      const current = (await rows(owner, table, 'select=*'))[0];
      const body = Object.fromEntries(fields.map((field) => [field, original[table][field]]));
      const restored = await patch(table, current.version, body);
      assert.ok(restored.ok); assert.equal(restored.data.length, 1);
      assert.equal(restored.data[0].version, current.version + 1);
      for (const field of fields) assert.deepEqual(restored.data[0][field], original[table][field]);
    }
  }
}

try {
  stage = 'normal Auth and schema availability';
  const a = await signIn('A'), b = await signIn('B');
  assert.notEqual(a.uid, b.uid);
  const jpg = await readFile(new URL('../security/fixture.jpg', import.meta.url));
  const sha = createHash('sha256').update(jpg).digest('hex');
  for (const owner of [a, b]) {
    const profile = await rows(owner, 'profiles', 'select=owner_id,ui_language,version');
    assert.equal(profile.length, 1);
    assert.ok([null, 'en', 'fi', 'sv'].includes(profile[0].ui_language));
    assert.ok(Number(profile[0].version) >= 1);
    const fixture = { owner, item: randomUUID(), image: randomUUID(), replacement: randomUUID(), outfit: randomUUID(), paths: [] };
    cleanups.push(fixture);
    stage = 'explicit owner item creation and version conflict';
    const item = { id: fixture.item, owner_id: owner.uid, title: 'Fictional integration top', category: 'top', purchase_price: 75, currency: 'EUR' };
    let result = await request(owner.token, '/rest/v1/items', { method: 'POST', body: item });
    assert.ok(result.ok);
    result = await request(owner.token, '/rest/v1/items', { method: 'POST', body: item });
    assert.equal(result.status, 409);
    assert.equal((await rows(owner, 'items', `id=eq.${fixture.item}&select=id`)).length, 1);
    result = await request(owner.token, `/rest/v1/items?id=eq.${fixture.item}&version=eq.1`, {
      method: 'PATCH', body: { favourite: true }, headers: { Prefer: 'return=representation' },
    });
    assert.ok(result.ok); assert.equal(result.data.length, 1); assert.equal(Number(result.data[0].version), 2);
    result = await request(owner.token, `/rest/v1/items?id=eq.${fixture.item}&version=eq.1`, {
      method: 'PATCH', body: { favourite: false }, headers: { Prefer: 'return=representation' },
    });
    assert.ok(result.ok); assert.deepEqual(result.data, []);
    assert.equal((await rows(owner, 'items', `id=eq.${fixture.item}&select=favourite`))[0].favourite, true);
    await personalSettings(owner, owner === a ? b : a, fixture.item);
    await itemProvenance(owner);
    stage = 'reserved private JPEG upload and idempotent commit';
    const reservation = {
      id: fixture.image, owner_id: owner.uid, item_id: fixture.item, main_bytes: jpg.length, thumb_bytes: jpg.length,
      main_sha256: sha, thumb_sha256: sha, width: 2, height: 2, alt_text: 'Fictional green image',
    };
    result = await request(owner.token, '/rest/v1/item_images', { method: 'POST', body: reservation, headers: { Prefer: 'return=representation' } });
    assert.ok(result.ok); assert.equal(result.data.length, 1); assert.equal(result.data[0].state, 'pending');
    fixture.paths.push(result.data[0].main_path, result.data[0].thumb_path);
    assert.deepEqual(fixture.paths, [`${owner.uid}/${fixture.item}/${fixture.image}/main.jpg`, `${owner.uid}/${fixture.item}/${fixture.image}/thumb.jpg`]);
    result = await request(owner.token, '/rest/v1/rpc/commit_image', { method: 'POST', body: { p_image_id: fixture.image } });
    assert.ok(!result.ok && result.status < 500);
    for (const objectPath of fixture.paths) {
      result = await request(owner.token, `/storage/v1/object/wardrobe/${objectPath}`, { method: 'POST', body: jpg, binary: true, headers: { 'Cache-Control': 'max-age=0', 'x-upsert': 'false' } });
      assert.ok(result.ok);
      result = await request(owner.token, `/storage/v1/object/wardrobe/${objectPath}`, { method: 'POST', body: jpg, binary: true, headers: { 'x-upsert': 'false' } });
      assert.ok(!result.ok && result.status < 500);
      result = await request(owner.token, `/storage/v1/object/authenticated/wardrobe/${objectPath}`);
      assert.ok(result.ok); assert.equal(createHash('sha256').update(result.data).digest('hex'), sha);
    }
    await rpc(owner, 'commit_image', { p_image_id: fixture.image });
    await rpc(owner, 'commit_image', { p_image_id: fixture.image });
    assert.equal((await rows(owner, 'item_images', `id=eq.${fixture.image}&select=state`))[0].state, 'ready');
    result = await request(owner.token, `/storage/v1/object/wardrobe/${fixture.paths[0]}`, { method: 'PUT', body: jpg, binary: true });
    assert.ok(!result.ok && result.status < 500);
    result = await request(owner.token, '/storage/v1/object/list/wardrobe', {
      method: 'POST', body: { prefix: `${owner.uid}/${fixture.item}/${fixture.image}`, limit: 100, offset: 0 },
    });
    assert.ok(result.ok); assert.deepEqual(result.data.map((row) => row.name).sort(), ['main.jpg', 'thumb.jpg']);
    result = await request(owner.token, `/storage/v1/object/sign/wardrobe/${fixture.paths[0]}`, { method: 'POST', body: { expiresIn: 60 } });
    assert.ok(result.ok);
    // A diagnostic signed capability is never followed, printed, or persisted.
    stage = 'interrupted replacement keeps the original ready image';
    result = await request(owner.token, '/rest/v1/item_images', { method: 'POST', body: { ...reservation, id: fixture.replacement, alt_text: '' } });
    assert.ok(result.ok);
    result = await request(owner.token, '/rest/v1/rpc/commit_image', { method: 'POST', body: { p_image_id: fixture.replacement } });
    assert.ok(!result.ok && result.status < 500);
    assert.equal((await rows(owner, 'item_images', `id=eq.${fixture.image}&select=state`))[0].state, 'ready');
    result = await request(owner.token, '/rest/v1/rpc/forget_image', { method: 'POST', body: { p_image_id: fixture.image } });
    assert.ok(!result.ok && result.status < 500);
    stage = 'atomic RPC retry and stale version preserve links';
    const outfit = {
      p_id: fixture.outfit, p_title: 'Fictional integration outfit', p_occasion: 'everyday', p_notes: '',
      p_favourite: false, p_item_ids: [fixture.item], p_expected_version: null,
    };
    const version = await rpc(owner, 'save_outfit', outfit);
    assert.equal(await rpc(owner, 'save_outfit', outfit), version);
    const next = await rpc(owner, 'save_outfit', { ...outfit, p_favourite: true, p_expected_version: version });
    assert.equal(Number(next), Number(version) + 1);
    result = await request(owner.token, '/rest/v1/rpc/save_outfit', { method: 'POST', body: { ...outfit, p_expected_version: version } });
    assert.ok(!result.ok && result.status < 500);
    assert.equal((await rows(owner, 'outfit_items', `outfit_id=eq.${fixture.outfit}&select=item_id`))[0].item_id, fixture.item);
    await descriptionCorrections(owner, fixture, jpg, sha);
  }
  passed.push('Both normal users: schema, item retry/version conflict, private JPEG lifecycle, immutable bytes, interrupted upload and atomic RPC idempotency');
  passed.push('I06 both normal owners: profile/language and optional preferences version saves, conflicts, clears, unchanged sibling and existing item money; fields restored with fresh versions');
  passed.push('I29a both normal owners: nullable/legacy-shaped facts, all 24 manual fields, numeric revisions, confirmations/clears/invalidation, CAS, code lists, atomic invalid writes and owned intermediate v2 export');
  passed.push('I29b both normal owners: name/category CAS, description clears/Unicode/bounds, same-value/stale/concurrent counters, pending/retired denial, replacement race, unchanged complete rows/media and raw v2 counter export');
  console.log('NOT RUN: I29b stored counter ceiling; ordinary fixtures cannot inject the counter; static finite-bound coverage only.');
} catch {
  console.error(`FAIL at ${stage}. Credentials and response contents are not logged.`);
  process.exitCode = 1;
} finally {
  for (const fixture of cleanups) {
    try {
      const { owner } = fixture;
      if (fixture.paths.length) {
        const result = await request(owner.token, '/storage/v1/object/wardrobe', { method: 'DELETE', body: { prefixes: fixture.paths } });
        assert.ok(result.ok);
        for (const objectPath of fixture.paths) {
          const download = await request(owner.token, `/storage/v1/object/authenticated/wardrobe/${objectPath}`);
          assert.ok(!download.ok && download.status < 500);
        }
      }
      await rpc(owner, 'forget_image', { p_image_id: fixture.image });
      await rpc(owner, 'forget_image', { p_image_id: fixture.replacement });
      for (const [table, id] of [['outfits', fixture.outfit], ['items', fixture.item]]) {
        const result = await request(owner.token, `/rest/v1/${table}?id=eq.${id}`, { method: 'DELETE' });
        assert.ok(result.ok);
        assert.equal((await rows(owner, table, `id=eq.${id}&select=id`)).length, 0);
      }
    } catch {
      console.error('FAIL: owner-scoped integration fixture cleanup is incomplete; review the disposable local stack.');
      process.exitCode = 1;
    }
  }
}
console.log(JSON.stringify({ tests: passed, result: process.exitCode ? 'FAIL' : 'PASS', credentials: 'normal password sessions only; no service key' }, null, 2));
