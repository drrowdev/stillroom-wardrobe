// TRYON-PROMPT2: the v4 try-on manifest (a pullover stays a pullover) and its guarded controls switch against the real schema. Invoked only
// by the CI-only preservation owner. tryon_claim, tryon_dispatch and tryon_finish are service functions, called through privileged SQL the
// way the Edge handler calls them; every owner read and assertion uses the ordinary A/B sessions. No provider calls: the prompts themselves
// are not exercised here. Every probe runs in one session, one statement after the other, with ONE exception: the bounded contention probe
// below, whose holder is a detached transaction whose readiness is confirmed by polling pg_locks and pg_stat_activity with fresh statements
// (no rendezvous between sessions, no write that references the held row). The lock order is also pinned as text in
// tests/unit/tryon-prompt-v4-schema.test.ts.
//   tryonPrompt2Checkpoint: the prior inventory (47 migrations through 20261109100000), both owners configured at v3 with one genuine held
//     claim, and everything the migration must not change captured.
//   tryonPrompt2Compare: after the migration alone only the two replaced bodies differ, each by exactly the widened manifest pin and each
//     equal to the migration; the v4 manifest differs from v3 only in its identity, prompt version, two hashes and description; the
//     held claim survives and is released.
//   tryonPrompt2Probes: v3 is admitted under v3 controls and v4 is refused (CONFIG_CHANGED), unknown and older manifests are refused
//     (UNCONFIGURED); the guarded switch refuses, changing nothing, for a held charge alone, a running chain with and without its reserved
//     result, a reserved result alone, a wrong installed manifest, an uninstalled target, a mixed account, and an owner holding a lock (the
//     whole transaction fails at its short lock timeout and a claim answers BUSY); after the chain has ended it moves every configured
//     account, leaving consent and the saved photos as they were, and then v3 is refused and a whole v4 chain records one manifest on every
//     step; the same text moves the accounts back; the per-owner recovery moves one account out of a mixed state; an unconfigured account is
//     never written.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';
import { helpers } from './tryon-prompt.sessions.mjs';

const V1 = 'azure-global-image25-sunburst-tryon-v1';
const V2 = 'azure-global-image25-sunburst-tryon-v2';
const V3 = 'azure-global-image25-sunburst-tryon-v3';
const V4 = 'azure-global-image25-sunburst-tryon-v4';
const V5 = 'azure-global-image25-sunburst-tryon-v5';
const RESERVED = 360000;
const NOTICE = 3;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const md5 = (text) => createHash('md5').update(text).digest('hex');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const output = (label) => {
  const bytes = Buffer.from(`synthetic prompt2 try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: sha(bytes) };
};
function equal(actual, expected, label = '') {
  if (isDeepStrictEqual(actual, expected)) return;
  const at = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/^at /, '').split(/[\\\\/]/).pop() ?? '';
  const text = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v))?.slice(0, 600);
  console.log(`PROMPT2-MISMATCH ${label} (${at}) expected ${text(expected)} actual ${text(actual)}`);
  requireEvidence(false);
}
function ok(condition, label = '') {
  if (condition) return;
  console.log(`PROMPT2-MISMATCH ${label} expected a refusal or a true condition`);
  requireEvidence(false);
}

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const V3_MIGRATION = '20261102090000_tryon_prompt_v3.sql';
const V4_MIGRATION = '20261109110000_tryon_prompt_v4.sql';
const REPLACED = ['public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])', 'public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)'];
const REPLACED_LIST = REPLACED.map((sig) => `'${sig}'::regprocedure`).join(',');
const PIN3 = `m.id<>'${V3}'`;
const PIN34 = `m.id not in ('${V3}','${V4}')`;
// The text between `as $$` and its closing `$$;`, exactly what pg_proc.prosrc holds.
const bodyOf = async (file, name) => {
  const text = await readFile(new URL(file, MIGRATIONS), 'utf8');
  const from = text.indexOf(`create or replace function public.${name}(`);
  requireEvidence(from >= 0);
  const open = text.indexOf('as $$', from) + 'as $$'.length;
  return text.slice(open, text.indexOf('\n$$;', open) + 1);
};

const digest = (table, where = 'true') => `select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(to_jsonb(t)::text,'|'
  order by to_jsonb(t)::text),'')))::text from ${table} t where ${where}`;
const TABLES = ['private.ai_controls', 'private.ai_usage', 'private.ai_usage_evidence', 'private.tryon_chains', 'private.tryon_attempts',
  'private.tryon_results', 'private.tryon_person_photos', 'private.tryon_chain_stops', 'private.provider_capacity', 'private.provider_slots'];
const STATE = Object.freeze({
  replaced: `select jsonb_agg(jsonb_build_object('sig',p.oid::regprocedure::text,'oid',p.oid::bigint,'owner',pg_get_userbyid(p.proowner),
    'acl',p.proacl::text,'secdef',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile::text,'kind',p.prokind::text) order by p.oid::regprocedure::text)::text
    from pg_proc p where p.oid in (${REPLACED_LIST})`,
  functions: `select jsonb_build_object('count',count(*),'md5',md5(string_agg(p.oid::regprocedure::text||'|'||pg_get_functiondef(p.oid)||'|'||
    coalesce(p.proacl::text,''),E'\\n' order by p.oid::regprocedure::text)))::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f' and p.oid not in (${REPLACED_LIST})`,
  triggers: `select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(pg_get_triggerdef(t.oid),'|' order by t.tgname,t.tgrelid::regclass::text),'')))::text
    from pg_trigger t where not t.tgisinternal`,
  manifests: digest('private.ai_execution_manifests', `t.id<>'${V4}'`),
  deployments: digest('private.provider_deployments', `t.manifest_id<>'${V4}'`),
  ...Object.fromEntries(TABLES.map((table) => [table, digest(table)])),
});
async function state(one) {
  const out = {};
  for (const [part, query] of Object.entries(STATE)) out[part] = await one(query);
  return out;
}

// The prior inventory: both owners configured at v3 with one genuine held claim, and the migration's non-changes captured.
export async function tryonPrompt2Checkpoint(snapshot, sql, mark = () => {}) {
  const h = helpers(snapshot, sql);
  const { a, one, scalar, claim } = h;
  mark('prior-inventory');
  equal(await scalar(`select count(*) from private.ai_execution_manifests where id=${literal(V4)};`), '0');
  mark('predecessor-bodies');
  for (const [index, name] of ['tryon_claim', 'tryon_bootstrap'].entries()) {
    const body = await bodyOf(V3_MIGRATION, name);
    equal(await scalar(`select md5(prosrc) from pg_proc where oid='${REPLACED[index]}'::regprocedure;`), md5(body), name);
  }
  mark('configure');
  const before = await h.configure(V3, NOTICE);
  try {
    const top = await h.garment('top'), outerwear = await h.garment('outerwear');
    mark('claim-held');
    const chain = h.fresh(), id = randomUUID();
    const held = await claim(a, chain, 1, id, V3, { items: [outerwear, top] });
    equal([held.code, held.claimed, held.manifestId], ['OK', true, V3]);
    equal(await scalar(`select charge_state from private.ai_usage where request_id=${literal(id)};`), 'held');
    mark('capture-state');
    const doc = await state(one);
    return { h, before, chain, id, doc };
  } catch (error) {
    await h.restore(before).catch(() => {});
    throw error;
  }
}

// After the migration alone. The comparison comes first; nothing is probed destructively before it.
export async function tryonPrompt2Compare(checkpoint, snapshot, sql, mark = () => {}) {
  const { h, before, chain, id, doc } = checkpoint;
  const { a, one, scalar, release } = h;
  try {
    mark('state-compare');
    const now = await state(one);
    for (const part of Object.keys(doc)) {
      if (!isDeepStrictEqual(now[part], doc[part])) { mark(`state-differs-${part}`); requireEvidence(false); }
    }
    mark('bodies');
    const v3 = await Promise.all(['tryon_claim', 'tryon_bootstrap'].map((name) => bodyOf(V3_MIGRATION, name)));
    const v4 = await Promise.all(['tryon_claim', 'tryon_bootstrap'].map((name) => bodyOf(V4_MIGRATION, name)));
    for (const [index, name] of ['tryon_claim', 'tryon_bootstrap'].entries()) {
      mark(`body-${name}`);
      equal(v3[index].split(PIN3).length, 2, `${name}-pin-count`);
      equal(v4[index], v3[index].replace(PIN3, () => PIN34), `${name}-only-delta`);
      equal(await scalar(`select md5(prosrc) from pg_proc where oid='${REPLACED[index]}'::regprocedure;`), md5(v4[index]), `${name}-installed`);
    }
    mark('manifest-v4');
    const differing = await one(`select jsonb_agg(e.key order by e.key) from private.ai_execution_manifests n
      join private.ai_execution_manifests o on o.id=${literal(V3)}, jsonb_each(to_jsonb(n)) e
      where n.id=${literal(V4)} and to_jsonb(o)->e.key is distinct from e.value;`);
    equal(differing, ['id', 'prompt_sha256', 'prompt_version', 'settings_sha256', 'tariff_description']);
    equal(await one(`select jsonb_build_array((select prompt_version from private.ai_execution_manifests where id=${literal(V4)}),
      (select count(distinct deployment_key) from private.provider_deployments where manifest_id like 'azure-global-image25-sunburst-tryon-v%'),
      (select count(*) from private.provider_deployments where manifest_id like 'azure-global-image25-sunburst-tryon-v%'),
      (select count(*) from private.ai_execution_manifests where id like 'azure-global-image25-sunburst-tryon-%'));`), [4, 1, 4, 4]);
    mark('held-claim-survives');
    equal(await scalar(`select charge_state from private.ai_usage where request_id=${literal(id)};`), 'held');
    mark('held-claim-release');
    await release(a, id);
    equal(await scalar(`select count(*) from private.ai_usage where purpose='try_on' and charge_state in ('reserved','held');`), '0');
    mark('chain-cancel');
    equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: chain })).code, 'CANCELLED');
  } finally {
    await h.restore(before);
  }
}

// After the migration: the manifest follows the controls, and the guarded switch and its recovery.
export async function tryonPrompt2Probes(snapshot, sql, mark = () => {}) {
  const h = helpers(snapshot, sql);
  const { a, b, one, scalar, claim, dispatch, finish } = h;
  const switchText = await readFile(new URL('../../docs/tryon-manifest-switch.sql', import.meta.url), 'utf8');
  const recoverText = await readFile(new URL('../../docs/tryon-manifest-recover-owner.sql', import.meta.url), 'utf8');
  const run = async (text) => { try { await sql(text); return null; } catch (error) { return error; } };
  const runGuard = (from, to, lockTimeout = null) => {
    let text = switchText.replaceAll('<from>', from).replaceAll('<to>', to);
    if (lockTimeout !== null) {
      const short = text.replace("set local lock_timeout = '10s';", `set local lock_timeout = '${lockTimeout}';`);
      ok(short !== text, 'lock-timeout-replaced');
      text = short;
    }
    return run(text);
  };
  const runRecover = (owner, from, to) => run(recoverText.replaceAll('<owner>', owner.uid).replaceAll('<from>', from).replaceAll('<to>', to));
  const installed = async () => [await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(a.uid)};`),
    await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(b.uid)};`)];
  const chainRows = (chain) => scalar(`select count(*) from private.tryon_chains where chain_id=${literal(chain)};`);
  const live = () => scalar(`select (select count(*) from private.ai_usage where purpose='try_on' and charge_state in ('reserved','held'))::text||':'||
    (select count(*) from private.tryon_chains where state='running')::text||':'||
    (select count(*) from private.tryon_results where state='reserved')::text;`);
  const evidence = (chain) => one(`select jsonb_agg(e.manifest_id::text order by u.tryon_step) from private.ai_usage u
    join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id where u.tryon_chain_id=${literal(chain)};`);
  const consentState = () => one(`select jsonb_agg(jsonb_build_array(owner_id::text,tryon_activated,tryon_notice_revision,tryon_consent_revision,
    tryon_consented_at::text,tryon_max_request_micro::text,tryon_monthly_allowance_micro::text,tryon_max_requests_per_hour)
    order by owner_id) from private.ai_controls where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
  const otherControls = async (owner) => (await h.controls(owner));
  const strip = (c) => Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'updated_at' && key !== 'tryon_manifest_id'));
  // One step of a chain through claim, dispatch and finish; returns the output hash the next step needs.
  const step = async (chain, n, manifest, items, person, last) => {
    const id = randomUUID();
    const claimed = await claim(a, chain, n, id, manifest, { items, person });
    equal([claimed.code, claimed.claimed, claimed.manifestId], ['OK', true, manifest], `claim-${n}`);
    equal((await dispatch(a, id)).code, 'AUTHORISED', `dispatch-${n}`);
    const out = output(`${n}`);
    const done = await finish(a, id, out, last);
    equal([done.code, done.last], ['OK', last], `finish-${n}`);
    return out.sha;
  };

  mark('structure');
  equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
      not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),has_function_privilege('anon',p.oid,'EXECUTE'),
      has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE')))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('tryon_claim','tryon_bootstrap');`), {
    tryon_claim: [true, true, false, false, true], tryon_bootstrap: [true, true, false, false, false],
  });
  const before = await h.configure(V3, NOTICE);
  try {
    mark('configured-accounts');
    equal(await scalar(`select count(*) from private.ai_controls where tryon_manifest_id is not null;`), '2');
    equal(await installed(), [V3, V3]);
    mark('saved-photos');
    for (const owner of [a, b]) equal((await h.putPhoto(owner)).code, 'OK');
    const photos = await h.photos();
    equal(Object.keys(photos).length, 2);
    const consent = await consentState();
    const controls = [strip(await h.controls(a)), strip(await h.controls(b))];

    mark('bootstrap');
    const boot = (manifest, limit = RESERVED) => one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(manifest)},${NOTICE},${limit},5000000,1000);`);
    equal(await boot(V3), { code: 'OK', replayed: true });
    equal((await boot(V4)).code, 'CONFLICT');
    equal((await boot(V2)).code, 'UNCONFIGURED');
    equal((await boot(V1)).code, 'UNCONFIGURED');
    equal((await boot(V5)).code, 'UNCONFIGURED');

    mark('garments');
    const top = await h.garment('top'), outerwear = await h.garment('outerwear');
    const items = [outerwear, top];

    mark('nothing-live-before-admission');
    equal(await live(), '0:0:0');
    mark('claim-v4-under-v3-controls');
    const refused = h.fresh();
    equal(await claim(a, refused, 1, randomUUID(), V4, { items }), { code: 'CONFIG_CHANGED', claimed: false });
    mark('claim-older-and-unknown');
    equal((await claim(a, refused, 1, randomUUID(), V2, { items })).code, 'UNCONFIGURED');
    equal((await claim(a, refused, 1, randomUUID(), V5, { items })).code, 'UNCONFIGURED');
    equal(await chainRows(refused), '0');
    equal(await live(), '0:0:0');

    // 1. A held charge alone: the owner stops the chain while its step is dispatched, so the chain is no longer running and no result slot
    //    is reserved, but the charge stays held until the step settles.
    mark('held-charge-claim');
    const chainH = h.fresh(), idH = randomUUID();
    equal((await claim(a, chainH, 1, idH, V3, { items })).code, 'OK');
    equal((await dispatch(a, idH)).code, 'AUTHORISED');
    mark('held-charge-stop');
    equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: chainH })).code, 'CANCELLED');
    equal(await live(), '1:0:0');
    mark('guard-refused-held-charge-alone');
    ok(await runGuard(V3, V4) !== null, 'held-alone');
    equal(await installed(), [V3, V3]);
    mark('held-charge-settle');
    await finish(a, idH, output('late'), false);
    equal(await live(), '0:0:0');

    // 2. A running chain with its reserved result, then the chain alone, then the reserved result alone.
    mark('chain-step-1');
    const chain1 = h.fresh();
    const id1 = randomUUID();
    equal((await claim(a, chain1, 1, id1, V3, { items })).code, 'OK');
    equal((await dispatch(a, id1)).code, 'AUTHORISED');
    const out1 = output('1');
    const done1 = await finish(a, id1, out1, false);
    equal([done1.code, done1.last], ['OK', false]);
    equal(await live(), '0:1:1');
    mark('guard-refused-running-chain-with-result');
    ok(await runGuard(V3, V4) !== null, 'chain-with-result');
    equal(await installed(), [V3, V3]);
    mark('chain-alone');
    await sql(`delete from private.tryon_results where chain_id=${literal(chain1)} and state='reserved';`);
    equal(await live(), '0:1:0');
    mark('guard-refused-running-chain-alone');
    ok(await runGuard(V3, V4) !== null, 'chain-alone');
    equal(await installed(), [V3, V3]);
    mark('chain-end');
    equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: chain1 })).code, 'CANCELLED');
    equal(await live(), '0:0:0');
    mark('reserved-result-alone');
    const stray = randomUUID();
    await sql(`insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,created_at)
      values (${literal(b.uid)},${literal(stray)},${literal(randomUUID())},null,'reserved',array[${literal(randomUUID())}::uuid],clock_timestamp());`);
    equal(await live(), '0:0:1');
    mark('guard-refused-reserved-result-alone');
    ok(await runGuard(V3, V4) !== null, 'result-alone');
    equal(await installed(), [V3, V3]);
    await sql(`delete from private.tryon_results where result_id=${literal(stray)};`);
    equal(await live(), '0:0:0');

    mark('guard-refused-wrong-installed');
    ok(await runGuard(V4, V3) !== null, 'wrong-installed');
    mark('guard-refused-uninstalled-target');
    ok(await runGuard(V3, V5) !== null, 'uninstalled');
    equal(await installed(), [V3, V3]);
    mark('guard-refused-mixed-accounts');
    await sql(`update private.ai_controls set tryon_manifest_id=${literal(V4)} where owner_id=${literal(b.uid)};`);
    ok(await runGuard(V3, V4) !== null, 'mixed');
    equal(await installed(), [V3, V4]);
    mark('recovery-refused-wrong-installed');
    ok(await runRecover(b, V3, V4) !== null, 'recover-wrong-from');
    equal(await installed(), [V3, V4]);
    mark('recovery-moves-one-account');
    equal(await runRecover(b, V4, V3), null);
    equal(await installed(), [V3, V3]);

    // 3. Contention. A detached transaction locks the profile row of the owner who comes second in the switch's order and sleeps; its
    //    readiness is confirmed from pg_locks and pg_stat_activity by fresh statements. A claim by that owner answers BUSY and writes nothing,
    //    and the switch, with its own one-second lock timeout, fails as a whole: the first owner, whose rows it had already locked, is
    //    unchanged too. Nothing here writes a row that references the held profile.
    mark('contention-holder-start');
    const [first, second] = [a, b].sort((x, y) => (x.uid < y.uid ? -1 : 1));
    const holdSeconds = 20;
    const holder = sql(`begin; select 1 from public.profiles where owner_id=${literal(second.uid)} for update; select pg_sleep(${holdSeconds}); commit;`)
      .then(() => null, (error) => error);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        ready = Number(await scalar(`select count(*) from pg_locks l join pg_stat_activity s on s.pid=l.pid
          where l.locktype='transactionid' and l.granted and s.datname=current_database() and s.pid<>pg_backend_pid()
          and s.wait_event='PgSleep' and s.query like '%pg_sleep(${holdSeconds})%';`)) > 0;
        if (!ready) await delay(250);
      }
      ok(ready, 'holder-ready');
      mark('contention-claim-busy');
      const busy = h.fresh();
      equal(await claim(second, busy, 1, randomUUID(), V3, { items }), { code: 'BUSY', claimed: false });
      equal(await chainRows(busy), '0');
      mark('contention-switch-lock-timeout');
      ok(await runGuard(V3, V4, '1s') !== null, 'switch-lock-timeout');
      mark('contention-nothing-changed');
      equal(await installed(), [V3, V3]);
      equal(await live(), '0:0:0');
      ok(first.uid !== second.uid, 'two-owners');
    } finally {
      mark('contention-holder-finish');
      ok((await holder) === null, 'holder-finished');
    }

    // 4. The move itself, after a complete chain and with nothing live.
    mark('v3-complete-chain');
    const chain2 = h.fresh();
    const person2 = await step(chain2, 1, V3, items, null, false);
    await step(chain2, 2, V3, null, person2, true);
    equal(await live(), '0:0:0');
    mark('guard-switch');
    equal(await runGuard(V3, V4), null);
    equal(await installed(), [V4, V4]);
    mark('guard-switch-writes-only-the-manifest');
    equal([strip(await h.controls(a)), strip(await h.controls(b))], controls);
    equal(await consentState(), consent);
    equal(await h.photos(), photos);

    mark('claim-v3-after-switch');
    const late = h.fresh();
    equal(await claim(a, late, 1, randomUUID(), V3, { items }), { code: 'CONFIG_CHANGED', claimed: false });
    equal(await chainRows(late), '0');
    equal(await live(), '0:0:0');

    mark('v4-chain-step-1');
    const chain3 = h.fresh();
    const person3 = await step(chain3, 1, V4, items, null, false);
    mark('guard-back-refused-running-chain');
    ok(await runGuard(V4, V3) !== null, 'back-running');
    equal(await installed(), [V4, V4]);
    mark('v4-chain-step-2');
    await step(chain3, 2, V4, null, person3, true);
    mark('one-manifest-per-chain');
    equal(await evidence(chain2), [V3, V3]);
    equal(await evidence(chain3), [V4, V4]);

    mark('guard-rollback');
    equal(await runGuard(V4, V3), null);
    equal(await installed(), [V3, V3]);
    equal(await claim(a, h.fresh(), 1, randomUUID(), V4, { items }), { code: 'CONFIG_CHANGED', claimed: false });
    equal([strip(await h.controls(a)), strip(await h.controls(b))], controls);
    equal(await consentState(), consent);
    equal(await h.photos(), photos);

    // 5. An unconfigured account is never written: the second owner's try-on configuration is removed, and only the first is moved.
    mark('unconfigured-account');
    await sql(`update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,tryon_manifest_id=null,
      tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,tryon_max_requests_per_hour=null
      where owner_id=${literal(b.uid)};`);
    const unconfigured = await otherControls(b);
    equal(await scalar(`select count(*) from private.ai_controls where tryon_manifest_id is not null;`), '1');
    mark('unconfigured-switch');
    equal(await runGuard(V3, V4), null);
    equal(await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(a.uid)};`), V4);
    equal(await otherControls(b), unconfigured);
    mark('unconfigured-rollback');
    equal(await runGuard(V4, V3), null);
    equal(await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(a.uid)};`), V3);
    equal(await otherControls(b), unconfigured);
    mark('done');
  } finally {
    await h.restore(before);
  }
}
