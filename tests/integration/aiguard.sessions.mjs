// AI-GUARD1: the spending guard against the real schema. Invoked only by the CI-only preservation owner, after the migrations
// are applied. Rows are inserted with privileged SQL in the shapes the five admissions write (analysis, Stylist, clean-up, try-on
// step, outfit run); every owner call goes through the ordinary A/B sessions. The window of both owners is restarted at the start
// (`ai_guard_resumed_at`), so rows left by earlier stages never count; everything inserted here is removed in finally. No provider calls.
//   aiGuardProbes: a legitimate peak (50 clean-ups, 50 analyses and a 6-step try-on chain, USD 22.79) never latches; a synthetic
//     burst latches one owner only; a paused owner is refused with AG001 and no row for every purpose; settlement, expiry and
//     withdrawal still work while paused; Resume re-opens admission and the spending that caused the pause is not counted again;
//     a second burst latches again; an owner-set threshold applies; status and Resume are owner-only reads and writes.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireEvidence } from './preservation.sessions.mjs';

// The rehearsal prints only the stage label, so a failed check names itself there (caller line, or the actual value).
let note = () => {};
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
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const MONTHLY = 50_000_000;
const PURPOSES = ['analysis', 'stylist', 'enhancement', 'try_on', 'outfitgen'];

export async function aiGuardProbes(snapshot, sql, mark = () => {}) {
  note = mark;
  const { client, owners: [a, b] } = snapshot;
  const scalar = async (text) => (await sql(text)).trim();
  const rpc = async (owner, name, body = {}) => {
    try { return await client.rpc(owner, name, body); } catch (error) { note(`rpc-${name}`); throw error; }
  };
  const both = `${literal(a.uid)},${literal(b.uid)}`;
  const period = "to_char(now() at time zone 'UTC','YYYY-MM')";
  const columns = 'owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state,dispatched_at,purpose,provider_slot_id,tryon_chain_id,tryon_step';
  // The values of one admission row; try-on rows also need a chain and a step, image rows a provider slot.
  const values = (owner, purpose, micro, state, chainId = null, step = null) => `${literal(owner)},gen_random_uuid(),${period},clock_timestamp(),${micro},${micro},
    ${literal(state)},${state === 'reserved' ? 'null' : 'clock_timestamp()'},${literal(purpose)},
    ${purpose === 'enhancement' || purpose === 'try_on' ? 'gen_random_uuid()' : 'null::uuid'},
    ${chainId ? `${literal(chainId)}::uuid` : 'null::uuid'},${step === null ? 'null::smallint' : `${step}::smallint`}`;
  const insert = (owner, purpose, count, micro, state = 'held') => sql(`insert into private.ai_usage(${columns})
    select ${values(owner, purpose, micro, state)} from generate_series(1,${count});`);
  const chain = (owner) => sql(`insert into private.ai_usage(${columns})
    select ${values(owner, 'try_on', 360000, 'held', randomUUID(), 'n')} from generate_series(1,6) n;`);
  // One admission-shaped row, as that purpose's claim writes it (analysis is reserved, the others are held).
  const admissionRow = (owner, purpose) => `select ${values(owner.uid, purpose, 1, purpose === 'analysis' ? 'reserved' : 'held',
    purpose === 'try_on' ? randomUUID() : null, purpose === 'try_on' ? 1 : null)}`;
  const status = (owner) => rpc(owner, 'ai_guard_status_v1');
  const pausedFlag = (owner) => scalar(`select (ai_guard_paused_at is not null)::text from private.ai_controls where owner_id=${literal(owner.uid)};`);
  const rows = async (owner) => Number(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(owner.uid)};`));
  const sweep = async () => JSON.parse(await sql(`select public.ai_guard_sweep(500);`));
  // True only when the guard refused the admission with its own SQLSTATE; any other outcome raises or reports false.
  const refusedBy = async (owner, purpose) => {
    const text = await scalar(`do $$ begin
      insert into private.ai_usage(${columns}) ${admissionRow(owner, purpose)};
      raise exception 'NOT REFUSED';
    exception when sqlstate 'AG001' then null; end $$; select 'REFUSED';`);
    return text.endsWith('REFUSED');
  };
  const admitted = async (owner, purpose) => {
    const was = await rows(owner);
    await sql(`insert into private.ai_usage(${columns}) ${admissionRow(owner, purpose)};`);
    return (await rows(owner)) === was + 1;
  };
  const started = await scalar(`select clock_timestamp();`);
  const before = JSON.parse(await sql(`select jsonb_agg(jsonb_build_object('o',owner_id,'m',monthly_allowance_micro) order by owner_id)
    from private.ai_controls where owner_id in (${both});`));
  try {
    note('setup');
    await sql(`update private.ai_controls set monthly_allowance_micro=${MONTHLY},ai_guard_hour_micro=null,ai_guard_paused_at=null,
      ai_guard_limit_micro=null,ai_guard_window_micro=null,ai_guard_resumed_at=clock_timestamp() where owner_id in (${both});`);
    equal(await status(a), { code: 'OK', paused: false });
    equal(await status(b), { code: 'OK', paused: false });

    note('peak');
    // USD 15.00 of clean-ups held at their reservation, USD 5.63 of settled analyses and one 6-step chain held: 22.79 < 25.00.
    await insert(a.uid, 'enhancement', 50, 300_000);
    await insert(a.uid, 'analysis', 50, 112_600, 'settled');
    await chain(a.uid);
    equal(await scalar(`select sum(accounted_micro)::text from private.ai_usage where owner_id=${literal(a.uid)} and created_at>=${literal(started)}::timestamptz;`), '22790000');
    equal(await sweep(), { code: 'OK', paused: 0 });
    equal(await pausedFlag(a), 'false');
    equal(await status(a), { code: 'OK', paused: false });
    equal(JSON.parse(await sql(`select public.ai_guard_sweep(0);`)), { code: 'INVALID_INPUT' });

    note('burst');
    // 70 outfit runs held at their reservation (USD 26.14) inside one hour latch that owner only.
    await insert(b.uid, 'outfitgen', 70, 373_402);
    equal(await sweep(), { code: 'OK', paused: 1 });
    equal([await pausedFlag(a), await pausedFlag(b)], ['false', 'true']);
    const paused = await status(b);
    equal([paused.code, paused.paused, paused.spentMicro, paused.limitMicro], ['OK', true, '26138140', String(MONTHLY / 2)]);
    ok(Number.isSafeInteger(paused.pausedAtMs) && Math.abs(paused.pausedAtMs - Date.now()) < 10 * 60_000);
    equal(await status(a), { code: 'OK', paused: false });
    // A second sweep changes nothing, and A resuming (a no-op for A) leaves B paused.
    equal(await sweep(), { code: 'OK', paused: 0 });
    equal(await rpc(a, 'ai_guard_resume_v1'), { code: 'OK', replayed: true });
    equal(await pausedFlag(b), 'true');

    note('refused');
    const rowsB = await rows(b);
    for (const purpose of PURPOSES) equal([purpose, await refusedBy(b, purpose)], [purpose, true]);
    equal(await rows(b), rowsB);
    // The unpaused owner is admitted for every purpose with the same shapes.
    for (const purpose of PURPOSES) equal([purpose, await admitted(a, purpose)], [purpose, true]);

    note('paused-operations');
    // Settlement, expiry and withdrawal are not admissions: they still work while paused.
    await sql(`update private.ai_usage set charge_state='settled',accounted_micro=1000 where owner_id=${literal(b.uid)} and purpose='outfitgen'
      and created_at>=${literal(started)}::timestamptz;`);
    equal(Number(await scalar(`select count(*) from private.ai_usage where owner_id=${literal(b.uid)} and purpose='outfitgen' and charge_state='held';`)), 0);
    equal(JSON.parse(await sql(`select public.outfitgen_expire_due(500);`)).code, 'OK');
    const withdrawn = await rpc(b, 'tryon_set_consent', { p_enabled: false, p_notice_revision: null });
    ok(typeof withdrawn.code === 'string' && withdrawn.code !== 'AG001');
    equal(await pausedFlag(b), 'true');

    note('resume');
    equal(await rpc(b, 'ai_guard_resume_v1'), { code: 'OK', replayed: false });
    equal(await status(b), { code: 'OK', paused: false });
    equal(await rpc(b, 'ai_guard_resume_v1'), { code: 'OK', replayed: true });
    for (const purpose of PURPOSES) equal([purpose, await admitted(b, purpose)], [purpose, true]);
    // The spending that caused the pause is not counted again.
    equal(await sweep(), { code: 'OK', paused: 0 });
    equal(await pausedFlag(b), 'false');

    note('second-burst');
    await insert(b.uid, 'stylist', 200, 129_360);
    equal(await sweep(), { code: 'OK', paused: 1 });
    equal(await pausedFlag(b), 'true');
    equal(await rpc(b, 'ai_guard_resume_v1'), { code: 'OK', replayed: false });

    note('owner-threshold');
    await sql(`update private.ai_controls set ai_guard_hour_micro=100000 where owner_id=${literal(b.uid)};`);
    await insert(b.uid, 'outfitgen', 1, 373_402);
    equal(await sweep(), { code: 'OK', paused: 1 });
    const custom = await status(b);
    equal([custom.paused, custom.limitMicro], [true, '100000']);
    equal(await rpc(b, 'ai_guard_resume_v1'), { code: 'OK', replayed: false });
  } catch (error) {
    note(`failed-${clean(error?.message ?? error)}`);
    throw error;
  } finally {
    note('restore');
    await sql(`delete from private.ai_usage where owner_id in (${both}) and created_at>=${literal(started)}::timestamptz;
      update private.ai_controls set ai_guard_hour_micro=null,ai_guard_paused_at=null,ai_guard_limit_micro=null,ai_guard_window_micro=null,
        ai_guard_resumed_at=null where owner_id in (${both});`);
    for (const entry of before) {
      await sql(`update private.ai_controls set monthly_allowance_micro=${entry.m} where owner_id=${literal(entry.o)};`);
    }
  }
}
