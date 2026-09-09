import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ROOT, TEST_EMAILS, assertProjectConfig, requireDocker, requireLocalContainer,
  privilegedLocalSql, readCredentialCache, normalSessionEnvironment, runCommand,
} from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import { exportBodyEvidence } from './preservation-rehearsal.mjs';
import { requireEvidence } from '../tests/integration/preservation.sessions.mjs';
import { AI_IDS, AI_POLICY, AI_FACTS, AI_PHASES, AI_FACT_VECTORS } from '../tests/integration/ai-controls.sessions.mjs';

const eq = (a, b) => requireEvidence(isDeepStrictEqual(a, b));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

async function main() {
  let stage = 'guards';
  try {
    requireEvidence(process.argv.length === 2);
    await assertProjectConfig();
    await requireDocker();
    await requireLocalContainer();
    const env = normalSessionEnvironment(process.env, await readCredentialCache());
    const setup = JSON.parse(await privilegedLocalSql(`
      select jsonb_build_object('accounts',(select jsonb_agg(jsonb_build_object('email',a.email,'id',a.user_id) order by a.admission_no)
        from private.approved_accounts a join auth.users u on u.id=a.user_id join public.profiles p on p.owner_id=a.user_id
        where a.enabled and u.email=a.email),'empty',
        not exists(select 1 from private.ai_controls) and not exists(select 1 from private.ai_usage)
        and not exists(select 1 from private.ai_requests));`));
    requireEvidence(setup.empty === true && setup.accounts.length === 2);
    eq(setup.accounts.map((a) => a.email), TEST_EMAILS);
    requireEvidence(setup.accounts.every((a) => uuid.test(a.id)) && setup.accounts[0].id !== setup.accounts[1].id);
    const owners = { A: setup.accounts[0].id, B: setup.accounts[1].id };
    const child = async (phase) => {
      requireEvidence(AI_PHASES.includes(phase));
      stage = phase;
      const result = await runCommand(process.execPath, [
        path.join(ROOT, 'tests/integration/ai-controls.sessions.mjs'), phase,
      ], { env });
      requireEvidence(result.code === 0 && result.stdout.trim() === `PASS: AI controls ${phase}; normal owners=2`);
      console.log(result.stdout.trim());
    };
    const dispatch = async (label, id) => JSON.parse(await privilegedLocalSql(
      `select public.ai_mark_dispatched('${owners[label]}','${id}');`));
    const settle = async (label, id, facts, bill, code) => JSON.parse(await privilegedLocalSql(
      `select public.ai_settle_request('${owners[label]}','${id}',${facts === null ? 'null' : literal(JSON.stringify(facts)) + '::jsonb'},
        ${bill === null ? 'null' : bill},${literal(code)});`));
    const ledger = async (label, id) => JSON.parse(await privilegedLocalSql(
      `select jsonb_build_object('state',charge_state,'amount',accounted_micro::text,'dispatched',dispatched_at is not null,
        'reason',closed_reason,'full',exists(select 1 from private.ai_requests r where r.owner_id=u.owner_id and r.request_id=u.request_id))
        from private.ai_usage u where owner_id='${owners[label]}' and request_id='${id}';`));
    const claimed = async (label, id) => {
      eq(await dispatch(label, id), { code: 'OK', claimed: true });
      eq(await dispatch(label, id), { code: 'ALREADY_CLAIMED', claimed: false });
    };
    const seedTime = async (id, expired) => {
      requireEvidence([AI_IDS.expiry, AI_IDS.purge, AI_IDS.delayed, AI_IDS.A.expiring].includes(id));
      await privilegedLocalSql(`
        begin;
        select 1 from public.profiles where owner_id='${owners.A}' for update;
        select 1 from private.ai_controls where owner_id='${owners.A}' for update;
        do $fixture$
        declare t timestamptz := clock_timestamp()-interval '${expired ? '2 hours' : '10 minutes'}';
        begin
          update private.ai_usage set created_at=t,period=to_char(t at time zone 'UTC','YYYY-MM'),
            dispatched_at=case when dispatched_at is not null then t+interval '1 second' else null end
            where owner_id='${owners.A}' and request_id='${id}' and closed_at is null;
          if not found then raise exception 'Fixture unavailable'; end if;
          update private.ai_requests set created_at=t,expires_at=t+interval '1 hour'
            where owner_id='${owners.A}' and request_id='${id}';
          if not found then raise exception 'Fixture unavailable'; end if;
        end $fixture$;
        commit;`);
    };
    stage = 'metadata';
    const metadata = JSON.parse(await privilegedLocalSql(`
      select jsonb_build_object(
        'private',(select count(*)=3 and bool_and(c.relrowsecurity)
          from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
          where n.nspname='private' and c.relname in ('ai_controls','ai_usage','ai_requests')),
        'policies',(select count(*)=0 from pg_catalog.pg_policies
          where schemaname='private' and tablename in ('ai_controls','ai_usage','ai_requests')),
        'tableDenied',(select bool_and(not has_table_privilege('authenticated',t,'SELECT,INSERT,UPDATE,DELETE')
          and not has_table_privilege('anon',t,'SELECT,INSERT,UPDATE,DELETE'))
          from unnest(array['private.ai_controls','private.ai_usage','private.ai_requests']) t),
        'columns',(select jsonb_agg(a.attname order by a.attname) from pg_catalog.pg_attribute a
          where a.attrelid='public.profiles'::regclass and a.attnum>0 and not a.attisdropped
          and has_column_privilege('authenticated','public.profiles',a.attname,'UPDATE')),
        'server',(select bool_and(has_function_privilege('service_role',f,'EXECUTE')
          and not has_function_privilege('authenticated',f,'EXECUTE') and not has_function_privilege('anon',f,'EXECUTE'))
          from unnest(array['public.ai_mark_dispatched(uuid,uuid)',
          'public.ai_settle_request(uuid,uuid,jsonb,bigint,text)','public.ai_purge_expired(integer)']) f),
        'export',(select jsonb_build_object('bytes',octet_length(prosrc),'md5',md5(prosrc),
          'stable',provolatile='s','invoker',not prosecdef,'language',l.lanname,'config',proconfig,
          'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),
          'anon',has_function_privilege('anon',p.oid,'EXECUTE'))
          from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
          where p.oid='public.export_manifest(uuid)'::regprocedure));`));
    for (const key of ['private', 'policies', 'tableDenied', 'server']) requireEvidence(metadata[key] === true);
    eq(metadata.columns, ['owner_id', 'display_name', 'ui_language', 'timezone', 'currency', 'weather_enabled',
      'weather_city', 'latitude', 'longitude', 'created_at', 'updated_at', 'version'].sort());
    const body = exportBodyEvidence(await readFile(path.join(ROOT, 'supabase/migrations/20260909180000_ai_request_controls.sql'), 'utf8'));
    eq(metadata.export, { ...body, stable: true, invoker: true, language: 'sql', config: ['search_path=""'], authenticated: true, anon: false });
    const facts = JSON.parse(await privilegedLocalSql(`select jsonb_agg(private.ai_valid_facts(v->0)=(v->>1)::boolean)
      from jsonb_array_elements(${literal(JSON.stringify(AI_FACT_VECTORS))}::jsonb) v;`));
    requireEvidence(facts.length === AI_FACT_VECTORS.length && facts.every((matched) => matched === true));
    await child('P1');
    stage = 'S2';
    for (const label of ['A', 'B']) {
      const policy = AI_POLICY[label];
      await privilegedLocalSql(`begin;
        select 1 from public.profiles where owner_id='${owners[label]}' for update;
        insert into private.ai_controls(owner_id,activated,notice_revision,model_id,prompt_version,
          max_request_micro,monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds)
          values('${owners[label]}',true,${AI_POLICY.notice},'${AI_POLICY.model}',${AI_POLICY.prompt},
            ${AI_POLICY.maximum},${policy.allowance},${policy.rate},${AI_POLICY.ttl});
        commit;`);
    }
    console.log('PASS: AI controls S2; fictional operator setup only');
    await child('P3');
    stage = 'S4-ready';
    for (const [label, id] of [['A', AI_IDS.A.ready], ['A', AI_IDS.A.expiring], ['B', AI_IDS.B.ready]]) {
      await claimed(label, id);
      const result = await settle(label, id, AI_FACTS[label], 0, 'SUCCESS');
      requireEvidence(result.code === 'READY' && result.stored && result.accountedMicro === '0');
    }
    await child('S4-release-races');
    await child('S4-withdraw');
    stage = 'S4-withdrawn-dispatch';
    eq(await dispatch('A', AI_IDS.withdraw), { code: 'CONSENT_REQUIRED', claimed: false });
    await child('S4-restore');
    eq(await ledger('A', AI_IDS.withdraw), { state: 'released', amount: '0', dispatched: false, reason: 'DISCARDED', full: false });
    await child('S4-failure');
    stage = 'S4-undispatched-failure';
    const failed = await settle('A', AI_IDS.failure, null, null, 'FAILED');
    requireEvidence(failed.code === 'FAILED' && failed.chargeState === 'released' && failed.accountedMicro === '0');
    const zero = await settle('A', AI_IDS.failure, null, 0, 'BILLING_ONLY');
    requireEvidence(zero.code === 'TERMINAL' && zero.chargeState === 'settled' && zero.undispatchedCharge);
    eq(await settle('A', AI_IDS.failure, null, 0, 'BILLING_ONLY'), zero);
    eq(await settle('A', AI_IDS.failure, null, 1, 'BILLING_ONLY'), { code: 'BILLING_CONFLICT', stored: false });
    await child('S4-expiry');
    stage = 'S4-expired-dispatch';
    await seedTime(AI_IDS.expiry, true);
    eq(await dispatch('A', AI_IDS.expiry), { code: 'EXPIRED', claimed: false });
    eq(await ledger('A', AI_IDS.expiry), { state: 'released', amount: '0', dispatched: false, reason: 'EXPIRED', full: false });
    await child('S4-purge');
    stage = 'S4-purge-held';
    await claimed('A', AI_IDS.purge);
    await child('S4-held');
    stage = 'S4-held-failure';
    await claimed('A', AI_IDS.held);
    const held = await settle('A', AI_IDS.held, null, null, 'FAILED');
    requireEvidence(held.code === 'FAILED' && held.chargeState === 'held' && held.accountedMicro === '5000');
    const reconciled = await settle('A', AI_IDS.held, null, 0, 'BILLING_ONLY');
    requireEvidence(reconciled.code === 'TERMINAL' && reconciled.chargeState === 'settled');
    await child('S4-discard-reserve');
    stage = 'S4-discard-dispatch';
    await claimed('A', AI_IDS.discard);
    await child('S4-discard');
    stage = 'S4-discard-billing';
    eq(await ledger('A', AI_IDS.discard), { state: 'held', amount: '5000', dispatched: true, reason: 'DISCARDED', full: false });
    const discarded = await settle('A', AI_IDS.discard, AI_FACTS.A, 0, 'SUCCESS');
    requireEvidence(discarded.code === 'TERMINAL' && !discarded.stored);
    await child('S4-delayed');
    stage = 'S4-delayed-completion';
    await claimed('A', AI_IDS.delayed);
    await seedTime(AI_IDS.delayed, false);
    const lifetime = async () => JSON.parse(await privilegedLocalSql(`select jsonb_build_object('created',created_at,'expires',expires_at)
      from private.ai_requests where owner_id='${owners.A}' and request_id='${AI_IDS.delayed}';`));
    const before = await lifetime();
    const billing = await settle('A', AI_IDS.delayed, null, 0, 'BILLING_ONLY');
    requireEvidence(billing.code === 'BILLING_ONLY' && !billing.stored && billing.chargeState === 'settled');
    const ready = await settle('A', AI_IDS.delayed, AI_FACTS.A, null, 'SUCCESS');
    requireEvidence(ready.code === 'READY' && ready.stored && ready.accountedMicro === '0');
    eq(await settle('A', AI_IDS.delayed, AI_FACTS.A, 0, 'SUCCESS'), ready);
    const conflict = await settle('A', AI_IDS.delayed, AI_FACTS.B, 0, 'SUCCESS');
    requireEvidence(conflict.code === 'FACTS_CONFLICT' && !conflict.stored);
    eq(await lifetime(), before);
    await child('S4-delayed-close');
    await child('S4-overrun');
    stage = 'S4-overrun-invalid-content';
    await claimed('A', AI_IDS.overrun);
    const overrun = await settle('A', AI_IDS.overrun, { outcome: 'ready', fields: { warmth: 4 } }, 16000, 'SUCCESS');
    requireEvidence(overrun.code === 'INVALID_FACTS' && !overrun.stored && overrun.accountedMicro === '16000');
    eq(await ledger('A', AI_IDS.overrun), { state: 'settled', amount: '16000', dispatched: true, reason: 'INVALID_FACTS', full: false });
    const anomaly = await settle('A', AI_IDS.withdraw, null, 1, 'BILLING_ONLY');
    requireEvidence(anomaly.code === 'TERMINAL' && !anomaly.stored && anomaly.undispatchedCharge && anomaly.accountedMicro === '1');
    eq(await ledger('A', AI_IDS.withdraw), { state: 'settled', amount: '1', dispatched: false, reason: 'DISCARDED', full: false });
    stage = 'S4-bounded-purge';
    await seedTime(AI_IDS.purge, true);
    await seedTime(AI_IDS.A.expiring, true);
    eq(JSON.parse(await privilegedLocalSql('select public.ai_purge_expired(1);')), { code: 'OK', removed: 1 });
    const remaining = JSON.parse(await privilegedLocalSql(`select count(*) from private.ai_requests where owner_id='${owners.A}'
      and request_id in ('${AI_IDS.purge}','${AI_IDS.A.expiring}') and expires_at<=clock_timestamp();`));
    requireEvidence(remaining === 1);
    eq(await ledger('A', AI_IDS.purge), { state: 'held', amount: '5000', dispatched: true, reason: 'EXPIRED', full: false });
    const purged = await settle('A', AI_IDS.purge, AI_FACTS.A, 0, 'SUCCESS');
    requireEvidence(purged.code === 'TERMINAL' && !purged.stored && purged.accountedMicro === '0');
    console.log('PASS: AI controls S4; trusted server RPCs; named fixture-seeded time, not elapsed retention');
    await child('P5');
    stage = 'S6';
    const final = JSON.parse(await privilegedLocalSql(`select jsonb_build_object(
      'requests',(select count(*) from private.ai_requests),
      'ready',(select count(*) from private.ai_requests where status='ready'),
      'unexplained',(select count(*) from private.ai_usage where closed_reason is null
        and request_id not in ('${AI_IDS.A.ready}','${AI_IDS.B.ready}')),
      'held',(select count(*) from private.ai_usage where charge_state in ('reserved','held')),
      'ledger',(select count(*) from private.ai_usage),
      'accounted',(select sum(accounted_micro)::text from private.ai_usage),
      'expiry',(select jsonb_build_object('reason',closed_reason,'amount',accounted_micro::text,'full',
        exists(select 1 from private.ai_requests r where r.owner_id=u.owner_id and r.request_id=u.request_id))
        from private.ai_usage u where owner_id='${owners.A}' and request_id='${AI_IDS.A.expiring}'));`));
    eq(final, { requests: 2, ready: 2, unexplained: 0, held: 0, ledger: 14, accounted: '16001',
      expiry: { reason: 'EXPIRED', amount: '0', full: false } });
    console.log('PASS: AI controls S6; structural retention and accounting, not owner access');
  } catch {
    console.error(`FAIL: AI controls fixture ${stage}; reset required; no SQL, credentials or fixture values disclosed`);
    process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) await main();
