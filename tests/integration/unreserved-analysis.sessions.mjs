import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisFacts, analysisHash } from './ai-analysis.sessions.mjs';
import { analyzedHarness, analyzedIntent } from './analyzed-save.sessions.mjs';
import { imageChangeHarness } from './image-replacement.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { switchControlsSql, CURRENT_PERIOD_SQL } from '../../scripts/budget2-controls-switch.mjs';

// BUDGET2: catalog and behaviour proof after 20261101090000. A populated budget2-prior state (everything through AVAIL1,
// whose own proofs already ran there, unchanged) is checkpointed, only this migration is applied, and the checkpoint is
// compared BEFORE any probe writes: the six replaced bodies equal the migration source byte for byte, exactly one manifest
// row was added, and no controls row, usage row, consent, trigger or object changed. The probes then run the real
// functions. No provider is called; no clock, manifest row or trigger is touched.
const MIGRATION = '20261101090000_unreserved_analysis_manifest.sql';
const FUNCTIONS = Object.freeze(['public.ai_claim_analysis', 'private.ai_analysis_permitted', 'public.ai_finish_analysis',
  'public.ai_status', 'public.complete_analyzed_item_save', 'private.admin_set_budget']);
const V1 = 'azure-eu-terra-devtest-v1', V2 = 'azure-eu-terra-devtest-v2', V3 = 'azure-eu-terra-devtest-v3';
const V3_SETTINGS_SHA = '67fd5bae409fb317702d89780ce8dcc1b80ccd4d6b690942b43faa7989d459bf';
const V2_RESERVATION = 4097351, V3_RESERVATION = 1, V3_INPUT_ENVELOPE = 16384;
const CEILING = 200_000_000;

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;

function sourceBody(sql, name) {
  const header = `create or replace function ${name}(`, start = sql.indexOf(header);
  requireEvidence(start >= 0 && sql.indexOf(header, start + header.length) === -1);
  const open = sql.indexOf(' as $$\n', start), close = sql.indexOf('\n$$;', open);
  requireEvidence(open > start && close > open);
  const body = sql.slice(open + ' as $$'.length, close + 1);
  requireEvidence(!body.includes('$$'));
  return body;
}

export async function budget2CatalogProbe(sql, mark = () => {}) {
  const source = await readFile(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  requireEvidence(!source.includes('\r'));
  const state = JSON.parse(await sql(`select jsonb_object_agg(f.name,(select coalesce(jsonb_agg(jsonb_build_object(
      'md5',md5(p.prosrc),'definer',p.prosecdef,'config',coalesce(p.proconfig,'{}'::text[]),
      'v3',position(${literal(V3)} in p.prosrc)>0,'ceiling',position('v_new>${CEILING}' in p.prosrc)>0)),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=f.name))
    from (values ${FUNCTIONS.map((name) => `(${literal(name)})`).join(',')}) as f(name);`));
  const label = (name, check) => mark(`catalog-${name.replace(/[^a-z0-9_]+/gi, '-')}-${check}`);
  for (const name of FUNCTIONS) {
    label(name, 'one-definition');
    requireEvidence(Array.isArray(state[name]) && state[name].length === 1);
    label(name, 'body-md5');
    equal(state[name][0].md5, createHash('md5').update(sourceBody(source, name)).digest('hex'));
    label(name, 'manifest-list');
    equal(state[name][0].v3, name !== 'private.admin_set_budget');
    label(name, 'ceiling');
    equal(state[name][0].ceiling, name === 'private.admin_set_budget');
    label(name, 'search-path');
    requireEvidence(state[name][0].config.some((entry) => entry.startsWith('search_path=')));
  }
}

const TABLES = [['private', 'ai_controls'], ['private', 'ai_usage'], ['private', 'ai_requests'], ['private', 'ai_usage_evidence'],
  ['private', 'ai_analysis_attestations'], ['private', 'ai_save_used_receipts'], ['private', 'ai_item_save_attempts'],
  ['private', 'item_save_attempts'], ['private', 'item_save_used_ids'], ['private', 'item_attribution_history'],
  ['private', 'image_change_attempts'], ['private', 'ai_limit_audit'], ['public', 'items'], ['public', 'item_images'], ['public', 'profiles']];
const checkpointSql = `select jsonb_build_object(
  'functions',(select jsonb_object_agg(n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    jsonb_build_object('owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile,
      'config',coalesce(p.proconfig,'{}'::text[]),'acl',coalesce(p.proacl::text,''),
      'body',case when n.nspname||'.'||p.proname=any(array[${FUNCTIONS.map(literal).join(',')}]) then null else md5(p.prosrc) end))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'manifests',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from private.ai_execution_manifests m),
  'triggers',(select coalesce(jsonb_agg(jsonb_build_array(c.oid::regclass::text,t.tgname,pg_get_triggerdef(t.oid))
      order by c.oid::regclass::text,t.tgname),'[]'::jsonb)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname in ('public','private')),
  'rows',jsonb_build_object(${TABLES.map(([schema, name]) => `${literal(`${schema}.${name}`)},(select jsonb_build_array(count(*),
      md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text)) from ${schema}.${name} t)`).join(',')}),
  'objects',(select jsonb_build_array(count(*),md5(coalesce(jsonb_agg(jsonb_build_array(name,metadata->>'size') order by name),'[]'::jsonb)::text))
    from storage.objects where bucket_id='wardrobe'));`;

export async function budget2Checkpoint(sql) {
  const state = JSON.parse(await sql(checkpointSql));
  requireEvidence(Object.keys(state.functions).length > 100 && state.triggers.length > 0);
  requireEvidence(state.manifests.some((m) => m.id === V2) && !state.manifests.some((m) => m.id === V3));
  for (const name of FUNCTIONS) {
    requireEvidence(Object.entries(state.functions).some(([key, value]) => key.startsWith(`${name}(`) && value.body === null));
  }
  requireEvidence(Object.values(state.rows).every((entry) => Array.isArray(entry) && entry.length === 2));
  requireEvidence(state.rows['public.items'][0] > 0 && state.rows['private.ai_usage'][0] > 0 && state.rows['private.ai_controls'][0] > 0);
  return state;
}

// Read-only: the migration changed the six bodies and added one manifest row, nothing else (owner, ACL, security config,
// volatility, every other body, every other manifest, triggers, every row including each account's controls, objects).
export async function budget2Compare(before, sql, mark = () => {}) {
  const after = JSON.parse(await sql(checkpointSql));
  const clean = (text) => String(text).replace(/[^a-z0-9_]+/gi, '-').slice(0, 80);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const section of ['triggers', 'objects']) {
    if (!same(after[section], before[section])) mark(`compare-${section}`);
    requireEvidence(same(after[section], before[section]));
  }
  for (const key of Object.keys(before.rows)) {
    if (!same(after.rows[key], before.rows[key])) mark(`compare-rows-${clean(key)}`);
    requireEvidence(same(after.rows[key], before.rows[key]));
  }
  const names = new Set([...Object.keys(before.functions), ...Object.keys(after.functions)]);
  for (const name of names) {
    for (const field of ['owner', 'definer', 'volatility', 'config', 'acl', 'body']) {
      const x = before.functions[name]?.[field], y = after.functions[name]?.[field];
      if (!same(x, y)) mark(`compare-function-${clean(name)}-${field}`);
      requireEvidence(same(x, y));
    }
  }
  mark('compare-manifests');
  const added = after.manifests.filter((m) => !before.manifests.some((old) => old.id === m.id));
  requireEvidence(added.length === 1 && added[0].id === V3 && after.manifests.length === before.manifests.length + 1);
  requireEvidence(same(after.manifests.filter((m) => m.id !== V3), before.manifests));
  const v2 = before.manifests.find((m) => m.id === V2), v3 = added[0];
  // Everything but the settings digest, the description, the envelope and the reservation is v2's, including the prompt and schema.
  const differing = Object.keys(v3).filter((key) => !same(v3[key], v2[key])).sort();
  equal(differing, ['id', 'input_envelope', 'reservation_micro', 'settings_sha256', 'tariff_description']);
  equal([v3.settings_sha256, v3.input_envelope, v3.output_envelope, v3.reservation_micro, v3.prompt_version],
    [V3_SETTINGS_SHA, V3_INPUT_ENVELOPE, 2048, V3_RESERVATION, 2]);
  const withoutManifests = (state) => Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'manifests'));
  equal(withoutManifests(after), withoutManifests(before));
}

const USAGE = Object.freeze({ modelObservation: 'expected_snapshot', controlObservation: 'ordinary', input: 1000, output: 200,
  total: 1200, reasoning: 50, cacheRead: 0, cacheWrite: 0 });
const ESTIMATE = Math.ceil((1000 * 440 + 200 * 1980) / 100);

// Runs the operator's switch text and reports its outcome instead of throwing: 'OK' (it committed) or the exact message it
// raised, so a refusal is told apart from any other failure. The DO block runs unchanged inside an EXECUTE.
async function attemptSwitch(sql, ownerId, direction, zone = 'UTC') {
  const text = switchControlsSql(ownerId, direction);
  const block = text.slice(text.indexOf('do $switch$'), text.lastIndexOf('commit;')).trim();
  const out = await sql(`create temp table if not exists budget2_attempt(message text);
    truncate budget2_attempt;
    set time zone ${literal(zone)};
    do $outer$ begin
      begin execute $inner$${block}$inner$; insert into budget2_attempt values('OK');
      exception when others then insert into budget2_attempt values(sqlerrm); end;
    end $outer$;
    reset time zone;
    select message from budget2_attempt;`);
  return out.trim();
}

export async function budget2BehaviourProbes(snapshot, rawSql, markStage) {
  // Failure labels are the only detail the rehearsal prints, so each comparison puts the actual and wanted values in it.
  let current = '';
  const mark = (name) => { current = name; markStage(name); };
  const brief = (value) => JSON.stringify(value ?? null).replace(/[^A-Za-z0-9_.:,()-]+/g, '').slice(0, 110);
  const sql = async (text) => {
    try { return await rawSql(text); } catch (error) { markStage(`${current}-sql-failed-${brief(text.replace(/\s+/g, ' ').slice(0, 60))}`); throw error; }
  };
  const attempt = (owner, direction, zone) => attemptSwitch(sql, owner.uid, direction, zone);
  const equal = (actual, expected) => {
    const ok = isDeepStrictEqual(actual, expected);
    if (!ok) markStage(`${current}-got-${brief(actual)}-want-${brief(expected)}`);
    requireEvidence(ok);
  };
  const need = (ok) => {
    if (!ok) markStage(`${current}-check-at-line-${/:(\d+):\d+/.exec(new Error('x').stack?.split('\n')[2] ?? '')?.[1] ?? 'unknown'}`);
    requireEvidence(ok);
  };
  const { client, owners: [a, b], env } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const used = async (owner) => BigInt(await scalar(`select private.ai_budget_used(${literal(owner.uid)},clock_timestamp());`));
  const setControls = (owner, manifest, maxRequest, allowance = 100000000) => sql(`insert into private.ai_controls(owner_id,activated,
    notice_revision,model_id,prompt_version,max_request_micro,monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds,
    execution_manifest_id) values(${literal(owner.uid)},true,2,'gpt-5.6-terra-2026-07-09',2,${maxRequest},${allowance},200,3600,
    ${literal(manifest)}) on conflict (owner_id) do update set activated=true,notice_revision=2,model_id=excluded.model_id,
      prompt_version=2,max_request_micro=excluded.max_request_micro,monthly_allowance_micro=excluded.monthly_allowance_micro,
      result_ttl_seconds=excluded.result_ttl_seconds,execution_manifest_id=excluded.execution_manifest_id;`);
  const setAllowance = (owner, micro) => sql(`update private.ai_controls set monthly_allowance_micro=${micro} where owner_id=${literal(owner.uid)};`);
  const aiConsent = async (owner, enabled) => {
    const profile = (await client.rows(owner, 'profiles'))[0];
    return client.rpc(owner, 'ai_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? 2 : null, p_expected_version: profile.version });
  };
  const claim = (owner, id, manifest = V3) => one(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
    ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(manifest)});`);
  const finish = (owner, id, facts, manifest = V3, usage = USAGE) => one(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},
    ${literal(manifest)},${json(facts)},${json(usage)},'SUCCESS');`);
  const facts = (fields) => ({ ...analysisFacts, fields: { ...analysisFacts.fields, ...fields } });
  const usageRow = (owner, id) => one(`select to_jsonb(u) from (select reserved_micro::text,accounted_micro::text,charge_state,closed_reason
    from private.ai_usage where owner_id=${literal(owner.uid)} and request_id=${literal(id)}) u;`);
  const controlsRow = (owner) => one(`select to_jsonb(c) from (select execution_manifest_id,max_request_micro,monthly_allowance_micro,
    activated,prompt_version,notice_revision from private.ai_controls where owner_id=${literal(owner.uid)}) c;`);
  const completed = async (ich, value) => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await ich.endpoint(value);
      if (result.status === 204) return;
      equal(result, { status: 409, data: { code: 'CONFLICT' } });
      await new Promise((resolve) => { setTimeout(resolve, 50 * attempt); });
    }
    need(false);
  };
  const saveIntent = (request, colours) => {
    const value = analyzedIntent(a, 21);
    value.p_item.id = randomUUID(); value.p_image.id = randomUUID(); value.p_item.colours = colours;
    value.p_claim = { ...value.p_claim, requestId: request, draftId: request,
      fields: { ...value.p_claim.fields, colours: { kind: 'ai_observed', value: colours } } };
    return value;
  };

  mark('v3-hold');
  await setControls(a, V3, V3_RESERVATION);
  equal((await aiConsent(a, true)).code, 'OK');
  const baseline = await used(a);
  const request = randomUUID();
  const first = await claim(a, request);
  need(first.claimed === true && first.manifestId === V3);
  // The whole hold is one micro-USD: no worst-case amount is set aside for the photo.
  equal(await usageRow(a, request), { reserved_micro: '1', accounted_micro: '1', charge_state: 'held', closed_reason: null });
  equal(await used(a), baseline + 1n);
  mark('v3-status');
  const status = await client.rpc(a, 'ai_status', {});
  equal([status.code, status.policy.executionManifestId, status.policy.maxRequestMicro, status.policy.promptVersion, status.policy.noticeRevision],
    ['OK', V3, '1', 2, 2]);
  mark('v3-finish');
  equal((await finish(a, request, facts({ colours: ['navy'] }))).stored, true);
  equal(await usageRow(a, request), { reserved_micro: '1', accounted_micro: String(ESTIMATE), charge_state: 'estimated', closed_reason: null });
  equal(await used(a), baseline + BigInt(ESTIMATE));

  mark('v3-analyzed-save');
  const h = analyzedHarness(client, a, env);
  const value = saveIntent(request, ['navy']);
  const row = await h.reserve(value);
  await h.upload(value);
  await h.finalize(value, row);
  let history = await client.rpc(a, 'item_attribution_history', { p_item_id: value.p_item.id });
  need(history.length === 1 && history[0].prompt_version === 2);
  equal(history[0].fields.colours, { kind: 'ai_observed', revision: 1 });
  // The saved lineage names the v3 manifest instead of none; the owner-facing history and export never show it.
  equal(await scalar(`select manifest_id from private.item_attribution_history where owner_id=${literal(a.uid)} and item_id=${literal(value.p_item.id)};`), V3);
  need(!JSON.stringify(history).includes('devtest') && !Object.hasOwn(history[0], 'manifest_id'));

  mark('v3-image-replacement');
  const replacementRequest = randomUUID();
  need((await claim(a, replacementRequest)).claimed === true);
  equal((await finish(a, replacementRequest, facts({ pattern: 'solid' }))).stored, true);
  const ich = imageChangeHarness(client, a, env);
  const replacement = ich.make((await h.read('items', value.p_item.id))[0], (await h.read('item_images', value.p_image.id))[0]);
  replacement.item.pattern = 'solid'; replacement.item.field_provenance.pattern = { kind: 'ai_observed', revision: 1 };
  replacement.claim = { requestId: replacementRequest, draftId: replacementRequest, generation: 1, imageSha256: analysisHash,
    fields: { pattern: { kind: 'ai_observed', value: 'solid' } } };
  await ich.reserve(replacement);
  await ich.upload(replacement);
  await completed(ich, replacement);
  history = await client.rpc(a, 'item_attribution_history', { p_item_id: value.p_item.id });
  need(history.length === 2 && history[1].source_image_id === replacement.imageId);
  // The replacement's attribution is recorded in image_change_history (the owner-facing history merges both tables).
  equal(await scalar(`select count(*) from private.item_attribution_history where owner_id=${literal(a.uid)} and item_id=${literal(value.p_item.id)}
    and manifest_id=${literal(V3)};`), '1');
  equal(await scalar(`select count(*) from private.image_change_history where owner_id=${literal(a.uid)} and item_id=${literal(value.p_item.id)}
    and manifest_id=${literal(V3)};`), '1');

  mark('manifest-pairs');
  // Each controls row admits only its own manifest. v2 keeps its whole-request floor, so v2 can never run at one micro.
  equal(await claim(a, randomUUID(), V2), { code: 'CONFIG_CHANGED', claimed: false });
  equal(await claim(a, randomUUID(), V1), { code: 'CONFIG_CHANGED', claimed: false });
  await setControls(a, V2, V3_RESERVATION);
  equal(await claim(a, randomUUID(), V2), { code: 'UNCONFIGURED', claimed: false });
  equal(await claim(a, randomUUID(), V3), { code: 'CONFIG_CHANGED', claimed: false });
  await setControls(a, V2, V2_RESERVATION);
  const legacy = randomUUID(), legacyBase = await used(a);
  need((await claim(a, legacy, V2)).claimed === true);
  equal((await usageRow(a, legacy)).accounted_micro, String(V2_RESERVATION));
  equal(await used(a), legacyBase + BigInt(V2_RESERVATION));
  equal(await claim(a, randomUUID(), V3), { code: 'CONFIG_CHANGED', claimed: false });
  equal((await finish(a, legacy, facts({ colours: ['navy'] }), V2)).stored, true);
  await setControls(a, V3, V3_RESERVATION);

  mark('burst-allowance');
  // The check compares recorded use only: with room for three one-micro holds, three claims are admitted, the fourth is not,
  // and finishing records the real cost, which may pass the allowance by what was in flight.
  const room = await used(a);
  await setAllowance(a, room + 3n);
  const burst = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of burst) need((await claim(a, id)).claimed === true);
  equal(await claim(a, randomUUID()), { code: 'ALLOWANCE', claimed: false });
  for (const id of burst) equal((await finish(a, id, facts({ colours: ['navy'] }))).stored, true);
  const after = await used(a);
  equal(after, room + BigInt(3 * ESTIMATE));
  need(after > room + 3n);
  equal(await claim(a, randomUUID()), { code: 'ALLOWANCE', claimed: false });
  await setAllowance(a, 100000000);

  mark('concurrent-claims');
  const concurrentBase = await used(a);
  await setAllowance(a, concurrentBase + 2n);
  const results = await Promise.all(Array.from({ length: 5 }, () => claim(a, randomUUID())));
  equal(results.filter((reply) => reply.claimed === true).length, 2);
  equal(results.filter((reply) => reply.code === 'ALLOWANCE').length, 3);
  equal(await used(a), concurrentBase + 2n);
  await setAllowance(a, 100000000);

  mark('expired-held');
  // A dispatched request that expires keeps its held charge (it is never released): one micro now, not a whole request.
  const stale = randomUUID(), staleBase = await used(a);
  need((await claim(a, stale)).claimed === true);
  await sql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
    where owner_id=${literal(a.uid)} and request_id=${literal(stale)};
    select private.ai_expire(${literal(a.uid)},clock_timestamp(),100);`);
  equal(await usageRow(a, stale), { reserved_micro: '1', accounted_micro: '1', charge_state: 'held', closed_reason: 'EXPIRED' });
  equal(await used(a), staleBase + 1n);

  mark('anomaly');
  // v3: the envelope is a recorded anomaly threshold, not a switch. Input above 16,384 records the unclamped estimate and fails
  // that photo only; analysis stays available for the next one without any reactivation.
  const edge = randomUUID();
  need((await claim(a, edge)).claimed === true);
  const inEnvelope = { ...USAGE, input: V3_INPUT_ENVELOPE, output: 2048, total: V3_INPUT_ENVELOPE + 2048, reasoning: 0 };
  equal((await finish(a, edge, facts({ colours: ['navy'] }), V3, inEnvelope)).stored, true);
  equal((await controlsRow(a)).activated, true);
  const over = randomUUID();
  need((await claim(a, over)).claimed === true);
  const overUsage = { ...USAGE, input: V3_INPUT_ENVELOPE + 1, output: 10, total: V3_INPUT_ENVELOPE + 11, reasoning: 0 };
  equal((await finish(a, over, facts({ colours: ['navy'] }), V3, overUsage)).code, 'USAGE_ANOMALY');
  equal((await usageRow(a, over)).accounted_micro, String(Math.ceil(((V3_INPUT_ENVELOPE + 1) * 440 + 10 * 1980) / 100)));
  equal(await scalar(`select anomaly::text from private.ai_usage_evidence where owner_id=${literal(a.uid)} and request_id=${literal(over)};`), 'true');
  equal((await controlsRow(a)).activated, true);
  need((await claim(a, randomUUID())).claimed === true);
  // The output side of the envelope behaves the same.
  const overOut = randomUUID();
  need((await claim(a, overOut)).claimed === true);
  equal((await finish(a, overOut, facts({ colours: ['navy'] }), V3, { ...USAGE, input: 100, output: 2049, total: 2149, reasoning: 0 })).code, 'USAGE_ANOMALY');
  equal((await controlsRow(a)).activated, true);
  // Every other shutdown is unchanged for v3: contradictory or cache controls still deactivate it.
  const contradictory = randomUUID();
  need((await claim(a, contradictory)).claimed === true);
  equal((await finish(a, contradictory, facts({ colours: ['navy'] }), V3, { ...USAGE, controlObservation: 'contradictory' })).code, 'USAGE_ANOMALY');
  equal((await controlsRow(a)).activated, false);
  equal(await claim(a, randomUUID()), { code: 'INACTIVE', claimed: false });
  await sql(`update private.ai_controls set activated=true where owner_id=${literal(a.uid)};`);
  const cache = randomUUID();
  need((await claim(a, cache)).claimed === true);
  equal((await finish(a, cache, facts({ colours: ['navy'] }), V3, { ...USAGE, controlObservation: 'cache_read', cacheRead: 5 })).code, 'USAGE_ANOMALY');
  equal((await controlsRow(a)).activated, false);
  await sql(`update private.ai_controls set activated=true where owner_id=${literal(a.uid)};`);
  // v2 keeps its deactivation on an envelope overrun (v1/v2 semantics preserved).
  await setControls(a, V2, V2_RESERVATION);
  const overV2 = randomUUID();
  need((await claim(a, overV2, V2)).claimed === true);
  equal((await finish(a, overV2, facts({ colours: ['navy'] }), V2, { ...USAGE, input: 922001, output: 10, total: 922011, reasoning: 0 })).code, 'USAGE_ANOMALY');
  equal((await controlsRow(a)).activated, false);
  await setControls(a, V3, V3_RESERVATION);
  need((await claim(a, randomUUID())).claimed === true);

  mark('ready-draft-and-reverse-cutover');
  // A ready, unsaved v3 result refuses Save once the controls return to v2 (its manifest no longer matches); the switch
  // itself is guarded and BLOCKED while a request is alive.
  await setControls(b, V3, V3_RESERVATION);
  equal((await aiConsent(b, true)).code, 'OK');
  const ready = randomUUID();
  need((await claim(a, ready)).claimed === true);
  equal((await finish(a, ready, facts({ colours: ['navy'] }))).stored, true);
  const before = await controlsRow(a);
  const refusal = await attempt(a, 'rollback');
  if (!refusal.startsWith('BLOCKED: ')) markStage(`${current}-rollback-not-blocked-got-${brief(refusal)}`);
  need(refusal.startsWith('BLOCKED: '));
  equal(await controlsRow(a), before);
  await sql(`update private.ai_controls set execution_manifest_id=${literal(V2)},max_request_micro=${V2_RESERVATION}
    where owner_id=${literal(a.uid)};`);
  const refused = await analyzedHarness(client, a, env).call('reserve_analyzed_item_save', saveIntent(ready, ['navy']));
  need(refused.ok && refused.data.length === 1 && refused.data[0].state === 'analysis_unavailable');

  mark('guarded-switch');
  // The subject account has no alive request, no held charge and no frozen Save: the guards are then seen one at a time.
  // Earlier frozen stages left such residue for either owner; it is cleared (requests, held charges) or, for a frozen attempt,
  // avoided by taking the owner that has none. A frozen attempt is never deleted to pass a guard.
  const frozenOf = async (owner) => Number(await scalar(`select (select count(*) from private.ai_item_save_attempts x join private.item_save_attempts y
      on y.owner_id=x.owner_id and y.item_id=x.item_id where x.owner_id=${literal(owner.uid)} and x.manifest_id is not null and y.state='reserved')
    +(select count(*) from private.image_change_attempts z where z.owner_id=${literal(owner.uid)} and z.manifest_id is not null and z.state='reserved');`));
  const frozen = [await frozenOf(b), await frozenOf(a)];
  const s = frozen[0] === 0 ? b : a;
  if (frozen[0] !== 0 && frozen[1] !== 0) markStage(`${current}-both-owners-hold-a-frozen-attempt-${frozen.join('-')}`);
  need(frozen[0] === 0 || frozen[1] === 0);
  await setControls(s, V3, V3_RESERVATION);
  equal((await aiConsent(s, true)).code, 'OK');
  const reconcile = (owner) => sql(`delete from private.ai_usage where owner_id=${literal(owner.uid)} and charge_state in ('reserved','held');`);
  const expire = (owner, id) => sql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
    where owner_id=${literal(owner.uid)} and request_id=${literal(id)}; select private.ai_expire(${literal(owner.uid)},clock_timestamp(),100);`);
  const REFUSALS = {
    row: 'BLOCKED: the controls are not the expected current row',
    alive: 'BLOCKED: a request of this account is still alive',
    ready: 'BLOCKED: an unsaved ready analysis is still alive',
    held: 'BLOCKED: reserved or held charge exists (an expired dispatched request keeps its held charge; only a closed Azure v2 anomaly hold of an earlier month, with no request, is ignored)',
  };
  await reconcile(s);
  // Earlier frozen stages left unexpired ready results for this owner; they are fixture residue, cleared so each guard is seen alone.
  await sql(`delete from private.ai_requests where owner_id=${literal(s.uid)};`);
  const bBefore = await controlsRow(s);
  // Rollback uses the same quiescence guards as the forward switch: a live request, an unsaved ready analysis and an expired
  // request's held charge each refuse it with their own message, and nothing is written or erased to pass the guard.
  const readyB = randomUUID();
  need((await claim(s, readyB)).claimed === true);
  equal(await attempt(s, 'rollback'), REFUSALS.alive);
  equal(await controlsRow(s), bBefore);
  equal((await finish(s, readyB, facts({ colours: ['navy'] }))).stored, true);
  equal(await attempt(s, 'rollback'), REFUSALS.ready);
  equal(await controlsRow(s), bBefore);
  await expire(s, readyB);
  const heldV3 = randomUUID();
  need((await claim(s, heldV3)).claimed === true);
  await expire(s, heldV3);
  const heldV3Row = await usageRow(s, heldV3);
  equal(heldV3Row, { reserved_micro: '1', accounted_micro: '1', charge_state: 'held', closed_reason: 'EXPIRED' });
  equal(await attempt(s, 'rollback'), REFUSALS.held);
  equal(await usageRow(s, heldV3), heldV3Row);
  equal(await controlsRow(s), bBefore);
  await reconcile(s);
  equal(await attempt(s, 'forward'), REFUSALS.row);
  equal(await controlsRow(s), bBefore);
  equal(await attempt(s, 'rollback'), 'OK');
  equal(await controlsRow(s), { ...bBefore, execution_manifest_id: V2, max_request_micro: V2_RESERVATION });
  // A held charge blocks the forward switch, and nothing is erased to pass the guard.
  const heldId = randomUUID();
  need((await claim(s, heldId, V2)).claimed === true);
  await expire(s, heldId);
  const heldBefore = await usageRow(s, heldId);
  equal(heldBefore, { reserved_micro: String(V2_RESERVATION), accounted_micro: String(V2_RESERVATION), charge_state: 'held', closed_reason: 'EXPIRED' });
  equal(await attempt(s, 'forward'), REFUSALS.held);
  equal(await usageRow(s, heldId), heldBefore);
  equal((await controlsRow(s)).execution_manifest_id, V2);
  // Reconciling that charge is a separately authorised step; once it is gone the guarded forward switch succeeds.
  await reconcile(s);
  equal(await attempt(s, 'forward'), 'OK');
  equal(await controlsRow(s), { ...bBefore, execution_manifest_id: V3, max_request_micro: V3_RESERVATION });
  // The switch writes no activation, consent, notice, prompt or allowance.
  const consent = (await client.rows(s, 'profiles'))[0];
  need(consent.ai_enabled === true && consent.ai_notice_revision === 2);

  mark('switch-period');
  // The period is the UTC month of the one timestamp, whatever the session time zone: the exact expression the switch embeds is
  // evaluated at the instants around each UTC month end (the database clock itself cannot be moved).
  const instants = ['2026-10-31T23:59:59.999999Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00.000001Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z'];
  for (const zone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles']) {
    equal(await one(`set time zone ${literal(zone)}; select jsonb_agg(${CURRENT_PERIOD_SQL.replaceAll('v_now', 'x')} order by x)
      from unnest(array[${instants.map(literal).join(',')}]::timestamptz[]) x; reset time zone;`), ['2026-10', '2026-11', '2026-11', '2026-12', '2027-01']);
  }

  mark('switch-debris');
  // Only the exact debris the old anomaly kill switch left may be ignored: analysis, held, an earlier UTC month, closed, no
  // request row, and Azure v2 evidence with anomaly=true and no normalized usage. The debris is made by the REAL claim and
  // finish (a v2 reply with a contradictory control reading); only its month is moved by a fixture update. Any other
  // reserved/held row blocks, and a refusal changes nothing (controls, usage, evidence, requests, budget).
  const owner = literal(s.uid);
  const PAST = "to_char((clock_timestamp() at time zone 'UTC')-interval '1 month','YYYY-MM')";
  const FUTURE = "to_char((clock_timestamp() at time zone 'UTC')+interval '1 month','YYYY-MM')";
  const RESERVATIONS = { [V2]: V2_RESERVATION, [V3]: V3_RESERVATION };
  const onRow = (id) => `owner_id=${owner} and request_id=${literal(id)}`;
  const place = (id, period) => sql(`update private.ai_usage set period=${period} where ${onRow(id)};`);
  const stateOf = () => one(`select jsonb_build_object(
    'controls',(select to_jsonb(c) from private.ai_controls c where c.owner_id=${owner}),
    'usage',(select coalesce(jsonb_agg(to_jsonb(u) order by u.request_id),'[]'::jsonb) from private.ai_usage u where u.owner_id=${owner}),
    'evidence',(select coalesce(jsonb_agg(to_jsonb(e) order by e.request_id),'[]'::jsonb) from private.ai_usage_evidence e where e.owner_id=${owner}),
    'requests',(select coalesce(jsonb_agg(to_jsonb(r)-'facts' order by r.request_id),'[]'::jsonb) from private.ai_requests r where r.owner_id=${owner}),
    'used',private.ai_budget_used(${owner},statement_timestamp())::text);`);
  const asControls = async (manifest, work) => {
    const keep = await controlsRow(s);
    await setControls(s, manifest, RESERVATIONS[manifest], keep.monthly_allowance_micro);
    try { return await work(); } finally { await setControls(s, keep.execution_manifest_id, keep.max_request_micro, keep.monthly_allowance_micro); }
  };
  let made = [];
  const track = (id) => { made.push(id); return id; };
  const cleanup = async () => {
    if (made.length > 0) await sql(`delete from private.ai_usage where owner_id=${owner} and request_id in (${made.map(literal).join(',')});`);
    made = [];
  };
  const evidenceShape = (id) => one(`select to_jsonb(x) from (select e.manifest_id,e.anomaly,e.normalized_usage is null as no_usage,
    (select count(*) from private.ai_requests r where r.owner_id=e.owner_id and r.request_id=e.request_id) as requests
    from private.ai_usage_evidence e where e.owner_id=${owner} and e.request_id=${literal(id)}) x;`);
  // Held 4,097,351 and closed UNAVAILABLE by the real finish; evidence anomaly=true, no usage, no request row.
  const anomalyHold = (manifest = V2) => asControls(manifest, async () => {
    const id = track(randomUUID());
    need((await claim(s, id, manifest)).claimed === true);
    equal((await finish(s, id, facts({ colours: ['navy'] }), manifest, { ...USAGE, controlObservation: 'contradictory' })).code, 'USAGE_ANOMALY');
    equal(await usageRow(s, id), { reserved_micro: String(RESERVATIONS[manifest]), accounted_micro: String(RESERVATIONS[manifest]),
      charge_state: 'held', closed_reason: 'UNAVAILABLE' });
    equal(await evidenceShape(id), { manifest_id: manifest, anomaly: true, no_usage: true, requests: 0 });
    return id;
  });
  // An ordinary expired v2 hold: closed EXPIRED, held, evidence not anomalous; a late finish could still settle it.
  const ordinaryHold = () => asControls(V2, async () => {
    const id = track(randomUUID());
    need((await claim(s, id, V2)).claimed === true);
    await expire(s, id);
    equal(await usageRow(s, id), { reserved_micro: String(V2_RESERVATION), accounted_micro: String(V2_RESERVATION), charge_state: 'held', closed_reason: 'EXPIRED' });
    return id;
  });
  const refuses = async (direction, message, zone) => {
    const unchanged = await stateOf();
    equal(await attempt(s, direction, zone), message);
    equal(await stateOf(), unchanged);
  };
  const lateFinish = async (id, usage) => {
    const unchanged = await stateOf();
    const late = await finish(s, id, facts({ colours: ['navy'] }), V2, usage);
    equal([late.code, late.stored], ['USAGE_CONFLICT', false]);
    equal(await stateOf(), unchanged);
  };
  const withoutControlWrites = (state) => ({ ...state, controls: { ...state.controls, execution_manifest_id: null, max_request_micro: null, updated_at: null } });
  equal(await scalar(`select count(*) from private.ai_usage where owner_id=${owner} and charge_state in ('reserved','held');`), '0');
  await sql(`delete from private.ai_requests where owner_id=${owner};`);

  // Each of these keeps blocking the controls at v3 (rollback), in a non-UTC session time zone.
  const ZONE = 'Pacific/Kiritimati';
  let id = await anomalyHold();
  await refuses('rollback', REFUSALS.held, ZONE); // the current UTC month
  await place(id, FUTURE);
  await refuses('rollback', REFUSALS.held, ZONE); // a future month
  await place(id, PAST);
  await sql(`update private.ai_usage set closed_reason=null,closed_at=null where ${onRow(id)};`);
  await refuses('rollback', REFUSALS.held, ZONE); // unclosed
  await cleanup();

  await asControls(V2, async () => {
    const present = track(randomUUID());
    need((await claim(s, present, V2)).claimed === true);
    await sql(`update private.ai_usage_evidence set anomaly=true where ${onRow(present)};
      update private.ai_usage set period=${PAST},closed_reason='EXPIRED',closed_at=clock_timestamp() where ${onRow(present)};
      update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where ${onRow(present)};`);
    equal(await evidenceShape(present), { manifest_id: V2, anomaly: true, no_usage: true, requests: 1 });
    return present;
  });
  await refuses('rollback', REFUSALS.held); // closed and anomalous, but the request row is still present
  await cleanup();

  id = await ordinaryHold();
  await place(id, PAST);
  await refuses('rollback', REFUSALS.held); // an ordinary expired hold of an earlier month
  const heldTotal = await used(s);
  // A late finish settles such a hold into a lower estimate: it is not inert, which is why it must keep blocking.
  const settled = await finish(s, id, facts({ colours: ['navy'] }), V2);
  equal(settled.code, 'TERMINAL');
  equal(await usageRow(s, id), { reserved_micro: String(V2_RESERVATION), accounted_micro: String(ESTIMATE), charge_state: 'estimated', closed_reason: 'EXPIRED' });
  need((await used(s)) < heldTotal);
  await cleanup();

  id = await anomalyHold(V3);
  await place(id, PAST);
  await refuses('rollback', REFUSALS.held); // v3 evidence is not the Azure v2 shape
  await cleanup();

  id = await anomalyHold();
  await place(id, PAST);
  await sql(`update private.ai_usage set purpose='stylist' where ${onRow(id)};`);
  await refuses('rollback', REFUSALS.held); // another purpose
  await cleanup();

  id = await anomalyHold();
  await place(id, PAST);
  await sql(`update private.ai_usage_evidence set normalized_usage='{"input":1}'::jsonb,estimated_micro=1 where ${onRow(id)};`);
  await refuses('rollback', REFUSALS.held); // evidence with recorded usage
  await cleanup();

  id = await anomalyHold();
  await place(id, PAST);
  await sql(`delete from private.ai_usage_evidence where ${onRow(id)};`);
  await refuses('rollback', REFUSALS.held); // no evidence at all
  await cleanup();

  id = track(randomUUID());
  await sql(`insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,closed_reason,closed_at)
    values(${owner},${literal(id)},${PAST},clock_timestamp()-interval '40 days',1,1,'reserved','EXPIRED',clock_timestamp());`);
  await refuses('rollback', REFUSALS.held); // a reserved row is never ignored
  await cleanup();

  id = await anomalyHold();
  await place(id, PAST);
  const ordinary = await ordinaryHold();
  await place(ordinary, PAST);
  await refuses('rollback', REFUSALS.held); // one ineligible hold blocks all of them
  await cleanup();

  id = track(randomUUID());
  need((await claim(s, id, V3)).claimed === true);
  await place(id, PAST);
  await refuses('rollback', REFUSALS.alive); // a live request still refuses first
  await cleanup();

  // The eligible debris alone is ignored, in both directions, and the row is left as it was.
  id = await anomalyHold();
  await place(id, PAST);
  let preSwitch = await stateOf();
  equal(await attempt(s, 'rollback', ZONE), 'OK');
  let postSwitch = await stateOf();
  equal(withoutControlWrites(postSwitch), withoutControlWrites(preSwitch));
  equal([postSwitch.controls.execution_manifest_id, postSwitch.controls.max_request_micro], [V2, V2_RESERVATION]);
  equal(postSwitch.used, preSwitch.used);
  // A late finish of that old row, even an anomalous one, stops at USAGE_CONFLICT and changes and switches off nothing.
  await lateFinish(id, { ...USAGE, controlObservation: 'contradictory' });
  await lateFinish(id, USAGE);
  equal((await controlsRow(s)).activated, true);

  // Forward (controls now v2): the same mixed refusal, then the hosted-shaped row alone.
  const extra = await ordinaryHold();
  await place(extra, PAST);
  await refuses('forward', REFUSALS.held, 'Pacific/Pago_Pago');
  await sql(`delete from private.ai_usage where ${onRow(extra)};`);
  preSwitch = await stateOf();
  equal(await attempt(s, 'forward', 'Pacific/Pago_Pago'), 'OK');
  postSwitch = await stateOf();
  equal(withoutControlWrites(postSwitch), withoutControlWrites(preSwitch));
  equal([postSwitch.controls.execution_manifest_id, postSwitch.controls.max_request_micro, postSwitch.controls.activated], [V3, V3_RESERVATION, true]);
  equal(postSwitch.used, preSwitch.used);
  await lateFinish(id, { ...USAGE, controlObservation: 'contradictory' });
  await cleanup();
  equal(await controlsRow(s), { ...bBefore, execution_manifest_id: V3, max_request_micro: V3_RESERVATION });

  mark('ceiling');
  // Earlier stages may have left an admin row (the admin is a singleton); it is fixture state and is replaced for this check.
  await sql('delete from private.app_admins;');
  await sql(`insert into private.app_admins(owner_id,admission_no,admission_generation)
    select user_id,admission_no,generation from private.approved_accounts where user_id=${literal(a.uid)};`);
  try {
    const target = await one(`select jsonb_build_object('no',admission_no,'generation',generation::text)
      from private.approved_accounts where user_id=${literal(b.uid)};`);
    const version = createHash('sha256').update(`${target.no}:${target.generation}`).digest('hex');
    const amount = (micro) => ({ monthlyAllowanceMicro: String(micro) });
    const write = (expected, limits) => client.rpc(a, 'admin_set_ai_limits_v2', { p_admission_no: target.no,
      p_account_version: version, p_expected: expected, p_limits: limits, p_reason_code: null });
    const current = amount(await scalar(`select monthly_allowance_micro::text from private.ai_controls where owner_id=${literal(b.uid)};`));
    equal(await write(current, amount(CEILING + 1)), { code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'APP_LIMIT' });
    equal((await write(current, amount(CEILING))).code, 'OK');
    equal(await scalar(`select monthly_allowance_micro::text from private.ai_controls where owner_id=${literal(b.uid)};`), String(CEILING));
    equal(await write(amount(CEILING), amount(CEILING + 1)), { code: 'INVALID_LIMITS', field: 'monthlyAllowanceMicro', reason: 'APP_LIMIT' });
    equal((await write(amount(CEILING), amount(50_000_001))).code, 'OK');
    equal((await write(amount(50_000_001), amount(0))).reason, 'NOT_POSITIVE');
  } finally {
    await sql('delete from private.app_admins;');
  }
}
