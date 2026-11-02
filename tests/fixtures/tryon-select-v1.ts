// The three-step garment selection of manifest v1 (src/domain/tryon.ts before TRYON-LIMITS1), frozen for the historical
// integration stages that run at the 20261011090000 inventory, where the SQL copy still selects at most top, bottom and shoes.
// Import-free so plain Node can load it. Never edit: the current selection is src/domain/tryon.ts selectTryOnSteps.
type Candidate = { itemId: string; category: string; lifecycle: string; deleted: boolean; readyImage: boolean };

const eligible = (item: Candidate) => item.lifecycle === 'active' && !item.deleted && item.readyImage;
const first = (items: readonly Candidate[], category: string) => items.find((item) => item.category === category && eligible(item));

export function selectTryOnStepsV1(items: readonly Candidate[]): { slot: string; itemId: string }[] {
  const onePiece = first(items, 'one_piece');
  const picked = onePiece
    ? [onePiece, first(items, 'footwear')]
    : [first(items, 'top'), first(items, 'bottom'), first(items, 'footwear')];
  return picked.filter((item): item is Candidate => item !== undefined)
    .map((item) => ({ slot: item.category, itemId: item.itemId })).slice(0, 3);
}
