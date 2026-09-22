import { createHash } from 'node:crypto';
import { normalClient, requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisId, analysisHash, analysisFacts, analysisUsage } from './ai-analysis.sessions.mjs';
import { analyzedHarness, analyzedIntent } from './analyzed-save.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { imageChangeHarness } from './image-replacement.sessions.mjs';

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

export async function verifyAzurePreservation(snapshot, sql, retainForImageChanges = false) {
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
    if (retainForImageChanges) continue;
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
  if (!retainForImageChanges) {
    const restored = await db(stateSql);
    requireEvidence(tables.every((name) => restored[name].length === 0));
  }
}

async function imageChangePreservationState(snapshot, sql) {
  const library = [];
  for (const owner of snapshot.owners) {
    const items = await snapshot.client.rows(owner, 'items'), images = await snapshot.client.rows(owner, 'item_images');
    const histories = [], bytes = [];
    for (const item of items) histories.push(await snapshot.client.rpc(owner, 'item_attribution_history', { p_item_id: item.id }));
    for (const image of images) for (const variant of ['main', 'thumb']) {
      const result = await snapshot.client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${image[`${variant}_path`]}`);
      requireEvidence(result.ok && Buffer.isBuffer(result.data));
      bytes.push(createHash('sha256').update(result.data).digest('hex'));
    }
    library.push({ profile: await snapshot.client.rows(owner, 'profiles'), items, images, histories, bytes });
  }
  return { private: JSON.parse(await sql(stateSql)), library };
}
export async function captureImageChangePreservation(snapshot, sql) {
  const { client, owners, env } = snapshot;
  for (const owner of owners) {
    await sql(`update private.ai_controls set activated=true,notice_revision=2,model_id='gpt-5.6-terra-2026-07-09',
      prompt_version=1,max_request_micro=4097351,execution_manifest_id='azure-eu-terra-devtest-v1'
      where owner_id=${literal(owner.uid)};`);
    const profile = (await client.rows(owner, 'profiles'))[0];
    equal(await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: 2, p_expected_version: profile.version }),
      { code: 'OK', profileVersion: String(profile.version + 1) });
    const h = analyzedHarness(client, owner, env);
    for (const n of [23, 24]) {
      const id = analysisId(owner.label, n);
      const claim = JSON.parse(await sql(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
        ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,'azure-eu-terra-devtest-v1');`));
      requireEvidence(claim.claimed === true);
      const finish = JSON.parse(await sql(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},'azure-eu-terra-devtest-v1',
        ${json(analysisFacts)},${json(analysisUsage)},'SUCCESS');`));
      requireEvidence(finish.stored === true);
      const value = analyzedIntent(owner, n), row = await h.reserve(value);
      await h.upload(value);
      if (n === 23) await h.finalize(value, row);
    }
  }
  const before = await imageChangePreservationState(snapshot, sql);
  requireEvidence(before.private.ai_item_save_attempts.length === 8 && before.private.item_attribution_history.length === 6);
  return { ...snapshot, imageChangeBefore: before };
}
export async function verifyImageChangePreservation(snapshot, sql) {
  equal(await imageChangePreservationState(snapshot, sql), snapshot.imageChangeBefore);
  const { client, owners, env } = snapshot;
  await imageChangeStructure(sql);
  const empty = JSON.parse(await sql(`select jsonb_build_object(
    'attempts',(select count(*) from private.image_change_attempts),'context',(select count(*) from private.image_change_context),
    'history',(select count(*) from private.image_change_history),'operations',(select count(*) from private.item_deletion_operations),
    'targets',(select count(*) from private.item_deletion_targets));`));
  requireEvidence(Object.keys(empty).length === 5 && Object.values(empty).every((value) => value === 0));
  for (const owner of owners) {
    const h = analyzedHarness(client, owner, env), profile = (await client.rows(owner, 'profiles'))[0];
    equal(await client.rpc(owner, 'ai_set_consent', { p_enabled: false, p_notice_revision: null, p_expected_version: profile.version }),
      { code: 'OK', profileVersion: String(profile.version + 1) });
    await sql(`update private.ai_controls set activated=false where owner_id=${literal(owner.uid)};
      update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
        where owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, 24))};`);
    for (const n of [21, 22, 23, 24]) {
      const value = analyzedIntent(owner, n), row = await h.reserve(value);
      await h.finalize(value, row);
      equal((await h.reserve(value)).state, 'completed');
      let history = await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id });
      requireEvidence(history.length === 1);
      equal(Object.keys(history[0]).sort(), ['fields', 'image_sha256', 'model_id', 'prompt_version', 'source_image_id']);
      equal(history[0].model_id, n < 23 ? 'gemini-3.8-flash' : 'gpt-5.6-terra-2026-07-09');
      let replacement, replacementHarness, recovery;
      if (n === 24) {
        await sql(`update private.ai_controls set activated=true where owner_id=${literal(owner.uid)};`);
        const p = (await client.rows(owner, 'profiles'))[0];
        equal(await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: 2, p_expected_version: p.version }),
          { code: 'OK', profileVersion: String(p.version + 1) });
        const id = analysisId(owner.label, 25);
        requireEvidence(JSON.parse(await sql(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
          ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,'azure-eu-terra-devtest-v1');`)).claimed === true);
        const facts = { ...analysisFacts, fields: { ...analysisFacts.fields, pattern: 'solid' } };
        requireEvidence(JSON.parse(await sql(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},'azure-eu-terra-devtest-v1',
          ${json(facts)},${json(analysisUsage)},'SUCCESS');`)).stored === true);
        replacementHarness = imageChangeHarness(client, owner, env);
        replacement = replacementHarness.make((await h.read('items', value.p_item.id))[0], (await h.read('item_images', value.p_image.id))[0]);
        replacement.item.pattern = 'solid'; replacement.item.field_provenance.pattern = { kind: 'ai_observed', revision: 1 };
        replacement.claim = { requestId: id, draftId: id, generation: 1, imageSha256: analysisHash,
          fields: { pattern: { kind: 'ai_observed', value: 'solid' } } };
        await replacementHarness.reserve(replacement); await replacementHarness.upload(replacement);
        equal(await replacementHarness.endpoint(replacement), { status: 204 });
        const forgedAdd = analyzedIntent(owner, 25);
        const reused = await h.call('reserve_analyzed_item_save', forgedAdd);
        requireEvidence(!reused.ok && reused.status === 400 && reused.data.message === 'Request conflict');
        history = await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id });
        requireEvidence(history.length === 2 && history[0].source_image_id === value.p_image.id
          && history[1].source_image_id === replacement.imageId);
        equal(history[1].fields, { pattern: { kind: 'ai_observed', revision: 1 } });
        for (const record of history) equal(Object.keys(record).sort(), ['fields', 'image_sha256', 'model_id', 'prompt_version', 'source_image_id']);
        const oldImage = (await h.read('item_images', value.p_image.id))[0];
        recovery = replacementHarness.make((await h.read('items', value.p_item.id))[0],
          (await h.read('item_images', replacement.imageId))[0], oldImage);
        for (const age of ["clock_timestamp()+interval '1 minute'", "clock_timestamp()-interval '7 days 1 minute'"]) {
          await sql(`update public.item_images set retired_at=${age}
            where owner_id=${literal(owner.uid)} and item_id=${literal(value.p_item.id)} and id=${literal(oldImage.id)} and state='retired';`);
          equal(await replacementHarness.endpoint(recovery, 'accept-recovery'), { status: 409, data: { code: 'CONFLICT' } });
          equal(await replacementHarness.status(recovery), null);
        }
        await sql(`update public.item_images set retired_at=clock_timestamp()-interval '6 days 23 hours 59 minutes'
          where owner_id=${literal(owner.uid)} and item_id=${literal(value.p_item.id)} and id=${literal(oldImage.id)} and state='retired';`);
        const accepted = await replacementHarness.endpoint(recovery, 'accept-recovery');
        requireEvidence(accepted.status === 200 && accepted.data.kind === 'recovery' && accepted.data.state === 'reserved');
        await sql(`update public.item_images set retired_at=clock_timestamp()-interval '7 days 1 minute'
          where owner_id=${literal(owner.uid)} and item_id=${literal(value.p_item.id)} and id=${literal(oldImage.id)} and state='retired';`);
        equal(await replacementHarness.endpoint(recovery, 'accept-recovery'), accepted);
        await replacementHarness.upload(recovery);
        equal(await replacementHarness.endpoint(recovery), { status: 204 });
        equal(await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id }), history);
        const addConsumed = replacementHarness.make((await h.read('items', value.p_item.id))[0],
          (await h.read('item_images', recovery.imageId))[0]);
        addConsumed.claim = { requestId: analysisId(owner.label, 24), draftId: analysisId(owner.label, 24),
          generation: 1, imageSha256: analysisHash, fields: {} };
        const reusedReplacement = await h.call('reserve_image_change', { p_intent: addConsumed });
        requireEvidence(!reusedReplacement.ok && reusedReplacement.status === 400 && reusedReplacement.data.message === 'Request conflict');
      }
      // Structural probe only: both actual tables, both public arms, DDL rolled back.
      const probe = await sql(`begin;
        set local statement_timeout='10s'; set local lock_timeout='2s';
        do $identity$ begin perform set_config('request.jwt.claim.sub',${literal(owner.uid)},true); end $identity$;
        do $probe$ declare before jsonb; after jsonb;
        begin
          before := public.item_attribution_history(${literal(value.p_item.id)});
          alter table private.item_attribution_history add column i10b_probe text default 'not-public';
          alter table private.image_change_history add column i10b_probe text default 'not-public';
          after := public.item_attribution_history(${literal(value.p_item.id)});
          if after is distinct from before then raise exception 'I10B_PROJECTION'; end if;
        end $probe$;
        rollback;
        select 'I10B_PROJECTION_OK';`);
      requireEvidence(probe === 'I10B_PROJECTION_OK');
      equal(await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id }), history);
      if (n === 24) await imageChangeContextProbe(owner, value.p_item.id, sql);
      if (replacement) {
        await replacementHarness.remove(recovery);
        await replacementHarness.remove(replacement);
        await client.rpc(owner, 'forget_image', { p_image_id: replacement.imageId });
        const unlinked = await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id });
        equal(unlinked, [history[0], { ...history[1], source_image_id: null }]);
      }
      await h.remove(value); await h.deleteItem(value);
    }
    const itemIds = [21, 22, 23, 24].map((n) => analyzedIntent(owner, n).p_item.id);
    const settledProfile = (await client.rows(owner, 'profiles'))[0];
    equal(await client.rpc(owner, 'ai_set_consent', {
      p_enabled: false, p_notice_revision: null, p_expected_version: settledProfile.version,
    }), { code: 'OK', profileVersion: String(settledProfile.version + 1) });
    await sql(`delete from private.ai_usage where owner_id=${literal(owner.uid)} and request_id in
        (${[1, 2, 3, 4, 21, 22, 23, 24, 25].map((n) => literal(analysisId(owner.label, n))).join(',')});
      delete from private.ai_save_used_receipts where owner_id=${literal(owner.uid)} and item_id in (${itemIds.map(literal).join(',')});
      delete from private.item_save_used_ids where owner_id=${literal(owner.uid)} and item_id in (${itemIds.map(literal).join(',')});
      delete from private.ai_controls where owner_id=${literal(owner.uid)};`);
    requireEvidence((await client.rows(owner, 'items')).length === 0 && (await client.rows(owner, 'item_images')).length === 0);
  }
  const restored = JSON.parse(await sql(stateSql));
  requireEvidence(tables.every((name) => restored[name].length === 0));
}

async function imageChangeStructure(sql) {
  const result = JSON.parse(await sql(`select jsonb_build_object(
    'five_private_tables',(select count(*)=5 and bool_and(c.relrowsecurity
      and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE'))
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
      and c.relname in ('image_change_attempts','image_change_context','image_change_history','item_deletion_operations','item_deletion_targets')),
    'auth_lifetime',(select count(*)=2 from pg_constraint where contype='f' and confrelid='auth.users'::regclass
      and conrelid in ('private.image_change_attempts'::regclass,'private.item_deletion_operations'::regclass) and confdeltype='c'),
    'no_profile_item_cascade',not exists(select 1 from pg_constraint where contype='f'
      and conrelid in ('private.image_change_attempts'::regclass,'private.item_deletion_operations'::regclass)
      and confrelid in ('public.items'::regclass,'public.profiles'::regclass)),
    'source_only_set_null',exists(select 1 from pg_constraint where contype='f'
      and conrelid='private.image_change_history'::regclass and confrelid='public.item_images'::regclass
      and confdeltype='n' and confdelsetcols=array[(select attnum from pg_attribute
        where attrelid='private.image_change_history'::regclass and attname='source_image_id')]),
    'one_shot_private',not has_function_privilege('authenticated',
      'private.consume_image_change_context(uuid,uuid,uuid,text,bigint,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('service_role','private.consume_image_change_context(uuid,uuid,uuid,text,bigint,jsonb,jsonb)','EXECUTE'),
    'service_completion_only',has_function_privilege('service_role','public.complete_image_change(uuid,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('authenticated','public.complete_image_change(uuid,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('anon','public.complete_image_change(uuid,jsonb,jsonb)','EXECUTE'),
    'service_recovery_only',has_function_privilege('service_role','public.reserve_image_recovery(uuid,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('authenticated','public.reserve_image_recovery(uuid,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('anon','public.reserve_image_recovery(uuid,jsonb,jsonb)','EXECUTE'),
    'revoked_legacy',not has_function_privilege('authenticated','private.reserve_analyzed_item_save_v10(jsonb,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('service_role','private.reserve_analyzed_item_save_v10(jsonb,jsonb,jsonb)','EXECUTE')
      and not has_function_privilege('authenticated','private.finish_item_deletion_v9(uuid,uuid)','EXECUTE'),
    'empty_context',not exists(select 1 from private.image_change_context),
    'target_key_bounds',(select bool_and(private.item_deletion_target_supported(
      '10000000-0000-4000-8000-000000000001','10800000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001/10800000-0000-4000-8000-000000000001/'||suffix)=allowed)
      from (values ('safe/main.jpg',true),('.',false),('..',false),('a//b',false),('%2f',false),
        ('a?b',false),('a#b',false),(repeat('a',129),false),(repeat('a/',16)||'a',false),
        (repeat(repeat('a',128)||'/',8)||'a',false)) as fixtures(suffix,allowed)));`));
  requireEvidence(Object.keys(result).length === 10 && Object.values(result).every((v) => v === true));
}

async function imageChangeContextProbe(owner, itemId, sql) {
  const result = await sql(`begin; set local statement_timeout='10s'; set local lock_timeout='2s';
    do $probe$ declare old_item public.items; target public.items; request uuid := gen_random_uuid(); refused boolean;
    begin
      select * into old_item from public.items where owner_id=${literal(owner.uid)} and id=${literal(itemId)} for update;
      if not found then raise exception 'I10B_PROBE'; end if;
      target := old_item;
      insert into private.image_change_context values(pg_current_xact_id(),old_item.owner_id,old_item.id,request,old_item.id,
        'replacement',old_item.version,private.image_change_hash(to_jsonb(old_item)),private.image_change_hash(to_jsonb(target)));
      if private.consume_image_change_context(old_item.owner_id,old_item.id,old_item.id,'begin_deletion',old_item.version,to_jsonb(old_item),to_jsonb(target))
        or private.consume_image_change_context(old_item.owner_id,old_item.id,old_item.id,'replacement',old_item.version+1,to_jsonb(old_item),to_jsonb(target))
        or private.consume_image_change_context(old_item.owner_id,old_item.id,old_item.id,'replacement',old_item.version,to_jsonb(old_item),'{}')
        or not private.consume_image_change_context(old_item.owner_id,old_item.id,old_item.id,'replacement',old_item.version,to_jsonb(old_item),to_jsonb(target))
        or private.consume_image_change_context(old_item.owner_id,old_item.id,old_item.id,'replacement',old_item.version,to_jsonb(old_item),to_jsonb(target))
        then raise exception 'I10B_ONE_SHOT'; end if;
      refused := false;
      begin
        insert into private.image_change_context values(pg_current_xact_id(),old_item.owner_id,old_item.id,request,old_item.id,
          'replacement',old_item.version,private.image_change_hash(to_jsonb(old_item)),private.image_change_hash(to_jsonb(target)));
        update public.items set title=title where owner_id=old_item.owner_id and id=old_item.id;
        if exists(select 1 from private.image_change_context) then raise exception 'I10B_NOT_CONSUMED'; end if;
        raise exception using errcode='ZX001',message='I10B_ROLLBACK';
      exception when sqlstate 'ZX001' then refused := true;
      end;
      if not refused or exists(select 1 from private.image_change_context)
        or (select to_jsonb(i) from public.items i where owner_id=old_item.owner_id and id=old_item.id) is distinct from to_jsonb(old_item)
        then raise exception 'I10B_ROLLBACK'; end if;
      refused := false;
      begin
        update public.items set material='Unattested',field_provenance=jsonb_set(field_provenance,'{material}',
          '{"kind":"ai_estimated","revision":1}'::jsonb) where owner_id=old_item.owner_id and id=old_item.id;
      exception when invalid_parameter_value then refused := true;
      end;
      if not refused then raise exception 'I10B_UNATTESTED'; end if;
    end $probe$; rollback; select 'I10B_CONTEXT_OK';`);
  requireEvidence(result === 'I10B_CONTEXT_OK');
  requireEvidence(await sql("select case when not exists(select 1 from private.image_change_context) then 'I10B_POOL_CLEAN' end;") === 'I10B_POOL_CLEAN');
}
