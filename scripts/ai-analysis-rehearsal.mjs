import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT, LOCAL_API, assertNoServiceSecrets, readCredentialCache, normalSessionEnvironment,
  localStatus, privilegedLocalSql, runCommand, startAnalysisServer, parseServedDiagnostics, withAnalyzedSaveFixtureLock } from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import { createHandler } from '../supabase/functions/analyze-clothing/handler.ts';
import { AZURE_MODEL, AZURE_ENDPOINT, azureRequest } from '../supabase/functions/analyze-clothing/azure-openai.ts';
import { readJson } from '../supabase/functions/analyze-clothing/protocol.ts';
import { aiClients, requireReady, AI_FACT_VECTORS } from '../tests/integration/ai-controls.sessions.mjs';
import { baseline, analysisId, analysisFacts, analysisUsage, analysisHash, equal } from '../tests/integration/ai-analysis.sessions.mjs';
import { TABLES, requireEvidence } from '../tests/integration/preservation.sessions.mjs';
import { analyzedHarness, analyzedIntent, saveId } from '../tests/integration/analyzed-save.sessions.mjs';
import { assertSanitizedJpeg, readJpegHeader } from '../src/images/jpeg.ts';
import { imageReplacementServed } from '../tests/integration/image-replacement.sessions.mjs';
const cAnalysisFacts = { ...analysisFacts, fields: { ...analysisFacts.fields, sleeve_length: 'long' } };

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const db = async (sql) => JSON.parse(await privilegedLocalSql(sql));
const manifest = 'azure-eu-terra-devtest-v1';
const privateTables = ['ai_controls', 'ai_usage', 'ai_requests', 'ai_usage_evidence', 'ai_analysis_attestations'];
const rowsSql = (table, where = 'true') =>
  `coalesce((select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from ${table} t where ${where}),'[]'::jsonb)`;
function markedRecords(stdout, stderr, marker, limit, recordLimit, lineLimit = 262145) {
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 262144) return null;
  const records = [];
  for (const text of [stdout, stderr]) {
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > lineLimit) return null;
    for (const [index, line] of lines.entries()) {
      const at = line.indexOf(marker);
      if (at < 0) continue;
      if (line.length > recordLimit + 256 || at > 256 || index === lines.length - 1
        || line.indexOf(marker, at + marker.length) !== -1
        || !line.slice(0, at).split('\u001b').every((part, index) => {
          const progress = index === 0 ? part : part.replace(/^\[[0-9;]*m/, '');
          return (index === 0 || progress !== part) && /^[ \t.\u00b7\u00b0\u00d7\u00b1\u2713\u2718]*$/.test(progress);
        })) return null;
      let record = line.slice(at).trimEnd();
      // Strip only trailing SGR decoration, never escapes embedded in protocol data.
      for (;;) {
        const escape = record.lastIndexOf('\u001b');
        if (escape < 0 || !/^\[[0-9;]*m$/.test(record.slice(escape + 1))) break;
        record = record.slice(0, escape).trimEnd();
      }
      if (!record.startsWith(`${marker} `) || Buffer.byteLength(record) > recordLimit || records.length >= limit) return null;
      records.push(record.slice(marker.length + 1));
    }
  }
  return records;
}
function cProgress(stdout, stderr) {
  const records = markedRecords(stdout, stderr, 'I29_C_STAGE', 32, 128, 4096);
  const ownerStages = ['OWNER', 'INITIALIZE', 'CONSENT', 'ANALYSIS', 'SAVE', 'SAVE_WAIT_RETRY', 'SAVE_RETRY',
    'SAVE_RETURNED', 'VERIFY', 'CLEANUP', 'CLOSED', 'RESTORE', 'DONE'];
  const expected = ['ENTRY 0', 'AUTH 0', ...[1, 2].flatMap((owner) => ownerStages.flatMap((stage) =>
    (owner === 2 && stage === 'SAVE' ? ['SAVE', 'SAVE_DISCARD', 'SAVE_REFUSAL', 'SAVE_MANUAL'] : [stage])
      .map((step) => `${step} ${owner}`))), 'COMPLETE 2'];
  if (!records?.length || records.length > expected.length || records.some((record, index) => record !== expected[index])) {
    return { stage: 'UNKNOWN', owner: 0 };
  }
  const [stage, owner] = expected[records.length - 1].split(' ');
  return { stage, owner: Number(owner) };
}
function nonAiProfile(profile) {
  return Object.fromEntries(Object.entries(profile).filter(([key]) =>
    !['version', 'updated_at', 'ai_enabled', 'ai_notice_revision', 'ai_consented_at'].includes(key)));
}
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
 'privateDenied',(select count(*)=12 and bool_and(not has_function_privilege('anon',p.oid,'EXECUTE')
   and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
   and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
   and p.proname in ('ai_manifest_immutable','ai_begin_owner','ai_settle_core','ai_normal_usage','ai_analysis_permitted','ai_accounting','ai_finish_google_legacy',
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
 'historyPrivateManifest',exists(select 1 from pg_constraint where conrelid='private.item_attribution_history'::regclass
   and confrelid='private.ai_execution_manifests'::regclass and confdeltype='a'),
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
    const consentRevision = async (revision) => {
      for (const owner of owners) {
        const previous = (await client.rows(owner, 'profiles'))[0];
        equal(await client.rpc(owner, 'ai_set_consent', { p_enabled: true, p_notice_revision: revision,
          p_expected_version: previous.version }), { code: 'OK', profileVersion: String(previous.version + 1) });
        const next = (await client.rows(owner, 'profiles'))[0];
        requireEvidence(next.ai_enabled && next.ai_notice_revision === revision && next.version === previous.version + 1);
        equal(nonAiProfile(next), nonAiProfile(previous));
      }
    };
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
    let mode = 'ready', generations = 0;
    const cRequestContext = new AsyncLocalStorage();
    const cRequests = [];
    const handler = createHandler({ supabaseUrl: LOCAL_API, publicKey: local.key, serviceKey: local.serviceKey,
      azure: { apiKey: 'fictional-local-only' } },
    async (url, init) => {
      requireEvidence(init.method === 'POST' && init.redirect === 'error' && init.cache === 'no-store');
      requireEvidence(url === AZURE_ENDPOINT);
      generations++;
      const sent = JSON.parse(init.body);
      const image = sent.messages[1].content[0].image_url;
      requireEvidence(image.url.startsWith('data:image/jpeg;base64,'));
      const bytes = Buffer.from(image.url.slice('data:image/jpeg;base64,'.length), 'base64');
      equal(sent, azureRequest(bytes));
      const cRequest = cRequestContext.getStore();
      if (cRequest) {
        const dimensions = readJpegHeader(bytes);
        requireEvidence(bytes.length === cRequest.byteCount
          && dimensions.width === cRequest.width && dimensions.height === cRequest.height
          && createHash('sha256').update(bytes).digest('hex') === cRequest.imageSha256
          && cRequest.generations === 0);
        cRequest.generations++;
      } else {
        requireEvidence(createHash('sha256').update(bytes).digest('hex') === analysisHash);
      }
      return Response.json({ model: AZURE_MODEL,
        usage: mode === 'unknown' ? {} : {
          prompt_tokens: mode === 'zero' ? 0 : 100, completion_tokens: mode === 'zero' ? 0 : 30,
          total_tokens: mode === 'zero' ? 0 : 130,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: mode === 'zero' ? 0 : 20 },
        },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', refusal: null,
          content: JSON.stringify(mode === 'failed' ? { ...analysisFacts, fields: { title: 'not allowed' } }
            : cRequest && mode === 'ready' ? cAnalysisFacts : analysisFacts) } }],
      }, { status: mode === 'http-failed' ? 500 : 200 });
    });
    server = createServer(async (req, res) => {
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; requireEvidence(size <= 513000); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks);
        const request = new Request(`http://127.0.0.1${req.url}`, {
          method: req.method, headers: req.headers,
          ...(['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? {} : { body: bytes }),
        });
        const requestId = request.headers.get('x-stillroom-request-id') ?? '';
        let cRequest;
        if (requestId.startsWith('c329')) {
          const match = /^c329([ab])000-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(requestId);
          requireEvidence(match && req.method === 'POST' && req.url === '/analyze-clothing'
            && request.headers.get('content-type') === 'image/jpeg' && bytes.length > 0 && bytes.length <= 512000);
          const owner = owners[match[1] === 'a' ? 0 : 1], prefix = requestId.slice(0, 9);
          const draftId = request.headers.get('x-stillroom-draft-id') ?? '';
          requireEvidence(new RegExp(`^${prefix}[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(draftId)
            && draftId !== requestId && request.headers.get('x-stillroom-generation') === '1'
            && !cRequests.some((value) => value.ownerId === owner.uid));
          const dimensions = readJpegHeader(bytes);
          assertSanitizedJpeg(bytes, dimensions.width, dimensions.height);
          cRequest = { ownerId: owner.uid, requestId, draftId, generation: 1, imageSha256: createHash('sha256').update(bytes).digest('hex'),
            byteCount: bytes.length, width: dimensions.width, height: dimensions.height, generations: 0 };
          cRequests.push(cRequest);
        }
        const response = await cRequestContext.run(cRequest, () => handler(request));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.requestTimeout = 20_000; server.headersTimeout = 20_000;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    stage = 'temporary-policy';
    await privilegedLocalSql(`update private.ai_controls set activated=true,notice_revision=2,model_id='gpt-5.6-terra-2026-07-09',
      prompt_version=1,max_request_micro=4097351,monthly_allowance_micro=100000000,max_requests_per_hour=200,
      result_ttl_seconds=3600,execution_manifest_id=${literal(manifest)} where ${ownerWhere};`);
    await consentRevision(2);
    const run = async (phase, expectedGenerations = 0) => {
      mode = phase; const count = generations;
      await child('integration', phase, origin);
      requireEvidence(generations - count === expectedGenerations);
      const active = await snapshot();
      requireEvidence(owners.every((o) => active.ai_usage.filter((u) => u.owner_id === o.uid
        && ids.includes(u.request_id)).length <= 32));
    };
    await run('validation');
    requireEvidence(generations === 0); equal((await snapshot()).ai_usage, before.ai_usage);
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
      requireEvidence((await finish(owner, 1, analysisUsage, 'SUCCESS',
        { ...analysisFacts, fields: { ...analysisFacts.fields, category: 'bottom' } })).code === 'FACTS_CONFLICT');
      equal(await record(owner, 1), saved);
    }
    await run('lost');
    await run('failed', 2); await run('unknown', 2); await run('zero', 2); await run('http-failed', 2);
    stage = 'accounting-and-terminal-fixtures';
    for (const owner of owners) {
      await accounting(owner, 5, 'estimated', '1034', false);
      await accounting(owner, 6, 'held', '4097351', false);
      await accounting(owner, 7, 'estimated', '0', true);
      await accounting(owner, 20, 'estimated', '1034', false);
      for (const n of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 32]) requireEvidence((await claim(owner, n)).claimed === true);
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
      await accounting(owner, n, 'estimated', '1034', false);
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
      requireEvidence(BigInt(old.usage.accountedMicro) - BigInt(after.usage.accountedMicro) === 4097351n);
      for (const n of [12, 13]) {
        if (n === 13) await finish(owner, n, analysisUsage, 'USAGE_ONLY');
        await bill(owner, n, 500);
        const result = await finish(owner, n, analysisUsage, 'USAGE_ONLY');
        equal(result.accounting, { basis: 'confirmed', amountMicro: '500', currency: 'USD' });
        equal((await bill(owner, n, 501)).code, 'BILLING_CONFLICT');
      }
      await finish(owner, 14, analysisUsage, 'USAGE_ONLY');
      const saved = await record(owner, 14);
      equal((await finish(owner, 14, { ...analysisUsage, total: 131 })).code, 'USAGE_CONFLICT');
      equal(await record(owner, 14), saved);
      for (const usage of [null, {}, { ...analysisUsage, total: 1 }, { ...analysisUsage, reasoning: 31 },
        { ...analysisUsage, input: null }, { ...analysisUsage, cacheRead: 0.5 },
        { ...analysisUsage, cacheWrite: 9007199254740992 }, { ...analysisUsage, extra: true }]) {
        const held = await finish(owner, 4, usage, 'USAGE_ONLY');
        equal(held.accounting, { basis: 'held', amountMicro: '4097351', currency: 'USD' });
        equal((await client.rpc(owner, 'ai_status', {})).policy.activated, true);
      }
      for (const [n, usage] of [
        [16, { ...analysisUsage, input: null, cacheRead: 1, controlObservation: 'cache_read' }],
        [18, { ...analysisUsage, modelObservation: 'response_missing_model' }],
        [19, { ...analysisUsage, cacheWrite: 1, controlObservation: 'cache_write' }],
      ]) {
        const anomaly = await finish(owner, n, usage);
        equal(anomaly, { code: 'USAGE_ANOMALY', stored: false,
          accounting: { basis: 'held', amountMicro: '4097351', currency: 'USD' } });
        const saved = await record(owner, n);
        requireEvidence(saved.evidence[0].anomaly && saved.evidence[0].normalized_usage === null
          && saved.request.length === 0);
        equal((await client.rpc(owner, 'ai_status', {})).policy.activated, false);
        equal((await finish(owner, n)).code, 'USAGE_CONFLICT');
        equal(await record(owner, n), saved);
        await privilegedLocalSql(`update private.ai_controls set activated=true where owner_id=${literal(owner.uid)};`);
      }
      const invalidFacts = await finish(owner, 32, analysisUsage, 'SUCCESS', { outcome: 'ready', fields: {} });
      equal(invalidFacts, { code: 'INVALID_FACTS', stored: false,
        accounting: { basis: 'estimated', amountMicro: '1034', currency: 'USD' } });
      equal((await finish(owner, 32)).code, 'TERMINAL');
      const overrun = await finish(owner, 15, { ...analysisUsage, input: 922001, output: 2049, total: 924050 });
      requireEvidence(overrun.code === 'USAGE_ANOMALY' && overrun.stored === false);
      equal(overrun.accounting, { basis: 'estimated', amountMicro: '4097375', currency: 'USD' });
    }
    await run('overrun');
    stage = 'success-only-restoration';
    requireEvidence(Date.now() < deadline);
    equal(await inventory(client, owners), preserved);
    for (const [index, owner] of owners.entries()) {
      const p = (await client.rows(owner, 'profiles'))[0];
      requireEvidence(p.version === versions[index] + 3 && p.ai_enabled && p.ai_notice_revision === 2);
    }
    const final = await snapshot();
    for (const table of ['ai_usage', 'ai_requests'])
      equal(final[table].filter((r) => !ids.includes(r.request_id)), before[table]);
    const restore = before.ai_controls.map((c) => `update private.ai_controls c set
      ${columns.map((col) => `${col}=v.${col}`).join(',')} from jsonb_populate_record(null::private.ai_controls,${json(c)}) v
      where c.owner_id=v.owner_id;`).join('\n');
    await privilegedLocalSql(`begin; delete from private.ai_usage where ${namespace}; ${restore} commit;`);
    await consentRevision(1);
    equal(await snapshot(), before);
    equal(await requireReady(client, owners), ready);
    await baseline(client, owners);
    await child('integration'); await child('security');
    console.log(`PASS: AZ1 B1 real Auth/DB and Azure-only synthetic transport; generations=${generations}; exact 14-ledger/2-ready baseline restored; consent migration/restoration plus withdraw/enable CAS=4`);
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
    await privilegedLocalSql(`update private.ai_controls set activated=true,notice_revision=2,model_id='gpt-5.6-terra-2026-07-09',
      prompt_version=1,max_request_micro=4097351,monthly_allowance_micro=100000000,max_requests_per_hour=200,
      result_ttl_seconds=3600,execution_manifest_id=${literal(manifest)} where ${ownerWhere};`);
    await consentRevision(2);
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
    for (const owner of owners) {
      const h = analyzedHarness(client, owner, env), completed = analyzedIntent(owner, 23);
      requireEvidence((await h.reserve(completed)).state === 'completed');
      const history = await db(`select coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb)
        from private.item_attribution_history h where owner_id=${literal(owner.uid)}
          and item_id=${literal(completed.p_item.id)} and source_image_id=${literal(completed.p_image.id)};`);
      requireEvidence(history.length === 1 && history[0].manifest_id === 'azure-eu-terra-devtest-v1');
      const publicHistory = await client.rpc(owner, 'item_attribution_history', { p_item_id: completed.p_item.id });
      requireEvidence(publicHistory.length === 1);
      equal(Object.keys(publicHistory[0]).sort(), ['fields', 'image_sha256', 'model_id', 'prompt_version', 'source_image_id']);
      equal(publicHistory[0], Object.fromEntries(Object.entries(history[0])
        .filter(([key]) => !['owner_id', 'item_id', 'manifest_id'].includes(key))));
    }
    for (const owner of owners) {
      const h = analyzedHarness(client, owner, env), first = analyzedIntent(owner, 31), accepted = analyzedIntent(owner, 24);
      const beforeLock = await record(owner, 31);
      await withAnalyzedSaveFixtureLock(owner.uid, first.p_item.id, first.p_image.id, 'profile', async () => {
        for (const value of [first, accepted]) {
          const response = await h.call('reserve_analyzed_item_save', value);
          requireEvidence(!response.ok && response.status === 400 && response.data.code === '22023');
        }
      });
      equal(await record(owner, 31), beforeLock);
      equal(await h.read('items', first.p_item.id), []);
      requireEvidence((await h.reserve(accepted)).state === 'reserved');
    }
    await b2Child('integration', 'withdraw');
    for (const owner of owners) {
      const refused = await record(owner, 31);
      requireEvidence(refused.request.length === 0 && refused.evidence[0].claim_identity !== null);
      equal(await claim(owner, 31), { code: 'TERMINAL', claimed: false });
      equal((await finish(owner, 31)).code, 'TERMINAL');
      equal(await record(owner, 31), refused);
    }
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
      requireEvidence((await client.rows(owner, 'profiles'))[0].version === versions[index] + 7);
    await privilegedLocalSql(`begin; delete from private.ai_usage where ${namespace};
      delete from private.ai_save_used_receipts where ${ownerWhere} and item_id in (${b2Ids.map(literal).join(',')});
      delete from private.item_save_used_ids where ${ownerWhere} and item_id in (${b2Ids.map(literal).join(',')});
      ${restore} commit;`);
    await consentRevision(1);
    equal(await snapshot(), before); equal(await b2Snapshot(), b2Before);
    equal(await requireReady(client, owners), ready); await baseline(client, owners);
    console.log('PASS: AZ1 B2 actual Deno/Auth/DB/Storage; synthetic Azure generations=22 separately from B1=12; exact private/14-ledger/2-ready baseline restored; B2 profile CAS advances=4 per owner');
    stage = 'C-entry';
    const cStarted = Date.now(), cCountBefore = generations;
    const headroom = () => deadline - Date.now();
    console.log(`C timing: entryHeadroomMs=${headroom()}`);
    requireEvidence(headroom() > 150_000 && cRequests.length === 0 && cCountBefore === 34);
    const cEntryProfiles = await Promise.all(owners.map(async (owner) => (await client.rows(owner, 'profiles'))[0]));
    for (const [index, profile] of cEntryProfiles.entries()) {
      requireEvidence(profile.owner_id === owners[index].uid && profile.version === versions[index] + 8
        && (profile.ui_language === null || ['en', 'fi', 'sv'].includes(profile.ui_language)));
    }
    for (const table of ['public.items', 'public.item_images', 'private.ai_usage', 'private.ai_requests',
      'private.ai_save_used_receipts', 'private.item_save_used_ids']) {
      const field = table.startsWith('public.') ? 'id' : table.includes('ai_usage') || table.includes('ai_requests') ? 'request_id' : 'item_id';
      requireEvidence(await db(`select to_jsonb(not exists(select 1 from ${table} where ${field}::text like 'c329a000-%' or ${field}::text like 'c329b000-%'));`));
    }
    await privilegedLocalSql(`update private.ai_controls set activated=true,notice_revision=2,model_id='gpt-5.6-terra-2026-07-09',
      prompt_version=1,max_request_micro=4097351,monthly_allowance_micro=100000000,max_requests_per_hour=200,
      result_ttl_seconds=3600,execution_manifest_id=${literal(manifest)} where ${ownerWhere};`);
    await consentRevision(2);
    mode = 'ready';
    owned = await startAnalysisServer();
    owned.assertRunning();
    console.log(`C timing: startupElapsedMs=${Date.now() - cStarted}; childHeadroomMs=${headroom()}`);
    requireEvidence(headroom() > 135_000);
    stage = 'C-ui-child';
    const result = await runCommand(process.execPath, [`${ROOT}node_modules/@playwright/test/cli.js`, 'test',
      '--config', `${ROOT}playwright.ai.config.ts`], {
      env: { ...env, I29_C_ANALYSIS_ORIGIN: origin }, timeout: 120_000, maxOutputBytes: 262144,
    });
    console.log(`C timing: childElapsedMs=${Date.now() - cStarted}; remainingMs=${headroom()}`);
    const diagnostic = cProgress(result.stdout, result.stderr);
    console.log(`C child diagnostic: stage=${diagnostic.stage}; ownerIndex=${diagnostic.owner}; exitCode=${result.code}`);
    requireEvidence(result.code === 0 && headroom() > 0);
    const lines = markedRecords(result.stdout, result.stderr, 'I29_C_RECEIPT', 1, 4096);
    requireEvidence(lines !== null && lines.length === 1);
    const receipts = JSON.parse(lines[0]);
    requireEvidence(Array.isArray(receipts) && receipts.length === 2 && cRequests.length === 2 && generations - cCountBefore === 2
      && cRequests[0].imageSha256 !== cRequests[1].imageSha256);
    const cKeys = ['ownerId', 'requestId', 'draftId', 'generation', 'itemId', 'imageId', 'imageSha256', 'byteCount', 'width', 'height'];
    for (const [index, owner] of owners.entries()) {
      const receipt = receipts[index], request = cRequests.find((value) => value.ownerId === owner.uid);
      requireEvidence(receipt && Object.keys(receipt).length === cKeys.length && cKeys.every((key) => Object.hasOwn(receipt, key))
        && request && request.generations === 1 && receipt.ownerId === owner.uid);
      for (const key of cKeys.filter((key) => !['itemId', 'imageId'].includes(key))) equal(receipt[key], request[key]);
      const prefix = index === 0 ? 'c329a000-' : 'c329b000-';
      requireEvidence(['requestId', 'draftId', 'itemId', 'imageId'].every((key) =>
        new RegExp(`^${prefix}[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(receipt[key]))
        && new Set(['requestId', 'draftId', 'itemId', 'imageId'].map((key) => receipt[key])).size === 4);
      const attestation = await db(`select coalesce((select to_jsonb(t) from private.ai_analysis_attestations t
        where owner_id=${literal(owner.uid)} and request_id=${literal(receipt.requestId)}),'null'::jsonb);`);
      if (index === 0) requireEvidence(attestation && attestation.image_sha256 === receipt.imageSha256 && attestation.byte_count === receipt.byteCount
        && attestation.width === receipt.width && attestation.height === receipt.height && attestation.manifest_id === manifest);
      else {
        equal(attestation, null);
        const terminal = await db(`select jsonb_build_object('usage',to_jsonb(u),'identity',e.claim_identity)
          from private.ai_usage u join private.ai_usage_evidence e using(owner_id,request_id)
          where u.owner_id=${literal(owner.uid)} and u.request_id=${literal(receipt.requestId)};`);
        requireEvidence(terminal.usage.closed_reason === 'DISCARDED' && terminal.usage.charge_state === 'estimated'
          && terminal.usage.accounted_micro === 1034);
        equal(terminal.identity, { draftId: receipt.draftId, generation: receipt.generation,
          imageSha256: receipt.imageSha256, bytes: receipt.byteCount, width: receipt.width, height: receipt.height });
      }
      const p = (await client.rows(owner, 'profiles'))[0];
      const original = cEntryProfiles[index], languageWrites = original.ui_language === null ? 2 : 0;
      requireEvidence(p.version === versions[index] + 11 + languageWrites
        && p.version === original.version + 3 + languageWrites && p.ai_enabled === true && p.ai_notice_revision === 2
        && typeof p.ai_consented_at === 'string' && Number.isFinite(Date.parse(p.ai_consented_at)));
      equal(nonAiProfile(p), nonAiProfile(original));
    }
    stage = 'C-success-only-restoration';
    owned.assertRunning(); await owned.stop(); owned = undefined;
    requireEvidence(headroom() > 0);
    equal(await inventory(client, owners), preserved);
    const cFinal = await snapshot(), cB2Final = await b2Snapshot();
    const requestIds = receipts.map((row) => row.requestId), itemIds = receipts.map((row) => row.itemId);
    for (const table of ['ai_usage', 'ai_requests', 'ai_usage_evidence', 'ai_analysis_attestations']) {
      requireEvidence(cFinal[table].length === before[table].length
        + (['ai_requests', 'ai_analysis_attestations'].includes(table) ? 1 : 2));
      equal(cFinal[table].filter((row) => !requestIds.includes(row.request_id)), before[table]);
    }
    for (const table of b2Tables) equal(cB2Final[table].filter((row) => !itemIds.includes(row.item_id)), b2Before[table]);
    requireEvidence(cB2Final.ai_save_used_receipts.length === b2Before.ai_save_used_receipts.length + 1
      && cB2Final.item_save_used_ids.length === b2Before.item_save_used_ids.length + 2
      && cB2Final.ai_item_save_attempts.length === b2Before.ai_item_save_attempts.length
      && cB2Final.item_attribution_history.length === b2Before.item_attribution_history.length
      && cB2Final.ai_item_save_context.length === 0);
    for (const [index, receipt] of receipts.entries()) {
      equal(cB2Final.ai_save_used_receipts.some((row) => row.owner_id === receipt.ownerId && row.request_id === receipt.requestId
        && row.item_id === receipt.itemId && row.image_id === receipt.imageId), index === 0);
    }
    requireEvidence(headroom() > 0);
    await privilegedLocalSql(`begin; ${receipts.map((row) => `
      delete from private.ai_usage where owner_id=${literal(row.ownerId)} and request_id=${literal(row.requestId)};
      delete from private.ai_save_used_receipts where owner_id=${literal(row.ownerId)} and request_id=${literal(row.requestId)}
        and item_id=${literal(row.itemId)} and image_id=${literal(row.imageId)};
      delete from private.item_save_used_ids where owner_id=${literal(row.ownerId)} and item_id=${literal(row.itemId)} and image_id=${literal(row.imageId)};`).join('\n')}
      ${restore} commit;`);
    await consentRevision(1);
    equal(await snapshot(), before); equal(await b2Snapshot(), b2Before);
    equal(await requireReady(client, owners), ready); await baseline(client, owners);
    requireEvidence(headroom() > 0);
    console.log(`PASS: AZ1 C ordinary-owner UI; generations=2; consent migration/restoration plus UI CAS=4 per owner; language initialization/restoration CAS=2 only for originally-null language; exact cleanup/restoration; elapsedMs=${Date.now() - cStarted}; remainingMs=${headroom()}`);
    stage = 'I10b-real-finalizer';
    owned = await startAnalysisServer();
    owned.assertRunning();
    const finalGenerationCount = generations;
    await imageReplacementServed(env);
    owned.assertRunning();
    equal(generations, finalGenerationCount);
    equal(await snapshot(), before); equal(await requireReady(client, owners), ready); await baseline(client, owners);
    requireEvidence(headroom() > 0);
    console.log('PASS: I10b actual Deno/Auth/DB/Storage replacement and new-identity recovery; incomplete-upload/caption conflicts, completed retries and no inference');
  } catch {
    console.error(`FAIL: AI rehearsal at ${stage}; private evidence withheld; fixture state preserved, no automatic recovery`);
    process.exitCode = 1;
  } finally {
    await owned?.stop();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
}
if (isMain(import.meta.url)) await main();
