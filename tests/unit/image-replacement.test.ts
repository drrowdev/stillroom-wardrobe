import { createRequire } from 'node:module';
import path from 'node:path';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Executable CI runner has no TypeScript declaration.
import { MIGRATIONS, migrateToAzureTarget, preservationStagePath } from '../../scripts/preservation-rehearsal.mjs';
import { ROOT } from '../../scripts/backend/local.mjs';
import { newImageChangeAttempt, parseImageChangeReceipt, parseRecoveryVersions, type ImageChangeReceipt } from '../../src/domain/image-replacement';
import { newGarmentDraft, editGarmentField, validateGarmentDraft } from '../../src/domain/garment-fields';
import type { ItemBaseline, ImageBaseline } from '../../src/domain/item-details';
import type { OwnerScope } from '../../src/auth/session';
import type { AppClient } from '../../src/data/client';
import { ImageChangeClient } from '../../src/images/replace';
import { createAiDraft, beginAiAnalysis, receiveAiResult } from '../../src/domain/ai-draft';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), stat: vi.fn(), mkdir: vi.fn(), list: vi.fn(), write: vi.fn(), rm: vi.fn(),
  cli: vi.fn(), run: vi.fn(), project: vi.fn(), container: vi.fn(),
}));
vi.mock('node:fs/promises', async () => ({
  ...await vi.importActual('node:fs/promises'),
  readFile: mocks.read, lstat: mocks.stat, mkdir: mocks.mkdir, readdir: mocks.list,
  writeFile: mocks.write, rm: mocks.rm,
}));
vi.mock('../../scripts/backend/local.mjs', async () => ({
  ...await vi.importActual('../../scripts/backend/local.mjs'),
  cli: mocks.cli, runCommand: mocks.run, assertProjectConfig: mocks.project, requireLocalContainer: mocks.container,
}));
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const run = '510b0000-0000-4000-8000-000000000001';
const stage = path.join(ROOT, '.supabase', `preservation-stage-${run}`);
type Migration = { name: string; version: string; time: string };
const migrations = MIGRATIONS as Migration[];
const packagePath = createRequire(import.meta.url).resolve('supabase/package.json');
let files: Map<string, Buffer>, directories: Set<string>, applied: number;
const originalExitCode = process.exitCode;
const history = () => ({
  code: 0, stderr: '', stdout: [
    'Local | Remote | Time (UTC)', '-------|--------|-----------',
    ...migrations.map((m, i) => `\`${m.version}\` | \`${i < applied ? m.version : ' '}\` | \`${m.time}\``),
  ].join('\n'),
});
const node = (name: string, directory: boolean) => ({
  name, isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory,
});
beforeEach(async () => {
  vi.resetAllMocks(); files = new Map(); directories = new Set([path.dirname(stage)]); applied = 9;
  for (const key of Object.keys(process.env)) if (/(?:SERVICE[_-]?ROLE|SECRET[_-]?KEY|SUPABASE.*(?:SERVICE|SECRET|TOKEN)|DATABASE_URL|DB_PASSWORD|PGPASSWORD)/i.test(key)) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({
    ALLOW_CI_STORAGE_GUARD_INSTALL: '1', ALLOW_PRESERVATION_REHEARSAL: '1', CI: 'true',
    GITHUB_ACTIONS: 'true', GITHUB_JOB: 'database', GITHUB_REPOSITORY: 'drrowdev/stillroom-wardrobe',
  })) vi.stubEnv(key, value);
  const configPath = path.join(ROOT, 'supabase', 'config.toml');
  files.set(configPath, await actual.readFile(configPath));
  for (const migration of migrations) {
    const filename = path.join(ROOT, 'supabase', 'migrations', migration.name);
    files.set(filename, await actual.readFile(filename));
  }
  files.set(packagePath, Buffer.from(JSON.stringify({ version: '2.116.0', bin: { supabase: 'bin/supabase' } })));
  directories.add(path.join(ROOT, 'supabase', 'migrations'));
  mocks.read.mockImplementation(async (filename: string, encoding?: string) => {
    const data = files.get(filename); if (!data) throw new Error('Missing fixture path');
    return encoding === 'utf8' ? data.toString('utf8') : data;
  });
  mocks.stat.mockImplementation(async (filename: string) => {
    if (!directories.has(filename) && !files.has(filename)) throw new Error('Missing fixture path');
    return { ...node(path.basename(filename), directories.has(filename)), size: files.get(filename)?.length ?? 0 };
  });
  mocks.mkdir.mockImplementation(async (filename: string) => {
    if (files.has(filename) || directories.has(filename)) throw new Error('Existing fixture path');
    directories.add(filename);
  });
  mocks.write.mockImplementation(async (filename: string, bytes: Uint8Array, options: unknown) => {
    expect(options).toEqual({ flag: 'wx' }); expect(files.has(filename)).toBe(false);
    files.set(filename, Buffer.from(bytes));
  });
  mocks.list.mockImplementation(async (directory: string, options?: { withFileTypes?: boolean }) => {
    const entries = [...files.keys(), ...directories].filter((f) => path.dirname(f) === directory).sort();
    return entries.map((f) => options?.withFileTypes ? node(path.basename(f), directories.has(f)) : path.basename(f));
  });
  mocks.rm.mockResolvedValue(undefined);
  mocks.cli.mockImplementation(async (args: string[]) => { expect(args).toEqual(['migration', 'list', '--local']); return history(); });
  mocks.run.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('--version')) return { code: 0, stdout: '2.116.0\n', stderr: '' };
    if (args.includes('inspect')) return { code: 0, stdout: 'a'.repeat(64) + '\n', stderr: '' };
    expect(args.slice(-3)).toEqual(['migration', 'up', '--local']);
    applied = 10; return { code: 0, stdout: '', stderr: '' };
  });
});
afterEach(() => { vi.unstubAllEnvs(); process.exitCode = originalExitCode; vi.restoreAllMocks(); });
describe('copy-only populated ten-migration stage (mocked filesystem/processes; no database)', () => {
  it.each(['base', 'prior-main'])('copies only verified config and first ten files from %s, then proves ROOT history/container', async (from) => {
    applied = from === 'base' ? 1 : 9;
    await migrateToAzureTarget(run, from);
    expect(mocks.write).toHaveBeenCalledTimes(11);
    expect(mocks.write.mock.calls.map((args) => String(args[0])).sort()).toEqual([
      path.join(stage, 'supabase', 'config.toml'),
      ...migrations.slice(0, 10).map((m) => path.join(stage, 'supabase', 'migrations', m.name)),
    ].sort());
    expect(mocks.mkdir.mock.calls.every((args) => args.length === 1)).toBe(true);
    const mutation = mocks.run.mock.calls.filter((args) => (args[1] as string[]).includes('up'));
    expect(mutation).toHaveLength(1);
    expect(mutation[0]?.[1]).toEqual([path.join(path.dirname(packagePath), 'bin/supabase'),
      '--agent', 'no', '--workdir', stage, 'migration', 'up', '--local']);
    expect(mutation[0]?.[2]).toEqual({ timeout: 120_000 });
    expect(mocks.cli).toHaveBeenCalledTimes(3);
    expect(mocks.container).toHaveBeenCalledTimes(3);
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(stage, { recursive: true, force: false });
    expect(files.get(path.join(stage, 'supabase', 'config.toml'))).toEqual(files.get(path.join(ROOT, 'supabase', 'config.toml')));
    expect(files.has(path.join(stage, 'supabase', 'migrations', migrations[10]!.name))).toBe(false);
  });

  const ownerId = '10000000-0000-4000-8000-000000000001';
  const itemId = '20000000-0000-4000-8000-000000000001';
  const imageId = '30000000-0000-4000-8000-000000000001';
  function imageFixture() {
    const draft = newGarmentDraft('EUR', 'en');
    Object.assign(draft.raw, { title: '  Kept title  ', category: 'top', material: 'Cotton' });
    const values = validateGarmentDraft(draft).values!;
    values.title = '  Kept title  ';
    const item: ItemBaseline = { id: itemId, ownerId, version: 7, title: values.title, category: 'top',
      values, provenance: { material: { kind: 'ai_estimated', revision: 4 }, notes: { kind: 'user', revision: 2 } }, facts: {} };
    const image: ImageBaseline = { id: imageId, ownerId, itemId, version: 2, altText: 'Old photo',
      mainPath: `${ownerId}/${itemId}/${imageId}/main.jpg`, thumbPath: `${ownerId}/${itemId}/${imageId}/thumb.jpg` };
    const scope: OwnerScope = { ownerId, epoch: 2, signal: new AbortController().signal };
    const photo = { main: new Blob(['main']), thumb: new Blob(['thumb']), width: 120, height: 80,
      mainSha256: 'a'.repeat(64), thumbSha256: 'b'.repeat(64) };
    return { item, image, scope, photo, draft: newGarmentDraft('EUR', 'en', values) };
  }
  function imageAttempt() {
    const f = imageFixture();
    return newImageChangeAttempt(f.item, f.image, f.draft, 'New photo', f.photo, f.scope);
  }
  function changeReceipt(attempt = imageAttempt(), state: ImageChangeReceipt['state'] = 'reserved'): ImageChangeReceipt {
    return { requestId: attempt.intent.requestId, itemId, imageId: attempt.intent.imageId, kind: 'replacement',
      state, fingerprint: 'f'.repeat(64), completedVersion: state === 'completed' ? 8 : null };
  }
  describe('saved photo replacement domain', () => {
    it('freezes a full exact saved projection with new identities and unchanged revisions', () => {
      const f = imageFixture();
      const attempt = newImageChangeAttempt(f.item, f.image, f.draft, ' New photo ', f.photo, f.scope);
      expect(attempt.intent.item).toMatchObject({ title: '  Kept title  ', material: 'Cotton', field_provenance: f.item.provenance });
      expect(attempt.intent.imageId).not.toBe(imageId);
      expect(attempt.intent.requestId).not.toBe(attempt.intent.imageId);
      expect(attempt.intent).toMatchObject({ expectedVersion: 7, currentImageId: imageId, descriptionVersion: 2, claim: null, sourceImageId: null });
      expect(attempt.intent.image.alt_text).toBe('New photo');
      expect(Object.isFrozen(attempt.intent.item.field_provenance)).toBe(true);
      expect(f.draft.intent).toEqual({});
    });
    it('advances exactly once for an estimate confirmation and an explicit clear', () => {
      const f = imageFixture();
      let draft = editGarmentField(f.draft, 'material', 'Cotton', 'en');
      draft = editGarmentField(draft, 'notes', '', 'en');
      const attempt = newImageChangeAttempt(f.item, f.image, draft, '', f.photo, f.scope);
      expect(attempt.intent.item.field_provenance).toEqual({ material: { kind: 'user', revision: 5 }, notes: { kind: 'user', revision: 3 } });
      expect(f.item.provenance.material).toEqual({ kind: 'ai_estimated', revision: 4 });
    });
    it('admits only actually derived empty untouched facts and advances the prior revision', () => {
      const f = imageFixture();
      f.item.provenance.pattern = { kind: 'unknown', revision: 3 };
      const context = { ownerId, epoch: 2, draftId: crypto.randomUUID(), generation: 1, requestId: crypto.randomUUID(), imageSha256: f.photo.mainSha256 };
      const created = createAiDraft(f.draft, context, { values: f.item.values, provenance: f.item.provenance });
      if (!created.ok) throw new Error('Fixture');
      const pending = beginAiAnalysis(created.state, context);
      const state = receiveAiResult(pending.state, context, {
        schemaVersion: 1, requestId: context.requestId, draftId: context.draftId, generation: context.generation,
        imageSha256: context.imageSha256, modelId: 'fictional:model/v1', promptVersion: 1,
        createdAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 60000,
        facts: { outcome: 'ready', fields: { pattern: 'solid', material: 'Wool' } },
      }, Date.now()).state;
      expect(state.status).toBe('ready');
      const savedDraft = state.draft!;
      const attempt = newImageChangeAttempt(f.item, f.image, {
        raw: { ...savedDraft.raw, colours: [...savedDraft.raw.colours], seasons: [...savedDraft.raw.seasons],
          style_tags: [...savedDraft.raw.style_tags], tags: [...savedDraft.raw.tags] },
        intent: { ...savedDraft.intent }, priceLanguage: savedDraft.priceLanguage,
      }, '', f.photo, f.scope, state);
      expect(attempt.intent.item.pattern).toBe('solid');
      expect(attempt.intent.item.material).toBe('Cotton');
      expect(attempt.intent.item.field_provenance).toMatchObject({ pattern: { kind: 'ai_observed', revision: 4 } });
    });
    it.each(['owner', 'version', 'revision', 'caption', 'hidden-change'])('rejects %s drift', (failure) => {
      const f = imageFixture();
      if (failure === 'owner') f.item.ownerId = crypto.randomUUID();
      if (failure === 'version') f.item.version = Number.MAX_SAFE_INTEGER;
      if (failure === 'revision') { f.item.provenance.material!.revision = 2147483647; f.draft = editGarmentField(f.draft, 'material', 'Wool', 'en'); }
      if (failure === 'caption') f.image.version = 0;
      if (failure === 'hidden-change') f.draft.raw.title = 'Not an edit';
      expect(() => newImageChangeAttempt(f.item, f.image, f.draft, '', f.photo, f.scope)).toThrow();
    });
    it('requires exact receipt keys, identities, states and safe versions', () => {
      const receipt = changeReceipt();
      expect(parseImageChangeReceipt(receipt, itemId)).toEqual(receipt);
      for (const wrong of [{ ...receipt, extra: true }, { ...receipt, itemId: imageId }, { ...receipt, state: 'absent' },
        { ...receipt, completedVersion: 8 }, { ...receipt, state: 'completed', completedVersion: 9007199254740992 }]) {
        expect(() => parseImageChangeReceipt(wrong, itemId)).toThrow();
      }
    });
    it('parses server eligibility, exact retired metadata, ordering and forty-row boundary', () => {
      const row = { image: { id: imageId, owner_id: ownerId, item_id: itemId, state: 'retired',
        main_path: `${ownerId}/${itemId}/${imageId}/main.jpg`, thumb_path: `${ownerId}/${itemId}/${imageId}/thumb.jpg`,
        main_bytes: 4, thumb_bytes: 5, main_sha256: 'a'.repeat(64), thumb_sha256: 'b'.repeat(64),
        width: 120, height: 80, alt_text: 'Old photo', description_version: 2,
        retired_at: '2026-09-20T10:00:00Z', created_at: '2026-09-01T10:00:00Z' }, eligible: true };
      const [source] = parseRecoveryVersions([row], ownerId, itemId);
      expect(source!.eligible).toBe(true);
      const f = imageFixture();
      f.image.id = '30000000-0000-4000-8000-000000000002';
      const recovered = newImageChangeAttempt(f.item, f.image, editGarmentField(f.draft, 'title', 'Ignored', 'en'),
        'Edited caption', f.photo, f.scope, undefined, source);
      expect(recovered.intent.item.title).toBe(f.item.title);
      expect(recovered.intent.item.field_provenance).toEqual(f.item.provenance);
      expect(recovered.intent.sourceImageId).toBe(imageId);
      expect(recovered.intent.imageId).not.toBe(imageId);
      expect(recovered.intent.claim).toBeNull();
      expect(() => parseRecoveryVersions([row, row], ownerId, itemId)).toThrow();
      expect(() => parseRecoveryVersions([row], ownerId, itemId, imageId)).toThrow();
      expect(() => parseRecoveryVersions(Array(41).fill(row), ownerId, itemId)).toThrow();
      expect(() => parseRecoveryVersions([{ ...row, eligible: 1 }], ownerId, itemId)).toThrow();
    });
  });

  describe('image change client (mocked ordinary client, not native evidence)', () => {
    function transport(attempt = imageAttempt()) {
      const f = imageFixture();
      let stored: ImageChangeReceipt | null = null;
      const calls: string[] = [];
      const rpc = vi.fn((name: string): { abortSignal: () => Promise<{ error: unknown; data: unknown }> } => ({ abortSignal: async () => {
        calls.push(name);
        if (name === 'image_change_status') return { error: null, data: stored };
        if (name === 'reserve_image_change') { stored = changeReceipt(attempt); return { error: null, data: stored }; }
        throw new Error('Unexpected fixture RPC');
      } }));
      const upload = vi.fn(async () => ({ error: null }));
      const download = vi.fn(async (path: string) => ({ error: null, data: path.endsWith('main.jpg') ? attempt.photo.main : attempt.photo.thumb }));
      const invoke = vi.fn(async (): Promise<{ error: unknown; data: unknown }> => {
        calls.push('complete'); stored = changeReceipt(attempt, 'completed'); return { error: null, data: null };
      });
      const client = { rpc, storage: { from: () => ({ upload, download }) }, functions: { invoke } } as unknown as AppClient;
      return { ...f, attempt, calls, rpc, upload, download, invoke, client: new ImageChangeClient(client, f.scope),
        stored: (value: ImageChangeReceipt | null) => { stored = value; } };
    }
    it('checks status, reserves only on explicit Save, uploads immutable paths and confirms completion', async () => {
      const f = transport();
      expect(f.rpc).not.toHaveBeenCalled();
      const receipt = await f.client.save(f.attempt, vi.fn(), vi.fn());
      expect(receipt.state).toBe('completed');
      expect(f.calls).toEqual(['image_change_status', 'reserve_image_change', 'complete', 'image_change_status']);
      expect(f.upload).toHaveBeenCalledTimes(2);
      expect(f.upload.mock.calls[0]).toEqual([`${ownerId}/${itemId}/${f.attempt.intent.imageId}/thumb.jpg`, f.attempt.photo.thumb,
        { contentType: 'image/jpeg', upsert: false, cacheControl: '0' }]);
    });
    it('retains an accepted reservation on retry without a second reserve or inference', async () => {
      const f = transport(); f.stored(changeReceipt(f.attempt));
      await f.client.save(f.attempt, vi.fn(), vi.fn());
      expect(f.calls).toEqual(['image_change_status', 'complete', 'image_change_status']);
    });
    it('uses only status and authenticated GET for completed retries, with no POST even on bad bytes', async () => {
      const f = transport(); f.stored(changeReceipt(f.attempt, 'completed'));
      await expect(f.client.save(f.attempt, vi.fn(), vi.fn())).rejects.toThrow('error.conflict');
      expect(f.calls).toEqual(['image_change_status']);
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.upload).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
    });
    it('rejects cancelled receipt and cross-owner attempts before upload', async () => {
      const f = transport(); f.stored(changeReceipt(f.attempt, 'cancelled'));
      await expect(f.client.save(f.attempt, vi.fn(), vi.fn())).rejects.toThrow();
      await expect(f.client.save({ ...f.attempt, ownerId: imageId }, vi.fn(), vi.fn())).rejects.toThrow();
      expect(f.upload).not.toHaveBeenCalled();
    });
    it('does not treat missing status as successful cancellation', async () => {
      const f = transport();
      await expect(f.client.cancel(changeReceipt(f.attempt))).rejects.toThrow();
      expect(f.calls).toEqual(['image_change_status']);
    });
    it('verifies both completed byte copies without repeating any write', async () => {
      const source = imageFixture();
      const digest = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      source.photo.mainSha256 = await digest(source.photo.main);
      source.photo.thumbSha256 = await digest(source.photo.thumb);
      const attempt = newImageChangeAttempt(source.item, source.image, source.draft, '', source.photo, source.scope);
      const f = transport(attempt); f.stored(changeReceipt(attempt, 'completed'));
      await expect(f.client.save(attempt, vi.fn(), vi.fn())).resolves.toEqual(changeReceipt(attempt, 'completed'));
      expect(f.calls).toEqual(['image_change_status']);
      expect(f.download.mock.calls.map(([path]) => path)).toEqual([
        `${ownerId}/${itemId}/${attempt.intent.imageId}/thumb.jpg`, `${ownerId}/${itemId}/${attempt.intent.imageId}/main.jpg`,
      ]);
      expect(f.upload).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
    });
    it('omits the initial recovery cursor and sends only the subsequent exact cursor', async () => {
      const f = transport();
      f.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: [] }) }));
      await expect(f.client.versions(itemId)).resolves.toEqual([]);
      await expect(f.client.versions(itemId, imageId)).resolves.toEqual([]);
      expect(f.rpc).toHaveBeenNthCalledWith(1, 'image_recovery_versions', { p_item_id: itemId });
      expect(f.rpc).toHaveBeenNthCalledWith(2, 'image_recovery_versions', { p_item_id: itemId, p_after: imageId });
      expect(f.invoke).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
    });
    it.each(['completed', 'cancelled'] as const)('reconciles %s before cancellation without another mutation', async state => {
      const f = transport(); f.stored(changeReceipt(f.attempt, state));
      await expect(f.client.cancel(changeReceipt(f.attempt))).resolves.toEqual(changeReceipt(f.attempt, state));
      expect(f.calls).toEqual(['image_change_status']);
      expect(f.upload).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
    });
    it('rejects changed fingerprint on cancellation before issuing the cancel RPC', async () => {
      const f = transport(); f.stored({ ...changeReceipt(f.attempt), fingerprint: 'e'.repeat(64) });
      await expect(f.client.cancel(changeReceipt(f.attempt))).rejects.toThrow('error.conflict');
      expect(f.calls).toEqual(['image_change_status']);
    });
    it.each([
      ['CONFLICT', 'error.conflict'], ['UPLOAD_INCOMPLETE', 'error.uploadIncomplete'],
    ])('preserves the exact bounded finalizer %s error', async (code, message) => {
      const f = transport();
      f.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify({ code }),
        { status: 409, headers: { 'Content-Type': 'application/json' } })) });
      await expect(f.client.save(f.attempt, vi.fn(), vi.fn())).rejects.toThrow(message);
      expect(f.calls).toEqual(['image_change_status', 'reserve_image_change']);
      expect(f.upload).toHaveBeenCalledTimes(2);
    });
    it.each([
      { body: { code: 'CONFLICT', extra: true }, status: 409, type: 'application/json' },
      { body: { code: 'CONFLICT' }, status: 500, type: 'application/json' },
      { body: { code: 'CONFLICT' }, status: 409, type: 'text/plain' },
      { body: { code: 'x'.repeat(1024) }, status: 409, type: 'application/json' },
    ])('rejects unrecognized finalizer errors without confirming completion: %j', async ({ body, status, type }) => {
      const f = transport();
      f.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify(body),
        { status, headers: { 'Content-Type': type } })) });
      await expect(f.client.save(f.attempt, vi.fn(), vi.fn())).rejects.toThrow('error.unavailable');
      expect(f.calls).toEqual(['image_change_status', 'reserve_image_change']);
    });
    it('bounds a stalled status by thirty seconds without starting reservation or upload', async () => {
      vi.useFakeTimers();
      try {
        const f = transport();
        f.rpc.mockImplementation(() => ({ abortSignal: () => new Promise(() => {}) }));
        const failure = expect(f.client.save(f.attempt, vi.fn(), vi.fn())).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(30000);
        await failure;
        expect(f.rpc).toHaveBeenCalledTimes(1);
        expect(f.upload).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
  });
  it.each(['../escape', '', '510b0000-0000-4000-8000-000000000001/child'])('rejects unsafe stage identity %s', (id) => {
    expect(() => preservationStagePath(id)).toThrow(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects an existing stage without deleting or adopting it', async () => {
    directories.add(stage);
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.rm).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
  });
  it('rejects a symlinked parent before any copy/CLI', async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => true });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects changed source bytes and never copies unverified migrations', async () => {
    files.set(path.join(ROOT, 'supabase', 'migrations', migrations[0]!.name), Buffer.from('changed'));
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.mkdir).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it('does not fall through to ROOT migration up on a staged CLI failure', async () => {
    mocks.run.mockImplementation(async (_command: string, args: string[]) => args.includes('--version')
      ? { code: 0, stdout: '2.116.0', stderr: '' } : args.includes('inspect')
        ? { code: 0, stdout: 'a'.repeat(64), stderr: '' } : { code: 1, stdout: '', stderr: '' });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(stage, { recursive: true, force: false });
    expect(mocks.run.mock.calls.filter((args) => (args[1] as string[]).includes('up'))).toHaveLength(1);
  });
  it('refuses a different database container after the copy instead of migrating it', async () => {
    let inspections = 0;
    mocks.run.mockImplementation(async (_command: string, args: string[]) => args.includes('--version')
      ? { code: 0, stdout: '2.116.0', stderr: '' }
      : { code: 0, stdout: (++inspections === 1 ? 'a' : 'b').repeat(64), stderr: '' });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('rejects changed copied config before migration rather than trimming function declarations', async () => {
    const original = mocks.write.getMockImplementation()!;
    mocks.write.mockImplementation(async (...args: unknown[]) => {
      await original(...args);
      if (args[0] === path.join(stage, 'supabase', 'config.toml')) files.set(String(args[0]), Buffer.from('changed'));
    });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('rejects ROOT ledger drift after copying and before any staged migration', async () => {
    let reads = 0;
    mocks.cli.mockImplementation(async () => { if (++reads === 2) applied = 10; return history(); });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(mocks.run.mock.calls.some((args) => (args[1] as string[]).includes('up'))).toBe(false);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('does not claim successful staging if the command leaves nine applied migrations', async () => {
    mocks.run.mockImplementation(async (_command: string, args: string[]) => args.includes('--version')
      ? { code: 0, stdout: '2.116.0', stderr: '' } : args.includes('inspect')
        ? { code: 0, stdout: 'a'.repeat(64), stderr: '' } : { code: 0, stdout: '', stderr: '' });
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow();
    expect(applied).toBe(9); expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
  it('keeps a cleanup failure nonzero even after successful migration', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rm.mockRejectedValue(new Error('Owned cleanup unavailable'));
    await expect(migrateToAzureTarget(run, 'prior-main')).rejects.toThrow('Owned cleanup unavailable');
    expect(process.exitCode).toBe(1); expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(stage, { recursive: true, force: false });
  });
});
