import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteWardrobeObject } from '../../src/data/storage-delete';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { MIGRATIONS, assertRehearsalEnvironment, validateInventory, assertMigrationInventory, assertCapabilities, parseMigrationHistory, assertHistory, assertHistoryResult, historyFailureDetail, exportBodyEvidence, sixPrivateCaptureSql, validateSixPrivate, compareSixPrivate } from '../../scripts/preservation-rehearsal.mjs';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { SOURCE_HASHES, MAX_SNAPSHOT_BYTES, COLUMNS, TABLES, COUNTS, IMPLICIT_FACTS, EXPLICIT_FACTS, NEW_COLUMNS, parsePhaseArguments, snapshotPath, assertSnapshotPath, validateSnapshotStat, rowIdentity, canonicalRows, validateSnapshot, comparePreservation, normalClient, captureData, functionalProbes, SIX_COUNTS, SIX_COLUMNS, validateSixSnapshot, compareSixPreservation } from '../integration/preservation.sessions.mjs';
// @ts-expect-error Executable integration fixture has no TypeScript declaration.
import { imageChangeHarness } from '../integration/image-replacement.sessions.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = randomUUID(), owners = [randomUUID(), randomUUID()] as const;
type Table = 'profiles' | 'style_preferences' | 'items' | 'item_images' | 'outfits' | 'outfit_items'
  | 'wear_events' | 'wear_event_items' | 'combination_rules' | 'suggestion_feedback';
const tables = TABLES as Table[];
const columns = COLUMNS as Record<Table, string>;
const newColumns = NEW_COLUMNS as string[];
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type Row = Record<string, Value>;
type TableRows = Record<Table, [Row, ...Row[]]> & { items: [Row, Row, Row]; item_images: [Row, Row] };
type OwnerData = { label: string; ownerId: string; tables: TableRows; objects: [ObjectEvidence, ...ObjectEvidence[]] };
type ObjectEvidence = { path: string; bytes: number; sha256: string };
type Snapshot = {
  schemaVersion: number; projectId: string; stage: string; run: string;
  sources: { base: string; target: string; description: string; collections: string; controls: string; save: string; analysis: string; analyzedSave: string; lifecycle: string; azure: string; imageChanges: string }; owners: string[];
  data: [OwnerData, OwnerData];
};
const sha = 'a'.repeat(64);
const time = '2026-09-05T12:34:56.123456+00:00';
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture entry');
  return value;
}

function fixture(): Snapshot {
  return {
    schemaVersion: 1, projectId: 'stillroom-wardrobe', stage: 'base', run,
    sources: { ...SOURCE_HASHES }, owners: [...owners],
    data: owners.map((ownerId, index): OwnerData => {
      const data = Object.fromEntries(tables.map((table, tableIndex) => [table,
        Array.from({ length: present((COUNTS as number[])[tableIndex]) }, () => {
          const row: Row = Object.fromEntries(columns[table].split(' ').map((column) => [column,
            column.endsWith('_at') ? time : column === 'version' ? 2 : 'fictional']));
          row.owner_id = ownerId;
          for (const key of Object.keys(row)) {
            if (key === 'id' || key.endsWith('_id') || ['item_low', 'item_high'].includes(key)) row[key] = randomUUID();
            if (['colours', 'seasons', 'style_tags', 'tags', 'preferred_colours', 'excluded_categories', 'item_ids'].includes(key)) row[key] = [];
            if (['weather_enabled', 'windproof', 'favourite', 'exclude_suggestions', 'wear_more'].includes(key)) row[key] = false;
            if (['latitude', 'longitude', 'purchase_price', 'minimum_upper_coverage', 'minimum_lower_coverage', 'cold_sensitivity',
              'repeat_gap_days', 'formality', 'warmth', 'min_temp', 'max_temp', 'rain_rating', 'upper_coverage',
              'lower_coverage', 'main_bytes', 'thumb_bytes', 'width', 'height', 'position', 'vote'].includes(key)) row[key] = 1;
            if (['purchase_date', 'local_date'].includes(key)) row[key] = '2024-02-29';
          }
          row.owner_id = ownerId;
          return row;
        }),
      ])) as TableRows;
      for (const row of data.items) Object.assign(row, IMPLICIT_FACTS, {
        colours: ['unknown'], seasons: ['spring', 'summer', 'autumn', 'winter'], notes: '',
        brand: null, purchase_price: null, currency: 'EUR', tags: [], style_tags: [], favourite: false,
      });
      data.items[0].title = 'Fictional implicit facts';
      Object.assign(data.items[1], EXPLICIT_FACTS, {
        title: 'Fictional explicit facts', colours: ['green', 'blue'], tags: ['fictional', 'preservation'],
        purchase_price: 123.45, currency: 'SEK', purchase_date: '2024-02-29', notes: 'Fictional note\nSecond line 🌿',
      });
      data.items[2].title = 'Fictional imageless item';
      for (const [imageIndex, image] of data.item_images.entries()) {
        Object.assign(image, { item_id: data.items[1].id, state: imageIndex ? 'ready' : 'retired', retired_at: imageIndex ? null : time });
        for (const variant of ['main', 'thumb']) {
          image[`${variant}_path`] = `${ownerId}/${image.item_id}/${image.id}/${variant}.jpg`;
          image[`${variant}_bytes`] = 632;
          image[`${variant}_sha256`] = sha;
        }
      }
      const objects = data.item_images.flatMap((image) => ['main', 'thumb'].map((variant) => ({
        path: image[`${variant}_path`] as string, bytes: 632, sha256: sha,
      })));
      return { label: index === 0 ? 'A' : 'B', ownerId, tables: data, objects: objects as [ObjectEvidence, ...ObjectEvidence[]] };
    }) as [OwnerData, OwnerData],
  };
}

function upgraded(before: Snapshot): Snapshot {
  const after = structuredClone(before);
  for (const data of after.data) for (const row of data.tables.items) {
    Object.assign(row, { pattern: null, sleeve_length: null, garment_length: null, field_provenance: {} });
  }
  for (const data of after.data) for (const row of data.tables.item_images) row.description_version = 1;
  return after;
}

// SOURCE-DERIVED: CLI 2.116.0 commit 997a1e69a4a83466964ed874d3a604c88a7b3866,
// list.format.ts (5d1d0d8) and legacy-glamour-table.ts (29c6778).
// Not observed CLI execution, database state or preservation proof.
const baseTable = [
  '',
  '  ',
  '   Local            | Remote           | Time (UTC)            ',
  '  ------------------|------------------|-----------------------',
  '   `20260905000000` | `20260905000000` | `2026-09-05 00:00:00` ',
  '   `20260906000000` | ` `              | `2026-09-06 00:00:00` ',
  '   `20260909070000` | ` `              | `2026-09-09 07:00:00` ',
  '   `20260909110000` | ` `              | `2026-09-09 11:00:00` ',
  '   `20260909180000` | ` `              | `2026-09-09 18:00:00` ',
  '   `20260910070000` | ` `              | `2026-09-10 07:00:00` ',
  '   `20260911040000` | ` `              | `2026-09-11 04:00:00` ',
  '   `20260911200000` | ` `              | `2026-09-11 20:00:00` ',
  '   `20260913120000` | ` `              | `2026-09-13 12:00:00` ',
  '   `20260921193000` | ` `              | `2026-09-21 19:30:00` ',
  '   `20260922020000` | ` `              | `2026-09-22 02:00:00` ',
  '   `20260924100000` | ` `              | `2026-09-24 10:00:00` ',
  '   `20260924100100` | ` `              | `2026-09-24 10:01:00` ',
  '   `20260925100000` | ` `              | `2026-09-25 10:00:00` ',
  '',
  '',
].join('\n');
const targetTable = [
  '',
  '  ',
  '   Local            | Remote           | Time (UTC)            ',
  '  ------------------|------------------|-----------------------',
  '   `20260905000000` | `20260905000000` | `2026-09-05 00:00:00` ',
  '   `20260906000000` | `20260906000000` | `2026-09-06 00:00:00` ',
  '   `20260909070000` | `20260909070000` | `2026-09-09 07:00:00` ',
  '   `20260909110000` | `20260909110000` | `2026-09-09 11:00:00` ',
  '   `20260909180000` | `20260909180000` | `2026-09-09 18:00:00` ',
  '   `20260910070000` | `20260910070000` | `2026-09-10 07:00:00` ',
  '   `20260911040000` | `20260911040000` | `2026-09-11 04:00:00` ',
  '   `20260911200000` | `20260911200000` | `2026-09-11 20:00:00` ',
  '   `20260913120000` | `20260913120000` | `2026-09-13 12:00:00` ',
  '   `20260921193000` | `20260921193000` | `2026-09-21 19:30:00` ',
  '   `20260922020000` | `20260922020000` | `2026-09-22 02:00:00` ',
  '   `20260924100000` | `20260924100000` | `2026-09-24 10:00:00` ',
  '   `20260924100100` | `20260924100100` | `2026-09-24 10:01:00` ',
  '   `20260925100000` | `20260925100000` | `2026-09-25 10:00:00` ',
  '',
  '',
].join('\n');
const pendingRow = (table: string, version: string) => table.replace(`\`${version}\` | \`${version}\``, `\`${version}\` | \` \`             `);
// COL1: eleven applied (image-change) and twelve applied (colours), then the full fourteen as target.
const coloursTable = pendingRow(pendingRow(targetTable, '20260925100000'), '20260924100100');
const imageChangeTable = pendingRow(coloursTable, '20260924100000');
const azureTable = pendingRow(imageChangeTable, '20260922020000');
const priorMainTable = azureTable.replace('`20260921193000` | `20260921193000`', '`20260921193000` | ` `             ');
const validEnv = { ALLOW_PRESERVATION_REHEARSAL: '1', CI: 'true', GITHUB_ACTIONS: 'true' };
const inventory = () => (MIGRATIONS as { name: string; version: string; bytes: number; sha256: string }[])
  .map((entry) => ({ ...entry, regular: true, symlink: false }));

type SixSnapshot = Omit<Snapshot, 'data'> & {
  data: { label: string; ownerId: string; tables: Record<Table, Row[]>; objects: ObjectEvidence[] }[];
};
function sixFixture(): SixSnapshot {
  const value: SixSnapshot = upgraded(fixture());
  value.stage = 'six';
  for (const data of value.data) {
    Object.assign(present(data.tables.profiles[0]), { ai_enabled: false, ai_notice_revision: null, ai_consented_at: null });
    const implicit = present(data.tables.items.find((row) => row.title === 'Fictional implicit facts'));
    for (const key of Object.keys(IMPLICIT_FACTS)) implicit[key] = null;
    const explicit = present(data.tables.items.find((row) => row.title === 'Fictional explicit facts'));
    Object.assign(explicit, { pattern: 'checked', sleeve_length: 'long', garment_length: 'long',
      field_provenance: { title: { kind: 'user', revision: 1 }, pattern: { kind: 'user', revision: 2 },
        warmth: { kind: 'unknown', revision: 1 } } });
    for (const image of data.tables.item_images) Object.assign(image, { width: 2, height: 2, description_version: 2 });
    for (const state of ['ready', 'pending']) {
      const item = { ...structuredClone(implicit), id: randomUUID(), title: `Fictional checked ${state}`, version: 1 };
      const image: Row = { ...structuredClone(present(data.tables.item_images[0])),
        id: randomUUID(), item_id: item.id, state, retired_at: null, description_version: 1 };
      for (const variant of ['main', 'thumb']) {
        image[`${variant}_path`] = `${data.ownerId}/${item.id}/${image.id}/${variant}.jpg`;
        data.objects.push({ path: String(image[`${variant}_path`]), bytes: 632, sha256: sha });
      }
      data.tables.items.push(item); data.tables.item_images.push(image);
    }
  }
  return value;
}
function sixPrivateFixture() {
  const before = sixFixture(), localOwners = before.owners.map((uid) => ({ uid }));
  const tombstones = before.owners.map((owner_id) => ({ owner_id, item_id: randomUUID(), image_id: randomUUID() }));
  const attempts: Row[] = [], used: Row[] = [], controls: Row[] = [], registry: Row[] = [];
  for (const data of before.data) {
    for (const image of data.tables.item_images) {
      registry.push({ owner_id: data.ownerId, image_id: image.id ?? null });
      if (image.description_version !== 1) continue;
      const ids = { owner_id: data.ownerId, item_id: image.item_id ?? null, image_id: image.id ?? null };
      attempts.push({ ...ids, fingerprint: sha, state: image.state === 'ready' ? 'completed' : 'reserved',
        created_at: time, completed_at: image.state === 'ready' ? time : null });
      used.push(ids);
    }
    const tombstone = present(tombstones.find((row) => row.owner_id === data.ownerId));
    used.push(tombstone); registry.push({ owner_id: data.ownerId, image_id: tombstone.image_id });
    controls.push({ owner_id: data.ownerId, activated: false, notice_revision: 1, model_id: 'fictional-inactive',
      prompt_version: 1, max_request_micro: 123, monthly_allowance_micro: 4567, max_requests_per_hour: 2,
      result_ttl_seconds: 3600, created_at: time, updated_at: time });
  }
  const old = { item_save_attempts: attempts, item_save_used_ids: used, ai_controls: controls, ai_requests: [], ai_usage: [] };
  const after = { ...structuredClone(old), ai_controls: controls.map((row) => ({ ...row, execution_manifest_id: null })),
    registry, empty: { image_change_attempts: true, image_change_context: true, image_change_history: true,
      item_deletion_claims: true, item_deletion_operations: true, item_deletion_targets: true } };
  return { old, after, snapshot: { before, owners: localOwners, tombstones } };
}

describe('HC1 populated six-to-eleven preservation (synthetic, no backend proof)', () => {
  it('recognizes only exact six-applied/five-pending history for fixture setup', () => {
    const sixTable = baseTable.replace(/`(202609(?:06000000|09070000|09110000|09180000|10070000))` \| ` `/g, '`$1` | `$1`');
    expect(assertHistory(sixTable, 'hosted-source')).toEqual({
      applied: inventory().slice(0, 6).map((entry) => entry.version),
      pending: inventory().slice(6).map((entry) => entry.version),
    });
    for (const wrong of [baseTable, priorMainTable, azureTable, targetTable]) {
      expect(() => assertHistory(wrong, 'hosted-source')).toThrow();
    }
    for (const stage of ['base', 'prior-main', 'azure-target', 'target', 'seven', 'eight']) {
      expect(() => assertHistory(sixTable, stage)).toThrow();
    }
  });
  it('retains every schema-six column and all38rows/16objects without base normalization', () => {
    const before = sixFixture();
    expect(SIX_COUNTS).toEqual([1, 1, 5, 4, 1, 2, 1, 2, 1, 1]);
    expect(SIX_COLUMNS.profiles).toBe(COLUMNS.profiles + ' ai_enabled ai_notice_revision ai_consented_at');
    expect(SIX_COLUMNS.items).toBe(COLUMNS.items + ' ' + NEW_COLUMNS.join(' '));
    expect(SIX_COLUMNS.item_images).toBe(COLUMNS.item_images + ' description_version');
    expect(() => validateSixSnapshot(before, run, [...owners])).not.toThrow();
    const after = structuredClone(before);
    for (const data of after.data) {
      for (const table of tables) data.tables[table].reverse();
      data.objects.reverse();
    }
    expect(() => compareSixPreservation(before, after, run, [...owners])).not.toThrow();
    expect(before.data.reduce((sum, data) => sum + tables.reduce((n, table) => n + data.tables[table].length, 0), 0)).toBe(38);
    expect(before.data.flatMap((data) => data.objects)).toHaveLength(16);
  });
  it.each(tables)('rejects dropped, added, changed and foreign rows/fields in %s', (table) => {
    for (const kind of ['drop', 'extra-row', 'extra-column', 'changed', 'foreign']) {
      const before = sixFixture(), after = structuredClone(before), data = present(after.data[0]);
      const row = present(data.tables[table][0]);
      if (kind === 'drop') data.tables[table].pop();
      else if (kind === 'extra-row') data.tables[table].push(structuredClone(row));
      else if (kind === 'extra-column') row.unexpected = null;
      else if (kind === 'foreign') row.owner_id = owners[1];
      else {
        const field = table === 'outfit_items' ? 'position' : table === 'combination_rules' ? 'created_at'
          : table === 'suggestion_feedback' ? 'vote' : table === 'wear_event_items' ? 'title_snapshot'
            : table === 'item_images' ? 'alt_text' : 'version';
        row[field] = typeof row[field] === 'number' ? Number(row[field]) + 1 : 'changed';
      }
      expect(() => compareSixPreservation(before, after, run, [...owners])).toThrow();
    }
  });
  it('rejects changed bytes/hash/path, duplicate objects, provenance/counter loss, wrong identity and oversized snapshots', () => {
    const changes: ((value: SixSnapshot) => void)[] = [
      (v) => { present(present(v.data[0]).objects[0]).bytes = 4; },
      (v) => { present(present(v.data[0]).objects[0]).sha256 = 'b'.repeat(64); },
      (v) => { present(present(v.data[0]).objects[0]).path += '/extra'; },
      (v) => { const d = present(v.data[0]); d.objects[0] = present(d.objects[1]); },
      (v) => { present(present(v.data[0]).tables.item_images[0]).description_version = 1; },
      (v) => { present(present(v.data[0]).tables.items.find((r) => r.title === 'Fictional explicit facts')).field_provenance = {}; },
      (v) => { v.run = randomUUID(); },
      (v) => { v.stage = 'base'; },
      (v) => { present(present(v.data[0]).tables.items[0]).notes = 'x'.repeat(MAX_SNAPSHOT_BYTES); },
    ];
    for (const change of changes) {
      const before = sixFixture(), after = structuredClone(before); change(after);
      expect(() => compareSixPreservation(before, after, run, [...owners])).toThrow();
    }
  });
  it('preserves exactly three private tables with only null execution_manifest_id added', () => {
    const { old, after, snapshot } = sixPrivateFixture();
    expect(() => validateSixPrivate(old, snapshot.owners, snapshot.tombstones)).not.toThrow();
    expect(() => compareSixPrivate(old, after, snapshot)).not.toThrow();
    expect(old.item_save_attempts).toHaveLength(4); expect(old.item_save_used_ids).toHaveLength(6);
    expect(snapshot.before.data.flatMap((data) => data.tables.item_images)).toHaveLength(8);
    expect(after.registry).toHaveLength(10);
    for (const table of ['item_save_attempts', 'item_save_used_ids', 'ai_controls'] as const) {
      for (const field of Object.keys(present(old[table][0]))) {
        const changed = structuredClone(after);
        Object.assign(present(changed[table][0]), { [field]: 'changed' });
        expect(() => compareSixPrivate(old, changed, snapshot)).toThrow();
      }
      const missing = structuredClone(after); missing[table].pop();
      expect(() => compareSixPrivate(old, missing, snapshot)).toThrow();
      const extra = structuredClone(after), rows: Row[] = extra[table];
      rows.push(present(rows[0]));
      expect(() => compareSixPrivate(old, extra, snapshot)).toThrow();
    }
    for (const value of ['manifest', undefined, 0]) {
      const changed = structuredClone(after);
      Object.assign(present(changed.ai_controls[0]), { execution_manifest_id: value });
      expect(() => compareSixPrivate(old, changed, snapshot)).toThrow();
    }
    const extraField = structuredClone(after);
    Object.assign(present(extraField.ai_controls[0]), { unexpected: null });
    expect(() => compareSixPrivate(old, extraField, snapshot)).toThrow();
    expect(() => compareSixPrivate(old, { ...after, ai_requests: [{ owner_id: owners[0] }] }, snapshot)).toThrow();
    expect(() => compareSixPrivate(old, { ...after, ai_usage: [{ owner_id: owners[0] }] }, snapshot)).toThrow();
  });
  it('distinguishes exact image/used-ID union from image-only, duplicate, foreign or equal-count wrong registries', () => {
    const { old, after, snapshot } = sixPrivateFixture();
    const images = snapshot.before.data.flatMap((data) => data.tables.item_images.map((row) =>
      ({ owner_id: row.owner_id, image_id: row.id })));
    expect(() => compareSixPrivate(old, { ...after, registry: images }, snapshot)).toThrow();
    for (const replacement of [after.registry[1], { owner_id: owners[0], image_id: randomUUID() },
      { owner_id: randomUUID(), image_id: present(after.registry[0]).image_id }]) {
      expect(() => compareSixPrivate(old, { ...after, registry: [replacement, ...after.registry.slice(1)] }, snapshot)).toThrow();
    }
    const absentUsed = structuredClone(old); absentUsed.item_save_used_ids.pop();
    expect(() => validateSixPrivate(absentUsed, snapshot.owners, snapshot.tombstones)).toThrow();
    const liveTombstone = structuredClone(snapshot.tombstones);
    Object.assign(present(liveTombstone[0]), present(old.item_save_used_ids[0]));
    expect(() => validateSixPrivate(old, snapshot.owners, liveTombstone)).toThrow();
    for (const name of Object.keys(after.empty)) expect(() =>
      compareSixPrivate(old, { ...after, empty: { ...after.empty, [name]: false } }, snapshot)).toThrow();
    expect(() => compareSixPrivate(old, { ...after, empty: { ...after.empty, ai_execution_manifests: true } }, snapshot)).toThrow();
  });
  it('scopes private capture to two checked fictional owners,33-row detection and enumerated new tables', () => {
    const ids = owners.map((uid) => ({ uid }));
    const sql = sixPrivateCaptureSql(ids), target = sixPrivateCaptureSql(ids, true);
    expect(sql.match(/limit 33/g)).toHaveLength(5);
    expect(target.match(/limit 33/g)).toHaveLength(6);
    for (const id of owners) expect(sql).toContain(`'${id}'`);
    expect(target).toContain('private.item_image_used_ids');
    expect(target).toContain('private.image_change_context');
    expect(target).not.toContain('private.ai_execution_manifests');
    expect(sql).not.toMatch(/delete|insert|update|from private\.image_change/);
    for (const bad of [[], [ids[0]], [ids[0], ids[0]], [{ uid: "';select" }, ids[1]]]) {
      expect(() => sixPrivateCaptureSql(bad)).toThrow();
    }
  });
  it('orders one fixed6->11 upgrade after finalizer shutdown, compares before probes and retains original races', async () => {
    const source = await readFile(path.join(root, 'scripts/preservation-rehearsal.mjs'), 'utf8');
    const normal = await readFile(path.join(root, 'tests/integration/preservation.sessions.mjs'), 'utf8');
    const six = source.slice(source.indexOf("stage = 'HC1-six-reset'"));
    expect(source.indexOf('await finalizer.stop();')).toBeLessThan(source.indexOf("stage = 'HC1-six-reset'"));
    let offset = 0;
    for (const step of ["'--version', HOSTED_SOURCE_VERSION", "await history('hosted-source')",
      'await captureSixPreservation(', "await history('hosted-source')", 'await sameDatabaseIdentity()',
      "await migrateToStage(run, 'hosted-source', 'image-change')", "await history('image-change')", 'await verifyCiStorageGuard()',
      'await readSixPreservation(', 'compareSixPrivate(', 'await probeSixPreservation(', 'await lifecyclePublicationCases(']) {
      const next = six.indexOf(step, offset); expect(next).toBeGreaterThanOrEqual(offset); offset = next + step.length;
    }
    expect(six).not.toMatch(/await cli\(\['migration', 'up'/);
    expect(six.slice(0, six.indexOf("stage = 'HC1-six-to-eleven'"))).not.toContain('verifyCiStorageGuard');
    expect(six.match(/performance\.now\(\) \+ 120_000/g)).toHaveLength(3);
    expect(six).toContain('requireLifecyclePrefixEmpty, requireLifecycleClaimFence');
    const capture = normal.slice(normal.indexOf('export async function captureSixPreservation'), normal.indexOf('export async function readSixPreservation'));
    expect(capture).toContain('requireEvidence(jpg.length === 632)');
    expect(capture).toContain('main_sha256: sha256(jpg), thumb_sha256: sha256(jpg)');
    expect(capture).toContain('body: jpg, binary: true');
    expect(capture).not.toContain('h.upload');
    expect(capture.indexOf('await h.deleteItem(tombstone)')).toBeLessThan(capture.indexOf('await capturePrivate('));
    expect(capture.indexOf('await capturePrivate(')).toBeLessThan(capture.indexOf('await captureData('));
    const probes = normal.slice(normal.indexOf('export async function probeSixPreservation'), normal.indexOf('export async function functionalProbes'));
    expect(probes.indexOf('sha256(found.data)')).toBeLessThan(probes.indexOf('await h.finalize('));
    expect(probes).toContain('isDeepStrictEqual(await h.reserve(value), receipt)');
    expect(probes).not.toMatch(/h\.upload|analyz|provider/);
  });
});

describe('CI-only preservation guards', () => {
  it('requires all literal opt-ins and zero arguments', () => {
    expect(() => assertRehearsalEnvironment(validEnv, [])).not.toThrow();
    for (const key of Object.keys(validEnv)) for (const value of [undefined, '', 'false', '0', 'TRUE', ' true ', true, 1]) {
      expect(() => assertRehearsalEnvironment({ ...validEnv, [key]: value }, [])).toThrow();
    }
    for (const args of [['--local'], ['--help'], ['--db-url', 'https://example.test'], ['20260906000000'], [''], null]) {
      expect(() => assertRehearsalEnvironment(validEnv, args)).toThrow();
    }
    for (const key of ['SERVICE_ROLE_KEY', 'DATABASE_URL', 'SUPABASE_ACCESS_TOKEN', 'PGPASSWORD']) {
      expect(() => assertRehearsalEnvironment({ ...validEnv, [key]: 'fictional-refused' }, [])).toThrow();
    }
  });
  it('pins exactly fourteen regular migrations, preserving all thirteen earlier lengths and hashes', async () => {
    expect(inventory().map((entry) => entry.version)).toEqual(['20260905000000', '20260906000000', '20260909070000', '20260909110000', '20260909180000', '20260910070000', '20260911040000', '20260911200000', '20260913120000', '20260921193000', '20260922020000', '20260924100000', '20260924100100', '20260925100000']);
    expect(() => validateInventory(inventory())).not.toThrow();
    await expect(assertMigrationInventory()).resolves.toBeUndefined();
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) for (const [key, value] of [
      ['name', 'unexpected.sql'], ['bytes', 0], ['bytes', present(inventory()[index]).bytes + 1],
      ['sha256', 'b'.repeat(64)], ['regular', false], ['symlink', true],
    ]) {
      const bad = inventory();
      Object.assign(present(bad[index]), { [key as string]: value });
      expect(() => validateInventory(bad)).toThrow();
    }
    for (const bad of [[], inventory().slice(1), inventory().slice(0, 2), [...inventory(), inventory()[0]],
      [inventory()[0], inventory()[1], inventory()[1]]]) {
      expect(() => validateInventory(bad)).toThrow();
    }
  });
  it('covers every old column from the pinned base SQL, including composite identities', async () => {
    const sql = await readFile(path.join(root, 'supabase/migrations/20260905000000_initial.sql'), 'utf8');
    for (const table of tables) {
      const definition = present(new RegExp(`create table public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1]);
      const names = [...definition.matchAll(/(?:^|\n|,)\s*([a-z_][a-z0-9_]*)\s+(?:uuid|text|boolean|numeric|timestamptz|bigint|smallint|date|integer)\b/g)]
        .map((match) => match[1]);
      expect(columns[table].split(' ').sort()).toEqual(names.sort());
    }
  });
  it('requires successful help with exact flags, not guessed capability', () => {
    const help = [{ code: 0, stdout: '  --local local\n  --version string version\n' },
      { code: 0, stdout: '  --local local\n' }, { code: 0, stdout: '  --local local\n' }];
    expect(() => assertCapabilities(help)).not.toThrow();
    for (const index of [0, 1, 2]) for (const replacement of [
      { code: 1, stdout: present(help[index]).stdout }, { code: 0, stdout: '' },
      { code: 0, stdout: 'text mentions --local and --version' },
      { code: 0, stdout: '  --local-only\n  --versioned\n' },
    ] as const) {
      const bad = [...help]; bad[index] = replacement;
      expect(() => assertCapabilities(bad)).toThrow();
    }
    expect(() => assertCapabilities(help.slice(1))).toThrow();
    expect(() => assertCapabilities([{ code: 0, stdout: '  --local\n' }, ...help.slice(1)])).toThrow();
  });
  it('parses source-derived applied/pending tables without claiming execution', () => {
    expect(assertHistory(baseTable, 'base')).toEqual({ applied: ['20260905000000'], pending: ['20260906000000', '20260909070000', '20260909110000', '20260909180000', '20260910070000', '20260911040000', '20260911200000', '20260913120000', '20260921193000', '20260922020000', '20260924100000', '20260924100100', '20260925100000'] });
    expect(assertHistory(targetTable, 'target')).toEqual({ applied: ['20260905000000', '20260906000000', '20260909070000', '20260909110000', '20260909180000', '20260910070000', '20260911040000', '20260911200000', '20260913120000', '20260921193000', '20260922020000', '20260924100000', '20260924100100', '20260925100000'], pending: [] });
    expect(assertHistory(priorMainTable, 'prior-main')).toEqual({ applied: ['20260905000000', '20260906000000', '20260909070000', '20260909110000', '20260909180000', '20260910070000', '20260911040000', '20260911200000', '20260913120000'], pending: ['20260921193000', '20260922020000', '20260924100000', '20260924100100', '20260925100000'] });
    expect(assertHistory(azureTable, 'azure-target')).toEqual({
      applied: inventory().slice(0, 10).map((entry) => entry.version), pending: ['20260922020000', '20260924100000', '20260924100100', '20260925100000'],
    });
    expect(assertHistory(imageChangeTable, 'image-change')).toEqual({
      applied: inventory().slice(0, 11).map((entry) => entry.version), pending: ['20260924100000', '20260924100100', '20260925100000'],
    });
    expect(assertHistory(coloursTable, 'colours')).toEqual({
      applied: inventory().slice(0, 12).map((entry) => entry.version), pending: ['20260924100100', '20260925100000'],
    });
    for (const [table, stage] of [[imageChangeTable, 'target'], [imageChangeTable, 'colours'], [coloursTable, 'target'],
      [coloursTable, 'image-change'], [targetTable, 'colours'], [azureTable, 'image-change']] as const)
      expect(() => assertHistory(table, stage)).toThrow();
    expect(() => assertHistory(azureTable, 'target')).toThrow();
    expect(() => assertHistory(targetTable, 'azure-target')).toThrow();
    for (const [table, stage] of [[baseTable, 'prior-main'], [targetTable, 'prior-main'],
      [priorMainTable, 'base'], [priorMainTable, 'target']])
      expect(() => assertHistory(table, stage)).toThrow();
    expect(() => assertHistory(priorMainTable.replace('`20260913120000` | `20260913120000`',
      '`20260913120000` | ` `             '), 'prior-main')).toThrow();
    expect(() => assertHistory(targetTable, 'base')).toThrow();
    expect(() => assertHistory(baseTable, 'target')).toThrow();
    expect(() => assertHistory(baseTable, 'other')).toThrow();
    expect(assertHistory(baseTable.replaceAll('\n', '\r\n'), 'base')).toEqual(parseMigrationHistory(baseTable));
    expect(assertHistory(targetTable.replaceAll('\n', '\r\n'), 'target')).toEqual(parseMigrationHistory(targetTable));
    expect(assertHistoryResult({ code: 0, stdout: baseTable }, 'base')).toEqual(parseMigrationHistory(baseTable));
  });
  it('retains SOURCE-DERIVED renderer padding, widths and decorative blank lines', () => {
    for (const table of [baseTable, priorMainTable, azureTable, imageChangeTable, coloursTable, targetTable]) {
      const lines = table.split('\n');
      expect(lines).toHaveLength(20);
      expect(lines.slice(0, 2)).toEqual(['', '  ']);
      expect(lines.slice(-2)).toEqual(['', '']);
      for (const line of lines.slice(2, -2)) {
        expect(line.startsWith('  ')).toBe(true);
        expect(line.slice(2).split('|').map((cell) => cell.length)).toEqual([18, 18, 23]);
      }
    }
  });
  it.each([
    '', '[]', 'PASS', baseTable + 'unexpected', baseTable.replace('Local', 'LOCAL'),
    baseTable.replaceAll('|', '│'), baseTable.replace('----------------', '-----+----------'),
    baseTable.replace('20260906000000', '20260907000000'),
    baseTable.replace('20260906000000', '20260905000000'),
    baseTable.replace('`20260905000000` | `20260905000000`', '` ` | `20260905000000`'),
    baseTable.replace('`20260906000000` | ` `', '`20260906000000` | `20260907000000`'),
    baseTable.replace('2026-09-06 00:00:00', '2026-09-07 00:00:00'),
    baseTable.replace('20260906000000', '`20260906000000`'),
    baseTable.replace('20260905000000', '\x1b[0m20260905000000'),
    baseTable.split('\n').slice(0, -3).join('\n'),
    baseTable + baseTable.split('\n')[4] + '\n',
    baseTable.replace('`20260905000000` | `20260905000000`', '`20260905000000` | ` `'),
    baseTable.replace('`20260905000000` | `20260905000000`', '`20260905000000` | `20260906000000`'),
    baseTable.replace('`20260905000000` | `20260905000000`', '`20260905000000`'),
    baseTable.replace('`20260905000000` | `20260905000000`', '`20260905000000` | `20260905000000` | ` `'),
    baseTable.replace('Local', '`Local`'),
    baseTable.replace('2026-09-06 00:00:00', '2026-09-06T00:00:00'),
    baseTable.replace('2026-09-06 00:00:00', '2026-09-06  00:00:00'),
    baseTable.replace('2026-09-06 00:00:00', '2026-09-06 00:00:01'),
    baseTable.replace('20260909070000', '20260906000000'),
    baseTable.replace('20260909070000', '20260910070000'),
    baseTable.replace('2026-09-09 07:00:00', '2026-09-09 00:00:00'),
    baseTable.replace('`20260909070000` | ` `', '`20260909070000` | `20260909070000`'),
    baseTable.replace('`20260906000000` | ` `', '`20260906000000` | `20260906000000`'),
    baseTable.replaceAll('`', ''),
    baseTable.replace('\n   `20260906000000`', '\n\n   `20260906000000`'),
    baseTable.split('\n').map((line, index, lines) => index === 4 ? lines[5] : index === 5 ? lines[4] : line).join('\n'),
    ' '.repeat(4097),
    baseTable.replace('Local', '\tLocal'),
    baseTable.replace('Local', '\0Local'),
  ])('rejects malformed, missing, duplicate or unknown history %#', (value) => {
    expect(() => assertHistory(value, 'base')).toThrow();
    expect(() => assertHistory(value.replaceAll('\n', '\r\n'), 'base')).toThrow();
  });
  it.each(['`20260905000000`', '` `', '`2026-09-05 00:00:00`'])('strictly validates quoted source-derived body cell %s', (cell) => {
    for (const replacement of [
      cell.slice(1, -1), cell.slice(1), cell.slice(0, -1), '`' + cell + '`',
      cell.slice(0, 2) + '`' + cell.slice(2), '``', '`  `', '`   `',
      '` ' + cell.slice(1), cell.slice(0, -1) + ' `',
    ]) {
      expect(() => assertHistory(baseTable.replace(cell, replacement), 'base')).toThrow('EVIDENCE_REQUIRED');
    }
  });
  it.each([
    ['length-cap', ' '.repeat(4097)],
    ['charset', baseTable.replace('Local', '\x1bLocal')],
    ['line-count', ''],
    ['header', baseTable.replace('Local', 'LOCAL')],
    ['separator', baseTable.replace('----------------', '-----+----------')],
    ['cell-count', baseTable.replace('`20260905000000` |', '')],
    ['cell-quoting', baseTable.replace('`20260905000000`', '20260905000000')],
    ['cell-content', baseTable.replace('` `', '``')],
    ['version-mismatch', baseTable.replace('20260906000000', '20260907000000')],
    ['remote-mismatch', baseTable.replace('` `', '`20260907000000`')],
    ['time-mismatch', baseTable.replace('2026-09-06', '2026-09-07')],
    ['inventory-mismatch', targetTable],
  ])('reports only the closed history reason %s', (reason, stdout) => {
    let failure: unknown;
    try { assertHistoryResult({ code: 0, stdout }, 'base'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('EVIDENCE_REQUIRED');
    expect(historyFailureDetail(failure)).toBe(`; reason=${reason}`);
    expect(assertHistory(baseTable, 'base')).toEqual({ applied: ['20260905000000'], pending: ['20260906000000', '20260909070000', '20260909110000', '20260909180000', '20260910070000', '20260911040000', '20260911200000', '20260913120000', '20260921193000', '20260922020000', '20260924100000', '20260924100100', '20260925100000'] });
  });
  it('distinguishes history command failure without forwarding command output or arbitrary errors', () => {
    const privateText = 'arbitrary upstream text /private/fixture-path';
    for (const code of [1, 2, null, undefined, '0']) {
      let failure: unknown;
      try { assertHistoryResult({ code, stdout: privateText, stderr: privateText }, 'base'); } catch (error) { failure = error; }
      expect(historyFailureDetail(failure)).toBe('; reason=history-command');
      expect((failure as Error).message).toBe('EVIDENCE_REQUIRED');
      Object.assign(failure as Error, { reason: privateText });
      expect(historyFailureDetail(failure)).toBe('');
    }
    for (const failure of [new Error(privateText), new Error('cell-quoting'), privateText,
      { reason: 'history-command', message: privateText }, null, undefined]) {
      expect(historyFailureDetail(failure)).toBe('');
    }
  });
  it('derives untrimmed source export bodies; this is not a database observation', async () => {
    for (const [name, bytes, md5] of [
      ['20260905000000_initial.sql', 1452, 'a8188b771786538ec7ef031d9d974fce'],
      ['20260909180000_ai_request_controls.sql', 1511, '689a81770938d05caa3a3f800ae3ecef'],
    ] as const) {
      const sql = await readFile(path.join(root, 'supabase', 'migrations', name), 'utf8');
      expect(exportBodyEvidence(sql)).toEqual({ bytes, md5 });
      expect(() => exportBodyEvidence(sql + sql)).toThrow();
      const declaration = 'function public.export_manifest(p_export_id uuid) returns jsonb\nlanguage sql stable security invoker set search_path = \'\' as $$';
      expect(() => exportBodyEvidence(sql.replace(declaration, declaration.replace('$$', '$body$')))).toThrow();
      const start = sql.indexOf('\n  select case when private.is_approved() then jsonb_build_object(');
      expect(() => exportBodyEvidence(sql.slice(0, start + 20))).toThrow();
    }
  });
});

describe('I29b description SQL contract (static, not database execution)', () => {
  it('bounds the counter independently of text, including empty counter-1 restores', async () => {
    const sql = await readFile(path.join(root, 'supabase/migrations/20260909070000_item_description_edit.sql'), 'utf8');
    expect(sql).toContain('add column description_version bigint not null default 1\n    check (description_version between 1 and 2147483647)');
    expect(sql).toContain('drop constraint item_images_alt_text_check,\n  add constraint item_images_alt_text_check check (length(alt_text) between 0 and 240)');
    expect(sql).not.toMatch(/alter column|description_version\s*=\s*1\b|insert into|delete from/i);
    expect(sql).toContain('p_expected_description_version is null');
    expect(sql).toContain('p_expected_description_version not between 1 and 2147483647');
    expect(sql).toContain('p_alt_text is null or length(p_alt_text)>240');
    expect(sql).toContain('p_image_id is null');
    const ceiling = 2147483647n;
    const matches = (stored: bigint, expected: bigint) => stored >= 1n && stored === expected && stored < ceiling;
    expect(matches(ceiling - 1n, ceiling - 1n)).toBe(true);
    expect(ceiling - 1n + 1n).toBe(ceiling);
    for (const [stored, expected] of [[ceiling, ceiling], [1n, 0n], [1n, -1n], [1n, ceiling + 1n], [2n, 1n]]) {
      expect(matches(present(stored), present(expected))).toBe(false);
    }
  });
  it('has one owner/admission/ready/CAS UPDATE, minimal return and no parent locks or new table grants', async () => {
    const sql = await readFile(path.join(root, 'supabase/migrations/20260909070000_item_description_edit.sql'), 'utf8');
    const executable = sql.replace(/^ *--.*$/gm, '');
    expect(executable.match(/\bupdate public\./g)).toHaveLength(1);
    expect(sql).toContain('returns table(id uuid, owner_id uuid, item_id uuid, alt_text text, description_version bigint)');
    expect(sql).toContain("language plpgsql volatile security definer set search_path = ''");
    expect(sql).toContain('if not private.is_approved() or auth.uid() is null then');
    expect(sql).toContain('set alt_text=p_alt_text, description_version=im.description_version+1');
    expect(sql).toContain("where im.id=p_image_id and im.owner_id=auth.uid()\n      and im.state='ready' and im.retired_at is null");
    expect(sql).toContain('and im.description_version=p_expected_description_version\n      and im.description_version<2147483647');
    expect(sql).toContain('where item.id=im.item_id and item.owner_id=auth.uid() and item.deleted_at is null');
    expect(sql).toContain('returning im.id,im.owner_id,im.item_id,im.alt_text,im.description_version;\n  if found then return; end if;');
    expect(executable).not.toMatch(/\bfor\s+(?:update|share|key\s+share|no\s+key\s+update)|\block\b|\bexecute\s+['"]|\bgrant\s+(?:insert|update|delete|all)|storage\.|public\.(?:commit_image|retire_image)/i);
    expect(sql).toContain('revoke all on function public.update_image_description(uuid,bigint,text) from public,anon,authenticated;');
    expect(sql).toContain('grant execute on function public.update_image_description(uuid,bigint,text) to authenticated;');
    expect(executable.match(/message='[^']+'/g)?.sort()).toEqual([
      "message='Invalid input'", "message='Not available'", "message='Not available'", "message='Request conflict'",
    ]);
    expect(sql).toMatch(/^--[^\n]*\nbegin;[\s\S]*\ncommit;\n$/);
    const base = await readFile(path.join(root, 'supabase/migrations/20260905000000_initial.sql'), 'utf8');
    expect(base).toContain('revoke update on public.item_images from authenticated;');
    expect(base).toContain('revoke delete on public.item_images from authenticated;');
    expect(base).toContain('grant insert(id,owner_id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)\n  on public.item_images to authenticated;');
  });
});

describe('I10b void and cleanup source contracts (static, not runtime evidence)', () => {
  it('pins the actual closed, disjoint RPC sets to the reviewed return classes', async () => {
    const source = await readFile(path.join(root, 'tests/integration/preservation.sessions.mjs'), 'utf8');
    const names = (set: string) => {
      const match = source.match(new RegExp(`const ${set} = new Set\\(\\[([^\\]]+)\\]\\);`));
      expect(match).not.toBeNull();
      return [...present(match?.[1]).matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    };
    const voids = names('voidRpcs'), nullable = names('nullableRpcs');
    expect(voids).toEqual(['commit_image', 'retire_image', 'forget_image']);
    expect(nullable).toEqual(['image_change_status', 'cancel_image_change', 'item_deletion_operation_status', 'item_deletion_next_target']);
    expect(voids.filter((name) => nullable.includes(name))).toEqual([]);
    const sql = await readFile(path.join(root, 'supabase/migrations/20260905000000_initial.sql'), 'utf8');
    for (const name of voids) expect(sql).toContain(`create function public.${name}(p_image_id uuid) returns void`);
    expect(source).toContain("new Set([...nullableRpcs].map((name) => `/rest/v1/rpc/${name}`))");
    expect(source).not.toMatch(/export const (?:voidRpcs|nullableRpcs)/);
  });
  it('pins six bounded forward cleanup substeps without changing operations or assertions', async () => {
    const source = await readFile(path.join(root, 'tests/integration/azure-preservation.sessions.mjs'), 'utf8');
    const verifier = source.slice(source.indexOf('export async function verifyImageChangePreservation('), source.indexOf('async function imageChangeStructure('));
    expect(verifier).toContain('for (const [ownerIndex, owner] of owners.entries()) {');
    expect(verifier).toContain('const ownerOrdinal = [1, 2][ownerIndex];');
    expect(verifier).toContain('requireEvidence(ownerOrdinal === 1 || ownerOrdinal === 2);');
    expect(verifier).toContain('for (const n of [21, 22, 23, 24]) {');
    const start = verifier.indexOf("      if (replacement) {");
    const end = verifier.indexOf("\n    }\n    mark('owner-restoration');", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const block = verifier.slice(start, end);
    const steps = ['recovery-object', 'replacement-object', 'forget', 'history-unlink', 'legacy-object', 'item-delete'];
    expect([...block.matchAll(/mark\(`item-cleanup-([^`]+)`\);/g)].map((match) => match[1]))
      .toEqual(steps.map((step) => `${step}-o\${ownerOrdinal}-n\${n}`));
    expect(block.replace(/^\s*mark\(`item-cleanup-[^`]+`\);\n/gm, '').trim()).toBe([
      'if (replacement) {',
      '        await replacementHarness.remove(recovery);',
      '        await replacementHarness.remove(replacement);',
      "        await client.rpc(owner, 'forget_image', { p_image_id: replacement.imageId });",
      "        const unlinked = await client.rpc(owner, 'item_attribution_history', { p_item_id: value.p_item.id });",
      '        equal(unlinked, [history[0], { ...history[1], source_image_id: null }]);',
      '      }',
      '      await h.remove(value);',
      '      await h.deleteItem(value);',
    ].join('\n'));
    const operations = ['await replacementHarness.remove(recovery);', 'await replacementHarness.remove(replacement);',
      "await client.rpc(owner, 'forget_image',", "const unlinked = await client.rpc(owner, 'item_attribution_history',",
      'await h.remove(value);', 'await h.deleteItem(value);'];
    for (const [index, step] of steps.entries()) {
      expect(block).toContain(`mark(\`item-cleanup-${step}-o\${ownerOrdinal}-n\${n}\`);\n${index < 4 ? '        ' : '      '}${operations[index]}`);
    }
    expect(verifier).not.toContain("mark('item-cleanup')");
    expect((verifier.match(/\$\{ownerOrdinal\}/g) ?? [])).toHaveLength(6);
    expect(new Set(steps.flatMap((step) => [1, 2].flatMap((owner) => [21, 22, 23, 24].map((n) =>
      `item-cleanup-${step}-o${owner}-n${n}`)))).size).toBe(48);
  });
});

describe('preservation HTTP boundary (stubbed, not live evidence)', () => {
  const env = {
    ALLOW_SECURITY_TESTS: '1', SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_fixture',
    TEST_A_EMAIL: 'user-a@example.test', TEST_B_EMAIL: 'user-b@example.test',
    TEST_A_PASSWORD: 'a'.repeat(24), TEST_B_PASSWORD: 'b'.repeat(24),
  };
  const owner = { label: 'A', uid: owners[0], token: 'fictional-a' };
  const other = { label: 'B', uid: owners[1], token: 'fictional-b' };
  const client = () => normalClient(env);
  const respond = (response: Response) => vi.stubGlobal('fetch', vi.fn(async () => response));
  const json = (value: Value, status = 200) => new Response(JSON.stringify(value), { status });
  const empty = () => new Response(null, { status: 204 });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  describe('strict void RPC contracts (real client, fetch/Response mocked only)', () => {
    const names = ['commit_image', 'retire_image', 'forget_image'];
    const args = { p_image_id: run };
    describe.each(names)('%s', (name) => {
      it.each([owner, other])('accepts only bodyless 204 with exact forwarding for $label', async (session) => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(empty());
        vi.stubGlobal('fetch', fetch);
        await expect(client().rpc(session, name, args)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledOnce();
        const [url, options] = present(fetch.mock.calls[0]);
        expect(url).toBe(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`);
        expect(options?.method).toBe('POST'); expect(options?.body).toBe(JSON.stringify(args));
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer '.concat(session.token));
      });
      it.each(['null', '', '{"state":"ready"}'])('refuses 200 with %j', async (raw) => {
        respond(new Response(raw));
        await expect(client().rpc(owner, name, args)).rejects.toThrow('EVIDENCE_REQUIRED');
      });
      it.each([201, 202, 400, 401, 403, 404, 409])('refuses non-204 status %s', async (status) => {
        respond(json({ code: 'synthetic-private' }, status));
        await expect(client().rpc(owner, name, args)).rejects.toThrow('EVIDENCE_REQUIRED');
      });
      it.each([204, 500, 502, 503, 504])('refuses malformed 204 or server status %s before body reads', async (status) => {
        const response = new Response('synthetic-private');
        vi.spyOn(response, 'status', 'get').mockReturnValue(status);
        const stream = present(response.body ?? undefined), getReader = vi.spyOn(stream, 'getReader');
        respond(response);
        const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
        await expect(client().rpc(owner, name, args)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(getReader).not.toHaveBeenCalled();
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      });
      it('preserves a fetch rejection without retry', async () => {
        const error = new Error('synthetic-private-fetch');
        const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
        vi.stubGlobal('fetch', fetch);
        await expect(client().rpc(owner, name, args)).rejects.toBe(error);
        expect(fetch).toHaveBeenCalledOnce();
      });
      it.each(['read', 'cancel', 'read-and-cancel'])('retains %s identity and finally precedence on non-204 responses', async (failure) => {
        const response = json(null), stream = present(response.body ?? undefined), reader = stream.getReader();
        const readError = new Error('synthetic-private-read'), cancelError = new Error('synthetic-private-cancel');
        const read = vi.spyOn(reader, 'read'), cancel = vi.spyOn(reader, 'cancel');
        if (failure !== 'cancel') read.mockRejectedValue(readError);
        if (failure !== 'read') cancel.mockRejectedValue(cancelError);
        vi.spyOn(stream, 'getReader').mockReturnValue(reader);
        respond(response);
        await expect(client().rpc(owner, name, args)).rejects.toBe(failure === 'read' ? readError : cancelError);
        expect(cancel).toHaveBeenCalledOnce();
      });
    });
    it.each(['image_change_status', 'cancel_image_change', 'item_deletion_operation_status', 'item_deletion_next_target',
      'image_change_requests', 'complete_image_change',
      ...names.flatMap((name) => [`${name}/`, `${name}?unit=1`, `${name}_other`, `prefix_${name}`, name.toUpperCase()])])(
      'does not grant the void response contract to %s', async (name) => {
        respond(empty());
        await expect(client().rpc(owner, name, args)).rejects.toThrow('EVIDENCE_REQUIRED');
      });
  });

  describe('strict nullable RPC contracts (real client, fetch/Response mocked only)', () => {
    const names = ['image_change_status', 'cancel_image_change', 'item_deletion_operation_status', 'item_deletion_next_target'];
    const value = { itemId: run, requestId: owners[1] };
    const args = { p_item_id: value.itemId, p_request_id: value.requestId };
    function invoke(name: string, session = owner) {
      const transport = client(), h = imageChangeHarness(transport, session, env);
      return name === 'image_change_status' ? h.status(value)
        : name === 'cancel_image_change' ? h.cancel(value) : transport.rpc(session, name, args);
    }
    describe.each(names)('%s', (name) => {
      const route = `/rest/v1/rpc/${name}`;
      it.each(['null', ' \nnull\t\r\n'])('accepts parsed JSON %j through the real caller', async (raw) => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(raw));
        vi.stubGlobal('fetch', fetch);
        const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
        await expect(invoke(name)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledOnce();
        const [url, options] = present(fetch.mock.calls[0]);
        expect(url).toBe(env.SUPABASE_URL + route);
        expect(options?.method).toBe('POST');
        expect(options?.body).toBe(JSON.stringify(args));
        const headers = new Headers(options?.headers);
        expect(headers.get('authorization')).toBe('Bearer '.concat(owner.token));
        expect(headers.get('apikey')).toBe(env.SUPABASE_PUBLISHABLE_KEY);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      });
      it.each([owner, other])('preserves non-null values and session forwarding for $label', async (session) => {
        const receipt = { requestId: value.requestId, itemId: value.itemId, state: 'reserved' };
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(receipt));
        vi.stubGlobal('fetch', fetch);
        await expect(invoke(name, session)).resolves.toEqual(receipt);
        expect(fetch).toHaveBeenCalledOnce();
        const [url, options] = present(fetch.mock.calls[0]);
        expect(url).toBe(env.SUPABASE_URL + route);
        expect(options?.body).toBe(JSON.stringify(args));
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer '.concat(session.token));
      });
      it('emits no observer label for successfully parsed null', async () => {
        respond(json(null));
        const onFailure = vi.fn();
        await expect(client().request(owner.token, route, { method: 'POST', body: args, onFailure }))
          .resolves.toEqual({ ok: true, status: 200, data: null, range: null });
        expect(onFailure).not.toHaveBeenCalled();
      });
      it.each(['', ' ', 'synthetic-private-not-json'])('refuses blank or malformed bytes %j at the parser', async (raw) => {
        respond(new Response(raw));
        const onFailure = vi.fn(), logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
        await expect(client().request(owner.token, route, { method: 'POST', body: args, onFailure }))
          .rejects.toThrow('EVIDENCE_REQUIRED');
        expect(onFailure.mock.calls).toEqual([['nonjson-200']]);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
        expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(/synthetic-private|fictional-a/);
      });
      it('refuses an absent 200 body before parsing', async () => {
        respond(new Response(null));
        await expect(invoke(name)).rejects.toThrow('EVIDENCE_REQUIRED');
      });
      it.each([201, 202, 204, 400, 401, 403, 404, 409])('refuses status %s even with null data', async (status) => {
        respond(status === 204 ? empty() : json(null, status));
        await expect(invoke(name)).rejects.toThrow('EVIDENCE_REQUIRED');
      });
      it.each([500, 502, 503, 504])('refuses %s before body access', async (status) => {
        const response = json({ message: 'synthetic-private-body' }, status);
        const body = vi.spyOn(response, 'body', 'get');
        respond(response);
        await expect(invoke(name)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(body).not.toHaveBeenCalled();
      });
      it('retains the exact byte bound and cancels an oversized response', async () => {
        respond(new Response(' '.repeat(MAX_SNAPSHOT_BYTES - 4) + 'null'));
        await expect(invoke(name)).resolves.toBeNull();
        const response = new Response(' '.repeat(MAX_SNAPSHOT_BYTES - 3) + 'null');
        const stream = present(response.body ?? undefined), reader = stream.getReader();
        const cancel = vi.spyOn(reader, 'cancel');
        vi.spyOn(stream, 'getReader').mockReturnValue(reader);
        respond(response);
        await expect(invoke(name)).rejects.toThrow('EVIDENCE_REQUIRED');
        expect(cancel).toHaveBeenCalledOnce();
      });
      it('preserves the exact fetch rejection without retry', async () => {
        const error = new Error('synthetic-private-fetch');
        const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
        vi.stubGlobal('fetch', fetch);
        await expect(invoke(name)).rejects.toBe(error);
        expect(fetch).toHaveBeenCalledOnce();
      });
      it.each(['read', 'cancel', 'read-and-cancel'])('preserves %s rejection and finally precedence', async (failure) => {
        const response = json(null), stream = present(response.body ?? undefined), reader = stream.getReader();
        const readError = new Error('synthetic-private-read'), cancelError = new Error('synthetic-private-cancel');
        const read = vi.spyOn(reader, 'read'), cancel = vi.spyOn(reader, 'cancel');
        if (failure !== 'cancel') read.mockRejectedValue(readError);
        if (failure !== 'read') cancel.mockRejectedValue(cancelError);
        vi.spyOn(stream, 'getReader').mockReturnValue(reader);
        respond(response);
        await expect(invoke(name)).rejects.toBe(failure === 'read' ? readError : cancelError);
        expect(cancel).toHaveBeenCalledOnce();
      });
    });
    it.each(['image_change_requests', 'ai_status', 'save_outfit',
      ...names.flatMap((name) => [`${name}_other`, `${name}/`, `${name}?unit=1`, `prefix_${name}`, name.toUpperCase()])])(
      'does not make %s nullable', async (name) => {
        respond(json(null));
        await expect(client().rpc(owner, name, args)).rejects.toThrow('EVIDENCE_REQUIRED');
      });
    it.each(names.flatMap((name) => [`${name}/`, `${name}?unit=1`, `${name}_other`, `prefix_${name}`]))(
      'does not expand empty-body parser tightening to near route %s', async (name) => {
        respond(new Response(''));
        await expect(client().request(owner.token, `/rest/v1/rpc/${name}`, { method: 'POST', body: args }))
          .resolves.toEqual({ ok: true, status: 200, data: null, range: null });
      });
    it('retains commit_image as exactly bodyless 204, not a nullable 200 RPC', async () => {
      respond(empty());
      await expect(client().rpc(owner, 'commit_image', { p_image_id: run })).resolves.toBeNull();
      for (const data of [null, { state: 'ready' }]) {
        respond(json(data));
        await expect(client().rpc(owner, 'commit_image', { p_image_id: run })).rejects.toThrow('EVIDENCE_REQUIRED');
      }
    });
  });

  describe('real client plus real replacement harness (fetch/Response mocked only)', () => {
    const variants = ['main', 'thumb'] as const;
    type Variant = typeof variants[number];
    const value = { requestId: run, itemId: run, imageId: owners[1] };
    function composed(response: Response, variant: Variant = 'main', marked = true) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      if (variant === 'thumb') fetch.mockResolvedValueOnce(json({ uploaded: true }, 200));
      vi.stubGlobal('fetch', fetch);
      let stage = 'I10b-preservation-replacement-upload';
      const mark = vi.fn((label: string) => { stage = `I10b-preservation-${label}`; });
      const transport = client();
      const h = marked ? imageChangeHarness(transport, owner, env, mark) : imageChangeHarness(transport, owner, env);
      const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
      return { fetch, mark, h, transport, logs, stage: () => stage };
    }
    function expectFailure(f: ReturnType<typeof composed>, variant: Variant, reason: string) {
      expect(f.stage()).toBe(`I10b-preservation-upload-${variant}-${reason}`);
      expect(f.mark.mock.calls).toEqual([
        ['upload-main-attempt'], ...(variant === 'thumb' ? [['upload-thumb-attempt']] : []),
        [`upload-${variant}-${reason}`],
      ]);
      expect(f.fetch).toHaveBeenCalledTimes(variant === 'main' ? 1 : 2);
      for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      expect(JSON.stringify(f.mark.mock.calls)).not.toMatch(/synthetic-private|fictional-a/);
      expect(JSON.stringify(f.mark.mock.calls)).not.toContain(owner.uid);
    }
    it('demonstrates the old pre-return miss without moving the 5xx guard or reading its body', async () => {
      const response = json({ code: 'synthetic-private-code', message: 'synthetic-private-body' }, 503);
      const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
      respond(response);
      const reachedOuterClassifier = vi.fn();
      await expect((async () => {
        const result = await client().request(owner.token, `/storage/v1/object/wardrobe/${owner.uid}/${run}/${run}/main.jpg`,
          { method: 'POST', binary: true, body: new Uint8Array([0]) });
        reachedOuterClassifier(result);
      })()).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(reachedOuterClassifier).not.toHaveBeenCalled();
      expect(getReader).not.toHaveBeenCalled();
    });
    it.each(variants.flatMap((variant) => [500, 502, 503, 504].map((status) => ({ variant, status }))))(
      'reports $variant status5xx-$status without any body access', async ({ variant, status }) => {
        const response = json({ code: '22023', message: 'synthetic-private-message',
          details: { token: 'synthetic-private-token' }, hint: owner.uid }, status);
        const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
        const body = vi.spyOn(response, 'body', 'get');
        const f = composed(response, variant);
        await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expectFailure(f, variant, `status5xx-${status}`);
        expect(body).not.toHaveBeenCalled(); expect(getReader).not.toHaveBeenCalled();
      });
    it.each(variants)('never emits an unlisted 5xx status or secret code for %s', async (variant) => {
      const response = json({ code: 'synthetic-private-code'.repeat(100), message: owner.token }, 598);
      const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
      const f = composed(response, variant);
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, variant, 'status5xx-OTHER'); expect(getReader).not.toHaveBeenCalled();
    });
    it.each(variants.flatMap((variant) => [400, 422].map((status) => ({ variant, status }))))(
      'reports $variant nonJSON$status without disclosing the response text', async ({ variant, status }) => {
        const response = new Response('synthetic-private-nonjson-token-and-path', { status });
        const f = composed(response, variant);
        await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
        expectFailure(f, variant, `nonjson-${status}`);
      });
    it('uses OTHER rather than an unlisted nonJSON response status', async () => {
      const f = composed(new Response('synthetic-private-raw', { status: 418 }));
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, 'main', 'nonjson-OTHER');
    });
    it.each(variants)('retains the malformed204 guard before reading %s', async (variant) => {
      const response = new Response('synthetic-private-body');
      vi.spyOn(response, 'status', 'get').mockReturnValue(204);
      const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
      const f = composed(response, variant);
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, variant, 'body-on-204'); expect(getReader).not.toHaveBeenCalled();
    });
    it.each(variants)('retains missing non204 body refusal for %s', async (variant) => {
      const f = composed(new Response(null, { status: 400 }), variant);
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, variant, 'no-body-400');
    });
    it('does not emit an unlisted missing-body status', async () => {
      const f = composed(new Response(null, { status: 418 }));
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, 'main', 'no-body-OTHER');
    });
    it.each(variants)('retains the exact response bound and cancellation on %s overflow', async (variant) => {
      const response = new Response(new Uint8Array(MAX_SNAPSHOT_BYTES + 1));
      const stream = present(response.body ?? undefined), reader = stream.getReader();
      const cancel = vi.spyOn(reader, 'cancel');
      vi.spyOn(stream, 'getReader').mockReturnValue(reader);
      const f = composed(response, variant);
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, variant, 'overflow'); expect(cancel).toHaveBeenCalledOnce();
    });
    it('accepts a valid JSON response at the unchanged exact bound without an invariant class', async () => {
      const f = composed(new Response(JSON.stringify('x'.repeat(MAX_SNAPSHOT_BYTES - 2))));
      await expect(f.h.upload(value, ['main'])).resolves.toBeUndefined();
      expect(f.mark.mock.calls).toEqual([['upload-main-attempt']]);
      expect(f.fetch).toHaveBeenCalledOnce();
    });
    it.each(variants)('leaves parsed JSON400 refusal to the outer %s code classifier', async (variant) => {
      const f = composed(json({ code: 'AccessDenied', message: 'synthetic-private-message',
        details: { token: owner.token }, hint: owner.uid }, 400), variant);
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, variant, 'http-400-AccessDenied');
    });
    it('does not emit secret or prototype-looking unknown JSON codes', async () => {
      const f = composed(json({ code: 'synthetic-private-code'.repeat(100),
        message: 'synthetic-private-message', details: { code: '42501' }, hint: owner.uid,
        constructor: { code: '23505' }, data: { token: owner.token } }, 400));
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expectFailure(f, 'main', 'http-400-OTHER');
    });
    it('keeps successful native requests sequential with the same binary body, headers and finalize boundary', async () => {
      const f = composed(json({ uploaded: true }, 201));
      let release!: (response: Response) => void;
      f.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
      const pending = f.h.upload(value);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.mark.mock.calls).toEqual([['upload-main-attempt']]);
      release(empty());
      await pending;
      expect(f.mark.mock.calls).toEqual([['upload-main-attempt'], ['upload-thumb-attempt']]);
      const calls = f.fetch.mock.calls;
      expect(calls).toHaveLength(2);
      const body = present(calls[0]?.[1]).body;
      expect(body).toBeInstanceOf(Uint8Array);
      for (const [index, variant] of variants.entries()) {
        const [url, init] = present(calls[index]);
        expect(url).toBe(`${env.SUPABASE_URL}/storage/v1/object/wardrobe/${owner.uid}/${value.itemId}/${value.imageId}/${variant}.jpg`);
        expect(init).toEqual({ method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
          headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${owner.token}`,
            'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body });
        expect(init?.body).toBe(body);
      }
      f.mark('replacement-finalize');
      expect(f.stage()).toBe('I10b-preservation-replacement-finalize');
      for (const log of f.logs) expect(log).not.toHaveBeenCalled();
    });
    it.each([200, 201, 204])('never invokes the synchronous invariant observer on successful%s', async (status) => {
      respond(status === 204 ? empty() : json({ code: 'AccessDenied' }, status));
      const onFailure = vi.fn();
      await client().request(owner.token, '/storage/v1/object/wardrobe/unit',
        { method: 'POST', binary: true, body: new Uint8Array([0]), onFailure });
      expect(onFailure).not.toHaveBeenCalled();
    });
    it.each(variants.flatMap((variant) => ['fetch', 'read', 'cancel', 'read-and-cancel'].map((failure) => ({ variant, failure }))))(
      'retains $variant $failure sentinel identity and existing finally precedence', async ({ variant, failure }) => {
        const response = json({ uploaded: true });
        const stream = present(response.body ?? undefined), reader = stream.getReader();
        const read = vi.spyOn(reader, 'read'), cancel = vi.spyOn(reader, 'cancel');
        vi.spyOn(stream, 'getReader').mockReturnValue(reader);
        const fetchError = new Error('synthetic-private-fetch'), readError = new Error('synthetic-private-read'),
          cancelError = new Error('synthetic-private-cancel');
        const f = composed(response, variant);
        if (failure === 'fetch') f.fetch.mockRejectedValueOnce(fetchError);
        if (failure === 'read' || failure === 'read-and-cancel') read.mockRejectedValue(readError);
        if (failure === 'cancel' || failure === 'read-and-cancel') cancel.mockRejectedValue(cancelError);
        await expect(f.h.upload(value)).rejects.toBe(failure === 'fetch' ? fetchError : failure === 'read' ? readError : cancelError);
        expect(f.stage()).toBe(`I10b-preservation-upload-${variant}-attempt`);
        expect(f.mark.mock.calls).toEqual([['upload-main-attempt'], ...(variant === 'thumb' ? [['upload-thumb-attempt']] : [])]);
        expect(f.fetch).toHaveBeenCalledTimes(variant === 'main' ? 1 : 2);
        expect(cancel).toHaveBeenCalledTimes(failure === 'fetch' ? 0 : 1);
        for (const log of f.logs) expect(log).not.toHaveBeenCalled();
      });
    it.each(variants)('retains %s overflow label when finally cancellation replaces the original assertion error', async (variant) => {
      const response = new Response(new Uint8Array(MAX_SNAPSHOT_BYTES + 1));
      const stream = present(response.body ?? undefined), reader = stream.getReader();
      const sentinel = new Error('synthetic-private-cancel');
      const cancel = vi.spyOn(reader, 'cancel').mockRejectedValue(sentinel);
      vi.spyOn(stream, 'getReader').mockReturnValue(reader);
      const f = composed(response, variant);
      await expect(f.h.upload(value)).rejects.toBe(sentinel);
      expectFailure(f, variant, 'overflow'); expect(cancel).toHaveBeenCalledOnce();
    });
    it('keeps three-argument harness callers silent and failing normally', async () => {
      const f = composed(json({ code: 'synthetic-private-code' }, 503), 'main', false);
      await expect(f.h.upload(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(f.mark).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
      for (const log of f.logs) expect(log).not.toHaveBeenCalled();
    });
    it('does not silently extend the observer to reserve', async () => {
      const response = json({ code: 'synthetic-private-code' }, 503);
      const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
      const f = composed(response);
      await expect(f.h.reserve(value)).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(f.mark).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
    });
  });

  it('retains fictional TUS 422 bytes and exact outgoing request without recovering a native response', async () => {
    const body = new Uint8Array([0, 255]), raw = Buffer.from('Fictional refusal');
    const headers = { 'Content-Type': 'application/offset+octet-stream', 'Tus-Resumable': '1.0.0', 'Upload-Length': '2' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(raw, {
      status: 422, headers: { 'content-range': '0-0/1' },
    }));
    vi.stubGlobal('fetch', fetch);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const result = await client().request(owner.token, '/storage/v1/upload/resumable', { method: 'POST', body, binary: true, headers });
    expect(result).toEqual({ ok: false, status: 422, data: raw, range: '0-0/1' });
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(timeout.mock.calls).toEqual([[15_000]]);
    const [url, init] = present(fetch.mock.calls[0]);
    expect(url).toBe(env.SUPABASE_URL + '/storage/v1/upload/resumable');
    expect(init).toEqual({
      method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + owner.token, ...headers }, body,
    });
    expect(init?.body).toBe(body);
  });
  it.each([
    { label: 'JSON-looking refusal', raw: Buffer.from('{"fictional":true}'), status: 422, ok: false },
    { label: 'empty non-204 stream', raw: Buffer.alloc(0), status: 422, ok: false },
    { label: 'fictional successful response', raw: Buffer.from('Fictional success'), status: 201, ok: true },
  ])('keeps $label as a TUS Buffer without normalizing status or ok', async ({ raw, status, ok }) => {
    respond(new Response(raw, { status }));
    const result = await client().request(owner.token, '/storage/v1/upload/resumable', {
      method: 'POST', body: new Uint8Array([0]), binary: true,
    });
    expect(result).toEqual({ ok, status, data: raw, range: null });
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(result.data.length).toBe(raw.length);
  });
  it.each([
    { label: 'lowercase method', method: 'post' },
    { label: 'mixed-case method', method: 'Post' },
    { label: 'PUT method', method: 'PUT' },
    { label: 'GET method', method: 'GET' },
    { label: 'trailing slash', route: '/storage/v1/upload/resumable/' },
    { label: 'query', route: '/storage/v1/upload/resumable?unit=1' },
    { label: 'child', route: '/storage/v1/upload/resumable/unit' },
    { label: 'lookalike', route: '/storage/v1/upload/resumable-other' },
    { label: 'false binary', binary: false },
    { label: 'omitted binary', binary: undefined },
    { label: 'numeric binary', binary: 1 },
    { label: 'string binary', binary: 'true' },
  ])('retains strict JSON outside the exact TUS fixture: $label', async (variant) => {
    const { method = 'POST', route = '/storage/v1/upload/resumable', binary } = { binary: true, ...variant };
    respond(new Response('Fictional non-JSON refusal', { status: 422 }));
    await expect(client().request(owner.token, route, { method, ...(binary === undefined ? {} : { binary }) }))
      .rejects.toThrow('EVIDENCE_REQUIRED');
  });
  it.each(['/rest/v1/items', '/auth/v1/token?grant_type=password', '/rest/v1/rpc/save_outfit', '/storage/v1/object/wardrobe/unit'])(
    'preserves ordinary JSON requirements for %s', async (route) => {
      respond(new Response('Fictional non-JSON refusal', { status: 422 }));
      await expect(client().request(owner.token, route, { method: 'POST', binary: true })).rejects.toThrow('EVIDENCE_REQUIRED');
      respond(json({ fictional: true }));
      await expect(client().request(owner.token, route, { method: 'POST', binary: true }))
        .resolves.toEqual({ ok: true, status: 200, data: { fictional: true }, range: null });
    },
  );
  it('preserves authenticated-download bytes outside the TUS fixture', async () => {
    const raw = Buffer.from([0, 255, 1]);
    respond(new Response(raw));
    const result = await client().request(owner.token, '/storage/v1/object/authenticated/wardrobe/unit');
    expect(result).toEqual({ ok: true, status: 200, data: raw, range: null });
    expect(Buffer.isBuffer(result.data)).toBe(true);
  });
  it('keeps matching TUS 204 bodyless and rejects null non-204 or noncompliant 204 streams', async () => {
    const options = { method: 'POST', binary: true, body: new Uint8Array([0]) };
    respond(empty());
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', options))
      .resolves.toEqual({ ok: true, status: 204, data: null, range: null });
    respond(new Response(null, { status: 422 }));
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', options)).rejects.toThrow('EVIDENCE_REQUIRED');
    const response = new Response('Fictional noncompliant stream');
    vi.spyOn(response, 'status', 'get').mockReturnValue(204);
    const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
    respond(response);
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', options)).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(getReader).not.toHaveBeenCalled();
  });
  it('retains the exact 512KiB TUS byte ceiling and cancels after completion or overflow', async () => {
    const raw = Buffer.alloc(MAX_SNAPSHOT_BYTES, 255);
    const response = new Response(raw), stream = present(response.body ?? undefined), reader = stream.getReader();
    const cancelled = vi.spyOn(reader, 'cancel');
    vi.spyOn(stream, 'getReader').mockReturnValue(reader);
    respond(response);
    const options = { method: 'POST', binary: true, body: new Uint8Array([0]) };
    const result = await client().request(owner.token, '/storage/v1/upload/resumable', options);
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(result.data).toEqual(raw);
    expect(result.data.length).toBe(MAX_SNAPSHOT_BYTES);
    expect(cancelled).toHaveBeenCalledOnce();
    const cancel = vi.fn();
    respond(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(raw); controller.enqueue(new Uint8Array(1)); },
      cancel,
    })));
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', options)).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([500, 503])('rejects matching TUS %s before accessing its reader', async (status) => {
    const response = new Response('Fictional server failure', { status });
    const getReader = vi.spyOn(present(response.body ?? undefined), 'getReader');
    respond(response);
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', {
      method: 'POST', binary: true, body: new Uint8Array([0]),
    })).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(getReader).not.toHaveBeenCalled();
  });
  it.each(['read', 'cancel', 'read-and-cancel'])('preserves matching TUS %s failure and finally precedence', async (failure) => {
    const response = new Response('Fictional stream'), stream = present(response.body ?? undefined), reader = stream.getReader();
    const readError = new Error('Fictional read failure'), cancelError = new Error('Fictional cancel failure');
    const read = vi.spyOn(reader, 'read'), cancel = vi.spyOn(reader, 'cancel');
    if (failure !== 'cancel') read.mockRejectedValue(readError);
    if (failure !== 'read') cancel.mockRejectedValue(cancelError);
    vi.spyOn(stream, 'getReader').mockReturnValue(reader);
    respond(response);
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', {
      method: 'POST', binary: true, body: new Uint8Array([0]),
    })).rejects.toBe(failure === 'read' ? readError : cancelError);
    expect(read).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('preserves matching TUS network failure without returning a result or retrying', async () => {
    const failure = new Error('Fictional network failure');
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
    vi.stubGlobal('fetch', fetch);
    await expect(client().request(owner.token, '/storage/v1/upload/resumable', {
      method: 'POST', binary: true, body: new Uint8Array([0]),
    })).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['DELETE', 'GET', 'HEAD'])('omits automatic Content-Type and body for undefined %s bodies', async (method) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => empty());
    vi.stubGlobal('fetch', fetch);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    for (const binary of [false, true]) {
      await client().request(owner.token, '/rest/v1/items', { method, binary });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[15_000], [15_000]]);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(env.SUPABASE_URL + '/rest/v1/items');
      expect(init).toEqual({
        method, cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
        headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + owner.token },
      });
      expect(init).not.toHaveProperty('body');
      expect(new Headers(init?.headers).has('content-type')).toBe(false);
    }
  });
  it.each([null, { title: 'Fictional transport item' }])('retains JSON headers and serialization for %j', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(empty());
    vi.stubGlobal('fetch', fetch);
    await client().request(owner.token, '/rest/v1/items', { method: 'POST', body });
    expect(fetch).toHaveBeenCalledOnce();
    const init = present(fetch.mock.calls[0]?.[1]);
    expect(init.body).toBe(JSON.stringify(body));
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + owner.token);
    expect(init.method).toBe('POST');
  });
  it('retains binary body identity, image type and anonymous key headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(empty()), body = new Uint8Array([0, 255]);
    vi.stubGlobal('fetch', fetch);
    await client().request(null, '/storage/v1/object/wardrobe/unit', { method: 'POST', body, binary: true });
    expect(fetch).toHaveBeenCalledOnce();
    const init = present(fetch.mock.calls[0]?.[1]);
    expect(init.body).toBe(body);
    expect(init.headers).toEqual({ apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'image/jpeg' });
  });
  it.each([undefined, null, { title: 'Fictional explicit headers' }])('preserves explicit header overrides with body %j', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(empty());
    vi.stubGlobal('fetch', fetch);
    const headers = { 'Content-Type': 'application/custom', Prefer: 'return=representation', Authorization: 'Bearer explicit-fixture' };
    await client().request(owner.token, '/rest/v1/items', { method: 'DELETE', body, headers });
    expect(fetch).toHaveBeenCalledOnce();
    const init = present(fetch.mock.calls[0]?.[1]);
    expect(init.headers).toEqual({ apikey: env.SUPABASE_PUBLISHABLE_KEY, ...headers });
    if (body === undefined) expect(init).not.toHaveProperty('body');
    else expect(init.body).toBe(JSON.stringify(body));
  });
  it('sends singular DELETE without JSON and still refuses an empty-JSON parser error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      statusCode: 400, error: 'Bad Request', message: 'Body cannot be empty when content-type is set to application/json',
    }, 400));
    vi.stubGlobal('fetch', fetch);
    const transport = client(), objectPath = `${owner.uid}/${run}/${run}/main.jpg`;
    await expect(deleteWardrobeObject((route, options) => transport.request(owner.token, route, options), owner.uid, objectPath))
      .rejects.toThrow('error.unavailable');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(env.SUPABASE_URL + '/storage/v1/object/wardrobe/' + objectPath);
    const init = present(fetch.mock.calls[0]?.[1]);
    expect(init.method).toBe('DELETE'); expect(init).not.toHaveProperty('body');
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });
  it('keeps standalone normal-session headers conditional without executing their runners', async () => {
    const local = await readFile(path.join(root, 'tests/integration/local.sessions.mjs'), 'utf8');
    const security = await readFile(path.join(root, 'tests/security/rls.sessions.mjs'), 'utf8');
    expect(local).toContain("...(body === undefined ? {} : { 'Content-Type': binary ? 'image/jpeg' : 'application/json' }), ...headers,");
    expect(local).toContain("...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) })");
    expect(local).toContain('deleteWardrobeObject((route, options) => request(owner.token, route, options), owner.uid, objectPath)');
    expect(security).toContain("...(body!==undefined?{'Content-Type':bytes?'image/jpeg':'application/json'}:{}),...(returnRepresentation?{Prefer:'return=representation'}:{})");
    expect(security).toContain("...(body!==undefined?{body:bytes?body:JSON.stringify(body)}:{})");
    expect(security).toContain('deleteWardrobeObject((route,options)=>call(c.token,route,options),c.uid,path)');
  });
  it('accepts bodyless 204 without reading a nonexistent stream and requires it for commit_image', async () => {
    const response = empty();
    const read = vi.spyOn(response, 'arrayBuffer');
    respond(response);
    await expect(client().rpc(owner, 'commit_image', { p_image_id: run })).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    for (const response of [new Response(null), new Response(''), json(null), json({}), json(1), json({}, 400)]) {
      respond(response);
      await expect(client().rpc(owner, 'commit_image', { p_image_id: run })).rejects.toThrow('EVIDENCE_REQUIRED');
    }
  });
  it('rejects a noncompliant 204 stream using a valid Response with a narrowly overridden status', async () => {
    const response = json({});
    vi.spyOn(response, 'status', 'get').mockReturnValue(204);
    respond(response);
    await expect(client().rpc(owner, 'commit_image', {})).rejects.toThrow('EVIDENCE_REQUIRED');
  });
  it('keeps required JSON RPCs distinct from void responses', async () => {
    for (const name of ['save_outfit', 'save_wear_event', 'export_manifest']) {
      for (const response of [empty(), new Response(null), new Response(''), new Response(' '), json(null), new Response('{'), new Response('not JSON')]) {
        respond(response);
        await expect(client().rpc(owner, name, {})).rejects.toThrow('EVIDENCE_REQUIRED');
      }
    }
    for (const name of ['save_outfit', 'save_wear_event']) {
      respond(json(2));
      await expect(client().rpc(owner, name, {})).resolves.toBe(2);
    }
  });
  it('retains row, insert and versioned-save response requirements', async () => {
    const row = fixture().data[0].tables.items[0];
    for (const call of [
      () => client().rows(owner, 'items'),
      () => client().insert(owner, 'items', {}),
      () => client().save(owner, 'items', row, {}),
    ]) {
      for (const response of [empty(), new Response(null), new Response(''), new Response('{'), json(null), json({}), json([null])]) {
        respond(response);
        await expect(call()).rejects.toThrow('EVIDENCE_REQUIRED');
      }
    }
    for (const value of [[], [{ id: 'invalid', owner_id: owner.uid }], [{ ...row, owner_id: other.uid }]]) {
      respond(json(value));
      await expect(client().insert(owner, 'items', {})).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    respond(json([row], 201));
    await expect(client().insert(owner, 'items', {})).resolves.toEqual(row);
    respond(new Response(JSON.stringify([row]), { headers: { 'content-range': '0-0/1' } }));
    await expect(client().rows(owner, 'items')).resolves.toEqual([row]);
    respond(new Response(JSON.stringify([row]), { headers: { 'content-range': '0-0/2' } }));
    await expect(client().rows(owner, 'items')).rejects.toThrow('EVIDENCE_REQUIRED');
    respond(json([{ ...row, version: Number(row.version) + 1 }]));
    await expect(client().save(owner, 'items', row, {})).resolves.toMatchObject({ version: Number(row.version) + 1 });
  });
  it('requires both login JSON and the verified ordinary user shape', async () => {
    const token = ['unit', Buffer.from(JSON.stringify({ sub: owner.uid, role: 'authenticated' })).toString('base64url'), 'unit'].join('.');
    const user = { id: owner.uid, email: env.TEST_A_EMAIL, is_anonymous: false };
    for (const response of [empty(), new Response(null), new Response(''), new Response('{'), json(null), json({}), json([])]) {
      respond(response);
      await expect(client().signIn('A')).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    for (const response of [empty(), new Response(null), new Response(''), new Response('{'), json(null), json({}),
      json({ ...user, id: other.uid }), json({ ...user, email: env.TEST_B_EMAIL }), json({ ...user, is_anonymous: true })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ access_token: token })).mockResolvedValueOnce(response));
      await expect(client().signIn('A')).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ access_token: token })).mockResolvedValueOnce(json(user)));
    await expect(client().signIn('A')).resolves.toEqual({ ...owner, token });
  });
  it('retains the streaming byte ceiling, cancellation and server-error refusal', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_SNAPSHOT_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    respond(new Response(stream));
    await expect(client().request(null, '/rest/v1/items')).rejects.toThrow('EVIDENCE_REQUIRED');
    expect(cancel).toHaveBeenCalledOnce();
    for (const status of [500, 503]) {
      const response = json({}, status);
      const reader = vi.spyOn(present(response.body ?? undefined), 'getReader');
      respond(response);
      await expect(client().request(null, '/rest/v1/items')).rejects.toThrow('EVIDENCE_REQUIRED');
      expect(reader).not.toHaveBeenCalled();
    }
    const response = json({ code: '42703' }, 400);
    const reader = present(response.body ?? undefined).getReader();
    const cancelled = vi.spyOn(reader, 'cancel');
    vi.spyOn(present(response.body ?? undefined), 'getReader').mockReturnValue(reader);
    respond(response);
    await expect(client().request(null, '/rest/v1/items')).resolves.toMatchObject({ ok: false, status: 400, data: { code: '42703' } });
    expect(cancelled).toHaveBeenCalledOnce();
    respond(new Response(' '.repeat(MAX_SNAPSHOT_BYTES - 2) + '{}'));
    await expect(client().request(null, '/rest/v1/items')).resolves.toMatchObject({ ok: true, data: {} });
  });
  it('requires actual downloaded bytes to match the stored fixture, including on 204', async () => {
    const snapshot = fixture();
    const bytes = await readFile(path.join(root, 'tests/security/fixture.jpg'));
    for (const data of snapshot.data) for (const image of data.tables.item_images) {
      image.main_sha256 = image.thumb_sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    const downloads = vi.fn<() => Response>();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.startsWith('/storage/v1/object/authenticated/')) return downloads();
      const table = tables.find((table) => url.pathname === `/rest/v1/${table}`);
      if (!table) throw new Error('UNEXPECTED_REQUEST');
      const data = present(snapshot.data.find((data) => `eq.${data.ownerId}` === url.searchParams.get('owner_id')));
      return new Response(JSON.stringify(data.tables[table]), { headers: { 'content-range': `0-0/${data.tables[table].length}` } });
    }));
    for (const response of [empty(), new Response(null), new Response(''), json({}), new Response(new Uint8Array(632))]) {
      downloads.mockReturnValueOnce(response);
      await expect(captureData(client(), [owner, other], run)).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    downloads.mockImplementation(() => new Response(bytes));
    await expect(captureData(client(), [owner, other], run)).resolves.toMatchObject({ owners: [...owners] });
    await expect(captureData(client(), [owner, other], run, true)).rejects.toThrow('EVIDENCE_REQUIRED');
    for (const data of snapshot.data) Object.assign(data.tables.profiles[0], {
      ai_enabled: false, ai_notice_revision: null, ai_consented_at: null,
    });
    const captured = await captureData(client(), [owner, other], run, true);
    for (const data of captured.data) expect(Object.keys(data.tables.profiles[0]).sort()).toEqual(columns.profiles.split(' ').sort());
    for (const [key, value] of [['ai_enabled', true], ['ai_notice_revision', 1], ['ai_consented_at', time]] as const) {
      const row = snapshot.data[0].tables.profiles[0], prior = row[key];
      row[key] = value;
      await expect(captureData(client(), [owner, other], run, true)).rejects.toThrow('EVIDENCE_REQUIRED');
      row[key] = prior!;
    }
  });
  it.each(['base', 'six'])('keeps exact export projection, owner and table equality for %s', async (stage) => {
    const after = stage === 'six' ? sixFixture() : upgraded(fixture());
    const unchanged = structuredClone(after);
    const manifest = vi.fn<(id: string, uid: string) => Response>();
    const validManifest = (id: string, uid: string) => {
      const exported = structuredClone(present(after.data.find((data) => data.ownerId === uid)).tables);
      if (stage === 'six') for (const profile of exported.profiles) {
        delete profile.ai_enabled; delete profile.ai_notice_revision; delete profile.ai_consented_at;
      }
      return { schema_version: 2, export_id: id, owner_id: uid, created_at: time, tables: exported };
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const token = new Headers(init.headers).get('Authorization');
      const current = token === 'Bearer ' + owner.token ? owner : token === 'Bearer ' + other.token ? other : null;
      if (url.pathname === '/rest/v1/rpc/export_manifest') {
        const body = JSON.parse(String(init.body)) as { p_export_id: string };
        return manifest(body.p_export_id, present(current?.uid));
      }
      if (url.pathname.startsWith('/storage/')) return json({}, 404);
      if (!current) return json({}, 401);
      if (url.searchParams.get('owner_id') !== `eq.${current.uid}`) return json([]);
      if (init.method === 'PATCH') return json({}, 400);
      const table = tables.find((table) => url.pathname === `/rest/v1/${table}`);
      if (!table) throw new Error('UNEXPECTED_REQUEST');
      const rows = validManifest(run, current.uid).tables[table];
      return new Response(JSON.stringify(rows), { headers: { 'content-range': `0-0/${rows.length}` } });
    }));
    for (const response of [empty(), new Response(null), new Response(''), new Response('{'), json(null), json({}), json([])]) {
      manifest.mockReturnValueOnce(response);
      await expect(functionalProbes(client(), [owner, other], after)).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    const changes: Record<string, Value>[] = [
      { schema_version: 1 }, { owner_id: randomUUID() }, { export_id: randomUUID() },
      { created_at: 'invalid' }, { tables: {} }, { extra: true },
      { tables: { ...present(after.data[0]).tables, items: [] } },
    ];
    for (const change of changes) {
      manifest.mockImplementationOnce((id, uid) => json({ ...validManifest(id, uid), ...change }));
      await expect(functionalProbes(client(), [owner, other], after)).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    manifest.mockImplementation((id, uid) => json(validManifest(id, uid)));
    await expect(functionalProbes(client(), [owner, other], after)).resolves.toBeUndefined();
    expect(after).toEqual(unchanged);
    const profileChanged = structuredClone(validManifest(run, owner.uid).tables);
    present(profileChanged.profiles[0]).display_name = 'Changed export';
    manifest.mockImplementationOnce((id, uid) => json({ ...validManifest(id, uid), tables: profileChanged }));
    await expect(functionalProbes(client(), [owner, other], after)).rejects.toThrow('EVIDENCE_REQUIRED');
    if (stage === 'six') {
      manifest.mockImplementationOnce((id, uid) => json({
        ...validManifest(id, uid), tables: present(after.data.find((data) => data.ownerId === uid)).tables,
      }));
      await expect(functionalProbes(client(), [owner, other], after)).rejects.toThrow('EVIDENCE_REQUIRED');
    }
  });
});

describe('strict bounded base snapshots', () => {
  it('binds exact mode, UUID and derived path with no arbitrary target', () => {
    for (const phase of ['capture', 'verify']) expect(parsePhaseArguments([phase, run])).toEqual({ phase, run });
    for (const bad of ['', '../escape', run.toUpperCase(), `${run}/../other`, run + '.json', '00000000-0000-0000-0000-000000000000']) {
      expect(() => snapshotPath(bad)).toThrow();
      expect(() => parsePhaseArguments(['capture', bad])).toThrow();
    }
    for (const args of [[], ['capture'], ['other', run], ['capture', run, 'extra'], ['verify', run, '--path']]) {
      expect(() => parsePhaseArguments(args)).toThrow();
    }
    const filename = path.join(root, '.supabase', `preservation-${run}.json`);
    expect(snapshotPath(run)).toBe(filename);
    expect(() => assertSnapshotPath(filename, run)).not.toThrow();
    for (const bad of [filename + '.old', path.join('/tmp', path.basename(filename)), path.join(root, '.supabase', '..', path.basename(filename))]) {
      expect(() => assertSnapshotPath(bad, run)).toThrow();
    }
  });
  it('requires a regular, non-symlink, private, singly linked bounded file', () => {
    const stat = { isFile: () => true, isSymbolicLink: () => false, size: 100, nlink: 1, mode: 0o100600 };
    expect(() => validateSnapshotStat(stat)).not.toThrow();
    for (const bad of [
      { isFile: () => false }, { isSymbolicLink: () => true }, { size: 0 }, { size: MAX_SNAPSHOT_BYTES + 1 },
      { nlink: 2 }, { mode: 0o100644 }, { mode: 0o100666 },
    ]) expect(() => validateSnapshotStat({ ...stat, ...bad })).toThrow();
  });
  it('uses actual table identities and rejects duplicate sets', () => {
    const snapshot = fixture();
    expect(validateSnapshot(snapshot, run, owners)).toBe(snapshot);
    for (const table of tables) {
      const rows = snapshot.data[0].tables[table];
      expect(canonicalRows(table, [...rows].reverse())).toEqual(canonicalRows(table, rows));
      expect(() => canonicalRows(table, [...rows, rows[0]])).toThrow();
      const row = structuredClone(rows[0]);
      delete row[table === 'profiles' || table === 'style_preferences' ? 'owner_id' : table === 'outfit_items' ? 'item_id' : 'id'];
      expect(() => rowIdentity(table, row)).toThrow();
    }
    expect(() => rowIdentity('unknown', {})).toThrow();
  });
  it('refuses every binding mismatch, empty set, stale stage and post-target capture', () => {
    const snapshot = fixture();
    for (const changes of [
      { schemaVersion: 2 }, { projectId: 'other' }, { stage: 'target' }, { run: randomUUID() },
      { sources: { ...SOURCE_HASHES, target: sha } }, { sources: { ...SOURCE_HASHES, description: sha } }, { sources: { ...SOURCE_HASHES, collections: sha } },
      { sources: { ...SOURCE_HASHES, controls: sha } },
      { sources: { ...SOURCE_HASHES, lifecycle: sha } },
      { sources: { base: SOURCE_HASHES.base, target: SOURCE_HASHES.target } }, { owners: [...owners].reverse() },
      { owners: [owners[0], owners[0]] }, { extra: true }, { data: [] },
    ]) expect(() => validateSnapshot({ ...snapshot, ...changes }, run, owners)).toThrow();
    expect(() => validateSnapshot(upgraded(snapshot), run, owners)).toThrow();
    for (const table of tables) {
      const bad = structuredClone(snapshot); bad.data[0].tables[table].pop();
      expect(() => validateSnapshot(bad, run, owners)).toThrow();
    }
    for (const mutate of [
      (s: Snapshot) => { s.data[0].label = 'B'; },
      (s: Snapshot) => { s.data[0].ownerId = owners[1]; },
      (s: Snapshot) => { s.data[0].tables.items[0].owner_id = owners[1]; },
      (s: Snapshot) => { s.data[0].tables.items[0].pattern = null; },
      (s: Snapshot) => { s.data[0].tables.items[0].version = 1; },
      (s: Snapshot) => { s.data[0].tables.items[0].created_at = 0; },
      (s: Snapshot) => { s.data[0].objects.pop(); },
      (s: Snapshot) => { s.data[0].objects[0].path = '../escape'; },
    ]) {
      const bad = structuredClone(snapshot); mutate(bad);
      expect(() => validateSnapshot(bad, run, owners)).toThrow();
    }
  });
  it('rejects credential-shaped fields/values, non-JSON and oversized snapshots', () => {
    for (const key of ['access_token', 'password', 'service_key', 'authResponse', 'credentials', 'session']) {
      const snapshot = fixture(); snapshot.data[0].tables.items[0][key] = 'fictional';
      expect(() => validateSnapshot(snapshot, run, owners)).toThrow();
    }
    for (const value of ['Bearer ' + 'fictional', 'sb_secret_' + 'fictional', 'github_pat_' + 'fictional',
      ['eyJ', 'fictional', 'fictional'].join('.'), 'x'.repeat(MAX_SNAPSHOT_BYTES + 1), Number.NaN, undefined]) {
      const snapshot = fixture();
      Object.assign(snapshot.data[0].tables.items[0], { material: value });
      expect(() => validateSnapshot(snapshot, run, owners)).toThrow();
    }
  });
});

describe('complete old-value and downloaded-byte comparison', () => {
  it('allows only four unverified item columns, initial image counters and irrelevant row ordering', () => {
    const before = fixture(), after = upgraded(before);
    for (const data of after.data) {
      for (const table of tables) data.tables[table].reverse();
      data.objects.reverse();
    }
    expect(() => comparePreservation(before, after, run, owners)).not.toThrow();
    for (const field of newColumns) {
      const bad = upgraded(before); delete bad.data[0].tables.items[0][field];
      expect(() => comparePreservation(before, bad, run, owners)).toThrow();
      const changed = upgraded(before); changed.data[0].tables.items[0][field] = field === 'field_provenance' ? { warmth: { kind: 'user', revision: 1 } } : 'solid';
      expect(() => comparePreservation(before, changed, run, owners)).toThrow();
    }
  });
  it('requires exactly counter 1 on every old ready and retired image for both owners', () => {
    const before = fixture();
    for (const ownerIndex of [0, 1] as const) for (const imageIndex of [0, 1] as const) {
      for (const value of [undefined, null, '1', 0, -1, 1.5, 2, 2147483647, 2147483648]) {
        const after = upgraded(before), image = after.data[ownerIndex].tables.item_images[imageIndex];
        if (value === undefined) delete image.description_version;
        else image.description_version = value;
        expect(() => comparePreservation(before, after, run, owners)).toThrow();
      }
      const extra = upgraded(before);
      extra.data[ownerIndex].tables.item_images[imageIndex].unexpected = null;
      expect(() => comparePreservation(before, extra, run, owners)).toThrow();
    }
  });
  it('fails on every changed or missing old column in all ten tables', () => {
    const before = fixture();
    for (const table of tables) for (const key of columns[table].split(' ')) {
      const after = upgraded(before), row = after.data[0].tables[table][0];
      row[key] = row[key] === null ? 'changed' : null;
      expect(() => comparePreservation(before, after, run, owners), `${table}.${key}`).toThrow();
      const missing = upgraded(before); delete missing.data[0].tables[table][0][key];
      expect(() => comparePreservation(before, missing, run, owners), `${table}.${key} missing`).toThrow();
    }
  });
  it('fails on missing/extra/duplicate rows even with retained versions', () => {
    const before = fixture();
    for (const table of tables) for (const kind of ['missing', 'extra', 'duplicate']) {
      const after = upgraded(before), rows = after.data[1].tables[table];
      if (kind === 'missing') rows.pop();
      else if (kind === 'duplicate' && rows.length > 1) rows[1] = structuredClone(rows[0]);
      else rows.push(structuredClone(rows[0]));
      expect(() => comparePreservation(before, after, run, owners)).toThrow();
    }
  });
  it('retains microseconds, array order, money, nulls and physical facts; versions alone prove nothing', () => {
    const before = fixture();
    for (const changes of [
      { updated_at: '2026-09-05T12:34:56.123457+00:00' },
      { created_at: '2026-09-05T12:34:56.123+00:00' }, { version: 3 },
      { seasons: ['winter', 'autumn', 'summer', 'spring'] }, { brand: '' }, { notes: 'changed' },
      { formality: null }, { warmth: 0 }, { windproof: true },
    ]) {
      const after = upgraded(before); Object.assign(after.data[0].tables.items[0], changes);
      expect(() => comparePreservation(before, after, run, owners)).toThrow();
    }
    const after = upgraded(before); after.data[0].tables.items[1].purchase_price = 123.46;
    expect(() => comparePreservation(before, after, run, owners)).toThrow();
  });
  it('requires stored AND actually downloaded lengths/hashes and immutable paths/states', () => {
    const before = fixture();
    for (const changes of [{ bytes: 631 }, { sha256: 'b'.repeat(64) }, { path: 'unknown' }]) {
      const after = upgraded(before); Object.assign(after.data[0].objects[0], changes);
      expect(() => comparePreservation(before, after, run, owners)).toThrow();
    }
    const both = upgraded(before);
    both.data[0].objects[0].sha256 = 'b'.repeat(64);
    both.data[0].tables.item_images[0].main_sha256 = 'b'.repeat(64);
    expect(() => comparePreservation(before, both, run, owners)).toThrow();
    const duplicate = upgraded(before); duplicate.data[0].objects[1] = { ...duplicate.data[0].objects[0] };
    expect(() => comparePreservation(before, duplicate, run, owners)).toThrow();
  });
});

describe('import safety and frozen integration boundary', () => {
  it('imports both executables without commands, network or fixture file operations', () => {
    const urls = ['scripts/preservation-rehearsal.mjs', 'tests/integration/preservation.sessions.mjs']
      .map((name) => new URL('../../' + name, import.meta.url).href);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import child from 'node:child_process';
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const refuse = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };
      for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']) child[key] = refuse;
      for (const key of ['open', 'writeFile', 'mkdir', 'unlink', 'rm', 'lstat', 'readdir', 'readFile']) fsp[key] = refuse;
      fs.writeFileSync = refuse;
      globalThis.fetch = refuse;
      syncBuiltinESMExports();
      for (const url of ${JSON.stringify(urls)}) await import(url);
      console.log('IMPORT_SAFE');
    `], { cwd: '/tmp', env: {}, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('IMPORT_SAFE\n');
    expect(result.stderr).toBe('');
  });
  it('keeps CI opt-in step-local, before unchanged final reset and suites', async () => {
    const workflow = (await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    expect(workflow).toContain("      - run: npm run db:start\n      - run: npm run db:rehearse\n        env:\n          ALLOW_PRESERVATION_REHEARSAL: '1'\n      - run: npm run db:reset\n      - run: npm run test:integration\n      - run: npm run test:security\n      - run: node scripts/ai-analysis-rehearsal.mjs\n      - run: npm run db:types");
    expect(workflow.match(/ALLOW_PRESERVATION_REHEARSAL/g)).toHaveLength(1);
    expect(workflow.match(/ALLOW_CI_DATABASE_MUTATION/g)).toHaveLength(1);
    expect(workflow).toContain("      ALLOW_SECURITY_TESTS: '1'\n      ALLOW_CI_DATABASE_MUTATION: '1'");
    expect(workflow.slice(0, workflow.indexOf('\n  database:'))).not.toContain('ALLOW_CI_DATABASE_MUTATION');
    expect(workflow).not.toContain('ALLOW_CI_STORAGE_GUARD_INSTALL');
    expect(workflow).not.toContain('GITHUB_JOB:');
    expect(workflow).toContain('timeout-minutes: 30');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:rehearse']).toBe('node scripts/preservation-rehearsal.mjs');
  });
  it('preflights before mutation and verifies every observed nine/ten/eleven transition before traffic', async () => {
    const source = await readFile(path.join(root, 'scripts/preservation-rehearsal.mjs'), 'utf8');
    const main = source.slice(source.indexOf('async function main()'));
    expect(main.indexOf('assertCiDatabaseMutationAllowed();')).toBeLessThan(main.indexOf('await assertProjectConfig();'));
    expect(main.indexOf('assertCiDatabaseMutationAllowed();')).toBeLessThan(main.indexOf('await cli(args)'));
    const base = main.slice(0, main.indexOf("stage = 'S3-migration-up'"));
    expect(base).not.toContain('await installCiStorageGuard();');
    expect(base).not.toContain('await verifyCiStorageGuard();');
    expect(main).not.toContain('installCiStorageGuard');
    expect(main.indexOf('await verifyCiStorageGuard();')).toBeGreaterThan(main.indexOf("await migrateToAzureTarget(run, 'base')"));
    expect(main.indexOf("await history('azure-target');")).toBeGreaterThan(main.indexOf('await verifyCiStorageGuard();'));
    expect(main.indexOf('ITEM_LIFECYCLE_CATALOG_SQL')).toBeGreaterThan(main.indexOf("await history('azure-target');"));
    expect(main.match(/await verifyCiStorageGuard\(\);/g)).toHaveLength(8);
    const prior = main.slice(main.indexOf("stage = 'AZ1-prior-main-reset'"));
    expect(source).toContain("const PRIOR_MAIN_VERSION = '20260913120000';");
    expect(source).toContain('MIGRATIONS.findIndex((entry) => entry.version === PRIOR_MAIN_VERSION)');
    expect(source).toContain("requireHistory(priorMainIndex >= 0 && azureIndex === priorMainIndex + 1, 'inventory-mismatch');");
    expect(prior).toContain("'--version', PRIOR_MAIN_VERSION");
    expect(source).not.toContain('MIGRATIONS.slice(0, 9)');
    expect(source).not.toContain('MIGRATIONS[9]');
    expect(prior.indexOf("await history('prior-main');")).toBeLessThan(prior.indexOf('await captureAzurePreservation('));
    expect(prior.indexOf('await captureAzurePreservation(')).toBeLessThan(prior.indexOf("await migrateToStage(run, 'azure-target', 'image-change')"));
    expect(prior.indexOf("await history('azure-target');")).toBeLessThan(prior.indexOf('await verifyAzurePreservation('));
    const nineToTen = prior.slice(prior.indexOf("await migrateToAzureTarget(run, 'prior-main')"), prior.indexOf('await verifyAzurePreservation('));
    expect(nineToTen).toContain("await history('azure-target');\n      await verifyCiStorageGuard();");
    expect(prior.indexOf('await verifyAzurePreservation(')).toBeLessThan(prior.indexOf('await captureImageChangePreservation('));
    expect(prior.indexOf('await captureImageChangePreservation(')).toBeLessThan(prior.indexOf("await migrateToStage(run, 'azure-target', 'image-change')"));
    expect(prior.indexOf("await history('image-change');")).toBeLessThan(prior.indexOf('await verifyImageChangePreservation('));
    expect(main).not.toMatch(/await cli\(\['migration', 'up'/);
  });
  it('keeps the normal child free of privileged calls and compares before probes', async () => {
    const source = await readFile(path.join(root, 'tests/integration/preservation.sessions.mjs'), 'utf8');
    expect(source).not.toMatch(/\b(?:cli|localStatus|privilegedLocalSql|runCommand|spawn|execFile)\s*\(/);
    expect(source).not.toContain('/auth/v1/admin');
    expect(source).not.toMatch(/method: '(?:PUT|DELETE)'/);
    expect(source.indexOf('comparePreservation(before, after, run, ids);')).toBeLessThan(source.indexOf('await functionalProbes(client, owners, after);'));
    const orchestrator = await readFile(path.join(root, 'scripts/preservation-rehearsal.mjs'), 'utf8');
    expect(orchestrator).toContain('normalSessionEnvironment(process.env, await readCredentialCache())');
    expect(orchestrator).toContain('validateSessionEnvironment(env)');
    expect(orchestrator.match(/provision-test-users\.mjs/g)).toHaveLength(4);
    expect(orchestrator.match(/\['db', 'reset'/g)).toHaveLength(5); // Help, fixed base, prior-main, schema six and COL1 twelve.
    for (const [stage, target] of [['S1-base-history', 'base'], ['S3-base-history', 'base'], ['S3-target-history', 'azure-target']]) {
      expect(orchestrator.replaceAll('\r\n', '\n')).toContain(`stage = '${stage}';\n    await history('${target}');`);
    }
    expect(orchestrator).not.toMatch(/--(?:linked|db-url)|migration.*repair/);
    const fixtureBytes = await readFile(path.join(root, 'tests/security/fixture.jpg'));
    expect(fixtureBytes.length).toBe(632);
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('COL1 strict preservation pass and twelve-only probes (source order, not executed backend proof)', () => {
  it('captures eleven, compares twelve and thirteen read-only, and probes only afterwards', async () => {
    const source = (await readFile(path.join(root, 'scripts/preservation-rehearsal.mjs'), 'utf8')).replaceAll('\r\n', '\n');
    const col1 = source.slice(source.indexOf("stage = 'COL1-A-finalizer'"), source.indexOf('} catch (error) {', source.indexOf("stage = 'COL1-A-finalizer'")));
    let offset = 0;
    for (const step of ["await history('image-change')", 'await captureColourPreservation(', "await history('image-change')",
      "await migrateToStage(run, 'image-change', 'colours')", "await history('colours'); await verifyCiStorageGuard();",
      "await verifyColourStage(colourSnapshot, privilegedLocalSql, 'colours')", "await migrateToStage(run, 'colours', 'target')",
      "await history('target'); await verifyCiStorageGuard();", "await verifyColourStage(colourSnapshot, privilegedLocalSql, 'target')",
      "await colourProbes(sixEnv, privilegedLocalSql, 'target')", 'await colourFinalizer.stop()',
      "'--version', COLOUR_VERSION", "await history('colours'); await verifyCiStorageGuard();", 'provision-test-users.mjs',
      "await colourProbes(twelveEnv, privilegedLocalSql, 'colours')", 'await twelveFinalizer.stop()']) {
      const next = col1.indexOf(step, offset); expect(next, step).toBeGreaterThanOrEqual(offset); offset = next + step.length;
    }
    expect(col1.match(/colourProbes\(/g)).toHaveLength(2);
    expect(col1).not.toMatch(/await cli\(\['migration', 'up'/);
    expect(source).toContain("const COLOUR_VERSION = '20260924100000';");
    const normal = await readFile(path.join(root, 'tests/integration/azure-preservation.sessions.mjs'), 'utf8');
    const verify = normal.slice(normal.indexOf('export async function verifyColourStage'), normal.indexOf('export async function colourProbes'));
    expect(verify).not.toMatch(/insert|update|delete|\.rpc\(|colourControls|colourConsent/);
    expect(verify).toContain('equal(after.rows, before.rows);');
  });
});