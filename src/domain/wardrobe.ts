import type { MessageKey } from '../i18n';

export const categories = ['top', 'bottom', 'one_piece', 'footwear', 'layer', 'outerwear', 'accessory'] as const;
export type Category = (typeof categories)[number];
export const categoryKeys: Record<Category, MessageKey> = {
  top: 'category.top', bottom: 'category.bottom', one_piece: 'category.one_piece',
  footwear: 'category.footwear', layer: 'category.layer', outerwear: 'category.outerwear', accessory: 'category.accessory',
};
export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && categories.some((category) => category === value);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export type WardrobeItem = {
  id: string;
  ownerId: string;
  title: string;
  category: Category;
  createdAt: string;
  imageId: string;
  mainPath: string;
  thumbPath: string;
  altText: string;
};

export type DraftDetails = { title: string; category: Category; altText: string };
export function validateDetails(title: string, category: string, altText: string): DraftDetails | null {
  const name = title.trim();
  const description = altText.trim();
  if (!name || [...name].length > 100 || !isCategory(category) || [...description].length > 240 || name.includes('\0') || description.includes('\0')) return null;
  return { title: name, category, altText: description };
}
