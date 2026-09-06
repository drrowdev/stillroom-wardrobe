# Explainable outfit engine

All rules in this file are **PROPOSED styling heuristics**, not scientific compatibility claims. The engine is a pure TypeScript function. It runs locally, uses only the current owner's catalog/preferences/history, and makes no AI or other network call. Weather is optional structured input supplied by a separate adapter.

**User decision, 6 September 2026:** outfits stay deterministic. AI fills an editable draft from a photo; only the owner's explicit Save makes its attributes available to this engine. Unsaved drafts, discarded analyses and incomplete upload saves are not candidate inventory. No outfit AI call, reranker or free-form explanation; see `20`.

```ts
type RecommendationContext = {
  ownerId: string; localDate: string; occasion: 'home'|'everyday'|'smart'|'business'|'formal';
  setting: 'indoors'|'outdoors'; temperatureC?: number;
  rainProbability?: number; windMetresPerSecond?: number;
  weatherSource: 'forecast'|'manual'|'unavailable'; season: 'spring'|'summer'|'autumn'|'winter';
};
type ItemRef = {itemId:string}; // always owned by the current account
type Suggestion = {
  items: ItemRef[]; score: number;
  reasons: {key: string; parameters: Record<string,string|number>}[]; // constrain keys to the reason catalog in implementation
  missingSlots: string[]; // canonical category codes, translated only for display
  completeness: 'complete'|'partial'; rulesVersion: 'rules-v1';
  contextFingerprint: string;
};
```

Each run receives an explicit clock/context and immutable catalog. No reading `Date.now()` inside scoring, and no `Math.random()` tie breaker. Sorting uses item UUID after score so a fixture yields the same answer on both phones.

Reason keys/parameters are language-neutral output, not English sentences. The presentation adapter formats numeric parameters (for example temperature) and resolves English/Finnish/Swedish strings using `19-LOCALIZATION.md`. Language is not a scoring input: the same catalog/context/clock must yield identical item IDs, scores and signatures in all three languages.

An exact-combination signature is lowercase hex SHA-256 of the UTF-8 string formed by sorting unique item UUIDs lexicographically and joining with `|`. Store the owned `item_ids` array with the vote; SQL validates ownership, canonicalizes the array and derives the signature. The scorer uses the same formula. Restore remaps the array and derives a new signature so saved feedback remains effective.

## Inputs and taxonomy

Categories: top, bottom, one_piece, footwear, layer, outerwear, accessory. Default outfit templates are **top + bottom + footwear**, and **one_piece + footwear**. A layer, outerwear and at most one accessory may be added. Accessories never determine whether a core outfit exists. One-piece clothing is available to either person without a gender preference assumption.

Formality targets: home 0, everyday 1, smart 2, business 3, formal 4. Item formality is 0–4. Coverage codes: upper 0 unrestricted / 1 shoulders covered / 2 long sleeves; lower 0 unrestricted / 1 to knee / 2 to ankle. Use the maximum coverage of the relevant outfit pieces, not the minimum of every layer.

The date determines northern-hemisphere season by default: March–May spring, June–August summer, September–November autumn, December–February winter. A manual season override is always available and is required for travel outside this assumption until trips ship. Style tags use the owner's chosen finite set such as relaxed, athletic, minimal, workwear and colourful. They are preferences, not inferred identity traits.

## Hard eligibility and rejection

Apply hard constraints **before** scoring, then re-check them on every completed combination:

1. Owner matches the authenticated catalog; no foreign original records. Item is active, not trashed, availability ready, not excluded, and its category is not excluded in preferences.
2. No duplicate item. Follow a template and fill its core slots. A one-piece does not require a separate top/bottom.
3. Never include a canonical excluded pair or a combination with an exact negative feedback signature. Favourites and score cannot override these rules.
4. Meet minimum combined upper/lower coverage. For business/formal, every core clothing item must be at least target−1 and the median core formality at least the target. Accessories are ignored in that test.
5. For outdoors with a known temperature, honour any explicit item min/max temperature range. These are user-imposed limits, not inferred material properties. Unknown ranges impose no rejection. Indoors uses the user's indoor temperature only if supplied.
6. Outdoors at ≤5°C requires outerwear and ankle coverage. Outdoors with rain probability ≥60% requires a rain-resistant/waterproof layer or outerwear (rain rating ≥1). Outdoors with wind ≥10 m/s requires a windproof layer or outerwear. Weather requirements do not apply to indoor context.
7. If an outdoor weather requirement cannot be satisfied, return a clearly partial suggestion or a missing-gear explanation. Never present the incompatible combination as weather-suitable. Do not automatically add outerwear to an indoor outfit merely because the outdoor forecast is cold.

Seasons are a soft fit signal rather than a universal hard exclusion: a cardigan tagged autumn can still suit a cold summer day. Laundry/availability, disliked pairs and deliberate temperature limits remain hard.

### Unknown and automatically identified attributes

I29 adds field provenance and removes false factual defaults for unentered physical attributes. `ai_observed` visible coverage can participate when the image supported that observation; a user correction always supersedes it. Material/formality estimates remain identified as estimates. A photo-based guess cannot establish insulation, waterproofness or wind protection.

If required coverage or weather protection is unknown, name the missing detail and return a partial result rather than declaring the outfit suitable or claiming the garment lacks that property. Preserve explicit exclusions. For soft scoring, omit unknown measurements from their component; if no usable values remain, deactivate that component and renormalize. The warmth calculation requires known warmth for the included clothing pieces; never sum nulls as zero or use the base SQL defaults as confirmed values.

The existing fully specified score fixtures below remain unchanged. Add separate fixtures for unknown/manual-clear/AI-estimate cases, including real long trousers whose coverage has not yet been recorded. Personal preferences and deliberately entered temperature limits remain authoritative.

## Candidate generation and bounded work

1. Build eligible category buckets. Preliminary rank each by preference, favourite, wear-more and least-recently-worn; UUID breaks ties. Retain at most **8** per category, but include an explicitly pinned owned item before truncation if it passes hard rules.
2. Expand each valid core template using a **beam width of 40**. At every slot, reject invalid partial combinations, compute an optimistic preliminary score and keep the best 40. Stop after **2,000 total expansions** across templates.
3. Add an optional layer/outerwear only when required by context or when it improves warmth fit. A `none` choice is available when optional. Accessories are opt-in and never block generation.
4. Run complete hard validation, score survivors, deduplicate by sorted refs and select up to three. Require at least one different core item between displayed suggestions, and prefer two differences where the catalog allows it. Do not fill the screen with cosmetic accessory variants.
5. If truncation misses a valid combination, run one additional pass with the next eight eligible items per required category under the same 2,000 expansion budget. Overall budget is at most 4,000 expansions. Expose partial results if still empty; no unbounded Cartesian product.

Small wardrobes bypass truncation. The performance gate is <200 ms at 500 items on an actual target phone, with memory and expansion counters measured. The bounded search is an approximation, not a promise of globally optimal styling.

## Score

For each active component `s` in [0,1], compute `100 × Σ(weight × s) / Σ(active weights)`. Unavailable components are removed and remaining weights renormalized. Round only the displayed score; keep full precision for sorting. Never use protected spouse data to calculate a component.

| Component | Weight | Exact rule |
|---|---:|---|
| Weather/season fit W | 25 | If temperature is known: `max(0,1−abs(warmth−target)/6) × 0.9 + seasonMatch × 0.1`. With no temperature but explicit manual season: seasonMatch alone. With unavailable weather and no season preference context: inactive. |
| Occasion O | 20 | Mean over core clothes of `max(0,1−abs(itemFormality−targetFormality)/2)`; hard business/formal gates still apply. |
| Colour compatibility C | 15 | If preferred colours exist: 0.8 × mean pair compatibility + 0.2 × fraction of core pieces in preferred colours; otherwise mean compatibility. Ignore footwear/accessories unless colourful mode is enabled. Unknown pairs =0.5. |
| Personal style S | 10 | Mean fraction of each item's style tags matching selected preferences; if item has no tags use 0.5. No selected style preferences → inactive. |
| Recency N | 10 | Mean `min(daysSinceLastWear/repeatGapDays,1)`; never worn=1; gap zero=1. Date difference uses local calendar days. |
| Use balance U | 10 | Mean `1−wearCount/(maxEligibleWearCount+1)` for owned pieces. This modestly favours underused clothing. |
| Favourite F | 5 | Fraction of owned items marked favourite. |
| Feedback P | 5 | Mean item value: wear-more=1, ordinary=0.5; exact liked combination adds 0.25, clamped to 1. Exact disliked combinations were already rejected. |

For warmth: `top.warmth + bottom.warmth + 2×onePiece.warmth + layer.warmth + 2×outerwear.warmth`; absent slots contribute zero and footwear is excluded. Target by temperature: ≥25°C →1; 18–24.99 →3; 10–17.99 →6; 2–9.99 →10; below 2 →14. Add the owner's cold-sensitivity value (−2…2), clamp 0…18. `seasonMatch` is the fraction of clothing pieces tagged for the context season. These coarse values must be editable item metadata; they are not fabric measurements.

Colour palette: black, white, cream, grey, navy, brown, tan, blue, green, olive, red, burgundy, orange, yellow, pink, purple, unknown. Pair score: a neutral (black/white/cream/grey/navy/brown/tan) with any known colour=1; identical non-neutral hues=0.8; explicitly adjacent pairs `{blue,green}`, `{green,olive}`, `{red,burgundy}`, `{red,orange}`, `{orange,yellow}`, `{pink,purple}`=0.85. Other known pairs=0.6. In colourful mode the contrast pairs `{blue,orange}`, `{purple,yellow}`, `{green,red}` receive 0.85. Pair order is irrelevant. Nothing here hard-bans a colour; users can explicitly exclude item combinations.

## Explainability and examples

Choose the two highest positive weighted contributions with understandable causes, plus any relevant constraint: “Uses your preferred olive colour”, “This overshirt has not been worn for 12 days”, “Includes a rain-resistant layer for the forecast”. Explain a missing piece in plain terms. Do not display invented confidence probabilities or imply the score measures how attractive the user is.

| Fixture | Expected result |
|---|---|
| A: W=.9, O=1, C=.9, S=1, N=.8, U=.7, F=.5, P=1 | **88.5/100** with all weights active |
| B: W=.7, O=.95, C=.8, S=.6, N=.2, U=.3, F=1, P=.5 | **67/100**; A ranks higher despite B's favourites |
| A with weather component inactive | Remaining numerator 66 / weight 75 → **88/100**; label weather unavailable |
| Favourite shirt in laundry | Rejected before scoring |
| Cold outdoor day but indoor context | No forced coat; use indoor manual temperature or neutral fit |
| Outfit contains a disliked pair | Rejected even if its theoretical score is 100 |

## Cold start and outages

With no items, guide capture of a top/bottom/shoes or one-piece/shoes. With only a top, offer it as a partial starting point and name the missing categories. With one complete outfit, show one result; never hallucinate variety. New items receive neutral unknown metadata and a visible “Improve suggestions” link; no guessed brand/material/fit. Lack of feedback does not block rules.

Weather adapter timeout is 5 s, cached forecast age at most 3 h, explicit refresh cooldown 60 s. On failure, offer manual temperature and indoor/outdoor context, or run without the weather weight. A stale forecast is labelled and used only after the user explicitly chooses it. The rules themselves do not fetch or infer location.

## Account boundary

The engine accepts only a catalog tagged with the current authenticated owner UID. There is no shared-content flag, foreign-reference type, peer preference input or borrowing workflow. Its adapter rejects any record whose owner differs before generation. A saved outfit and its wear history can contain only owned item IDs. Changing accounts destroys engine inputs/results before loading a new catalog.

## Tests and provider boundary

Unit/property fixtures must prove hard constraints, deterministic output, score arithmetic, missing weather renormalization, empty catalog, one-piece templates, no duplicates, availability, timezones, canonical pairs, feedback exclusion, beam limits and owner isolation. A metamorphic test adds 500 foreign records and asserts identical owned recommendations. Changing the active UID invalidates all in-memory inputs and results.

After ten ordinary dressing decisions per user, each independently rates three suggestions useful/neutral/not useful. Target at least one useful result on 7 of 10 decisions when the catalog contains enough suitable clothes. This is an evaluation goal, not a claimed measured success rate. Tune soft weights only after failures are categorized; never weaken privacy/availability/dislike constraints to improve that metric.

```ts
interface ImageEnhancementProvider {
  readonly id: string;
  enhance(input: {image: Blob; consent: boolean}, signal: AbortSignal):
    Promise<{status:'ok';image:Blob}|{status:'unavailable';reason:string}>;
}
```

Image enhancement remains disabled. Pre-save photo analysis is a separate I29 endpoint, not part of this scorer. It fills the editable form automatically; library saving is explicit. Save does not turn an unchanged AI estimate into confirmed warmth/protection. Manual edits, owner isolation and budgets remain authoritative.

I15's completion evidence includes the ten-decision usefulness sample above for each owner when enough suitable garments exist. Record failures by missing metadata, rule mismatch or personal taste before tuning weights; paid tagging alone is not proof that outfit suggestions are useful.
