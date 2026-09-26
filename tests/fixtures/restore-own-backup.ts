// Synthetic, fictional v2 backups for the restore-own integration gate: real decodable JPEG bytes, several photos per item,
// an outfit, a rule, feedback and history that keeps the text of an item that is permanently gone. Nothing here is personal.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptPart, metadataDigest, partFileName, planParts, savedColumns, sha256Hex, toBase64, type SavedMetadata, type SavedTable } from '../../src/domain/export-format';

export type SyntheticPhoto = { bytes: Uint8Array; width: number; height: number };
export type SyntheticItem = { title: string; photos: readonly SyntheticPhoto[]; category?: string; notes?: string;
  provenance?: Record<string, { kind: string; revision: number }> };
export type SyntheticBackup = { owner: string; exportId: string; items: readonly SyntheticItem[];
  /** Adds an outfit of the first two items, a rule and feedback for them, and history naming item 0 and a gone item. */
  extras?: boolean };

const stamp = '2026-09-20T10:00:00+00:00';
// Deterministic IDs within one backup, distinct between backups (the export ID seeds them).
export const syntheticId = (exportId: string, group: number, n: number) =>
  `${exportId.slice(0, 8)}-${group.toString(16).padStart(4, '0')}-4000-8000-${n.toString(16).padStart(12, '0')}`;

function row(owner: string, table: SavedTable, values: Record<string, unknown>) {
  const known: readonly string[] = savedColumns[table];
  if (Object.keys(values).some(column => !known.includes(column))) throw new Error('Unknown column.');
  return { ...Object.fromEntries(known.map(column => [column, null])), owner_id: owner, ...values };
}

export async function syntheticMetadata(backup: SyntheticBackup): Promise<SavedMetadata> {
  const { owner, exportId } = backup;
  const items: Record<string, unknown>[] = [], images: Record<string, unknown>[] = [];
  for (const [n, item] of backup.items.entries()) {
    const id = syntheticId(exportId, 1, n);
    items.push(row(owner, 'items', { id, title: item.title, category: item.category ?? 'top', colours: ['black'], seasons: [], style_tags: [], tags: [],
      notes: item.notes ?? '', currency: 'EUR', favourite: false, availability: 'ready', lifecycle: 'active', exclude_suggestions: false,
      wear_more: false, deleted_at: null, created_at: stamp, updated_at: stamp, version: item.photos.length, field_provenance: item.provenance ?? {} }));
    for (const [p, photo] of item.photos.entries()) {
      const image = syntheticId(exportId, 2, n * 16 + p);
      const hash = await sha256Hex(photo.bytes);
      const current = p === item.photos.length - 1;
      images.push(row(owner, 'item_images', { id: image, item_id: id, state: current ? 'ready' : 'retired',
        retired_at: current ? null : `2026-09-2${p}T10:00:00+00:00`, main_path: `${owner}/${id}/${image}/main.jpg`, thumb_path: `${owner}/${id}/${image}/thumb.jpg`,
        main_bytes: photo.bytes.length, thumb_bytes: photo.bytes.length, main_sha256: hash, thumb_sha256: hash, width: photo.width, height: photo.height,
        alt_text: `Photo ${p + 1} of ${item.title}`, created_at: stamp, description_version: 1 }));
    }
  }
  const first = syntheticId(exportId, 1, 0), second = syntheticId(exportId, 1, 1);
  const outfit = syntheticId(exportId, 3, 1), event = syntheticId(exportId, 4, 1);
  const extras = backup.extras ?? false;
  return {
    format: 'stillroom-saved', schema_version: 2, export_id: exportId, owner_id: owner, created_at: stamp,
    tables: {
      profiles: [row(owner, 'profiles', { display_name: 'Fictional', ui_language: 'fi', timezone: 'Europe/Helsinki', currency: 'EUR',
        created_at: stamp, updated_at: stamp, version: 1 })],
      style_preferences: [row(owner, 'style_preferences', { preferred_colours: ['red'], style_tags: [], excluded_categories: [], created_at: stamp, updated_at: stamp, version: 1 })],
      items, item_images: images, item_attributions: [],
      outfits: extras ? [row(owner, 'outfits', { id: outfit, title: 'Fictional outfit', occasion: 'everyday', notes: '', favourite: false, deleted_at: null,
        created_at: stamp, updated_at: stamp, version: 1 })] : [],
      outfit_items: extras ? [row(owner, 'outfit_items', { outfit_id: outfit, item_id: first, position: 0 }),
        row(owner, 'outfit_items', { outfit_id: outfit, item_id: second, position: 1 })] : [],
      wear_events: extras ? [row(owner, 'wear_events', { id: event, outfit_id: outfit, local_date: '2026-09-19', timezone: 'Europe/Helsinki', state: 'worn',
        label: 'Daily outfit', deleted_at: null, created_at: stamp, updated_at: stamp, version: 1 })] : [],
      wear_event_items: extras ? [
        row(owner, 'wear_event_items', { id: syntheticId(exportId, 5, 1), event_id: event, item_id: first, title_snapshot: backup.items[0]!.title, category_snapshot: 'top' }),
        // Permanently deleted before the backup: only its text remains.
        row(owner, 'wear_event_items', { id: syntheticId(exportId, 5, 2), event_id: event, item_id: null, title_snapshot: 'Fictional scarf, long gone', category_snapshot: 'accessory' }),
      ] : [],
      combination_rules: extras ? [row(owner, 'combination_rules', { id: syntheticId(exportId, 6, 1), item_low: first < second ? first : second,
        item_high: first < second ? second : first, created_at: stamp })] : [],
      suggestion_feedback: extras ? [row(owner, 'suggestion_feedback', { id: syntheticId(exportId, 7, 1), item_ids: [first, second].sort(), signature: 'fictional',
        vote: 1, created_at: stamp })] : [],
    },
  } as unknown as SavedMetadata;
}

/** Writes the backup's encrypted parts into `directory` and returns the part file names, in order. */
export async function writeSyntheticBackup(directory: string, backup: SyntheticBackup, passphrase: string): Promise<string[]> {
  const meta = await syntheticMetadata(backup);
  const bytes = new Map<string, Uint8Array>();
  for (const [n, item] of backup.items.entries()) for (const [p, photo] of item.photos.entries()) bytes.set(syntheticId(backup.exportId, 2, n * 16 + p), photo.bytes);
  const plan = planParts(meta);
  const base = { format: 'stillroom-export', schemaVersion: 2, exportId: backup.exportId, partCount: plan.length + 1, manifestSha256: await metadataDigest(meta) } as const;
  const parts = [{ ...base, partIndex: 0, manifest: meta, files: [] },
    ...plan.map((refs, index) => ({ ...base, partIndex: index + 1, files: refs.map(ref => ({ imageId: ref.imageId, variant: ref.variant,
      sha256: ref.sha256, byteLength: ref.byteLength, mime: 'image/jpeg' as const, base64: toBase64(bytes.get(ref.imageId)!) })) }))];
  const names: string[] = [];
  for (const part of parts) {
    const name = partFileName(backup.exportId, part.partIndex);
    await writeFile(join(directory, name), JSON.stringify(await encryptPart(part as never, passphrase)));
    names.push(name);
  }
  return names;
}
