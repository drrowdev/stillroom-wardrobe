# Phase 4 — I15 Today: outfit ideas with Like and Not for me

**Implemented locally on a draft PR for review. It is not merged, deployed or
accepted by the owner.** The browser, unit and static checks listed below passed
on the local machine. The real local Supabase integration suite was not run
here (see [Pending](#pending)).

- Requirements: R09 (explainable recommendations: at most three ranked
  outfits, hard exclusions, reasons and missing slots), R25 (durable
  suggestion feedback, owner-only) and R27 (EN/FI/SV for every new string).
- Packet: I15, the second Phase 4 packet. It is stacked on I14 (engine, PR #45).
  The plan was approved as Tier B, with owner answers Q1 (Wardrobe stays the
  start page, Today is added to the nav), Q2 (no "Don't pair these two" action)
  and Q3 (the hidden style preferences are not used).
- Writer: one persistent local session (`claude-opus-5.5`).
- Node: v24.19.0.

## What changed

- **No migration and no hosted change.** Like and Not for me use the installed
  `suggestion_feedback` table. Its trigger checks ownership, sorts the item IDs
  and derives the signature. The app upserts on `owner_id,signature` and
  clears a vote by owner and signature. Excluded pairs are read from the
  installed `combination_rules` table. Both reads are owner-filtered and paged
  (500 rows per page).
- **Today screen** (`#/today`, first link in the header nav):
  - Occasion and Season selects. Season defaults from the profile time zone's
    local date.
  - Up to three ideas, each with its pieces, photos and up to two reasons.
  - **More ideas** pages through every distinct idea; **Start over** returns to
    the first page. A new occasion or season starts again.
  - **Save as outfit** opens the I11 editor filled in with the pieces and the
    occasion. Saving uses the existing `save_outfit` RPC once.
  - **Like** toggles (`aria-pressed`). **Not for me** hides that exact outfit
    for good and offers **Undo**. Votes apply from the next page, so a card
    never jumps while you look at it.
  - A partial start (for example only tops) shows what is missing and leads to
    **Add item**. With no clothes there is a short empty state.
  - Offline keeps the ideas visible and disables Save, Like and Not for me.
- **Only active clothes with a ready photo** are offered, and the engine skips
  anything not ready to wear (for example in the laundry). Archived, trashed,
  excluded and photo-pending items never appear.
- **No wear history, weather, AI or Edge Function calls.** The engine is the
  deterministic I14 `rules-v1`.

## Validation (local)

- `npm run lint`, `npm run typecheck`: pass.
- `npm run check:translations`: 626 keys in en/fi/sv.
- `npm run test:unit`: pass. Under machine load three unrelated tests time out
  at 5 s (`preservation`, `ai-schema`, `local-backend`). Each file passes when
  run alone.
- Playwright `today.spec.ts` on chromium, mobile and webkit-photo: 36 passed.
- Playwright `outfits.spec.ts` and `slice.spec.ts` on chromium and mobile
  (header nav changed): 168 passed.
- Accessibility: axe on every state, keyboard order, 320 px and 200 % text
  with three nav links.
- Bounded synthetic captures (`test-results/i15-visual/`, App job artifact
  `i15-today-ui-<head>`): ideas and missing, en-desktop and fi-mobile.

## Pending

- `tests/integration/feedback.sessions.mjs` (owner-isolated upsert, update in
  any order, undo, server bounds) runs in the CI database job. There is no
  local Docker here.
- Coordinator visual review of the four captures.
- The ten-decision usefulness sample with the owner's real wardrobe.
- The phone performance check on a real device.

## Later addition: Don't pair these

Owner priority after PR #66; Tier B, no schema change. This section records
that packet; the I15 record above is unchanged.

- **Today**: each idea with two or more pieces offers **Don't pair these**.
  With two pieces it applies at once; with more, it asks which two. The card
  then shows the two pieces, "These two won't be suggested together." and
  **Undo**. Other ideas on the page with both pieces disappear, and later
  pages, Start over and reloads never pair them.
- **Settings > Avoided pairs** lists each pair with both thumbnails and titles
  and a **Remove** button; with none, one plain line. A pair is skipped while
  either piece is in trash and returns if the piece is restored; permanent
  deletion removes it by cascade.
- Writes go to the installed combination_rules table (idempotent insert on
  owner_id,item_low,item_high, exact owner delete). A lost reply is checked
  by reading the pair back; an unsettled change offers Try again and locks the
  other choices, as for votes.
- 	ests/integration/feedback.sessions.mjs now also covers insert, duplicate,
  ordering and self-pair refusal, removal and owner isolation for pairs.
- Captures added to i15-today-ui-<head>: pair-chooser-fi-mobile,
  pair-chooser-fi-320-200, pair-hidden-en-desktop,
  voided-pairs-sv-mobile.

## PAIR1: Don't pair these moves straight on (9 October 2026)

Owner request: choosing Don't pair these showed a summary of the decision that
was not needed. Tier B UI change on base b2c09aae; no schema, storage, security,
privacy or ranking change. It supersedes the card described above ("shows the
two pieces ... and Undo") and its pair-hidden-en-desktop capture; the rest of
that section is unchanged.

- **Today**: once the pair is confirmed saved (including a lost reply confirmed
  by reading the pair back), the idea gives way to the next eligible one, on the
  next page when the current page is used up, or to the existing no-more state.
  There is no summary, status line or extra Show another tap. With more than two
  pieces the pair chooser stays; Apply then behaves the same way.
- **Undo** is a compact button below the suggestion. It restores the latest
  confirmed pair only, for the current Today context (occasion, season,
  weather); a newer pair, a context change or leaving Today replaces it. The
  rejected idea returns when it is still on the page. It stays available when no
  ideas are left. A failed Undo says so and stays available; an unsettled one
  offers Try again and locks other choices.
- Nothing moves on for a rejected, offline or unsettled write; the existing
  Try again and locking rules are unchanged, as are writePair, readPair, merging
  and the stale-read and owner/epoch guards. Focus lands on the next suggestion
  heading or the no-more state only when it was on the removed idea; focus
  elsewhere is left alone.
- Strings: today.pairHidden replaced by today.undoPair (en/fi/sv).
- Captures: pair-next-en-desktop and pair-next-fi-mobile in i15-today-ui-<head>
  replace pair-hidden-en-desktop (ci.yml artifact list and its unit test).
  Written by tests, not viewed by the builder; coordinator visual review pending.
- Review repair: while an Undo is being written or unsettled, Save as outfit and
  Wear today are disabled with the other choices, so leaving Today cannot lose a
  pending Try again. A pair receipt carries the occasion, season and weather it
  came from; one that lands after the context changed is consumed without
  restoring the idea or moving the new page. Tests hold the Undo write and the
  forecast to cover direct confirmation and a lost reply. Removing the Save/Wear
  lock fails its tests; removing the receipt guard does not, because the old idea
  is still excluded when the receipt lands, so the guard is defence in depth.
- Validation (local, pinned Node 24.19.0): lint, typecheck, check:translations,
  tests/unit/today.test.ts and ci-workflow.test.ts, and tests/browser/today.spec.ts
  on chromium, mobile and webkit-photo (47 tests each). Full integration,
  security and browser suites run in CI.

## VARIETY1: Show another offers different bottoms (9 October 2026)

Owner decision on [#84](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6077163552): prefer noticeably different suitable outfits. Tier B engine fix on base 5d5c9b52; no schema, storage, security, privacy, provider, weather or copy change. Details of the contract are in blueprint/09-RECOMMENDATIONS.md ("Variety across ideas, rules-v3").

- **Reproduced** with the real engine on a synthetic fixture (6 white tops, 2 navy bottoms with one favourite, 4 black shoes, all summer, formality 1): the favourite bottom was in every idea on every page (91.7 each; the other bottom scored 89.3). Owner wardrobe data and images were not used.
- **Engine** (src/domain/recommendations.ts only): selection by least shown garments among cores within a 10-point fit band of the best remaining one, from the skipped core keys Show another already passes; the same ordering for beam trimming, and unfinished cores whose reachable completions were all shown are dropped (a shown core counts only if it fits the template and its capped candidate window, so replacement or removed garments never hide unseen cores; review repair). Scores, reasons, hard rules, limits (8/16, beam 40, 2,000 expansions, two passes) and the hook, featured and screen code (including the PAIR1 next-idea and Undo behaviour) are unchanged.
- **Result on the fixture**: the first six ideas use both bottoms, all 6 tops and all 4 shoes, the first idea is still the strongest, and every page keeps exact recorded scores. A bottom whose fit is clearly worse (out of season in that fixture) is not promoted, yet stays reachable at the end of paging.
- **Version**: `rulesVersion` is `rules-v3`, which exists only in the engine, its type and the context fingerprint; no stored value, migration or type file changes. The earlier sections stay as written.
- **Bounded-search measurement** (laptop, pinned Node 24.19.0, seeded 500-item catalog of the performance proxy, 20 occasion/season contexts, median of 7 calls each, whole recommend() calls, same conditions for both engines): expansions are identical (mean about 1,095, at most 1,744). Time on this machine: first page mean 8.7 ms and worst 14.4 ms (previously 3.7 and 6.8); after five shown pages mean 12.5 ms and worst 20.2 ms (previously 4.9 and 9.2); after fifteen mean 14.6 ms and worst 22.5 ms (previously 5.6 and 11.3), measured with the repaired engine in a separate run from earlier figures. This is a laptop figure; it does not show the target phone budget. The CI performance proxy is the gate for that and has not run on this head.
- **Exhaustive paging**, 8 tops x 8 bottoms x 8 shoes (one favourite bottom): the previous engine stopped after 320 of 512 cores; rules-v3 shows all 512 once each. The 8-per-category window is still not rotated, so a category of more than 8 ready items is not visited exhaustively.
- **Paging after a refresh (integration repair)**: a diagnostic run showed that a refresh can push an idea already seen off the page and that Show another could then offer it again (a refresh test failed 7 of 100 runs, 0 of 40 on the previous engine, which reorders less). Show another now also skips the cores of the ideas actually seen or showing, mapped from their keys within the page and context; ideas never seen stay reachable, and the map is cleared with the page, Start over and any context change. Changed: src/features/today/use-suggestions.ts (`skipAfterPaging`, the page's key-to-core map, `more(shownKeys)`) and src/features/today/today-screen.tsx (one call site); the PAIR1 pending, unresolved, auto-next, Undo and focus code is untouched.
- **Tests**: unit tests for the 6/2/4 journey over pages, strongest first and exact scores, colour and score variation, a clearly worse bottom, a crowded catalog, one-piece rotation, sparse/one-outfit/excluded pairs, blocked and disliked pieces, reversed input, cold weather and a partial wardrobe; a seeded paging property (no repeated core, hard rules, budget, determinism); regressions for a replacement pair of shoes after the shown ones are unavailable, a top and bottom left as a partial start when the shown shoes are gone, shown cores of another template or with garments outside the catalog, and the end of paging; a browser journey of six Show another taps with a favourite bottom, then starting over (it fails on the previous engine); unit tests for `skipAfterPaging`; a browser test where three favourites return from the laundry and push every shown idea off the page (30 of 30 pass; with the single `ideas.more()` call restored 30 of 30 fail), covering no repeat, reachability of the unseen ideas and Start over. No new captures.
- **Reachability regressions, mutation evidence**: restoring the reviewer's original `shownWith` guard fails the first three reachability regressions; turning pruning off entirely does not (the crowded 8x8x8 walk falls to 456 of 512), and the fourth regression is a behaviour check that neither change is expected to fail. An earlier hacked variant is weaker evidence and is not counted as that restore.
- **Validation unknown**: the identity of one failure in a first 144-test Today run was lost and is not recovered. A later run of the whole spec with repeats failed on fixed-path capture files (by design, one write per path), on two 30-second `page.goto` load timeouts in the first tests of two workers (not reproduced: with a cleared Vite dependency cache both pass in about 4 seconds, and the whole spec passed afterwards; cause unclassified), and on the refresh defect repaired above.
- **Not run locally**: full browser, integration, security, accessibility and performance suites, which run in CI. Coordinator review of existing exact-head captures, the performance proxy and the live check stay pending; CI must run on a head that includes main 322dc15e.