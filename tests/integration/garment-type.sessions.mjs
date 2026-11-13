import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';
import { analysisFacts, analysisHash } from './ai-analysis.sessions.mjs';
import { analyzedHarness, analyzedIntent } from './analyzed-save.sessions.mjs';
import { imageChangeHarness } from './image-replacement.sessions.mjs';
import { saveHarness, denied } from './item-save.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';
import { switchManifestSql } from '../../scripts/budget2-controls-switch.mjs';

// CAPS1a: catalog and behaviour proof for the two garment type migrations. Invoked only by the CI-only preservation owner, one step after
// the other in one session (no detached transaction, no rendezvous between sessions); every step marks its label first, because the rehearsal
// prints only the last label on a failure. No provider is called.
//   M1 20261113090000_garment_type.sql (the column, its check, the helper and ten replaced writers) is applied ALONE to the 49-migration
//     inventory. Before it: the account's pending checked saves are settled (earlier stages left frozen ones, which the drain check would
//     refuse), a completed save and a genuine pending save are seeded, the drain check is shown to refuse with the pending one, and the
//     state (functions, ACLs, triggers, every row, objects, every item's row hash) is captured. After it, BEFORE any write: only the ten bodies
//     and the one helper differ, each body equals the migration and each earlier body equals its predecessor's source, every row hash is
//     unchanged, and the column is empty. Then the behaviour.
//   M2 20261113090100_garment_type_manifest.sql (the v4 manifest and five replaced analysis functions) is applied alone to the 50.
const M1 = '20261113090000_garment_type.sql';
const M2 = '20261113090100_garment_type_manifest.sql';
const V2 = 'azure-eu-terra-devtest-v2', V3 = 'azure-eu-terra-devtest-v3', V4 = 'azure-eu-terra-devtest-v4';
const V2_RESERVATION = 4097351;
const V3_ENVELOPE = 16384;
const DRAIN = 'garment type: a checked item save or photo replacement is still pending; finish or cancel it, then run this again';

// The ten replaced writers and the file that holds the body each one has before M1.
const M1_REPLACED = Object.freeze({
  'private.item_save_fingerprint': '20260910070000_checked_item_save.sql',
  'private.item_save_value_hash': '20260911200000_checked_ai_item_save.sql',
  'private.ai_valid_facts': '20260924100000_garment_colours.sql',
  'private.item_field_provenance': '20260922020000_checked_image_changes.sql',
  'private.reserve_item_save': '20260924100000_garment_colours.sql',
  'private.image_change_intent': '20260924100000_garment_colours.sql',
  'public.complete_image_change': '20260922020000_checked_image_changes.sql',
  'private.reserve_analyzed_item_save_v10': '20261101080000_persistent_ai_availability.sql',
  'private.reserve_image_change': '20261101080000_persistent_ai_availability.sql',
  'public.reserve_restored_item_save': '20260925110000_restore_item_save.sql',
});
const M2_REPLACED = Object.freeze({
  'public.ai_claim_analysis': '20261101090000_unreserved_analysis_manifest.sql',
  'private.ai_analysis_permitted': '20261101090000_unreserved_analysis_manifest.sql',
  'public.ai_finish_analysis': '20261101090000_unreserved_analysis_manifest.sql',
  'public.ai_status': '20261101090000_unreserved_analysis_manifest.sql',
  'public.complete_analyzed_item_save': '20261101090000_unreserved_analysis_manifest.sql',
});
const HELPER = 'private.garment_type_allowed';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const md5 = (text) => createHash('md5').update(text).digest('hex');
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');

// The text between ` as $$` and its closing `$$;`, exactly what pg_proc.prosrc holds. Accepts the original `create function` and the
// replacing `create or replace function` headers.
function sourceBody(sql, name) {
  const headers = [`create or replace function ${name}(`, `create function ${name}(`];
  const found = headers.map((header) => sql.indexOf(header)).filter((index) => index >= 0);
  requireEvidence(found.length === 1);
  const start = found[0];
  const open = sql.indexOf(' as $$\n', start), close = sql.indexOf('\n$$;', open);
  requireEvidence(open > start && close > open);
  const body = sql.slice(open + ' as $$'.length, close + 1);
  requireEvidence(!body.includes('$$'));
  return body;
}

function probe(markStage, rawSql) {
  let current = '';
  const mark = (name) => { current = name; markStage(name); };
  const brief = (value) => JSON.stringify(value ?? null).replace(/[^A-Za-z0-9_.:,()-]+/g, '').slice(0, 110);
  const sql = async (text) => {
    try { return await rawSql(text); } catch (error) { markStage(`${current}-sql-failed-${brief(text.replace(/\s+/g, ' ').slice(0, 60))}`); throw error; }
  };
  const equal = (actual, expected) => {
    const ok = isDeepStrictEqual(actual, expected);
    if (!ok) markStage(`${current}-got-${brief(actual)}-want-${brief(expected)}`);
    requireEvidence(ok);
  };
  const need = (ok) => {
    if (!ok) markStage(`${current}-check-at-line-${/:(\d+):\d+/.exec(new Error('x').stack?.split('\n')[2] ?? '')?.[1] ?? 'unknown'}`);
    requireEvidence(ok);
  };
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  return { mark, sql, equal, need, one, scalar, brief };
}

const TABLES = [['private', 'ai_controls'], ['private', 'ai_usage'], ['private', 'ai_requests'], ['private', 'ai_usage_evidence'],
  ['private', 'ai_analysis_attestations'], ['private', 'ai_save_used_receipts'], ['private', 'ai_item_save_attempts'],
  ['private', 'item_save_attempts'], ['private', 'item_save_used_ids'], ['private', 'item_attribution_history'],
  ['private', 'image_change_attempts'], ['private', 'image_change_history'], ['private', 'ai_limit_audit'],
  ['public', 'items'], ['public', 'item_images'], ['public', 'profiles']];
// One capture of everything a migration here must leave alone. A replaced function's body is left out (null) and read separately.
const captureSql = (replaced) => `select jsonb_build_object(
  'functions',(select jsonb_object_agg(n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    jsonb_build_object('owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile,
      'config',coalesce(p.proconfig,'{}'::text[]),'acl',coalesce(p.proacl::text,''),
      'body',case when n.nspname||'.'||p.proname=any(array[${Object.keys(replaced).map(literal).join(',')},${literal(HELPER)}]) then null else md5(p.prosrc) end))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'manifests',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from private.ai_execution_manifests m),
  'triggers',(select coalesce(jsonb_agg(jsonb_build_array(c.oid::regclass::text,t.tgname,pg_get_triggerdef(t.oid))
      order by c.oid::regclass::text,t.tgname),'[]'::jsonb)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname in ('public','private')),
  'rows',jsonb_build_object(${TABLES.map(([schema, name]) => `${literal(`${schema}.${name}`)},(select jsonb_build_array(count(*),
      md5(coalesce(jsonb_agg(${schema === 'public' && name === 'items' ? `to_jsonb(t)-'garment_type'` : 'to_jsonb(t)'}
        order by ${schema === 'public' && name === 'items' ? `(to_jsonb(t)-'garment_type')::text` : 'to_jsonb(t)::text'}),'[]'::jsonb)::text))
      from ${schema}.${name} t)`).join(',')}),
  'objects',(select jsonb_build_array(count(*),md5(coalesce(jsonb_agg(jsonb_build_array(name,metadata->>'size') order by name),'[]'::jsonb)::text))
    from storage.objects where bucket_id='wardrobe'),
  'hashes',(select coalesce(jsonb_object_agg(i.id::text,private.item_save_value_hash(i)),'{}'::jsonb) from public.items i),
  'fingerprints',(select coalesce(jsonb_object_agg(i.id::text||'|'||m.id::text,private.item_save_fingerprint(i,m)),'{}'::jsonb)
    from public.items i join public.item_images m on m.owner_id=i.owner_id and m.item_id=i.id))::text;`;
const bodiesSql = (names) => `select coalesce(jsonb_object_agg(f.name,(select coalesce(jsonb_agg(jsonb_build_object('md5',md5(p.prosrc),
    'definer',p.prosecdef,'config',coalesce(p.proconfig,'{}'::text[]))),'[]'::jsonb)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=f.name)),'{}'::jsonb)::text
  from (values ${names.map((name) => `(${literal(name)})`).join(',')}) as f(name);`;
const clean = (text) => String(text).replace(/[^a-z0-9_]+/gi, '-').slice(0, 80);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// Compares everything but the replaced bodies (and the helper), which differ by design.
function compareUnchanged(before, after, mark, p, { allowNewFunction } = {}) {
  for (const section of ['triggers', 'objects']) {
    if (!same(after[section], before[section])) mark(`compare-${section}`);
    p.need(same(after[section], before[section]));
  }
  for (const key of Object.keys(before.rows)) {
    if (!same(after.rows[key], before.rows[key])) mark(`compare-rows-${clean(key)}`);
    p.need(same(after.rows[key], before.rows[key]));
  }
  const names = new Set([...Object.keys(before.functions), ...Object.keys(after.functions)]);
  for (const name of names) {
    if (before.functions[name] === undefined) {
      if (!(allowNewFunction && name.startsWith(`${HELPER}(`))) mark(`compare-function-${clean(name)}-appeared`);
      p.need(allowNewFunction && name.startsWith(`${HELPER}(`));
      continue;
    }
    for (const field of ['owner', 'definer', 'volatility', 'config', 'acl', 'body']) {
      const x = before.functions[name]?.[field], y = after.functions[name]?.[field];
      if (!same(x, y)) mark(`compare-function-${clean(name)}-${field}`);
      p.need(same(x, y));
    }
  }
  mark('compare-hashes');
  p.need(same(after.hashes, before.hashes));
  mark('compare-fingerprints');
  p.need(same(after.fingerprints, before.fingerprints));
}

// ---------------------------------------------------------------- M1
// The drain check of the migration, run as the migration runs it, and reported instead of thrown.
async function attemptDrain(p, source) {
  const from = source.indexOf('do $pre$'), to = source.indexOf('$pre$;', from) + '$pre$;'.length;
  p.need(from > 0 && to > from);
  const block = source.slice(from, to);
  const out = await p.sql(`create temp table if not exists caps_attempt(message text);
    truncate caps_attempt;
    do $outer$ begin
      begin execute $inner$${block}$inner$; insert into caps_attempt values('OK');
      exception when others then insert into caps_attempt values(sqlerrm); end;
    end $outer$;
    select message from caps_attempt;`);
  return out.trim();
}

export async function garmentTypeCheckpointM1(snapshot, rawSql, markStage) {
  const p = probe(markStage, rawSql);
  const { client, owners: [a, b] } = snapshot;
  const source = await migration(M1);
  p.mark('prior-inventory');
  p.equal(await p.scalar(`select count(*) from information_schema.columns where table_schema='public' and table_name='items' and column_name='garment_type';`), '0');
  p.equal(await p.scalar(`select count(*) from pg_proc where proname='garment_type_allowed';`), '0');
  p.equal(await p.scalar(`select count(*) from private.ai_execution_manifests where id=${literal(V4)};`), '0');
  p.mark('predecessor-bodies');
  const installed = JSON.parse(await p.sql(bodiesSql(Object.keys(M1_REPLACED))));
  for (const [name, file] of Object.entries(M1_REPLACED)) {
    p.mark(`predecessor-${clean(name)}`);
    p.equal(installed[name]?.length, 1);
    p.equal(installed[name][0].md5, md5(sourceBody(await migration(file), name)));
  }
  p.mark('settle-earlier-frozen-saves');
  // Earlier stages deliberately froze checked saves and replacements (to prove they finish under their own manifest). They would make the drain
  // check refuse, as it should; this fixture settles them as an owner finishing or cancelling them would.
  await p.sql(`update private.item_save_attempts set state='completed',completed_at=clock_timestamp() where state='reserved';
    update private.image_change_attempts set state='cancelled' where state='reserved';`);
  p.equal(await attemptDrain(p, source), 'OK');
  p.mark('seed-completed-save');
  const ha = saveHarness(client, a);
  const done = ha.track();
  const doneRow = await ha.reserve(done);
  await ha.upload(done);
  await ha.finalize(done, doneRow);
  p.mark('seed-pending-save');
  const hb = saveHarness(client, b);
  const pending = hb.track();
  const pendingRow = await hb.reserve(pending);
  await hb.upload(pending);
  p.mark('drain-refuses-a-pending-save');
  p.equal(await attemptDrain(p, source), DRAIN);
  p.mark('drain-releases-after-finalize');
  await hb.finalize(pending, pendingRow);
  p.equal(await attemptDrain(p, source), 'OK');
  p.mark('capture');
  const state = JSON.parse(await p.sql(captureSql(M1_REPLACED)));
  p.need(Object.keys(state.functions).length > 100 && state.triggers.length > 0 && Object.keys(state.hashes).length > 0);
  p.need(Object.keys(state.fingerprints).length > 0);
  return { state, done, doneFingerprint: doneRow.fingerprint, doneItem: doneRow.item };
}

export async function garmentTypeCompareM1(before, rawSql, markStage) {
  const p = probe(markStage, rawSql), { mark } = p;
  const source = await migration(M1);
  mark('compare-capture');
  const after = JSON.parse(await p.sql(captureSql(M1_REPLACED)));
  compareUnchanged(before.state, after, mark, p, { allowNewFunction: true });
  mark('compare-bodies');
  const bodies = JSON.parse(await p.sql(bodiesSql([...Object.keys(M1_REPLACED), HELPER])));
  for (const name of [...Object.keys(M1_REPLACED), HELPER]) {
    mark(`compare-body-${clean(name)}`);
    p.equal(bodies[name]?.length, 1);
    p.equal(bodies[name][0].md5, md5(sourceBody(source, name)));
  }
  mark('compare-helper-acl');
  p.equal(await p.scalar(`select has_function_privilege('authenticated','${HELPER}(text,text)','execute')::text||has_function_privilege('anon','${HELPER}(text,text)','execute')::text;`), 'falsefalse');
  mark('compare-column');
  p.equal(await p.one(`select to_jsonb(c) from (select data_type,is_nullable from information_schema.columns
    where table_schema='public' and table_name='items' and column_name='garment_type') c;`), { data_type: 'text', is_nullable: 'YES' });
  p.equal(await p.scalar(`select count(*) from pg_constraint where conrelid='public.items'::regclass and conname='items_garment_type_pair' and contype='c';`), '1');
  p.equal(await p.scalar(`select count(*) from public.items where garment_type is not null;`), '0');
}

const proofOf = (kind, revision = 1) => ({ kind, revision });
const userAll = (...fields) => Object.fromEntries(fields.map((field) => [field, proofOf('user')]));

export async function garmentTypeProbesM1(snapshot, rawSql, before, markStage) {
  const p = probe(markStage, rawSql), { mark, equal, need } = p;
  const { client, owners: [a, b], env } = snapshot;
  const ha = saveHarness(client, a), hb = saveHarness(client, b);
  const patch = (owner, row, body) => client.request(owner.token,
    `/rest/v1/items?owner_id=eq.${owner.uid}&id=eq.${row.id}&version=eq.${row.version}`,
    { method: 'PATCH', body, headers: { Prefer: 'return=representation' } });

  mark('ai-valid-facts');
  const valid = async (fields, outcome = 'ready') => (await p.scalar(`select private.ai_valid_facts(${json({ outcome, fields })})::text;`)) === 'true';
  need(await valid({ category: 'top', garment_type: 'shirt' }));
  need(await valid({ category: 'outerwear', garment_type: 'vest' }) && await valid({ category: 'layer', garment_type: 'vest' }));
  need(await valid({ category: 'top', garment_type: null }) && await valid({ garment_type: null }));
  need(!(await valid({ category: 'top', garment_type: 'jeans' })));
  need(!(await valid({ garment_type: 'shirt' })) && !(await valid({ category: null, garment_type: 'shirt' })));
  need(!(await valid({ category: 'top', garment_type: 'poncho' })) && !(await valid({ category: 'top', garment_type: 5 })));
  need(!(await valid({ category: 'top', garment_type: 'shirt' }, 'unclear')));
  need(await valid({ category: null, garment_type: null }, 'unclear'));

  mark('retry-of-a-completed-save');
  // The completed seed is retried exactly as the client sent it: the stored row hash and fingerprint did not change with the column.
  const retry = await ha.call('reserve_item_save', before.done);
  need(retry.ok && retry.status === 200 && retry.data.length === 1);
  equal([retry.data[0].state, retry.data[0].fingerprint], ['completed', before.doneFingerprint]);
  equal(retry.data[0].item.garment_type, null);

  mark('save-without-the-key');
  const plain = ha.track();
  const plainRow = await ha.reserve(plain);
  await ha.upload(plain);
  await ha.finalize(plain, plainRow);
  equal((await ha.read('items', plain.p_item.id))[0].garment_type, null);

  mark('save-with-a-type');
  const typed = hb.track();
  Object.assign(typed.p_item, { category: 'outerwear', garment_type: 'vest' });
  typed.p_item.field_provenance = userAll('title', 'category', 'garment_type');
  const typedRow = await hb.reserve(typed);
  await hb.upload(typed);
  await hb.finalize(typed, typedRow);
  const stored = (await hb.read('items', typed.p_item.id))[0];
  equal([stored.category, stored.garment_type, stored.field_provenance.garment_type], ['outerwear', 'vest', proofOf('user')]);

  mark('save-refuses-a-wrong-pair');
  for (const [category, garmentType] of [['top', 'jeans'], ['outerwear', 'shirt'], ['top', 'poncho'], ['top', '']]) {
    const bad = hb.track();
    Object.assign(bad.p_item, { category, garment_type: garmentType });
    bad.p_item.field_provenance = userAll('title', 'category', 'garment_type');
    denied(await hb.call('reserve_item_save', bad), 'Invalid input');
    equal(await hb.read('items', bad.p_item.id), []);
  }
  mark('save-refuses-a-type-without-its-assertion');
  const unasserted = hb.track();
  Object.assign(unasserted.p_item, { category: 'top', garment_type: 'shirt' });
  denied(await hb.call('reserve_item_save', unasserted), 'Invalid input');
  equal(await hb.read('items', unasserted.p_item.id), []);

  mark('restore-keeps-an-observed-kind');
  const restored = ha.track();
  Object.assign(restored.p_item, { category: 'layer', garment_type: 'vest' });
  restored.p_item.field_provenance = { title: proofOf('user'), category: proofOf('user'), garment_type: proofOf('ai_observed') };
  const restoredRow = await ha.call('reserve_restored_item_save', restored);
  need(restoredRow.ok && restoredRow.data.length === 1);
  await ha.upload(restored);
  await ha.finalize(restored, restoredRow.data[0]);
  const back = (await ha.read('items', restored.p_item.id))[0];
  equal([back.garment_type, back.field_provenance.garment_type], ['vest', proofOf('ai_observed')]);
  mark('restore-refuses-a-mismatch');
  const mismatch = ha.track();
  Object.assign(mismatch.p_item, { category: 'top', garment_type: 'jeans' });
  mismatch.p_item.field_provenance = { title: proofOf('user'), category: proofOf('user'), garment_type: proofOf('user') };
  denied(await ha.call('reserve_restored_item_save', mismatch), 'Invalid input');
  equal(await ha.read('items', mismatch.p_item.id), []);

  mark('direct-edits');
  const edit = ha.track();
  Object.assign(edit.p_item, { category: 'outerwear', garment_type: 'overshirt' });
  edit.p_item.field_provenance = userAll('title', 'category', 'garment_type');
  const editRow = await ha.reserve(edit);
  await ha.upload(edit);
  await ha.finalize(edit, editRow);
  let row = (await ha.read('items', edit.p_item.id))[0];
  const moved = await patch(a, row, { category: 'layer', field_provenance: { ...row.field_provenance, category: proofOf('user', 2) } });
  need(moved.ok);
  row = moved.data[0];
  equal(row.garment_type, 'overshirt');
  for (const body of [{ category: 'bottom' }, { garment_type: 'shirt' }, { garment_type: 'poncho' }, { garment_type: '' }]) {
    const refused = await patch(a, row, { notes: 'Must roll back', ...body });
    need(!refused.ok);
    equal(await ha.read('items', row.id), [row]);
  }
  const unmarked = await patch(a, row, { garment_type: 'cardigan' });
  need(unmarked.ok);
  equal(unmarked.data[0].field_provenance.garment_type, proofOf('unknown', 2));
  const cleared = await patch(a, unmarked.data[0], { garment_type: null, field_provenance: { ...unmarked.data[0].field_provenance, garment_type: proofOf('user', 3) } });
  need(cleared.ok);
  equal([cleared.data[0].garment_type, cleared.data[0].field_provenance.garment_type], [null, proofOf('user', 3)]);

  mark('export-carries-the-column');
  const exported = await client.rpc(a, 'export_manifest', { p_export_id: randomUUID() });
  need(Array.isArray(exported.tables.items) && exported.tables.items.length > 0
    && exported.tables.items.every((entry) => Object.hasOwn(entry, 'garment_type')));

  mark('replacement-with-and-without-the-key');
  const ich = imageChangeHarness(client, a, env, markStage);
  const made = await ich.create();
  equal(made.item.garment_type, null);
  const first = ich.make(made.item, made.image);
  need(Object.hasOwn(first.item, 'garment_type'));
  await ich.reserve(first);
  await ich.upload(first);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await ich.endpoint(first);
    if (result.status === 204) break;
    equal(result, { status: 409, data: { code: 'CONFLICT' } });
    need(attempt < 10);
    await new Promise((resolve) => { setTimeout(resolve, 50 * attempt); });
  }
  const after = (await ich.read('items', first.itemId))[0];
  equal([after.version, after.garment_type], [2, null]);
  const currentImage = (await ich.read('item_images', first.imageId))[0];
  const oldClient = ich.make(after, currentImage);
  delete oldClient.item.garment_type;
  denied(await ich.call('reserve_image_change', { p_intent: oldClient }), 'Invalid input');
  const wrong = ich.make(after, currentImage);
  Object.assign(wrong.item, { garment_type: 'jeans', field_provenance: { ...after.field_provenance, garment_type: proofOf('user') } });
  denied(await ich.call('reserve_image_change', { p_intent: wrong }), 'Invalid input');
  const second = ich.make(after, currentImage);
  Object.assign(second.item, { garment_type: 'shirt', field_provenance: { ...after.field_provenance, garment_type: proofOf('user') } });
  await ich.reserve(second);
  await ich.upload(second);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await ich.endpoint(second);
    if (result.status === 204) break;
    equal(result, { status: 409, data: { code: 'CONFLICT' } });
    need(attempt < 10);
    await new Promise((resolve) => { setTimeout(resolve, 50 * attempt); });
  }
  const typedAfter = (await ich.read('items', second.itemId))[0];
  equal([typedAfter.version, typedAfter.garment_type, typedAfter.field_provenance.garment_type], [3, 'shirt', proofOf('user')]);

  await backfillProbes(p, snapshot, ha, patch);
}

// ---------------------------------------------------------------- the backfill file
const BACKFILL = new URL('../../docs/garment-type-backfill.sql', import.meta.url);
export async function backfillParts() {
  const text = await readFile(BACKFILL, 'utf8');
  const one = text.indexOf('-- == PART 1'), two = text.indexOf('-- == PART 2');
  requireEvidence(one > 0 && two > one);
  return { part1: text.slice(one, two), part2: text.slice(two) };
}

async function backfillProbes(p, snapshot, ha, patch) {
  const { mark, equal, need } = p;
  const { owners: [a, b] } = snapshot;
  const { part1, part2 } = await backfillParts();
  const dry = (owner) => p.one(part1.replaceAll('<owner>', owner.uid));
  const apply = (owner, reviewed) => p.sql(part2.replaceAll('<owner>', owner.uid).replaceAll('<reviewed>', JSON.stringify(reviewed).replaceAll("'", "''")));
  const row = async (id) => (await ha.read('items', id))[0];
  const make = async (category, title, extra = {}, provenance = {}) => {
    const value = ha.track();
    Object.assign(value.p_item, { category, title, ...extra });
    value.p_item.field_provenance = { title: proofOf('user'), category: proofOf('user'), ...provenance };
    const saved = await ha.reserve(value);
    await ha.upload(value);
    await ha.finalize(value, saved);
    return value.p_item.id;
  };
  mark('backfill-fixtures');
  const ids = {
    tee: await make('top', 'Synthetic black T-shirt'), polo: await make('top', 'Synthetic navy polo shirt'),
    shorts: await make('bottom', 'Synthetic blue jeans shorts'), vest: await make('outerwear', 'Synthetic navy down vest'),
    flannel: await make('layer', 'Synthetic burgundy flannel'), mystery: await make('top', 'Synthetic mystery piece'),
    typed: await make('top', 'Synthetic typed shirt', { garment_type: 'shirt' }, { garment_type: proofOf('user') }),
    cleared: await make('top', 'Synthetic cleared shirt', { garment_type: 'shirt' }, { garment_type: proofOf('user') }),
    changed: await make('top', 'Synthetic changed shirt'),
  };
  const mine = new Set(Object.values(ids));
  const cleared = await patch(a, await row(ids.cleared), { garment_type: null, field_provenance: { ...(await row(ids.cleared)).field_provenance, garment_type: proofOf('user', 2) } });
  need(cleared.ok);
  equal([cleared.data[0].garment_type, cleared.data[0].field_provenance.garment_type.kind], [null, 'user']);

  mark('backfill-dry-run');
  const before = await Promise.all(Object.values(ids).map(async (id) => [id, await row(id)]));
  const report = await dry(a);
  const proposals = report.proposals.filter((entry) => mine.has(entry.id));
  const byId = Object.fromEntries(proposals.map((entry) => [entry.id, entry.type]));
  equal(byId, { [ids.tee]: 't_shirt', [ids.polo]: 'polo', [ids.shorts]: 'shorts', [ids.vest]: 'vest', [ids.flannel]: 'overshirt', [ids.changed]: 'shirt' });
  equal(report.unmatched.filter((entry) => mine.has(entry.id)).map((entry) => entry.id), [ids.mystery]);
  need(!report.proposals.some((entry) => entry.id === ids.cleared || entry.id === ids.typed));
  need(!report.unmatched.some((entry) => entry.id === ids.cleared || entry.id === ids.typed));
  for (const [id, saved] of before) equal(await row(id), saved); // the dry run wrote nothing

  mark('backfill-changed-row');
  // One reviewed garment is edited after the review: its version moves on, so the apply skips it.
  const edited = await patch(a, await row(ids.changed), { notes: 'Edited after the review' });
  need(edited.ok);

  mark('backfill-forged-proposals');
  const forged = [
    { id: ids.cleared, version: (await row(ids.cleared)).version, type: 'shirt' },
    { id: ids.typed, version: (await row(ids.typed)).version, type: 'polo' },
    { id: ids.tee, version: (await row(ids.tee)).version, type: 'jeans' },
    { id: ids.mystery, version: (await row(ids.mystery)).version, type: 'shirt' },
  ];
  const untouched = await Promise.all(forged.map(async (entry) => [entry.id, await row(entry.id)]));
  await apply(a, forged);
  for (const [id, saved] of untouched) equal(await row(id), saved);

  mark('backfill-other-owner');
  // Another account's list is never applied to this one's garments, and this one's rows are never reachable with the other's id.
  await apply(b, proposals);
  for (const [id, saved] of before.filter(([id]) => id !== ids.changed && id !== ids.cleared)) equal(await row(id), saved);

  mark('backfill-apply');
  await apply(a, proposals);
  const expected = { [ids.tee]: 't_shirt', [ids.polo]: 'polo', [ids.shorts]: 'shorts', [ids.vest]: 'vest', [ids.flannel]: 'overshirt' };
  const setVersions = {};
  for (const [id, type] of Object.entries(expected)) {
    mark(`backfill-set-${type}`);
    const written = await row(id), old = before.find(([key]) => key === id)[1];
    equal([written.garment_type, written.version, written.field_provenance.garment_type], [type, old.version + 1, proofOf('unknown', 1)]);
    equal(written.title, old.title); equal(written.category, old.category); equal(written.notes, old.notes);
    setVersions[id] = written.version;
  }
  mark('backfill-skips');
  equal((await row(ids.changed)).garment_type, null);
  equal((await row(ids.mystery)).garment_type, null);
  const keptCleared = await row(ids.cleared);
  equal([keptCleared.garment_type, keptCleared.field_provenance.garment_type.kind], [null, 'user']);
  equal((await row(ids.typed)).garment_type, 'shirt');

  mark('backfill-replay');
  await apply(a, proposals);
  for (const [id, version] of Object.entries(setVersions)) equal((await row(id)).version, version);
  mark('backfill-dry-run-after');
  const again = await dry(a);
  need(!again.proposals.some((entry) => mine.has(entry.id) && entry.id !== ids.changed));
}

// ---------------------------------------------------------------- M2
export async function garmentTypeCheckpointM2(rawSql, markStage) {
  const p = probe(markStage, rawSql);
  p.mark('prior-inventory');
  p.equal(await p.scalar(`select count(*) from private.ai_execution_manifests where id=${literal(V4)};`), '0');
  p.equal(await p.scalar(`select count(*) from information_schema.columns where table_schema='public' and table_name='items' and column_name='garment_type';`), '1');
  p.mark('predecessor-bodies');
  const installed = JSON.parse(await p.sql(bodiesSql(Object.keys(M2_REPLACED))));
  for (const [name, file] of Object.entries(M2_REPLACED)) {
    p.mark(`predecessor-${clean(name)}`);
    p.equal(installed[name]?.length, 1);
    p.equal(installed[name][0].md5, md5(sourceBody(await migration(file), name)));
  }
  p.mark('capture');
  const state = JSON.parse(await p.sql(captureSql(M2_REPLACED)));
  p.need(Object.keys(state.functions).length > 100 && state.manifests.some((m) => m.id === V3) && !state.manifests.some((m) => m.id === V4));
  return state;
}

export async function garmentTypeCompareM2(before, rawSql, markStage) {
  const p = probe(markStage, rawSql), { mark } = p;
  const source = await migration(M2);
  mark('compare-capture');
  const after = JSON.parse(await p.sql(captureSql(M2_REPLACED)));
  const withoutManifests = (state) => ({ ...state, manifests: null });
  compareUnchanged(withoutManifests(before), withoutManifests(after), mark, p);
  mark('compare-bodies');
  const bodies = JSON.parse(await p.sql(bodiesSql(Object.keys(M2_REPLACED))));
  for (const name of Object.keys(M2_REPLACED)) {
    mark(`compare-body-${clean(name)}`);
    p.equal(bodies[name]?.length, 1);
    p.equal(bodies[name][0].md5, md5(sourceBody(source, name)));
  }
  mark('compare-manifests');
  const added = after.manifests.filter((m) => !before.manifests.some((old) => old.id === m.id));
  p.need(added.length === 1 && added[0].id === V4 && after.manifests.length === before.manifests.length + 1);
  p.need(same(after.manifests.filter((m) => m.id !== V4), before.manifests));
  const v3 = before.manifests.find((m) => m.id === V3), v4 = added[0];
  const differing = Object.keys(v4).filter((key) => !same(v4[key], v3[key])).sort();
  p.equal(differing, ['id', 'prompt_sha256', 'prompt_version', 'schema_sha256', 'settings_sha256', 'tariff_description']);
  p.equal([v4.prompt_version, v4.reservation_micro, v4.input_envelope, v4.output_envelope, v4.model_id], [3, 1, V3_ENVELOPE, 2048, v3.model_id]);
  mark('compare-no-controls-written');
  // Every account stays on the manifest it was on: the migration writes no controls row.
  p.need(same(after.rows['private.ai_controls'], before.rows['private.ai_controls']));
}

const USAGE = Object.freeze({ modelObservation: 'expected_snapshot', controlObservation: 'ordinary', input: 1000, output: 200,
  total: 1200, reasoning: 50, cacheRead: 0, cacheWrite: 0 });
const ESTIMATE = Math.ceil((1000 * 440 + 200 * 1980) / 100);
const fields14 = analysisFacts.fields;
const facts = (extra, outcome = 'ready', withType = true) => ({ outcome, fields: { ...fields14, ...(withType ? { garment_type: null } : {}), ...extra } });

export async function garmentTypeProbesM2(snapshot, rawSql, markStage) {
  const p = probe(markStage, rawSql), { mark, equal, need, one, scalar, sql } = p;
  const { client, owners: [a, b], env } = snapshot;
  const setControls = (owner, manifest, maxRequest, promptVersion, allowance = 100000000) => sql(`insert into private.ai_controls(owner_id,activated,
    notice_revision,model_id,prompt_version,max_request_micro,monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds,
    execution_manifest_id) values(${literal(owner.uid)},true,2,'gpt-5.6-terra-2026-07-09',${promptVersion},${maxRequest},${allowance},200,3600,
    ${literal(manifest)}) on conflict (owner_id) do update set activated=true,notice_revision=2,model_id=excluded.model_id,
      prompt_version=excluded.prompt_version,max_request_micro=excluded.max_request_micro,monthly_allowance_micro=excluded.monthly_allowance_micro,
      result_ttl_seconds=excluded.result_ttl_seconds,execution_manifest_id=excluded.execution_manifest_id;`);
  const controlsRow = async (owner) => {
    const text = await sql(`select to_jsonb(c) from (select execution_manifest_id,max_request_micro,monthly_allowance_micro,
      activated,prompt_version,notice_revision,model_id,result_ttl_seconds from private.ai_controls where owner_id=${literal(owner.uid)}) c;`);
    return text.trim() ? JSON.parse(text) : null;
  };
  const aiConsent = async (owner, enabled) => {
    const profile = (await client.rows(owner, 'profiles'))[0];
    return client.rpc(owner, 'ai_set_consent', { p_enabled: enabled, p_notice_revision: enabled ? 2 : null, p_expected_version: profile.version });
  };
  const claim = (owner, id, manifest) => one(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(id)},${literal(id)},1,
    ${literal(analysisHash)},${jpegHeaderFixture().length},120,80,${literal(manifest)});`);
  const finish = (owner, id, body, manifest, usage = USAGE) => one(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(id)},
    ${literal(manifest)},${json(body)},${json(usage)},'SUCCESS');`);
  const usageRow = (owner, id) => one(`select to_jsonb(u) from (select reserved_micro::text,accounted_micro::text,charge_state,closed_reason
    from private.ai_usage where owner_id=${literal(owner.uid)} and request_id=${literal(id)}) u;`);
  const original = [await controlsRow(a), await controlsRow(b)];

  try {
    mark('v4-claim-and-status');
    await setControls(a, V4, 1, 3);
    need((await aiConsent(a, true)).code === 'OK');
    const request = randomUUID();
    const first = await claim(a, request, V4);
    need(first.claimed === true && first.manifestId === V4);
    equal(await usageRow(a, request), { reserved_micro: '1', accounted_micro: '1', charge_state: 'held', closed_reason: null });
    const status = await client.rpc(a, 'ai_status', {});
    equal([status.code, status.policy.executionManifestId, status.policy.maxRequestMicro, status.policy.promptVersion, status.policy.noticeRevision],
      ['OK', V4, '1', 3, 2]);
    mark('v4-finish-15-keys');
    equal((await finish(a, request, facts({ category: 'top', garment_type: 'shirt' }), V4)).stored, true);
    equal(await usageRow(a, request), { reserved_micro: '1', accounted_micro: String(ESTIMATE), charge_state: 'estimated', closed_reason: null });

    mark('v4-key-sets-and-pairs');
    const fourteen = randomUUID();
    need((await claim(a, fourteen, V4)).claimed === true);
    const short = await finish(a, fourteen, facts({}, 'ready', false), V4);
    equal([short.code, short.stored], ['INVALID_FACTS', false]);
    equal((await usageRow(a, fourteen)).accounted_micro, String(ESTIMATE)); // the cost is still recorded
    const wrongPair = randomUUID();
    need((await claim(a, wrongPair, V4)).claimed === true);
    equal((await finish(a, wrongPair, facts({ category: 'top', garment_type: 'jeans' }), V4)).code, 'INVALID_FACTS');
    const noCategory = randomUUID();
    need((await claim(a, noCategory, V4)).claimed === true);
    equal((await finish(a, noCategory, facts({ category: null, garment_type: 'shirt' }), V4)).code, 'INVALID_FACTS');
    const unknownCode = randomUUID();
    need((await claim(a, unknownCode, V4)).claimed === true);
    equal((await finish(a, unknownCode, facts({ category: 'top', garment_type: 'poncho' }), V4)).code, 'INVALID_FACTS');
    const unsure = randomUUID();
    need((await claim(a, unsure, V4)).claimed === true);
    equal((await finish(a, unsure, facts({ category: 'top', garment_type: null }), V4)).stored, true);

    mark('v4-analysed-save');
    const harness = analyzedHarness(client, a, env);
    const saved = randomUUID();
    need((await claim(a, saved, V4)).claimed === true);
    equal((await finish(a, saved, facts({ category: 'top', garment_type: 'shirt' }), V4)).stored, true);
    const value = analyzedIntent(a, 22);
    value.p_item.id = randomUUID(); value.p_image.id = randomUUID();
    value.p_item.garment_type = 'shirt';
    value.p_item.field_provenance.garment_type = proofOf('ai_observed');
    value.p_claim = { ...value.p_claim, requestId: saved, draftId: saved,
      fields: { ...value.p_claim.fields, garment_type: { kind: 'ai_observed', value: 'shirt' } } };
    const row = await harness.reserve(value);
    await harness.upload(value);
    await harness.finalize(value, row);
    const item = (await harness.read('items', value.p_item.id))[0];
    equal([item.garment_type, item.field_provenance.garment_type], ['shirt', proofOf('ai_observed')]);
    const history = await client.rpc(a, 'item_attribution_history', { p_item_id: value.p_item.id });
    need(history.length === 1 && history[0].prompt_version === 3);
    equal(history[0].fields.garment_type, proofOf('ai_observed'));
    equal(await scalar(`select manifest_id from private.item_attribution_history where owner_id=${literal(a.uid)} and item_id=${literal(value.p_item.id)};`), V4);
    mark('v4-analysed-save-refuses-a-claim-the-facts-do-not-have');
    const other = randomUUID();
    need((await claim(a, other, V4)).claimed === true);
    equal((await finish(a, other, facts({ category: 'top', garment_type: 'polo' }), V4)).stored, true);
    const forgedClaim = analyzedIntent(a, 23);
    forgedClaim.p_item.id = randomUUID(); forgedClaim.p_image.id = randomUUID();
    forgedClaim.p_item.garment_type = 'shirt';
    forgedClaim.p_item.field_provenance.garment_type = proofOf('ai_observed');
    forgedClaim.p_claim = { ...forgedClaim.p_claim, requestId: other, draftId: other,
      fields: { ...forgedClaim.p_claim.fields, garment_type: { kind: 'ai_observed', value: 'shirt' } } };
    const refused = await harness.call('reserve_analyzed_item_save', forgedClaim);
    need(!refused.ok);
    equal(await harness.read('items', forgedClaim.p_item.id), []);

    mark('v3-and-v4-are-not-mixed');
    await setControls(a, V3, 1, 2);
    equal(await claim(a, randomUUID(), V4), { code: 'CONFIG_CHANGED', claimed: false });
    const v3request = randomUUID();
    need((await claim(a, v3request, V3)).claimed === true);
    const v3with15 = await finish(a, v3request, facts({ category: 'top', garment_type: 'shirt' }), V3);
    equal([v3with15.code, v3with15.stored], ['INVALID_FACTS', false]);
    const v3plain = randomUUID();
    need((await claim(a, v3plain, V3)).claimed === true);
    equal((await finish(a, v3plain, { outcome: 'ready', fields: { ...fields14, category: 'top' } }, V3)).stored, true);
    await setControls(a, V4, 1, 3);
    equal(await claim(a, randomUUID(), V3), { code: 'CONFIG_CHANGED', claimed: false });

    mark('v4-anomaly');
    // Like v3: an envelope overrun records its full unclamped cost and fails only that photo, and analysis stays on.
    const edge = randomUUID();
    need((await claim(a, edge, V4)).claimed === true);
    const inEnvelope = { ...USAGE, input: V3_ENVELOPE, output: 2048, total: V3_ENVELOPE + 2048, reasoning: 0 };
    equal((await finish(a, edge, facts({ category: 'top' }), V4, inEnvelope)).stored, true);
    equal((await controlsRow(a)).activated, true);
    const over = randomUUID();
    need((await claim(a, over, V4)).claimed === true);
    const overUsage = { ...USAGE, input: V3_ENVELOPE + 1, output: 10, total: V3_ENVELOPE + 11, reasoning: 0 };
    equal((await finish(a, over, facts({ category: 'top' }), V4, overUsage)).code, 'USAGE_ANOMALY');
    equal((await usageRow(a, over)).accounted_micro, String(Math.ceil(((V3_ENVELOPE + 1) * 440 + 10 * 1980) / 100)));
    equal(await scalar(`select anomaly::text from private.ai_usage_evidence where owner_id=${literal(a.uid)} and request_id=${literal(over)};`), 'true');
    equal((await controlsRow(a)).activated, true);
    need((await claim(a, randomUUID(), V4)).claimed === true);
    mark('v4-other-shutdowns-unchanged');
    const contradictory = randomUUID();
    need((await claim(a, contradictory, V4)).claimed === true);
    equal((await finish(a, contradictory, facts({ category: 'top' }), V4, { ...USAGE, controlObservation: 'contradictory' })).code, 'USAGE_ANOMALY');
    equal((await controlsRow(a)).activated, false);
    equal(await claim(a, randomUUID(), V4), { code: 'INACTIVE', claimed: false });
    await sql(`update private.ai_controls set activated=true where owner_id=${literal(a.uid)};`);
    mark('v2-still-deactivates-on-an-overrun');
    await setControls(a, V2, V2_RESERVATION, 2);
    const overV2 = randomUUID();
    need((await claim(a, overV2, V2)).claimed === true);
    equal((await finish(a, overV2, { outcome: 'ready', fields: { ...fields14, category: 'top' } }, V2,
      { ...USAGE, input: 922001, output: 10, total: 922011, reasoning: 0 })).code, 'USAGE_ANOMALY');
    equal((await controlsRow(a)).activated, false);
  } finally {
    await restoreControls(sql, a, original[0]);
    await restoreControls(sql, b, original[1]);
  }

  await switchProbes(p, snapshot, { setControls, controlsRow, aiConsent, claim, finish, usageRow });
}

async function restoreControls(sql, owner, row) {
  if (row === null) return;
  await sql(`update private.ai_controls set execution_manifest_id=${literal(row.execution_manifest_id)},max_request_micro=${row.max_request_micro},
    monthly_allowance_micro=${row.monthly_allowance_micro},activated=${row.activated},prompt_version=${row.prompt_version}
    where owner_id=${literal(owner.uid)};`);
}

// The guarded switch between v3 and v4: it needs the exact current row and a quiet account, writes only the manifest, the amount and the
// prompt version, and the same text moves the account back.
async function switchProbes(p, snapshot, h) {
  const { mark, equal, need, sql } = p;
  const { owners: [, b] } = snapshot;
  const { setControls, controlsRow, aiConsent, claim, finish, usageRow } = h;
  const attempt = async (direction) => {
    const [from, to] = direction === 'forward' ? ['v3', 'v4'] : ['v4', 'v3'];
    const text = switchManifestSql(b.uid, from, to);
    const block = text.slice(text.indexOf('do $switch$'), text.lastIndexOf('commit;')).trim();
    const out = await sql(`create temp table if not exists caps_switch(message text);
      truncate caps_switch;
      do $outer$ begin
        begin execute $inner$${block}$inner$; insert into caps_switch values('OK');
        exception when others then insert into caps_switch values(sqlerrm); end;
      end $outer$;
      select message from caps_switch;`);
    return out.trim();
  };
  const original = await controlsRow(b);
  try {
    mark('switch-quiet-account');
    await sql(`delete from private.ai_usage where owner_id=${literal(b.uid)} and charge_state in ('reserved','held');
      delete from private.ai_requests where owner_id=${literal(b.uid)};`);
    await setControls(b, V3, 1, 2);
    need((await aiConsent(b, true)).code === 'OK');
    const start = await controlsRow(b);
    mark('switch-refuses-the-wrong-row');
    equal(await attempt('rollback'), 'BLOCKED: the controls are not the expected current row');
    equal(await controlsRow(b), start);
    mark('switch-forward');
    equal(await attempt('forward'), 'OK');
    equal(await controlsRow(b), { ...start, execution_manifest_id: V4, prompt_version: 3, max_request_micro: 1 });
    equal(await attempt('forward'), 'BLOCKED: the controls are not the expected current row');
    mark('switch-refuses-a-live-request');
    const live = randomUUID();
    need((await claim(b, live, V4)).claimed === true);
    const held = await controlsRow(b);
    equal(await attempt('rollback'), 'BLOCKED: a request of this account is still alive');
    equal(await controlsRow(b), held);
    equal((await finish(b, live, facts({ category: 'top' }), V4)).stored, true);
    equal(await attempt('rollback'), 'BLOCKED: an unsaved ready analysis is still alive');
    equal(await controlsRow(b), held);
    await sql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
      where owner_id=${literal(b.uid)} and request_id=${literal(live)}; select private.ai_expire(${literal(b.uid)},clock_timestamp(),100);`);
    mark('switch-refuses-a-held-charge');
    const expired = randomUUID();
    need((await claim(b, expired, V4)).claimed === true);
    await sql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
      where owner_id=${literal(b.uid)} and request_id=${literal(expired)}; select private.ai_expire(${literal(b.uid)},clock_timestamp(),100);`);
    const heldRow = await usageRow(b, expired);
    equal(heldRow.charge_state, 'held');
    const heldMessage = await attempt('rollback');
    need(heldMessage.startsWith('BLOCKED: reserved or held charge exists'));
    equal(await usageRow(b, expired), heldRow);
    await sql(`delete from private.ai_usage where owner_id=${literal(b.uid)} and charge_state in ('reserved','held');
      delete from private.ai_requests where owner_id=${literal(b.uid)};`);
    mark('switch-rollback');
    equal(await attempt('rollback'), 'OK');
    equal(await controlsRow(b), { ...start });
    const consent = (await snapshot.client.rows(b, 'profiles'))[0];
    need(consent.ai_enabled === true && consent.ai_notice_revision === 2);
  } finally {
    await restoreControls(sql, b, original);
  }
}
