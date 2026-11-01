import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisFacts, analysisHash, analysisUsage } from './ai-analysis.sessions.mjs';
import { analyzedHarness, analyzedIntent } from './analyzed-save.sessions.mjs';
import { imageChangeHarness } from './image-replacement.sessions.mjs';
import { manifestExpired } from './synthetic-analysis.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

// AVAIL1: catalog proof after 20261101080000. The nine replaced bodies equal the migration source byte for byte, and only
// the legacy Google term in the analysis permission still reads a review date. The historical stages keep their own
// expiry-dependent behaviour; this stage never changes a clock, a manifest row or a trigger.
const MIGRATION = '20261101080000_persistent_ai_availability.sql';
const FUNCTIONS = Object.freeze(['public.ai_claim_analysis', 'private.ai_analysis_permitted',
  'private.reserve_analyzed_item_save_v10', 'private.reserve_image_change', 'public.stylist_claim', 'public.enhance_claim',
  'private.tryon_permission', 'private.tryon_probe_permission', 'public.tryon_claim']);

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

function sourceBody(sql, name) {
  const header = `create or replace function ${name}(`, start = sql.indexOf(header);
  requireEvidence(start >= 0 && sql.indexOf(header, start + header.length) === -1);
  const open = sql.indexOf(' as $$\n', start), close = sql.indexOf('\n$$;', open);
  requireEvidence(open > start && close > open);
  const body = sql.slice(open + ' as $$'.length, close + 1);
  requireEvidence(!body.includes('$$'));
  return body;
}

export async function availabilityCatalogProbe(sql, mark = () => {}) {
  const source = await readFile(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  requireEvidence(!source.includes('\r'));
  const state = JSON.parse(await sql(`select jsonb_object_agg(f.name,(select coalesce(jsonb_agg(jsonb_build_object(
      'md5',md5(p.prosrc),'dates',(length(p.prosrc)-length(replace(p.prosrc,'review_expires_at','')))/length('review_expires_at'),
      'definer',p.prosecdef,'config',coalesce(p.proconfig,'{}'::text[]))),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=f.name))
    from (values ${FUNCTIONS.map((name) => `(${literal(name)})`).join(',')}) as f(name);`));
  // Failure labels go through mark (the stage name is the only detail the rehearsal prints).
  const label = (name, check) => mark(`catalog-${name.replace(/[^a-z0-9_]+/gi, '-')}-${check}`);
  for (const name of FUNCTIONS) {
    label(name, 'one-definition');
    requireEvidence(Array.isArray(state[name]) && state[name].length === 1);
    label(name, 'body-md5');
    equal(state[name][0].md5, createHash('md5').update(sourceBody(source, name)).digest('hex'));
    label(name, 'review-date-reads');
    equal(state[name][0].dates, name === 'private.ai_analysis_permitted' ? 1 : 0);
    label(name, 'search-path');
    // proconfig holds entries such as search_path=", so match the entry, not the bare key.
    requireEvidence(state[name][0].config.some((entry) => entry.startsWith('search_path=')));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// AVAIL1 behaviour. A populated avail-prior state is checkpointed, only the availability migration is applied, and the
// checkpoint is compared BEFORE any probe writes. The probes then run the real functions (never the synthetic fixtures)
// after the manifests' review dates: the lifecycle succeeds, and consent, activation, configuration, allowance, provider
// availability and request lifetime still refuse. No clock, manifest row or trigger is touched; no provider is called.
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const TABLES = [['private', 'ai_controls'], ['private', 'ai_usage'], ['private', 'ai_requests'], ['private', 'ai_usage_evidence'],
  ['private', 'ai_analysis_attestations'], ['private', 'ai_save_used_receipts'], ['private', 'ai_item_save_attempts'],
  ['private', 'item_save_attempts'], ['private', 'item_save_used_ids'], ['private', 'item_attribution_history'],
  ['private', 'image_change_attempts'], ['public', 'items'], ['public', 'item_images'], ['public', 'profiles']];
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

export async function availabilityCheckpoint(sql) {
  const state = JSON.parse(await sql(checkpointSql));
  requireEvidence(Object.keys(state.functions).length > 100 && state.manifests.length >= 8 && state.triggers.length > 0);
  for (const name of FUNCTIONS) {
    requireEvidence(Object.entries(state.functions).some(([key, value]) => key.startsWith(`${name}(`) && value.body === null));
  }
  requireEvidence(Object.values(state.rows).every((entry) => Array.isArray(entry) && entry.length === 2));
  requireEvidence(state.rows['public.items'][0] > 0 && state.rows['private.ai_usage'][0] > 0 && state.objects[0] > 0);
  return state;
}

// Read-only: the migration changed the nine bodies and nothing else (owner, ACL, security config, volatility, every other
// body, manifests, triggers, rows, object bytes).
export async function availabilityCompare(before, sql, mark = () => {}) {
  const after = JSON.parse(await sql(checkpointSql));
  const clean = (text) => String(text).replace(/[^a-z0-9_]+/gi, '-').slice(0, 80);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const section of ['manifests', 'triggers', 'objects']) {
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
  equal(after, before);
}

const STYLIST = 'azure-eu-terra-stylist-v2', CLEANUP = 'azure-global-image25-sunburst-cleanup-v1';
const V1 = 'azure-eu-terra-devtest-v1', V2 = 'azure-eu-terra-devtest-v2';
const STYLIST_RESERVE = 129360, CLEANUP_RESERVE = 300000;
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', controlObservation: 'ordinary', input: 1000, output: 200,
  total: 1200, reasoning: 50, cacheRead: 0, cacheWrite: 0 });

export async function availabilityBehaviourProbes(snapshot, sql, mark) {
  const { client, owners: [a, b], env } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const used = async (owner) => BigInt(await scalar(`select private.ai_budget_used(${literal(owner.uid)},clock_timestamp());`));
  const setControls = (owner, manifest, prompt) => sql(`insert into private.ai_controls(owner_id,activated,notice_revision,model_id,
    prompt_version,max_request_micro,monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds,execution_manifest_id)
    values(${literal(owner.uid)},true,2,'gpt-5.6-terra-2026-07-09',${prompt},4097351,100000000,200,3600,${literal(manifest)})
    on conflict (owner_id) do update set activated=true,notice_revision=2,model_id=excluded.model_id,
      prompt_version=excluded.prompt_version,max_request_micro=excluded.max_request_micro,
      monthly_allowance_micro=excluded.monthly_allowance_micro,max_requests_per_hour=excluded.max_requests_per_hour,
      result_ttl_seconds=excluded.result_ttl_seconds,execution_manifest_id=excluded.execution_manifest_id;`);
  const aiConsent = async (owner, enabled) => {
    const profile = (await client.rows(owner, 'profiles'))[0];
    return client.rpc(owner, 'ai_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? 2 : null, p_expected_version: profile.version });
  };
  const claim = (owner, id, manifest = V2) => one(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
    ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(manifest)});`);
  const finish = (owner, id, facts, manifest = V2) => one(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},
    ${literal(manifest)},${json(facts)},${json(analysisUsage)},'SUCCESS');`);
  const facts = (fields) => ({ ...analysisFacts, fields: { ...analysisFacts.fields, ...fields } });
  const completed = async (ich, value) => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await ich.endpoint(value);
      if (result.status === 204) return;
      equal(result, { status: 409, data: { code: 'CONFLICT' } });
      await new Promise((resolve) => { setTimeout(resolve, 50 * attempt); });
    }
    requireEvidence(false);
  };

  mark('past-date');
  // Photo analysis is configured on the Azure v2 manifest whose recorded date has passed; nothing here moves the clock.
  requireEvidence(await manifestExpired(sql, V1) && await manifestExpired(sql, V2));

  mark('analysis-lifecycle');
  await setControls(a, V2, 2);
  equal((await aiConsent(a, true)).code, 'OK');
  const h = analyzedHarness(client, a, env), request = randomUUID();
  const first = await claim(a, request);
  requireEvidence(first.claimed === true && first.manifestId === V2);
  equal((await finish(a, request, facts({ colours: ['navy'] }))).stored, true);
  const value = analyzedIntent(a, 21);
  value.p_item.id = randomUUID(); value.p_image.id = randomUUID(); value.p_item.colours = ['navy'];
  value.p_claim = { ...value.p_claim, requestId: request, draftId: request,
    fields: { ...value.p_claim.fields, colours: { kind: 'ai_observed', value: ['navy'] } } };
  const row = await h.reserve(value);
  await h.upload(value);
  await h.finalize(value, row);
  let history = await client.rpc(a, 'item_attribution_history', { p_item_id: value.p_item.id });
  requireEvidence(history.length === 1 && history[0].prompt_version === 2);
  equal(history[0].fields.colours, { kind: 'ai_observed', revision: 1 });

  mark('image-replacement');
  const replacementRequest = randomUUID();
  requireEvidence((await claim(a, replacementRequest)).claimed === true);
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
  requireEvidence(history.length === 2 && history[1].source_image_id === replacement.imageId);
  equal(history[1].fields, { pattern: { kind: 'ai_observed', revision: 1 } });

  mark('analysis-refusals');
  const idle = () => randomUUID();
  // The configuration check, which used to come second to the date, is now reached: a wrong manifest is CONFIG_CHANGED.
  equal(await claim(a, idle(), V1), { code: 'CONFIG_CHANGED', claimed: false });
  equal((await aiConsent(a, false)).code, 'OK');
  equal(await claim(a, idle()), { code: 'CONSENT_REQUIRED', claimed: false });
  equal((await aiConsent(a, true)).code, 'OK');
  await sql(`update private.ai_controls set activated=false where owner_id=${literal(a.uid)};`);
  equal(await claim(a, idle()), { code: 'INACTIVE', claimed: false });
  await sql(`update private.ai_controls set activated=true where owner_id=${literal(a.uid)};`);
  await sql(`update private.ai_controls set monthly_allowance_micro=${await used(a) + 1n} where owner_id=${literal(a.uid)};`);
  equal(await claim(a, idle()), { code: 'ALLOWANCE', claimed: false });
  await sql(`update private.ai_controls set monthly_allowance_micro=100000000 where owner_id=${literal(a.uid)};`);
  // A request past its own lifetime is refused at Save, as before; this is an operational lifetime, not a review date.
  const stale = randomUUID();
  requireEvidence((await claim(a, stale)).claimed === true);
  equal((await finish(a, stale, facts({ colours: ['navy'] }))).stored, true);
  await sql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
    where owner_id=${literal(a.uid)} and request_id=${literal(stale)};`);
  const refused = analyzedIntent(a, 21);
  refused.p_item.id = randomUUID(); refused.p_image.id = randomUUID(); refused.p_item.colours = ['navy'];
  refused.p_claim = { ...refused.p_claim, requestId: stale, draftId: stale,
    fields: { ...refused.p_claim.fields, colours: { kind: 'ai_observed', value: ['navy'] } } };
  const saved = await h.call('reserve_analyzed_item_save', refused);
  requireEvidence(saved.ok && saved.data.length === 1 && saved.data[0].state === 'analysis_unavailable');
  mark('no-hourly-limit');
  // The retired hourly column no longer limits anything: with it at 1, several ordinary claims in a row are all admitted.
  await sql(`update private.ai_controls set max_requests_per_hour=1 where owner_id=${literal(a.uid)};`);
  for (let n = 0; n < 3; n++) requireEvidence((await claim(a, idle())).claimed === true);

  mark('stylist-and-cleanup');
  // A failing check puts the actual reply in the stage label, which is the only detail the rehearsal prints.
  const brief = (value) => JSON.stringify(value ?? null).replace(/[^A-Za-z0-9_.:,-]+/g, '').slice(0, 110);
  const expectThat = (label, actual, ok) => {
    if (!ok) mark(`${label}-got-${brief(actual)}`);
    requireEvidence(ok);
    return actual;
  };
  const expectEqual = (label, actual, expected) => expectThat(label, actual, JSON.stringify(actual) === JSON.stringify(expected));
  // BUSY is lock contention with a background finalizer, not a refusal: retry it, never any other reply.
  const unbusy = async (call) => {
    let reply = await call();
    for (let attempt = 1; reply?.code === 'BUSY' && attempt <= 10; attempt++) {
      await new Promise((resolve) => { setTimeout(resolve, 100 * attempt); });
      reply = await call();
    }
    return reply;
  };
  await setControls(b, V2, 2);
  await sql(`update private.ai_controls set stylist_activated=true,stylist_notice_revision=1,stylist_manifest_id=${literal(STYLIST)},
    stylist_max_request_micro=${STYLIST_RESERVE},stylist_max_requests_per_hour=1,enhance_activated=true,enhance_notice_revision=2,
    enhance_manifest_id=${literal(CLEANUP)},enhance_max_request_micro=${CLEANUP_RESERVE},enhance_max_requests_per_hour=1,
    max_requests_per_hour=1,updated_at=clock_timestamp() where owner_id=${literal(b.uid)};`);
  expectEqual('b-ai-consent', (await aiConsent(b, true)).code, 'OK');
  const consented = (reply) => reply?.consent?.enabled === true;
  const stylistOn = await client.rpc(b, 'stylist_set_consent', { p_enabled: true, p_notice_revision: 1 });
  expectThat('stylist-consent', stylistOn, consented(stylistOn));
  const cleanupOn = await client.rpc(b, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 2 });
  expectThat('cleanup-consent', cleanupOn, consented(cleanupOn));
  await imageChangeHarness(client, b, env).create();
  const stylistClaim = (id = randomUUID()) => one(`select public.stylist_claim(${literal(b.uid)},${literal(id)},${literal(STYLIST)});`);
  const stylistFinish = (id, code, usage) => one(`select public.stylist_finish(${literal(b.uid)},${literal(id)},${literal(code)},
    ${usage === null ? 'null::jsonb' : json(usage)});`);
  const styId = randomUUID();
  const stylistFirst = await unbusy(() => stylistClaim(styId));
  expectThat('stylist-claim', stylistFirst, stylistFirst?.claimed === true);
  expectEqual('stylist-finish-ok', (await stylistFinish(styId, 'OK', VALID)).code, 'OK');
  for (let n = 0; n < 2; n++) {
    const id = randomUUID();
    const reply = await unbusy(() => stylistClaim(id));
    expectThat('stylist-claim-loop', reply, reply?.claimed === true);
    expectEqual('stylist-finish-not-dispatched', (await stylistFinish(id, 'NOT_DISPATCHED', null)).code, 'NOT_DISPATCHED');
  }
  const stylistConsent = (enabled) => client.rpc(b, 'stylist_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? 1 : null });
  await stylistConsent(false);
  const withdrawn = await stylistClaim();
  expectThat('stylist-consent-off', withdrawn, withdrawn.claimed === false && withdrawn.code === 'CONSENT_REQUIRED');
  await stylistConsent(true);
  await sql(`update private.ai_controls set monthly_allowance_micro=${await used(b) + BigInt(STYLIST_RESERVE) - 1n} where owner_id=${literal(b.uid)};`);
  expectEqual('stylist-allowance', await unbusy(() => stylistClaim()), { code: 'ALLOWANCE', claimed: false });
  await sql(`update private.ai_controls set monthly_allowance_micro=100000000 where owner_id=${literal(b.uid)};`);

  const key = await scalar(`select deployment_key from private.provider_deployments where manifest_id=${literal(CLEANUP)};`);
  expectThat('cleanup-deployment', key, key !== '');
  expectEqual('cleanup-provider-on', await one(`select public.enhance_provider_control(${literal(key)},true,null::text);`),
    { code: 'OK', dispatchEnabled: true });
  await sql(`update private.provider_capacity set max_dispatch=1,updated_at=clock_timestamp() where deployment_key=${literal(key)};
    update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
      where deployment_key=${literal(key)} and held_until>clock_timestamp();`);
  const input = createHash('sha256').update(randomUUID()).digest('hex');
  const cleanupClaim = (id = randomUUID()) => one(`select public.enhance_claim(${literal(b.uid)},${literal(id)},${literal(CLEANUP)},
    ${literal(input)},null::uuid);`);
  const cleanupId = randomUUID();
  const cleanup = await unbusy(() => cleanupClaim(cleanupId));
  expectThat('cleanup-claim', cleanup, cleanup?.claimed === true);
  expectEqual('cleanup-finish', (await one(`select public.enhance_finish(${literal(b.uid)},${literal(cleanupId)},'NOT_DISPATCHED',
    null::jsonb,null::text,null::integer);`)).code, 'NOT_DISPATCHED');
  const disabled = await one(`select public.enhance_provider_control(${literal(key)},false,null::text);`);
  expectThat('cleanup-provider-off', disabled, disabled.code === 'OK' && disabled.dispatchEnabled === false);
  const refusedCleanup = await cleanupClaim();
  expectThat('cleanup-provider-off-claim', refusedCleanup, refusedCleanup.claimed === false);
  await one(`select public.enhance_provider_control(${literal(key)},true,null::text);`);
}