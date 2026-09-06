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
    const item = { id: fixture.item, owner_id: owner.uid, title: 'Fictional integration top', category: 'top' };
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
