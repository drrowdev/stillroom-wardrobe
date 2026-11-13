// Imports nothing, so the analysis Edge function can use it as it is.
// The closed garment types per category (CAPS1a). A garment has one type or none. Some codes belong to two categories
// (a vest or an overshirt is a layer or outerwear). The same table is written into the database check and the analysis schema.
export const garmentTypesByCategory = {
  top: ['t_shirt', 'shirt', 'polo', 'knit', 'sweatshirt', 'tank'],
  bottom: ['jeans', 'chinos', 'trousers', 'shorts', 'skirt'],
  one_piece: ['dress', 'jumpsuit'],
  footwear: ['sneakers', 'boots', 'shoes', 'sandals'],
  layer: ['blazer', 'cardigan', 'hoodie', 'sweatshirt', 'knit', 'vest', 'overshirt'],
  outerwear: ['coat', 'jacket', 'parka', 'bomber', 'puffer', 'shell', 'vest', 'overshirt'],
  accessory: ['hat', 'scarf', 'belt', 'bag'],
} as const;
export const garmentTypes = [
  't_shirt', 'shirt', 'polo', 'knit', 'sweatshirt', 'tank', 'jeans', 'chinos', 'trousers', 'shorts', 'skirt', 'dress', 'jumpsuit',
  'sneakers', 'boots', 'shoes', 'sandals', 'blazer', 'cardigan', 'hoodie', 'vest', 'overshirt',
  'coat', 'jacket', 'parka', 'bomber', 'puffer', 'shell', 'hat', 'scarf', 'belt', 'bag',
] as const;
export type GarmentType = typeof garmentTypes[number];

export function isGarmentType(value: unknown): value is GarmentType {
  return typeof value === 'string' && garmentTypes.some((code) => code === value);
}
export function garmentTypesFor(category: unknown): readonly GarmentType[] {
  return typeof category === 'string' && Object.hasOwn(garmentTypesByCategory, category)
    ? garmentTypesByCategory[category as keyof typeof garmentTypesByCategory] : [];
}
export function isGarmentTypeFor(category: unknown, type: unknown): type is GarmentType {
  return garmentTypesFor(category).some((code) => code === type);
}
