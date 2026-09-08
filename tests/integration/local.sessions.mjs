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
      assert.deepEqual(omitted.colours, ['unknown']);
      assert.deepEqual(omitted.seasons, ['spring', 'summer', 'autumn', 'winter']);
      const retained = { formality: 1, warmth: 1, rain_rating: 0, windproof: false, upper_coverage: 0, lower_coverage: 0 };
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
        purchase_price: 25, notes: 'Fictional owner note',
      };
      const assertions = Object.fromEntries(fields.map((field) => [field, { kind: 'user', revision: 1 }]));
      let row = await insert({ ...values, field_provenance: { ...assertions, title: { kind: 'user', revision: JSON.rawJSON('1.0') } } });
      assert.deepEqual(row.field_provenance, assertions);
      for (const field of fields) assert.deepEqual(row[field], values[field]);
      const unchanged = row.field_provenance;
      row = await save(row, { favourite: true, version: 999999, created_at: '2000-01-01T00:00:00Z' });
      assert.deepEqual(row.field_provenance, unchanged);

      stage = 'I29a same-value confirmation and permitted manual null and empty clears';
      const cleared = {
        ...values, subcategory: null, colours: ['unknown'], pattern: null, sleeve_length: null,
        garment_length: null, brand: null, size_label: null, material: null, formality: null,
        warmth: null, min_temp: null, max_temp: null, rain_rating: null, windproof: null,
        upper_coverage: null, lower_coverage: null, style_tags: [], tags: [], purchase_date: null,
        purchase_price: null, notes: '',
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
        { colours: [] }, { seasons: [] }, { title: '' }, { category: 'invalid' },
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
      assert.ok(!manifest.tables.item_images.some((image) => ids.includes(image.item_id)));
    } finally {
      for (const id of ids) {
        const result = await request(owner.token, `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${id}`, { method: 'DELETE' });
        assert.ok(result.ok); assert.deepEqual(await read(id), []);
      }
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
    result = await request(owner.token, '/rest/v1/item_images', { method: 'POST', body: { ...reservation, id: fixture.replacement } });
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
  }
  passed.push('Both normal users: schema, item retry/version conflict, private JPEG lifecycle, immutable bytes, interrupted upload and atomic RPC idempotency');
  passed.push('I06 both normal owners: profile/language and optional preferences version saves, conflicts, clears, unchanged sibling and existing item money; fields restored with fresh versions');
  passed.push('I29a both normal owners: nullable/legacy-shaped facts, all 24 manual fields, numeric revisions, confirmations/clears/invalidation, CAS, code lists, atomic invalid writes and owned intermediate v2 export');
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
