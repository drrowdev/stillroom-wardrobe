// TRYON-PROMPT3: the v5 try-on manifest (garments keep their length; outerwear is optional and never drawn) and its guarded controls switch against
// the real schema. Invoked only by the CI-only preservation owner. tryon_claim, tryon_dispatch and tryon_finish are service functions, called
// through privileged SQL the way the Edge handler calls them; every owner read and assertion uses the ordinary A/B sessions. No provider calls: the
// prompts themselves are not exercised here. Every probe runs in one session, one statement after the other: there is no detached transaction and no
// rendezvous between sessions (the lock order of the switch is pinned as text in tests/unit/tryon-prompt-v4-schema.test.ts and its algorithm is
// unchanged).
//   tryonPrompt3Checkpoint: the prior inventory (48 migrations through 20261109110000), both owners configured at v4 with one genuine held claim
//     whose chain still includes the outerwear step, and everything the migration must not change captured.
//   tryonPrompt3Compare: after the v5 migration alone only the two replaced bodies and the ONE new helper differ; each body differs from its
//     predecessor by exactly the stated delta and equals the migration; the v5 manifest differs from v4 only in its identity, prompt version, two
//     hashes and description; the helper has no API grant; the held claim survives and is released.
//   tryonPrompt3Probes: under v4 controls the plan still includes outerwear (the rollback state) and v5 is refused (CONFIG_CHANGED); the guarded
//     switch moves both accounts; under v5 controls v4 is refused, a chain never gets an outerwear step (idea and saved outfit, one-piece and
//     layered), an outfit with only outerwear is answered NO_GARMENTS with nothing written, a coat does not count against the budget (five drawn
//     steps are admitted at exactly five reservations and refused one micro below), every step of a chain records one manifest, the rollback
//     restores the earlier plan, and bootstrap admits v5 for an unconfigured account.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';
import { helpers } from './tryon-prompt.sessions.mjs';

const V2 = 'azure-global-image25-sunburst-tryon-v2';
const V3 = 'azure-global-image25-sunburst-tryon-v3';
const V4 = 'azure-global-image25-sunburst-tryon-v4';
const V5 = 'azure-global-image25-sunburst-tryon-v5';
const V6 = 'azure-global-image25-sunburst-tryon-v6';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const RESERVED = 360000;
const NOTICE = 3;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const md5 = (text) => createHash('md5').update(text).digest('hex');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const output = (label) => {
  const bytes = Buffer.from(`synthetic prompt3 try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: sha(bytes) };
};
function equal(actual, expected, label = '') {
  if (isDeepStrictEqual(actual, expected)) return;
  const at = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/^at /, '').split(/[\\\\/]/).pop() ?? '';
  const text = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v))?.slice(0, 600);
  console.log(`PROMPT3-MISMATCH ${label} (${at}) expected ${text(expected)} actual ${text(actual)}`);
  requireEvidence(false);
}
function ok(condition, label = '') {
  if (condition) return;
  console.log(`PROMPT3-MISMATCH ${label} expected a refusal or a true condition`);
  requireEvidence(false);
}

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const V4_MIGRATION = '20261109110000_tryon_prompt_v4.sql';
const V5_MIGRATION = '20261111090000_tryon_prompt_v5.sql';
const CLAIM = 'public.tryon_claim(uuid,uuid,integer,uuid,text,uuid,text,uuid,uuid[])';
const BOOTSTRAP = 'public.tryon_bootstrap(uuid,text,integer,bigint,bigint,integer)';
const REPLACED = [CLAIM, BOOTSTRAP];
const REPLACED_LIST = REPLACED.map((sig) => `'${sig}'::regprocedure`).join(',');
const PIN34 = `m.id not in ('${V3}','${V4}')`;
const PIN345 = `m.id not in ('${V3}','${V4}','${V5}')`;
const ANCHOR = "    v_n := jsonb_array_length(v_steps);\n    if v_n=0 then return jsonb_build_object('code','NO_GARMENTS','claimed',false); end if;";
const DRAWN = `    v_steps := private.tryon_drawn_steps(m.id,v_steps);\n${ANCHOR}`;
// The text between `as $$` and its closing `$$;`, exactly what pg_proc.prosrc holds.
const bodyOf = async (file, name) => {
  const text = await readFile(new URL(file, MIGRATIONS), 'utf8');
  const from = text.indexOf(`create or replace function public.${name}(`);
  requireEvidence(from >= 0);
  const open = text.indexOf('as $$', from) + 'as $$'.length;
  return text.slice(open, text.indexOf('\n$$;', open) + 1);
};
const expectedBody = (v4Body, name) => (name === 'tryon_claim'
  ? v4Body.replace(PIN34, () => PIN345).replace(ANCHOR, () => DRAWN) : v4Body.replace(PIN34, () => PIN345));

const digest = (table, where = 'true') => `select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(to_jsonb(t)::text,'|'
  order by to_jsonb(t)::text),'')))::text from ${table} t where ${where}`;
const TABLES = ['private.ai_controls', 'private.ai_usage', 'private.ai_usage_evidence', 'private.tryon_chains', 'private.tryon_attempts',
  'private.tryon_results', 'private.tryon_person_photos', 'private.tryon_chain_stops', 'private.provider_capacity', 'private.provider_slots'];
const STATE = Object.freeze({
  replaced: `select jsonb_agg(jsonb_build_object('sig',p.oid::regprocedure::text,'oid',p.oid::bigint,'owner',pg_get_userbyid(p.proowner),
    'acl',p.proacl::text,'secdef',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile::text,'kind',p.prokind::text) order by p.oid::regprocedure::text)::text
    from pg_proc p where p.oid in (${REPLACED_LIST})`,
  // Every other function of the two schemas, apart from the one new helper that the migration adds.
  functions: `select jsonb_build_object('count',count(*),'md5',md5(string_agg(p.oid::regprocedure::text||'|'||pg_get_functiondef(p.oid)||'|'||
    coalesce(p.proacl::text,''),E'\\n' order by p.oid::regprocedure::text)))::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f' and p.oid not in (${REPLACED_LIST}) and p.proname<>'tryon_drawn_steps'`,
  triggers: `select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(pg_get_triggerdef(t.oid),'|' order by t.tgname,t.tgrelid::regclass::text),'')))::text
    from pg_trigger t where not t.tgisinternal`,
  manifests: digest('private.ai_execution_manifests', `t.id<>'${V5}'`),
  deployments: digest('private.provider_deployments', `t.manifest_id<>'${V5}'`),
  ...Object.fromEntries(TABLES.map((table) => [table, digest(table)])),
});
async function state(one) {
  const out = {};
  for (const [part, query] of Object.entries(STATE)) out[part] = await one(query);
  return out;
}

// The prior inventory: both owners configured at v4 with one genuine held claim whose chain still includes outerwear.
export async function tryonPrompt3Checkpoint(snapshot, sql, mark = () => {}) {
  const h = helpers(snapshot, sql);
  const { a, one, scalar, claim } = h;
  mark('prior-inventory');
  equal(await scalar(`select count(*) from private.ai_execution_manifests where id=${literal(V5)};`), '0');
  equal(await scalar(`select count(*) from pg_proc where proname='tryon_drawn_steps';`), '0');
  mark('predecessor-bodies');
  for (const [index, name] of ['tryon_claim', 'tryon_bootstrap'].entries()) {
    const body = await bodyOf(V4_MIGRATION, name);
    equal(await scalar(`select md5(prosrc) from pg_proc where oid='${REPLACED[index]}'::regprocedure;`), md5(body), name);
  }
  mark('configure');
  const before = await h.configure(V4, NOTICE);
  try {
    const top = await h.garment('top'), outerwear = await h.garment('outerwear');
    mark('claim-held');
    const chain = h.fresh(), id = randomUUID();
    const held = await claim(a, chain, 1, id, V4, { items: [outerwear, top] });
    equal([held.code, held.claimed, held.manifestId, held.steps], ['OK', true, V4, 2]);
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
export async function tryonPrompt3Compare(checkpoint, snapshot, sql, mark = () => {}) {
  const { h, before, chain, id, doc } = checkpoint;
  const { a, one, scalar, release } = h;
  try {
    mark('state-compare');
    const now = await state(one);
    for (const part of Object.keys(doc)) {
      if (!isDeepStrictEqual(now[part], doc[part])) { mark(`state-differs-${part}`); requireEvidence(false); }
    }
    mark('bodies');
    const v4 = await Promise.all(['tryon_claim', 'tryon_bootstrap'].map((name) => bodyOf(V4_MIGRATION, name)));
    const v5 = await Promise.all(['tryon_claim', 'tryon_bootstrap'].map((name) => bodyOf(V5_MIGRATION, name)));
    for (const [index, name] of ['tryon_claim', 'tryon_bootstrap'].entries()) {
      mark(`body-${name}`);
      equal(v4[index].split(PIN34).length, 2, `${name}-pin-count`);
      equal(v5[index], expectedBody(v4[index], name), `${name}-only-delta`);
      equal(await scalar(`select md5(prosrc) from pg_proc where oid='${REPLACED[index]}'::regprocedure;`), md5(v5[index]), `${name}-installed`);
    }
    mark('manifest-v5');
    const differing = await one(`select jsonb_agg(e.key order by e.key) from private.ai_execution_manifests n
      join private.ai_execution_manifests o on o.id=${literal(V4)}, jsonb_each(to_jsonb(n)) e
      where n.id=${literal(V5)} and to_jsonb(o)->e.key is distinct from e.value;`);
    equal(differing, ['id', 'prompt_sha256', 'prompt_version', 'settings_sha256', 'tariff_description']);
    equal(await one(`select jsonb_build_array((select prompt_version from private.ai_execution_manifests where id=${literal(V5)}),
      (select count(distinct deployment_key) from private.provider_deployments where manifest_id like 'azure-global-image25-sunburst-tryon-v%'),
      (select count(*) from private.provider_deployments where manifest_id like 'azure-global-image25-sunburst-tryon-v%'),
      (select count(*) from private.ai_execution_manifests where id like 'azure-global-image25-sunburst-tryon-%'));`), [5, 1, 5, 5]);
    mark('helper-properties');
    equal(await one(`select jsonb_build_array(p.prosecdef,p.provolatile::text,p.proconfig,p.proacl is not null
      and not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),has_function_privilege('anon',p.oid,'EXECUTE'),
      has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE'),n.nspname)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid='private.tryon_drawn_steps(text,jsonb)'::regprocedure;`),
    [false, 'i', ['search_path=""'], true, false, false, false, 'private']);
    equal(await scalar(`select count(*) from pg_proc where proname='tryon_drawn_steps';`), '1');
    mark('helper-behaviour');
    const plan = '[{"slot":"top","itemId":"a"},{"slot":"outerwear","itemId":"b"},{"slot":"footwear","itemId":"c"}]';
    equal(await one(`select private.tryon_drawn_steps(${literal(V5)},${literal(plan)}::jsonb);`),
      [{ slot: 'top', itemId: 'a' }, { slot: 'footwear', itemId: 'c' }]);
    equal(await one(`select private.tryon_drawn_steps(${literal(V5)},'[{"slot":"outerwear","itemId":"b"}]'::jsonb);`), []);
    for (const manifest of [V2, V3, V4, V6]) {
      equal(await one(`select private.tryon_drawn_steps(${literal(manifest)},${literal(plan)}::jsonb);`), JSON.parse(plan), manifest);
    }
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

// After the migration: the plan follows the controls' manifest, the guarded switch moves both accounts, and the rollback restores the plan.
export async function tryonPrompt3Probes(snapshot, sql, mark = () => {}) {
  const h = helpers(snapshot, sql);
  const { a, b, one, scalar, claim, dispatch, finish } = h;
  const switchText = await readFile(new URL('../../docs/tryon-manifest-switch.sql', import.meta.url), 'utf8');
  const run = async (text) => { try { await sql(text); return null; } catch (error) { return error; } };
  const runGuard = (from, to) => run(switchText.replaceAll('<from>', from).replaceAll('<to>', to));
  const installed = async () => [await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(a.uid)};`),
    await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(b.uid)};`)];
  const chainRows = (chain) => scalar(`select count(*) from private.tryon_chains where chain_id=${literal(chain)};`);
  const live = () => scalar(`select (select count(*) from private.ai_usage where purpose='try_on' and charge_state in ('reserved','held'))::text||':'||
    (select count(*) from private.tryon_chains where state='running')::text||':'||
    (select count(*) from private.tryon_results where state='reserved')::text;`);
  const evidence = (chain) => one(`select jsonb_agg(e.manifest_id::text order by u.tryon_step) from private.ai_usage u
    join private.ai_usage_evidence e on e.owner_id=u.owner_id and e.request_id=u.request_id where u.tryon_chain_id=${literal(chain)};`);
  const slotsOf = (chain) => one(`select jsonb_agg(e.s->>'slot' order by e.n) from private.tryon_chains c,
    jsonb_array_elements(c.steps) with ordinality e(s,n) where c.chain_id=${literal(chain)};`);
  const itemsOf = (chain) => one(`select jsonb_agg(e.s->>'itemId' order by e.n) from private.tryon_chains c,
    jsonb_array_elements(c.steps) with ordinality e(s,n) where c.chain_id=${literal(chain)};`);
  const resultItems = (chain) => one(`select to_jsonb(item_ids) from private.tryon_results where chain_id=${literal(chain)};`);
  const attempts = (chain) => scalar(`select count(*) from private.tryon_attempts where chain_id=${literal(chain)};`);
  const consentState = () => one(`select jsonb_agg(jsonb_build_array(owner_id::text,tryon_activated,tryon_notice_revision,tryon_consent_revision,
    tryon_consented_at::text,tryon_max_request_micro::text,tryon_monthly_allowance_micro::text,tryon_max_requests_per_hour)
    order by owner_id) from private.ai_controls where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
  const strip = (c) => Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'updated_at' && key !== 'tryon_manifest_id'));
  const freeSlots = () => sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
    where deployment_key=${literal(KEY)} and held_until>clock_timestamp();`);
  // One step of a chain through claim, dispatch and finish; returns the output hash the next step needs.
  const step = async (chain, n, manifest, items, person, last, outfit = null) => {
    const id = randomUUID();
    let claimed;
    if (outfit === null) claimed = await claim(a, chain, n, id, manifest, { items, person });
    else {
      await freeSlots();
      claimed = await one(`select public.tryon_claim(${literal(a.uid)},${literal(chain)},${n},${literal(id)},${literal(manifest)},${literal(outfit)}::uuid,
        null::text,null::uuid,null::uuid[]);`);
    }
    equal([claimed.code, claimed.claimed, claimed.manifestId], ['OK', true, manifest], `claim-${n}`);
    equal((await dispatch(a, id)).code, 'AUTHORISED', `dispatch-${n}`);
    const out = output(`${n}`);
    const done = await finish(a, id, out, last);
    equal([done.code, done.last], ['OK', last], `finish-${n}`);
    return out.sha;
  };
  // A whole chain: the steps expected from the plan, the first one named by `items` (or by `outfit`).
  const chainOf = async (manifest, slots, items, outfit = null) => {
    const chain = h.fresh();
    let person = null;
    for (let n = 1; n <= slots; n += 1) person = await step(chain, n, manifest, n === 1 ? items : null, person, n === slots, n === 1 ? outfit : null);
    return chain;
  };
  const outfits = [];
  const saveOutfit = async (ids, title) => {
    const id = randomUUID();
    equal(Number(await h.rpc(a, 'save_outfit', { p_id: id, p_title: title, p_occasion: 'everyday', p_notes: '', p_favourite: false,
      p_item_ids: ids, p_expected_version: null })), 1, 'save-outfit');
    outfits.push(id);
    return id;
  };
  const claimOutfit = async (outfit, manifest, chain, id) => {
    await freeSlots();
    return one(`select public.tryon_claim(${literal(a.uid)},${literal(chain)},1,${literal(id)},${literal(manifest)},${literal(outfit)}::uuid,
      null::text,null::uuid,null::uuid[]);`);
  };

  mark('structure');
  equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
      not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),has_function_privilege('anon',p.oid,'EXECUTE'),
      has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE')))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('tryon_claim','tryon_bootstrap');`), {
    tryon_claim: [true, true, false, false, true], tryon_bootstrap: [true, true, false, false, false],
  });
  const before = await h.configure(V4, NOTICE);
  try {
    mark('configured-accounts');
    equal(await installed(), [V4, V4]);
    mark('saved-photos');
    for (const owner of [a, b]) equal((await h.putPhoto(owner)).code, 'OK');
    const photos = await h.photos();
    equal(Object.keys(photos).length, 2);
    const consent = await consentState();
    const controls = [strip(await h.controls(a)), strip(await h.controls(b))];

    mark('bootstrap');
    const boot = (manifest) => one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(manifest)},${NOTICE},${RESERVED},5000000,1000);`);
    equal(await boot(V4), { code: 'OK', replayed: true });
    equal((await boot(V5)).code, 'CONFLICT');
    equal((await boot(V3)).code, 'CONFLICT');
    equal((await boot(V2)).code, 'UNCONFIGURED');
    equal((await boot(V6)).code, 'UNCONFIGURED');

    mark('garments');
    const top = await h.garment('top'), bottom = await h.garment('bottom'), outerwear = await h.garment('outerwear'),
      coat2 = await h.garment('outerwear'), layer = await h.garment('layer'), footwear = await h.garment('footwear'),
      accessory = await h.garment('accessory'), dress = await h.garment('one_piece');
    mark('nothing-live-before-admission');
    equal(await live(), '0:0:0');

    // 1. Under v4 controls the plan is what it was: outerwear is a step (this is also the state a rollback returns to).
    mark('v4-claim-v5-refused');
    const refused = h.fresh();
    equal(await claim(a, refused, 1, randomUUID(), V5, { items: [outerwear, top] }), { code: 'CONFIG_CHANGED', claimed: false });
    equal(await chainRows(refused), '0');
    equal(await live(), '0:0:0');
    mark('v4-chain-includes-outerwear');
    const chainV4 = await chainOf(V4, 3, [outerwear, top, bottom]);
    equal(await slotsOf(chainV4), ['top', 'bottom', 'outerwear']);
    equal(await evidence(chainV4), [V4, V4, V4]);
    equal(await live(), '0:0:0');

    // 2. The guarded switch (its algorithm is unchanged) moves both configured accounts and writes only the manifest.
    mark('guard-switch');
    equal(await runGuard(V4, V5), null);
    equal(await installed(), [V5, V5]);
    mark('guard-switch-writes-only-the-manifest');
    equal([strip(await h.controls(a)), strip(await h.controls(b))], controls);
    equal(await consentState(), consent);
    equal(await h.photos(), photos);

    // 3. Under v5 controls outerwear is never a step.
    mark('v5-claim-v4-refused');
    const late = h.fresh();
    equal(await claim(a, late, 1, randomUUID(), V4, { items: [outerwear, top] }), { code: 'CONFIG_CHANGED', claimed: false });
    equal(await chainRows(late), '0');
    equal(await live(), '0:0:0');
    mark('v5-idea-chain-without-outerwear');
    const chain1 = h.fresh(), id1 = randomUUID();
    const first = await claim(a, chain1, 1, id1, V5, { items: [outerwear, top, bottom, footwear] });
    equal([first.code, first.claimed, first.manifestId, first.steps, first.slot, first.last], ['OK', true, V5, 3, 'top', false]);
    equal(await slotsOf(chain1), ['top', 'bottom', 'footwear']);
    equal(await itemsOf(chain1), [top, bottom, footwear]);
    equal(await resultItems(chain1), [top, bottom, footwear]);
    equal((await dispatch(a, id1)).code, 'AUTHORISED');
    const out1 = output('v5-1');
    equal((await finish(a, id1, out1, false)).code, 'OK');
    const person2 = out1.sha;
    const person3 = await step(chain1, 2, V5, null, person2, false);
    mark('v5-guard-back-refused-running-chain');
    ok(await runGuard(V5, V4) !== null, 'back-running');
    equal(await installed(), [V5, V5]);
    await step(chain1, 3, V5, null, person3, true);
    equal(await attempts(chain1), '3');
    equal(await evidence(chain1), [V5, V5, V5]);
    equal(await live(), '0:0:0');
    mark('v5-two-coats-same-plan');
    const chain2 = h.fresh(), id2 = randomUUID();
    const two = await claim(a, chain2, 1, id2, V5, { items: [coat2, outerwear, top, bottom, footwear] });
    equal([two.code, two.steps], ['OK', 3]);
    equal(await itemsOf(chain2), [top, bottom, footwear]);
    mark('v5-two-coats-release');
    await h.release(a, id2);
    equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: chain2 })).code, 'CANCELLED');
    equal(await live(), '0:0:0');
    mark('v5-one-piece-and-layer');
    const chain3 = await chainOf(V5, 2, [outerwear, dress, layer]);
    equal(await slotsOf(chain3), ['one_piece', 'layer']);
    equal(await evidence(chain3), [V5, V5]);
    mark('v5-layer-still-drawn');
    const chain4 = await chainOf(V5, 2, [top, layer, outerwear]);
    equal(await slotsOf(chain4), ['top', 'layer']);
    mark('v5-single-garment-with-coat');
    const chain5 = await chainOf(V5, 1, [outerwear, top]);
    equal(await slotsOf(chain5), ['top']);

    mark('v5-outerwear-only-idea');
    const noneIdea = h.fresh();
    const usageBefore = await scalar(`select count(*) from private.ai_usage;`);
    equal(await claim(a, noneIdea, 1, randomUUID(), V5, { items: [outerwear] }), { code: 'NO_GARMENTS', claimed: false });
    equal(await chainRows(noneIdea), '0');
    equal(await scalar(`select count(*) from private.ai_usage;`), usageBefore);
    equal(await live(), '0:0:0');
    mark('v5-saved-outfit-without-outerwear');
    const outfit = await saveOutfit([outerwear, top, bottom], 'Fictional prompt3 outfit');
    const chain6 = h.fresh(), id6 = randomUUID();
    const saved = await claimOutfit(outfit, V5, chain6, id6);
    equal([saved.code, saved.claimed, saved.steps, saved.slot], ['OK', true, 2, 'top']);
    equal(await slotsOf(chain6), ['top', 'bottom']);
    equal((await dispatch(a, id6)).code, 'AUTHORISED');
    const out6 = output('v5-outfit-1');
    equal((await finish(a, id6, out6, false)).code, 'OK');
    await step(chain6, 2, V5, null, out6.sha, true);
    equal(await resultItems(chain6), [top, bottom]);
    equal(await evidence(chain6), [V5, V5]);
    mark('v5-saved-outfit-only-outerwear');
    const coatOutfit = await saveOutfit([outerwear], 'Fictional prompt3 coat only');
    const noneOutfit = h.fresh();
    equal(await claimOutfit(coatOutfit, V5, noneOutfit, randomUUID()), { code: 'NO_GARMENTS', claimed: false });
    equal(await chainRows(noneOutfit), '0');
    equal(await live(), '0:0:0');

    // 4. Admission counts the drawn steps only: five drawn steps and a coat are admitted at exactly five reservations and refused one micro below.
    mark('v5-budget-refused-one-micro-below');
    const budgetItems = [outerwear, top, bottom, layer, footwear, accessory];
    const setAllowance = (delta) => sql(`update private.ai_controls set monthly_allowance_micro=
      private.ai_budget_used(${literal(a.uid)},clock_timestamp())::bigint+${5 * RESERVED + delta},updated_at=clock_timestamp()
      where owner_id=${literal(a.uid)};`);
    await setAllowance(-1);
    const over = h.fresh();
    equal(await claim(a, over, 1, randomUUID(), V5, { items: budgetItems }), { code: 'ALLOWANCE', claimed: false });
    equal(await chainRows(over), '0');
    equal(await live(), '0:0:0');
    mark('v5-budget-admitted-at-five');
    await setAllowance(0);
    const five = h.fresh(), idFive = randomUUID();
    const admitted = await claim(a, five, 1, idFive, V5, { items: budgetItems });
    equal([admitted.code, admitted.claimed, admitted.steps], ['OK', true, 5]);
    equal(await slotsOf(five), ['top', 'bottom', 'layer', 'footwear', 'accessory']);
    mark('v5-budget-release');
    await h.release(a, idFive);
    equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: five })).code, 'CANCELLED');
    equal(await live(), '0:0:0');
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,updated_at=clock_timestamp() where owner_id=${literal(a.uid)};`);

    // 5. The rollback restores the earlier plan, and every chain kept its one manifest.
    mark('guard-rollback');
    equal(await runGuard(V5, V4), null);
    equal(await installed(), [V4, V4]);
    equal([strip(await h.controls(a)), strip(await h.controls(b))], controls);
    equal(await consentState(), consent);
    equal(await h.photos(), photos);
    mark('rollback-v5-refused');
    equal(await claim(a, h.fresh(), 1, randomUUID(), V5, { items: [outerwear, top] }), { code: 'CONFIG_CHANGED', claimed: false });
    mark('rollback-plan-includes-outerwear');
    const back = h.fresh(), idBack = randomUUID();
    const rolled = await claim(a, back, 1, idBack, V4, { items: [outerwear, top] });
    equal([rolled.code, rolled.steps], ['OK', 2]);
    equal(await slotsOf(back), ['top', 'outerwear']);
    await h.release(a, idBack);
    equal((await h.rpc(a, 'tryon_cancel', { p_chain_id: back })).code, 'CANCELLED');
    equal(await live(), '0:0:0');
    mark('one-manifest-per-chain');
    equal(await evidence(chainV4), [V4, V4, V4]);
    equal(await evidence(chain1), [V5, V5, V5]);

    // 6. Bootstrap admits v5 for an account that has no try-on configuration yet; nothing else about it changes.
    mark('unconfigured-bootstrap');
    await sql(`update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,tryon_manifest_id=null,
      tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,tryon_max_requests_per_hour=null
      where owner_id=${literal(b.uid)};`);
    equal(await one(`select public.tryon_bootstrap(${literal(b.uid)},${literal(V5)},${NOTICE},${RESERVED},5000000,1000);`), { code: 'OK', replayed: false });
    equal(await scalar(`select tryon_manifest_id from private.ai_controls where owner_id=${literal(b.uid)};`), V5);
    mark('done');
  } finally {
    for (const id of outfits) {
      await sql(`delete from public.outfit_items where owner_id=${literal(a.uid)} and outfit_id=${literal(id)};
        delete from public.outfits where owner_id=${literal(a.uid)} and id=${literal(id)};`).catch(() => {});
    }
    await h.restore(before);
  }
}
