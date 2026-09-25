// Normal-session child for the P6c deletion rehearsal. It receives only the rehearsal API URL, the
// publishable key and two fictional passwords; it never sees a service key or any Docker setting.
//   seed:   owners C and D each save two items with photos and one outfit; both are refused the service RPCs.
//   verify: C can no longer sign in; D still signs in and reads its own items and photos.
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { isMain } from '../../scripts/quality/files.mjs';
import { bytes, intent } from './item-save.sessions.mjs';

const API = 'http://127.0.0.1:55321';
const ALLOWED = new Set(['PATH', 'HOME', 'NO_COLOR', 'REHEARSAL_URL', 'REHEARSAL_PUBLISHABLE_KEY',
  'REHEARSAL_C_EMAIL', 'REHEARSAL_C_PASSWORD', 'REHEARSAL_D_EMAIL', 'REHEARSAL_D_PASSWORD']);
let phase = 'environment';
const need = (condition) => { if (!condition) throw new Error(phase); };

export function assertChildEnvironment(env) {
  const extra = Object.keys(env).filter((name) => !ALLOWED.has(name) && !/^(?:LC_|__CF|LANG$|PWD$|SHLVL$|_$)/.test(name));
  need(extra.length === 0 && env.REHEARSAL_URL === API && typeof env.REHEARSAL_PUBLISHABLE_KEY === 'string'
    && !Object.keys(env).some((name) => /SERVICE|SECRET|DOCKER|ALLOW_HOSTED/i.test(name)));
}

async function request(env, token, route, { method = 'GET', body, binary = false } = {}) {
  const response = await fetch(API + route, {
    method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { apikey: env.REHEARSAL_PUBLISHABLE_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': binary ? 'image/jpeg' : 'application/json' }), ...(binary ? { 'x-upsert': 'false' } : {}) },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: response.ok, status: response.status, data, length: text.length };
}

async function signIn(env, label) {
  const result = await request(env, null, '/auth/v1/token?grant_type=password',
    { method: 'POST', body: { email: env[`REHEARSAL_${label}_EMAIL`], password: env[`REHEARSAL_${label}_PASSWORD`] } });
  return result.ok && typeof result.data?.access_token === 'string' ? { token: result.data.access_token, uid: result.data.user.id } : null;
}

async function seedOwner(env, owner) {
  const rpc = (name, body) => request(env, owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
  const items = [];
  for (let n = 0; n < 2; n += 1) {
    phase = `seed-item-${n}`;
    const value = intent();
    const reserved = await rpc('reserve_item_save', value);
    need(reserved.ok && reserved.data?.[0]?.item?.owner_id === owner.uid);
    for (const variant of ['thumb', 'main']) {
      const uploaded = await request(env, owner.token,
        `/storage/v1/object/wardrobe/${owner.uid}/${value.p_item.id}/${value.p_image.id}/${variant}.jpg`, { method: 'POST', body: bytes, binary: true });
      need(uploaded.ok);
    }
    const finalized = await rpc('finalize_item_save', { p_item_id: value.p_item.id, p_image_id: value.p_image.id,
      p_fingerprint: reserved.data[0].fingerprint });
    need(finalized.ok);
    items.push(value.p_item.id);
  }
  phase = 'seed-outfit';
  const outfit = await rpc('save_outfit', { p_id: randomUUID(), p_title: 'Fictional rehearsal outfit', p_item_ids: items,
    p_occasion: '', p_notes: '', p_favourite: false });
  need(outfit.ok);
  phase = 'seed-service-rpcs-refused';
  for (const [name, body] of [['deletion_control', { p_owner_id: owner.uid, p_action: 'status' }], ['purge_deletion_receipts', {}]]) {
    const refused = await rpc(name, body);
    need(!refused.ok && refused.status < 500);
  }
}

async function main() {
  try {
    const env = process.env;
    assertChildEnvironment(env);
    const mode = process.argv[2];
    need(process.argv.length === 3 && ['seed', 'verify'].includes(mode));
    if (mode === 'seed') {
      phase = 'seed-sign-in';
      const c = await signIn(env, 'C'), d = await signIn(env, 'D');
      need(c && d && c.uid !== d.uid);
      await seedOwner(env, c);
      await seedOwner(env, d);
      console.log(JSON.stringify({ c: c.uid, d: d.uid }));
      return;
    }
    phase = 'verify-deleted-owner';
    need(await signIn(env, 'C') === null);
    phase = 'verify-control-owner';
    const d = await signIn(env, 'D');
    need(d !== null);
    const items = await request(env, d.token, `/rest/v1/items?owner_id=eq.${d.uid}&select=id`);
    need(items.ok && Array.isArray(items.data) && items.data.length === 2);
    const images = await request(env, d.token, `/rest/v1/item_images?owner_id=eq.${d.uid}&select=main_path,thumb_path`);
    need(images.ok && Array.isArray(images.data) && images.data.length === 2);
    for (const image of images.data) {
      for (const objectPath of [image.main_path, image.thumb_path]) {
        const photo = await request(env, d.token, `/storage/v1/object/authenticated/wardrobe/${objectPath}`);
        need(photo.ok && photo.length > 0);
      }
    }
    console.log('PASS: deleted owner cannot sign in; control owner keeps its items and photos');
  } catch {
    console.error(`FAIL: deletion rehearsal normal sessions; phase=${phase}; no private details logged`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
