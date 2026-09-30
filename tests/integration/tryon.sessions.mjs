// VTO-1: the inactive virtual try-on backend against the real schema at the full migration inventory. Invoked only by
// the CI-only preservation owner after the AD1 probes (a database reset follows). tryon_claim, tryon_dispatch,
// tryon_finish and tryon_probe_authorise are service functions, tryon_expire_due, tryon_bootstrap and
// tryon_discard_transient are database-owner functions; they are called here through privileged SQL the way the Edge
// handler, cron and the operator call them. Every owner read, cancel, delete and isolation assertion uses the ordinary
// A/B sessions. The shared switch, capacity and controls are opened only inside this probe and restored in finally.
// Timing cases move the durable evidence back with the guard trigger briefly disabled (test-only). No provider calls.
// VTO-3a stop markers are durable rows: this probe tracks each one it creates and removes exactly those in finally,
// then checks that no marker is left for any chain ID it used.
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';
import { intent, saveHarness } from './item-save.sessions.mjs';

// The admin parsers: the frozen AD1b v1 parser that already-installed apps run (tests/fixtures/admin-limits-v1.ts, a
// verbatim copy) and the app's current v2 parser. The app's extensionless imports ('../i18n') are resolved to the .ts
// sources for this test only; Node strips the types.
let hooked = false;
const adminParser = () => {
  if (!hooked) {
    hooked = true;
    registerHooks({
      resolve(specifier, context, next) {
        try {
          return next(specifier, context);
        } catch (error) {
          if (!['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error?.code) || !specifier.startsWith('.')
            || !context.parentURL?.includes('/src/')) throw error;
          for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
            try { return next(candidate, context); } catch { /* try the next form */ }
          }
          throw error;
        }
      },
    });
  }
  return Promise.all([import(new URL('../fixtures/admin-limits-v1.ts', import.meta.url).href),
    import(new URL('../../src/domain/admin-limits.ts', import.meta.url).href)])
    .then(([v1, v2]) => ({ parseSpending: v1.parseSpending, parseSpendingV2: v2.parseSpending }));
};

const MANIFEST = 'azure-global-image25-sunburst-tryon-v1';
const KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const RESERVED = 360000;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const orNull = (value, cast) => (value === null ? `null::${cast}` : `${literal(value)}::${cast}`);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// ceil((9000*800 + 6000*3000)/100) = 252000 micro-USD under the try-on manifest prices.
const VALID = Object.freeze({ modelObservation: 'expected_snapshot', input: 9000, output: 6000, total: 15000, inputText: 200,
  inputImage: 8800 });
const ESTIMATE = '252000';
const output = (label) => {
  const bytes = Buffer.from(`synthetic try-on output ${label} ${randomUUID()}`);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
};

export async function tryonProbes(snapshot, sql, mark) {
  const { client, owners: [a, b] } = snapshot;
  const one = async (text) => JSON.parse(await sql(text));
  const scalar = async (text) => (await sql(text)).trim();
  const freeSlots = () => sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second'
    where deployment_key=${literal(KEY)} and held_until>clock_timestamp();`);
  // The shared capacity stays at its default 2 per 60 s: a claim first frees earlier test slots, unless the case is
  // about the slots themselves or about a code decided before the slot check ({ hold: true }).
  const claimCall = (owner, chain, step, id, { outfit = null, person = null, probe = null } = {}) => `public.tryon_claim(
    ${literal(owner.uid)},${literal(chain)},${step},${literal(id)},${literal(MANIFEST)},${orNull(outfit, 'uuid')},
    ${orNull(person, 'text')},${orNull(probe, 'uuid')})`;
  const claim = async (owner, chain, step, id, { outfit = null, person = null, probe = null, hold = false } = {}) => {
    if (!hold) await freeSlots();
    return one(`select ${claimCall(owner, chain, step, id, { outfit, person, probe })};`);
  };
  const dispatch = (owner, id, present = true) => one(`select public.tryon_dispatch(${literal(owner.uid)},${literal(id)},${present});`);
  const finishCall = (owner, id, code, { usage = VALID, out = null, send = false, fetched = true, live = true, gone = false } = {}) =>
    `public.tryon_finish(${literal(owner.uid)},${literal(id)},${literal(code)},${usage === null ? 'null::jsonb' : json(usage)},
      ${orNull(out?.sha ?? null, 'text')},${out === null ? 'null::integer' : out.bytes.length},
      ${send ? `decode(${literal(out.bytes.toString('hex'))},'hex')` : 'null::bytea'},${fetched},
      ${fetched ? String(live) : 'null::boolean'},${gone})`;
  const finish = (owner, id, code, options = {}) => one(`select ${finishCall(owner, id, code, options)};`);
  const ledger = (owner, id) => one(`select coalesce((select jsonb_build_object('state',u.charge_state,'accounted',u.accounted_micro::text,
      'closed',u.closed_reason,'origin',e.enhance_settlement_origin,'code',e.enhance_code,'anomaly',e.anomaly,
      'authorised',e.tryon_dispatch_authorised_at is not null,'fetch',e.tryon_fetch_started,'live',e.tryon_client_live_at_fetch,
      'gone',e.tryon_client_gone_at_finish)
    from private.ai_usage u join private.ai_usage_evidence e using (owner_id,request_id)
    where u.owner_id=${literal(owner.uid)} and u.request_id=${literal(id)}),'null'::jsonb);`);
  const rows = (owner) => one(`select jsonb_build_object('usage',(select count(*) from private.ai_usage where owner_id=${literal(owner.uid)}
      and purpose='try_on'),'slots',(select count(*) from private.provider_slots where deployment_key=${literal(KEY)}
      and held_until>clock_timestamp()),'results',(select count(*) from private.tryon_results where owner_id=${literal(owner.uid)}),
      'chains',(select count(*) from private.tryon_chains where owner_id=${literal(owner.uid)}));`);
  const controls = (owner) => one(`select to_jsonb(c) from private.ai_controls c where owner_id=${literal(owner.uid)};`);
  const capacity = () => one(`select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(KEY)};`);
  const expireDue = () => one('select public.tryon_expire_due(500);');
  const health = () => one('select public.tryon_purge_health();');
  // An unauthorised claim is released by the Edge's PRE_DISPATCH finish; used to clear capacity and race cases.
  const release = (owner, id) => finish(owner, id, 'PRE_DISPATCH', { usage: null, fetched: false });
  const live = (owner) => scalar(`select count(*) from private.tryon_results where owner_id=${literal(owner.uid)}
    and (state='reserved' or expires_at>clock_timestamp());`).then(Number);
  const setControls = (owner, assignments) => sql(`update private.ai_controls set ${assignments},updated_at=clock_timestamp()
    where owner_id=${literal(owner.uid)};`);
  const reopen = () => sql(`update private.provider_capacity set dispatch_enabled=true,disabled_reason=null,disabled_at=null,
    updated_at=clock_timestamp() where deployment_key=${literal(KEY)};`);
  // Test-only move of a running chain past its 30 minutes (both columns, so the fixed-length check still holds).
  const ageChain = (owner, chain) => sql(`update private.tryon_chains set created_at=created_at-interval '31 minutes',
    expires_at=expires_at-interval '31 minutes' where owner_id=${literal(owner.uid)} and chain_id=${literal(chain)};`);
  // One full step: claim, mark, finish OK. The last step sends the picture.
  const runStep = async (owner, chain, n, { outfit = null, person = null, probe = null, last = false, usage = VALID } = {}) => {
    const id = randomUUID();
    const claimed = await claim(owner, chain, n, id, { outfit: n === 1 ? outfit : null, person, probe });
    requireEvidence(claimed.code === 'OK' && claimed.last === last);
    equal((await dispatch(owner, id)).code, 'AUTHORISED');
    const out = output(`${n}`);
    const done = await finish(owner, id, 'OK', { usage, out, send: last });
    requireEvidence(done.code === 'OK' && done.last === last);
    return { id, out, done };
  };
  // Test-only time travel on the durable evidence: the guard forbids every such change outside this probe.
  const backdate = (owner, id, interval) => sql(`begin;
    alter table private.ai_usage_evidence disable trigger ai_usage_evidence_tryon_guard;
    update private.ai_usage_evidence set tryon_dispatch_before=tryon_dispatch_before-interval '${interval}',
      tryon_dispatch_authorised_at=tryon_dispatch_authorised_at-interval '${interval}'
      where owner_id=${literal(owner.uid)} and request_id=${literal(id)};
    update private.ai_usage set created_at=created_at-interval '${interval}',dispatched_at=dispatched_at-interval '${interval}'
      where owner_id=${literal(owner.uid)} and request_id=${literal(id)};
    alter table private.ai_usage_evidence enable trigger ai_usage_evidence_tryon_guard;
    commit;`);
  // Stop, through the owner's session, every chain this probe left running (their reserved slots count to twenty).
  const stopRunning = async (owner) => {
    const running = await one(`select coalesce(jsonb_agg(chain_id),'[]'::jsonb) from private.tryon_chains
      where owner_id=${literal(owner.uid)} and state='running';`);
    for (const id of running) equal(await rpc(owner, 'tryon_cancel', { p_chain_id: id }), { code: 'CANCELLED' });
  };
  const rpc = (owner, name, body) => client.rpc(owner, name, body);

  // VTO-3a stop markers. `expected` holds the owner:chain keys of markers this probe really created and that still
  // exist; a key is added only after the row is read back and removed only after its purge or discard is verified.
  // `used` is every chain ID this probe cancelled or seeded, for the residue check in finally.
  const expected = new Set(), used = new Set();
  const markerKey = (owner, chain) => `${owner.uid}:${chain}`;
  const markers = (owner, chain = null) => scalar(`select count(*) from private.tryon_chain_stops where owner_id=${literal(owner.uid)}
    ${chain === null ? '' : `and chain_id=${literal(chain)}`};`).then(Number);
  const recentMarkers = (owner) => scalar(`select count(*) from private.tryon_chain_stops where owner_id=${literal(owner.uid)}
    and created_at>clock_timestamp()-interval '1 hour';`).then(Number);
  const stop = (owner, chain) => { used.add(chain); return rpc(owner, 'tryon_cancel', { p_chain_id: chain }); };
  const created = async (owner, chain) => {
    equal(await markers(owner, chain), 1);
    expected.add(markerKey(owner, chain));
  };
  // Everything a claim could have written for one chain and its request IDs, plus the live shared slots.
  const chainRows = (owner, chain, ids) => one(`select jsonb_build_object(
      'usage',(select count(*) from private.ai_usage where owner_id=${literal(owner.uid)}
        and (tryon_chain_id=${literal(chain)} or request_id in (${ids.map(literal).join(',')}))),
      'evidence',(select count(*) from private.ai_usage_evidence where owner_id=${literal(owner.uid)}
        and request_id in (${ids.map(literal).join(',')})),
      'chains',(select count(*) from private.tryon_chains where owner_id=${literal(owner.uid)} and chain_id=${literal(chain)}),
      'attempts',(select count(*) from private.tryon_attempts where owner_id=${literal(owner.uid)} and chain_id=${literal(chain)}),
      'results',(select count(*) from private.tryon_results where owner_id=${literal(owner.uid)} and chain_id=${literal(chain)}),
      'slots',(select count(*) from private.provider_slots where deployment_key=${literal(KEY)} and held_until>clock_timestamp()));`);
  // A privileged transaction that runs `statement`, then sleeps `seconds` holding its locks (admin-limits pattern). The
  // marker identifies it in pg_stat_activity; each case uses its own duration, under the functions' 2 s lock_timeout.
  // It returns a NON-thenable handle once the holder sleeps: awaiting the handle must not wait for the commit, or every
  // competitor would start after the lock is gone. `open()` proves the holder is still sleeping when a case checks it,
  // and `done` is awaited only at the intended release point.
  const holdTx = async (statement, seconds, end = 'commit') => {
    const marker = `pg_sleep(${seconds})`;
    let settled = false;
    const done = sql(`begin; ${statement}; select 'HELD'; select ${marker}; ${end}; select 'DONE';`)
      .finally(() => { settled = true; });
    done.catch(() => {});
    for (const until = Date.now() + 5000; ;) {
      requireEvidence(!settled);
      if (await scalar(`select count(*) from pg_stat_activity where wait_event='PgSleep'
        and query like ${literal(`%${marker}%`)} and pid<>pg_backend_pid();`) === '1') {
        return { done, marker, open: () => !settled };
      }
      requireEvidence(Date.now() < until);
      await delay(25);
    }
  };
  const heldReply = (out) => JSON.parse(out.split('\n').map((line) => line.trim()).find((line) => line.startsWith('R:')).slice(2));
  // The competing Stop must be seen waiting on a lock while the holder sleeps; otherwise the case fails.
  const cancelsWaiting = async (count) => {
    for (const until = Date.now() + 1200; ;) {
      if (Number(await scalar(`select count(*) from pg_stat_activity where wait_event_type='Lock'
        and query like '%tryon_cancel%' and pid<>pg_backend_pid();`)) === count) return;
      requireEvidence(Date.now() < until);
      await delay(10);
    }
  };
  const asOwner = (owner, text) => `set local role authenticated;
    select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: owner.uid, role: 'authenticated' }))},true); ${text}`;

  mark('structure');
  equal(await one(`select jsonb_object_agg(p.proname,jsonb_build_array(p.prosecdef and p.proconfig @> array['search_path=""'],
      not exists(select 1 from aclexplode(p.proacl) x where x.grantee=0),
      has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('authenticated',p.oid,'EXECUTE'),
      has_function_privilege('service_role',p.oid,'EXECUTE')))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'tryon\\_%';`), {
    tryon_claim: [true, true, false, false, true], tryon_dispatch: [true, true, false, false, true],
    tryon_finish: [true, true, false, false, true], tryon_probe_authorise: [true, true, false, false, true],
    tryon_purge_health: [true, true, false, false, true],
    tryon_status: [true, true, false, true, false], tryon_set_consent: [true, true, false, true, false],
    tryon_chain_status: [true, true, false, true, false], tryon_cancel: [true, true, false, true, false],
    tryon_results_v1: [true, true, false, true, false], tryon_result_image_v1: [true, true, false, true, false],
    tryon_delete_result: [true, true, false, true, false],
    tryon_expire_due: [true, true, false, false, false], tryon_bootstrap: [true, true, false, false, false],
    tryon_discard_transient: [true, true, false, false, false] });
  // The purge job is active and runs the bounded expiry every 15 minutes.
  equal(await one(`select jsonb_build_object('schedule',schedule,'command',command,'active',active) from cron.job
    where jobname='stillroom-tryon-expire';`), { schedule: '*/15 * * * *', command: 'select public.tryon_expire_due(500)', active: true });
  const initial = await capacity();
  requireEvidence(initial.dispatch_enabled === false && initial.max_dispatch === 2 && initial.window_seconds === 60);
  const before = { a: await controls(a), b: await controls(b) };
  requireEvidence(before.a.activated === true && before.a.tryon_activated === false && before.b.tryon_activated === false
    && before.a.tryon_manifest_id === null && before.b.tryon_manifest_id === null);
  equal(await health(), { code: 'OK', overdueResults: 0, overdueChains: 0, heldUsage: 0, safeguard: false });

  // The BG2b probes just before this share the deployment and leave their last slots held until they end on their own;
  // free them so the empty-ledger checks below count only this probe's claims.
  await freeSlots();

  mark('normal-denied');
  // Each check names its own stage (function, session and status only; never a token or ID) before it can fail.
  const denied = (label, ok) => { if (!ok) mark(`normal-denied-${label}`); requireEvidence(ok); };
  const other = randomUUID();
  for (const [who, token] of [['A', a.token], ['B', b.token], ['anon', null]]) {
    for (const [name, body] of [
      ['tryon_claim', { p_owner_id: a.uid, p_chain_id: other, p_step: 1, p_request_id: other, p_manifest_id: MANIFEST,
        p_outfit_id: other, p_person_sha256: null, p_probe_id: null }],
      ['tryon_dispatch', { p_owner_id: a.uid, p_request_id: other, p_client_present: true }],
      ['tryon_finish', { p_owner_id: a.uid, p_request_id: other, p_code: 'PRE_DISPATCH', p_usage: null, p_output_sha256: null,
        p_output_bytes: null, p_output: null, p_fetch_started: false, p_client_live_at_fetch: null, p_client_gone: false }],
      ['tryon_expire_due', { p_limit: 10 }], ['tryon_purge_health', {}], ['tryon_discard_transient', {}],
      ['tryon_bootstrap', { p_owner_id: a.uid, p_manifest_id: MANIFEST, p_notice_revision: 1, p_max_request_micro: RESERVED,
        p_monthly_allowance_micro: 5000000, p_max_requests_per_hour: 6 }],
      ['tryon_probe_authorise', { p_id: other, p_owner_id: a.uid, p_manifest_id: MANIFEST, p_max_calls: 1,
        p_allocation_micro: RESERVED, p_approval_ref: 'denied', p_expires_at: new Date(Date.now() + 3600000).toISOString() }]]) {
      const refused = await client.request(token, `/rest/v1/rpc/${name}`, { method: 'POST', body });
      denied(`${name}-${who}-${refused.status}`, !refused.ok && [401, 403, 404].includes(refused.status));
    }
  }
  denied('controls', isDeepStrictEqual(await controls(a), before.a));
  const after = await rows(a);
  for (const [key, value] of Object.entries(after)) denied(`rows-${key}-${value}`, value === 0);
  // No table access for ordinary sessions: the private schema is not exposed.
  for (const table of ['tryon_chains', 'tryon_attempts', 'tryon_results', 'tryon_probe_authorisations']) {
    const read = await client.request(a.token, `/rest/v1/${table}?select=*`);
    denied(`${table}-${read.status}`, !read.ok && read.status >= 400 && read.status < 500);
  }

  const sh = saveHarness(client, a), shB = saveHarness(client, b);
  const outfits = [];
  let passed = false, markerError = null;
  try {
    mark('bootstrap');
    // Status before bootstrap: unconfigured, no policy. Bootstrap fills only null fields, never activation or consent.
    equal((await rpc(a, 'tryon_status', {})).code, 'UNCONFIGURED');
    await sql(`update private.ai_controls set monthly_allowance_micro=100000000,max_requests_per_hour=1000,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    const boot = (owner, allowance = 5000000) => one(`select public.tryon_bootstrap(${literal(owner.uid)},${literal(MANIFEST)},1,
      ${RESERVED},${allowance},1000);`);
    equal(await one(`select public.tryon_bootstrap(${literal(a.uid)},${literal(MANIFEST)},1,${RESERVED - 1},5000000,1000);`),
      { code: 'INVALID_LIMITS' });
    equal(await boot(a), { code: 'OK', replayed: false });
    equal(await boot(a), { code: 'OK', replayed: true });
    equal(await boot(a, 4000000), { code: 'CONFLICT' });
    equal(await boot(b), { code: 'OK', replayed: false });
    for (const owner of [a, b]) {
      const c = await controls(owner);
      requireEvidence(c.tryon_activated === false && c.tryon_consent_revision === null && c.tryon_manifest_id === MANIFEST
        && c.tryon_max_request_micro === RESERVED && c.tryon_monthly_allowance_micro === 5000000);
      equal((await rpc(owner, 'tryon_status', {})).code, 'INACTIVE');
    }
    // Consent is accepted while inactive; Turn off is accepted whatever the state.
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 2 })).code, 'CONFIG_CHANGED');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'INACTIVE');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).code, 'INACTIVE');
    requireEvidence((await controls(a)).tryon_consent_revision === null);

    mark('garments');
    const garment = async (harness, category) => {
      const value = harness.track(intent());
      value.p_item.category = category;
      value.p_item.title = `Fictional try-on ${category}`;
      const row = await harness.reserve(value);
      await harness.upload(value);
      await harness.finalize(value, row);
      return value;
    };
    const saveOutfit = async (owner, items) => {
      const id = randomUUID();
      await rpc(owner, 'save_outfit', { p_id: id, p_title: 'Fictional try-on outfit', p_occasion: 'everyday', p_notes: '',
        p_favourite: false, p_item_ids: items.map((value) => value.p_item.id), p_expected_version: null });
      outfits.push([owner, id]);
      return id;
    };
    const aTop = await garment(sh, 'top'), aBottom = await garment(sh, 'bottom'), aShoes = await garment(sh, 'footwear');
    const bTop = await garment(shB, 'top');
    const outfit = await saveOutfit(a, [aTop, aBottom, aShoes]);
    const outfitB = await saveOutfit(b, [bTop]);
    // One-garment outfits for the probe order's calls 4 and 5 (P3 and P2, each one step).
    const single = await saveOutfit(a, [aTop]), singleShoes = await saveOutfit(a, [aShoes]);

    mark('gates');
    const c0 = randomUUID();
    equal(await claim(a, c0, 1, randomUUID(), { outfit }), { code: 'INACTIVE', claimed: false });
    await sql(`update private.ai_controls set tryon_activated=true,updated_at=clock_timestamp()
      where owner_id in (${literal(a.uid)},${literal(b.uid)});`);
    equal(await claim(a, c0, 1, randomUUID(), { outfit }), { code: 'CONSENT_REQUIRED', claimed: false });
    for (const owner of [a, b]) equal((await rpc(owner, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    // The shared switch is still off: refused before any row or slot.
    equal(await claim(a, c0, 1, randomUUID(), { outfit }), { code: 'UNAVAILABLE', claimed: false });
    equal(await rows(a), { usage: 0, slots: 0, results: 0, chains: 0 });
    await sql(`update private.provider_capacity set dispatch_enabled=true,disabled_reason=null,disabled_at=null,
      updated_at=clock_timestamp() where deployment_key=${literal(KEY)};`);
    requireEvidence((await capacity()).max_dispatch === 2);
    // Room for every case below; the allowance cases set their own limits and restore these.
    for (const owner of [a, b]) await setControls(owner, 'tryon_monthly_allowance_micro=50000000');
    // A peer outfit is unknown to the claimant, the same as a missing one.
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: outfitB }), { code: 'NOT_FOUND', claimed: false });
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: randomUUID() }), { code: 'NOT_FOUND', claimed: false });
    equal((await rows(a)).usage, 0);

    mark('chain');
    const chain = randomUUID();
    let person = null, final = null;
    for (const step of [1, 2, 3]) {
      const id = randomUUID();
      const claimed = await claim(a, chain, step, id, { outfit: step === 1 ? outfit : null, person });
      requireEvidence(claimed.code === 'OK' && claimed.claimed === true && claimed.step === step && claimed.steps === 3
        && claimed.last === (step === 3) && claimed.slot === ['top', 'bottom', 'footwear'][step - 1]
        && claimed.reservationMicro === String(RESERVED) && claimed.garment.path.startsWith(`${a.uid}/`));
      // One attempt per step: a second request for the same step is BUSY and writes no usage or slot.
      const counted = await rows(a);
      equal(await claim(a, chain, step, randomUUID(), { person, hold: true }), { code: 'BUSY', claimed: false });
      equal(await rows(a), counted);
      // A request ID is used once.
      equal(await claim(a, randomUUID(), 1, id, { outfit, hold: true }), { code: 'TERMINAL', claimed: false });
      const marked = await dispatch(a, id);
      requireEvidence(marked.code === 'AUTHORISED' && marked.authorisedAtMs < marked.dispatchBeforeMs);
      equal(await dispatch(a, id), { code: 'ALREADY_AUTHORISED' });
      const out = output(step);
      const done = await finish(a, id, 'OK', { out, send: step === 3 });
      requireEvidence(done.code === 'OK' && done.last === (step === 3)
        && done.accounting.basis === 'estimated' && done.accounting.amountMicro === ESTIMATE);
      const replay = await finish(a, id, 'OK', { out, send: step === 3 });
      requireEvidence(replay.code === 'OK' && replay.replayed === true);
      equal((await finish(a, id, 'FAILED', { usage: VALID })).code, 'USAGE_CONFLICT');
      equal(await ledger(a, id), { state: 'estimated', accounted: ESTIMATE, closed: null, origin: 'observed', code: 'OK',
        anomaly: false, authorised: true, fetch: true, live: true, gone: false });
      if (step === 3) final = { done, out };
      person = out.sha;
    }
    const status = await rpc(a, 'tryon_chain_status', { p_chain_id: chain });
    requireEvidence(status.code === 'OK' && status.state === 'complete' && status.nextStep === 4
      && status.resultId === final.done.resultId && status.steps.length === 3);
    const listed = await rpc(a, 'tryon_results_v1', {});
    requireEvidence(listed.code === 'OK' && listed.results.length === 1 && listed.results[0].id === final.done.resultId
      && listed.results[0].outfitId === outfit && listed.results[0].bytes === final.out.bytes.length
      && listed.results[0].expiresAtMs - listed.results[0].completedAtMs === 7 * 24 * 3600 * 1000);
    const image = await rpc(a, 'tryon_result_image_v1', { p_result_id: final.done.resultId });
    requireEvidence(image.code === 'OK' && Buffer.from(image.jpegBase64, 'base64').equals(final.out.bytes));
    // Cancel after completion keeps the result and says so.
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: chain }), { code: 'COMPLETED', resultId: final.done.resultId });

    mark('isolation');
    // B cannot see, read or delete A's chain or result; foreign equals unknown.
    for (const [name, body] of [['tryon_chain_status', { p_chain_id: chain }],
      ['tryon_result_image_v1', { p_result_id: final.done.resultId }], ['tryon_delete_result', { p_result_id: final.done.resultId }]]) {
      equal(await rpc(b, name, body), { code: 'NOT_FOUND' });
      const unknown = Object.fromEntries(Object.keys(body).map((key) => [key, randomUUID()]));
      equal(await rpc(b, name, unknown), { code: 'NOT_FOUND' });
    }
    equal(await rpc(b, 'tryon_results_v1', {}), { code: 'OK', results: [] });
    requireEvidence(!JSON.stringify(await rpc(b, 'tryon_status', {})).includes(a.uid));
    // B's claim cannot adopt A's chain ID with A's outfit, nor continue A's chain.
    equal(await claim(b, chain, 1, randomUUID(), { outfit }), { code: 'NOT_FOUND', claimed: false });
    equal((await claim(b, chain, 2, randomUUID(), { person })).code, 'INVALID_INPUT');
    equal((await rows(b)).usage, 0);
    // VTO-3a: Stop of a chain B does not have records a stop under B's own ID only, so the reply is CANCELLED whether
    // or not A has that chain; it says nothing about A's chain, which keeps its result.
    for (const target of [chain, randomUUID()]) {
      equal(await stop(b, target), { code: 'CANCELLED' });
      await created(b, target);
    }
    equal(await markers(a, chain), 0);
    requireEvidence((await rpc(a, 'tryon_chain_status', { p_chain_id: chain })).state === 'complete'
      && (await rpc(a, 'tryon_result_image_v1', { p_result_id: final.done.resultId })).code === 'OK');
    // Deleting the result is the owner's; a replay of the final finish never resurrects it.
    equal(await rpc(a, 'tryon_delete_result', { p_result_id: final.done.resultId }), { code: 'OK' });
    equal(await rpc(a, 'tryon_result_image_v1', { p_result_id: final.done.resultId }), { code: 'NOT_FOUND' });
    // The other direction: B finishes a one-step chain; A can neither see nor touch it, nor mark or finish B's request.
    const chainB = randomUUID();
    const doneB = await runStep(b, chainB, 1, { outfit: outfitB, last: true });
    const usageA = await rows(a);
    for (const [name, body] of [['tryon_chain_status', { p_chain_id: chainB }],
      ['tryon_result_image_v1', { p_result_id: doneB.done.resultId }], ['tryon_delete_result', { p_result_id: doneB.done.resultId }]]) {
      equal(await rpc(a, name, body), { code: 'NOT_FOUND' });
    }
    requireEvidence(!(await rpc(a, 'tryon_results_v1', {})).results.some((r) => r.id === doneB.done.resultId));
    equal(await claim(a, chainB, 1, randomUUID(), { outfit: outfitB }), { code: 'NOT_FOUND', claimed: false });
    equal((await claim(a, chainB, 2, randomUUID(), { person: doneB.out.sha })).code, 'INVALID_INPUT');
    equal(await dispatch(a, doneB.id), { code: 'INVALID_INPUT' });
    equal((await finish(a, doneB.id, 'OK', { out: doneB.out, send: true })).code, 'INVALID_INPUT');
    equal(await rows(a), { ...usageA, slots: 0 });
    // A's Stop of B's chain is CANCELLED and only records A's own stop; B's chain and result are unchanged.
    equal(await stop(a, chainB), { code: 'CANCELLED' });
    await created(a, chainB);
    equal(await markers(b, chainB), 0);
    equal((await rpc(b, 'tryon_chain_status', { p_chain_id: chainB })).state, 'complete');
    const listedB = await rpc(b, 'tryon_results_v1', {});
    requireEvidence(listedB.results.length === 1 && listedB.results[0].id === doneB.done.resultId);
    equal(await rpc(b, 'tryon_delete_result', { p_result_id: doneB.done.resultId }), { code: 'OK' });
    await freeSlots();

    mark('admin-v1');
    // The deployed AD1b screen still parses the v1 spending read with try-on usage present: tryOn stays not available.
    // The VTO-2b screen parses the v2 read of the same accounts.
    const { parseSpending, parseSpendingV2 } = await adminParser();
    await sql(`insert into private.app_admins(owner_id,admission_no,admission_generation)
      select user_id,admission_no,generation from private.approved_accounts where user_id=${literal(a.uid)};`);
    try {
      // parseSpending refuses the whole reply unless every month's tryOn is exactly { available: false }.
      const raw = await rpc(a, 'admin_ai_spending', { p_months: 6 });
      const parsed = parseSpending(raw);
      requireEvidence(parsed !== null && parsed.months.length === 6 && parsed.accounts.length === 2
        && raw.accounts.every((account) => account.history.every((month) => isDeepStrictEqual(month.tryOn, { available: false }))));
      const parsedV2 = parseSpendingV2(await rpc(a, 'admin_ai_spending_v2', { p_months: 6 }));
      requireEvidence(parsedV2 !== null && parsedV2.months.length === 6 && parsedV2.accounts.length === 2
        && parsedV2.accounts.every((account) => (account.limits === null || account.limits.tryOn !== undefined) && account.history.length === 6)
        && parseSpending(await rpc(a, 'admin_ai_spending_v2', { p_months: 6 })) === null);
    } finally {
      await sql(`delete from private.app_admins where owner_id=${literal(a.uid)};`);
    }

    mark('capacity');
    // The shared deployment admits 2 dispatch slots per 60 s across try-on and enhancement.
    const held = [];
    for (const expected of ['OK', 'OK', 'RATE_LIMIT']) {
      const id = randomUUID();
      const result = await claim(a, randomUUID(), 1, id, { outfit: single, hold: held.length > 0 });
      equal(result.code, expected);
      if (result.code === 'OK') held.push(id);
    }
    for (const id of held.splice(0)) equal((await release(a, id)).code, 'PRE_DISPATCH');
    await freeSlots();
    // An enhancement call holding one slot of the same deployment leaves one for try-on.
    await sql(`insert into private.provider_slots(slot_id,deployment_key,held_until)
      values(gen_random_uuid(),${literal(KEY)},clock_timestamp()+interval '80 seconds');`);
    const shared = randomUUID();
    equal((await claim(a, randomUUID(), 1, shared, { outfit: single, hold: true })).code, 'OK');
    const countedCapacity = await rows(a);
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: single, hold: true }), { code: 'RATE_LIMIT', claimed: false });
    equal(await rows(a), countedCapacity);
    equal((await release(a, shared)).code, 'PRE_DISPATCH');
    await freeSlots();

    mark('step-race');
    // Two concurrent claims of the same step: exactly one attempt and one usage row.
    const raceChain = randomUUID();
    const first = await runStep(a, raceChain, 1, { outfit });
    await freeSlots();
    const usageBeforeRace = (await rows(a)).usage;
    const racing = [randomUUID(), randomUUID()];
    const raced = await Promise.all(racing.map((id) => claim(a, raceChain, 2, id, { person: first.out.sha, hold: true })));
    equal(raced.map((r) => r.code).sort(), ['BUSY', 'OK']);
    equal((await rows(a)).usage, usageBeforeRace + 1);
    equal((await release(a, racing[raced.findIndex((r) => r.code === 'OK')])).code, 'PRE_DISPATCH');
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: raceChain }), { code: 'CANCELLED' });

    mark('replay-late');
    // An accepted intermediate is replayed only while it is still the running chain's current output.
    const lateChain = randomUUID();
    const accepted = await runStep(a, lateChain, 1, { outfit });
    const again = await finish(a, accepted.id, 'OK', { out: accepted.out });
    requireEvidence(again.code === 'OK' && again.replayed === true && again.last === false);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: lateChain }), { code: 'CANCELLED' });
    equal(await finish(a, accepted.id, 'OK', { out: accepted.out }),
      { code: 'LATE', replayed: true, accounting: { basis: 'estimated', currency: 'USD', amountMicro: ESTIMATE } });
    // After withdrawal: the intermediate replay is LATE, a finished picture stays readable and its replay reports it.
    const kept = await runStep(a, randomUUID(), 1, { outfit: single, last: true });
    const withdrawnChain = randomUUID();
    const pending = await runStep(a, withdrawnChain, 1, { outfit });
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).code, 'CONSENT_REQUIRED');
    equal((await finish(a, pending.id, 'OK', { out: pending.out })).code, 'LATE');
    const keptReplay = await finish(a, kept.id, 'OK', { out: kept.out, send: true });
    requireEvidence(keptReplay.code === 'OK' && keptReplay.replayed === true && keptReplay.last === true
      && keptReplay.resultId === kept.done.resultId && keptReplay.deleted === false);
    const keptImage = await rpc(a, 'tryon_result_image_v1', { p_result_id: kept.done.resultId });
    requireEvidence(keptImage.code === 'OK' && Buffer.from(keptImage.jpegBase64, 'base64').equals(kept.out.bytes));
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    equal(await rpc(a, 'tryon_delete_result', { p_result_id: kept.done.resultId }), { code: 'OK' });
    // A deleted picture is reported as deleted by the replay, never recreated.
    const goneReplay = await finish(a, kept.id, 'OK', { out: kept.out, send: true });
    requireEvidence(goneReplay.code === 'OK' && goneReplay.resultId === null && goneReplay.deleted === true);

    mark('finish-expiry');
    // Finish itself applies both deadlines under its locks, with no status read or purge in between.
    // (1) The chain passed its 30 minutes during the call: settled as observed, nothing published.
    const agedChain = randomUUID(), agedId = randomUUID();
    equal((await claim(a, agedChain, 1, agedId, { outfit: single })).code, 'OK');
    equal((await dispatch(a, agedId)).code, 'AUTHORISED');
    await ageChain(a, agedChain);
    equal(await finish(a, agedId, 'OK', { out: output('aged'), send: true }),
      { code: 'LATE', accounting: { basis: 'estimated', currency: 'USD', amountMicro: ESTIMATE } });
    equal(Number(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)}
      and chain_id=${literal(agedChain)};`)), 0);
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: agedChain })).state, 'expired');
    // (2) The step passed its provisional expiry: EXPIRED is kept (the call-4 PASS rule), the observed usage is recorded.
    const heldChain = randomUUID(), heldId = randomUUID();
    equal((await claim(a, heldChain, 1, heldId, { outfit: single })).code, 'OK');
    equal((await dispatch(a, heldId)).code, 'AUTHORISED');
    await backdate(a, heldId, '4 minutes');
    const expiredFinish = await finish(a, heldId, 'OK', { out: output('held'), send: true, gone: true });
    equal(expiredFinish, { code: 'EXPIRED', accounting: { basis: 'estimated', currency: 'USD', amountMicro: ESTIMATE } });
    equal(await ledger(a, heldId), { state: 'estimated', accounted: ESTIMATE, closed: 'EXPIRED', origin: 'observed', code: 'OK',
      anomaly: false, authorised: true, fetch: true, live: true, gone: true });
    equal(Number(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)}
      and chain_id=${literal(heldChain)} and state='ready';`)), 0);
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: heldChain }), { code: 'CANCELLED' });

    mark('settlement');
    // A refusal without usage is unmetered at the reservation, flagged, and leaves the switch on.
    const filtered = randomUUID();
    equal((await claim(a, randomUUID(), 1, filtered, { outfit: single })).code, 'OK');
    equal((await dispatch(a, filtered)).code, 'AUTHORISED');
    equal((await finish(a, filtered, 'FILTERED', { usage: null })).code, 'FILTERED');
    equal(await ledger(a, filtered), { state: 'estimated', accounted: String(RESERVED), closed: 'FAILED', origin: 'unmetered',
      code: 'FILTERED', anomaly: true, authorised: true, fetch: true, live: true, gone: false });
    requireEvidence((await capacity()).dispatch_enabled === true && (await controls(a)).tryon_activated === true);
    // Unusable usage stops the shared switch and this account's try-on; each case restores both before the next.
    for (const [usage, code, accounted, closed] of [
      [{ ...VALID, total: VALID.total + 1 }, 'INVALID_USAGE', String(RESERVED), 'FAILED'],
      [{ ...VALID, modelObservation: 'response_unrecognised_model' }, 'USAGE_ANOMALY', String(RESERVED), 'UNAVAILABLE'],
      // Over the output envelope: ceil((9000*800 + 12000*3000)/100) = 432000, above the reservation.
      [{ ...VALID, output: 12000, total: 21000 }, 'USAGE_ANOMALY', '432000', 'UNAVAILABLE']]) {
      const id = randomUUID();
      equal((await claim(a, randomUUID(), 1, id, { outfit: single })).code, 'OK');
      equal((await dispatch(a, id)).code, 'AUTHORISED');
      equal((await finish(a, id, 'OK', { usage, out: output(code), send: true })).code, code);
      const settled = await ledger(a, id);
      requireEvidence(settled.state === 'estimated' && settled.accounted === accounted && settled.closed === closed
        && settled.origin === 'terminal_anomaly' && settled.anomaly === true);
      const stopped = await capacity();
      requireEvidence(stopped.dispatch_enabled === false && stopped.disabled_reason === 'USAGE_ANOMALY'
        && (await controls(a)).tryon_activated === false);
      equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: single }), { code: 'INACTIVE', claimed: false });
      await reopen();
      await setControls(a, 'tryon_activated=true');
    }
    // The try-on sub-limit and the shared allowance each refuse on their own, before any row.
    const spent = await one(`select to_jsonb(s) from private.tryon_usage(${literal(a.uid)},clock_timestamp()) s;`);
    const counted2 = await rows(a);
    await setControls(a, `tryon_monthly_allowance_micro=${Number(spent.tryon_micro) + RESERVED - 1}`);
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: single }), { code: 'ALLOWANCE', claimed: false });
    await setControls(a, `tryon_monthly_allowance_micro=50000000,monthly_allowance_micro=${Number(spent.total_micro) + RESERVED - 1}`);
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: single }), { code: 'ALLOWANCE', claimed: false });
    equal(await rows(a), { ...counted2, slots: 0 });
    await setControls(a, 'monthly_allowance_micro=100000000,tryon_monthly_allowance_micro=50000000');
    await stopRunning(a);
    await freeSlots();

    mark('pre-dispatch');
    // A refused or lost mark leaves no authorisation: PRE_DISPATCH releases, and Try again claims the same step.
    const c2 = randomUUID(), r1 = randomUUID();
    equal((await claim(a, c2, 1, r1, { outfit })).code, 'OK');
    equal(await dispatch(a, r1, false), { code: 'CLIENT_GONE' });
    const released = await finish(a, r1, 'PRE_DISPATCH', { usage: null, fetched: false });
    equal(released, { code: 'PRE_DISPATCH', accounting: { basis: 'held', currency: 'USD', amountMicro: '0' } });
    equal(await dispatch(a, r1), { code: 'TERMINAL' });
    // A committed mark whose reply was lost: no fetch, charged at the reservation, never released.
    const r2 = randomUUID();
    equal((await claim(a, c2, 1, r2)).code, 'OK');
    equal((await dispatch(a, r2)).code, 'AUTHORISED');
    equal((await finish(a, r2, 'PRE_DISPATCH', { usage: null, fetched: false })).code, 'NOT_DISPATCHED');
    equal(await ledger(a, r2), { state: 'estimated', accounted: String(RESERVED), closed: 'UNAVAILABLE', origin: 'unmetered',
      code: 'PRE_DISPATCH', anomaly: true, authorised: true, fetch: false, live: null, gone: false });
    // The dispatch authorisation is durable: it can be neither cleared nor changed.
    for (const change of ['tryon_dispatch_authorised_at=null', "tryon_dispatch_authorised_at=tryon_dispatch_authorised_at-interval '1 second'",
      'tryon_fetch_started=true']) {
      // Only the guard's 42501 is absorbed; an accepted change raises UNEXPECTED and fails the fixture.
      equal(await sql(`do $$ begin
        update private.ai_usage_evidence set ${change} where owner_id=${literal(a.uid)} and request_id=${literal(r2)};
        raise exception 'UNEXPECTED';
      exception when insufficient_privilege then null; end $$;
      select 'GUARDED';`), 'GUARDED');
    }

    mark('cancel');
    // Stop on a running chain: the late finish settles accounting only and publishes nothing; the slot is freed.
    const r3 = randomUUID();
    equal((await claim(a, c2, 1, r3)).code, 'OK');
    equal((await dispatch(a, r3)).code, 'AUTHORISED');
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: c2 }), { code: 'CANCELLED' });
    const late = await finish(a, r3, 'OK', { out: output('late'), gone: true });
    equal(late, { code: 'LATE', accounting: { basis: 'estimated', currency: 'USD', amountMicro: ESTIMATE } });
    equal(Number(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)} and chain_id=${literal(c2)};`)), 0);
    equal((await claim(a, c2, 1, randomUUID())).code, 'CANCELLED');
    await freeSlots();

    mark('garment-recheck');
    // D4 at every step claim: a garment archived between steps ends the chain as stale with no usage, slot or substitute.
    const c3 = randomUUID(), s1 = randomUUID();
    equal((await claim(a, c3, 1, s1, { outfit })).code, 'OK');
    equal((await dispatch(a, s1)).code, 'AUTHORISED');
    const o1 = output('recheck');
    equal((await finish(a, s1, 'OK', { out: o1 })).code, 'OK');
    await sql(`update public.items set lifecycle='archived' where owner_id=${literal(a.uid)} and id=${literal(aBottom.p_item.id)};`);
    const counted = await rows(a);
    equal(await claim(a, c3, 2, randomUUID(), { person: o1.sha, hold: true }), { code: 'CHAIN_MISMATCH', claimed: false });
    equal(await rows(a), { ...counted, results: counted.results - 1 });
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: c3 })).state, 'stale');
    await sql(`update public.items set lifecycle='active' where owner_id=${literal(a.uid)} and id=${literal(aBottom.p_item.id)};`);
    equal((await claim(a, c3, 2, randomUUID(), { person: o1.sha })).code, 'CHAIN_MISMATCH');
    await freeSlots();

    mark('withdrawal');
    // Withdrawal after the mark: the call may still finish, but nothing is published; a new chain after re-consent works.
    const c4 = randomUUID(), w1 = randomUUID();
    equal((await claim(a, c4, 1, w1, { outfit })).code, 'OK');
    equal((await dispatch(a, w1)).code, 'AUTHORISED');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null })).code, 'CONSENT_REQUIRED');
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: c4 })).state, 'withdrawn');
    equal((await finish(a, w1, 'OK', { out: output('withdrawn') })).code, 'CONSENT_REQUIRED');
    equal((await claim(a, c4, 2, randomUUID(), { person: randomUUID().replaceAll('-', '').padEnd(64, '0') })).code, 'CONSENT_REQUIRED');
    equal((await rpc(a, 'tryon_set_consent', { p_enabled: true, p_notice_revision: 1 })).code, 'OK');
    equal((await claim(a, c4, 1, randomUUID())).code, 'WITHDRAWN');
    await freeSlots();

    mark('expiry');
    // D2: accounting settles from held usage and its evidence, with no finish and no chain or attempt left.
    const c5 = randomUUID(), c6 = randomUUID(), authorised = randomUUID(), unmarked = randomUUID();
    equal((await claim(a, c5, 1, authorised, { outfit })).code, 'OK');
    equal((await dispatch(a, authorised)).code, 'AUTHORISED');
    await freeSlots();
    equal((await claim(a, c6, 1, unmarked, { outfit })).code, 'OK');
    equal(await rpc(a, 'tryon_cancel', { p_chain_id: c5 }), { code: 'CANCELLED' });
    await sql(`delete from private.tryon_chains where owner_id=${literal(a.uid)} and chain_id in (${literal(c5)},${literal(c6)});`);
    await backdate(a, authorised, '4 minutes');
    await backdate(a, unmarked, '1 minute');
    const expired = await expireDue();
    requireEvidence(expired.code === 'OK' && expired.expired >= 2);
    equal(await ledger(a, authorised), { state: 'estimated', accounted: String(RESERVED), closed: 'EXPIRED',
      origin: 'provisional_expiry', code: 'EXPIRED', anomaly: true, authorised: true, fetch: null, live: null, gone: null });
    equal(await ledger(a, unmarked), { state: 'released', accounted: '0', closed: 'EXPIRED', origin: 'provisional_expiry',
      code: 'EXPIRED', anomaly: false, authorised: false, fetch: null, live: null, gone: null });
    // A late finish records the observed usage and still returns EXPIRED; nothing is published.
    const lateExpired = await finish(a, authorised, 'OK', { out: output('expired'), gone: true });
    requireEvidence(lateExpired.code === 'EXPIRED' && lateExpired.accounting.amountMicro === ESTIMATE);
    await freeSlots();

    mark('purge-health');
    // D7: a finished picture two hours past its access expiry blocks new chains until the purge runs.
    const c7 = randomUUID(), p1 = randomUUID();
    const oneStep = await saveOutfit(a, [aTop]);
    equal((await claim(a, c7, 1, p1, { outfit: oneStep })).code, 'OK');
    equal((await dispatch(a, p1)).code, 'AUTHORISED');
    const po = output('health');
    const healthDone = await finish(a, p1, 'OK', { out: po, send: true });
    requireEvidence(healthDone.code === 'OK' && healthDone.last === true);
    await sql(`update private.tryon_results set completed_at=completed_at-interval '7 days 3 hours',
      expires_at=expires_at-interval '7 days 3 hours' where owner_id=${literal(a.uid)} and result_id=${literal(healthDone.resultId)};`);
    equal(await rpc(a, 'tryon_result_image_v1', { p_result_id: healthDone.resultId }), { code: 'NOT_FOUND' });
    requireEvidence((await health()).safeguard === true && (await health()).overdueResults === 1);
    await freeSlots();
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit }), { code: 'UNAVAILABLE', claimed: false });
    requireEvidence((await expireDue()).resultsPurged >= 1);
    equal(await health(), { code: 'OK', overdueResults: 0, overdueChains: 0, heldUsage: 0, safeguard: false });

    mark('slots');
    // Twenty live pictures or reserved slots fill the account. Fixture pictures share one timestamp, so they meet the
    // exact 30-minute and 7-day checks. Nineteen, then two chains start at once: one takes the twentieth slot.
    await stopRunning(a);
    const fill = 19 - await live(a);
    requireEvidence(fill > 0);
    await sql(`do $$ declare t timestamptz := clock_timestamp(); begin
      insert into private.tryon_chains(owner_id,chain_id,outfit_id,steps,state,next_step,result_id,created_at,expires_at,ended_at,end_reason)
        select ${literal(a.uid)},gen_random_uuid(),${literal(outfit)},'[{"slot":"top"}]'::jsonb,'complete',2,gen_random_uuid(),
          t,t+interval '30 minutes',t,'COMPLETE' from generate_series(1,${fill});
      insert into private.tryon_results(owner_id,result_id,chain_id,outfit_id,state,item_ids,jpeg,created_at,completed_at,expires_at)
        select owner_id,result_id,chain_id,outfit_id,'ready',array[${literal(aTop.p_item.id)}::uuid],'\\xffd8ffd9'::bytea,
          t,t,t+interval '7 days' from private.tryon_chains
          where owner_id=${literal(a.uid)} and end_reason='COMPLETE' and steps='[{"slot":"top"}]'::jsonb;
    end $$;`);
    equal(await live(a), 19);
    await freeSlots();
    const starters = [randomUUID(), randomUUID()];
    const started = await Promise.all(starters.map((id) => claim(a, randomUUID(), 1, id, { outfit: single, hold: true })));
    const winners = started.filter((r) => r.code === 'OK');
    requireEvidence(winners.length === 1 && started.every((r) => ['OK', 'BUSY', 'RESULTS_FULL'].includes(r.code)));
    equal(await live(a), 20);
    const full = await rows(a);
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit }), { code: 'RESULTS_FULL', claimed: false });
    equal(await rows(a), { ...full, slots: 0 });
    equal((await release(a, starters[started.findIndex((r) => r.code === 'OK')])).code, 'PRE_DISPATCH');
    await stopRunning(a);
    equal((await rpc(a, 'tryon_results_v1', {})).results.length, 19);
    await sql(`delete from private.tryon_results where owner_id=${literal(a.uid)} and item_ids=array[${literal(aTop.p_item.id)}::uuid]
      and octet_length(jpeg)=4;`);

    mark('probe');
    // The probe permission replaces activation and consent only while the ordinary path is off; an ordinary request is
    // never exempted by a probe row, and a probe claim is refused while the ordinary path is fully on.
    await sql(`update private.ai_controls set tryon_activated=false where owner_id=${literal(a.uid)};`);
    const probe = randomUUID();
    const authorisedProbe = await one(`select public.tryon_probe_authorise(${literal(probe)},${literal(a.uid)},${literal(MANIFEST)},5,
      1800000,'vto1-rehearsal',clock_timestamp()+interval '1 day');`);
    requireEvidence(authorisedProbe.code === 'OK' && authorisedProbe.replayed === false && authorisedProbe.deploymentKey === KEY);
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit }), { code: 'INACTIVE', claimed: false });
    equal(await claim(b, randomUUID(), 1, randomUUID(), { outfit: outfitB, probe }), { code: 'INACTIVE', claimed: false });
    const pc = randomUUID(), pr = randomUUID();
    equal((await claim(a, pc, 1, pr, { outfit, probe })).code, 'OK');
    // A stopped authorisation is refused at dispatch, never exempted.
    await sql(`update private.tryon_probe_authorisations set stopped_at=clock_timestamp(),stopped_reason='OPERATOR' where id=${literal(probe)};`);
    equal(await dispatch(a, pr), { code: 'INACTIVE' });
    equal((await finish(a, pr, 'PRE_DISPATCH', { usage: null, fetched: false })).code, 'PRE_DISPATCH');
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit, probe }), { code: 'INACTIVE', claimed: false });
    // The approved five-call order (docs/cloud-development.md): P1's three steps, then P3 and P2 alone. Each new chain
    // must fit calls + steps <= max_calls, so a second three-step chain after call 3 would be refused.
    const sequence = randomUUID();
    equal((await one(`select public.tryon_probe_authorise(${literal(sequence)},${literal(a.uid)},${literal(MANIFEST)},5,
      1800000,'vto1-sequence',clock_timestamp()+interval '1 day');`)).code, 'OK');
    const chainP1 = randomUUID();
    let personP1 = null;
    for (const n of [1, 2, 3]) {
      const done = await runStep(a, chainP1, n, { outfit, person: personP1, probe: sequence, last: n === 3 });
      personP1 = done.out.sha;
    }
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit, probe: sequence }), { code: 'PROBE_LIMIT', claimed: false });
    const p3 = await runStep(a, randomUUID(), 1, { outfit: single, probe: sequence, last: true });
    const p2 = await runStep(a, randomUUID(), 1, { outfit: singleShoes, probe: sequence, last: true });
    equal(await claim(a, randomUUID(), 1, randomUUID(), { outfit: single, probe: sequence }), { code: 'PROBE_LIMIT', claimed: false });
    equal(await one(`select jsonb_build_object('calls',count(*),'spent',sum(u.accounted_micro)::text) from private.ai_usage u
      join private.ai_usage_evidence e using (owner_id,request_id) where e.tryon_probe_id=${literal(sequence)};`),
    { calls: 5, spent: String(5 * Number(ESTIMATE)) });
    for (const done of [p3, p2]) equal(await rpc(a, 'tryon_delete_result', { p_result_id: done.done.resultId }), { code: 'OK' });
    // A provider refusal without usage is unmetered: it stops the probe (missing usage), not the shared switch.
    const refusal = randomUUID(), refused = randomUUID();
    equal((await one(`select public.tryon_probe_authorise(${literal(refusal)},${literal(a.uid)},${literal(MANIFEST)},1,
      ${RESERVED},'vto1-refusal',clock_timestamp()+interval '1 day');`)).code, 'OK');
    equal((await claim(a, randomUUID(), 1, refused, { outfit: single, probe: refusal })).code, 'OK');
    equal((await dispatch(a, refused)).code, 'AUTHORISED');
    equal((await finish(a, refused, 'FILTERED', { usage: null })).code, 'FILTERED');
    equal(await one(`select jsonb_build_object('stopped',stopped_at is not null,'reason',stopped_reason)
      from private.tryon_probe_authorisations where id=${literal(refusal)};`), { stopped: true, reason: 'MISSING_USAGE' });
    requireEvidence((await capacity()).dispatch_enabled === true);
    await stopRunning(a);
    await sql(`update private.ai_controls set tryon_activated=true where owner_id=${literal(a.uid)};`);
    await freeSlots();

    mark('outfit-delete');
    // An outfit deletion removes its chains and pictures; held usage still settles through the expiry.
    const c8 = randomUUID(), d1 = randomUUID();
    equal((await claim(a, c8, 1, d1, { outfit })).code, 'OK');
    equal((await dispatch(a, d1)).code, 'AUTHORISED');
    await sql(`delete from public.outfit_items where owner_id=${literal(a.uid)} and outfit_id=${literal(outfit)};
      delete from public.outfits where owner_id=${literal(a.uid)} and id=${literal(outfit)};`);
    equal(Number(await scalar(`select count(*) from private.tryon_chains where owner_id=${literal(a.uid)} and outfit_id=${literal(outfit)};`)), 0);
    equal((await ledger(a, d1)).state, 'held');
    await backdate(a, d1, '4 minutes');
    await expireDue();
    equal((await ledger(a, d1)).state, 'estimated');

    mark('stop-before-claim');
    // VTO-3a: Stop before the first step has claimed. The stop is recorded, so the claim that arrives later is refused
    // before any usage, evidence, chain, attempt, result or slot, and the chain never becomes visible.
    await freeSlots();
    const usageOf = (owner) => one(`select to_jsonb(s) from private.tryon_usage(${literal(owner.uid)},clock_timestamp()) s;`);
    const early = randomUUID(), earlyId = randomUUID();
    const spentBefore = await usageOf(a), listedBefore = await rpc(a, 'tryon_results_v1', {});
    equal(await stop(a, early), { code: 'CANCELLED' });
    await created(a, early);
    const markersA = await markers(a);
    equal(await stop(a, early), { code: 'CANCELLED' });
    equal(await markers(a), markersA);
    const slotsBefore = (await chainRows(a, early, [earlyId])).slots;
    equal(await claim(a, early, 1, earlyId, { outfit: single, hold: true }), { code: 'CANCELLED', claimed: false });
    equal(await chainRows(a, early, [earlyId]), { usage: 0, evidence: 0, chains: 0, attempts: 0, results: 0, slots: slotsBefore });
    equal(await rpc(a, 'tryon_chain_status', { p_chain_id: early }), { code: 'NOT_FOUND' });
    equal(await usageOf(a), spentBefore);
    equal(await rpc(a, 'tryon_results_v1', {}), listedBefore);

    mark('stop-isolation');
    // B's stop of a chain ID A has not claimed yet does not stop A: A can still claim it.
    const sharedStop = randomUUID(), sharedStopId = randomUUID();
    equal(await stop(b, sharedStop), { code: 'CANCELLED' });
    await created(b, sharedStop);
    equal((await claim(a, sharedStop, 1, sharedStopId, { outfit: single })).code, 'OK');
    // B's stop of A's running chain leaves it running.
    const runningA = randomUUID(), runningId = randomUUID();
    equal((await claim(a, runningA, 1, runningId, { outfit: single })).code, 'OK');
    equal(await stop(b, runningA), { code: 'CANCELLED' });
    await created(b, runningA);
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: runningA })).state, 'running');
    // A's own Stop of an existing chain ends it and records no stop.
    for (const [target, id] of [[sharedStop, sharedStopId], [runningA, runningId]]) {
      equal((await release(a, id)).code, 'PRE_DISPATCH');
      equal(await stop(a, target), { code: 'CANCELLED' });
      equal(await markers(a, target), 0);
    }
    await freeSlots();

    mark('stop-retention');
    // The purge removes a stop older than one day and keeps a newer one.
    const oldStop = randomUUID(), newStop = randomUUID();
    for (const target of [oldStop, newStop]) {
      equal(await stop(a, target), { code: 'CANCELLED' });
      await created(a, target);
    }
    await sql(`update private.tryon_chain_stops set created_at=created_at-interval '25 hours'
      where owner_id=${literal(a.uid)} and chain_id=${literal(oldStop)};`);
    requireEvidence((await expireDue()).stopsPurged >= 1);
    equal(await markers(a, oldStop), 0);
    expected.delete(markerKey(a, oldStop));
    equal(await markers(a, newStop), 1);

    mark('stop-race-a');
    // (a) Stop holds the owner's profile lock with its stop not yet committed: the claim's NOWAIT lock refuses BUSY and
    // writes nothing. After the commit, the claim is CANCELLED.
    const raceA = randomUUID(), raceA1 = randomUUID(), raceA2 = randomUUID();
    used.add(raceA);
    await freeSlots();
    const stopping = await holdTx(asOwner(a, `select 'R:'||public.tryon_cancel(${literal(raceA)})::text`), 1.501);
    const slotsA = (await chainRows(a, raceA, [raceA1])).slots;
    requireEvidence(stopping.open());
    equal(await claim(a, raceA, 1, raceA1, { outfit: single, hold: true }), { code: 'BUSY', claimed: false });
    // The BUSY reply must have come while the Stop was still uncommitted.
    requireEvidence(stopping.open());
    equal(await chainRows(a, raceA, [raceA1]), { usage: 0, evidence: 0, chains: 0, attempts: 0, results: 0, slots: slotsA });
    equal(heldReply(await stopping.done), { code: 'CANCELLED' });
    await created(a, raceA);
    equal(await claim(a, raceA, 1, raceA2, { outfit: single, hold: true }), { code: 'CANCELLED', claimed: false });
    equal(await chainRows(a, raceA, [raceA1, raceA2]), { usage: 0, evidence: 0, chains: 0, attempts: 0, results: 0, slots: slotsA });
    equal(await rpc(a, 'tryon_chain_status', { p_chain_id: raceA }), { code: 'NOT_FOUND' });

    mark('stop-race-b1');
    // (b1) The claim passes the stop check first and holds the lock; Stop waits, then cancels the visible chain, so the
    // dispatch is refused and the Edge's PRE_DISPATCH releases the reservation. Nothing is published.
    const raceB = randomUUID(), raceB1 = randomUUID();
    used.add(raceB);
    await freeSlots();
    const claiming = await holdTx(`select 'R:'||${claimCall(a, raceB, 1, raceB1, { outfit: single })}::text`, 1.502);
    const stopB = stop(a, raceB);
    await cancelsWaiting(1);
    requireEvidence(claiming.open());
    const claimedB = heldReply(await claiming.done);
    requireEvidence(claimedB.code === 'OK' && claimedB.claimed === true);
    equal(await stopB, { code: 'CANCELLED' });
    equal(await markers(a, raceB), 0);
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: raceB })).state, 'cancelled');
    equal(await dispatch(a, raceB1), { code: 'CANCELLED' });
    equal(await release(a, raceB1), { code: 'PRE_DISPATCH', accounting: { basis: 'held', currency: 'USD', amountMicro: '0' } });
    equal(Number(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)}
      and chain_id=${literal(raceB)};`)), 0);

    mark('stop-race-b2');
    // (b2) The dispatch wins and holds the lock; Stop waits, then cancels. The finish settles accounting only: LATE,
    // no picture, and the saved list is unchanged.
    const raceZ = randomUUID(), raceZ1 = randomUUID();
    used.add(raceZ);
    equal((await claim(a, raceZ, 1, raceZ1, { outfit: single })).code, 'OK');
    const listedZ = await rpc(a, 'tryon_results_v1', {});
    const dispatching = await holdTx(`select 'R:'||public.tryon_dispatch(${literal(a.uid)},${literal(raceZ1)},true)::text`, 1.503);
    const stopZ = stop(a, raceZ);
    await cancelsWaiting(1);
    requireEvidence(dispatching.open());
    equal(heldReply(await dispatching.done).code, 'AUTHORISED');
    equal(await stopZ, { code: 'CANCELLED' });
    equal(await markers(a, raceZ), 0);
    equal(await finish(a, raceZ1, 'OK', { out: output('stop-race'), send: true, gone: true }),
      { code: 'LATE', accounting: { basis: 'estimated', currency: 'USD', amountMicro: ESTIMATE } });
    equal((await ledger(a, raceZ1)).state, 'estimated');
    equal(Number(await scalar(`select count(*) from private.tryon_results where owner_id=${literal(a.uid)}
      and chain_id=${literal(raceZ)} and state='ready';`)), 0);
    equal(await rpc(a, 'tryon_results_v1', {}), listedZ);
    await freeSlots();

    mark('stop-race-c');
    // (c) The last finish wins and holds the lock; Stop waits, then reports the finished picture and records no stop.
    const raceC = randomUUID(), raceC1 = randomUUID();
    used.add(raceC);
    equal((await claim(a, raceC, 1, raceC1, { outfit: single })).code, 'OK');
    equal((await dispatch(a, raceC1)).code, 'AUTHORISED');
    const outC = output('stop-race-c');
    const finishing = await holdTx(`select 'R:'||${finishCall(a, raceC1, 'OK', { out: outC, send: true })}::text`, 1.504);
    const stopC = stop(a, raceC);
    await cancelsWaiting(1);
    requireEvidence(finishing.open());
    const doneC = heldReply(await finishing.done);
    requireEvidence(doneC.code === 'OK' && doneC.last === true && typeof doneC.resultId === 'string');
    equal(await stopC, { code: 'COMPLETED', resultId: doneC.resultId });
    equal(await markers(a, raceC), 0);
    requireEvidence((await rpc(a, 'tryon_results_v1', {})).results.some((r) => r.id === doneC.resultId));
    const imageC = await rpc(a, 'tryon_result_image_v1', { p_result_id: doneC.resultId });
    requireEvidence(imageC.code === 'OK' && Buffer.from(imageC.jpegBase64, 'base64').equals(outC.bytes));
    equal(await rpc(a, 'tryon_delete_result', { p_result_id: doneC.resultId }), { code: 'OK' });
    await freeSlots();

    mark('stop-cap');
    // (d) 60 new stops an hour per owner. With 59, two concurrent Stops of distinct missing chains wait on the owner's
    // lock; exactly one is recorded and the other is UNAVAILABLE. At the cap, a repeat Stop and a Stop of a running
    // chain still work, and a new one writes nothing.
    const capR = randomUUID(), capR1 = randomUUID();
    used.add(capR);
    equal((await claim(a, capR, 1, capR1, { outfit: single })).code, 'OK');
    const seeded = Array.from({ length: 59 - await recentMarkers(a) }, () => randomUUID());
    requireEvidence(seeded.length > 0);
    for (const id of seeded) used.add(id);
    await sql(`insert into private.tryon_chain_stops(owner_id,chain_id,created_at)
      select ${literal(a.uid)},id::uuid,clock_timestamp()-interval '1 minute' from unnest(array[${seeded.map(literal).join(',')}]) id;`);
    equal(Number(await scalar(`select count(*) from private.tryon_chain_stops where owner_id=${literal(a.uid)}
      and chain_id in (${seeded.map(literal).join(',')});`)), seeded.length);
    for (const id of seeded) expected.add(markerKey(a, id));
    equal(await recentMarkers(a), 59);
    const capP = randomUUID(), capQ = randomUUID();
    const locking = await holdTx(`select 1 from public.profiles where owner_id=${literal(a.uid)} for update`, 1.505, 'rollback');
    const contenders = [stop(a, capP), stop(a, capQ)];
    await cancelsWaiting(2);
    requireEvidence(locking.open());
    await locking.done;
    const replies = await Promise.all(contenders);
    equal(replies.map((r) => r.code).sort(), ['CANCELLED', 'UNAVAILABLE']);
    const winner = replies[0].code === 'CANCELLED' ? capP : capQ, loser = winner === capP ? capQ : capP;
    await created(a, winner);
    equal(await markers(a, loser), 0);
    equal(await recentMarkers(a), 60);
    const over = randomUUID();
    equal(await stop(a, over), { code: 'UNAVAILABLE' });
    equal(await markers(a, over), 0);
    equal(await stop(a, winner), { code: 'CANCELLED' });
    equal(await stop(a, capR), { code: 'CANCELLED' });
    equal((await rpc(a, 'tryon_chain_status', { p_chain_id: capR })).state, 'cancelled');
    equal(await markers(a, capR), 0);
    equal(await recentMarkers(a), 60);
    equal((await release(a, capR1)).code, 'PRE_DISPATCH');
    await freeSlots();

    mark('export');
    // Try-on rows are neither exported nor restorable: the owner export names no try-on table, and none of the owner's
    // stops appears anywhere in it.
    const exported = await rpc(a, 'export_manifest', { p_export_id: randomUUID() });
    requireEvidence(exported && typeof exported.tables === 'object'
      && Object.keys(exported.tables).every((table) => !table.startsWith('tryon')));
    const stoppedA = [...expected].filter((key) => key.startsWith(`${a.uid}:`)).map((key) => key.slice(a.uid.length + 1));
    const exportedText = JSON.stringify(exported);
    requireEvidence(stoppedA.length > 0 && stoppedA.every((id) => !exportedText.includes(id)));

    mark('discard');
    // §5.3: the restore step deletes every transient row and never touches usage or evidence.
    const usageBefore = await scalar(`select count(*) from private.ai_usage where purpose='try_on';`);
    const discarded = await one('select public.tryon_discard_transient();');
    requireEvidence(discarded.code === 'OK' && discarded.stopsDeleted === expected.size);
    equal(await one(`select jsonb_build_array((select count(*) from private.tryon_chains),(select count(*) from private.tryon_results),
      (select count(*) from private.tryon_attempts),(select count(*) from private.tryon_chain_stops));`), [0, 0, 0, 0]);
    expected.clear();
    equal(await scalar(`select count(*) from private.ai_usage where purpose='try_on';`), usageBefore);
    passed = true;
  } finally {
    // Remove exactly the stops this probe created and still expects, then check none is left for any ID it used.
    // A failure here is reported only when the probe itself passed, so it never hides the first failure.
    try {
      if (expected.size > 0) {
        const keys = [...expected].map((key) => key.split(':'));
        const removed = Number(await scalar(`with d as (delete from private.tryon_chain_stops where (owner_id,chain_id) in
          (${keys.map(([owner, id]) => `(${literal(owner)}::uuid,${literal(id)}::uuid)`).join(',')}) returning 1) select count(*) from d;`));
        requireEvidence(removed === expected.size);
      }
      if (used.size > 0) {
        equal(Number(await scalar(`select count(*) from private.tryon_chain_stops where owner_id in (${literal(a.uid)},${literal(b.uid)})
          and chain_id in (${[...used].map(literal).join(',')});`)), 0);
      }
    } catch (error) { if (passed) markerError = error; }
    for (const [owner, id] of outfits) {
      await sql(`delete from public.outfit_items where owner_id=${literal(owner.uid)} and outfit_id=${literal(id)};
        delete from public.outfits where owner_id=${literal(owner.uid)} and id=${literal(id)};`);
    }
    await sh.cleanup();
    await shB.cleanup();
    // Restore the inactive state: switch off with its INITIAL reason, 2 per 60 s, try-on off and unconfigured, no
    // consent, the shared limits as they were; held usage is settled so the global safeguard is clear.
    await sql(`update private.provider_slots set held_until=clock_timestamp()-interval '1 second' where deployment_key=${literal(KEY)};
      update private.provider_capacity set dispatch_enabled=false,disabled_reason='INITIAL',disabled_at=clock_timestamp(),
        max_dispatch=2,updated_at=clock_timestamp() where deployment_key=${literal(KEY)};
      update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${before.a.monthly_allowance_micro},
        max_requests_per_hour=${before.a.max_requests_per_hour},updated_at=clock_timestamp() where owner_id=${literal(a.uid)};
      update private.ai_controls set tryon_activated=false,tryon_consent_revision=null,tryon_consented_at=null,
        tryon_manifest_id=null,tryon_notice_revision=null,tryon_max_request_micro=null,tryon_monthly_allowance_micro=null,
        tryon_max_requests_per_hour=null,monthly_allowance_micro=${before.b.monthly_allowance_micro},
        max_requests_per_hour=${before.b.max_requests_per_hour},updated_at=clock_timestamp() where owner_id=${literal(b.uid)};`);
  }
  if (markerError) {
    mark('stop-cleanup');
    throw markerError;
  }
  const restored = await capacity();
  requireEvidence(restored.dispatch_enabled === false && restored.disabled_reason === 'INITIAL' && restored.max_dispatch === 2);
  await sql(`begin;
    alter table private.ai_usage_evidence disable trigger ai_usage_evidence_tryon_guard;
    update private.ai_usage set dispatched_at=dispatched_at-interval '1 hour' where purpose='try_on' and charge_state='held';
    update private.ai_usage_evidence e set tryon_dispatch_before=tryon_dispatch_before-interval '1 hour',
      tryon_dispatch_authorised_at=tryon_dispatch_authorised_at-interval '1 hour'
      from private.ai_usage u where u.owner_id=e.owner_id and u.request_id=e.request_id and u.purpose='try_on' and u.charge_state='held';
    alter table private.ai_usage_evidence enable trigger ai_usage_evidence_tryon_guard;
    commit;`);
  await expireDue();
  equal(await health(), { code: 'OK', overdueResults: 0, overdueChains: 0, heldUsage: 0, safeguard: false });
}
