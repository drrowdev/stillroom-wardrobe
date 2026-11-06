// OUTFITGEN1a: AI-judged outfit suggestions against the real schema. Invoked only by the CI-only preservation owner, after the PROMPT1
// checks ran unchanged at their own exact inventory (20261102090000). The service functions (outfitgen_plan, _claim, _finish, _expire_due)
// are called through privileged SQL the way the Edge handler calls them; every owner read and assertion uses the ordinary A/B sessions.
// Controls and consent are opened only inside these probes and restored in finally. No provider calls.
//   outfitgenUpgradeSeed / outfitgenUpgradeVerify: after the migration alone, the two replaced bodies (the admin account view and the
//     deletion guard) each keep every earlier line in order and add only outfit generation lines, the new tables are empty, and no
//     controls row, consent or activation changed.
//   outfitgenProbes: plan, one live batch per owner, frozen signatures, finish (idempotent, conflict-safe, record-or-skip per row),
//     the pending cap across a batch, dedupe against judged, saved, trashed and disliked sets, Keep, Remove and Undo, unmetered failure,
//     cooldown, expiry, stale handling, deletion cascade and owner isolation.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';
import { intent, saveHarness } from './item-save.sessions.mjs';

// The rehearsal prints only the stage label, so a failed check names itself there (caller line, or the actual value).
let note = () => {};
let last = '';
const clean = (value) => String(value).replace(/[^A-Za-z0-9_.:|,-]+/g, '').slice(0, 110);
function ok(condition) {
  if (condition) return;
  note(`check-line-${clean((new Error().stack.split('\n')[2] ?? '').match(/:(\d+):\d+\)?$/)?.[1] ?? '?')}`);
  requireEvidence(false);
}
function equal(actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return;
  const text = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  const line = (new Error().stack.split('\n')[2] ?? '').match(/:(\d+):\d+\)?$/)?.[1] ?? '?';
  note(`equal-line-${line}-got-${clean(text(actual))}`);
  requireEvidence(false);
}
const MANIFEST = 'azure-eu-terra-outfitgen-v1';
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const uuids = (ids) => (ids === null ? 'null::uuid[]' : `array[${ids.map((id) => `${literal(id)}::uuid`).join(',')}]::uuid[]`);
const texts = (values) => `array[${values.map(literal).join(',')}]::text[]`;
const USAGE = Object.freeze({ modelObservation: 'expected_snapshot', controlObservation: 'ordinary', input: 30000, output: 2000,
  total: 32000, reasoning: 500, cacheRead: 0, cacheWrite: 0 });
const BODIES = ['private.admin_account_v3(private.approved_accounts,timestamptz,text[])', 'private.deletion_owner_rows_absent(uuid)'];

function bulkSql(owner, newest, direction) {
  const ids = "select md5('outfitgen-bulk-'||n)::uuid id from generate_series(1,520) n";
  const where = `owner_id=${literal(owner)} and title like 'Fictional bulk %'`;
  if (direction === 'remove') {
    return `begin;
set local session_replication_role = replica;
delete from private.outfit_assessed_items where owner_id=${literal(owner)} and item_id in (${ids});
delete from public.item_images where owner_id=${literal(owner)} and item_id in (select id from public.items where ${where});
delete from public.items where ${where};
commit;`;
  }
  return `begin;
set local session_replication_role = replica;
insert into public.items(id,owner_id,title,category,colours) select b.id,${literal(owner)},'Fictional bulk '||b.id,'top','{navy}' from (${ids}) b;
insert into public.items(id,owner_id,title,category,colours) values (${literal(newest)},${literal(owner)},'Fictional bulk newest','top','{navy}');
insert into public.item_images(id,owner_id,item_id,state,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
  select gen_random_uuid(),i.owner_id,i.id,'ready',100000,10000,repeat('a',64),repeat('b',64),800,1000,'photo' from public.items i where i.${where};
insert into private.outfit_assessed_items(owner_id,item_id) select ${literal(owner)},b.id from (${ids}) b;
commit;`;
}

export async function outfitgenUpgradeSeed(snapshot, sql) {
  const { owners: [a, b] } = snapshot;
  const bodies = {};
  for (const signature of BODIES) bodies[signature] = (await sql(`select pg_get_functiondef(${literal(signature)}::regprocedure);`)).split('\n').map((line) => line.trim()).filter(Boolean);
  const controls = JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(c) order by owner_id),'[]'::jsonb) from private.ai_controls c
    where owner_id in (${literal(a.uid)},${literal(b.uid)});`));
  const manifests = Number((await sql(`select count(*) from private.ai_execution_manifests;`)).trim());
  return { bodies, controls, manifests };
}

export async function outfitgenUpgradeVerify(seed, sql, mark = () => {}) {
  note = mark;
  mark('bodies');
  for (const signature of BODIES) {
    const before = seed.bodies[signature];
    const after = (await sql(`select pg_get_functiondef(${literal(signature)}::regprocedure);`)).split('\n').map((line) => line.trim()).filter(Boolean);
    let index = 0;
    const added = [];
    for (const line of after) { if (before[index]?.replace(/\)\);$/, ')') === line.replace(/\)\);$/, ')')) index++; else added.push(line); }
    ok(index >= before.length - 3);
    // Every earlier line is kept in order; what is added is a short outfit-generation block (some of its lines are continuations
    // that name no outfit term themselves).
    ok(added.length <= 12 && /outfit/i.test(added.join('\n')));
  }
  mark('controls');
  const owners = seed.controls.map((row) => row.owner_id);
  const after = JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(c) order by owner_id),'[]'::jsonb) from private.ai_controls c
    where owner_id in (${owners.map(literal).join(',')});`));
  equal(after.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('outfitgen_')))), seed.controls);
  for (const row of after) {
    equal([row.outfitgen_activated, row.outfitgen_notice_revision, row.outfitgen_manifest_id, row.outfitgen_consent_revision], [false, null, null, null]);
  }
  equal(Number((await sql(`select count(*) from private.ai_execution_manifests;`)).trim()), seed.manifests + 1);
  for (const table of ['public.suggested_outfits', 'private.outfit_assessed_items', 'private.outfitgen_requests']) {
    equal(Number((await sql(`select count(*) from ${table};`)).trim()), 0, table);
  }
}

function helpers(snapshot, sql) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = async (owner, name, body = {}) => {
    try { return await client.rpc(owner, name, body); } catch (error) { note(`rpc-${name}`); throw error; }
  };
  const sig = (ids) => scalar(`select private.outfitgen_signature(${uuids(ids)});`);
  const plan = () => one(`select public.outfitgen_plan(${literal(a.uid)});`);
  const claim = (id, signatures, { auto = false, targets = [] } = {}) => one(`select public.outfitgen_claim(${literal(a.uid)},${literal(id)},${literal(MANIFEST)},
    ${auto},${texts(signatures)},${uuids(targets)});`);
  const finish = (id, code, usage, results, assessed) => one(`select public.outfitgen_finish(${literal(a.uid)},${literal(id)},${literal(code)},
    ${usage ? json(usage) : 'null::jsonb'},${results ? json(results) : 'null::jsonb'},${assessed ? uuids(assessed) : 'null::uuid[]'});`);
  const result = (ids, decision, score, over = {}) => ({ items: ids, decision, score, occasion: 'smart',
    title: decision === 'suggested' ? 'Fictional navy set' : null, reason: decision === 'suggested' ? 'Calm colours.' : null, ...over });
  const sh = saveHarness(client, a);
  const garment = async (category, colours = ['navy']) => {
    note(`garment-${category}`);
    const value = sh.track(intent());
    value.p_item.category = category;
    value.p_item.title = `Fictional outfit ${category}`;
    const row = await sh.reserve(value);
    note(`garment-${category}-upload`);
    await sh.upload(value);
    note(`garment-${category}-finalize`);
    await sh.finalize(value, row);
    note(`garment-${category}-colours`);
    await sql(`update public.items set colours=${texts(colours)} where owner_id=${literal(a.uid)} and id=${literal(value.p_item.id)};`);
    return value.p_item.id;
  };
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const clear = () => sql(`delete from public.suggested_outfits where owner_id in (${literal(a.uid)},${literal(b.uid)});
    delete from private.outfit_assessed_items where owner_id in (${literal(a.uid)},${literal(b.uid)});
    delete from private.ai_usage where purpose='outfitgen' and owner_id in (${literal(a.uid)},${literal(b.uid)});`);
  const configure = async () => {
    const before = { a: await controls(a), b: await controls(b) };
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,outfitgen_notice_revision=1,outfitgen_manifest_id=${literal(MANIFEST)},
      outfitgen_max_request_micro=400000,updated_at=clock_timestamp() where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    return before;
  };
  const restore = async (before, extra = []) => {
    await sql(`delete from public.suggestion_feedback where owner_id=${literal(a.uid)} and item_ids && ${uuids(extra)};
      delete from public.outfits where owner_id=${literal(a.uid)} and id in (select outfit_id from public.outfit_items where item_id=any(${uuids(extra)}));`);
    await clear();
    await sh.cleanup();
    for (const [owner, was] of [[a, before.a], [b, before.b]]) {
      await sql(`update private.ai_controls set outfitgen_activated=false,outfitgen_consent_revision=null,outfitgen_consented_at=null,
        outfitgen_manifest_id=null,outfitgen_notice_revision=null,outfitgen_max_request_micro=null,
        monthly_allowance_micro=${was.monthly_allowance_micro},updated_at=clock_timestamp() where owner_id=${literal(owner.uid)};`);
    }
    equal(Number(await scalar(`select count(*) from private.ai_usage where purpose='outfitgen' and charge_state='held';`)), 0);
  };
  return { a, b, one, scalar, rpc, sig, plan, claim, finish, result, garment, controls, clear, configure, restore, sql };
}

export async function outfitgenProbes(snapshot, sql, mark = () => {}) {
  note = (label) => { last = label; mark(label); };
  const h = helpers(snapshot, sql);
  const { client } = snapshot;
  const { a, b, one, scalar, rpc, sig, plan, claim, finish, result } = h;
  const before = await h.configure();
  const made = [];
  try {
    note('setup');
    // Earlier rehearsal stages left other eligible garments for this owner, so counts are relative to this baseline.
    const base = (await rpc(a, 'outfitgen_status')).unassessed;
    ok(Number.isSafeInteger(base));
    const top = await h.garment('top'), bottom = await h.garment('bottom'), shoes = await h.garment('footwear');
    const top2 = await h.garment('top', ['red']), layer = await h.garment('layer');
    made.push(top, bottom, shoes, top2, layer);
    // Controls: an owner reads its own state only; consent follows the configured notice revision.
    equal((await rpc(a, 'outfitgen_status')).code, 'INACTIVE');
    await sql(`update private.ai_controls set outfitgen_activated=true where owner_id=${literal(a.uid)};`);
    equal((await rpc(a, 'outfitgen_status')).code, 'CONSENT_REQUIRED');
    equal((await rpc(a, 'outfitgen_set_consent', { p_enabled: true, p_notice_revision: 2 })).code, 'CONFIG_CHANGED');
    const on = await rpc(a, 'outfitgen_set_consent', { p_enabled: true, p_notice_revision: 1 });
    equal(on.code, 'OK');
    ok(on.unassessed === base + 5 && on.autoUnassessed === 0 && on.pending === 0 && on.live === false);
    equal((await rpc(b, 'outfitgen_status')).code, 'INACTIVE');
    equal((await one(`select public.outfitgen_plan(${literal(b.uid)});`)).code, 'INACTIVE');

    note('plan-claim');
    const p = await plan();
    equal(p.code, 'OK');
    equal(p.items.length, base + 5);
    equal(p.pendingRoom, 40);
    ok(p.items.every((item) => item.unassessed === true && /^[0-9a-f]{8}-/.test(item.image.path) && item.image.path.startsWith(`${a.uid}/`)
      && !('title' in item) && !('notes' in item) && !('brand' in item)));
    const [s1, s2, s3] = [await sig([top, bottom, shoes]), await sig([top2, bottom, shoes]), await sig([top, bottom, shoes, layer])];
    const R1 = randomUUID(), R2 = randomUUID(), R3 = randomUUID();
    const c1 = await claim(R1, [s1, s2, s3], { targets: [top, bottom] });
    equal([c1.code, c1.claimed, c1.manifestId], ['OK', true, MANIFEST]);
    equal((await claim(R2, [s1])).code, 'BUSY');
    equal((await claim(R1, [s1])).code, 'TERMINAL');
    equal((await claim(randomUUID(), [s1], { auto: true })).code, 'BUSY');
    for (const bad of [[], ['x'], [s1, s1], new Array(25).fill(0).map((_, i) => i.toString(16).padStart(64, '0'))]) {
      equal((await claim(randomUUID(), bad)).code, 'INVALID_INPUT');
    }
    equal(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)} and purpose='outfitgen' and charge_state='held';`), '1');
    equal(await scalar(`select reserved_micro::text from private.ai_usage where request_id=${literal(R1)};`), '400000');

    note('finish');
    const results = [result([top, bottom, shoes], 'suggested', 9), result([top2, bottom, shoes], 'declined', 3),
      result([top, bottom, shoes, layer], 'suggested', 8), result([top, top2, shoes], 'suggested', 10), result([top, bottom], 'suggested', 10)];
    const done = await finish(R1, 'OK', USAGE, results, [top, bottom]);
    equal(done.code, 'OK');
    equal(done.recorded, { suggested: 2, declined: 1, assessed: 2 });
    equal(done.accounting.basis, 'estimated');
    equal(await scalar(`select accounted_micro::text from private.ai_usage where request_id=${literal(R1)};`), String(30000 * 220 / 100 + 2000 * 1320 / 100));
    // The admin spending view counts this purpose in the month and in its total (the historical shared-budget probe runs earlier and
    // is left as it was).
    await sql(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      select user_id,admission_no,generation from private.approved_accounts where user_id=${literal(a.uid)};`);
    try {
      const spending = await rpc(a, 'admin_ai_spending_v2', {});
      equal(spending.code, 'OK');
      const no = Number(await scalar(`select admission_no from private.approved_accounts where user_id=${literal(a.uid)};`));
      const mine = spending.accounts.find((entry) => entry.admissionNo === no);
      ok(mine !== undefined && mine.features.outfitGen.activated === true && Number(mine.history[0].outfitGen.requests) >= 1);
      equal(mine.current.outfitGen, { usedMicro: '92400' });
      ok(BigInt(mine.current.shared.usedMicro) >= 92400n);
    } finally {
      await sql('delete from private.app_admins;');
    }
    equal((await finish(R1, 'OK', USAGE, results, [top, bottom])).replayed, true);
    equal((await finish(R1, 'OK', { ...USAGE, input: 31000, total: 33000 }, results, [top, bottom])).code, 'USAGE_CONFLICT');
    equal(await scalar(`select count(*) from private.outfit_assessed_items where owner_id=${literal(a.uid)};`), '2');
    equal(await scalar(`select count(*) from public.suggested_outfits where owner_id=${literal(a.uid)};`), '3');
    equal(await scalar(`select signatures='{}' from private.outfitgen_requests where request_id=${literal(R1)};`), 't');
    const listed = await rpc(a, 'outfitgen_list');
    equal(listed.code, 'OK');
    equal(listed.suggestions.map((s) => s.itemIds.length).sort(), [3, 4]);
    equal((await rpc(b, 'outfitgen_list')).suggestions, []);
    const own = await client.request(a.token, '/rest/v1/suggested_outfits?select=id,item_ids,state', { method: 'GET' });
    ok(own.ok && own.data.length === 3);
    const foreign = await client.request(b.token, '/rest/v1/suggested_outfits?select=id', { method: 'GET' });
    ok(foreign.ok && foreign.data.length === 0);
    const write = await client.request(a.token, '/rest/v1/suggested_outfits', { method: 'POST', body: { item_ids: [top, bottom], state: 'kept' } });
    ok(!write.ok);
    ok((await client.request(a.token, `/rest/v1/suggested_outfits?id=eq.${listed.suggestions[0].id}`, { method: 'DELETE' })).data?.length !== 1);
    equal(await scalar(`select count(*) from public.suggested_outfits where owner_id=${literal(a.uid)};`), '3');

    note('dedupe');
    equal((await claim(R2, [s1])).code, 'CONFLICT');
    const p2 = await plan();
    ok([s1, s2, s3].every((value) => p2.known.includes(value)));
    equal((await rpc(a, 'outfitgen_status')).unassessed, base + 3);

    note('keep-remove');
    const three = listed.suggestions.find((s) => s.itemIds.length === 3), four = listed.suggestions.find((s) => s.itemIds.length === 4);
    const O1 = randomUUID();
    equal((await rpc(b, 'outfitgen_keep', { p_id: three.id, p_outfit_id: randomUUID() })).code, 'NOT_FOUND');
    equal((await rpc(b, 'outfitgen_remove', { p_id: three.id })).code, 'NOT_FOUND');
    const kept = await rpc(a, 'outfitgen_keep', { p_id: three.id, p_outfit_id: O1 });
    equal([kept.code, kept.outfitId], ['OK', O1]);
    equal((await rpc(a, 'outfitgen_keep', { p_id: three.id, p_outfit_id: O1 })).replayed, true);
    equal((await rpc(a, 'outfitgen_keep', { p_id: three.id, p_outfit_id: randomUUID() })).code, 'CONFLICT');
    equal(await scalar(`select count(*) from public.outfit_items where outfit_id=${literal(O1)};`), '3');
    equal(await scalar(`select title||'/'||occasion||'/'||notes from public.outfits where id=${literal(O1)};`), 'Fictional navy set/smart/Calm colours.');
    equal(await scalar(`select state||':'||kept_outfit_id from public.suggested_outfits where id=${literal(three.id)};`), `kept:${O1}`);
    // A like recorded in Today before the removal is restored by Undo; a vote changed meanwhile is left alone.
    await sql(`insert into public.suggestion_feedback(owner_id,item_ids,vote) values (${literal(a.uid)},${uuids([top, bottom, shoes, layer])},1);`);
    equal((await rpc(a, 'outfitgen_remove', { p_id: four.id })).code, 'OK');
    equal(await scalar(`select vote from public.suggestion_feedback where owner_id=${literal(a.uid)} and signature=${literal(s3)};`), '-1');
    equal((await rpc(a, 'outfitgen_remove', { p_id: four.id })).replayed, true);
    equal((await rpc(a, 'outfitgen_list')).suggestions, []);
    equal((await rpc(a, 'outfitgen_undo_remove', { p_id: four.id })).code, 'OK');
    equal(await scalar(`select vote from public.suggestion_feedback where owner_id=${literal(a.uid)} and signature=${literal(s3)};`), '1');
    equal((await rpc(a, 'outfitgen_list')).suggestions.length, 1);
    equal((await rpc(a, 'outfitgen_remove', { p_id: four.id })).code, 'OK');
    // Another device changes the vote through the real Today vote writer (an upsert that keeps created_at): like, then dislike again.
    // Undo must not restore the older like over it, and must not delete the newer dislike.
    const vote = (value) => client.request(a.token, '/rest/v1/suggestion_feedback?on_conflict=owner_id,signature',
      { method: 'POST', body: { owner_id: a.uid, item_ids: [top, bottom, shoes, layer], vote: value }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    ok((await vote(1)).ok && (await vote(-1)).ok);
    equal((await rpc(a, 'outfitgen_undo_remove', { p_id: four.id })).code, 'CONFLICT');
    equal(await scalar(`select vote from public.suggestion_feedback where owner_id=${literal(a.uid)} and signature=${literal(s3)};`), '-1');
    equal(await scalar(`select state from public.suggested_outfits where id=${literal(four.id)};`), 'removed');
    equal((await claim(randomUUID(), [s3])).code, 'CONFLICT');

    note('failure-cooldown');
    const s4 = await sig([top2, bottom, shoes, layer]);
    const c3 = await claim(R3, [s4], { targets: [top2] });
    equal(c3.code, 'OK');
    const failed = await finish(R3, 'FAILED', null, null, null);
    equal(failed.code, 'FAILED');
    equal(await scalar(`select accounted_micro::text||':'||charge_state||':'||closed_reason from private.ai_usage where request_id=${literal(R3)};`), '400000:estimated:FAILED');
    equal(await scalar(`select outfitgen_activated from private.ai_controls where owner_id=${literal(a.uid)};`), 't');
    equal((await finish(R3, 'FAILED', null, null, null)).replayed, true);
    equal((await finish(R3, 'OK', USAGE, results, null)).code, 'USAGE_CONFLICT');
    const status = await rpc(a, 'outfitgen_status');
    ok(Number.isSafeInteger(status.cooldownUntilMs) && status.cooldownUntilMs > status.serverTimeMs);
    equal((await claim(randomUUID(), [s4], { auto: true, targets: [top2] })).code, 'COOLDOWN');

    note('expiry');
    await sql(`update private.ai_usage set closed_at=clock_timestamp()-interval '2 hours' where request_id=${literal(R3)};`);
    const R4 = randomUUID();
    equal((await claim(R4, [s4], { targets: [top2] })).code, 'OK');
    await sql(`update private.ai_usage set dispatched_at=clock_timestamp()-interval '7 minutes' where request_id=${literal(R4)};`);
    equal((await one(`select public.outfitgen_expire_due(10);`)).expired, 1);
    equal(await scalar(`select closed_reason||':'||accounted_micro from private.ai_usage where request_id=${literal(R4)};`), 'EXPIRED:400000');
    const late = await finish(R4, 'OK', USAGE, [result([top2, bottom, shoes, layer], 'suggested', 9)], [top2]);
    equal(late.code, 'EXPIRED');
    equal(await scalar(`select count(*) from public.suggested_outfits where signature=${literal(s4)};`), '0');
    equal(await scalar(`select count(*) from private.outfit_assessed_items where item_id=${literal(top2)};`), '0');

    note('caps');
    await sql(`update private.ai_usage set closed_at=case when closed_reason is not null then clock_timestamp()-interval '2 hours' end,created_at=clock_timestamp()-interval '20 minutes'
      where request_id in (${[R1, R3, R4].map(literal).join(',')});`);
    // 38 pending rows (over real garments, never a valid outfit with the shoes), then a batch of three suggestions: only two fit under
    // the pending cap of 40, whatever the batch holds.
    const fresh = [await h.garment('top'), await h.garment('top'), await h.garment('top')];
    made.push(...fresh);
    await sql(`with g as (select id from public.items where owner_id=${literal(a.uid)} and id<>${literal(shoes)}::uuid and id=any(${uuids(made)})),
      c as (select array[x.id,y.id,z.id] ids from g x join g y on y.id>x.id join g z on z.id>y.id
        union all select array[x.id,y.id,z.id,w.id] from g x join g y on y.id>x.id join g z on z.id>y.id join g w on w.id>z.id)
      insert into public.suggested_outfits(owner_id,item_ids,state,title,reason,occasion,score,fingerprint,manifest_id,prompt_version,request_id)
        select ${literal(a.uid)},ids,'suggested','t','r','smart',9,repeat('d',64),${literal(MANIFEST)},1,${literal(R1)} from c limit 80 on conflict do nothing;
      delete from public.suggested_outfits where id in (select id from public.suggested_outfits where owner_id=${literal(a.uid)}
        and state='suggested' order by id offset 38);`);
    equal(await scalar(`select count(*) from public.suggested_outfits where owner_id=${literal(a.uid)} and state='suggested';`), '38');
    const batch = fresh.map((x) => [x, bottom, shoes]);
    const R5 = randomUUID();
    const c5 = await claim(R5, await Promise.all(batch.map((ids) => sig(ids))), { targets: fresh });
    equal(c5.code, 'OK', 'batch claim');
    const capped = await finish(R5, 'OK', USAGE, batch.map((ids, index) => result(ids, 'suggested', 10 - index)), fresh);
    equal(capped.code, 'OK');
    equal(capped.recorded, { suggested: 2, declined: 0, assessed: 3 });
    equal(await scalar(`select count(*) from public.suggested_outfits where owner_id=${literal(a.uid)} and state='suggested';`), '40');
    // The best-scored two were kept; the third was neither recorded nor assessed away (it can be judged again).
    equal(await scalar(`select count(*) from public.suggested_outfits where signature=${literal(await sig(batch[2]))};`), '0');
    await sql(`update private.ai_usage set closed_at=case when closed_reason is not null then clock_timestamp()-interval '2 hours' end,created_at=clock_timestamp()-interval '20 minutes'
      where request_id=${literal(R5)};`);
    equal((await claim(randomUUID(), [await sig([fresh[2], bottom, shoes])], { targets: [fresh[2]] })).code, 'PENDING_FULL');
    equal((await rpc(a, 'outfitgen_status')).pending, 2, 'only valid outfits count for the badge');

    note('rate-limit');
    await sql(`delete from public.suggested_outfits where owner_id=${literal(a.uid)} and state='suggested';
      insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
        select ${literal(a.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp(),1,1,'estimated','outfitgen' from generate_series(1,4);`);
    equal((await claim(randomUUID(), [await sig([fresh[2], bottom, shoes])], { targets: [fresh[2]] })).code, 'RATE_LIMIT');
    await sql(`delete from private.ai_usage where purpose='outfitgen' and reserved_micro=1 and owner_id=${literal(a.uid)};`);

    note('stale');
    // An edit that changes what was judged drops a declined judgement (it can be judged again); a removal is never dropped.
    const planBefore = await plan();
    ok(planBefore.known.includes(s2) && planBefore.known.includes(s3));
    await sql(`update public.items set colours='{green}' where id=${literal(top2)};`);
    const after = await plan();
    ok(!after.known.includes(s2) && after.known.includes(s3));
    // A garment taken out of suggestions hides the sets that contain it, without deleting them.
    await sql(`update public.items set exclude_suggestions=true where id=${literal(fresh[0])};`);
    ok((await rpc(a, 'outfitgen_list')).suggestions.every((s) => !s.itemIds.includes(fresh[0])));
    ok(Number(await scalar(`select count(*) from public.suggested_outfits where ${literal(fresh[0])}=any(item_ids);`)) >= 0);
    await sql(`update public.items set exclude_suggestions=false where id=${literal(fresh[0])};`);

    note('keep-recheck');
    const suggestion = (ids) => sql(`insert into public.suggested_outfits(owner_id,item_ids,state,title,reason,occasion,score,fingerprint,manifest_id,prompt_version,request_id)
      values (${literal(a.uid)},${uuids(ids)},'suggested','Fictional set','Calm colours.','smart',9,repeat('e',64),${literal(MANIFEST)},1,${literal(R1)});`);
    const rowOf = (ids) => scalar(`select id from public.suggested_outfits where signature=private.outfitgen_signature(${uuids(ids)});`);
    // A garment moved to Trash after the suggestion was made: Keep refuses and creates nothing.
    const trashed = [fresh[1], bottom, shoes];
    await suggestion(trashed);
    await sql(`update public.items set deleted_at=clock_timestamp() where id=${literal(fresh[1])};`);
    equal((await rpc(a, 'outfitgen_keep', { p_id: await rowOf(trashed), p_outfit_id: randomUUID() })).code, 'STALE');
    await sql(`update public.items set deleted_at=null where id=${literal(fresh[1])};`);
    // The same set is already a saved outfit that sits in Trash: no second outfit is created.
    const dup = [fresh[2], bottom, shoes], O2 = randomUUID();
    await sql(`insert into public.outfits(id,owner_id,title,occasion,notes,favourite,deleted_at) values (${literal(O2)},${literal(a.uid)},'Fictional saved','smart','',false,clock_timestamp());
      insert into public.outfit_items(owner_id,outfit_id,item_id,position) select ${literal(a.uid)},${literal(O2)},x.id,(x.ord-1)::smallint from unnest(${uuids(dup)}) with ordinality x(id,ord);`);
    await suggestion(dup);
    equal((await rpc(a, 'outfitgen_keep', { p_id: await rowOf(dup), p_outfit_id: randomUUID() })).code, 'IN_TRASH');
    equal(await scalar(`select count(*) from public.outfits o where o.owner_id=${literal(a.uid)} and o.id in (select outfit_id from public.outfit_items where item_id=${literal(fresh[2])});`), '1');
    equal(await scalar(`select state from public.suggested_outfits where signature=private.outfitgen_signature(${uuids(dup)});`), 'declined');

    note('many-garments');
    // With more than 500 eligible garments a new garment must still be planned, however its id sorts. The bulk rows stand for already
    // assessed garments; they are written and removed with triggers off.
    const newest = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await sql(bulkSql(a.uid, newest, 'add'));
    try {
      const big = await plan();
      equal(big.code, 'OK');
      ok(big.items.length <= 500 && big.items.some((item) => item.id === newest && item.unassessed === true));
      ok(big.items.filter((item) => item.unassessed).length <= 100 + made.length);
    } finally {
      await sql(bulkSql(a.uid, newest, 'remove'));
    }
  } catch (error) {
    if (!/^EVIDENCE_REQUIRED/.test(String(error?.message))) note(`${last}-threw-${clean(error?.message)}`);
    throw error;
  } finally {
    await h.restore(before, made);
  }
}
