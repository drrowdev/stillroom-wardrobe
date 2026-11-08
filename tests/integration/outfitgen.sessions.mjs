// OUTFITGEN1a: AI-judged outfit suggestions against the real schema. Invoked only by the CI-only preservation owner, after the PROMPT1
// checks ran unchanged at their own exact inventory (20261102090000). The service functions (outfitgen_plan, _claim, _finish, _expire_due)
// are called through privileged SQL the way the Edge handler calls them; every owner read and assertion uses the ordinary A/B sessions.
// Controls and consent are opened only inside these probes and restored in finally. No provider calls.
//   outfitgenUpgradeSeed / outfitgenUpgradeVerify: after the migration alone, the two replaced bodies (the admin account view and the
//     deletion guard) each keep every earlier line in order and add only outfit generation lines, the new tables are empty, and no
//     controls row, consent or activation changed.
//   outfitgenProbes: plan, one live batch per owner, frozen signatures, finish (idempotent, conflict-safe, record-or-skip per row),
//     the pending cap across a batch, dedupe against judged, saved, trashed and disliked sets, Keep, Remove and Undo, unmetered failure,
//     cooldown, expiry, stale handling, call limits per mode (OUTFITGEN3-B2), deletion cascade and owner isolation.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
const CLAIM = 'public.outfitgen_claim(uuid,uuid,text,boolean,text[],uuid[])';
const FINISH = 'public.outfitgen_finish(uuid,uuid,text,jsonb,jsonb,uuid[])';

// OUTFITGEN3-B2: the claim's call limits (manual 40 / 10 min, 120 / hour, 200 / rolling day; automatic 4 / 6 / 40), counted per owner and
// mode, and the safety the replaced claim body must keep. Rows are seeded with privileged SQL in the shape a settled claim leaves
// (an ai_usage row and its outfitgen_requests row, with a chosen age); claims go through the real function the way the Edge handler calls it.
// Everything created here is removed in finally; the earlier probes' own rows (keep) are only moved back in time.
async function rateLimitProbes(h, { keep, signature, client }) {
  const { a, b, one, scalar, sql, rpc, finish } = h;
  const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const claimBy = (owner, id, auto = false) => one(`select public.outfitgen_claim(${literal(owner.uid)},${literal(id)},${literal(MANIFEST)},
    ${auto},${texts([signature])},${uuids([])});`);
  const code = async (owner, auto = false) => (await claimBy(owner, randomUUID(), auto)).code;
  const seed = (owner, mode, count, age, reason = null) => sql(`with u as (
      insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose,closed_reason,closed_at)
        select ${literal(owner.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp()-interval '${age}',1,1,'estimated','outfitgen',
          ${reason ? `${literal(reason)}::text` : 'null::text'},${reason ? `clock_timestamp()-interval '${age}'` : 'null::timestamptz'} from generate_series(1,${count})
        returning owner_id,request_id,created_at)
      insert into private.outfitgen_requests(owner_id,request_id,mode,signatures,target_items,created_at)
        select owner_id,request_id,${literal(mode)},'{}'::text[],'{}'::uuid[],created_at from u;`);
  const seedUsage = (owner, id, age, mode) => sql(`with u as (
      insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
        values (${literal(owner.uid)},${literal(id)},to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp()-interval '${age}',1,1,'estimated','outfitgen')
        returning owner_id,request_id,created_at)
      insert into private.outfitgen_requests(owner_id,request_id,mode,signatures,target_items,created_at)
        select owner_id,request_id,${literal(mode)},'{}'::text[],'{}'::uuid[],created_at from u;`);
  const both = `${literal(a.uid)},${literal(b.uid)}`;
  const kept = keep.length ? keep.map(literal).join(',') : "'00000000-0000-0000-0000-000000000000'";
  const wipe = () => sql(`delete from private.ai_usage where purpose='outfitgen' and owner_id in (${both}) and request_id not in (${kept});
    delete from private.ai_usage where purpose='stylist' and reserved_micro=1001 and owner_id in (${both});`);
  const counts = async (owner) => (await scalar(`select (select count(*) from private.ai_usage where owner_id=${literal(owner.uid)})||'/'||
    (select count(*) from private.ai_usage_evidence where owner_id=${literal(owner.uid)})||'/'||
    (select count(*) from private.outfitgen_requests where owner_id=${literal(owner.uid)});`));
  const was = await h.controls(a);
  try {
    note('rate-source');
    // The installed body is the migration's text, and its properties and grants are those of the other service-only outfit function.
    const migration = await readFile(new URL('../../supabase/migrations/20261108100000_outfitgen_call_limits.sql', import.meta.url), 'utf8');
    const open = migration.indexOf('$$', migration.indexOf('function public.outfitgen_claim('));
    const source = migration.slice(open + 2, migration.indexOf('$$', open + 2));
    equal(lines(await scalar(`select prosrc from pg_proc where oid='${CLAIM}'::regprocedure;`)), lines(source));
    const props = (name) => scalar(`select prosecdef::text||'|'||coalesce(array_to_string(proconfig,','),'')||'|'||pg_get_userbyid(proowner)||'|'||coalesce(proacl::text,'')||'|'||
      prorettype::regtype::text from pg_proc where oid='${name}'::regprocedure;`);
    const claimProps = await props(CLAIM);
    ok(claimProps.startsWith('true|') && claimProps.includes('lock_timeout=2s'));
    equal(claimProps.split('|').slice(0, 3), (await props(FINISH)).split('|').slice(0, 3));
    equal(claimProps.split('|')[3], (await props(FINISH)).split('|')[3]);
    equal(await scalar(`select has_function_privilege('service_role','${CLAIM}','execute')::text||has_function_privilege('authenticated','${CLAIM}','execute')::text||
      has_function_privilege('anon','${CLAIM}','execute')::text||has_function_privilege('public','${CLAIM}','execute')::text;`), 'truefalsefalsefalse');

    note('rate-setup');
    // Earlier probes' claims, if any, would count in the windows below; they are moved two days back.
    if (keep.length) {
      await sql(`update private.ai_usage set created_at=created_at-interval '2 days' where request_id in (${kept});
        update private.outfitgen_requests set created_at=created_at-interval '2 days' where request_id in (${kept});`);
    }
    await sql(`update private.ai_controls set outfitgen_activated=true,outfitgen_consent_revision=2,outfitgen_consented_at=clock_timestamp()
      where owner_id in (${both});`);
    await wipe();

    note('rate-manual');
    // Limit - 1 is admitted, the limit is refused, and a window that has passed no longer counts.
    for (const [label, count, age, expected] of [
      ['ten-39', 39, '1 minute', 'OK'], ['ten-40', 40, '1 minute', 'RATE_LIMIT'], ['ten-passed', 40, '11 minutes', 'OK'],
      ['hour-119', 119, '20 minutes', 'OK'], ['hour-120', 120, '20 minutes', 'RATE_LIMIT'], ['hour-passed', 120, '61 minutes', 'OK'],
      ['day-199', 199, '5 hours', 'OK'], ['day-200', 200, '5 hours', 'RATE_LIMIT'], ['day-passed', 200, '25 hours', 'OK'],
    ]) {
      note(`rate-manual-${label}`);
      await seed(a, 'manual', count, age);
      equal([label, await code(a)], [label, expected]);
      await wipe();
    }
    note('rate-failed-counted');
    // Failed, expired and unavailable claims are still claims: 14 + 13 + 13 closed rows reach the limit.
    await seed(a, 'manual', 14, '1 minute', 'FAILED');
    await seed(a, 'manual', 13, '1 minute', 'EXPIRED');
    await seed(a, 'manual', 13, '1 minute', 'UNAVAILABLE');
    equal(await code(a), 'RATE_LIMIT');
    await wipe();

    note('rate-auto');
    // Automatic keeps 4 / 6 / 40. Its own 3-per-6-hours rule answers COOLDOWN before those limits can be reached with fewer rows.
    for (const [label, count, age, expected] of [
      ['ten-4', 4, '1 minute', 'RATE_LIMIT'], ['ten-3', 3, '1 minute', 'COOLDOWN'], ['ten-2', 2, '1 minute', 'OK'], ['ten-passed', 4, '11 minutes', 'COOLDOWN'],
      ['hour-6', 6, '20 minutes', 'RATE_LIMIT'], ['hour-5', 5, '20 minutes', 'COOLDOWN'], ['day-40', 40, '5 hours', 'RATE_LIMIT'], ['day-39', 39, '5 hours', 'COOLDOWN'],
    ]) {
      note(`rate-auto-${label}`);
      await seed(a, 'auto', count, age);
      equal([label, await code(a, true)], [label, expected]);
      await wipe();
    }

    note('rate-independent');
    // Manual history never consumes automatic calls, and automatic history never consumes manual ones.
    for (const [count, age] of [[40, '1 minute'], [120, '20 minutes'], [200, '5 hours']]) {
      await seed(a, 'manual', count, age);
      equal([count, await code(a), await code(a, true)], [count, 'RATE_LIMIT', 'OK']);
      await wipe();
    }
    await seed(a, 'auto', 4, '1 minute');
    equal([await code(a, true), await code(a)], ['RATE_LIMIT', 'OK']);
    await wipe();

    note('rate-owners');
    // One owner's calls never limit another's, and a request id shared by two owners (the key is owner and request) is classified by its own
    // owner's request row only: A has 39 manual rows plus one auto row under the shared id, B has a manual row under it, so A's manual count stays 39.
    await seed(b, 'manual', 200, '1 minute');
    equal([await code(b), await code(a)], ['RATE_LIMIT', 'OK']);
    await wipe();
    await seed(a, 'manual', 40, '1 minute');
    equal([await code(a), await code(b)], ['RATE_LIMIT', 'OK']);
    await wipe();
    const shared = randomUUID();
    await seed(a, 'manual', 39, '1 minute');
    await seedUsage(a, shared, '1 minute', 'auto');
    await seedUsage(b, shared, '1 minute', 'manual');
    equal(await code(a), 'OK');
    await wipe();
    await seed(a, 'manual', 39, '1 minute');
    await seedUsage(a, shared, '1 minute', 'manual');
    await seedUsage(b, shared, '1 minute', 'auto');
    equal(await code(a), 'RATE_LIMIT');
    await wipe();

    note('rate-unclassified');
    // Recent outfit usage without a request row (never written by the claim) counts as manual, never as automatic.
    await sql(`insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
      select ${literal(a.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp()-interval '1 minute',1,1,'estimated','outfitgen'
      from generate_series(1,40);`);
    equal([await code(a), await code(a, true)], ['RATE_LIMIT', 'OK']);
    await wipe();

    note('rate-purposes');
    // Another purpose's usage never counts toward the outfit limits, however much of it there is. The manual claim is settled successfully
    // (not as a failure, which would start the automatic cooldown) before the automatic one, which would otherwise meet the live batch (BUSY).
    await sql(`insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
      select ${literal(a.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp()-interval '1 minute',1001,1001,'settled','stylist'
      from generate_series(1,200);`);
    const purposeClaim = randomUUID();
    equal((await claimBy(a, purposeClaim)).code, 'OK');
    equal((await finish(purposeClaim, 'OK', USAGE, [], null)).code, 'OK');
    equal(await code(a, true), 'OK');
    await wipe();

    note('rate-sequence');
    // Real claims, far beyond the old 4 in ten minutes and 6 in an hour: 40 are admitted and settle as failures, the 41st is refused,
    // and once the window has passed one is admitted again.
    const ids = [];
    for (let index = 0; index < 40; index++) {
      const id = randomUUID();
      ids.push(id);
      equal([index, (await claimBy(a, id)).code], [index, 'OK']);
      equal([index, (await finish(id, 'FAILED', null, null, null)).code], [index, 'FAILED']);
    }
    equal(await code(a), 'RATE_LIMIT');
    // A manual failure starts the automatic cooldown (any failed outfit call does), without touching the manual limit.
    equal(await code(a, true), 'COOLDOWN');
    const listed = ids.map(literal).join(',');
    await sql(`update private.ai_usage set created_at=created_at-interval '11 minutes' where request_id in (${listed});
      update private.outfitgen_requests set created_at=created_at-interval '11 minutes' where request_id in (${listed});`);
    equal(await code(a), 'OK');
    await wipe();

    note('rate-last-slot');
    // With one slot left, concurrent claims admit exactly one; once it settles the limit is reached and the next claim is refused.
    await seed(a, 'manual', 39, '1 minute');
    const last = await Promise.all([claimBy(a, randomUUID()), claimBy(a, randomUUID())]);
    equal(last.map((entry) => entry.code).sort(), ['BUSY', 'OK']);
    equal(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)} and purpose='outfitgen' and created_at>clock_timestamp()-interval '30 seconds';`), '1');
    const admitted = await scalar(`select request_id from private.ai_usage where owner_id=${literal(a.uid)} and charge_state='held';`);
    equal((await finish(admitted, 'FAILED', null, null, null)).code, 'FAILED');
    equal(await code(a), 'RATE_LIMIT');
    await wipe();

    note('rate-safety');
    // Replay, one live batch, concurrency and the claim's refusals leave exactly the rows they should.
    const live = randomUUID();
    equal((await claimBy(a, live)).code, 'OK');
    const afterLive = await counts(a);
    equal(await code(a), 'BUSY');
    equal((await claimBy(a, live)).code, 'TERMINAL');
    equal(await counts(a), afterLive);
    equal((await finish(live, 'FAILED', null, null, null)).code, 'FAILED');
    await wipe();
    const racers = await Promise.all([claimBy(a, randomUUID()), claimBy(a, randomUUID())]);
    equal(racers.map((racer) => racer.code).sort(), ['BUSY', 'OK']);
    equal(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(a.uid)} and purpose='outfitgen' and charge_state='held';`), '1');
    await wipe();

    note('rate-allowance');
    // The allowance is exact and shared: used + the reservation equal to it is admitted, one micro less is refused with nothing written,
    // and another purpose's spend counts.
    await sql(`insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
      values (${literal(a.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp(),1001,1001,'settled','stylist');`);
    const used = BigInt(await scalar(`select private.ai_budget_used(${literal(a.uid)},clock_timestamp())::bigint;`));
    const max = BigInt(was.outfitgen_max_request_micro);
    await sql(`update private.ai_controls set monthly_allowance_micro=${used + max} where owner_id=${literal(a.uid)};`);
    equal(await code(a), 'OK');
    await wipe();
    await sql(`insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
      values (${literal(a.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp(),1001,1001,'settled','stylist');
      update private.ai_controls set monthly_allowance_micro=${used + max - 1n} where owner_id=${literal(a.uid)};`);
    const before = await counts(a);
    equal(await code(a), 'ALLOWANCE');
    equal(await counts(a), before);
    await wipe();
    await sql(`update private.ai_controls set monthly_allowance_micro=${was.monthly_allowance_micro} where owner_id=${literal(a.uid)};`);

    note('rate-paused');
    // A paused account is refused by the guard's SQLSTATE and every claim insert rolls back; settlement and expiry still work.
    const held = randomUUID();
    equal((await claimBy(a, held)).code, 'OK');
    await sql(`update private.ai_usage set dispatched_at=clock_timestamp()-interval '7 minutes' where request_id=${literal(held)};
      update private.ai_controls set ai_guard_paused_at=clock_timestamp(),ai_guard_limit_micro=1,ai_guard_window_micro=2 where owner_id=${literal(a.uid)};`);
    const rowsBefore = await counts(a);
    const refused = await scalar(`do $$ begin
      perform public.outfitgen_claim(${literal(a.uid)},${literal(randomUUID())},${literal(MANIFEST)},false,${texts([signature])},${uuids([])});
      raise exception 'NOT REFUSED';
    exception when sqlstate 'AG001' then null; end $$; select 'REFUSED';`);
    ok(refused.endsWith('REFUSED'));
    equal(await counts(a), rowsBefore);
    equal((await one(`select public.outfitgen_expire_due(10);`)).expired, 1);
    equal((await finish(held, 'OK', USAGE, [], null)).code, 'EXPIRED');
    const settled = randomUUID();
    await sql(`update private.ai_controls set ai_guard_paused_at=null,ai_guard_limit_micro=null,ai_guard_window_micro=null where owner_id=${literal(a.uid)};`);
    equal((await claimBy(a, settled)).code, 'OK');
    await sql(`update private.ai_controls set ai_guard_paused_at=clock_timestamp(),ai_guard_limit_micro=1,ai_guard_window_micro=2 where owner_id=${literal(a.uid)};`);
    equal((await finish(settled, 'FAILED', null, null, null)).code, 'FAILED');
    await sql(`update private.ai_controls set ai_guard_paused_at=null,ai_guard_limit_micro=null,ai_guard_window_micro=null where owner_id=${literal(a.uid)};`);
    await wipe();

    note('rate-consent');
    // Withdrawn consent refuses with nothing written; consenting again admits.
    await rpc(a, 'outfitgen_set_consent', { p_enabled: false, p_notice_revision: null });
    const withdrawn = await counts(a);
    equal(await code(a), 'CONSENT_REQUIRED');
    equal(await counts(a), withdrawn);
    equal((await rpc(a, 'outfitgen_set_consent', { p_enabled: true, p_notice_revision: 2 })).code, 'OK');
    equal(await code(a), 'OK');
    await wipe();

    note('rate-denied');
    // An ordinary session cannot call the service-only claim, whatever it sends.
    const unchanged = await counts(a);
    const denied = await client.request(a.token, '/rest/v1/rpc/outfitgen_claim', { method: 'POST', body: { p_owner_id: a.uid, p_request_id: randomUUID(),
      p_manifest_id: MANIFEST, p_auto: false, p_signatures: [signature], p_targets: [] } });
    ok(!denied.ok && denied.status === 403);
    equal(await counts(a), unchanged);
  } finally {
    await sql(`update private.ai_controls set ai_guard_paused_at=null,ai_guard_limit_micro=null,ai_guard_window_micro=null,
      monthly_allowance_micro=${was.monthly_allowance_micro} where owner_id=${literal(a.uid)};`);
    await wipe();
  }
}

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
insert into public.items(id,owner_id,title,category,colours,created_at) select md5('outfitgen-old-'||n)::uuid,${literal(owner)},'Fictional bulk old '||n,'top','{navy}',clock_timestamp()-interval '30 days' from generate_series(1,120) n;
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
  // The target inventory also carries the AI-GUARD1 migration, whose five nullable columns are not part of this seed.
  equal(after.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('outfitgen_') && !key.startsWith('ai_guard_')))), seed.controls);
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
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,outfitgen_notice_revision=2,outfitgen_manifest_id=${literal(MANIFEST)},
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
    equal((await rpc(a, 'outfitgen_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'CONFIG_CHANGED');
    const on = await rpc(a, 'outfitgen_set_consent', { p_enabled: true, p_notice_revision: 2 });
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
    // The claim limits of this inventory are the original ones (4 / 6 / 40 for every outfit call); the raised manual limits are probed after
    // their own migration (outfitgenLimitProbes).
    await sql(`delete from public.suggested_outfits where owner_id=${literal(a.uid)} and state='suggested';
      insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,purpose)
        select ${literal(a.uid)},gen_random_uuid(),to_char(now() at time zone 'UTC','YYYY-MM'),clock_timestamp(),1,1,'estimated','outfitgen' from generate_series(1,4);`);
    equal((await claim(randomUUID(), [await sig([fresh[2], bottom, shoes])], { targets: [fresh[2]] })).code, 'RATE_LIMIT');
    await sql(`delete from private.ai_usage where purpose='outfitgen' and reserved_micro=1 and owner_id=${literal(a.uid)};`);

    note('undo-capacity');
    // Undo puts a suggestion back among the pending ones, so it respects the same cap of 40: with 41 pending rows, one Remove leaves
    // 40 and its Undo is refused (nothing changes); with room, the Undo works.
    await sql(`with g as (select id from public.items where owner_id=${literal(a.uid)} and id<>${literal(shoes)}::uuid and id=any(${uuids(made)})),
      c as (select array[x.id,y.id,z.id] ids from g x join g y on y.id>x.id join g z on z.id>y.id
        union all select array[x.id,y.id,z.id,w.id] from g x join g y on y.id>x.id join g z on z.id>y.id join g w on w.id>z.id)
      insert into public.suggested_outfits(owner_id,item_ids,state,title,reason,occasion,score,fingerprint,manifest_id,prompt_version,request_id)
        select ${literal(a.uid)},ids,'suggested','capfill','r','smart',9,repeat('c',64),${literal(MANIFEST)},1,${literal(R1)} from c order by random() limit 41;`);
    equal(await scalar(`select count(*) from public.suggested_outfits where owner_id=${literal(a.uid)} and title='capfill';`), '41');
    const capId = await scalar(`select id from public.suggested_outfits where owner_id=${literal(a.uid)} and title='capfill' limit 1;`);
    equal((await rpc(a, 'outfitgen_remove', { p_id: capId })).code, 'OK');
    equal(await scalar(`select count(*) from public.suggested_outfits where owner_id=${literal(a.uid)} and state='suggested';`), '40');
    equal((await rpc(a, 'outfitgen_undo_remove', { p_id: capId })).code, 'PENDING_FULL');
    equal(await scalar(`select state from public.suggested_outfits where id=${literal(capId)};`), 'removed');
    await sql(`delete from public.suggested_outfits where id in (select id from public.suggested_outfits where owner_id=${literal(a.uid)}
      and title='capfill' and state='suggested' limit 1);`);
    equal((await rpc(a, 'outfitgen_undo_remove', { p_id: capId })).code, 'OK');
    await sql(`delete from public.suggestion_feedback where owner_id=${literal(a.uid)} and signature=(select signature from public.suggested_outfits where id=${literal(capId)});
      delete from public.suggested_outfits where owner_id=${literal(a.uid)} and title='capfill';`);

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
      // A backlog of 120 older unassessed garments (added before consent) must not hide the new, auto-eligible one.
      ok(big.items.length <= 500 && big.items.some((item) => item.id === newest && item.unassessed === true && item.auto === true));
      ok(big.items.filter((item) => item.unassessed && !item.auto).length >= 100);
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

const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url);
const claimBodyLines = async (name) => {
  const sqlText = await readFile(new URL(name, MIGRATIONS_DIR), 'utf8');
  const open = sqlText.indexOf('$$', sqlText.indexOf('function public.outfitgen_claim('));
  return sqlText.slice(open + 2, sqlText.indexOf('$$', open + 2)).split('\n').map((line) => line.trim()).filter(Boolean);
};
// The only lines the claim limits migration changes (trimmed): the original rate block and its replacement.
const OLD_RATE_LINES = [
  "select count(*) filter (where created_at>v_now-interval '1 hour'),count(*) filter (where created_at>v_now-interval '1 day'),",
  "count(*) filter (where created_at>v_now-interval '10 minutes') into v_hour,v_day,v_ten",
  "from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen';",
  "if v_hour>=6 or v_day>=40 or v_ten>=4 then return jsonb_build_object('code','RATE_LIMIT','claimed',false); end if;",
];
const NEW_RATE_LINES = [
  "select count(*) filter (where u.created_at>v_now-interval '1 hour'),count(*) filter (where u.created_at>v_now-interval '1 day'),",
  "count(*) filter (where u.created_at>v_now-interval '10 minutes') into v_hour,v_day,v_ten",
  "from private.ai_usage u left join private.outfitgen_requests r on r.owner_id=u.owner_id and r.request_id=u.request_id",
  "where u.owner_id=p.owner_id and u.purpose='outfitgen' and u.created_at>v_now-interval '1 day'",
  "and coalesce(r.mode,'manual')=case when p_auto then 'auto' else 'manual' end;",
  "if (p_auto and (v_hour>=6 or v_day>=40 or v_ten>=4)) or (not p_auto and (v_hour>=120 or v_day>=200 or v_ten>=40))",
  "then return jsonb_build_object('code','RATE_LIMIT','claimed',false); end if;",
];
const replaceLines = (all, from, to) => {
  const at = all.findIndex((_, index) => from.every((line, offset) => all[index + offset] === line));
  return at < 0 ? null : [...all.slice(0, at), ...to, ...all.slice(at + from.length)];
};
// Everything an installation of the claim limits migration must leave alone, as one comparable document. The claim's own body is
// excluded; its identity, owner, ACL, security configuration, volatility and the full definition and ACL of every other function in
// the application schemas are included, with the rows of every table the claim reads or writes and every trigger.
const rowsDigest = (table) => `select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')))::text from ${table} t`;
// One query per part, each answering a jsonb document as text, so a failure names the part (the rehearsal prints only the stage label).
const LIMITS_STATE = {
  claim: `select jsonb_build_object('oid',p.oid::bigint,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'secdef',p.prosecdef,'config',p.proconfig,
    'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,'kind',p.prokind,'returns',p.prorettype::regtype::text,
    'args',pg_get_function_identity_arguments(p.oid),'language',l.lanname,'cost',p.procost,'rows',p.prorows)::text
    from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='${CLAIM}'::regprocedure`,
  functions: `select jsonb_build_object('count',count(*),'md5',md5(string_agg(p.oid::regprocedure::text||'|'||pg_get_functiondef(p.oid)||'|'||coalesce(p.proacl::text,''),E'\\n'
    order by p.oid::regprocedure::text)))::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f' and p.oid<>'${CLAIM}'::regprocedure`,
  // The enabled flag is cast to text: text || "char" is an ambiguous operator.
  triggers: `select to_jsonb(md5(string_agg(tgrelid::regclass::text||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid),E'\\n' order by tgrelid::regclass::text,tgname)))::text
    from pg_trigger where not tgisinternal`,
  controls: rowsDigest('private.ai_controls'),
  usage: rowsDigest('private.ai_usage'),
  evidence: rowsDigest('private.ai_usage_evidence'),
  requests: rowsDigest('private.outfitgen_requests'),
  suggestions: rowsDigest('public.suggested_outfits'),
  assessed: rowsDigest('private.outfit_assessed_items'),
  manifests: rowsDigest('private.ai_execution_manifests'),
};
async function limitsState(one) {
  const state = {};
  for (const [part, text] of Object.entries(LIMITS_STATE)) {
    note(`state-${part}`);
    state[part] = await one(`${text};`);
  }
  return state;
}

// OUTFITGEN3-B2, before the claim limits migration (the predecessor inventory): one owner is configured and consented, one genuine claim is held
// and everything the migration must not change is captured. The held request must survive the installation and settle afterwards.
export async function outfitgenLimitsCheckpoint(snapshot, sql, mark = () => {}) {
  note = (label) => { last = label; mark(label); };
  const h = helpers(snapshot, sql);
  const { a, one, scalar, claim } = h;
  const before = await h.configure();
  try {
    note('configure');
    await sql(`update private.ai_controls set outfitgen_activated=true,outfitgen_consent_revision=2,outfitgen_consented_at=clock_timestamp()
      where owner_id=${literal(a.uid)};`);
    note('claim');
    const id = randomUUID();
    const held = await claim(id, ['c'.repeat(64)]);
    equal([held.code, held.claimed], ['OK', true]);
    equal(await scalar(`select charge_state from private.ai_usage where request_id=${literal(id)};`), 'held');
    const state = await limitsState(one);
    note('body');
    return { before, id, state, body: lines(await scalar(`select prosrc from pg_proc where oid='${CLAIM}'::regprocedure;`)) };
  } catch (error) {
    if (!/^EVIDENCE_REQUIRED/.test(String(error?.message))) note(`${last}-threw-${clean(error?.message)}`);
    await sql(`delete from private.ai_usage where purpose='outfitgen' and owner_id=${literal(a.uid)};`);
    await h.restore(before, []);
    throw error;
  }
}
const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

// After the migration alone: only the claim's body differs (by exactly the rate block), the held request survives and settles, and the
// configuration is restored.
export async function outfitgenLimitsCompare(checkpoint, snapshot, sql, mark = () => {}) {
  note = (label) => { last = label; mark(label); };
  const h = helpers(snapshot, sql);
  const { one, scalar, finish } = h;
  try {
    const state = await limitsState(one);
    note('state-compare');
    for (const part of Object.keys(LIMITS_STATE)) {
      if (!isDeepStrictEqual(state[part], checkpoint.state[part])) { note(`state-differs-${part}`); requireEvidence(false); }
    }
    note('body');
    const after = lines(await scalar(`select prosrc from pg_proc where oid='${CLAIM}'::regprocedure;`));
    const sourceNow = await claimBodyLines('20261108100000_outfitgen_call_limits.sql');
    equal(after, sourceNow);
    equal(replaceLines(checkpoint.body, OLD_RATE_LINES, NEW_RATE_LINES), after);
    equal(replaceLines(after, NEW_RATE_LINES, OLD_RATE_LINES), checkpoint.body);
    equal(await claimBodyLines('20261106090000_outfit_generation.sql'), checkpoint.body);
    note('held');
    equal(await scalar(`select charge_state from private.ai_usage where request_id=${literal(checkpoint.id)};`), 'held');
    const done = await finish(checkpoint.id, 'OK', USAGE, [], null);
    equal(done.code, 'OK');
    equal(await scalar(`select charge_state||':'||accounted_micro from private.ai_usage where request_id=${literal(checkpoint.id)};`), `estimated:${30000 * 220 / 100 + 2000 * 1320 / 100}`);
  } catch (error) {
    if (!/^EVIDENCE_REQUIRED/.test(String(error?.message))) note(`${last}-threw-${clean(error?.message)}`);
    throw error;
  } finally {
    await sql(`delete from private.ai_usage where purpose='outfitgen' and owner_id=${literal(h.a.uid)} and charge_state='held';`);
    await h.restore(checkpoint.before, []);
  }
}

// OUTFITGEN3-B2 after the migration: the raised manual limits, the unchanged automatic ones and the preserved claim safety.
export async function outfitgenLimitProbes(snapshot, sql, mark = () => {}) {
  note = (label) => { last = label; mark(label); };
  const h = helpers(snapshot, sql);
  const before = await h.configure();
  try {
    await rateLimitProbes(h, { keep: [], client: snapshot.client, signature: 'd'.repeat(64) });
  } catch (error) {
    if (!/^EVIDENCE_REQUIRED/.test(String(error?.message))) note(`${last}-threw-${clean(error?.message)}`);
    throw error;
  } finally {
    await h.restore(before, []);
  }
}
