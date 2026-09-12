import { randomUUID } from 'node:crypto';
import { isMain } from '../../scripts/quality/files.mjs';
import { LOCAL_API } from '../../scripts/backend/local.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { intent, saveClients, saveHarness, denied, eq } from './item-save.sessions.mjs';
import { analysisId, analysisHash, analysisRequest } from './ai-analysis.sessions.mjs';
import { requireEvidence } from './preservation.sessions.mjs';

export const saveId = (label, n, image = false) => {
  requireEvidence(['A', 'B'].includes(label) && Number.isInteger(n) && n >= 21 && n <= 31);
  return `b229${label.toLowerCase()}00${image ? '1' : '0'}-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
export function analyzedIntent(owner, n) {
  const value = intent();
  value.p_item.id = saveId(owner.label, n);
  value.p_image = { ...value.p_image, id: saveId(owner.label, n, true),
    main_bytes: jpegHeaderFixture().length, thumb_bytes: jpegHeaderFixture().length,
    main_sha256: analysisHash, thumb_sha256: analysisHash, width: 120, height: 80 };
  Object.assign(value.p_item, { colours: ['green'], formality: 0, brand: null, material: 'Unverified', warmth: 2 });
  value.p_item.field_provenance = {
    title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 },
    colours: { kind: 'ai_observed', revision: 1 }, formality: { kind: 'ai_estimated', revision: 1 },
    brand: { kind: 'user', revision: 1 }, material: { kind: 'unknown', revision: 1 }, warmth: { kind: 'unknown', revision: 1 },
  };
  value.p_claim = {
    requestId: analysisId(owner.label, n), draftId: analysisId(owner.label, n), generation: 1, imageSha256: analysisHash,
    fields: { category: { kind: 'ai_observed', value: 'top' }, colours: { kind: 'ai_observed', value: ['green'] },
      formality: { kind: 'ai_estimated', value: 0 } },
  };
  return value;
}
export function analyzedHarness(client, owner, env) {
  const h = saveHarness(client, owner);
  const reserve = async (value) => {
    const result = await h.call('reserve_analyzed_item_save', value);
    requireEvidence(result.ok && result.status === 200 && Array.isArray(result.data) && result.data.length === 1);
    const row = result.data[0];
    requireEvidence(/^[0-9a-f]{64}$/.test(row.fingerprint) && ['reserved', 'completed'].includes(row.state));
    for (const [key, expected] of Object.entries(value.p_item)) eq(row.item[key], expected);
    for (const [key, expected] of Object.entries(value.p_image)) eq(row.image[key], expected);
    eq(row.item.owner_id, owner.uid); eq(row.image.owner_id, owner.uid);
    eq(row.image.item_id, value.p_item.id); eq(row.item.version, 1); eq(row.item.deleted_at, null);
    eq(row.image.description_version, 1); eq(row.image.retired_at, null);
    eq(await h.read('items', value.p_item.id), [row.item]);
    eq(await h.read('item_images', value.p_image.id), [row.image]);
    return row;
  };
  const upload = async (value, data = jpegHeaderFixture()) => {
    for (const path of h.paths(value)) {
      const result = await client.request(owner.token, `/storage/v1/object/wardrobe/${path}`,
        { method: 'POST', body: data, binary: true, headers: { 'x-upsert': 'false', 'cache-control': '0' } });
      requireEvidence(result.ok);
    }
  };
  const endpoint = async (value, row, token = owner.token, extras = {}) => {
    const result = await fetch(`${LOCAL_API}/functions/v1/finalize-analyzed-item`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer '.concat(token), apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: value.p_item.id, imageId: value.p_image.id, fingerprint: row.fingerprint, ...extras }),
    });
    requireEvidence(result.status < 500);
    if (result.status === 204) { requireEvidence(result.body === null); return { status: 204 }; }
    return { status: result.status, data: await result.json() };
  };
  const finalize = async (value, row) => eq(await endpoint(value, row), { status: 204 });
  const preflight = async (value, row) => {
    const result = await h.call('analyzed_item_save_preflight', h.finalizeArgs(value, row));
    requireEvidence(result.ok); return result.data;
  };
  return { ...h, reserve, upload, endpoint, finalize, preflight };
}

export async function analyzedBaseline(env) {
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    const h = analyzedHarness(client, owner, env);
    try {
      const value = h.track({ ...intent(), p_claim: null });
      value.p_item.warmth = 2; value.p_item.field_provenance.warmth = { kind: 'unknown', revision: 1 };
      const before = await client.rpc(owner, 'ai_status', {});
      const row = await h.reserve(value);
      eq(await h.reserve(value), row);
      denied(await h.call('reserve_analyzed_item_save', { ...value, p_claim: { oversized: 'x'.repeat(8193) } }), 'Invalid input');
      denied(await h.call('finalize_item_save', h.finalizeArgs(value, row)));
      denied(await h.call('commit_image', { p_image_id: value.p_image.id }));
      denied(await h.call('analyzed_item_save_preflight', h.finalizeArgs(value, row)), 'Upload incomplete');
      eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id }), []);
      await h.call('cancel_analyzed_item_save', h.finalizeArgs(value, row)).then((r) => requireEvidence(r.ok));
      denied(await h.call('reserve_analyzed_item_save', value));
      const after = await client.rpc(owner, 'ai_status', {});
      eq(after.usage, before.usage); eq(after.policy, before.policy); eq(after.consent, before.consent);
    } finally { await h.cleanup(); }
  }
}

async function prepare(env, origin) {
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    const h = analyzedHarness(client, owner, env);
    for (let n = 21; n <= 31; n++) {
      const response = await analysisRequest(origin, env, owner, n);
      requireEvidence(response.status === 200 && response.data.status === 'ready');
      const value = analyzedIntent(owner, n);
      if (n === 31) continue;
      if (n === 30) {
        for (const alter of [
          (v) => { v.p_claim.requestId = randomUUID(); },
          (v) => { v.p_claim.generation = 2; },
          (v) => { v.p_claim.draftId = randomUUID(); },
          (v) => { v.p_claim.imageSha256 = 'a'.repeat(64); },
          (v) => { v.p_image.main_bytes++; },
          (v) => { v.p_image.width++; },
          (v) => { v.p_item.category = 'bottom'; },
          (v) => { v.p_claim.fields.category.kind = 'ai_estimated'; },
          (v) => { v.p_item.field_provenance.category.kind = 'ai_estimated'; },
          (v) => { v.p_claim.fields.formality.value = 1; },
        ]) {
          const bad = structuredClone(value); alter(bad);
          const result = await h.call('reserve_analyzed_item_save', bad);
          requireEvidence(!result.ok && result.status === 400 && result.data.code === '22023');
          eq(await h.read('items', value.p_item.id), []);
        }
      }
      const row = await h.reserve(value);
      eq(await h.reserve(value), row);
      eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id }), []);
      await h.upload(value);
    }
  }
}
async function full(env, phase) {
  const { client, owners } = await saveClients(env);
  for (const owner of owners) {
    const h = analyzedHarness(client, owner, env);
    const use = async (n) => { const value = analyzedIntent(owner, n); return [value, await h.reserve(value)]; };
    if (phase === 'full') {
      const before = await client.rpc(owner, 'ai_status', {});
      const [value, row] = await use(21);
      denied(await h.call('finalize_item_save', h.finalizeArgs(value, row)));
      denied(await h.call('commit_image', { p_image_id: value.p_image.id }));
      await h.finalize(value, row);
      eq((await h.reserve(value)).state, 'completed');
      await h.finalize(value, row);
      const history = await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id });
      requireEvidence(history.length === 1 && history[0].source_image_id === value.p_image.id
        && history[0].image_sha256 === analysisHash && history[0].model_id === 'gemini-3.8-flash'
        && history[0].prompt_version === 1);
      eq(Object.keys(history[0].fields).sort(), ['category', 'colours', 'formality']);
      eq(Object.keys(history[0]).sort(), ['fields', 'image_sha256', 'model_id', 'prompt_version', 'source_image_id']);
      for (const field of ['category', 'colours', 'formality'])
        eq(history[0].fields[field], value.p_item.field_provenance[field]);
      await h.remove(value);
      requireEvidence((await h.call('forget_image', { p_image_id: value.p_image.id })).ok);
      eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id }),
        [{ ...history[0], source_image_id: null }]);
      denied(await h.call('reserve_analyzed_item_save', value));
      const duplicate = structuredClone(value); duplicate.p_item.id = randomUUID(); duplicate.p_image.id = randomUUID();
      denied(await h.call('reserve_analyzed_item_save', duplicate));

      const [discard, discardRow] = await use(23);
      await client.rpc(owner, 'ai_request_control', { p_request_id: discard.p_claim.requestId, p_action: 'discard' });
      await h.finalize(discard, discardRow); eq((await h.reserve(discard)).state, 'completed');
      const [cancel, cancelRow] = await use(26);
      requireEvidence((await h.call('cancel_analyzed_item_save', h.finalizeArgs(cancel, cancelRow))).ok);
      eq(await h.endpoint(cancel, cancelRow), { status: 409, data: { code: 'CONFLICT' } });
      denied(await h.call('reserve_analyzed_item_save', cancel));
      const [replacement, replacementRow] = await use(27);
      const old = await h.preflight(replacement, replacementRow);
      await h.remove(replacement); await h.upload(replacement);
      const next = await h.preflight(replacement, replacementRow);
      for (const variant of ['main', 'thumb']) {
        requireEvidence(typeof old.objects[variant].version === 'string' && old.objects[variant].version.length > 0);
        requireEvidence(old.objects[variant].id !== next.objects[variant].id && old.objects[variant].version !== next.objects[variant].version);
      }
      await h.finalize(replacement, replacementRow);
      const [mismatch, mismatchRow] = await use(28);
      await h.remove(mismatch); await h.upload(mismatch, jpegHeaderFixture(121, 80));
      eq(await h.endpoint(mismatch, mismatchRow), { status: 409, data: { code: 'CONFLICT' } });
      eq((await h.read('item_images', mismatch.p_image.id))[0].state, 'pending');
      const [edited, editedRow] = await use(29);
      await h.finalize(edited, editedRow);
      const editedHistory = await client.rpc(owner, 'item_attribution_history', { p_item_id: edited.p_item.id });
      requireEvidence((await client.patch(owner, 'items', editedRow.item, { favourite: true })).ok);
      const unchanged = (await h.read('items', edited.p_item.id))[0];
      eq(unchanged.field_provenance, edited.p_item.field_provenance);
      requireEvidence((await client.patch(owner, 'items', unchanged, { category: 'bottom' })).ok);
      const changed = (await h.read('items', edited.p_item.id))[0];
      eq(changed.field_provenance.category, { kind: 'unknown', revision: 2 });
      requireEvidence((await client.patch(owner, 'items', changed, { colours: [], field_provenance: {
        ...changed.field_provenance, colours: { kind: 'user', revision: 2 },
      } })).ok);
      eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: edited.p_item.id }), editedHistory);
      const after = await client.rpc(owner, 'ai_status', {});
      eq(after.usage.accountedMicro, before.usage.accountedMicro);
    } else if (phase === 'withdraw') {
      const [value, row] = await use(22);
      const profile = (await client.rows(owner, 'profiles'))[0];
      eq(await client.rpc(owner, 'ai_set_consent', { p_enabled: false, p_notice_revision: null, p_expected_version: profile.version }),
        { code: 'OK', profileVersion: String(profile.version + 1) });
      await h.finalize(value, row); eq((await h.reserve(value)).state, 'completed');
      eq(await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: 1, p_expected_version: profile.version + 1 }),
        { code: 'OK', profileVersion: String(profile.version + 2) });
    } else if (phase === 'expired') {
      const [value, row] = await use(24);
      await h.finalize(value, row);
      denied(await h.call('reserve_analyzed_item_save', analyzedIntent(owner, 31)));
      const unverified = analyzedIntent(owner, 31); unverified.p_claim = null;
      for (const entry of Object.values(unverified.p_item.field_provenance))
        if (entry.kind.startsWith('ai_')) entry.kind = 'unknown';
      const manual = await h.reserve(unverified); await h.upload(unverified); await h.finalize(unverified, manual);
      eq(await client.rpc(owner, 'item_attribution_history', { p_item_id: unverified.p_item.id }), []);
    } else if (phase === 'inactive') {
      const [value, row] = await use(25); await h.finalize(value, row);
    } else if (phase === 'cleanup') {
      for (let n = 21; n <= 31; n++) {
        const value = analyzedIntent(owner, n);
        await h.remove(value); await h.deleteItem(value);
        denied(await h.call('reserve_analyzed_item_save', value));
      }
    } else throw new Error('EVIDENCE_REQUIRED');
  }
}

async function main() {
  const [phase = 'baseline', origin, ...extra] = process.argv.slice(2);
  try {
    requireEvidence(extra.length === 0 && (phase === 'prepare' ? !!origin : origin === undefined));
    if (phase === 'baseline') await analyzedBaseline(process.env);
    else if (phase === 'prepare') await prepare(process.env, origin);
    else await full(process.env, phase);
    console.log(`PASS: B2 ${phase}; normal owners=2; ${phase === 'baseline' ? 'reservation baseline only, no finalizer proof' : 'actual Auth/DB/Storage; synthetic JPEG fixture'}`);
  } catch {
    console.error(`FAIL: B2 integration ${phase}; private details withheld; fixture state retained`);
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
