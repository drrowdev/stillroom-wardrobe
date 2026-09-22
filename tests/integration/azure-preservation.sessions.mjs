import { createHash } from 'node:crypto';
import { normalClient, requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisId, analysisHash } from './ai-analysis.sessions.mjs';
import { analyzedHarness, analyzedIntent } from './analyzed-save.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const tables = ['ai_controls', 'ai_usage', 'ai_requests', 'ai_usage_evidence', 'ai_analysis_attestations',
  'ai_save_used_receipts', 'ai_item_save_attempts', 'item_save_attempts', 'item_save_used_ids', 'item_attribution_history'];
const googleUsage = { modelVersion: 'gemini-3.8-flash', trafficType: 'ON_DEMAND',
  promptTokenCount: 100, totalTokenCount: 130, candidatesTokenCount: 10, thoughtsTokenCount: 20 };
const googleFacts = { outcome: 'ready', fields: { category: 'top', colours: ['green'], formality: 0 } };
const rows = (table) => `coalesce((select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from private.${table} t),'[]'::jsonb)`;
const stateSql = `select jsonb_build_object(${tables.map((name) => `${literal(name)},${rows(name)}`).join(',')});`;

// Invoked only by the existing CI-only preservation owner, at exact prior-main.
export async function captureAzurePreservation(env, sql) {
  const db = async (query) => JSON.parse(await sql(query));
  const client = normalClient(env), owners = [await client.signIn('A'), await client.signIn('B')];
  requireEvidence(owners[0].uid !== owners[1].uid);
  const old = await db(stateSql);
  requireEvidence(tables.every((name) => old[name].length === 0));
  const profiles = [];
  for (const owner of owners) {
    await sql(`insert into private.ai_controls(owner_id,activated,notice_revision,model_id,prompt_version,max_request_micro,
      monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds,execution_manifest_id)
      values(${literal(owner.uid)},true,1,'gemini-3.8-flash',1,2270823,100000000,200,3600,'google-eu-3.8-v1');`);
    const p = (await client.rows(owner, 'profiles'))[0];
    equal(await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: 1, p_expected_version: p.version }),
      { code: 'OK', profileVersion: String(p.version + 1) });
    profiles.push((await client.rows(owner, 'profiles'))[0]);
    for (const n of [1, 2, 3, 4, 21, 22]) {
      const id = analysisId(owner.label, n);
      const claim = await db(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
        ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,'google-eu-3.8-v1');`);
      requireEvidence(claim.claimed === true);
      if ([2, 3, 21, 22].includes(n)) {
        const finish = await db(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},'google-eu-3.8-v1',
          ${json(googleFacts)},${json(googleUsage)},'SUCCESS');`);
        requireEvidence(finish.stored === true);
      }
      if (n === 3) {
        const billed = await db(`select public.ai_settle_request(${literal(owner.uid)},${literal(id)},null,500,'BILLING_ONLY');`);
        requireEvidence(billed.chargeState === 'settled');
      }
    }
    const h = analyzedHarness(client, owner, env), intent = analyzedIntent(owner, 21);
    const row = await h.reserve(intent);
    await h.upload(intent);
    requireEvidence((await h.preflight(intent, row)).state === 'reserved');
    const completed = analyzedIntent(owner, 22);
    const completedRow = await h.reserve(completed);
    await h.upload(completed); await h.finalize(completed, completedRow);
  }
  const before = await db(stateSql), library = [];
  requireEvidence(before.ai_usage.length === 12 && before.ai_item_save_attempts.length === 4
    && before.item_attribution_history.length === 2);
  for (const owner of owners) {
    const h = analyzedHarness(client, owner, env);
    const bytes = [];
    for (const path of [21, 22].flatMap((n) => h.paths(analyzedIntent(owner, n)))) {
      const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
      requireEvidence(result.ok && Buffer.isBuffer(result.data));
      bytes.push(createHash('sha256').update(result.data).digest('hex'));
    }
    library.push({ items: await client.rows(owner, 'items'), images: await client.rows(owner, 'item_images'), bytes });
  }
  return { before, profiles, library, client, owners, env };
}

export async function verifyAzurePreservation(snapshot, sql) {
  const db = async (query) => JSON.parse(await sql(query));
  const { before, profiles, library, client, owners, env } = snapshot;
  const after = await db(stateSql);
  for (const row of after.ai_usage_evidence) {
    for (const key of ['model_observation', 'control_observation', 'claim_identity']) {
      requireEvidence(Object.hasOwn(row, key) && row[key] === null); delete row[key];
    }
  }
  for (const row of after.item_attribution_history) {
    requireEvidence(Object.hasOwn(row, 'manifest_id') && row.manifest_id === null); delete row.manifest_id;
  }
  equal(after, before);
  for (const [index, owner] of owners.entries()) {
    equal((await client.rows(owner, 'profiles'))[0], profiles[index]);
    equal(await client.rows(owner, 'items'), library[index].items);
    equal(await client.rows(owner, 'item_images'), library[index].images);
    const h = analyzedHarness(client, owner, env), intent = analyzedIntent(owner, 21);
    for (const [variant, path] of [21, 22].flatMap((n) => h.paths(analyzedIntent(owner, n))).entries()) {
      const result = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${path}`);
      requireEvidence(result.ok && Buffer.isBuffer(result.data));
      equal(createHash('sha256').update(result.data).digest('hex'), library[index].bytes[variant]);
    }
    for (const [n, basis, amount] of [[1, 'held', '2270823'], [2, 'estimated', '413'], [3, 'confirmed', '500'], [4, 'held', '2270823']]) {
      const reply = await client.rpc(owner, 'ai_analysis_status', { p_request_id: analysisId(owner.label, n) });
      equal(reply.accounting, { basis, amountMicro: amount, currency: 'USD' });
    }
    const id = analysisId(owner.label, 4);
    const settled = await db(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},'google-eu-3.8-v1',
      ${json(googleFacts)},${json(googleUsage)},'SUCCESS');`);
    requireEvidence(settled.stored && settled.code === 'READY');
    const late = await client.rpc(owner, 'ai_analysis_status', { p_request_id: id });
    requireEvidence(late.status === 'ready' && late.result.modelId === 'gemini-3.8-flash');
    equal(late.result.facts, googleFacts); equal(late.accounting, { basis: 'estimated', amountMicro: '413', currency: 'USD' });
    const p = (await client.rows(owner, 'profiles'))[0];
    equal(await client.rpc(owner, 'ai_set_consent', { p_enabled: false, p_notice_revision: null, p_expected_version: p.version }),
      { code: 'OK', profileVersion: String(p.version + 1) });
    await sql(`update private.ai_controls set activated=false where owner_id=${literal(owner.uid)};
      update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
      where owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, 21))};`);
    const reserved = await h.reserve(intent);
    await h.finalize(intent, reserved);
    equal((await h.reserve(intent)).state, 'completed');
    const history = await client.rpc(owner, 'item_attribution_history', { p_item_id: intent.p_item.id });
    requireEvidence(history.length === 1 && history[0].model_id === 'gemini-3.8-flash');
    equal(Object.keys(history[0]).sort(), ['fields', 'image_sha256', 'model_id', 'prompt_version', 'source_image_id']);
    const itemIds = [21, 22].map((n) => analyzedIntent(owner, n).p_item.id);
    for (const n of [21, 22]) {
      const value = analyzedIntent(owner, n);
      await h.remove(value); await h.deleteItem(value);
    }
    await sql(`delete from private.ai_usage where owner_id=${literal(owner.uid)} and request_id in
      (${[1, 2, 3, 4, 21, 22].map((n) => literal(analysisId(owner.label, n))).join(',')});
      delete from private.ai_save_used_receipts where owner_id=${literal(owner.uid)} and item_id in (${itemIds.map(literal).join(',')});
      delete from private.item_save_used_ids where owner_id=${literal(owner.uid)} and item_id in (${itemIds.map(literal).join(',')});
      delete from private.ai_controls where owner_id=${literal(owner.uid)};`);
    requireEvidence((await client.rows(owner, 'items')).length === 0 && (await client.rows(owner, 'item_images')).length === 0);
  }
  const restored = await db(stateSql);
  requireEvidence(tables.every((name) => restored[name].length === 0));
}
