// P6d: a genuine tag-history round trip on a freshly reset local CI stack. Account A gets server-recorded history the
// way the app records it (analyzed Save, then an analyzed photo replacement, both finalized by the served functions),
// export-own backs A up, restore-own adds it to B, B is backed up and restored into A. Both generations must carry
// every entry as imported, in order, with the same values and each photo mapped to the restored copy.
// Privileged SQL only seeds A's AI controls and stands in for the provider (claim and finish), as the other rehearsals
// do; everything else runs with normal sessions and the CLIs' own code. Output is fixed text only.
// The BG2b-2 phase that follows also opens the shared enhancement capacity for A and restores it and A's controls after.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ROOT, LOCAL_API, assertNoServiceSecrets, readCredentialCache, normalSessionEnvironment, localStatus,
  privilegedLocalSql, startAnalysisServer } from './backend/local.mjs';
import { isMain } from './quality/files.mjs';
import { registerSourceLoader } from './src-loader.mjs';

export const ROUNDTRIP_BOUND_MS = 420_000;
const PASSPHRASE = 'synthetic attribution round trip';
const MANIFEST = 'azure-eu-terra-devtest-v2';
const WIDTH = 128, HEIGHT = 96;
const ENHANCE_MANIFEST = 'azure-global-image25-sunburst-enhance-v1';
const ENHANCE_MODEL = 'gpt-image-2.5-sunburst';
const ENHANCE_KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
const ENHANCE_USAGE = Object.freeze({ modelObservation: 'not_observed', input: 1000, output: 4000, total: 5000, inputText: 100,
  inputImage: 900 });
const ENTRY_KEYS = ['fields', 'image_sha256', 'model_id', 'origin', 'prompt_version', 'source_image_id'];

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The restore fixtures import their helper without an extension, as Vite allows; map only that one import.
export function registerFixtureLoader() {
  const parent = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'restore-jpeg-fixtures.ts')).href;
  const target = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'jpeg-helpers.ts')).href;
  registerHooks({
    resolve(specifier, context, next) {
      return specifier === './jpeg-helpers' && context.parentURL === parent ? { url: target, shortCircuit: true } : next(specifier, context);
    },
  });
}

// The CLIs get only the publishable key and the OS variables a terminal would have; no service secret, no SUPABASE_URL.
export function cliEnvironment(source, key) {
  const env = { SUPABASE_PUBLISHABLE_KEY: key };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG',
    'PLAYWRIGHT_BROWSERS_PATH']) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

function sink() {
  const chunks = [];
  return { chunks, stream: { write: (text) => { chunks.push(String(text)); return true; } }, text: () => chunks.join('') };
}

// A terminal for restore-own: each prompt ending in ': ' gets the next answer; anything unexpected cancels.
export function terminal(answers) {
  const queue = [...answers];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const err = sink();
  const stderr = { write: (text) => {
    err.chunks.push(String(text));
    if (String(text).endsWith(': ')) setTimeout(() => input.write(`${queue.shift() ?? '\u0003'}\r`), 1);
    return true;
  } };
  return { stdin: input, stderr, text: err.text, left: () => queue.length };
}

// The history as a restore of it must look: imported, same order and values, each photo mapped.
export function expectedImported(entries, photos) {
  return entries.map((entry) => {
    if (entry.source_image_id !== null && !photos.has(entry.source_image_id)) throw new Error('UNMAPPED');
    return { ...entry, origin: 'imported', source_image_id: entry.source_image_id === null ? null : photos.get(entry.source_image_id) };
  });
}

// Which entry keys differ, and where a differing photo points: nothing but key names and fixed words.
// A fixed word for any failure: our own codes, the shared evidence marker, a transport code or an error class name.
export function failureCode(error) {
  if (typeof error?.code === 'string' && /^[a-z0-9+_-]{1,80}$/.test(error.code)) return error.code;
  if (error instanceof Error && error.message === 'EVIDENCE_REQUIRED') return 'evidence-required';
  const transport = error?.cause?.code;
  if (typeof transport === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(transport)) return `transport-${transport}`;
  if (error instanceof Error && ['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError']
    .includes(error.name)) return `error-${error.name}`;
  return 'other';
}

export function differing(actual, expected, copies) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return `length-${Array.isArray(actual) ? actual.length : 'none'}-${expected.length}`;
  const keys = new Set();
  let photo = '';
  actual.forEach((entry, index) => {
    for (const key of ENTRY_KEYS) if (!isDeepStrictEqual(entry?.[key], expected[index][key])) keys.add(key);
    if (!isDeepStrictEqual(entry?.source_image_id, expected[index].source_image_id)) {
      photo = entry?.source_image_id === null ? 'null' : copies.has(entry?.source_image_id) ? 'other-copy' : 'unknown';
    }
  });
  return [...keys].sort().join('+') + (photo ? `-${photo}` : '') || 'order';
}

async function main() {
  const started = performance.now();
  let stage = 'guards', server, parent;
  const watchdog = setTimeout(() => {
    console.error(`FAIL: P6d genuine round trip ${stage}; bound ${ROUNDTRIP_BOUND_MS / 1000}s exceeded`);
    process.exit(1);
  }, ROUNDTRIP_BOUND_MS);
  watchdog.unref();
  let step = 'start';
  // Failure codes are fixed words and schema key names, never values.
  const check = (condition, code = 'evidence') => { if (!condition) throw Object.assign(new Error('EVIDENCE'), { code }); };
  const equal = (a, b) => check(isDeepStrictEqual(a, b));
  try {
    check(process.argv.length === 2 && process.env.ALLOW_SECURITY_TESTS === '1' && process.env.ALLOW_CI_DATABASE_MUTATION === '1');
    assertNoServiceSecrets(process.env);
    registerSourceLoader();
    registerFixtureLoader();
    const { flatJpeg } = await import('../tests/fixtures/restore-jpeg-fixtures.ts');
    const { normalClient, requireEvidence } = await import('../tests/integration/preservation.sessions.mjs');
    const { analysisId, analysisFacts, analysisUsage } = await import('../tests/integration/ai-analysis.sessions.mjs');
    const { analyzedHarness, analyzedIntent } = await import('../tests/integration/analyzed-save.sessions.mjs');
    const { imageChangeHarness } = await import('../tests/integration/image-replacement.sessions.mjs');
    const { restoreId } = await import('../src/domain/restore-plan.ts');
    const { runExport } = await import('./export-own.mjs');
    const { runRestoreOwn } = await import('./restore-own.mjs');
    const { listParts, partSource, restoreReadiness } = await import('./verify-backup.mjs');
    const { verifyBackup } = await import('../src/domain/export-format.ts');
    const db = async (sql) => JSON.parse(await privilegedLocalSql(sql));

    stage = 'stack';
    const credentials = await readCredentialCache();
    const env = normalSessionEnvironment(process.env, credentials);
    await localStatus();
    check(env.SUPABASE_URL === LOCAL_API);
    const cli = cliEnvironment(process.env, env.SUPABASE_PUBLISHABLE_KEY);
    server = await startAnalysisServer();
    server.assertRunning();

    stage = 'clean-accounts';
    const client = normalClient(env);
    const a = await client.signIn('A'), b = await client.signIn('B');
    check(a.uid !== b.uid);
    for (const owner of [a, b]) {
      equal(await client.rows(owner, 'items'), []);
      equal(await client.rows(owner, 'item_images'), []);
    }
    requireEvidence((await db(`select to_jsonb(count(*)) from private.item_attribution_history;`)) === 0);

    stage = 'controls';
    await privilegedLocalSql(`insert into private.ai_controls(owner_id,activated,notice_revision,model_id,prompt_version,max_request_micro,
      monthly_allowance_micro,max_requests_per_hour,result_ttl_seconds,execution_manifest_id)
      values(${literal(a.uid)},true,2,'gpt-5.6-terra-2026-07-09',2,4097351,100000000,200,3600,${literal(MANIFEST)})
      on conflict (owner_id) do update set activated=true,notice_revision=2,model_id=excluded.model_id,
        prompt_version=excluded.prompt_version,max_request_micro=excluded.max_request_micro,
        monthly_allowance_micro=excluded.monthly_allowance_micro,max_requests_per_hour=excluded.max_requests_per_hour,
        result_ttl_seconds=excluded.result_ttl_seconds,execution_manifest_id=excluded.execution_manifest_id;`);
    const profile = (await client.rows(a, 'profiles'))[0];
    equal((await client.rpc(a, 'ai_set_consent', { p_enabled: true, p_notice_revision: 2, p_expected_version: profile.version }))?.code, 'OK');

    // One stored analysis result for a photo, as the provider stand-in.
    const analysed = async (n, bytes, fields) => {
      const id = analysisId('A', n);
      check((await db(`select public.ai_claim_analysis(${literal(a.uid)},${literal(id)},${literal(id)},1,
        ${literal(sha256(bytes))},${bytes.length},${WIDTH},${HEIGHT},${literal(MANIFEST)});`)).claimed === true);
      check((await db(`select public.ai_finish_analysis(${literal(a.uid)},${literal(id)},${literal(MANIFEST)},
        ${json({ ...analysisFacts, fields: { ...analysisFacts.fields, ...fields } })},${json(analysisUsage)},'SUCCESS');`)).stored === true);
      return id;
    };
    const photo = (colour) => flatJpeg({ width: WIDTH, height: HEIGHT, colour });
    const h = analyzedHarness(client, a, env), ich = imageChangeHarness(client, a, env);
    // The thumbnail of a photo this small is the same size, so the same decodable bytes serve both variants.
    const upload = async (paths, bytes) => {
      for (const route of paths) {
        check((await client.request(a.token, `/storage/v1/object/wardrobe/${route}`, {
          method: 'POST', body: bytes, binary: true, headers: { 'x-upsert': 'false', 'cache-control': '0' } })).ok);
      }
    };
    const analyzedSave = async (n, bytes, colours) => {
      const id = await analysed(n, bytes, { colours });
      const value = analyzedIntent(a, 20 + n);
      value.p_image = { ...value.p_image, main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: sha256(bytes),
        thumb_sha256: sha256(bytes), width: WIDTH, height: HEIGHT };
      value.p_item.colours = colours;
      value.p_claim = { ...value.p_claim, requestId: id, draftId: id, imageSha256: sha256(bytes),
        fields: { ...value.p_claim.fields, colours: { kind: 'ai_observed', value: colours } } };
      const row = await h.reserve(value);
      await upload(h.paths(value), bytes);
      await h.finalize(value, row);
      return { itemId: value.p_item.id, imageId: value.p_image.id };
    };
    const analyzedReplacement = async (n, saved, bytes) => {
      const id = await analysed(n, bytes, { pattern: 'solid' });
      const value = ich.make((await ich.read('items', saved.itemId))[0], (await ich.read('item_images', saved.imageId))[0]);
      value.image = { ...value.image, main_bytes: bytes.length, thumb_bytes: bytes.length, main_sha256: sha256(bytes),
        thumb_sha256: sha256(bytes), width: WIDTH, height: HEIGHT };
      value.item.pattern = 'solid'; value.item.field_provenance.pattern = { kind: 'ai_observed', revision: 1 };
      value.claim = { requestId: id, draftId: id, generation: 1, imageSha256: sha256(bytes),
        fields: { pattern: { kind: 'ai_observed', value: 'solid' } } };
      await ich.reserve(value);
      await upload(ich.paths(value), bytes);
      for (let attempt = 1; ; attempt++) {
        const result = await ich.endpoint(value);
        if (result.status === 204) break;
        equal(result, { status: 409, data: { code: 'CONFLICT' } });
        check(attempt < 10);
        await delay(50 * attempt);
      }
      return value.imageId;
    };
    const history = async (owner, itemId) => {
      const current = await client.rpc(owner, 'item_attribution_history_v2', { p_item_id: itemId });
      check(Array.isArray(current));
      for (const entry of current) equal(Object.keys(entry).sort(), ENTRY_KEYS);
      return current;
    };

    stage = 'recorded';
    const first = await analyzedSave(1, photo([90, 120, 140]), ['navy']);
    const replaced = await analyzedReplacement(2, first, photo([150, 100, 160]));
    const second = await analyzedSave(3, photo([200, 128, 128]), ['white']);
    const recorded = new Map();
    for (const saved of [first, second]) {
      const current = await history(a, saved.itemId);
      check(current.every((entry) => entry.origin === 'recorded'));
      const legacy = current.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'origin')));
      equal(legacy, await client.rpc(a, 'item_attribution_history', { p_item_id: saved.itemId }));
      recorded.set(saved.itemId, current);
    }
    equal(recorded.get(first.itemId).map((entry) => entry.source_image_id), [first.imageId, replaced]);
    equal(recorded.get(second.itemId).map((entry) => entry.source_image_id), [second.imageId]);
    const sourceImages = [first.imageId, replaced, second.imageId];

    parent = await mkdtemp(path.join(tmpdir(), 'stillroom-p6d-roundtrip-'));
    const exportOwn = async (label, owner) => {
      stage = `export-${label}`;
      const output = path.join(parent, `export-${label}`), out = sink(), err = sink();
      const code = await runExport({ argv: ['--output', output, '--local', LOCAL_API], env: cli,
        stdin: Readable.from([Buffer.from(`${env[`TEST_${owner.label}_EMAIL`]}\n${env[`TEST_${owner.label}_PASSWORD`]}\n${PASSPHRASE}\n`)]),
        stdout: out.stream, stderr: err.stream });
      const found = /Folder: stillroom-([0-9a-f-]{36})\n$/.exec(out.text());
      check(code === 0 && found !== null);
      return { exportId: found[1], folder: path.join(output, `stillroom-${found[1]}`) };
    };
    const restoreOwn = async (label, backup, owner) => {
      stage = `restore-${label}`;
      const tty = terminal([env[`TEST_${owner.label}_EMAIL`], env[`TEST_${owner.label}_PASSWORD`], PASSPHRASE, 'restore']);
      const out = sink();
      const code = await runRestoreOwn({ argv: [backup.folder, '--local', LOCAL_API, '--yes', '--allow-other-account', '--report', 'json'],
        env: cli, stdin: tty.stdin, stdout: out.stream, stderr: tty.stderr });
      const line = out.text().split('\n').find((text) => text.startsWith('{'));
      check(line !== undefined && tty.left() === 0);
      return { code, report: JSON.parse(line) };
    };
    // The target's copies: each source item and photo has exactly one restored ID, and every copy exists.
    const mappingOf = async (owner, backup, items, images) => {
      const ids = async (table, source) => new Map(await Promise.all(source.map(async (id) =>
        [id, await restoreId(3, owner.uid, backup.exportId, table, id)])));
      step = 'restore-ids';
      const itemMap = await ids('items', items), imageMap = await ids('item_images', images);
      // Read directly: restored IDs are deterministic version-8 UUIDs, which the shared row helper (version 4 only) refuses.
      const present = async (table) => {
        const response = await fetch(`${LOCAL_API}/rest/v1/${table}?select=id&owner_id=eq.${owner.uid}&limit=33`, {
          cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${owner.token}` } });
        check(response.status === 200, `status-${response.status >= 100 && response.status < 600 ? response.status : 'other'}`);
        const rows = await response.json();
        check(Array.isArray(rows) && rows.length <= 32 && rows.every((row) => typeof row?.id === 'string'), 'rows-shape');
        return new Set(rows.map((row) => row.id));
      };
      step = 'read-items';
      const storedItems = await present('items');
      step = 'read-images';
      const storedImages = await present('item_images');
      step = 'mapped-copies';
      check([...itemMap.values()].every((id) => storedItems.has(id)), 'items-missing');
      check([...imageMap.values()].every((id) => storedImages.has(id)),
        `images-missing-${[...imageMap.values()].filter((id) => !storedImages.has(id)).length}-of-${imageMap.size}`);
      return { itemMap, imageMap };
    };
    const generation = async (label, from, to, items, images, expected) => {
      const backup = await exportOwn(label, from);
      const { code, report } = await restoreOwn(label, backup, to);
      step = 'report';
      check(code === 0, `exit-${Number.isInteger(code) ? code : 'other'}`);
      check(report.counts.restored === items.length && report.counts.attributions === items.length && report.counts.attributionsKept === 0
        && report.counts.failed === 0 && report.counts.blocked === 0 && report.counts.deferred === 0, 'report-counts');
      check(report.photos.length === images.length && report.photos.every((entry) => ['written', 'present'].includes(entry.outcome)),
        `report-photos-${report.photos.length}-of-${images.length}`);
      stage = `compare-${label}`;
      const { itemMap, imageMap } = await mappingOf(to, backup, items, images);
      const next = new Map();
      for (const [source, entries] of expected) {
        const target = itemMap.get(source);
        step = 'imported-history';
        const current = await history(to, target);
        const wanted = expectedImported(entries, imageMap);
        check(isDeepStrictEqual(current, wanted), `entries-${differing(current, wanted, new Set(imageMap.values()))}`);
        step = 'legacy-history';
        // The legacy projection keeps returning only server-recorded attribution.
        check(isDeepStrictEqual(await client.rpc(to, 'item_attribution_history', { p_item_id: target }), []), 'legacy-not-empty');
        next.set(target, current);
      }
      stage = `rerun-${label}`;
      const again = await restoreOwn(`${label}-again`, backup, to);
      step = 'rerun-report';
      check(again.code === 0, `exit-${Number.isInteger(again.code) ? again.code : 'other'}`);
      // An earlier run of the same backup counts as restored; nothing is kept and nothing changes.
      check(again.report.counts.attributions === items.length && again.report.counts.attributionsKept === 0
        && again.report.counts.restored === 0 && again.report.counts.same === items.length, 'rerun-counts');
      step = 'rerun-history';
      for (const [target, entries] of next) equal(await history(to, target), entries);
      return { next, itemMap, imageMap };
    };

    const one = await generation('A-to-B', a, b, [first.itemId, second.itemId], sourceImages, recorded);
    const two = await generation('B-to-A', b, a, [...one.itemMap.values()], [...one.imageMap.values()], one.next);
    stage = 'source-unchanged';
    for (const [itemId, entries] of recorded) equal(await history(a, itemId), entries);
    // Through both generations each entry keeps its values and points at A's second copy of its original photo.
    const through = new Map(sourceImages.map((id) => [id, two.imageMap.get(one.imageMap.get(id))]));
    for (const [source, entries] of recorded) {
      equal(await history(a, two.itemMap.get(one.itemMap.get(source))), expectedImported(entries, through));
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`PASS: P6d genuine round trip; recorded history (analyzed Save + analyzed replacement) -> export-own -> restore-own into B -> re-export -> restore into A; items=2 entries=3 photos=3 generations=2 reruns=2; all imported, order/values/photo mappings equal; ${seconds}s`);

    // BG2b-2 v4 round trip: a recorded AI-edited photo leaves A through the real client export, passes the offline
    // verifier, and arrives in B through the shared restore engine as imported provenance with the same bytes. An edited
    // photo in Trash keeps the export at version 3 with no provenance key. The enhancement ledger rows are written through
    // the service functions the Edge handler calls (no provider); every Save, export, restore and read is a normal session.
    stage = 'bg2b-v4-setup';
    const capacityRow = `select to_jsonb(k) from private.provider_capacity k where deployment_key=${literal(ENHANCE_KEY)};`;
    const controlsRow = `select to_jsonb(c) from private.ai_controls c where owner_id=${literal(a.uid)};`;
    const savedCapacity = await db(capacityRow), savedControls = await db(controlsRow);
    const enhancementIds = [];
    let primary = null, failedStage = stage;
    try {
      check(savedCapacity.dispatch_enabled === false && savedControls.enhance_activated === false, 'enhance-initial');
      equal(await client.rpc(a, 'image_provenance_v1', {}), []);
      equal(await client.rpc(b, 'image_provenance_v1', {}), []);
      await privilegedLocalSql(`update private.ai_controls set enhance_activated=true,enhance_notice_revision=1,
        enhance_manifest_id=${literal(ENHANCE_MANIFEST)},enhance_max_request_micro=300000,enhance_monthly_allowance_micro=50000000,
        enhance_max_requests_per_hour=1000,updated_at=clock_timestamp() where owner_id=${literal(a.uid)};
        update private.provider_capacity set max_dispatch=100,dispatch_enabled=true,disabled_reason=null,disabled_at=null
          where deployment_key=${literal(ENHANCE_KEY)};`);
      check((await client.rpc(a, 'enhance_set_consent', { p_enabled: true, p_notice_revision: 1 }))?.code === 'OK', 'enhance-consent');
      // Released H2 evidence for these exact bytes, as enhance_finish records it after the provider double answers.
      const enhancedPhoto = async (colour) => {
        const bytes = photo(colour), id = randomUUID();
        enhancementIds.push(id);
        check((await db(`select public.enhance_claim(${literal(a.uid)},${literal(id)},${literal(ENHANCE_MANIFEST)},
          ${literal(sha256(Buffer.from(id)))},null::uuid);`)).claimed === true, 'enhance-claim');
        const done = await db(`select public.enhance_finish(${literal(a.uid)},${literal(id)},'OK',${json(ENHANCE_USAGE)},
          ${literal(sha256(bytes))},${bytes.length});`);
        check(done.code === 'OK', 'enhance-finish');
        return bytes;
      };
      const provenanceOf = async (owner) => {
        const rows = await client.rpc(owner, 'image_provenance_v1', {});
        check(Array.isArray(rows), 'provenance-read');
        return rows;
      };
      const recordedRow = (imageId, bytes) => ({ image_id: imageId, kind: 'ai_edited', origin: 'recorded', model_id: ENHANCE_MODEL,
        manifest_id: ENHANCE_MANIFEST, stored_sha256: sha256(bytes), backup_sha256: null });
      const verified = async (backup) => {
        step = 'verify-backup';
        const { metadata } = await verifyBackup(partSource(await listParts(backup.folder)), PASSPHRASE, restoreReadiness().check);
        check(metadata.export_id === backup.exportId, 'verify-export-id');
        return metadata;
      };

      stage = 'bg2b-v3-trash';
      const trashedBytes = await enhancedPhoto([60, 160, 90]);
      const trashed = await analyzedSave(4, trashedBytes, ['green']);
      equal(await provenanceOf(a), [recordedRow(trashed.imageId, trashedBytes)]);
      const itemRow = await client.request(a.token, `/rest/v1/items?id=eq.${trashed.itemId}&select=version`);
      check(itemRow.ok && itemRow.data?.length === 1, 'trash-read');
      const trashResult = await client.request(a.token, '/rest/v1/rpc/set_item_trashed', { method: 'POST',
        body: { p_item_id: trashed.itemId, p_expected_version: itemRow.data[0].version, p_trashed: true } });
      check(trashResult.ok, 'trash');
      const v3 = await verified(await exportOwn('bg2b-v3-trash', a));
      check(v3.schema_version === 3 && !Object.hasOwn(v3, 'provenance'), 'v3-shape');
      check(!v3.tables.items.some((item) => item.id === trashed.itemId)
        && !v3.tables.item_images.some((image) => image.id === trashed.imageId), 'v3-trash-excluded');

      stage = 'bg2b-v4-export';
      const editedBytes = await enhancedPhoto([210, 180, 60]);
      const edited = await analyzedSave(5, editedBytes, ['yellow']);
      const sourceProvenance = await provenanceOf(a);
      equal(sourceProvenance, [recordedRow(trashed.imageId, trashedBytes), recordedRow(edited.imageId, editedBytes)]
        .sort((x, y) => (x.image_id < y.image_id ? -1 : 1)));
      const sourceRow = await client.request(a.token, `/rest/v1/item_images?id=eq.${edited.imageId}&select=state,main_path,main_sha256`);
      check(sourceRow.ok && sourceRow.data?.length === 1 && sourceRow.data[0].state === 'ready'
        && sourceRow.data[0].main_sha256 === sha256(editedBytes), 'source-row');
      const sourcePath = `/storage/v1/object/authenticated/wardrobe/${sourceRow.data[0].main_path}`;
      const sourceMain = await client.request(a.token, sourcePath);
      check(sourceMain.ok && Buffer.isBuffer(sourceMain.data) && sha256(sourceMain.data) === sha256(editedBytes), 'source-bytes');
      const backup = await exportOwn('bg2b-v4', a);
      const v4 = await verified(backup);
      check(v4.schema_version === 4, 'v4-version');
      equal(v4.provenance, [{ imageId: edited.imageId, kind: 'ai_edited', modelId: ENHANCE_MODEL, manifestId: ENHANCE_MANIFEST,
        backupSha256: sha256(editedBytes) }]);
      check(v4.tables.item_images.some((image) => image.id === edited.imageId && image.main_sha256 === sha256(editedBytes)), 'v4-image');

      const restoreChecked = async (label) => {
        const { code, report } = await restoreOwn(label, backup, b);
        step = 'report';
        check(code === 0, `exit-${Number.isInteger(code) ? code : 'other'}`);
        check(report.counts.failed === 0 && report.counts.blocked === 0 && report.counts.deferred === 0
          && report.counts.unlabelledEnhanced === 0, 'v4-report-counts');
        return report;
      };
      stage = 'bg2b-v4-restore';
      await restoreChecked('bg2b-v4-A-to-B');
      const targetImage = await restoreId(4, b.uid, backup.exportId, 'item_images', edited.imageId);
      const targetItem = await restoreId(4, b.uid, backup.exportId, 'items', edited.itemId);
      const imported = [{ image_id: targetImage, kind: 'ai_edited', origin: 'imported', model_id: ENHANCE_MODEL,
        manifest_id: ENHANCE_MANIFEST, stored_sha256: sha256(editedBytes), backup_sha256: sha256(editedBytes) }];
      step = 'imported-provenance';
      equal(await provenanceOf(b), imported);
      step = 'restored-bytes';
      const restoredRow = await client.request(b.token, `/rest/v1/item_images?id=eq.${targetImage}&select=item_id,state,main_path,main_sha256`);
      check(restoredRow.ok && restoredRow.data?.length === 1 && restoredRow.data[0].item_id === targetItem
        && restoredRow.data[0].state === 'ready' && restoredRow.data[0].main_sha256 === sha256(editedBytes), 'restored-row');
      const restoredMain = await client.request(b.token, `/storage/v1/object/authenticated/wardrobe/${restoredRow.data[0].main_path}`);
      check(restoredMain.ok && Buffer.isBuffer(restoredMain.data) && Buffer.compare(restoredMain.data, editedBytes) === 0, 'restored-bytes');

      stage = 'bg2b-v4-replay';
      const again = await restoreChecked('bg2b-v4-A-to-B-again');
      check(again.counts.restored === 0, 'replay-restored');
      equal(await provenanceOf(b), imported);

      stage = 'bg2b-v4-source-unchanged';
      equal(await provenanceOf(a), sourceProvenance);
      const sourceAfter = await client.request(a.token, sourcePath);
      check(sourceAfter.ok && Buffer.compare(sourceAfter.data, sourceMain.data) === 0, 'source-bytes-after');
      check(!(await provenanceOf(a)).some((row) => row.image_id === targetImage), 'no-cross-owner-row');
    } catch (error) {
      primary = error;
    } finally {
      // Leave the ledger and switches exactly as the later Edge gate expects: this phase's enhancement usage moves out of
      // the current hour, its slots end, and A's controls and the shared capacity row return to their snapshots.
      failedStage = stage;
      stage = primary ? `${failedStage}+bg2b-v4-restore-state` : 'bg2b-v4-restore-state';
      const ids = enhancementIds.map(literal).join(',') || 'null';
      const columns = Object.keys(savedControls ?? {}).filter((c) => c !== 'owner_id');
      check(columns.length > 0 && columns.every((c) => /^[a-z_0-9]+$/.test(c)), 'controls-columns');
      await privilegedLocalSql(`begin;
        update private.provider_slots s set held_until=clock_timestamp()-interval '1 second' from private.ai_usage u
          where u.owner_id=${literal(a.uid)} and u.request_id in (${ids}) and s.slot_id=u.provider_slot_id;
        update private.ai_usage set created_at=created_at-interval '2 hours',dispatched_at=dispatched_at-interval '2 hours',
          closed_at=closed_at-interval '2 hours' where owner_id=${literal(a.uid)} and request_id in (${ids});
        update private.provider_capacity k set window_seconds=v.window_seconds,max_dispatch=v.max_dispatch,
          dispatch_enabled=v.dispatch_enabled,disabled_reason=v.disabled_reason,disabled_at=v.disabled_at,updated_at=v.updated_at
          from jsonb_populate_record(null::private.provider_capacity,${json(savedCapacity)}) v where k.deployment_key=v.deployment_key;
        update private.ai_controls c set ${columns.map((c) => `${c}=v.${c}`).join(',')}
          from jsonb_populate_record(null::private.ai_controls,${json(savedControls)}) v where c.owner_id=v.owner_id;
        commit;`);
      equal(await db(capacityRow), savedCapacity);
      equal(await db(controlsRow), savedControls);
    }
    // A restored state never hides the phase's own failure.
    if (primary) { stage = failedStage; throw primary; }
    console.log(`PASS: BG2b v4 round trip; recorded AI-edited photo -> export-own v4 (edited photo in Trash -> v3, no provenance key) -> offline verify -> restore-own into B -> rerun; imported provenance and bytes equal, replay unchanged, A unchanged; ${((performance.now() - started) / 1000).toFixed(1)}s`);
    return 0;
  } catch (error) {
    const code = failureCode(error);
    console.error(`FAIL: P6d genuine round trip ${stage}; step=${step}; cause=${code}; ${((performance.now() - started) / 1000).toFixed(1)}s`);
    return 1;
  } finally {
    clearTimeout(watchdog);
    await server?.stop().catch(() => {});
    if (parent) await rm(parent, { recursive: true, force: true }).catch(() => {});
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
