import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { ROOT, LOCAL_API, assertNoServiceSecrets, readCredentialCache, normalSessionEnvironment,
  localStatus, privilegedLocalSql, runCommand, startAnalysisServer, parseServedDiagnostics, withAnalyzedSaveFixtureLock } from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import { createHandler } from '../supabase/functions/analyze-clothing/handler.ts';
import { TOKEN_URL, GOOGLE_ORIGIN } from '../supabase/functions/analyze-clothing/google-cloud.ts';
import { MODEL_ID, readJson, GENERATION_CONFIG, SAFETY_SETTINGS, PROMPT } from '../supabase/functions/analyze-clothing/protocol.ts';
import { aiClients, requireReady, AI_FACT_VECTORS } from '../tests/integration/ai-controls.sessions.mjs';
import { baseline, analysisId, analysisFacts, analysisUsage, analysisHash, equal } from '../tests/integration/ai-analysis.sessions.mjs';
import { TABLES, requireEvidence } from '../tests/integration/preservation.sessions.mjs';
import { analyzedHarness, analyzedIntent, saveId } from '../tests/integration/analyzed-save.sessions.mjs';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const db = async (sql) => JSON.parse(await privilegedLocalSql(sql));
const manifest = 'google-eu-3.8-v1';
const privateTables = ['ai_controls', 'ai_usage', 'ai_requests', 'ai_usage_evidence', 'ai_analysis_attestations'];
const rowsSql = (table, where = 'true') =>
  `coalesce((select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from ${table} t where ${where}),'[]'::jsonb)`;
async function snapshot() {
  return db(`select jsonb_build_object(${privateTables.map((t) => `${literal(t)},${rowsSql(`private.${t}`)}`).join(',')});`);
}
async function inventory(client, owners) {
  const data = [];
  for (const owner of owners) {
    const tables = {};
    for (const table of TABLES) tables[table] = await client.rows(owner, table);
    const profile = tables.profiles[0];
    for (const key of ['version', 'updated_at', 'ai_enabled', 'ai_notice_revision', 'ai_consented_at']) delete profile[key];
    const hashes = [];
    for (const image of tables.item_images) for (const variant of ['main', 'thumb']) {
      const response = await client.request(owner.token, `/storage/v1/object/authenticated/wardrobe/${image[`${variant}_path`]}`);
      requireEvidence(response.ok && Buffer.isBuffer(response.data));
      hashes.push(createHash('sha256').update(response.data).digest('hex'));
    }
    const metadata = await client.rpc(owner, 'export_manifest', { p_export_id: analysisId(owner.label, 32) });
    requireEvidence(metadata.schema_version === 2 && metadata.owner_id === owner.uid);
    equal(Object.keys(metadata.tables).sort(), [...TABLES].sort());
    requireEvidence(metadata.tables.profiles.every((p) =>
      !['ai_enabled', 'ai_notice_revision', 'ai_consented_at'].some((key) => Object.hasOwn(p, key))));
    delete metadata.created_at;
    data.push({ tables, hashes, metadata });
    // AI consent/version timestamps are expected to advance through ordinary CAS.
    for (const key of ['version', 'updated_at', 'ai_enabled', 'ai_notice_revision', 'ai_consented_at'])
      delete metadata.tables.profiles[0][key];
  }
  return data;
}
export const ANALYSIS_CATALOG_SQL = `
select jsonb_build_object(
 'privateRls',(select count(*)=7 and bool_and(relrowsecurity)
   from pg_class where oid in ('private.ai_execution_manifests'::regclass,'private.ai_usage_evidence'::regclass,'private.ai_analysis_attestations'::regclass,
     'private.ai_save_used_receipts'::regclass,'private.ai_item_save_attempts'::regclass,
     'private.ai_item_save_context'::regclass,'private.item_attribution_history'::regclass)),
 'noPolicies',(select count(*)=0 from pg_policies where schemaname='private'
   and tablename in ('ai_execution_manifests','ai_usage_evidence','ai_analysis_attestations',
     'ai_save_used_receipts','ai_item_save_attempts','ai_item_save_context','item_attribution_history')),
 'tableDenied',(select bool_and(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE'))
   from unnest(array['anon','authenticated','service_role']) r,
   unnest(array['private.ai_execution_manifests','private.ai_usage_evidence','private.ai_analysis_attestations',
     'private.ai_save_used_receipts','private.ai_item_save_attempts','private.ai_item_save_context','private.item_attribution_history']) t),
 'privateDenied',(select count(*)=11 and bool_and(not has_function_privilege('anon',p.oid,'EXECUTE')
   and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
   and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
   and p.proname in ('ai_manifest_immutable','ai_begin_owner','ai_settle_core','ai_normal_usage','ai_analysis_permitted','ai_accounting',
     'item_save_value_hash','item_field_provenance','reserve_item_save','finalize_manual_item_save','analyzed_item_save_current')),
 'serviceOnly',(select count(*)=4 and bool_and(p.prosecdef
   and p.proconfig=(case when p.proname='complete_analyzed_item_save' then array['search_path=""','lock_timeout=2s'] else array['search_path=""'] end)
   and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
   and not has_function_privilege('anon',p.oid,'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and p.proname in ('ai_claim_analysis','ai_finish_analysis','ai_settle_request','complete_analyzed_item_save')),
 'ownerOnly',(select count(*)=7 and bool_and(p.prosecdef
   and p.proconfig=(case when p.proname in ('reserve_analyzed_item_save','analyzed_item_save_preflight','cancel_analyzed_item_save')
     then array['search_path=""','lock_timeout=2s'] else array['search_path=""'] end)
   and has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
   and not has_function_privilege('anon',p.oid,'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and p.proname in ('ai_begin_request','ai_request_control','ai_analysis_status',
     'reserve_analyzed_item_save','analyzed_item_save_preflight','cancel_analyzed_item_save','item_attribution_history')),
 'oldConstraints',(select count(*)=5 from pg_constraint where conrelid='private.ai_usage'::regclass
   and conname in ('ai_usage_check','ai_usage_check1','ai_usage_check2','ai_usage_check3','ai_usage_check4')),
 'evidenceCascade',exists(select 1 from pg_constraint where conrelid='private.ai_usage_evidence'::regclass
   and confrelid='private.ai_usage'::regclass and confdeltype='c'
   and pg_get_constraintdef(oid)='FOREIGN KEY (owner_id, request_id) REFERENCES private.ai_usage(owner_id, request_id) ON DELETE CASCADE'),
 'attestationCascade',exists(select 1 from pg_constraint where conrelid='private.ai_analysis_attestations'::regclass
   and confrelid='private.ai_requests'::regclass and confdeltype='c'
   and pg_get_constraintdef(oid)='FOREIGN KEY (owner_id, request_id) REFERENCES private.ai_requests(owner_id, request_id) ON DELETE CASCADE'),
 'receiptOwnerLifetime',(select count(*)=1 and bool_and(confrelid='public.profiles'::regclass and confdeltype='c')
   from pg_constraint where conrelid='private.ai_save_used_receipts'::regclass and contype='f'),
 'saveExtensionCascade',exists(select 1 from pg_constraint where conrelid='private.ai_item_save_attempts'::regclass
   and confrelid='private.item_save_attempts'::regclass and confdeltype='c'),
 'historyNullableImage',exists(select 1 from pg_constraint where conrelid='private.item_attribution_history'::regclass
   and pg_get_constraintdef(oid)='FOREIGN KEY (owner_id, item_id, source_image_id) REFERENCES item_images(owner_id, item_id, id) ON DELETE SET NULL (source_image_id)'),
 'contextEmpty',not exists(select 1 from private.ai_item_save_context),
 'storageIdentity',exists(select 1 from pg_attribute where attrelid='storage.objects'::regclass and attname='id' and atttypid='uuid'::regtype)
   and exists(select 1 from pg_attribute where attrelid='storage.objects'::regclass and attname='version' and not attisdropped)
);`;

async function main() {
  let stage = 'entry', owned, server;
  const deadline = Date.now() + 600_000;
  try {
    requireEvidence(process.argv.length === 2 && process.env.ALLOW_SECURITY_TESTS === '1');
    assertNoServiceSecrets(process.env);
    const env = normalSessionEnvironment(process.env, await readCredentialCache());
    const local = await localStatus();
    const { client, owners } = await aiClients(env);
    const ready = await baseline(client, owners);
    const before = await snapshot(), preserved = await inventory(client, owners);
    const versions = await Promise.all(owners.map(async (o) => (await client.rows(o, 'profiles'))[0].version));
    requireEvidence(before.ai_controls.length === 2 && before.ai_usage.length === 14 && before.ai_requests.length === 2
      && before.ai_requests.every((r) => r.status === 'ready' && Date.parse(r.expires_at) - Date.now() > 1_200_000)
      && before.ai_usage.every((u) => !['held', 'reserved'].includes(u.charge_state))
      && before.ai_usage_evidence.length === 0 && before.ai_analysis_attestations.length === 0);
    requireEvidence(owners.every((o) => before.ai_controls.some((c) => c.owner_id === o.uid && c.execution_manifest_id === null)));
    // B's three existing admissions must remain in the rate window throughout the bounded rehearsal.
    requireEvidence(before.ai_usage.filter((u) => u.owner_id === owners[1].uid && Date.parse(u.created_at) > Date.now() - 2_400_000).length === 3);
    const columns = Object.keys(before.ai_controls[0]).filter((c) => c !== 'owner_id');
    requireEvidence(columns.every((c) => /^[a-z_]+$/.test(c)));
    const ownerWhere = `owner_id in (${owners.map((o) => literal(o.uid)).join(',')})`;
    const ids = owners.flatMap((o) => Array.from({ length: 32 }, (_, i) => analysisId(o.label, i + 1)));
    const namespace = `${ownerWhere} and request_id in (${ids.map(literal).join(',')})`;
    const child = async (name, phase, origin) => {
      requireEvidence(Date.now() < deadline);
      stage = phase ?? name;
      const result = await runCommand(process.execPath, [
        `${ROOT}tests/${name}/ai-analysis.sessions.mjs`, ...(phase ? [phase, origin] : []),
      ], { env, timeout: 120_000 });
      if (phase === 'served') {
        try {
          for (const line of parseServedDiagnostics(result.stdout, result.stderr)) console.log(line);
        } catch { /* Diagnostics never replace the child's result. */ }
      }
      requireEvidence(result.code === 0);
      console.log(`PASS: B1 ${name}/${phase ?? 'baseline'} normal-session child`);
    };
    await child('integration'); await child('security');
    stage = 'served-entrypoint';
    owned = await startAnalysisServer();
    await child('integration', 'served', LOCAL_API);
    owned.assertRunning();
    await owned.stop(); owned = undefined;
    stage = 'catalog';
    requireEvidence(Object.values(await db(ANALYSIS_CATALOG_SQL)).every((v) => v === true));
    for (const [facts, valid] of AI_FACT_VECTORS)
      equal(await db(`select to_jsonb(private.ai_valid_facts(${json(facts)}));`), valid);
    equal(await snapshot(), before);
    const serviceRpc = async (name, body) => {
      requireEvidence(Date.now() < deadline);
      const signal = AbortSignal.timeout(5000);
      const response = await fetch(`${LOCAL_API}/rest/v1/rpc/${name}`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal,
        headers: { Authorization: 'Bearer '.concat(local.serviceKey), apikey: local.serviceKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(response, 32768, signal);
      requireEvidence(response.ok); return data;
    };
    const claim = (owner, n, overrides = {}) => serviceRpc('ai_claim_analysis', {
      p_owner_id: owner.uid, p_request_id: analysisId(owner.label, n), p_draft_id: analysisId(owner.label, n),
      p_generation: 1, p_image_sha256: analysisHash, p_byte_count: 31, p_width: 120, p_height: 80,
      p_manifest_id: manifest, ...overrides,
    });
    const finish = (owner, n, usage = analysisUsage, code = 'SUCCESS', facts = analysisFacts) => serviceRpc('ai_finish_analysis', {
      p_owner_id: owner.uid, p_request_id: analysisId(owner.label, n), p_manifest_id: manifest,
      p_facts: facts, p_usage: usage, p_code: code,
    });
    const bill = (owner, n, amount, code = 'BILLING_ONLY') => serviceRpc('ai_settle_request', {
      p_owner_id: owner.uid, p_request_id: analysisId(owner.label, n), p_facts: analysisFacts, p_billed_micro: amount, p_code: code,
    });
    const record = async (owner, n) => db(`select jsonb_build_object(
      'usage',${rowsSql('private.ai_usage', `owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, n))}`)},
      'evidence',${rowsSql('private.ai_usage_evidence', `owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, n))}`)},
      'request',${rowsSql('private.ai_requests', `owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, n))}`)}
    );`);
    const accounting = async (owner, n, state, amount, resultPresent) => {
      const r = await record(owner, n);
      requireEvidence(r.usage.length === 1 && r.usage[0].charge_state === state
        && String(r.usage[0].accounted_micro) === amount && (r.request.length === 1) === resultPresent);
    };
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    let mode = 'ready', generations = 0, oauth = 0;
    const handler = createHandler({ supabaseUrl: LOCAL_API, publicKey: local.key, serviceKey: local.serviceKey,
      google: { projectId: 'fictional-b1', clientEmail: 'fixture@fictional-b1.iam.gserviceaccount.com', privateKey: key } },
    async (url, init) => {
      requireEvidence(init.method === 'POST' && init.redirect === 'error' && init.cache === 'no-store');
      if (url === TOKEN_URL) {
        oauth++;
        return Response.json({ access_token: 'fictional-local-only', token_type: 'Bearer', expires_in: 300 });
      }
      requireEvidence(url === `${GOOGLE_ORIGIN}/v1/projects/fictional-b1/locations/eu/publishers/google/models/${MODEL_ID}:generateContent`);
      generations++;
      const sent = JSON.parse(init.body);
      equal(Object.keys(sent).sort(), ['contents', 'generationConfig', 'safetySettings', 'systemInstruction'].sort());
      equal(sent.generationConfig, GENERATION_CONFIG); equal(sent.safetySettings, SAFETY_SETTINGS);
      equal(sent.systemInstruction, { parts: [{ text: PROMPT }] });
      const image = sent.contents[0].parts[0].inlineData;
      requireEvidence(image.mimeType === 'image/jpeg' && createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') === analysisHash);
      return Response.json({ modelVersion: MODEL_ID,
        usageMetadata: mode === 'unknown' ? { trafficType: 'ON_DEMAND' } : mode === 'zero'
          ? { trafficType: 'ON_DEMAND', promptTokenCount: 0, totalTokenCount: 0 } : { ...analysisUsage, modelVersion: undefined },
        candidates: [{ finishReason: 'STOP', content: { role: 'model',
          parts: [{ text: JSON.stringify(mode === 'failed' ? { ...analysisFacts, fields: { title: 'not allowed' } } : analysisFacts) }] } }],
      }, { status: mode === 'http-failed' ? 500 : 200 });
    });
    server = createServer(async (req, res) => {
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; requireEvidence(size <= 513000); chunks.push(chunk); }
        const request = new Request(`http://127.0.0.1${req.url}`, {
          method: req.method, headers: req.headers,
          ...(['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
        });
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.requestTimeout = 20_000; server.headersTimeout = 20_000;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    stage = 'temporary-policy';
    await privilegedLocalSql(`update private.ai_controls set activated=true,notice_revision=1,model_id='gemini-3.8-flash',
      prompt_version=1,max_request_micro=2270823,monthly_allowance_micro=100000000,max_requests_per_hour=200,
      result_ttl_seconds=3600,execution_manifest_id=${literal(manifest)} where ${ownerWhere};`);
    const run = async (phase, expectedGenerations = 0) => {
      mode = phase; const count = generations;
      await child('integration', phase, origin);
      requireEvidence(generations - count === expectedGenerations);
      const active = await snapshot();
      requireEvidence(owners.every((o) => active.ai_usage.filter((u) => u.owner_id === o.uid
        && ids.includes(u.request_id)).length <= 32));
    };
    await run('validation');
    requireEvidence(oauth === 0); equal((await snapshot()).ai_usage, before.ai_usage);
    await run('ready', 2); await run('concurrent', 2); await run('legacy');
    stage = 'constraint-negatives';
    const allRows = await snapshot();
    for (const [table, assignment] of [
      ['ai_usage', "closed_reason='FAILED',closed_at=null"],
      ['ai_usage', "charge_state='reserved'"],
      ['ai_usage', "charge_state='held',dispatched_at=null"],
      ['ai_usage', "charge_state='held',accounted_micro=1"],
      ['ai_usage', "charge_state='released',accounted_micro=1,dispatched_at=null"],
      ['ai_usage_evidence', 'estimated_micro=-1'],
      ['ai_usage_evidence', 'normalized_usage=null'],
      ['ai_analysis_attestations', 'byte_count=512001'],
      ['ai_analysis_attestations', 'width=0'],
      ['ai_analysis_attestations', 'height=1601'],
      ['ai_analysis_attestations', "image_sha256='wrong'"],
      ['ai_analysis_attestations', "dispatch_before=claimed_at+interval '21 seconds'"],
    ]) {
      await privilegedLocalSql(`begin; do $$ begin
        begin
          update private.${table} set ${assignment} where owner_id=${literal(owners[0].uid)}
            and request_id=${literal(analysisId('A', 1))};
          raise exception 'Expected check violation';
        exception when check_violation then null; end;
      end $$; rollback;`);
    }
    for (const table of ['ai_usage_evidence', 'ai_analysis_attestations'])
      await privilegedLocalSql(`begin; do $$ begin
        begin
          update private.${table} set owner_id=${literal(owners[1].uid)}
            where owner_id=${literal(owners[0].uid)} and request_id=${literal(analysisId('A', 1))};
          raise exception 'Expected composite owner FK violation';
        exception when foreign_key_violation then null; end;
      end $$; rollback;`);
    await privilegedLocalSql(`begin; do $$ begin
      begin
        update private.ai_execution_manifests set maximum_side=1 where id=${literal(manifest)};
        raise exception 'Expected immutable manifest refusal';
      exception when insufficient_privilege then null; end;
    end $$; rollback;`);
    equal(await snapshot(), allRows);
    stage = 'claim-admission';
    for (const owner of owners) {
      for (const overrides of [{ p_byte_count: 512001 }, { p_width: 1601 }, { p_height: 0 },
        { p_image_sha256: 'invalid' }, { p_generation: 0 }, { p_manifest_id: 'other' }]) {
        const result = await claim(owner, 32, overrides);
        requireEvidence(result.claimed === false && result.code !== 'OK');
      }
      const result = await claim(owner, 4);
      requireEvidence(result.code === 'OK' && result.claimed === true);
      equal(await claim(owner, 4), { code: 'ALREADY_CLAIMED', claimed: false });
      const saved = await record(owner, 1);
      requireEvidence((await finish(owner, 1, analysisUsage, 'SUCCESS', { outcome: 'ready', fields: {} })).code === 'FACTS_CONFLICT');
      equal(await record(owner, 1), saved);
    }
    await run('lost');
    await run('failed', 2); await run('unknown', 2); await run('zero', 2); await run('http-failed', 2);
    stage = 'accounting-and-terminal-fixtures';
    for (const owner of owners) {
      await accounting(owner, 5, 'estimated', '413', false);
      await accounting(owner, 6, 'held', '2270823', true);
      await accounting(owner, 7, 'estimated', '0', true);
      await accounting(owner, 20, 'estimated', '413', false);
      for (const n of [8, 9, 10, 11, 12, 13, 14, 15, 17]) requireEvidence((await claim(owner, n)).claimed === true);
      const saved = await record(owner, 4);
      for (const code of ['SUCCESS', 'FAILED']) equal(await bill(owner, 4, 0, code), { code: 'UNAVAILABLE', stored: false });
      equal(await record(owner, 4), saved);
      equal((await finish(owner, 3)).code, 'UNAVAILABLE');
      const where = `owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, 10))}`;
      await privilegedLocalSql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',
        expires_at=clock_timestamp()-interval '1 hour' where ${where};`);
    }
    await run('discard'); await run('withdraw');
    for (const owner of owners) {
      const result = await finish(owner, 9);
      requireEvidence(result.stored === false && result.code === 'UNAVAILABLE');
    }
    await run('restore'); await run('expired');
    for (const owner of owners) for (const n of [8, 9, 10]) {
      const result = await finish(owner, n);
      requireEvidence(result.stored === false && result.code === 'TERMINAL');
      await accounting(owner, n, 'estimated', '413', false);
    }
    stage = 'manifest-status-guard';
    await privilegedLocalSql(`update private.ai_controls set execution_manifest_id=null where ${ownerWhere};`);
    await run('config');
    await privilegedLocalSql(`update private.ai_controls set execution_manifest_id=${literal(manifest)} where ${ownerWhere};`);
    stage = 'usage-reconciliation';
    for (const owner of owners) {
      const where = `owner_id=${literal(owner.uid)} and request_id=${literal(analysisId(owner.label, 11))}`;
      await privilegedLocalSql(`update private.ai_usage set period=to_char(clock_timestamp()-interval '1 month','YYYY-MM') where ${where};`);
      const old = await client.rpc(owner, 'ai_status', {});
      await finish(owner, 11, analysisUsage, 'USAGE_ONLY');
      const after = await client.rpc(owner, 'ai_status', {});
      requireEvidence(BigInt(old.usage.accountedMicro) - BigInt(after.usage.accountedMicro) === 2270823n);
      for (const n of [12, 13]) {
        if (n === 13) await finish(owner, n, analysisUsage, 'USAGE_ONLY');
        await bill(owner, n, 500);
        const result = await finish(owner, n, analysisUsage, 'USAGE_ONLY');
        equal(result.accounting, { basis: 'confirmed', amountMicro: '500', currency: 'USD' });
        equal((await bill(owner, n, 501)).code, 'BILLING_CONFLICT');
      }
      await finish(owner, 14, analysisUsage, 'USAGE_ONLY');
      const saved = await record(owner, 14);
      equal((await finish(owner, 14, { ...analysisUsage, totalTokenCount: 131 })).code, 'USAGE_CONFLICT');
      equal(await record(owner, 14), saved);
      for (const usage of [null, {}, { ...analysisUsage, totalTokenCount: 1 }, { ...analysisUsage, thoughtsTokenCount: 31 },
        { ...analysisUsage, trafficType: 'OTHER' }, { ...analysisUsage, extra: true }]) {
        const held = await finish(owner, 4, usage, 'USAGE_ONLY');
        equal(held.accounting, { basis: 'held', amountMicro: '2270823', currency: 'USD' });
      }
      const overrun = await finish(owner, 15, { ...analysisUsage, totalTokenCount: 1_000_100 });
      requireEvidence(overrun.code === 'USAGE_ANOMALY' && overrun.stored === false);
      equal(overrun.accounting, { basis: 'estimated', amountMicro: '8250165', currency: 'USD' });
    }
    await run('overrun');
    stage = 'success-only-restoration';
    requireEvidence(Date.now() < deadline);
    equal(await inventory(client, owners), preserved);
    for (const [index, owner] of owners.entries()) {
      const p = (await client.rows(owner, 'profiles'))[0];
      requireEvidence(p.version === versions[index] + 2 && p.ai_enabled && p.ai_notice_revision === 1);
    }
    const final = await snapshot();
    for (const table of ['ai_usage', 'ai_requests'])
      equal(final[table].filter((r) => !ids.includes(r.request_id)), before[table]);
    const restore = before.ai_controls.map((c) => `update private.ai_controls c set
      ${columns.map((col) => `${col}=v.${col}`).join(',')} from jsonb_populate_record(null::private.ai_controls,${json(c)}) v
      where c.owner_id=v.owner_id;`).join('\n');
    await privilegedLocalSql(`begin; delete from private.ai_usage where ${namespace}; ${restore} commit;`);
    equal(await snapshot(), before);
    equal(await requireReady(client, owners), ready);
    await baseline(client, owners);
    await child('integration'); await child('security');
    console.log(`PASS: B1 real Auth/DB and Google-only synthetic transport; generations=${generations}; exact 14-ledger/2-ready baseline restored; profile CAS versions advanced twice`);
    stage = 'B2-entry';
    requireEvidence(generations === 12);
    const b2Tables = ['ai_save_used_receipts', 'ai_item_save_attempts', 'ai_item_save_context', 'item_attribution_history', 'item_save_used_ids'];
    const b2Snapshot = () => db(`select jsonb_build_object(${b2Tables.map((t) => `${literal(t)},${rowsSql(`private.${t}`)}`).join(',')});`);
    const b2Before = await b2Snapshot(), countBefore = generations;
    const b2Child = async (suite, phase, origin) => {
      stage = `B2-${suite}-${phase}`;
      requireEvidence(Date.now() < deadline);
      const result = await runCommand(process.execPath, [`${ROOT}tests/${suite}/analyzed-save.sessions.mjs`,
        phase, ...(origin ? [origin] : [])], { env, timeout: 120_000 });
      requireEvidence(result.code === 0);
      console.log(`PASS: B2 ${suite}/${phase} normal-session child`);
    };
    await privilegedLocalSql(`update private.ai_controls set activated=true,notice_revision=1,model_id='gemini-3.8-flash',
      prompt_version=1,max_request_micro=2270823,monthly_allowance_micro=100000000,max_requests_per_hour=200,
      result_ttl_seconds=3600,execution_manifest_id=${literal(manifest)} where ${ownerWhere};`);
    mode = 'ready';
    owned = await startAnalysisServer();
    await b2Child('integration', 'prepare', origin);
    requireEvidence(generations - countBefore === 22);
    owned.assertRunning();
    // The server credential only exercises service-boundary negatives, never owner access assertions.
    const completeProbe = async (owner, value, row, objects, expected) => {
      const response = await fetch(`${LOCAL_API}/rest/v1/rpc/complete_analyzed_item_save`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bearer '.concat(local.serviceKey), apikey: local.serviceKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_owner_id: owner.uid, p_item_id: value.p_item.id,
          p_image_id: value.p_image.id, p_fingerprint: row.fingerprint, p_objects: objects }),
      });
      requireEvidence(response.status === 400 || response.status === 403);
      const result = await readJson(response, 4096, AbortSignal.timeout(5000));
      requireEvidence(result.code === expected && result.details === null && result.hint === null);
    };
    for (const owner of owners) {
      const h = analyzedHarness(client, owner, env), value = analyzedIntent(owner, 27), row = await h.reserve(value);
      const old = await h.preflight(value, row);
      await h.remove(value); await h.upload(value);
      const next = await h.preflight(value, row);
      for (const variant of ['main', 'thumb']) {
        requireEvidence(old.objects[variant].id !== next.objects[variant].id
          && old.objects[variant].version !== next.objects[variant].version);
        for (const field of ['id', 'version']) {
          const wrong = structuredClone(next.objects); wrong[variant][field] = old.objects[variant][field];
          await completeProbe(owner, value, row, wrong, '22023');
        }
      }
      await completeProbe(owner, value, row, old.objects, '22023');
      for (const resource of ['profile', 'item', 'image', 'objects'])
        await withAnalyzedSaveFixtureLock(owner.uid, value.p_item.id, value.p_image.id, resource,
          () => completeProbe(owner, value, row, next.objects, '22023'));
      requireEvidence((await h.endpoint(value, row, local.serviceKey)).status === 401);
      const approval = await db(`select to_jsonb(enabled) from private.approved_accounts where user_id=${literal(owner.uid)};`);
      requireEvidence(approval === true);
      await privilegedLocalSql(`update private.approved_accounts set enabled=false where user_id=${literal(owner.uid)};`);
      await completeProbe(owner, value, row, next.objects, '42501');
      requireEvidence((await h.endpoint(value, row)).status === 403);
      await privilegedLocalSql(`update private.approved_accounts set enabled=true where user_id=${literal(owner.uid)};`);
    }
    await b2Child('security', 'full');
    await b2Child('integration', 'full');
    await b2Child('integration', 'withdraw');
    const expiring = owners.flatMap((o) => [24, 31].map((n) => analysisId(o.label, n)));
    await privilegedLocalSql(`update private.ai_requests set created_at=clock_timestamp()-interval '2 hours',
      expires_at=clock_timestamp()-interval '1 hour' where ${ownerWhere} and request_id in (${expiring.map(literal).join(',')});`);
    await b2Child('integration', 'expired');
    await privilegedLocalSql(`update private.ai_controls set activated=false where ${ownerWhere};`);
    await b2Child('integration', 'inactive');
    await b2Child('integration', 'cleanup');
    owned.assertRunning(); await owned.stop(); owned = undefined;
    stage = 'B2-success-only-restoration';
    requireEvidence(generations - countBefore === 22);
    equal(await inventory(client, owners), preserved);
    const b2Ids = owners.flatMap((o) => Array.from({ length: 11 }, (_, i) => saveId(o.label, i + 21)));
    const now = await b2Snapshot();
    for (const table of b2Tables)
      equal(now[table].filter((r) => !b2Ids.includes(r.item_id)), b2Before[table]);
    requireEvidence(now.ai_item_save_context.length === 0 && now.ai_item_save_attempts.length === 0
      && now.item_attribution_history.length === 0);
    for (const [index, owner] of owners.entries())
      requireEvidence((await client.rows(owner, 'profiles'))[0].version === versions[index] + 4);
    await privilegedLocalSql(`begin; delete from private.ai_usage where ${namespace};
      delete from private.ai_save_used_receipts where ${ownerWhere} and item_id in (${b2Ids.map(literal).join(',')});
      delete from private.item_save_used_ids where ${ownerWhere} and item_id in (${b2Ids.map(literal).join(',')});
      ${restore} commit;`);
    equal(await snapshot(), before); equal(await b2Snapshot(), b2Before);
    equal(await requireReady(client, owners), ready); await baseline(client, owners);
    console.log('PASS: B2 actual Deno/Auth/DB/Storage; synthetic Google generations=22 separately from B1=12; exact private/14-ledger/2-ready baseline restored; B2 profile CAS advances=2 per owner');
  } catch {
    console.error(`FAIL: B1 rehearsal at ${stage}; private evidence withheld; fixture state preserved, no automatic recovery`);
    process.exitCode = 1;
  } finally {
    await owned?.stop();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
}
if (isMain(import.meta.url)) await main();
