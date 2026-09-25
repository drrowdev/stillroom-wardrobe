// A synthetic owner snapshot large enough for two photo parts, with a fake client shaped like the calls
// src/data/export.ts makes. Entropy is replaced only inside `withEntropy`, so the encrypted output is reproducible.
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { canonical, decryptPart, rawColumns, type RawTable } from '../../src/domain/export-format';

export const PARITY_OWNER = '11111111-1111-4111-8111-111111111111';
export const PARITY_EXPORT = '22222222-2222-4222-8222-222222222222';
export const PARITY_PASSPHRASE = 'a long synthetic parity passphrase';
const stamp = '2026-09-25T10:00:00+00:00';
const later = '2026-09-25T11:00:00+00:00';
export const parityId = (group: number, n: number) => `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

type Row = Record<string, unknown>;
function row(table: RawTable, values: Row): Row {
  const base: Row = Object.fromEntries(rawColumns[table].map(column => [column, null]));
  return { ...base, owner_id: PARITY_OWNER, ...values };
}

// Deterministic, non-JPEG bytes; the exporter checks only length and hash.
export function photoBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = (seed * 2654435761) >>> 0;
  for (let index = 0; index < length; index++) { state = (state * 1103515245 + 12345) >>> 0; bytes[index] = state >>> 24; }
  return bytes;
}

export type ParityWorld = { raw: Row; objects: Map<string, Uint8Array>; attributions: Map<string, unknown> };

export function parityWorld(itemCount = 26, mainBytes = 512_000, thumbBytes = 61_440): ParityWorld {
  const objects = new Map<string, Uint8Array>();
  const items: Row[] = [], images: Row[] = [];
  const addImage = (item: string, n: number, state: 'ready' | 'retired' | 'pending') => {
    const id = parityId(3, n);
    const main = photoBytes(n * 2, mainBytes), thumb = photoBytes(n * 2 + 1, thumbBytes);
    const mainPath = `${PARITY_OWNER}/${item}/${id}/main.jpg`, thumbPath = `${PARITY_OWNER}/${item}/${id}/thumb.jpg`;
    objects.set(mainPath, main); objects.set(thumbPath, thumb);
    images.push(row('item_images', { id, item_id: item, state, retired_at: state === 'retired' ? later : null, main_path: mainPath, thumb_path: thumbPath,
      main_bytes: main.length, thumb_bytes: thumb.length, main_sha256: digest(main), thumb_sha256: digest(thumb), width: 800, height: 1000,
      alt_text: `Photo ${n}`, created_at: stamp, description_version: 1 }));
    return id;
  };
  for (let n = 1; n <= itemCount; n++) {
    const id = parityId(2, n);
    items.push(row('items', { id, title: `Synthetic garment ${n}`, category: n % 2 ? 'top' : 'bottom', colours: ['black'], deleted_at: null,
      created_at: stamp, updated_at: stamp, version: 1, favourite: false, availability: 'available', lifecycle: 'active', field_provenance: {} }));
    addImage(id, n, 'ready');
  }
  const first = parityId(2, 1), second = parityId(2, 2);
  addImage(first, 900, 'retired');
  addImage(second, 901, 'pending');
  const trashed = parityId(2, 999);
  items.push(row('items', { id: trashed, title: 'Trashed', category: 'top', deleted_at: later, created_at: stamp, updated_at: stamp, version: 2 }));
  addImage(trashed, 902, 'ready');
  const outfit = parityId(4, 1), event = parityId(5, 1);
  const raw = {
    schema_version: 2, export_id: PARITY_EXPORT, owner_id: PARITY_OWNER, created_at: stamp,
    tables: {
      profiles: [row('profiles', { display_name: 'Synthetic', ui_language: 'en', timezone: 'Europe/Helsinki', currency: 'EUR', weather_enabled: true,
        created_at: stamp, updated_at: stamp, version: 1 })],
      style_preferences: [row('style_preferences', { preferred_colours: [], style_tags: [], excluded_categories: [], created_at: stamp, updated_at: stamp, version: 1 })],
      items, item_images: images,
      outfits: [row('outfits', { id: outfit, title: 'Synthetic outfit', deleted_at: null, favourite: false, created_at: stamp, updated_at: stamp, version: 1 })],
      outfit_items: [row('outfit_items', { outfit_id: outfit, item_id: first, position: 0 }), row('outfit_items', { outfit_id: outfit, item_id: second, position: 1 })],
      wear_events: [row('wear_events', { id: event, outfit_id: outfit, local_date: '2026-09-24', timezone: 'Europe/Helsinki', state: 'worn', deleted_at: null,
        created_at: stamp, updated_at: stamp, version: 1 })],
      wear_event_items: [row('wear_event_items', { id: parityId(6, 1), event_id: event, item_id: first, title_snapshot: 'Synthetic garment 1', category_snapshot: 'top' }),
        row('wear_event_items', { id: parityId(6, 2), event_id: event, item_id: trashed, title_snapshot: 'Trashed', category_snapshot: 'top' })],
      combination_rules: [row('combination_rules', { id: parityId(7, 1), item_low: first, item_high: second, created_at: stamp })],
      suggestion_feedback: [row('suggestion_feedback', { id: parityId(8, 1), item_ids: [first, second], signature: 'sig', vote: 'up', created_at: stamp })],
    },
  };
  const attributions = new Map<string, unknown>(items.filter(item => item.deleted_at === null).map(item => [String(item.id), []]));
  attributions.set(first, [{ source_image_id: parityId(3, 900), image_sha256: images.find(image => image.id === parityId(3, 900))!.main_sha256,
    model_id: 'synthetic-model', prompt_version: 3, fields: { category: 'top' } }]);
  return { raw, objects, attributions };
}

// The subset of the supabase-js surface that src/data/export.ts calls.
export function parityClient(world: ParityWorld, calls: string[] = []) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      return { abortSignal: async (signal: AbortSignal) => {
        calls.push(name);
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (name === 'export_manifest') return { data: { ...world.raw, export_id: args.p_export_id }, error: null };
        if (name === 'item_attribution_history') {
          const value = world.attributions.get(String(args.p_item_id));
          return value === undefined ? { data: null, error: { code: '42501' } } : { data: value, error: null };
        }
        return { data: null, error: { code: 'PGRST202' } };
      } };
    },
    storage: { from: (bucket: string) => ({ download: async (path: string) => {
      calls.push(`download:${bucket}`);
      const bytes = world.objects.get(path);
      return bytes ? { data: new Blob([bytes as Uint8Array<ArrayBuffer>]), error: null } : { data: null, error: { statusCode: '404' } };
    } }) },
  };
}

// Replaces randomUUID and getRandomValues with a counter for the duration of `run` only.
export async function withEntropy<T>(run: () => Promise<T>): Promise<T> {
  let counter = 0;
  const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(PARITY_EXPORT);
  const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<A extends ArrayBufferView | null>(array: A): A => {
    const view = new Uint8Array((array as ArrayBufferView).buffer, (array as ArrayBufferView).byteOffset, (array as ArrayBufferView).byteLength);
    for (let index = 0; index < view.length; index++) view[index] = (counter++ * 37 + 11) & 0xff;
    return array;
  });
  try { return await run(); } finally { uuid.mockRestore(); random.mockRestore(); }
}

export type PartRecord = { index: number; bytes: number; sha256: string; salt: string; iv: string; aad: string; iterations: number; plainSha256: string; files: string[] };
export async function describePart(index: number, text: string): Promise<PartRecord> {
  const envelope = JSON.parse(text) as { salt: string; iv: string; aad: string; iterations: number };
  const part = await decryptPart(text, PARITY_PASSPHRASE);
  return { index, bytes: Buffer.byteLength(text), sha256: sha256(text), salt: envelope.salt, iv: envelope.iv, aad: envelope.aad,
    iterations: envelope.iterations, plainSha256: sha256(canonical(part)), files: part.files.map(file => `${file.imageId}:${file.variant}:${file.sha256}`) };
}
