// TRYON-PROMPT1: the v3 try-on manifest (open coats) against the real schema. Invoked only by the CI-only preservation owner, after the
// LIMITS1 checks ran unchanged at their own exact inventory (20261101200000). tryon_claim, tryon_dispatch and tryon_finish are service
// functions, called through privileged SQL the way the Edge handler calls them; every owner read and assertion uses the ordinary A/B
// sessions. Capacity, controls and consent are opened only inside these probes and restored in finally. No provider calls: the prompts
// themselves are not exercised here.
//   promptUpgradeSeed / promptUpgradeVerify: populated cutover. At the prior inventory both owners are configured at the v2 manifest and
//     notice 3 with consent at 3, a saved reference photo and results. After the migration alone the v2 row is byte for byte as it was,
//     the owners moved to v3 and nothing else on their controls changed (notice, consent, activation and limits included), the saved
//     photo, the results and the owner reads are as seeded, and the v2 manifest is no longer accepted.
//   promptMigrationGuards: at the prior inventory the migration's own SQL is run inside the hosted-style wrapper (execute in a DO
//     block, in a transaction that is always rolled back): a running chain and a held charge each refuse it with nothing changed; a v2
//     bootstrap that is already executing finishes first and is then moved to v3; a v2 claim made while the migration holds its
//     locks gets BUSY and writes nothing.
//   tryonPromptProbes: a two-step chain claims, finishes and records v3; v2 is refused by claim and bootstrap.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { requireEvidence } from './preservation.sessions.mjs';
import { isDeepStrictEqual } from 'node:util';
import { intent, saveHarness } from './item-save.sessions.mjs';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures.ts';

function equal(actual, expected, label = '') {
  if (isDeepStrictEqual(actual, expected)) return;
  const at = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/^at /, '').split(/[\\\\/]/).pop() ?? '';
  const text = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v))?.slice(0, 600);
  console.log(`PROMPT1-MISMATCH ${label} (${at}) expected ${text(expected)} actual ${text(actual)}`);
  requireEvidence(false);
}
const V1 = 'azure-global-image25-sunburst-tryon-v1';
const V2 = 'azure-global-image25-sunburst-tryon-v2';
const V3 = 'azure-global-image25-sunburst-tryon-v3';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const RESERVED = 360000;
const NOTICE = 3;
const RESULTS_HEADER = { 'X-Stillroom-TryOn-Results-Contract': '2' };
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const orNull = (value, cast) => (value === null ? `null::${cast}` : `${literal(value)}::${cast}`);
const uuids = (ids) => (ids === null ? 'null::uuid[]' : `array[${ids.map((id) => `${literal(id)}::uuid`).join(',')}]::uuid[]`);
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', input: 9000, output: 6000, total: 15000, inputText: 200,
  inputImage: 8800 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const output = (label) => {
  const bytes = Buffer.from(`synthetic prompt try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: sha(bytes) };
};
const PHOTO = flatJpeg({ width: 1024, height: 1280 });
const without = (c, keys) => Object.fromEntries(Object.entries(c).filter(([key]) => !keys.includes(key)));

function helpers(snapshot, sql) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = (owner, name, body) => client.rpc(owner, name, body);
  const rpcWith = async (owner, name, body, headers) => {
    const reply = await client.request(owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body, headers });
    requireEvidence(reply.ok);
    return reply.data;
  };
  const freeSlots = () => sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
    where deployment_key=${literal(KEY)} and held_until>clock_timestamp();`);
  const claim = async (owner, chain, step, id, manifest, { items = null, person = null } = {}) => {
    await freeSlots();
    return one(`select public.tryon_claim(${literal(owner.uid)},${literal(chain)},${step},${literal(id)},${literal(manifest)},
      null::uuid,${orNull(person, 'text')},null::uuid,${uuids(items)});`);
  };
  const dispatch = (owner, id) => one(`select public.tryon_dispatch(${literal(owner.uid)},${literal(id)},true);`);
  const finish = (owner, id, out, send) => one(`select public.tryon_finish(
    ${literal(owner.uid)},${literal(id)},'OK',${json(VALID)},${literal(out.sha)},${out.bytes.length},
    ${send ? `decode(${literal(out.bytes.toString('hex'))},'hex')` : 'null::bytea'},true,true,false);`);
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const release = (owner, id) => one(`select public.tryon_finish(${literal(owner.uid)},${literal(id)},'PRE_DISPATCH',null::jsonb,
    null::text,null::integer,null::bytea,false,null::boolean,false);`);
  const photos = () => one(`select coalesce(jsonb_object_agg(owner_id,encode(sha256(jpeg),'hex')||':'||saved_at::text),'{}'::jsonb)
    from private.tryon_person_photos where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
  const putPhoto = (owner, bytes = PHOTO) => rpc(owner, 'tryon_person_photo_put_v1', { p_jpeg_base64: b64(bytes), p_sha256: sha(bytes) });
  const chains = [];
  const fresh = () => { const id = randomUUID(); chains.push(id); return id; };
  const sh = saveHarness(client, a);
  const garment = async (category) => {
    const value = sh.track(intent());
    value.p_item.category = category;
    value.p_item.title = `Fictional prompt ${category}`;
    const row = await sh.reserve(value);
    await sh.upload(value);
    await sh.finalize(value, row);
    return value.p_item.id;
  };
  // Both owners configured, activated and consenting at `notice`; `restore` puts every touched control back.
  const configure = async (manifest, notice) => {
    const before = { a: await controls(a), b: await controls(b),
      capacity: await one(`select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(KEY)};`) };
    requireEvidence(before.a.tryon_activated === false && before.b.tryon_activated === false);
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    for (const owner of [a, b]) {
      equal((await one(`select public.tryon_bootstrap(${literal(owner.uid)},${literal(manifest)},${notice},${RESERVED},5000000,1000);`)).code, 'OK');
    }
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});
      update private.provider_capacity set dispatch_enabled=true,disabled_reason=null,disabled_at=null,updated_at=clock_timestamp()
      where deployment_key=${literal(KEY)};`);
    for (const owner of [a, b]) equal((await rpc(owner, 'tryon_set_consent', { p_enabled: true, p_notice_revision: notice })).code, 'OK');
    return before;
  };
  const restore = async (before) => {
    await sql(`delete from private.tryon_results where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chains where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_person_photos where owner_id in (${literal(a.uid)},${literal(b.uid)});
      delete from private.tryon_chain_stops where owner_id in (${literal(a.uid)},${literal(b.uid)})
        and chain_id in (${chains.length ? chains.map((id) => `${literal(id)}::uuid`).join(',') : 'null::uuid'});`);
    await sh.cleanup();
    const c = before.capacity;
    await sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second' where deployment_key=${literal(KEY)};
      update private.provider_capacity set dispatch_enabled=${c.dispatch_enabled},disabled_reason=${orNull(c.disabled_reason, 'text')},
        disabled_at=${orNull(c.disabled_at, 'timestamptz')},updated_at=clock_timestamp() where deployment_key=${literal(KEY)};`);
    for (const [owner, was] of [[a, before.a], [b, before.b]]) {
      await sql(`update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${was.monthly_allowance_micro},updated_at=clock_timestamp()
        where owner_id=${literal(owner.uid)};`);
    }
    equal(Number(await scalar(`select count(*) from private.ai_usage where purpose='try_on' and charge_state='held';`)), 0);
  };
  return { a, b, one, scalar, rpc, rpcWith, claim, dispatch, finish, release, controls, photos, putPhoto, fresh, garment, configure, restore };
}

const STORED = (ids) => `select coalesce(jsonb_object_agg(result_id,jsonb_build_object('owner',owner_id,'sha',encode(sha256(jpeg),'hex'),
  'bytes',octet_length(jpeg),'chain',chain_id,'items',item_ids,'state',state,'created',extract(epoch from created_at)::text,
  'completed',extract(epoch from completed_at)::text)),'{}'::jsonb) from private.tryon_results where result_id in (${ids.map(literal).join(',')});`;
const manifestRow = (h, id) => h.one(`select to_jsonb(m) from private.ai_execution_manifests m where id=${literal(id)};`);

const MIGRATION = new URL('../../supabase/migrations/20261102090000_tryon_prompt_v3.sql', import.meta.url);
const migrationInner = async () => {
  const text = await readFile(MIGRATION, 'utf8');
  requireEvidence(text.startsWith('-- TRYON-PROMPT1') && text.includes('\nbegin;\n') && text.trimEnd().endsWith('commit;')
    && !text.includes('$mig$') && !text.includes('$w$'));
  return text.replace('\nbegin;\n', '\n').trimEnd().replace(/commit;$/, '');
};
// The hosted install runs the migration's inner SQL with execute inside a DO block; this does the same inside a transaction that is
// always rolled back, so an attempt (applied or refused) never changes the database or the migration history.
const wrapped = (inner, tail) => `begin;
create temp table prompt_guard_result(msg text);
do $w$ begin
  begin
    execute $mig$${inner}$mig$;
    insert into prompt_guard_result values('APPLIED');
  exception when others then
    insert into prompt_guard_result values('REFUSED: '||sqlerrm);
  end;
end $w$;
select 'MSG:'||msg from prompt_guard_result;
${tail}
rollback;`;
const fingerprintExpr = (a, b) => `jsonb_build_object(
  'v3',(select count(*) from private.ai_execution_manifests where id=${literal(V3)}),
  'deployments',(select count(*) from private.provider_deployments where manifest_id like 'azure-global-image25-sunburst-tryon-v%'),
  'claim',(select md5(prosrc) from pg_proc where oid='public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])'::regprocedure),
  'bootstrap',(select md5(prosrc) from pg_proc where oid='public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)'::regprocedure),
  'controls',(select jsonb_agg(to_jsonb(c) order by owner_id) from private.ai_controls c where owner_id in (${literal(a.uid)},${literal(b.uid)})),
  'chains',(select count(*) from private.tryon_chains where state='running'),
  'held',(select count(*) from private.ai_usage where purpose='try_on' and charge_state in ('reserved','held')))`;
const lineOf = (out, prefix) => out.split('\n').map((line) => line.trim()).find((line) => line.startsWith(prefix))?.slice(prefix.length);

export async function promptMigrationGuards(snapshot, sql, mark = () => {}) {
  const h = helpers(snapshot, sql);
  const { a, b } = h;
  const inner = await migrationInner();
  const expr = fingerprintExpr(a, b);
  const fpNow = async () => JSON.parse(await h.scalar(`select (${expr})::text;`));
  const attempt = async (tail = '') => {
    const out = await sql(wrapped(inner, `select 'FP:'||(${expr})::text;\n${tail}`));
    return { msg: lineOf(out, 'MSG:'), fp: JSON.parse(lineOf(out, 'FP:')), out };
  };
  // A background transaction that sleeps holding its locks; returns once the sleep is seen, and `done` is awaited at the release point.
  const sleeping = async (text, marker) => {
    let settled = false;
    const done = sql(text).finally(() => { settled = true; });
    done.catch(() => {});
    for (const until = Date.now() + 8000; ;) {
      requireEvidence(!settled);
      if (await h.scalar(`select count(*) from pg_stat_activity where wait_event='PgSleep'
        and query like ${literal(`%${marker}%`)} and pid<>pg_backend_pid();`) === '1') return { done, open: () => !settled };
      requireEvidence(Date.now() < until);
      await delay(25);
    }
  };
  const waitingOnMigration = async (ms) => {
    for (const until = Date.now() + ms; ;) {
      if (Number(await h.scalar(`select count(*) from pg_stat_activity where wait_event_type='Lock'
        and query like '%execute $mig$%' and pid<>pg_backend_pid();`)) === 1) return;
      requireEvidence(Date.now() < until);
      await delay(25);
    }
  };
  const refused = async (label) => {
    const before = await fpNow();
    const reply = await attempt();
    if (!reply.msg?.startsWith('REFUSED:') || !reply.msg.includes('drain first')) {
      console.log(`PROMPT1-MISMATCH ${label} expected a drain refusal, got ${String(reply.msg).slice(0, 300)}`);
      requireEvidence(false);
    }
    equal(reply.fp, before, `${label}-inside`);
    equal(await fpNow(), before, `${label}-after`);
    return before;
  };

  mark('live-chain-and-held-charge');
  {
    const before = await h.configure(V2, NOTICE);
    try {
      const top = await h.garment('top');
      const chain = h.fresh(), id = randomUUID();
      equal((await h.claim(a, chain, 1, id, V2, { items: [top] })).code, 'OK');
      // A claimed step holds a charge and a running chain.
      const held = await refused('held-charge');
      requireEvidence(held.held === 1 && held.chains === 1);
      await h.release(a, id);
      // A released step leaves the chain running: still refused, nothing held.
      const running = await refused('running-chain');
      requireEvidence(running.held === 0 && running.chains === 1);
      equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: chain })).code, 'CANCELLED');
      requireEvidence((await fpNow()).chains === 0);
    } finally {
      await h.restore(before);
    }
  }

  mark('racing-bootstrap');
  {
    const was = { a: await h.controls(a), b: await h.controls(b),
      capacity: await h.one(`select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(KEY)};`) };
    requireEvidence(was.a.tryon_manifest_id === null && was.b.tryon_manifest_id === null);
    try {
      // A v2 bootstrap is already executing (it holds the account's controls row). The migration waits for it, then sees and moves
      // what it wrote: the account ends on v3 inside the migration, never left on v2.
      const booting = await sleeping(`begin; select public.tryon_bootstrap(${literal(b.uid)},${literal(V2)},${NOTICE},${RESERVED},5000000,1000);
        select 'HELD'; select pg_sleep(3.31); commit;`, '3.31');
      const migrating = sql(wrapped(inner, `select 'B:'||coalesce((select tryon_manifest_id from private.ai_controls where owner_id=${literal(b.uid)}),'none');`));
      migrating.catch(() => {});
      await waitingOnMigration(2500);
      requireEvidence(booting.open());
      await booting.done;
      const out = await migrating;
      equal(lineOf(out, 'MSG:'), 'APPLIED');
      equal(lineOf(out, 'B:'), V3);
      // The attempt was rolled back; only the committed bootstrap remains.
      equal((await h.controls(b)).tryon_manifest_id, V2);
      requireEvidence((await fpNow()).v3 === 0);
    } finally {
      await h.restore(was);
    }
  }

  mark('racing-claim');
  {
    const before = await h.configure(V2, NOTICE);
    try {
      const top = await h.garment('top');
      const fp = await fpNow();
      // While the migration holds its locks, a v2 claim cannot take the account's controls row: BUSY, nothing claimed or written.
      const holding = await sleeping(wrapped(inner, `select 'HELD';\nselect pg_sleep(3.17);`), '3.17');
      const chain = h.fresh();
      equal(await h.claim(a, chain, 1, randomUUID(), V2, { items: [top] }), { code: 'BUSY', claimed: false });
      requireEvidence(holding.open());
      equal(lineOf(await holding.done, 'MSG:'), 'APPLIED');
      equal(await fpNow(), fp);
      equal(await h.scalar(`select count(*) from private.tryon_chains where owner_id=${literal(a.uid)} and chain_id=${literal(chain)};`), '0');
    } finally {
      await h.restore(before);
    }
  }
}

export async function promptUpgradeSeed(snapshot, sql) {
  const h = helpers(snapshot, sql);
  const { a, b } = h;
  // The prior inventory: no v3 manifest yet, and the controls and consent below are the ones the migration must leave alone.
  equal(await h.one(`select jsonb_build_array(not exists(select 1 from private.ai_execution_manifests where id=${literal(V3)}),
    exists(select 1 from private.ai_execution_manifests where id=${literal(V2)}));`), [true, true]);
  const manifestV2 = await manifestRow(h, V2);
  const before = await h.configure(V2, NOTICE);
  try {
    for (const owner of [a, b]) equal((await h.putPhoto(owner)).code, 'OK');
    const photos = await h.photos();
    requireEvidence(Object.keys(photos).length === 2);
    const ids = {};
    for (const [label, owner, days] of [['recent', a, 1], ['older', a, 40], ['other', b, 3]]) {
      ids[label] = randomUUID();
      await sql(`with t as (select clock_timestamp()-interval '${days} days' c)
        insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,jpeg,created_at,completed_at)
        select ${literal(owner.uid)},${literal(ids[label])},gen_random_uuid(),null,'ready',array[gen_random_uuid()],
          decode(${literal(Buffer.from(`seeded ${label} ${randomUUID()}`).toString('hex'))},'hex'),t.c-interval '1 minute',t.c from t;`);
    }
    const stored = await h.one(STORED(Object.values(ids)));
    requireEvidence(Object.keys(stored).length === 3);
    // Nothing is running or held, as the migration's drain guard requires.
    equal(await h.scalar(`select (select count(*) from private.tryon_chains where state='running')
      + (select count(*) from private.ai_usage where purpose='try_on' and charge_state='held');`), '0');
    const seeded = { a: await h.controls(a), b: await h.controls(b) };
    for (const c of [seeded.a, seeded.b]) {
      requireEvidence(c.tryon_activated === true && c.tryon_manifest_id === V2 && c.tryon_notice_revision === NOTICE
        && c.tryon_consent_revision === NOTICE && c.tryon_consented_at !== null);
    }
    return { h, before, manifestV2, photos, ids, stored, seeded };
  } catch (error) {
    await h.restore(before).catch(() => {});
    throw error;
  }
}

export async function promptUpgradeVerify(seed, mark = () => {}) {
  const { h, before, manifestV2, photos, ids, stored, seeded } = seed;
  const { a, b } = h;
  try {
    mark('structure');
    // The v2 row is exactly what it was; v3 differs from it only in id, prompt version, the prompt and settings hashes and the
    // description, and sits on the same deployment key.
    equal(await manifestRow(h, V2), manifestV2);
    const differing = await h.one(`select jsonb_agg(e.key order by e.key) from private.ai_execution_manifests n
      join private.ai_execution_manifests o on o.id=${literal(V2)}, jsonb_each(to_jsonb(n)) e
      where n.id=${literal(V3)} and to_jsonb(o)->e.key is distinct from e.value;`);
    requireEvidence(Array.isArray(differing) && differing.length === 5 && ['id', 'prompt_version', 'prompt_sha256', 'settings_sha256',
      'tariff_description'].every((key) => differing.includes(key)));
    equal(await h.one(`select jsonb_build_array((select prompt_version from private.ai_execution_manifests where id=${literal(V3)}),
      (select count(distinct deployment_key) from private.provider_deployments where manifest_id in (${literal(V1)},${literal(V2)},${literal(V3)})),
      (select count(*) from private.provider_deployments where manifest_id in (${literal(V1)},${literal(V2)},${literal(V3)})),
      (select count(*) from private.ai_execution_manifests where id like 'azure-global-image25-sunburst-tryon-%'));`), [3, 1, 3, 3]);

    mark('controls');
    // Only the manifest moved: notice, consent, activation and limits are as seeded (no re-consent).
    for (const [owner, was] of [[a, seeded.a], [b, seeded.b]]) {
      const now = await h.controls(owner);
      requireEvidence(now.tryon_manifest_id === V3);
      requireEvidence(now.tryon_notice_revision === NOTICE && now.tryon_consent_revision === NOTICE
        && now.tryon_consented_at === was.tryon_consented_at && now.tryon_activated === true);
      equal(without(now, ['updated_at', 'tryon_manifest_id']), without(was, ['updated_at', 'tryon_manifest_id']));
    }
    const status = await h.rpc(a, 'tryon_status', {});
    requireEvidence(status.code === 'OK' && status.policy.manifestId === V3 && status.policy.noticeRevision === NOTICE
      && status.policy.maxSteps === 6 && status.policy.maxResults === 200);

    mark('saved-photo');
    // The notice did not change, so the guard never ran: each saved photo is present, byte for byte, and readable by its owner.
    equal(await h.photos(), photos);
    requireEvidence((await h.rpc(a, 'tryon_person_photo_status_v1', {})).saved === true);
    requireEvidence((await h.rpc(b, 'tryon_person_photo_status_v1', {})).saved === true);

    mark('results');
    equal(await h.one(STORED(Object.values(ids))), stored);
    equal((await h.rpcWith(a, 'tryon_results_v1', {}, RESULTS_HEADER)).results.map((row) => row.id).sort(), [ids.recent, ids.older].sort());
    equal((await h.rpcWith(b, 'tryon_results_v1', {}, RESULTS_HEADER)).results.map((row) => row.id), [ids.other]);
  } finally {
    await h.restore(before);
  }
}

export async function tryonPromptProbes(snapshot, sql, mark) {
  const h = helpers(snapshot, sql);
  const { a, b, one, scalar, claim, dispatch, finish } = h;
  const before = await h.configure(V3, NOTICE);
  try {
    mark('structure');
    equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
        not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),has_function_privilege('anon',p.oid,'EXECUTE'),
        has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE')))
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('tryon_claim','tryon_bootstrap');`), {
      tryon_claim: [true, true, false, false, true], tryon_bootstrap: [true, true, false, false, false],
    });

    mark('bootstrap');
    // The controls were bootstrapped at v3 above; the same call replays, v2 and v1 are not accepted, and a different limit conflicts.
    equal(await one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(V3)},${NOTICE},${RESERVED},5000000,1000);`), { code: 'OK', replayed: true });
    equal((await one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(V2)},${NOTICE},${RESERVED},5000000,1000);`)).code, 'UNCONFIGURED');
    equal((await one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(V1)},${NOTICE},${RESERVED},5000000,1000);`)).code, 'UNCONFIGURED');
    equal((await one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(V3)},${NOTICE},${RESERVED + 1},5000000,1000);`)).code, 'CONFLICT');

    mark('claim-refuses-v2');
    const top = await h.garment('top'), outerwear = await h.garment('outerwear');
    const refusedChain = h.fresh();
    equal(await claim(a, refusedChain, 1, randomUUID(), V2, { items: [top, outerwear] }), { code: 'UNCONFIGURED', claimed: false });
    equal(await scalar(`select count(*) from private.tryon_chains where owner_id=${literal(a.uid)} and chain_id=${literal(refusedChain)};`), '0');

    mark('two-step-chain');
    const chain = h.fresh();
    let person = null;
    const slots = [];
    for (let step = 1; step <= 2; step += 1) {
      const id = randomUUID();
      const claimed = await claim(a, chain, step, id, V3, { items: step === 1 ? [outerwear, top] : null, person });
      requireEvidence(claimed.code === 'OK' && claimed.claimed === true && claimed.manifestId === V3 && claimed.steps === 2 && claimed.last === (step === 2));
      slots.push(claimed.slot);
      equal((await dispatch(a, id)).code, 'AUTHORISED');
      const out = output(`${step}`);
      const done = await finish(a, id, out, step === 2);
      requireEvidence(done.code === 'OK' && done.last === (step === 2));
      equal(await scalar(`select manifest_id from private.ai_usage_evidence where owner_id=${literal(a.uid)} and request_id=${literal(id)};`), V3);
      person = out.sha;
      if (step === 2) equal(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)} and result_id=${literal(done.resultId)} and state='ready';`), '1');
    }
    // The idea lists the outerwear before the top; the chain order is still top, then outerwear.
    equal(slots, ['top', 'outerwear']);
    equal((await h.rpc(a, 'tryon_chain_status', { p_chain_id: chain })).state, 'complete');
    equal(await scalar(`select count(*) from private.tryon_chains where owner_id=${literal(b.uid)};`), '0');
    mark('done');
  } finally {
    await h.restore(before);
  }
}
