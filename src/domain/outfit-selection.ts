// OUTFITGEN-QUALITY1 selection (pure, import-free, shared by the outfit-generate Edge function and the tests). The judge returns a
// score for the base look (top or one-piece, bottoms, shoes: what is left indoors) and one for the whole outfit. A suggestion is
// kept only when the weaker of the two reaches the bar and when it does not repeat what the owner already has: at most a few per
// call (and never more than the room left on the waiting list), one look per top+bottom base per call, at most `perBase` looks per
// base overall and at most `perGarment` suggestions per garment, where only the owner's waiting and kept suggestions count. Removed
// sets count for nothing here: a removal is an exact-set ban that the candidate lists already honour, and it must not make every
// other variant of that top and bottoms unwelcome. A good verdict that a cap or the room blocks is recorded as judged, never silently
// dropped. These constants are Edge settings, not part of the provider manifest, so tuning them needs no new manifest version.

export type SelectionCategory = 'top' | 'bottom' | 'one_piece' | 'layer' | 'outerwear' | 'footwear';
export type SelectionVerdict = { decision: 'good' | 'skip'; baseScore: number; fullScore: number };
/**
 * One suggestion the owner already has, reduced by the database before any candidate-pool truncation: the ids of its top, bottoms or
 * one-piece (the base) and the ids of every garment except its shoes.
 */
export type SeenLook = { base: readonly string[]; garments: readonly string[] };
export type SelectionSeen = { pending: readonly SeenLook[]; kept: readonly SeenLook[] };

export const SELECTION_LIMITS = Object.freeze({ perCallMax: 4, perBase: 2, perBaseCall: 1, perGarment: 6 });

/** The stored score: the look is only as good as its weaker version, so a base that only works under a jacket stays low. */
export const verdictScore = (verdict: Pick<SelectionVerdict, 'baseScore' | 'fullScore'>): number => Math.min(verdict.baseScore, verdict.fullScore);
export const perCallLimit = (candidates: number): number => Math.min(SELECTION_LIMITS.perCallMax, Math.ceil(candidates / 4));

const baseCategories: readonly SelectionCategory[] = ['top', 'bottom', 'one_piece'];
export const baseKey = (ids: readonly string[]): string | null => (ids.length ? [...new Set(ids)].sort().join('|') : null);
/** Sorted ids of the top and bottoms (or the one-piece) of a candidate set; null when any garment is unknown. */
export function baseKeyOf(ids: readonly string[], categoryOf: (id: string) => SelectionCategory | undefined): string | null {
  const base: string[] = [];
  for (const id of ids) {
    const category = categoryOf(id);
    if (category === undefined) return null;
    if (baseCategories.includes(category)) base.push(id);
  }
  return baseKey(base);
}

/** Every candidate index in ranking order: score (weaker of the two) first, then base score, then the order the call listed them. */
export function rankCandidates(verdicts: readonly Pick<SelectionVerdict, 'baseScore' | 'fullScore'>[]): number[] {
  return verdicts.map((_, index) => index)
    .sort((a, b) => verdictScore(verdicts[b]!) - verdictScore(verdicts[a]!) || verdicts[b]!.baseScore - verdicts[a]!.baseScore || a - b);
}

export type SelectionInput = {
  sets: readonly (readonly string[])[]; verdicts: readonly SelectionVerdict[]; bar: number; seen: SelectionSeen;
  /** Places left on the waiting list (the plan's `pendingRoom`). */
  room: number;
  categoryOf: (id: string) => SelectionCategory | undefined;
};

/** Which candidates become suggestions (index-aligned with `sets`), and every candidate in ranking order. */
export function selectSuggestions(input: SelectionInput): { chosen: boolean[]; order: number[] } {
  const { sets, verdicts, bar, seen, categoryOf } = input;
  const baseUses = new Map<string, number>(), garmentUses = new Map<string, number>(), callBases = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const look of [...seen.pending, ...seen.kept]) {
    const key = baseKey(look.base);
    if (key !== null) bump(baseUses, key);
    for (const garment of new Set(look.garments)) bump(garmentUses, garment);
  }
  const order = rankCandidates(verdicts);
  const chosen = sets.map(() => false);
  const limit = Math.min(perCallLimit(sets.length), Math.max(0, Math.floor(input.room)));
  let taken = 0;
  for (const index of order) {
    if (taken >= limit) break;
    const verdict = verdicts[index]!;
    if (verdict.decision !== 'good' || verdictScore(verdict) < bar) continue;
    const ids = sets[index]!;
    // A candidate with an unknown garment cannot be placed in a base or counted, so it is never kept.
    if (ids.some((id) => categoryOf(id) === undefined)) continue;
    const key = baseKeyOf(ids, categoryOf);
    if (key !== null && ((baseUses.get(key) ?? 0) >= SELECTION_LIMITS.perBase || (callBases.get(key) ?? 0) >= SELECTION_LIMITS.perBaseCall)) continue;
    if (ids.some((id) => categoryOf(id) !== 'footwear' && (garmentUses.get(id) ?? 0) >= SELECTION_LIMITS.perGarment)) continue;
    chosen[index] = true;
    taken++;
    if (key !== null) { bump(callBases, key); bump(baseUses, key); }
    for (const id of ids) if (categoryOf(id) !== 'footwear') bump(garmentUses, id);
  }
  return { chosen, order };
}
