# Phase 3 — I11 outfits: create, name, edit and view

**Implemented locally and left unstaged for coordinator review. This is not a
merge, deployment or user acceptance.** The browser, unit and static checks
listed below passed on the local machine. The real local Supabase integration
and security suites were not run here (see [Pending gates](#pending-gates)).

- Requirements: R06 (outfits: create, name, edit, view) and R23 (EN/FI/SV for
  every new string).
- Packet: I11 layer 1, the first Phase 3 packet. Plan rev 3 plus the rev 4
  delta, with binding amendment E1, were approved at
  [PR #38 comment 5816339602](https://github.com/drrowdev/stillroom-wardrobe/pull/38#issuecomment-5816339602)
  after an actual read-only GPT-6 Astra critique.
- Writer: one persistent local session, `1cc36142-8714-4469-9d6f-8849c517e18b`.
  The coordinator attested it as `claude-opus-5.5` from its events.jsonl.
- Base: main `d3814f33f3c9d59e832a0f91058a619353a26d1f` (includes L2b PR #40),
  branch `drrowdev-outfits-i11-planning`. The work started on `386656b6` and was
  moved forward by stash and pop, with no merge commit. The translation catalogue
  combined key by key, and no key was changed on both sides.
- Node: v24.19.0.

## What changed

- **No migration and no hosted change.** Saves use the installed base RPC
  `save_outfit` (SECURITY INVOKER, authenticated only). Reads use the
  owner-filtered `outfits` table with an embedded `outfit_items` projection.
  Generated types, `messages.json`, dependencies and the lockfile are unchanged.
- **Routes:**
  - `#/outfits` is the list.
  - `#/outfits/new` is the editor.
  - `#/outfits/<id>` is the detail page. It has an in-page Edit mode instead
    of a separate edit hash.
- **Header:**
  - The header now has Wardrobe and Outfits links. Only the link for the
    committed route gets `active-nav` and `aria-current="page"`.
  - At 650 px and below, the nav moves onto its own row. Previously it was
    hidden.
- **Editor:**
  - Pick up to 12 active items and reorder them with Move up and Move down.
    The new position is announced in a live region.
  - Name the outfit. Optional details are occasion, notes and favourite.
  - Validation runs only when you press Save outfit.
  - Items that are trashed or archived stay in the outfit and are labelled.
    Deleted items leave a position gap, which is reported on the detail page.
- **Unknown save results:**
  - A save whose reply is lost, or that fails with a transport error, triggers
    exactly one read-only reread of that outfit after one second. The reread
    waits while the app is offline or the leave dialog is open. It never
    resends the save.
  - Only an explicit "not saved" result offers Try again, which resends the
    frozen original attempt.
  - "Still saving" offers Try again as well, but that only rereads.
- **E1:**
  - The first unknown save result marks the editor unresolved, even while it
    is still busy. It stays unresolved until the reread classifies the outcome.
  - Leaving during the scheduled delay or the offline wait shows the outfit
    dialog: "Your last change may already be saved."
  - That dialog never shows the ordinary discard text, never uses AI
    cancellation or refund wording, and sends no further writes.
- **Isolation:**
  - Every read filters on the owner. Rows owned by another account are
    rejected when parsed.
  - Another account's outfit, or a malformed ID, shows "This outfit isn't
    available."

## Code review repair (GPT-6 Astra AMEND, agent 2210d6b3)

- **A removed outfit keeps the open editor.** If a refresh finds the outfit
  deleted or missing while you are editing, the editor and its last loaded
  outfit stay mounted. The draft is kept but locked, with "This outfit isn't
  available." An unknown save keeps its frozen attempt and E1 state until its
  reread reports the removal. Only leaving, through the usual leave dialog,
  clears it.
- **Selected garments keep current labels.** The editor rereads every selected
  garment, whatever its lifecycle or trash state, on the same refresh triggers
  as the picker. Archiving, trashing or restoring a selected garment elsewhere
  updates its label and never turns it into "unavailable". The picker still
  offers only active garments.
- **Every 5xx save reply is unknown.** It is classified before the database
  code allowlist, so a 503 carrying `42501` is reread before any resend.
- **Tests added:**
  - both disappearance cases;
  - archive, trash and restore of a selected garment in create and edit;
  - a 5xx reply with a rejection code, and a 503 reread after the client's own
    retries;
  - F3 return-to-Outfits after photo replace, archive, trash, restore and
    permanent deletion;
  - missing and denied photos;
  - held responses across a route change and across sign-out A / sign-in B;
  - the deletion read race and a persistently unreadable link;
  - a 320 px and 200% text check that also covers the header nav on the
    wardrobe, settings and trash screens.
- **Captures** use the approved states:
  - three list cards;
  - the editor with four slots, one in the trash, and More details open;
  - the detail page with the deletion-gap note.

## Second repair (GPT-6 Astra AMEND, agent 860dafb1)

- **A clean editor follows same-version composition changes.** Permanently
  deleting a garment removes its outfit link without changing the outfit
  version. A clean, idle editor now takes the refreshed composition at the same
  version, so the deleted garment leaves the draft and Save sends only the
  remaining items. A dirty draft, or one with a pending save attempt, keeps its
  baseline. Tests cover both cases; the clean case fails without the fix.
- **The 200% text check scales body text too.** The test applies
  `html { font-size: 200% } body { font-size: 32px }`. Before the overflow and
  nav checks, it asserts that the name label, a garment name and the name input
  value each render at exactly twice their normal computed size.

## Files

**Added:**
- `src/domain/outfits.ts`, `src/data/outfits.ts`
- `src/features/outfits/{use-outfits.ts,outfits-screen.tsx,editor.tsx,detail.tsx}`
- `tests/unit/outfits.test.ts`, `tests/browser/outfits.spec.ts`
- `tests/integration/outfit-rpc.sessions.mjs`, `tests/security/outfit-rpc.sessions.mjs`
- this file

**Changed:**
- `src/app/app.tsx`, `src/app/icon.tsx`, `src/i18n/phase-zero.json` (32 keys),
  `src/styles/app.css`
- `tests/browser/mock-backend.ts`, `scripts/run-local-tests.mjs`
- `playwright.config.ts` (the spec is added to webkit-photo)
- `.github/workflows/ci.yml` (one App-job upload), `tests/unit/ci-workflow.test.ts`

## Local validation

| Command | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run check:translations` | pass: 608 keys in en/fi/sv, 71 files |
| `npm run test:unit` | pass: 39 files, 3688 tests (first repair); see the note below for the second |
| `npm run build` | pass (existing chunk-size warning) |
| `npm run scan:secrets` | pass: 280 files; CI supplies the canary |
| `npm run test:a11y` | pass: 87 |
| `npm run test:browser -- --project=chromium --project=mobile` | pass: 778, 2 skipped |
| `npm run test:browser -- --project=webkit-photo` | pass: 345, 2 skipped |
| `npx playwright test outfits.spec.ts` (all three projects) | pass: 138 |
| `git diff --check` | clean |

After the second repair, `npm run test:unit` ran six times while another
project's tests were running on the same machine. Every run reported 1–4
failures, all "Test timed out in 5000ms". The failing tests differed between
runs, were all outside the outfits code, and each passed when run on its own.
The same suite passes 3688/3688 with `npx vitest run --testTimeout=20000`.
This is recorded as an environment result, not a pass. CI on the exact head
decides the gate.

Local browser runs used `PLAYWRIGHT_PORT=5291`, because another worktree's
test server was holding the default port. The mobile project is Chromium with
iPhone 13 emulation, and webkit-photo is Desktop Safari's engine. Neither is a
native-device claim.

## Pending gates

- **Real local Supabase:** `npm run test:integration` and `npm run
  test:security` are **NOT RUN** locally. This session has no approved local
  stack ownership. The new suites are wired into `scripts/run-local-tests.mjs`
  and run in CI's Real local Supabase job:
  - **Integration:** create, replay and conflict; edit, stale version, bounds
    and atomicity; archived and trashed items; soft delete; a race between two
    sessions of the same owner; untouched wear rows; the owned embed; and the
    item-deletion cascade.
  - **Security:** A→B and B→A, plus anonymous callers.
- **Visual review:** the six synthetic captures (`test-results/i11-visual/`,
  artifact `i11-outfits-ui-<head>`) are generated but not reviewed. The session
  is text-only, so the coordinator's exact-head review remains pending.
- **Coordinator:** GPT-6 Astra code review, publication release, draft PR and
  CI remain open.
- **Owner:** normal-owner acceptance remains open.
