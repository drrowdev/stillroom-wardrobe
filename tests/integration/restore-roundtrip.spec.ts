// I26 restore drill against the local Supabase stack, with normal owner sessions only. Owner B's fictional wardrobe is
// backed up through the app's own export code (src/data/export.ts); owner A then checks and restores that SAME backup
// twice in the real app, the first run interrupted and continued. Three hash sources are kept apart: the backup's
// manifest and files (source), the Q6 plan in the app's restore report (expected), and the files downloaded from Storage
// as A (actual). The page's transport is a tripwire: no analysis or provider endpoint may be called. B stays unchanged.
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import type { OwnerScope } from '../../src/auth/session';
import type { AppClient } from '../../src/data/client';
import type { Database, Json } from '../../src/data/database.types';
import { buildPart, prepareExport } from '../../src/data/export';
import { saveItemFields } from '../../src/data/item-details';
import { ItemLifecycleClient } from '../../src/data/item-lifecycle';
import type { RestoreResult } from '../../src/data/restore';
import { parseFieldProvenance, type FieldProvenance } from '../../src/domain/attribute-provenance';
import { canonical, decryptPart, partFileName, type ExportPart } from '../../src/domain/export-format';
import { buildGarmentWrite, editGarmentField, garmentPayload, newGarmentDraft, parseGarmentValues, type GarmentDraft } from '../../src/domain/garment-fields';
import { itemDetailColumns, parseItemBaseline } from '../../src/domain/item-details';
import { deletionIntent } from '../../src/domain/item-lifecycle';
import { restoreId } from '../../src/domain/restore-plan';
import { translate, type MessageKey } from '../../src/i18n';
import { fitDimensions, JPEG_LIMITS } from '../../src/images/jpeg';
import { ImageChangeClient } from '../../src/images/replace';
import { newSaveAttempt, saveItem, type SaveAttempt } from '../../src/images/upload';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';

type Row = Record<string, unknown>;
type Owner = { client: AppClient; scope: OwnerScope };
type Snapshot = { tables: Record<string, Row[]>; objects: Record<string, string> };

const ROOT_URL = 'http://127.0.0.1:5173/';
const PASSPHRASE = 'fictional drill passphrase 26';
const TABLES = ['profiles', 'style_preferences', 'items', 'item_images', 'outfits', 'outfit_items', 'wear_events', 'wear_event_items',
  'combination_rules', 'suggestion_feedback'] as const;
const slow = { timeout: 120_000 };
const failure = new Error('Local restore drill failed.');
function check(value: unknown): asserts value { if (!value) throw failure; }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (key: MessageKey, parameters?: Record<string, string | number>) => translate('en', key, parameters);
const button = (page: Page, key: MessageKey) => page.getByRole('button', { name: text(key), exact: true });
const byCanonical = (a: unknown, b: unknown) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
const empty = (value: unknown) => value === null || value === '' || Array.isArray(value) && value.length === 0;
// Names only the tables and object counts that differ (all drill data is fictional), so a failure says where it is.
function differences(actual: Snapshot, expected: Snapshot): string[] {
  const out = TABLES.filter(table => canonical(actual.tables[table]) !== canonical(expected.tables[table]))
    .map(table => `${table} (${actual.tables[table]?.length ?? 0} vs ${expected.tables[table]?.length ?? 0} rows)`);
  if (canonical(actual.objects) !== canonical(expected.objects)) {
    out.push(`storage (${Object.keys(actual.objects).length} vs ${Object.keys(expected.objects).length} objects)`);
  }
  return out;
}
function unchanged(label: string, actual: Snapshot, expected: Snapshot) {
  const changed = differences(actual, expected);
  if (changed.length) throw new Error(`${label} changed: ${changed.join(', ')}.`);
}
// The only change signing in may make: the app's first-language save (saveInitialLanguage), which sets a null
// ui_language and so bumps version and updated_at. Every other table, every other profile field and Storage must match.
function languageInitializationOnly(label: string, actual: Snapshot, expected: Snapshot) {
  const changed = differences(actual, expected).filter(entry => !entry.startsWith('profiles '));
  if (changed.length) throw new Error(`${label} changed: ${changed.join(', ')}.`);
  const before = expected.tables.profiles ?? [], after = actual.tables.profiles ?? [];
  if (before.length !== 1 || after.length !== 1) throw new Error(`${label}: expected one profile row.`);
  const [was, now] = [before[0]!, after[0]!];
  const fields = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(field => canonical(was[field]) !== canonical(now[field]));
  if (!fields.length) return;
  const initialized = fields.every(field => ['ui_language', 'version', 'updated_at'].includes(field)) && was.ui_language === null
    && ['en', 'fi', 'sv'].includes(String(now.ui_language)) && now.version === Number(was.version) + 1;
  if (!initialized) throw new Error(`${label}: profile changed beyond the first-language save (${fields.join(', ')}).`);
}
// Status and preflight RPCs that only read. ai_status and ai_analysis_status are deliberately absent: both can expire
// and close old AI requests (private.ai_close).
const READ_ONLY_RPCS = new Set(['analyzed_item_save_preflight', 'deletion_status', 'image_change_preflight',
  'image_change_requests', 'image_change_status', 'image_recovery_preflight', 'image_recovery_versions', 'item_attribution_history',
  'item_deletion_operation_status', 'item_deletion_operations', 'item_deletion_status', 'restore_image_change_status',
  'restore_item_save_status']);

// Every row of the ten owner tables (paged until exhausted) and every stored object with its SHA-256, read as the owner.
async function snapshot({ client, scope }: Owner): Promise<Snapshot> {
  type Page = PromiseLike<{ data: Row[] | null; error: unknown }>;
  const from = (table: string) => (client as unknown as {
    from(name: string): { select(columns: string): { eq(column: string, value: string): { range(start: number, end: number): Page } } };
  }).from(table);
  const tables: Record<string, Row[]> = {};
  for (const table of TABLES) {
    const rows: Row[] = [];
    for (let start = 0; ; start += 1000) {
      const result = await from(table).select('*').eq('owner_id', scope.ownerId).range(start, start + 999);
      check(!result.error && Array.isArray(result.data));
      rows.push(...result.data);
      if (result.data.length < 1000) break;
    }
    tables[table] = rows.sort(byCanonical);
  }
  const objects: Record<string, string> = {};
  const queue = [scope.ownerId];
  while (queue.length) {
    const prefix = queue.shift()!;
    for (let offset = 0; ; offset += 1000) {
      const listed = await client.storage.from('wardrobe').list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
      check(!listed.error && Array.isArray(listed.data));
      for (const entry of listed.data) {
        const path = `${prefix}/${entry.name}`;
        if (!entry.id) { queue.push(path); continue; }
        const file = await client.storage.from('wardrobe').download(path, {}, { cache: 'no-store' });
        check(!file.error && file.data);
        objects[path] = sha(new Uint8Array(await file.data.arrayBuffer()));
      }
      if (listed.data.length < 1000) break;
    }
  }
  return { tables, objects };
}
const rowsOf = (value: Snapshot, table: typeof TABLES[number]) => value.tables[table]!;

test('I26 restore drill: the same backup restored twice into A, hashes checked three ways, B unchanged, no analysis', async ({ page }) => {
  test.setTimeout(600_000);
  validateSessionEnvironment(process.env);
  const base = assertLocalApi(process.env.SUPABASE_URL!), key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  const clients: AppClient[] = [];
  const output = await mkdtemp(join(tmpdir(), 'restore-drill-'));
  const cleanupFailures: string[] = [];
  const created = { b: { items: [] as string[], outfits: [] as string[], events: [] as string[], feedback: [] as string[] },
    a: { items: [] as string[], outfits: [] as string[], events: [] as string[] } };
  let stage = 'sign-in';
  let a: Owner | undefined, b: Owner | undefined;
  const signIn = async (label: 'A' | 'B'): Promise<Owner> => {
    const client = createClient<Database>(base, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `restore-drill-${randomUUID()}`, debug: false },
    }) as AppClient;
    clients.push(client);
    const login = await client.auth.signInWithPassword({ email: process.env[`TEST_${label}_EMAIL`]!, password: process.env[`TEST_${label}_PASSWORD`]! });
    check(!login.error && login.data.user);
    return { client, scope: { ownerId: login.data.user.id, epoch: 1, signal: new AbortController().signal } };
  };
  // Every function call from the page is recorded; analysis and the analysed-item finalizer are refused and counted.
  const requests: { method: string; url: string }[] = [];
  const refusedFunctions: string[] = [];
  page.on('request', request => { requests.push({ method: request.method(), url: request.url() }); });
  await page.route('**/functions/v1/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/')[3] ?? '';
    if (name !== 'finalize-image-change') { refusedFunctions.push(name); await route.abort('blockedbyclient'); return; }
    await route.fallback();
  });
  const functionCalls = (from: number) => requests.slice(from).filter(({ url }) => new URL(url).pathname.startsWith('/functions/v1/'));
  const storageWrites = (from: number) => requests.slice(from).filter(({ method, url }) =>
    method !== 'GET' && method !== 'HEAD' && new URL(url).pathname.startsWith('/storage/v1/object/'));
  const reservations = (from: number) => requests.slice(from).filter(({ url }) => /\/rest\/v1\/rpc\/reserve_/.test(new URL(url).pathname));
  // ai_status expires and closes the owner's old AI requests (private state the snapshots can't see). The app's Settings
  // initialization may call it; it must finish before the restore baseline, and any later call is refused and fails.
  const isAiStatus = (request: import('@playwright/test').Request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/rest/v1/rpc/ai_status';
  const aiInFlight = new Set<import('@playwright/test').Request>();
  // lateAiStatus counts refusals by the route; postLockAiStatus independently counts every post-lock POST seen by the
  // request listener, whatever its query string. Both must equal the drill's own refused probes.
  let aiFinished = 0, aiLocked = false, lateAiStatus = 0, postLockAiStatus = 0, aiProbes = 0;
  page.on('request', request => {
    if (!isAiStatus(request)) return;
    if (aiLocked) postLockAiStatus++; else aiInFlight.add(request);
  });
  const settle = (request: import('@playwright/test').Request) => { if (aiInFlight.delete(request)) aiFinished++; };
  page.on('requestfinished', settle); page.on('requestfailed', settle);
  // A URL predicate on the exact pathname: a glob would miss `/rest/v1/rpc/ai_status?…`.
  await page.route(url => url.pathname === '/rest/v1/rpc/ai_status', async route => {
    if (aiLocked && route.request().method() === 'POST') { lateAiStatus++; await route.abort('blockedbyclient'); return; }
    await route.fallback();
  });
  let aInitial: Snapshot | undefined, bInitial: Snapshot | undefined;

  try {
    a = await signIn('A'); b = await signIn('B');
    check(a.scope.ownerId !== b.scope.ownerId);
    const owner = b;
    // Inventories before any drill data exists; cleanup must return both owners to these.
    aInitial = await snapshot(a); bInitial = await snapshot(b);

    // ---- B's fictional wardrobe. ----
    stage = 'fixtures';
    const photo = (width: number, height: number, colour: number[], mode?: 'progressive') => {
      const main = flatJpeg({ width, height, colour, ...mode ? { mode } : {} });
      const thumb = flatJpeg({ ...fitDimensions(width, height, JPEG_LIMITS.thumbSide), colour });
      return { main: new Blob([main], { type: 'image/jpeg' }), thumb: new Blob([thumb], { type: 'image/jpeg' }),
        mainSha256: sha(main), thumbSha256: sha(thumb), width, height };
    };
    const draft = (title: string, category: string, edits: [keyof GarmentDraft['raw'], string | string[]][] = []) => {
      let value = editGarmentField(editGarmentField(newGarmentDraft('EUR', 'en'), 'title', title, 'en'), 'category', category, 'en');
      for (const [field, entry] of edits) value = editGarmentField(value, field, entry as never, 'en');
      return value;
    };
    const readItem = async (id: string) => {
      const found = await owner.client.from('items').select(itemDetailColumns).eq('owner_id', owner.scope.ownerId).eq('id', id).single();
      check(!found.error && found.data);
      return found.data as unknown as Row;
    };
    // P: saved with AI kinds through the checked restored-item reservation (user, ai_observed, ai_estimated, unknown), photo 0
    // a baseline JPEG the restore keeps byte for byte, then replaced by a progressive JPEG the restore re-encodes.
    const pDraft = draft('Fictional wool coat', 'outerwear', [['colours', ['grey']], ['material', 'Wool blend'], ['brand', 'Fictional Mill']]);
    const pWrite = buildGarmentWrite(pDraft);
    const pKinds: FieldProvenance = { title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 },
      colours: { kind: 'ai_observed', revision: 1 }, material: { kind: 'ai_estimated', revision: 1 }, brand: { kind: 'unknown', revision: 1 } };
    const pBase = newSaveAttempt(pDraft, 'A grey wool coat, front', photo(1200, 900, [200, 110, 150]), owner.scope);
    const pAttempt: SaveAttempt = { ...pBase, values: pWrite.values, payload: { ...garmentPayload(pWrite.values), field_provenance: pKinds } };
    created.b.items.push(pAttempt.itemId);
    await saveItem(owner.client, owner.scope, pAttempt, () => undefined, 'reserve_restored_item_save');
    const pFirst = await owner.client.from('item_images').select('id,description_version').eq('owner_id', owner.scope.ownerId)
      .eq('item_id', pAttempt.itemId).single();
    check(!pFirst.error && pFirst.data);
    const replacement = photo(640, 480, [90, 140, 100], 'progressive');
    const pRow = await readItem(pAttempt.itemId);
    const imageId = randomUUID();
    const receipt = await new ImageChangeClient(owner.client, owner.scope).save({ ownerId: owner.scope.ownerId, epoch: owner.scope.epoch, photo: replacement,
      intent: { requestId: randomUUID(), itemId: pAttempt.itemId, imageId, expectedVersion: 1, currentImageId: pFirst.data.id,
        descriptionVersion: pFirst.data.description_version,
        item: { ...garmentPayload(parseGarmentValues(pRow)), field_provenance: pRow.field_provenance as Json } as Record<string, Json>,
        image: { id: imageId, main_bytes: replacement.main.size, thumb_bytes: replacement.thumb.size, main_sha256: replacement.mainSha256,
          thumb_sha256: replacement.thumbSha256, width: 640, height: 480, alt_text: 'A grey wool coat, back' },
        claim: null, sourceImageId: null } }, () => undefined, () => undefined);
    check(receipt.state === 'completed');
    // C: an ordinary Save with brand (text), pattern (enum) and seasons (array) filled in, then all three cleared by an edit.
    const cDraft = draft('Fictional striped shirt', 'top', [['brand', 'Fictional Weaver'], ['pattern', 'striped'], ['seasons', ['spring', 'summer']]]);
    const cAttempt = newSaveAttempt(cDraft, 'A striped shirt', photo(900, 1200, [150, 100, 160]), owner.scope);
    created.b.items.push(cAttempt.itemId);
    await saveItem(owner.client, owner.scope, cAttempt, () => undefined);
    const cBefore = await readItem(cAttempt.itemId);
    check(cBefore.brand === 'Fictional Weaver' && cBefore.pattern === 'striped' && canonical(cBefore.seasons) === canonical(['spring', 'summer']));
    const cBaseline = parseItemBaseline(cBefore, owner.scope.ownerId, cAttempt.itemId);
    let cEdit = newGarmentDraft('EUR', 'en', cBaseline.values);
    cEdit = editGarmentField(editGarmentField(editGarmentField(cEdit, 'brand', '', 'en'), 'pattern', '', 'en'), 'seasons', [], 'en');
    const cWrite = buildGarmentWrite(cEdit, cBaseline.values, cBaseline.provenance);
    await saveItemFields(owner.client, owner.scope, { epoch: owner.scope.epoch, baseline: cBaseline, fields: cWrite.values, patch: cWrite.patch });
    // T: saved, then moved to Trash. A backup leaves it out.
    const tAttempt = newSaveAttempt(draft('Fictional trashed scarf', 'accessory'), 'A scarf', photo(64, 48, [120, 128, 128]), owner.scope);
    created.b.items.push(tAttempt.itemId);
    await saveItem(owner.client, owner.scope, tAttempt, () => undefined);
    const lifecycleB = new ItemLifecycleClient(owner.client, { url: base, publishableKey: key, version: 'local-restore-drill' }, owner.scope);
    await lifecycleB.change(tAttempt.itemId, true, (await lifecycleB.statusOf(tAttempt.itemId)).version, () => undefined);
    // Outfit [C, P], a worn day with that outfit, a pairing rule and a vote.
    const outfitId = randomUUID(), eventId = randomUUID();
    created.b.outfits.push(outfitId);
    const outfit = await owner.client.rpc('save_outfit', { p_id: outfitId, p_title: 'Fictional office outfit', p_occasion: 'Work', p_notes: 'Drill',
      p_favourite: true, p_item_ids: [cAttempt.itemId, pAttempt.itemId] });
    check(!outfit.error);
    created.b.events.push(eventId);
    const worn = await owner.client.rpc('save_wear_event', { p_id: eventId, p_local_date: '2026-09-20', p_timezone: 'Europe/Helsinki', p_state: 'worn',
      p_label: 'Daily outfit', p_outfit_id: outfitId, p_item_ids: [pAttempt.itemId, cAttempt.itemId] });
    check(!worn.error);
    const [low, high] = [pAttempt.itemId, cAttempt.itemId].sort() as [string, string];
    const rule = await owner.client.from('combination_rules').insert({ owner_id: owner.scope.ownerId, item_low: low, item_high: high });
    check(!rule.error);
    const vote = await owner.client.from('suggestion_feedback').insert({ owner_id: owner.scope.ownerId, item_ids: [low, high], vote: 1 }).select('id').single();
    check(!vote.error && vote.data);
    created.b.feedback.push(vote.data.id);

    // ---- The backup, through the app's export code, written to disposable drill files. ----
    stage = 'backup';
    const prepared = await prepareExport(owner.client, owner.scope, new AbortController().signal);
    const exportId = prepared.exportId;
    const parts: string[] = [], files: string[] = [];
    for (let index = 0; index < prepared.partCount; index++) {
      const blob = await buildPart(owner.client, owner.scope, prepared, index, PASSPHRASE, new AbortController().signal);
      const file = join(output, partFileName(exportId, index));
      await writeFile(file, await blob.text(), 'utf8');
      files.push(file);
      parts.push(await readFile(file, 'utf8'));
    }
    const decrypted: ExportPart[] = [];
    for (const part of parts) decrypted.push(await decryptPart(part, PASSPHRASE));
    const manifest = decrypted[0]!.manifest!;
    check(manifest.owner_id === owner.scope.ownerId && manifest.export_id === exportId);
    const sourceItems = manifest.tables.items, sourceImages = manifest.tables.item_images;
    check(sourceItems.map(item => item.id).sort().join() === [pAttempt.itemId, cAttempt.itemId].sort().join());
    check(sourceImages.length === 3);
    // Source hashes: the manifest's recorded hashes, and the hashes of the file bytes the backup actually carries.
    const carried = new Map(decrypted.flatMap(part => part.files).map(entry => [`${entry.imageId}/${entry.variant}`, sha(Buffer.from(entry.base64, 'base64'))]));
    for (const image of sourceImages) {
      check(carried.get(`${String(image.id)}/main`) === image.main_sha256 && carried.get(`${String(image.id)}/thumb`) === image.thumb_sha256);
    }
    const sourceP = sourceItems.find(item => item.id === pAttempt.itemId)!, sourceC = sourceItems.find(item => item.id === cAttempt.itemId)!;
    check(empty(sourceC.brand) && sourceC.pattern === null && canonical(sourceC.seasons) === '[]');
    const pImages = sourceImages.filter(image => image.item_id === pAttempt.itemId);
    const pOld = pImages.find(image => image.state === 'retired')!, pNew = pImages.find(image => image.state === 'ready')!;
    check(pOld && pNew && pNew.main_sha256 === replacement.mainSha256);
    const cImage = sourceImages.find(image => image.item_id === cAttempt.itemId)!;

    const bBefore = await snapshot(owner);
    let aBefore = await snapshot(a);
    const map = (table: string, id: unknown) => restoreId(2, a!.scope.ownerId, exportId, table, String(id));
    const [pId, cId] = [await map('items', pAttempt.itemId), await map('items', cAttempt.itemId)];
    created.a.items.push(pId, cId);
    const aOutfitId = await map('outfits', outfitId), aEventId = await map('wear_events', eventId);
    created.a.outfits.push(aOutfitId); created.a.events.push(aEventId);
    for (const id of [pId, cId, aOutfitId, aEventId]) check(!JSON.stringify(aBefore.tables).includes(id));

    // ---- A signs in to the app and checks the backup. Nothing is written by Check. ----
    stage = 'check';
    const signInFrom = requests.length;
    await page.goto(ROOT_URL);
    await page.locator('#email').fill(process.env.TEST_A_EMAIL!);
    await page.locator('#password').fill(process.env.TEST_A_PASSWORD!);
    await page.locator('button[type=submit]').click();
    await expect(page.locator('#wardrobe-title')).toBeVisible(slow);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#settings-title')).toBeVisible();
    // Settings initialization: let its ai_status call(s) finish and the network stay quiet, then lock ai_status.
    await expect.poll(() => aiFinished > 0 && aiInFlight.size === 0, slow).toBe(true);
    await expect.poll(async () => { const seen = aiFinished; await page.waitForTimeout(1000); return aiInFlight.size === 0 && aiFinished === seen; }, slow).toBe(true);
    aiLocked = true;
    // Negative control: a query-bearing ai_status POST from the page must be refused by the route and counted by both.
    check(lateAiStatus === 0 && postLockAiStatus === 0);
    aiProbes++;
    const probe = await page.evaluate(async url => {
      try { await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }); return 'reached'; } catch { return 'refused'; }
    }, `${base}/rest/v1/rpc/ai_status?select=*&probe=${randomUUID()}`);
    if (probe !== 'refused') throw new Error('A query-bearing ai_status call escaped the lock.');
    await expect.poll(() => [lateAiStatus, postLockAiStatus], slow).toEqual([aiProbes, aiProbes]);
    // Every write attempt while signing in and opening Settings, even one later undone: only Auth, the profile's
    // first-language save, the initialization ai_status and read-only status RPCs are allowed.
    const signInAttempts = requests.slice(signInFrom).filter(({ method }) => !['GET', 'HEAD', 'OPTIONS'].includes(method))
      .map(({ method, url }) => ({ method, path: new URL(url).pathname }))
      .filter(({ method, path }) => !(path.startsWith('/auth/v1/') || method === 'PATCH' && path === '/rest/v1/profiles'
        || method === 'POST' && (path === '/rest/v1/rpc/ai_status' || READ_ONLY_RPCS.has(path.replace('/rest/v1/rpc/', ''))
          && path.startsWith('/rest/v1/rpc/'))));
    if (signInAttempts.length) throw new Error(`Write attempts while signing in: ${signInAttempts.map(({ method, path }) => `${method} ${path}`).join(', ')}.`);
    const opened = await snapshot(a);
    languageInitializationOnly('A while signing in', opened, aBefore);
    if (differences(opened, aBefore).length) console.log('I26 drill: signing in saved the first language');
    aBefore = opened;
    const card = page.locator('.restore-card');
    const checkBackup = async () => {
      if (await button(page, 'restore.open').isVisible()) await button(page, 'restore.open').click();
      await card.locator('#restore-files').setInputFiles(files);
      await card.getByLabel(text('backup.passphrase'), { exact: true }).fill(PASSPHRASE);
      await button(page, 'restore.check').click();
    };
    await checkBackup();
    await expect(card.getByText(text('restore.add', { n: '2' }))).toBeVisible(slow);
    await expect(card).toContainText(text('restore.reencoded_one', { count: '1' }));
    await expect(card).toContainText(text('restore.otherAccount'));
    unchanged('A after Check', await snapshot(a), aBefore);

    // ---- First run, interrupted: P's replacement cannot be reserved twice in a row. ----
    stage = 'interrupted-run';
    let blocked = 2;
    const blockReservation = async (route: import('@playwright/test').Route) => {
      if (blocked > 0) { blocked--; await route.abort('failed'); return; }
      await route.fallback();
    };
    await page.route('**/rest/v1/rpc/reserve_image_change', blockReservation);
    await button(page, 'restore.start').click();
    await expect(card.getByRole('alert')).toHaveText(text('restore.stopped'), slow);
    // P and everything that refers to it (outfit, rule, vote, worn day) wait for the next run.
    await expect(card).toContainText(text('restore.notRestored', { n: '5' }));
    check(blocked === 0);
    const partial = await snapshot(a);
    const partialItems = rowsOf(partial, 'items').filter(row => row.id === pId || row.id === cId);
    check(partialItems.length === 2 && partialItems.find(row => row.id === pId)!.version === 1 && partialItems.find(row => row.id === cId)!.version === 1);
    check(canonical(rowsOf(partial, 'item_images').filter(row => row.item_id === pId).map(row => [row.id, row.state]))
      === canonical([[await map('item_images', pOld.id), 'ready']]));
    for (const table of ['outfits', 'outfit_items', 'wear_events', 'wear_event_items', 'combination_rules', 'suggestion_feedback'] as const) {
      check(canonical(rowsOf(partial, table)) === canonical(rowsOf(aBefore, table)));
    }
    await page.unroute('**/rest/v1/rpc/reserve_image_change', blockReservation);

    // ---- The same run continued. ----
    stage = 'continued-run';
    const continuedFrom = requests.length;
    await button(page, 'restore.again').click();
    await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
    check(functionCalls(continuedFrom).some(({ url }) => url.includes('/functions/v1/finalize-image-change')));
    const report = await page.evaluate(async () => {
      const module = '/src/data/restore.ts';
      const { restoreReport } = await import(module) as typeof import('../../src/data/restore');
      return restoreReport();
    }) as RestoreResult | null;
    check(report && report.photos.length === 3 && report.failed === 0 && report.blocked === 0 && report.deferred === 0);
    const after = await snapshot(a);

    // Hashes: source (manifest and carried bytes) -> expected (Q6 plan) -> actual (row and the object downloaded as A).
    stage = 'hashes';
    const expectedMain = { [String(pOld.id)]: 'preserved', [String(pNew.id)]: 'reencoded', [String(cImage.id)]: 'preserved' } as const;
    const expectedOutcome = { [String(pOld.id)]: 'present', [String(pNew.id)]: 'written', [String(cImage.id)]: 'present' } as const;
    for (const source of sourceImages) {
      const planned = report.photos.find(entry => entry.sourceImageId === source.id);
      check(planned);
      check(planned.planned.sourceSha256 === source.main_sha256);
      check(planned.planned.main === expectedMain[String(source.id)] && planned.outcome === expectedOutcome[String(source.id)]);
      if (planned.planned.main === 'preserved') check(planned.planned.mainSha256 === source.main_sha256 && planned.planned.reason === null);
      else check(planned.planned.mainSha256 !== source.main_sha256 && planned.planned.reason !== null);
      // The thumbnail is always made again from the main photo, never copied from the backup.
      check(planned.planned.thumbSha256 !== source.thumb_sha256);
      check(canonical(planned.stored) === canonical({ mainSha256: planned.planned.mainSha256, thumbSha256: planned.planned.thumbSha256 }));
      const targetId = await map('item_images', source.id);
      const row = rowsOf(after, 'item_images').find(image => image.id === targetId);
      check(row && row.owner_id === a.scope.ownerId && row.item_id === await map('items', source.item_id));
      check(row.main_sha256 === planned.planned.mainSha256 && row.thumb_sha256 === planned.planned.thumbSha256);
      check(row.main_path === `${a.scope.ownerId}/${String(row.item_id)}/${targetId}/main.jpg`
        && row.thumb_path === `${a.scope.ownerId}/${String(row.item_id)}/${targetId}/thumb.jpg`);
      check(after.objects[String(row.main_path)] === planned.planned.mainSha256 && after.objects[String(row.thumb_path)] === planned.planned.thumbSha256);
      check(row.state === source.state && (row.state === 'retired') === (row.retired_at !== null));
      check(row.alt_text === source.alt_text && row.width === source.width && row.height === source.height);
    }

    // Per-table expected differences: mapped IDs; values equal; kinds kept at revision 1, cleared fields without an entry.
    stage = 'tables';
    for (const source of [sourceP, sourceC]) {
      const row = rowsOf(after, 'items').find(item => item.id === (source === sourceP ? pId : cId));
      check(row && row.owner_id === a.scope.ownerId && row.deleted_at === null);
      check(canonical(garmentPayload(parseGarmentValues(row))) === canonical(garmentPayload(parseGarmentValues(source))));
      const payload = garmentPayload(parseGarmentValues(source)) as Row;
      const expectedKinds = Object.fromEntries(Object.entries(parseFieldProvenance(source.field_provenance))
        .filter(([field]) => !empty(payload[field])).map(([field, entry]) => [field, { kind: entry.kind, revision: 1 }]));
      check(canonical(parseFieldProvenance(row.field_provenance)) === canonical(expectedKinds));
      check(row.version === (source === sourceP ? 2 : 1));
    }
    const restoredP = rowsOf(after, 'items').find(item => item.id === pId)!, restoredC = rowsOf(after, 'items').find(item => item.id === cId)!;
    check(canonical(parseFieldProvenance(restoredP.field_provenance)) === canonical(pKinds));
    const cKinds = parseFieldProvenance(restoredC.field_provenance);
    check(!('brand' in cKinds) && !('pattern' in cKinds) && !('seasons' in cKinds));
    check(empty(restoredC.brand) && restoredC.pattern === null && canonical(restoredC.seasons) === '[]');
    check(rowsOf(after, 'items').filter(item => !rowsOf(aBefore, 'items').some(old => old.id === item.id)).length === 2);
    const aOutfit = rowsOf(after, 'outfits').find(row => row.id === aOutfitId);
    const sourceOutfit = manifest.tables.outfits.find(row => row.id === outfitId)!;
    check(aOutfit && (['title', 'occasion', 'notes', 'favourite'] as const).every(field => aOutfit[field] === sourceOutfit[field]) && aOutfit.deleted_at === null);
    const order = async (rows: Row[], id: unknown, mapped: boolean) => Promise.all(rows.filter(row => row.outfit_id === id)
      .sort((x, y) => Number(x.position) - Number(y.position)).map(row => mapped ? map('items', row.item_id) : String(row.item_id)));
    check(canonical(await order(rowsOf(after, 'outfit_items'), aOutfitId, false)) === canonical(await order(manifest.tables.outfit_items, outfitId, true)));
    const aEvent = rowsOf(after, 'wear_events').find(row => row.id === aEventId);
    const sourceEvent = manifest.tables.wear_events.find(row => row.id === eventId)!;
    check(aEvent && aEvent.outfit_id === aOutfitId && aEvent.deleted_at === null
      && (['local_date', 'timezone', 'state', 'label'] as const).every(field => aEvent[field] === sourceEvent[field]));
    const sourceEntries = manifest.tables.wear_event_items.filter(row => row.event_id === eventId);
    check(sourceEntries.length === 2 && rowsOf(after, 'wear_event_items').filter(row => row.event_id === aEventId).length === 2);
    for (const entry of sourceEntries) {
      const entryId = await map('wear_event_items', entry.id);
      const restored = rowsOf(after, 'wear_event_items').find(row => row.id === entryId);
      check(restored && restored.event_id === aEventId && restored.title_snapshot === entry.title_snapshot
        && restored.item_id === await map('items', entry.item_id)
        && restored.category_snapshot === entry.category_snapshot && restored.import_id === exportId);
    }
    const mappedPair = [pId, cId].sort();
    check(rowsOf(after, 'combination_rules').some(row => row.item_low === mappedPair[0] && row.item_high === mappedPair[1]));
    check(rowsOf(after, 'suggestion_feedback').some(row => canonical(row.item_ids) === canonical(mappedPair) && row.vote === 1));
    for (const table of ['profiles', 'style_preferences'] as const) check(canonical(rowsOf(after, table)) === canonical(rowsOf(aBefore, table)));
    // Q5: saved attribution history is not restored; the restored items have none.
    for (const id of [pId, cId]) {
      const history = await a.client.rpc('item_attribution_history', { p_item_id: id });
      check(!history.error && canonical(history.data) === '[]');
    }

    // ---- Second run of the same backup: everything is already here and nothing persistent changes. ----
    stage = 'second-run';
    await button(page, 'backup.finish').click();
    const secondFrom = requests.length;
    await checkBackup();
    await expect(card.getByText(text('restore.same', { n: '2' }))).toBeVisible(slow);
    await expect(card).toContainText(text('restore.add', { n: '0' }));
    await button(page, 'restore.start').click();
    await expect(card.getByRole('status')).toHaveText(text('restore.done'), slow);
    unchanged('A after the second restore', await snapshot(a), after);
    check(storageWrites(secondFrom).length === 0 && reservations(secondFrom).length === 0 && functionCalls(secondFrom).length === 0);

    // ---- Tripwire and the other owner. ----
    stage = 'tripwire';
    const paths = (list: { url: string }[]) => [...new Set(list.map(({ url }) => new URL(url).pathname))];
    const tripped = (label: string, list: string[]) => { if (list.length) throw new Error(`${label}: ${list.join(', ')}.`); };
    tripped('Refused function calls', refusedFunctions);
    tripped('Function calls other than finalize-image-change',
      paths(functionCalls(0)).filter(path => path !== '/functions/v1/finalize-image-change'));
    // ai_status ran only during the Settings initialization, before the baseline (see aiLocked); any later call was refused.
    if (lateAiStatus !== aiProbes || postLockAiStatus !== aiProbes) {
      throw new Error(`ai_status called after the restore baseline: ${postLockAiStatus - aiProbes} seen, ${lateAiStatus - aiProbes} refused beyond the probe.`);
    }
    tripped('Save or AI RPCs', paths(requests).filter(path => /\/rpc\/(reserve_item_save|reserve_analyzed_item_save|ai_)/.test(path)
      && path !== '/rest/v1/rpc/ai_status'));
    unchanged('B', await snapshot(owner), bBefore);
  } catch (problem) {
    throw new AggregateError([new Error(`restore drill primary failed at ${stage}.`)],
      problem === failure ? 'Local restore drill failed.' : 'Local restore drill failed (unexpected).', { cause: problem });
  } finally {
    await rm(output, { recursive: true, force: true }).catch(() => cleanupFailures.push('output'));
    const removeItems = async (value: Owner | undefined, ids: string[]) => {
      if (!value) return;
      const lifecycle = new ItemLifecycleClient(value.client, { url: base, publishableKey: key, version: 'local-restore-drill' }, value.scope);
      for (const id of ids) {
        try {
          const present = await value.client.from('items').select('id').eq('owner_id', value.scope.ownerId).eq('id', id);
          check(!present.error);
          if (!present.data?.length) continue;
          let status = await lifecycle.statusOf(id);
          if (!status.deleted_at) await lifecycle.change(id, true, status.version, () => undefined);
          status = await lifecycle.statusOf(id);
          const outcome = await lifecycle.delete(deletionIntent(status, value.scope.epoch), true, () => undefined);
          check(outcome.missing === 0);
          const absent = await value.client.from('items').select('id').eq('owner_id', value.scope.ownerId).eq('id', id);
          check(!absent.error && absent.data?.length === 0);
        } catch { cleanupFailures.push('item'); }
      }
    };
    const removeRows = async (value: Owner | undefined, table: 'wear_events' | 'outfits' | 'suggestion_feedback', ids: string[]) => {
      if (!value || !ids.length) return;
      const removed = await value.client.from(table).delete().eq('owner_id', value.scope.ownerId).in('id', ids);
      if (removed.error) cleanupFailures.push(table);
    };
    try {
      await removeRows(a, 'wear_events', created.a.events);
      await removeRows(a, 'outfits', created.a.outfits);
      if (a && created.a.items.length) {
        const rows = await a.client.from('suggestion_feedback').select('id, item_ids').eq('owner_id', a.scope.ownerId);
        const ids = (rows.data ?? []).filter(row => (row.item_ids as string[]).some(id => created.a.items.includes(id))).map(row => String(row.id));
        if (rows.error) cleanupFailures.push('feedback');
        else await removeRows(a, 'suggestion_feedback', ids);
      }
      await removeItems(a, created.a.items);
      await removeRows(b, 'wear_events', created.b.events);
      await removeRows(b, 'outfits', created.b.outfits);
      await removeRows(b, 'suggestion_feedback', created.b.feedback);
      await removeItems(b, created.b.items);
    } catch { cleanupFailures.push('cleanup'); }
    // Both owners must be back at their pre-drill inventories: tables and Storage keys and hashes. A only keeps the
    // first-language save; every tracked drill ID is absent.
    const tracked = [...created.a.items, ...created.a.outfits, ...created.a.events, ...created.b.items, ...created.b.outfits,
      ...created.b.events, ...created.b.feedback];
    for (const [label, value, initial, compare] of [['A', a, aInitial, languageInitializationOnly], ['B', b, bInitial, unchanged]] as const) {
      if (!value || !initial) continue;
      try {
        const final = await snapshot(value);
        compare(`${label} after cleanup`, final, initial);
        const dump = JSON.stringify(final);
        const left = tracked.filter(id => dump.includes(id));
        if (left.length) cleanupFailures.push(`${label} still holds ${left.length} drill ID(s).`);
      } catch (problem) { cleanupFailures.push(`${label} inventory: ${problem instanceof Error ? problem.message : 'unreadable'}`); }
    }
    for (const client of clients) await client.auth.signOut({ scope: 'local' }).catch(() => cleanupFailures.push('sign-out'));
  }
  expect(cleanupFailures).toEqual([]);
});
