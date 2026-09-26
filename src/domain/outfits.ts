import type { MessageKey } from '../i18n';
import { isCategory, isRecord, isUuid, type Category } from './wardrobe';
import { colours } from './preferences';
import { lifecycle as lifecycleValues } from './garment-fields';

export const occasions = ['home', 'everyday', 'smart', 'business', 'formal'] as const;
export type Occasion = (typeof occasions)[number];
export const occasionKeys: Record<Occasion, MessageKey> = {
  home: 'occasion.home', everyday: 'occasion.everyday', smart: 'occasion.smart', business: 'occasion.business', formal: 'occasion.formal',
};
export const outfitLimits = { title: 100, notes: 2000, occasion: 60, items: 12 } as const;
export const outfitColumns = 'id,owner_id,title,occasion,notes,favourite,deleted_at,version,created_at,outfit_items!outfit_items_owner_id_outfit_id_fkey(owner_id,item_id,position)';
export const componentColumns = 'id,owner_id,title,category,colours,deleted_at,lifecycle';
export const componentImageColumns = 'id,owner_id,item_id,state,main_path,thumb_path,alt_text';

export type OutfitLink = { itemId: string; position: number };
export type OutfitRecord = {
  id: string; ownerId: string; title: string; occasion: string; notes: string; favourite: boolean;
  deletedAt: string | null; version: number; createdAt: string; links: OutfitLink[];
};
export type ComponentState = 'current' | 'archived' | 'trashed' | 'missing';
export type OutfitComponent = {
  id: string; state: ComponentState; title: string | null; category: Category | null; colour: string | null;
  lifecycle: (typeof lifecycleValues)[number] | null; thumbPath: string | null; altText: string;
};
export type OutfitDraft = { title: string; occasion: string; notes: string; favourite: boolean; itemIds: string[] };
export type OutfitPayload = { title: string; occasion: string; notes: string; favourite: boolean; itemIds: string[] };
export type SaveAttempt = {
  kind: 'create' | 'edit'; id: string; payload: OutfitPayload; baselineVersion: number | null; ownerId: string; epoch: number;
};
export type SaveOutcome = 'saved' | 'notSaved' | 'changed' | 'gone';
export type DraftErrors = { title?: MessageKey; notes?: MessageKey; items?: MessageKey };

const length = (value: string) => [...value].length;
const plainText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && !value.includes('\0') && length(value) <= maximum;

export function isOccasion(value: unknown): value is Occasion {
  return typeof value === 'string' && occasions.some(code => code === value);
}
export function occasionLabel(record: Pick<OutfitRecord, 'occasion'>): MessageKey | null {
  return isOccasion(record.occasion) ? occasionKeys[record.occasion] : null;
}
export function outfitRouteId(value: string): string | null {
  return isUuid(value) && value === value.toLowerCase() ? value : null;
}
export type NavFamily = 'today' | 'wardrobe' | 'outfits' | 'calendar' | 'statistics' | null;
export function isOutfitRoute(route: string): boolean {
  return route === 'outfits' || route === 'outfit-new' || route.startsWith('outfit:');
}
export function navFamilyFor(route: string): NavFamily {
  if (route === 'today') return 'today';
  if (route === 'calendar') return 'calendar';
  if (route === 'statistics') return 'statistics';
  return isOutfitRoute(route) ? 'outfits' : route === 'wardrobe' || route === 'add' || route.startsWith('detail:') ? 'wardrobe' : null;
}
// Outfit editors never use the shared discard dialog: there is nothing to cancel or refund.
export function leaveDialogFor(route: string): 'outfit' | 'discard' {
  return isOutfitRoute(route) ? 'outfit' : 'discard';
}
export function emptyDraft(): OutfitDraft {
  return { title: '', occasion: 'everyday', notes: '', favourite: false, itemIds: [] };
}
export function draftFromRecord(record: OutfitRecord): OutfitDraft {
  return { title: record.title, occasion: record.occasion, notes: record.notes, favourite: record.favourite, itemIds: record.links.map(link => link.itemId) };
}
export function sameDraft(left: OutfitDraft, right: OutfitDraft): boolean {
  return left.title === right.title && left.occasion === right.occasion && left.notes === right.notes && left.favourite === right.favourite
    && left.itemIds.length === right.itemIds.length && left.itemIds.every((id, index) => id === right.itemIds[index]);
}

export function parseOutfitRow(row: unknown, ownerId: string): OutfitRecord {
  if (!isRecord(row) || row.owner_id !== ownerId || !isUuid(row.id) || row.id !== row.id.toLowerCase()
    || !plainText(row.title, outfitLimits.title) || !row.title.length || !plainText(row.occasion, outfitLimits.occasion)
    || !plainText(row.notes, outfitLimits.notes) || typeof row.favourite !== 'boolean'
    || !(row.deleted_at === null || typeof row.deleted_at === 'string') || typeof row.created_at !== 'string'
    || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1
    || !Array.isArray(row.outfit_items) || row.outfit_items.length > outfitLimits.items) throw new Error('Invalid outfit.');
  const items = new Set<string>(), positions = new Set<number>();
  const links = (row.outfit_items as unknown[]).map((link): OutfitLink => {
    if (!isRecord(link) || link.owner_id !== ownerId || !isUuid(link.item_id) || link.item_id !== link.item_id.toLowerCase()
      || typeof link.position !== 'number' || !Number.isInteger(link.position) || link.position < 0 || link.position >= outfitLimits.items
      || items.has(link.item_id) || positions.has(link.position)) throw new Error('Invalid outfit.');
    items.add(link.item_id); positions.add(link.position);
    return { itemId: link.item_id, position: link.position };
  }).sort((a, b) => a.position - b.position);
  return {
    id: row.id, ownerId, title: row.title, occasion: row.occasion, notes: row.notes, favourite: row.favourite,
    deletedAt: row.deleted_at, version: row.version, createdAt: row.created_at, links,
  };
}

export function parseComponents(ids: readonly string[], items: unknown, images: unknown, ownerId: string): Map<string, OutfitComponent> {
  if (!Array.isArray(items) || !Array.isArray(images)) throw new Error('Invalid components.');
  const wanted = new Set(ids);
  const photos = new Map<string, { thumbPath: string; altText: string }>();
  for (const image of images as unknown[]) {
    if (!isRecord(image) || image.owner_id !== ownerId || !isUuid(image.id) || !isUuid(image.item_id) || !wanted.has(image.item_id)
      || image.state !== 'ready' || !plainText(image.alt_text, 240) || photos.has(image.item_id)
      || image.main_path !== `${ownerId}/${image.item_id}/${image.id}/main.jpg`
      || image.thumb_path !== `${ownerId}/${image.item_id}/${image.id}/thumb.jpg`) throw new Error('Invalid components.');
    photos.set(image.item_id, { thumbPath: image.thumb_path, altText: image.alt_text });
  }
  const result = new Map<string, OutfitComponent>();
  for (const item of items as unknown[]) {
    if (!isRecord(item) || item.owner_id !== ownerId || !isUuid(item.id) || !wanted.has(item.id) || result.has(item.id)
      || !plainText(item.title, 100) || !item.title.length || !isCategory(item.category)
      || !Array.isArray(item.colours) || !item.colours.every((code: unknown) => typeof code === 'string')
      || !(item.deleted_at === null || typeof item.deleted_at === 'string')) throw new Error('Invalid components.');
    const state = lifecycleValues.find(value => value === item.lifecycle);
    if (!state) throw new Error('Invalid components.');
    const photo = photos.get(item.id);
    result.set(item.id, {
      id: item.id, state: item.deleted_at !== null ? 'trashed' : state === 'active' ? 'current' : 'archived',
      title: item.title, category: item.category, colour: typeof item.colours[0] === 'string' ? item.colours[0] : null,
      lifecycle: state, thumbPath: photo?.thumbPath ?? null, altText: photo?.altText ?? '',
    });
  }
  for (const id of ids) if (!result.has(id)) result.set(id, missingComponent(id));
  return result;
}
export function missingComponent(id: string): OutfitComponent {
  return { id, state: 'missing', title: null, category: null, colour: null, lifecycle: null, thumbPath: null, altText: '' };
}

export function hasGap(record: OutfitRecord): boolean {
  return record.links.some((link, index) => link.position !== index);
}
export function isEmpty(record: OutfitRecord): boolean {
  return record.links.length === 0;
}
export function componentLabel(component: OutfitComponent): MessageKey | null {
  if (component.state === 'trashed') return 'outfits.inTrash';
  if (component.state === 'missing') return 'outfits.unavailableItem';
  if (component.state === 'archived') return component.lifecycle === 'donated' ? 'lifecycle.donated' : component.lifecycle === 'sold' ? 'lifecycle.sold' : 'detail.archived';
  return null;
}
const singular: Record<Category, MessageKey> = {
  top: 'categoryOne.top', bottom: 'categoryOne.bottom', one_piece: 'categoryOne.one_piece', footwear: 'categoryOne.footwear',
  layer: 'categoryOne.layer', outerwear: 'categoryOne.outerwear', accessory: 'categoryOne.accessory',
};
const colourKeys: Record<(typeof colours)[number], MessageKey> = {
  black: 'colour.black', white: 'colour.white', cream: 'colour.cream', grey: 'colour.grey', navy: 'colour.navy', blue: 'colour.blue',
  light_blue: 'colour.light_blue', teal: 'colour.teal', green: 'colour.green', olive: 'colour.olive', khaki: 'colour.khaki',
  beige: 'colour.beige', brown: 'colour.brown', burgundy: 'colour.burgundy', red: 'colour.red', yellow: 'colour.yellow',
  orange: 'colour.orange', pink: 'colour.pink', purple: 'colour.purple', gold: 'colour.gold', silver: 'colour.silver',
};
export function componentMeta(category: Category, colour: string | null): { category: MessageKey; colour: MessageKey | null } {
  const known = colours.find(code => code === colour);
  return { category: singular[category], colour: known ? colourKeys[known] : null };
}

export function validateDraft(draft: OutfitDraft, components: ReadonlyMap<string, OutfitComponent>): { payload: OutfitPayload } | { errors: DraftErrors } {
  const errors: DraftErrors = {};
  const title = draft.title.trim(), notes = draft.notes.trim();
  if (!title) errors.title = 'outfits.nameRequired';
  else if (length(title) > outfitLimits.title || title.includes('\0')) errors.title = 'outfits.nameTooLong';
  if (length(notes) > outfitLimits.notes || notes.includes('\0')) errors.notes = 'outfits.notesTooLong';
  const ids = draft.itemIds;
  if (!ids.length) errors.items = 'outfits.chooseAtLeastOne';
  else if (ids.length > outfitLimits.items) errors.items = 'outfits.limit';
  else if (new Set(ids).size !== ids.length || ids.some(id => !isUuid(id) || id !== id.toLowerCase())) errors.items = 'outfits.invalidSelection';
  else if (ids.some(id => components.get(id)?.state === 'missing' || !components.has(id))) errors.items = 'outfits.removeUnavailable';
  const occasion = draft.occasion;
  if (!plainText(occasion, outfitLimits.occasion)) errors.items ??= 'outfits.invalidSelection';
  if (errors.title || errors.notes || errors.items) return { errors };
  return { payload: { title, occasion, notes, favourite: draft.favourite, itemIds: [...ids] } };
}

export function toggle(ids: readonly string[], id: string): { ids: string[]; limited: boolean } {
  if (ids.includes(id)) return { ids: ids.filter(value => value !== id), limited: false };
  if (ids.length >= outfitLimits.items) return { ids: [...ids], limited: true };
  return { ids: [...ids, id], limited: false };
}
export function moveUp(ids: readonly string[], index: number): string[] {
  if (index <= 0 || index >= ids.length) return [...ids];
  const next = [...ids];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  return next;
}
export function moveDown(ids: readonly string[], index: number): string[] {
  if (index < 0 || index >= ids.length - 1) return [...ids];
  const next = [...ids];
  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
  return next;
}
export function remove(ids: readonly string[], id: string): string[] {
  return ids.filter(value => value !== id);
}

export function saveArguments(attempt: SaveAttempt) {
  const base = {
    p_id: attempt.id, p_title: attempt.payload.title, p_occasion: attempt.payload.occasion,
    p_notes: attempt.payload.notes, p_favourite: attempt.payload.favourite, p_item_ids: [...attempt.payload.itemIds],
  };
  return attempt.kind === 'create' ? base : { ...base, p_expected_version: attempt.baselineVersion ?? 0 };
}
export function expectedVersion(attempt: SaveAttempt): number {
  return attempt.kind === 'create' ? 1 : (attempt.baselineVersion ?? 0) + 1;
}
export function matchesPayload(record: OutfitRecord, payload: OutfitPayload): boolean {
  return record.title === payload.title && record.occasion === payload.occasion && record.notes === payload.notes
    && record.favourite === payload.favourite && record.links.length === payload.itemIds.length
    && record.links.every((link, index) => link.position === index && link.itemId === payload.itemIds[index]);
}
// A read-only reread decides what an unknown save did; it never implies a resend.
export function compareSaved(attempt: SaveAttempt, reread: OutfitRecord | null): SaveOutcome {
  if (attempt.kind === 'create') {
    if (reread === null) return 'notSaved';
    if (reread.deletedAt !== null) return 'gone';
    return reread.version === 1 && matchesPayload(reread, attempt.payload) ? 'saved' : 'changed';
  }
  if (reread === null || reread.deletedAt !== null) return 'gone';
  if (reread.version === attempt.baselineVersion) return 'notSaved';
  return reread.version === expectedVersion(attempt) && matchesPayload(reread, attempt.payload) ? 'saved' : 'changed';
}

export type SaveResult = 'invalidSelection' | 'changed' | 'rejected' | 'unknown';
// Only these database rejections are definitive; everything else, and any 5xx reply whatever its code, may have committed.
export function classifySaveError(error: unknown, status?: number): SaveResult {
  if (typeof status === 'number' && status >= 500) return 'unknown';
  if (!isRecord(error)) return 'unknown';
  const code = String(error.code ?? ''), message = error.message;
  if (code === 'P0001' && message === 'Invalid selection') return 'invalidSelection';
  if (code === 'P0001' && message === 'Request conflict' || code === '23505') return 'changed';
  if (['42501', '23514', '23502', '23503', 'PGRST301', 'PGRST302'].includes(code)) return 'rejected';
  return 'unknown';
}
export function confirmsVersion(attempt: SaveAttempt, value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value === expectedVersion(attempt);
}
