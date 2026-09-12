import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/data/database.types';
import type { OwnerScope } from '../../src/auth/session';
import { beginAiAnalysis, createAiDraft, editAiDraftField, receiveAiResult, type AiTransition } from '../../src/domain/ai-draft';
import { newAnalyzedSaveAttempt, newUnverifiedSaveAttempt } from '../../src/domain/analyzed-save';
import { buildGarmentWrite, editGarmentField, newGarmentDraft } from '../../src/domain/garment-fields';
import { saveAnalyzedItem } from '../../src/images/upload';

const owner = '10000000-0000-4000-8000-000000000001';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const photo = { main: new Blob(['main'], { type: 'image/jpeg' }), thumb: new Blob(['thumb'], { type: 'image/jpeg' }),
  mainSha256: sha('main'), thumbSha256: sha('thumb'), width: 120, height: 80 };
const context = { ownerId: owner, epoch: 1, draftId: '20000000-0000-4000-8000-000000000001',
  requestId: '30000000-0000-4000-8000-000000000001', generation: 1, imageSha256: photo.mainSha256 };
const next = (value: AiTransition) => {
  if (value.status !== 'updated') throw new Error('Expected update');
  return value.state;
};
function fixture() {
  const controller = new AbortController();
  const scope: OwnerScope = { ownerId: owner, epoch: 1, signal: controller.signal };
  const draft = editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'Manual title', 'en');
  const created = createAiDraft(draft, context);
  if (!created.ok) throw new Error('Expected draft');
  const state = next(receiveAiResult(next(beginAiAnalysis(created.state, context)), context, {
    schemaVersion: 1, requestId: context.requestId, draftId: context.draftId, generation: 1,
    imageSha256: photo.mainSha256, modelId: 'gemini-3.8-flash', promptVersion: 1, createdAtMs: 500, expiresAtMs: 2000,
    facts: { outcome: 'ready', fields: { category: 'top', colours: ['green'], formality: 0 } },
  }, 1000));
  return { state, scope, controller };
}

describe('separate analyzed and explicitly unverified composition', () => {
  it('keeps user, observed, estimated and unknown assertions separate and freezes the attempt', () => {
    const { state, scope } = fixture();
    const attempt = newAnalyzedSaveAttempt(state, context, '', photo, scope, 1000);
    expect(attempt.payload.field_provenance).toEqual({
      title: { kind: 'user', revision: 1 }, category: { kind: 'ai_observed', revision: 1 },
      colours: { kind: 'ai_observed', revision: 1 }, formality: { kind: 'ai_estimated', revision: 1 },
    });
    expect(Object.isFrozen(attempt.claim?.fields)).toBe(true);
    expect(Object.isFrozen(attempt.values.colours)).toBe(true);
    expect(attempt.photo.main).toBe(photo.main);
    if (state.status === 'invalidated') throw new Error('Expected active');
    expect(() => buildGarmentWrite({
      raw: { ...state.draft.raw, colours: [...state.draft.raw.colours], seasons: [], style_tags: [], tags: [] },
      intent: { ...state.draft.intent }, priceLanguage: 'en',
    })).toThrow('detail.invalidFields');
  });
  it.each([['colours', []], ['formality', ''], ['category', 'top']] as const)('preserves manual override or clear of %s', (field, value) => {
    const { state, scope } = fixture();
    const edited = next(editAiDraftField(state, context, field, typeof value === 'string' ? value : [...value], 'en'));
    const attempt = newAnalyzedSaveAttempt(edited, context, '', photo, scope, 1000);
    expect(attempt.payload.field_provenance[field]).toEqual({ kind: 'user', revision: 1 });
    expect(attempt.claim?.fields[field]).toBeUndefined();
  });
  it('never silently downgrades expired, changed-photo, changed-owner or changed-epoch proof', () => {
    const { state, scope, controller } = fixture();
    for (const now of [499, 2000, 3000]) expect(() => newAnalyzedSaveAttempt(state, context, '', photo, scope, now)).toThrow('error.conflict');
    expect(() => newAnalyzedSaveAttempt(state, context, '', { ...photo, mainSha256: 'b'.repeat(64) }, scope, 1000)).toThrow();
    expect(() => newAnalyzedSaveAttempt(state, context, '', photo, { ...scope, ownerId: context.draftId }, 1000)).toThrow();
    expect(() => newAnalyzedSaveAttempt(state, context, '', photo, { ...scope, epoch: 2 }, 1000)).toThrow();
    controller.abort();
    expect(() => newAnalyzedSaveAttempt(state, context, '', photo, scope, 1000)).toThrow();
  });
  it('requires a separate unverified snapshot and emits explicit unknown@1', () => {
    const { scope } = fixture();
    const draft = newGarmentDraft('EUR', 'en');
    draft.raw.title = 'Retained'; draft.raw.category = 'top'; draft.raw.warmth = '2';
    const attempt = newUnverifiedSaveAttempt(draft, '', photo, scope);
    expect(attempt.claim).toBeNull();
    expect(attempt.payload.field_provenance).toEqual(Object.fromEntries(['title', 'category', 'warmth']
      .map((field) => [field, { kind: 'unknown', revision: 1 }])));
    expect(newUnverifiedSaveAttempt(draft, '', photo, scope).itemId).not.toBe(attempt.itemId);
  });
});

describe('connected analyzed Save (actual SDK; synthetic HTTP only)', () => {
  function api() {
    const { state, scope, controller } = fixture();
    const attempt = newAnalyzedSaveAttempt(state, context, '', photo, scope, 1000);
    const prefix = `${owner}/${attempt.itemId}/${attempt.imageId}`;
    const calls: string[] = [];
    const requests: Array<{ path: string; method: string; cache: RequestCache | undefined;
      hasAuthorization: boolean; hasApiKey: boolean }> = [];
    const bodies: unknown[] = [];
    let completed = false, lost = false, drift = 0;
    let finalizerResponse: (() => Response) | undefined;
    const files = new Map<string, Blob>();
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      requests.push({ path, method: init?.method ?? 'GET', cache: init?.cache,
        hasAuthorization: Boolean(headers.get('authorization')), hasApiKey: Boolean(headers.get('apikey')) });
      calls.push(path); bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
      if (drift === calls.length) scope.epoch++;
      if (path.endsWith('/reserve_analyzed_item_save')) return Response.json([{
        item: { ...attempt.payload, id: attempt.itemId, owner_id: owner, version: 1, deleted_at: null,
          created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z' },
        image: { id: attempt.imageId, owner_id: owner, item_id: attempt.itemId, main_path: `${prefix}/main.jpg`,
          thumb_path: `${prefix}/thumb.jpg`, main_bytes: photo.main.size, thumb_bytes: photo.thumb.size,
          main_sha256: photo.mainSha256, thumb_sha256: photo.thumbSha256, width: 120, height: 80,
          state: completed ? 'ready' : 'pending', retired_at: null, description_version: 1, alt_text: '', created_at: '2026-09-12T00:00:00Z' },
        state: completed ? 'completed' : 'reserved', fingerprint: 'c'.repeat(64),
      }]);
      if (path.endsWith('/finalize-analyzed-item')) {
        if (finalizerResponse) return finalizerResponse();
        completed = true;
        return lost ? Response.json({ code: 'TIMEOUT' }, { status: 504 }) : new Response(null, { status: 204 });
      }
      if (path.includes('/storage/v1/object/')) {
        if (init?.method === 'POST') {
          if (files.has(path)) return Response.json({ statusCode: '409' }, { status: 409 });
          if (!(init.body instanceof FormData)) throw new Error('Expected upload');
          const body = init.body.get('');
          if (!(body instanceof Blob)) throw new Error('Expected blob');
          expect(new Headers(init.headers).get('x-upsert')).toBe('false');
          files.set(path, body); return Response.json({});
        }
        const file = files.get(path.replace('/authenticated/', '/'));
        if (!file) throw new Error('Missing fixture object');
        return new Response(file);
      }
      throw new Error('Unexpected route');
    });
    const client = createClient<Database>('http://127.0.0.1:54321', 'public-fixture-only', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    return { client, scope, attempt, calls, requests, bodies, files, controller, lose: (value: boolean) => { lost = value; }, drift: (n: number) => { drift = n; },
      respond: (response: () => Response) => { finalizerResponse = response; }, completed: () => completed };
  }
  it('routes only through analyzed reserve, immutable uploads and finalizer, preserving frozen proof on lost-reply retry', async () => {
    const a = api(); a.lose(true);
    await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow('error.unavailable');
    expect(a.completed()).toBe(true);
    const stored = [...a.files.entries()];
    a.lose(false);
    await saveAnalyzedItem(a.client, a.scope, a.attempt, () => {});
    expect(a.bodies[0]).toEqual(a.bodies[4]);
    expect(a.calls.filter((p) => p.endsWith('/finalize-analyzed-item'))).toHaveLength(2);
    expect(a.requests.filter(({ method }) => method === 'GET')).toEqual(['thumb', 'main'].map((variant) => ({
      path: `/storage/v1/object/wardrobe/${owner}/${a.attempt.itemId}/${a.attempt.imageId}/${variant}.jpg`,
      method: 'GET', cache: 'no-store', hasAuthorization: true, hasApiKey: true,
    })));
    expect([...a.files.entries()]).toEqual(stored);
    expect(a.calls.some((p) => /analyze-clothing|finalize_item_save|commit_image/.test(p))).toBe(false);
  });
  it.each([['CONFLICT', 'error.conflict'], ['UPLOAD_INCOMPLETE', 'error.uploadIncomplete']] as const)(
    'preserves checked HTTP 409 %s without completing or retrying the fixture', async (code, key) => {
      const a = api(); a.respond(() => Response.json({ code }, { status: 409 }));
      await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow(key);
      expect(a.completed()).toBe(false); expect(a.calls).toHaveLength(4);
    },
  );
  it.each([
    ['unknown code', () => Response.json({ code: 'UNKNOWN' }, { status: 409 })],
    ['extra field', () => Response.json({ code: 'CONFLICT', detail: 'synthetic' }, { status: 409 })],
    ['array', () => Response.json([{ code: 'CONFLICT' }], { status: 409 })],
    ['null', () => Response.json(null, { status: 409 })],
    ['absent body', () => new Response(null, { status: 409, headers: { 'Content-Type': 'application/json' } })],
    ['malformed JSON', () => new Response('{', { status: 409, headers: { 'Content-Type': 'application/json' } })],
    ['wrong media type', () => new Response('{"code":"CONFLICT"}', { status: 409 })],
    ['mismatched conflict status', () => Response.json({ code: 'CONFLICT' }, { status: 400 })],
    ['mismatched incomplete status', () => Response.json({ code: 'UPLOAD_INCOMPLETE' }, { status: 503 })],
    ['timeout', () => Response.json({ code: 'TIMEOUT' }, { status: 504 })],
    ['network failure', () => { throw new TypeError('Synthetic transport failure'); }],
    ['invalid UTF-8', () => new Response(new Uint8Array([255]), { status: 409, headers: { 'Content-Type': 'application/json' } })],
    ['failed body', () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('Synthetic body failure')); },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })],
  ] as const)('maps %s to explicit unavailable without completing', async (_name, response) => {
    const a = api(); a.respond(response);
    await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow('error.unavailable');
    expect(a.completed()).toBe(false); expect(a.calls).toHaveLength(4);
  });
  it.each([[1024, 'error.conflict'], [1025, 'error.unavailable']] as const)(
    'enforces the exact %s-byte error-body boundary', async (size, key) => {
      const a = api();
      a.respond(() => new Response('{"code":"CONFLICT"}'.padEnd(size, ' '),
        { status: 409, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow(key);
      expect(a.completed()).toBe(false); expect(a.calls).toHaveLength(4);
    },
  );
  it('bounds cumulative error bytes and cancels the unread remainder', async () => {
    const a = api(), cancel = vi.fn();
    let pulls = 0;
    a.respond(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(' '.repeat(513)));
      },
      cancel,
    }, { highWaterMark: 0 }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow('error.unavailable');
    expect(pulls).toBe(2); expect(cancel).toHaveBeenCalledOnce();
    expect(a.completed()).toBe(false); expect(a.calls).toHaveLength(4);
  });
  it('aborts a pending error-body read and releases the response stream', async () => {
    const a = api(), cancel = vi.fn();
    let started: () => void = () => {};
    const reading = new Promise<void>((resolve) => { started = resolve; });
    a.respond(() => new Response(new ReadableStream<Uint8Array>({
      pull() { started(); },
      cancel,
    }, { highWaterMark: 0 }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    const saving = expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toMatchObject({ name: 'AbortError' });
    await reading; a.controller.abort(); await saving;
    expect(cancel).toHaveBeenCalledOnce(); expect(a.completed()).toBe(false);
    expect(a.calls).toHaveLength(4);
  });
  it.each(['owner', 'epoch'] as const)('rejects %s drift while reading a checked error body', async (change) => {
    const a = api();
    a.respond(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (change === 'owner') a.scope.ownerId = context.draftId;
        else a.scope.epoch++;
        controller.enqueue(new TextEncoder().encode('{"code":"UPLOAD_INCOMPLETE"}'));
        controller.close();
      },
    }, { highWaterMark: 0 }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(a.completed()).toBe(false); expect(a.calls).toHaveLength(4);
  });
  it.each([1, 2, 3, 4])('rejects owner scope drift at boundary %s', async (boundary) => {
    const a = api(); a.drift(boundary);
    await expect(saveAnalyzedItem(a.client, a.scope, a.attempt, () => {})).rejects.toThrow('error.conflict');
    expect(a.calls).toHaveLength(boundary);
  });
});

describe('B2 SQL boundary (source assertions, not live proof)', () => {
  it('keeps the extracted admission body exact except for allowed kinds and canonical class preservation', async () => {
    const old = await readFile(new URL('../../supabase/migrations/20260910070000_checked_item_save.sql', import.meta.url), 'utf8');
    const added = await readFile(new URL('../../supabase/migrations/20260911200000_checked_ai_item_save.sql', import.meta.url), 'utf8');
    const body = (source: string, name: string) => {
      const start = source.indexOf(`create function ${name}(`);
      const begin = source.indexOf('$$', start) + 2;
      return source.slice(begin, source.indexOf('$$;', begin));
    };
    const expected = body(old, 'public.reserve_item_save')
      .replace("or v<>jsonb_build_object('kind','user','revision',1)",
        "or not coalesce(v->>'kind'=any(p_kinds),false)\n      or v<>jsonb_build_object('kind',v->>'kind','revision',1)")
      .replace("jsonb_object_agg(key,jsonb_build_object('kind','user','revision',1))", "jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1))")
      .replace('  -- Existing public identities are never adopted; uniqueness errors are closed below.\n', '');
    expect(body(added, 'private.reserve_item_save')).toBe(expected);
    expect(added).toContain('a.claim_hash is distinct from encode(sha256(convert_to(p_claim::text');
    expect(added).toContain('and entry is distinct from old.field_provenance->field');
    expect(added).toContain('on delete set null(source_image_id)');
    expect(added).not.toMatch(/set_config|current_setting|when others|create extension/i);
    const completion = body(added, 'public.complete_analyzed_item_save');
    expect(completion).not.toMatch(/auth\.uid|commit_item_save_image|item_save_owner/);
    expect(completion.indexOf("set state='ready'")).toBeLessThan(completion.indexOf('insert into private.item_attribution_history'));
  });
});
