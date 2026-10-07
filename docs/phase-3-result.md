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

## OUTFIT1 - outfit Trash lifecycle, 7 October 2026

This source packet extends the historical I11 result above; it is not a
merge, hosted installation, deployment, visual approval or owner acceptance.
The owner requested both individual and multi-select removal, with Undo and
Trash Restore, and chose seven-day recovery plus permanent deletion.
The coordinator approved the Tier A plan with binding Opus5.5/high critique
amendments in [#84 comment 6036609345](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6036609345).
The fresh sole local writer uses GPT-6.1 Sol/medium, on
`drrowdev-outfit1-trash-and-undo`, base
`06b2eac5b2baa341d711e84c35a938b66b25a84e`. Root instruction files, dependency
pins, CI and old migration bodies/hashes are unchanged.

Requirements: R06 (outfits), R07/R08 (wear/calendar preservation), R11/R12
(owner integrity), R16/R17 (recovery/Trash), R20 (accessibility),
R23 (predictable concurrency) and R27 (EN/FI/SV localization).
The earlier I11 localization label R23 above is historical; R27 is the
localization requirement.

- Individual detail and accessible list selection/Select all use explicit
  confirmation, sequential frozen owner/version targets and confirmed-only
  eight-second Undo. Confirmed targets can be undone while a different target
  remains uncertain; uncertain Undo cannot resend, and closing the Undo notice
  keeps Check available. Failed/uncertain changes are explicit; Check is read-only.
- Trash groups clothes and outfits without using garment RPCs for outfits.
  Seven-day Restore survives reload. Expired outfits remain, with permanent
  deletion only; there is no purge. Direct historical outfit links show
  recovery instead of a generic unavailable message.
- The LF transaction `20261007090000_outfit_lifecycle.sql` adds two checked
  authenticated RPCs with the approved admission/profile/controls/outfit lock
  order. Existing ordinary grants and `save_outfit` are unchanged.
- Permanent deletion refuses unexpired running try-on chains; existing FKs
  remove outfit links/private try-on JPEGs/references. Clothes/photos,
  calendar dates/labels, wear snapshots and statistics stay. Wear source
  nulling necessarily bumps technical version/time; client invalidates
  history/calendar. No consent/provider/cost changes or hosted action.
- Saved-only exports already exclude trashed outfits and null their exported
  event source links; historical text remains. That behavior is unchanged.

### OUTFIT1 validation and remaining gates

Pinned Node24.19.0/npm11.17.0 and locked Playwright executables were verified
locally. The first lint attempt failed because dependencies were absent; the
approved locked `npm ci --quiet` restored them without changing manifests.
The locked install reported seven high advisories; no dependency upgrade or
install-script approval was performed.

| Command | Evidence so far |
| --- | --- |
| `npm run test:unit -- tests\unit\outfit-lifecycle.test.ts tests\unit\outfit-lifecycle-schema.test.ts tests\unit\outfits.test.ts tests\unit\preservation.test.ts tests\unit\isolation-catalog.test.ts tests\unit\ci-storage-guard.test.ts tests\unit\ai-purge-schedule.test.ts tests\unit\bulk-trash.test.ts tests\unit\wear-events.test.ts tests\unit\wear-history.test.ts` | 694 passed |
| `$env:PLAYWRIGHT_PORT='5194'; npm run test:browser -- outfits.spec.ts bulk-trash.spec.ts items.spec.ts --grep 'OUTFIT1\|bounded I11\|select three, move them\|standalone list states' --project chromium --project mobile --project webkit-photo` | 39 passed, including partial/uncertain Undo, owner change during a held batch, repaired garment-group selectors, EN/FI/SV, 320px/200% dialog overflow and bounded captures |
| `npm run lint` | passed |
| `npm run check:translations` | passed, 1100 keys in EN/FI/SV |
| `npm run scan:secrets` | passed locally without the CI canary |
| `npm run typecheck` | passed after the authorized genuine generated-type import; no fabricated types/casts |

The broader fixture run (`npm run test:browser -- outfits.spec.ts
bulk-trash.spec.ts items.spec.ts tryon.spec.ts calendar.spec.ts --project
chromium --project mobile --project webkit-photo`, port5194) recorded
372 passed, 22 skipped and six failures: the two old garment tests in every
project assumed a single Trash list and level-two garment headings.
Those selectors were corrected for the new groups/heading hierarchy; all six
passed in the targeted run above. That is not a full-suite green result at the
final head. Calendar is selected only by chromium/mobile in the existing
configuration; no project matches were expanded. Full exact-head CI remains
pending. Normal-session lifecycle integration and
security/isolation probes were added but not run locally: this writer has
no approved backend-stack ownership. No Docker/WSL or hosted smoke ran.
The initial source [CI run 37617032688](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/37617032688),
head `081eed7a46f1ad71b909811bdea5f2968f8d0657`, passed preservation,
integration and security before the generated-type guard. Its static checks
failed on the two missing RPC names; the type guard failed solely on the
genuine generated additions. All three Chromium/mobile shards and WebKit2/2
passed. WebKit1/2 reported a new nonallowlisted retry in unchanged
`enhancement.spec.ts:324`: `crop-review-hint` was absent while preparing an
accepted changed crop. The retry passed, but the gate correctly failed;
this result is not waived and no Actions rerun/allowlist change was performed.

The coordinator authorized `database-types` artifact11480883218 from that
exact run/head and supplied its extracted text file. The writer mechanically
copied it byte-for-byte and verified byte equality: only
`delete_trashed_outfit` and `set_outfit_trashed` were added.
Typecheck, lint, translations and the 694 affected unit tests passed afterward.
A fresh exact-head CI must pass all required gates.

All six historical I11 captures remain. Four bounded additions are
`outfit-bulk-confirm-en-desktop.png`, `outfit-trash-en-desktop.png`,
`outfit-delete-confirm-en-desktop.png` and
`outfit-phone-trash-fi-mobile.png` under ignored `test-results/i11-visual`.
The existing CI upload enumerates the six old paths and **does not upload
these four additions**. The coordinator explicitly chose to review these
four local ignored captures at the final committed head, alongside CI's
six preserved scenes, without changing CI. Final-head regeneration and
actual review remain pending; current pre-commit images are not acceptance.
The writer stays text-only.
Independent Opus5.5/high code review, coordinator exact-head visual review,
normal-owner acceptance and owner-run R5 deployment remain separate gates.
