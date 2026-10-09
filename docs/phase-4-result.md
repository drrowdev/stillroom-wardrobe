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