import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { MIGRATIONS, assertRehearsalEnvironment, validateInventory, assertMigrationInventory, assertCapabilities, parseMigrationHistory, assertHistory, exportBodyEvidence } from '../../scripts/preservation-rehearsal.mjs';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { SOURCE_HASHES, MAX_SNAPSHOT_BYTES, COLUMNS, TABLES, COUNTS, IMPLICIT_FACTS, EXPLICIT_FACTS, NEW_COLUMNS, parsePhaseArguments, snapshotPath, assertSnapshotPath, validateSnapshotStat, rowIdentity, canonicalRows, validateSnapshot, comparePreservation, normalClient, captureData, functionalProbes } from '../integration/preservation.sessions.mjs';

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
  sources: { base: string; target: string }; owners: string[];
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
  return after;
}

// Source-derived only: CLI v2.116.0 internal/migration/list/list.go makeTable,
// utils/output.go RenderTable and Glamour v1.0.0 ASCII/table cell rendering.
// Not observed CLI execution, database state or preservation proof.
const baseTable = `
  Local          | Remote         | Time (UTC)
 ----------------|----------------|---------------------
  20260905000000 | 20260905000000 | 2026-09-05 00:00:00
  20260906000000 |                | 2026-09-06 00:00:00
`;
const targetTable = baseTable.replace('20260906000000 |                |', '20260906000000 | 20260906000000 |');
const validEnv = { ALLOW_PRESERVATION_REHEARSAL: '1', CI: 'true', GITHUB_ACTIONS: 'true' };
const inventory = () => (MIGRATIONS as { name: string; version: string; bytes: number; sha256: string }[])
  .map((entry) => ({ ...entry, regular: true, symlink: false }));

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
  it('pins exactly two regular migrations, lengths and hashes', async () => {
    expect(() => validateInventory(inventory())).not.toThrow();
    await expect(assertMigrationInventory()).resolves.toBeUndefined();
    for (const index of [0, 1]) for (const [key, value] of [
      ['name', 'unexpected.sql'], ['bytes', 0], ['bytes', present(inventory()[index]).bytes + 1],
      ['sha256', 'b'.repeat(64)], ['regular', false], ['symlink', true],
    ]) {
      const bad = inventory();
      Object.assign(present(bad[index]), { [key as string]: value });
      expect(() => validateInventory(bad)).toThrow();
    }
    for (const bad of [[], inventory().slice(1), [...inventory(), inventory()[0]], [inventory()[0], inventory()[0]]]) {
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
    expect(assertHistory(baseTable, 'base')).toEqual({ applied: ['20260905000000'], pending: ['20260906000000'] });
    expect(assertHistory(targetTable, 'target')).toEqual({ applied: ['20260905000000', '20260906000000'], pending: [] });
    expect(() => assertHistory(targetTable, 'base')).toThrow();
    expect(() => assertHistory(baseTable, 'target')).toThrow();
    expect(() => assertHistory(baseTable, 'other')).toThrow();
    expect(assertHistory(baseTable.replaceAll('\n', '\r\n'), 'base')).toEqual(parseMigrationHistory(baseTable));
  });
  it.each([
    '', '[]', 'PASS', baseTable + 'unexpected', baseTable.replace('Local', 'LOCAL'),
    baseTable.replaceAll('|', '│'), baseTable.replace('----------------', '-----+----------'),
    baseTable.replace('20260906000000', '20260907000000'),
    baseTable.replace('20260906000000', '20260905000000'),
    baseTable.replace('20260905000000 | 20260905000000', '               | 20260905000000'),
    baseTable.replace('20260906000000 |                |', '20260906000000 | 20260907000000 |'),
    baseTable.replace('2026-09-06 00:00:00', '2026-09-07 00:00:00'),
    baseTable.replace('20260906000000', '`20260906000000`'),
    baseTable.replace('20260905000000', '\x1b[0m20260905000000'),
    baseTable.split('\n').slice(0, -2).join('\n'),
    baseTable + baseTable.split('\n')[3] + '\n',
    baseTable.replace('20260905000000 | 20260905000000', '20260905000000 |               '),
  ])('rejects malformed, missing, duplicate or unknown history %#', (value) => {
    expect(() => assertHistory(value, 'base')).toThrow();
  });
  it('derives untrimmed source export bodies; this is not a database observation', async () => {
    for (const [name, md5] of [
      ['20260905000000_initial.sql', 'a8188b771786538ec7ef031d9d974fce'],
      ['20260906000000_item_field_provenance.sql', 'cb47b75d41751df15813773388c062cf'],
    ] as const) {
      const sql = await readFile(path.join(root, 'supabase', 'migrations', name), 'utf8');
      expect(exportBodyEvidence(sql)).toEqual({ bytes: 1452, md5 });
      expect(() => exportBodyEvidence(sql + sql)).toThrow();
      expect(() => exportBodyEvidence(sql.replace('as $$\n  select case', 'as $body$\n  select case'))).toThrow();
      const start = sql.indexOf('\n  select case when private.is_approved() then jsonb_build_object(');
      expect(() => exportBodyEvidence(sql.slice(0, start + 20))).toThrow();
    }
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
  });
  it('keeps full export shape, owner and table equality assertions after the HTTP reader', async () => {
    const after = upgraded(fixture());
    const manifest = vi.fn<(id: string, uid: string) => Response>();
    const validManifest = (id: string, uid: string) => ({
      schema_version: 2, export_id: id, owner_id: uid, created_at: time,
      tables: present(after.data.find((data) => data.ownerId === uid)).tables,
    });
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
      { tables: { ...after.data[0].tables, items: [] } },
    ];
    for (const change of changes) {
      manifest.mockImplementationOnce((id, uid) => json({ ...validManifest(id, uid), ...change }));
      await expect(functionalProbes(client(), [owner, other], after)).rejects.toThrow('EVIDENCE_REQUIRED');
    }
    manifest.mockImplementation((id, uid) => json(validManifest(id, uid)));
    await expect(functionalProbes(client(), [owner, other], after)).resolves.toBeUndefined();
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
      { sources: { ...SOURCE_HASHES, target: sha } }, { owners: [...owners].reverse() },
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
  it('allows only four unverified new columns and irrelevant row ordering', () => {
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
    const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain("      - run: npm run db:start\n      - run: npm run db:rehearse\n        env:\n          ALLOW_PRESERVATION_REHEARSAL: '1'\n      - run: npm run db:reset\n      - run: npm run test:integration\n      - run: npm run test:security\n      - run: npm run db:types");
    expect(workflow.match(/ALLOW_PRESERVATION_REHEARSAL/g)).toHaveLength(1);
    expect(workflow).toContain('timeout-minutes: 30');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:rehearse']).toBe('node scripts/preservation-rehearsal.mjs');
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
    expect(orchestrator.match(/provision-test-users\.mjs/g)).toHaveLength(1);
    expect(orchestrator.match(/\['db', 'reset'/g)).toHaveLength(2); // One help probe, one fixed base reset.
    for (const [stage, target] of [['S1-base-history', 'base'], ['S3-base-history', 'base'], ['S3-target-history', 'target']]) {
      expect(orchestrator).toContain(`stage = '${stage}';\n    await history('${target}');`);
    }
    expect(orchestrator).not.toMatch(/--(?:linked|db-url)|migration.*repair/);
    const fixtureBytes = await readFile(path.join(root, 'tests/security/fixture.jpg'));
    expect(fixtureBytes.length).toBe(632);
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toMatch(/^[a-f0-9]{64}$/);
  });
});
