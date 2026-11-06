// OUTFITGEN1 candidate sets (B3). Pure and import-free so the outfit-generate Edge function and the tests share it. It bounds
// what the model is asked to judge and never ranks taste into a ban: the only hard filters are validity (a complete outfit
// of distinct eligible garments) and the owner's explicit bans (avoided pairs, disliked sets). Everything else only orders
// and diversifies. Each garment is an "anchor": its candidate list is a finite, deterministic, diverse selection of at most
// `perAnchor` sets that contain it, computed without looking at what was already judged, so assessing an item always ends.

export type CandidateCategory = 'top' | 'bottom' | 'one_piece' | 'layer' | 'outerwear' | 'footwear';
export type CandidateItem = {
  id: string; category: CandidateCategory; colours: readonly string[]; pattern: string | null; seasons: readonly string[];
  formality: number | null; favourite: boolean;
};
export type CandidateBans = { pairs: ReadonlySet<string>; disliked: ReadonlySet<string> };
export type CandidateSet = { ids: string[]; key: string; anchor: string; score: number; addOn: boolean };
export type SignedSet = CandidateSet & { signature: string };

export const CANDIDATE_LIMITS = Object.freeze({
  perAnchor: 8, exploration: 3, partnerReuse: 2, explorationReuse: 3, poolCore: 24, poolAddOnAnchor: 8, addOnsPerKind: 2, maxAnchors: 12,
  maxGarments: 8, maxSets: 24, imageBytes: 3_145_728, plannedTokens: 40_000, textTokens: 8_000, imageTokens: 3_300,
});

const displayOrder: readonly CandidateCategory[] = ['top', 'bottom', 'one_piece', 'layer', 'outerwear', 'footwear'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const setKey = (ids: readonly string[]): string => [...new Set(ids)].sort(compare).join('|');
export const pairKeyOf = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`;
// Same formula as combinationSignature() and private.outfitgen_signature(): SHA-256 of the sorted ids joined by '|'.
export async function signatureOf(ids: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(setKey(ids)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function hashOf(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

// A copy of src/domain/colour-pairs.ts, pinned equal in tests/unit/outfit-candidates.test.ts (the Edge function imports no app modules).
const KNOWN_COLOURS = new Set(['black', 'white', 'cream', 'grey', 'navy', 'blue', 'light_blue', 'teal', 'green', 'olive', 'khaki', 'beige', 'brown',
  'burgundy', 'red', 'yellow', 'orange', 'pink', 'purple', 'gold', 'silver']);
const NEUTRAL = new Set(['black', 'white', 'cream', 'grey', 'navy', 'beige', 'khaki', 'brown']);
const ADJACENT = new Set(([['blue', 'light_blue'], ['blue', 'teal'], ['light_blue', 'teal'], ['teal', 'green'], ['green', 'olive'],
  ['red', 'burgundy'], ['burgundy', 'purple'], ['red', 'orange'], ['orange', 'yellow'], ['pink', 'purple'], ['gold', 'yellow']] as const)
  .flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
export function colourPairScore(a: string, b: string): number {
  if (!KNOWN_COLOURS.has(a) || !KNOWN_COLOURS.has(b)) return 0.5;
  if (NEUTRAL.has(a) || NEUTRAL.has(b)) return 1;
  if (a === b) return 0.8;
  return ADJACENT.has(`${a}|${b}`) ? 0.85 : 0.6;
}

const isCore = (item: CandidateItem) => item.category !== 'layer' && item.category !== 'outerwear';
const loud = (item: CandidateItem) => item.pattern !== null && item.pattern !== 'solid';
/** Ordering score only (0..~1.1): colour pairing, formality agreement, season overlap, pattern clash, favourites. Never a filter. */
export function softScore(items: readonly CandidateItem[]): number {
  const pairs: number[] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    pairs.push(colourPairScore(items[i]!.colours[0] ?? 'unknown', items[j]!.colours[0] ?? 'unknown'));
  }
  const colour = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : 0.5;
  const known = items.filter((item) => isCore(item) && item.formality !== null).map((item) => item.formality!);
  const formality = known.length >= 2 ? Math.max(0, 1 - (Math.max(...known) - Math.min(...known)) / 3) : 0.7;
  const season = Math.max(...['spring', 'summer', 'autumn', 'winter'].map((s) => items.filter((item) => item.seasons.includes(s)).length)) / items.length;
  const patterns = items.filter(loud).length;
  const pattern = patterns >= 3 ? 0.4 : patterns === 2 ? 0.7 : 1;
  const favourite = items.filter((item) => item.favourite).length / items.length;
  return 0.4 * colour + 0.25 * formality + 0.2 * season + 0.15 * pattern + 0.1 * favourite;
}

const fit = (a: CandidateItem, b: CandidateItem) => colourPairScore(a.colours[0] ?? 'unknown', b.colours[0] ?? 'unknown')
  + (a.formality !== null && b.formality !== null ? 1 - Math.abs(a.formality - b.formality) / 4 : 0.5) + (b.favourite ? 0.1 : 0);
/** Best-fitting items first, then a deterministic hashed sample of the rest, so unusual pairings are tried too. */
function pickPool(list: readonly CandidateItem[], anchor: CandidateItem, size: number): CandidateItem[] {
  if (list.length <= size) return [...list].sort((a, b) => compare(a.id, b.id));
  const byFit = [...list].sort((a, b) => fit(anchor, b) - fit(anchor, a) || compare(a.id, b.id));
  const head = Math.ceil(size * 0.6), chosen = byFit.slice(0, head);
  const rest = byFit.slice(head).sort((a, b) => hashOf(anchor.id + a.id) - hashOf(anchor.id + b.id) || compare(a.id, b.id));
  return [...chosen, ...rest.slice(0, size - head)];
}

const banned = (items: readonly CandidateItem[], bans: CandidateBans) => {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (bans.pairs.has(pairKeyOf(items[i]!.id, items[j]!.id))) return true;
  }
  return bans.disliked.has(setKey(items.map((item) => item.id)));
};
const ordered = (items: readonly CandidateItem[]) => [...items].sort((a, b) => displayOrder.indexOf(a.category) - displayOrder.indexOf(b.category) || compare(a.id, b.id));

/**
 * The finite candidate list of one anchor: at most `perAnchor` valid, unbanned sets that contain it. Selection is greedy by
 * score with a per-partner reuse cap, guarantees a bare outfit and (when any layer or outerwear exists) one with an add-on,
 * and reserves `exploration` slots for a deterministic hashed sample so mid-ranked pairings get judged as well.
 */
export function anchorSets(anchor: CandidateItem, items: readonly CandidateItem[], bans: CandidateBans): CandidateSet[] {
  const by = (category: CandidateCategory) => items.filter((item) => item.category === category && item.id !== anchor.id);
  const addOnAnchor = anchor.category === 'layer' || anchor.category === 'outerwear';
  const size = addOnAnchor ? CANDIDATE_LIMITS.poolAddOnAnchor : CANDIDATE_LIMITS.poolCore;
  const pool = (category: CandidateCategory) => pickPool(by(category), anchor, size);
  const cores: CandidateItem[][] = [];
  const tops = anchor.category === 'top' ? [anchor] : pool('top'), bottoms = anchor.category === 'bottom' ? [anchor] : pool('bottom');
  const shoes = anchor.category === 'footwear' ? [anchor] : pool('footwear'), dresses = anchor.category === 'one_piece' ? [anchor] : pool('one_piece');
  if (anchor.category !== 'one_piece') for (const t of tops) for (const b of bottoms) for (const f of shoes) cores.push([t, b, f]);
  if (anchor.category !== 'top' && anchor.category !== 'bottom') for (const d of dresses) for (const f of shoes) cores.push([d, f]);
  const layers = items.filter((item) => item.category === 'layer'), outer = items.filter((item) => item.category === 'outerwear');
  const sets = new Map<string, CandidateSet>();
  const add = (members: CandidateItem[], addOn: boolean) => {
    if (!members.some((item) => item.id === anchor.id) || banned(members, bans)) return;
    const key = setKey(members.map((item) => item.id));
    if (!sets.has(key)) sets.set(key, { ids: ordered(members).map((item) => item.id), key, anchor: anchor.id, score: softScore(members), addOn });
  };
  for (const core of cores) {
    if (core.some((item, index) => core.findIndex((other) => other.id === item.id) !== index)) continue;
    if (!addOnAnchor) add(core, false);
    const kinds = addOnAnchor ? [[anchor]] : [
      [...layers].sort((a, b) => fit(core[0]!, b) - fit(core[0]!, a) || compare(a.id, b.id)).slice(0, CANDIDATE_LIMITS.addOnsPerKind),
      [...outer].sort((a, b) => fit(core[0]!, b) - fit(core[0]!, a) || compare(a.id, b.id)).slice(0, CANDIDATE_LIMITS.addOnsPerKind)];
    for (const kind of kinds) for (const extra of kind) add([...core, extra], true);
  }
  const all = [...sets.values()].sort((a, b) => b.score - a.score || compare(a.key, b.key));
  const k = CANDIDATE_LIMITS.perAnchor, explore = Math.min(CANDIDATE_LIMITS.exploration, Math.max(0, all.length - 1));
  const picks: CandidateSet[] = [], uses = new Map<string, number>();
  const take = (set: CandidateSet, cap: number) => {
    if (picks.includes(set) || set.ids.some((id) => id !== anchor.id && (uses.get(id) ?? 0) >= cap)) return false;
    picks.push(set);
    for (const id of set.ids) if (id !== anchor.id) uses.set(id, (uses.get(id) ?? 0) + 1);
    return true;
  };
  for (const set of all) { if (picks.length >= k - explore) break; take(set, CANDIDATE_LIMITS.partnerReuse); }
  const hasKind = (addOn: boolean) => picks.some((set) => set.addOn === addOn);
  for (const wanted of [false, true]) {
    if (hasKind(wanted) || !all.some((set) => set.addOn === wanted)) continue;
    const swap = all.find((set) => set.addOn === wanted && !picks.includes(set));
    if (!swap) continue;
    if (picks.length >= k - explore) picks.pop();
    take(swap, CANDIDATE_LIMITS.explorationReuse);
  }
  const rest = all.filter((set) => !picks.includes(set)).sort((a, b) => hashOf(a.key) - hashOf(b.key) || compare(a.key, b.key));
  for (const cap of [CANDIDATE_LIMITS.partnerReuse, CANDIDATE_LIMITS.explorationReuse, Infinity]) {
    for (const set of rest) { if (picks.length >= k) break; take(set, cap); }
  }
  return picks.sort((a, b) => b.score - a.score || compare(a.key, b.key));
}

export type BatchInput = {
  items: readonly (CandidateItem & { imageBytes: number })[]; anchors: readonly string[]; known: ReadonlySet<string>; bans: CandidateBans;
  sign?: (ids: readonly string[]) => Promise<string>;
};
export type Batch = {
  sets: SignedSet[]; garments: string[]; imageBytes: number;
  /** Anchors whose whole candidate list is now known or in this batch: they may be marked assessed. */
  covered: string[];
  /** Anchors in the input that are not covered yet. */
  uncovered: string[];
};
const tokensFor = (garments: number) => CANDIDATE_LIMITS.textTokens + CANDIDATE_LIMITS.imageTokens * garments;

/**
 * One batch: candidate lists of the first anchors (finite, known sets dropped), packed so that garments, image bytes and
 * estimated input tokens all stay within their bounds. After the greedy pass every other pending set whose garments are
 * already in the batch is added too, so photos are sent once however many sets use them.
 */
export async function buildBatch(input: BatchInput): Promise<Batch> {
  const sign = input.sign ?? signatureOf;
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const pending: SignedSet[] = [], perAnchor = new Map<string, string[]>(), covered: string[] = [];
  const seen = new Set<string>();
  for (const id of input.anchors.slice(0, CANDIDATE_LIMITS.maxAnchors)) {
    const anchor = byId.get(id);
    if (!anchor) continue;
    const unknown: string[] = [];
    for (const set of anchorSets(anchor, input.items, input.bans)) {
      const signature = await sign(set.ids);
      if (input.known.has(signature)) continue;
      unknown.push(signature);
      if (!seen.has(signature)) { seen.add(signature); pending.push({ ...set, signature }); }
    }
    if (unknown.length === 0) covered.push(id); else perAnchor.set(id, unknown);
  }
  const garments = new Set<string>(), chosen: SignedSet[] = [];
  let bytes = 0;
  const fits = (ids: readonly string[]) => {
    const added = ids.filter((id) => !garments.has(id));
    const extraBytes = added.reduce((sum, id) => sum + byId.get(id)!.imageBytes, 0);
    return garments.size + added.length <= CANDIDATE_LIMITS.maxGarments && bytes + extraBytes <= CANDIDATE_LIMITS.imageBytes
      && tokensFor(garments.size + added.length) <= CANDIDATE_LIMITS.plannedTokens;
  };
  const include = (set: SignedSet) => {
    for (const id of set.ids) if (!garments.has(id)) { garments.add(id); bytes += byId.get(id)!.imageBytes; }
    chosen.push(set);
  };
  for (const set of pending) if (chosen.length < CANDIDATE_LIMITS.maxSets && fits(set.ids)) include(set);
  for (const set of pending) {
    if (chosen.length >= CANDIDATE_LIMITS.maxSets) break;
    if (!chosen.includes(set) && set.ids.every((id) => garments.has(id))) include(set);
  }
  const chosenSignatures = new Set(chosen.map((set) => set.signature));
  for (const [id, signatures] of perAnchor) if (signatures.every((signature) => chosenSignatures.has(signature))) covered.push(id);
  const done = new Set(covered);
  return { sets: chosen, garments: [...garments].sort(compare), imageBytes: bytes, covered,
    uncovered: input.anchors.filter((id) => byId.has(id) && !done.has(id)) };
}
