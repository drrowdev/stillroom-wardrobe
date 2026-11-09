// OUTFITGEN-QUALITY1 selection (pure, import-free, shared by the outfit-generate Edge function and the tests). The judge returns a
// score for the base look (top or one-piece, bottoms, shoes: what is left indoors) and one for the whole outfit. A suggestion is
// kept only when the weaker of the two reaches the bar and when it does not repeat what the owner already has: at most a few per
// call, one look per top+bottom base per call, at most `perBase` looks per base overall (waiting, kept and removed together) and at
// most `perGarment` waiting suggestions per garment. A good verdict that a cap blocks is recorded as judged, never silently dropped. These constants are
// Edge settings, not part of the provider manifest, so tuning them needs no new manifest version.

export type SelectionCategory = 'top' | 'bottom' | 'one_piece' | 'layer' | 'outerwear' | 'footwear';
export type SelectionVerdict = { decision: 'good' | 'skip'; baseScore: number; fullScore: number };
/** Item-id sets the owner already has: waiting suggestions, kept suggestions and removed or disliked sets. */
export type SelectionSeen = { pending: readonly (readonly string[])[]; kept: readonly (readonly string[])[]; removed: readonly (readonly string[])[] };

export const SELECTION_LIMITS = Object.freeze({ perCallMax: 4, perBase: 2, perBaseCall: 1, perGarment: 6 });

/** The stored score: the look is only as good as its weaker version, so a base that only works under a jacket stays low. */
export const verdictScore = (verdict: Pick<SelectionVerdict, 'baseScore' | 'fullScore'>): number => Math.min(verdict.baseScore, verdict.fullScore);
export const perCallLimit = (candidates: number): number => Math.min(SELECTION_LIMITS.perCallMax, Math.ceil(candidates / 4));

const baseCategories: readonly SelectionCategory[] = ['top', 'bottom', 'one_piece'];
/** Sorted ids of the top and bottoms (or the one-piece); null when any garment is unknown, so a partial set never matches. */
export function baseKeyOf(ids: readonly string[], categoryOf: (id: string) => SelectionCategory | undefined): string | null {
  const base: string[] = [];
  for (const id of ids) {
    const category = categoryOf(id);
    if (category === undefined) return null;
    if (baseCategories.includes(category)) base.push(id);
  }
  return base.length ? [...new Set(base)].sort().join('|') : null;
}

export type SelectionInput = {
  sets: readonly (readonly string[])[]; verdicts: readonly SelectionVerdict[]; bar: number; seen: SelectionSeen;
  categoryOf: (id: string) => SelectionCategory | undefined;
};

/** Which candidates become suggestions. Index-aligned with `sets` and `verdicts`. */
export function selectSuggestions(input: SelectionInput): boolean[] {
  const { sets, verdicts, bar, seen, categoryOf } = input;
  const baseUses = new Map<string, number>(), garmentUses = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const countBase = (ids: readonly string[]) => { const key = baseKeyOf(ids, categoryOf); if (key !== null) bump(baseUses, key); };
  const countGarments = (ids: readonly string[]) => {
    if (ids.some((id) => categoryOf(id) === undefined)) return;
    for (const id of ids) if (categoryOf(id) !== 'footwear') bump(garmentUses, id);
  };
  for (const ids of seen.pending) { countBase(ids); countGarments(ids); }
  for (const ids of seen.kept) countBase(ids);
  for (const ids of seen.removed) countBase(ids);

  const chosen = sets.map(() => false);
  const eligible = verdicts.map((_, index) => index)
    .filter((index) => verdicts[index]!.decision === 'good' && verdictScore(verdicts[index]!) >= bar)
    .sort((a, b) => verdictScore(verdicts[b]!) - verdictScore(verdicts[a]!) || verdicts[b]!.baseScore - verdicts[a]!.baseScore || a - b);
  const room = perCallLimit(sets.length);
  let taken = 0;
  const callBases = new Map<string, number>();
  for (const index of eligible) {
    if (taken >= room) break;
    const ids = sets[index]!;
    const key = baseKeyOf(ids, categoryOf);
    if (key !== null && ((baseUses.get(key) ?? 0) >= SELECTION_LIMITS.perBase || (callBases.get(key) ?? 0) >= SELECTION_LIMITS.perBaseCall)) continue;
    if (ids.some((id) => categoryOf(id) !== 'footwear' && (garmentUses.get(id) ?? 0) >= SELECTION_LIMITS.perGarment)) continue;
    chosen[index] = true;
    taken++;
    if (key !== null) bump(callBases, key);
    countBase(ids);
    countGarments(ids);
  }
  return chosen;
}
