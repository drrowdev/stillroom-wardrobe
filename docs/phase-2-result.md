# Phase 2 — I07 image preparation and crop controls

8 September 2026. **Reviewed I07 corrections and local checks complete;
corrected-candidate CodeQL passed; coordinator review/CI/native/visual gates
remain open.** The native Mac PNG cause remains unknown; see the
[correction checkpoint](#reviewed-correction-checkpoint). This is not completion of
Phase 2, I29, I08 or I10, and not deployment or human/device acceptance.

PR [#9](https://github.com/drrowdev/stillroom-wardrobe/pull/9), branch
`copilot/drrowdevstillroom-wardrobe`. Repaired base:
`cf90288f99a6d5c791923d3bd0bf5d138b4ea72f`; initial empty-commit head:
`ccfb92c835a90dc711c5fb19519175e428cc030a`. Original executable/test/workflow head:
`f06f5a54dbc2a43f33af2f8dc22d092c9c5019db`; correction starting head:
`ef7fb5d7da7ae1a8e6e9f2dd112ecfd8bc490889`. Corrected executable/test head:
`25a268712dc9158259608f5a4f17d11d9b9ad279`. This result update changes no
executable inputs.

## Original implementation authority and context

Before edits, read the full controlling
[approval 5584049483](https://github.com/drrowdev/stillroom-wardrobe/pull/8#issuecomment-5584049483)
and its identical public
[PR #9 mirror 5584111022](https://github.com/drrowdev/stillroom-wardrobe/pull/9#issuecomment-5584111022).
Both API bodies have UTF-8 SHA-256
`80e8e34d204d06777a7198ccb4f6beabfe5028e6f21ba32b6693eb9364815843`.
After gathering context, reread the full mirror and this session's
[native receipt 5584111413](https://github.com/drrowdev/stillroom-wardrobe/pull/9#issuecomment-5584111413).
It records coordinator selection and authenticated platform verification of
`sweagent-capi:gpt-6-astra`, task `a7da2501-9173-4f7d-ae9e-a400789a2837`,
session `a076c501-f29c-4bb2-813e-7973eed71975`, observed
`2026-09-08T11:01:17.2573080Z`, against this PR/branch/base/initial head.
This is the matching public coordinator receipt, not worker self-attestation,
an old receipt, or the closed configuration operator exception.

The approval records actual read-only **Anthropic / Claude Opus 5** reviewer
`f7473508-b24a-4654-8b00-b517ba974267`, `i07-image-plan-critique`, completed
turns 0/1. Incorporated corrections cover live catalog ownership, bounded
whole-container admission, unchanged JPEG behavior, native fixture generation,
deletion-only EXIF normalization/composition, Save interlocks and exact artifact
bounds. Its second turn superseded the earlier restrictive orientation-rejection
proposal. No new agent, planning round, material scope amendment or model fallback
was introduced.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/cloud-development.md`, `docs/phase-0-result.md` and
`docs/phase-1-result.md` relevant history, `docs/local-backend.md`;
blueprint 00/03/05/10/13/14/19, relevant image/API/schema/I07/AI-contract
sections of 07/08/15/20; actual migration and generated item/image types;
`src/images/jpeg.ts`, `process-jpeg.ts`, `upload.ts`, AddItem, owner session/app
lifecycle, i18n and styles; existing JPEG helpers, image-processing/Slice/profile
tests and browser mock; local/hosted guards, quality-gate fixture tests, package
scripts, Playwright config and both affected workflows. Public PR #8/#9 comments,
PR #9 diff/reviews/threads, prerequisite PR #7/#8 final reviews, recent MCP
workflow runs and the repaired-main failed-job query were consulted.

The initial head directly parented repaired main with zero changed files.
I06 review `5138563467`, configuration review `5140715926`, and successful
repaired-main CI `34217438176` are prerequisite evidence, not I07 validation.
The historical fixture retry was not reused as a waiver.

## Implemented scope

**R04/R17/R24**, preserving **R01/R11/R19/R23/R26/R27**:

* Signature-driven JPEG/PNG/WebP input, 20 MiB/40 MP source limits, bounded
  Blob-slice container walks, 1 MiB read budget, 4096 PNG/64 WebP chunk bounds,
  structural/animation/duplicate checks and native dimension verification.
* Isolated new-format TIFF orientation reader. PNG non-identity normalization
  removes only eXIf; WebP removes EXIF plus pad, patches RIFF length and clears
  only the EXIF flag. Identity retains source bytes. Retained-byte tests cover
  colour, alpha-bearing container data, text/XMP and unknown chunks.
  No XMP-orientation support is claimed.
* Pure EXIF/quarter-turn/crop geometry, inverse mapping and integer edge bounds;
  direct bounded canvas output without a full-resolution staging canvas.
  Native JPEG EXIF is never applied twice. One encode/verify/hash core retains
  existing main/thumbnail budgets, warm neutral background and sanitization.
  Default JPEG bytes/hashes, five-argument draw shape, encode order and absence
  of transforms are independently checked against `prepareJpeg`.
* Automatic full-photo preparation remains the default. Optional inline editing
  provides numeric framing, keyboard nudges, aspect choices, left/right rotation,
  fit/reset/apply/cancel, native Intl presentation and EN/FI/SV labels.
  Crop controls work at 320px/200% text with 44px controls and axe checks.
* Original and bounded full preview remain capture-owner memory only.
  Replacement cancels stale work; native decode/encode lifetimes drain before
  the next source starts. Bounded signature reads remain promptly abortable.
  Apply always prepares from the original, not a previous crop.
  Cancel retains the accepted photo; unapplied/invalid/pending edits visibly
  block Save. Apply/cancel restore focus. Text/language drafts survive editing.
* Only accepted `PreparedPhoto` enters the unchanged immutable Save attempt.
  Frozen retries keep UUIDs/hashes and block editing; logout/owner changes,
  navigation/unmount and successful Save release capture state.
  No upload, RPC, Auth, data, route or persisted replacement implementation changed.
* The minimal enhancement adapter returns unavailable with zero network.
  No provider UI, inference, codec, dependency, schema or hosted operation.

Seventeen executable/test/workflow paths changed, plus this result: **18 of the
21 allowed paths**. The three repaired generic guides remain unchanged. Frozen
JPEG parser/helpers, existing browser tests/mock, upload/data/Auth/app/profile,
schema/types, packages/lock, local tools, Vite config, gitignore and dated result
files were verified unchanged against repaired main.

## Original implementation local validation

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Units/static builds completed before Vite-backed suites. Browser runs explicitly
disabled retries. Prepared dependencies/local fixtures were reused; the worker
did not reset or reprovision the backend.

| Exact command | Result |
|---|---|
| `npm run lint` | Final exit 0. |
| `npm run typecheck` | Final exit 0. |
| `npm run check:translations` | Exit 0; 402 EN/FI/SV keys, 36 source files. |
| `npm run test:unit -- tests/unit/image-headers.test.ts tests/unit/crop.test.ts` | Final targeted exit 0; 84/84. |
| `npm run test:unit` | Final exit 0; 464/464 in 12 files. |
| `npx playwright install --with-deps webkit` | Exit 0; installed the existing pinned browser/system libraries, no dependency/config change. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts --project=chromium --retries=0` | Exit 0; 20/20 unchanged JPEG cases. |
| `npm run test:browser -- tests/browser/images.spec.ts --retries=0` | Exit 0; 33/33 across all configured projects before the final signature-read correction; also covered by the final full run. |
| `npm run test:browser -- tests/browser/slice.spec.ts tests/browser/images.spec.ts --grep 'late selection\|serializes full-source\|held preparation\|structural inputs' --retries=0` | Exit 0; 12/12 after the signature-read correction. |
| `npm run test:browser -- --retries=0` | Final exit 0; **314/314**, no retries or skips. |
| `npm run test:a11y -- --retries=0` | Final exit 0; **27/27**, no retries or skips. |
| `npm run db:start` | Exit 0; prepared disposable local stack healthy. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Final exit 0; both real ordinary owners' existing integration contracts and real recovery UI **1/1**; fixture restoration verified. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Final exit 0; 12 stages, normal A/B/anonymous access and liveness checks, no service credentials. |
| `npm run db:types -- --check` | Final exit 0; committed types equal actual local generation. |
| `npm run build` | Final exit 0; JS 163.68 kB gzip, CSS 4.97 kB gzip. Existing non-failing >500 kB chunk warning remains. |
| `npm run scan:secrets` | Executable-head exit 0; 154 text files and canary checked. Changed-file scans also passed before commits. |
| `npm run check:dependencies` | Exit 0; 12 production/220 development packages, zero unverified dates and zero reported production advisories. |
| `git diff --check` | Exit 0. |

The final full run includes all eight PNG/WebP EXIF orientations in both decoder
paths, independent asymmetric corner probes, composed crop/rotation, alpha,
default JPEG equality, exact accepted-photo Save/retry, source rejection,
late replacement/logout, localization and accessibility. Browser mock/wire
contracts are not live backend or hosted tests; real local suites are separately
identified above.

### Failures and corrections retained

Initial typechecks caught new return narrowing, an unused import, fixture syntax/
typed-array errors and browser-spy/message-key bindings; these were corrected
before successful checks. The first new Chromium run was 6/8: a nudged crop
correctly rounds outward to 61 pixels, not the test's assumed 60; the unchanged
router retains the capture route on owner switch rather than returning to the
empty wardrobe. Only the new assertions were corrected.

The first all-project I07 run was 23/24: Linux WebKit exposed enlarged-text
horizontal overflow. Text-only DOM bounds identified the photo panel's intrinsic
minimum width; scoped shrink/wrap CSS fixed it without hiding overflow.

The first full run at `a61229c33b01b586ac41eedf632f005d06d317bf` was
**311/314**. The unchanged late-selection case failed in all three engines:
the new two-byte signature read waited for a held cancelled read. The correction
uses the existing abortable helper inside source-stage error handling. Native
resource serialization remains intact. The unchanged case and new lifecycle
checks then passed, followed by the final full 314/314. No old tests, concurrency,
timeouts or retries were weakened; no blind rerun or baseline waiver was used.

Automated validation at `a61229c` reported **zero CodeQL JavaScript/Actions
alerts**. At final executable head `f06f5a5`, revalidation **timed out**, so there
is no final-head CodeQL pass. Both calls reported the code-review executable
unavailable despite their wrapper's success heading: **not a code-review pass**.
The timed-out validator was not blindly retried.

## Original implementation evidence and remaining gates (historical)

Existing I06 captures/upload remain unchanged. I07 adds only:

* `test-results/i07-visual/crop-en-desktop.png` — English, 1280px.
* `test-results/i07-visual/crop-fi-mobile.png` — Finnish, 320px.

The full browser run passed exact-file-count, regular-file, PNG-header/width and
1 MiB-per-file assertions. The flow verifies protected loopback capture, known
fabricated owner/photo/form values, no login/password controls, and a boolean-only
credential-pattern scan of visible text and form values. Functional/axe checks
run in every project; only Chromium writes captures and ignores returned buffers.
No worker image/binary/archive viewing or encoded image output occurred.
The later standalone a11y run uses the same disposable Playwright output directory;
local files are not claimed as retained CI artifacts or visually approved evidence.

After successful full App browser execution, CI uploads exactly those two files
as `i07-capture-ui-<exact PR head SHA>` (current commit on non-PR events), using
the existing pinned upload action, one-day retention and missing-file failure.
I06 plus I07 is bounded to at most 4 MiB/run, not guaranteed free storage.
Workers=2, fullyParallel, existing App/Database commands, native Mac runner/
15-minute budget and original four-case command are unchanged. Mac adds only
the existing Chromium install and the approved anchored three-title invocation.

| Pending gate | Responsible action / exit |
|---|---|
| Final-head security validation | Coordinator obtains completed required security analysis; the timeout and predecessor zero-alert result do not waive this gate. |
| Independent code review | Coordinator obtains actual independent Claude impact review; unavailable automated tooling is not a substitute. |
| Exact-head CI and native Apple | Coordinator reviews executable/workflow trust before authorizing current-head CI; all required App, real-local and native jobs must pass. Linux WebKit is not native Mac evidence. |
| Actual visual acceptance | Coordinator verifies exact run/head/artifact names/files, actually views both approved pairs, records hashes/verdict on PR #9, and cleans named scratch files. Artifact existence/DOM alone is insufficient. |
| Hosted/human acceptance | Still open. Only the second hosted-account test is user-deferred; other operator, actual-phone, native-language and screen-reader checks are not waived. |

Phase 0 remains engineering complete, acceptance open. No extra agent/branch/PR,
Actions authorization/rerun, merge, deployment, paid activation, hosted/private
input or later packet was performed. No native image-download failure recurred.

## Reviewed correction checkpoint

The ordinary R1–R4 correction follows the full
[approval 5585335336](https://github.com/drrowdev/stillroom-wardrobe/pull/9#issuecomment-5585335336)
and original full plan `5584111022`, not a new phase or operator exception.
Approval records actual independent **Anthropic / Claude Opus 5** reviewer
`449c548d-d84c-470a-b5c4-3072b0bf0bbb`: one reproduced generated-percentage defect,
no other confirmed runtime bug in its reviewed scope. Parent
[review 5141457289](https://github.com/drrowdev/stillroom-wardrobe/pull/9#pullrequestreview-5141457289)
records actual four-PNG inspection and narrow crop polish requirements.
It also records prior-head CI `34221659967` passing App/real-local gates, and
native `34221659968` passing old JPEG4/new WebP1 but failing PNG orientation
and composition2 with `invalid`. These are historical results, not current-head passes.

After context and before edits, reread this correction and the matching public
[receipt 5585387167](https://github.com/drrowdev/stillroom-wardrobe/pull/9#issuecomment-5585387167).
It records coordinator-requested `gpt-6-astra`, authenticated platform confirmation
of actual `sweagent-capi:gpt-6-astra`, task `32f82761-c0ae-42fa-9ca3-6a14345e4904`,
session `19561f2a-8fdf-4415-8ed0-b5b97c131b4b`, observed
`2026-09-08T12:48:57.8571017Z`, on this PR/branch and exact base/starting head.
The preceding session's receipt was not reused. No new agent or material scope
amendment was introduced.

Context actually read includes root/Copilot instructions, full cloud guide,
Phase 0/1 evidence excerpts and full Phase 2 report, local-backend evidence;
blueprint 00/03/05/10/14, relevant image/schema/command/I07/localization/AI sections
of 07/08/13/15/19/20; actual item/image migration and generated type excerpts;
crop/editor/AddItem/validation/preparation source, preparation compatibility diff,
catalog merge/rotation translations, capture CSS, complete I07 units/helper/browser
tests, quality-fixture/local/hosted guards, package commands and Playwright config.
PR discussion/approvals/receipt/reviews/threads/diff, current base/head, recent
MCP workflow runs and failed native job `102049829916` logs were consulted.

### Changes and bounded native observations

* R1: shared strict decimal parser plus paired integer-grid generated formatting,
  at `1e-12` fractional precision (ten percentage decimals). Positive dimensions
  retain at least one grid tick, finer than a pixel even at the 40 MP source bound.
  Pairing prevents rounding positions and sizes into an invalid sum. No exponent
  input, fake validity or forced full-frame replacement. Original ratio remains
  the unrotated width/height ratio after rotation. Units cover both axes, boundary
  fractions, tiny positives, tolerated geometry and invalid/cleared input; UI
  covers 3200x1214 → 1600x607 and 1600x530, nudges and Apply without reset/retyping.
* R2: generated PNG fixtures replace encoder eXIf with one intended TIFF block
  before IEND (or after IHDR for the existing alternate fixture position);
  all other chunks stay byte-identical. Generated WebP fixtures likewise replace
  existing EXIF. Raw validation and preparation happen before fixture injection,
  so a raw production failure cannot be hidden by fixture replacement.
  In-page failure records expose only fixed format/path/orientation/phase/code/stage
  and bounded PNG structure fields; the outer test throws on every failure record.
  No original exception text, metadata payload, image bytes or URLs reach logs.
  Positive contiguous multi-IDAT admission/exact normalization and pre-existing
  encoder-Exif replacement units were added; interleaved/duplicate/malformed
  production rejection remains unchanged.
* R3: only the editing preview is shown while open; the accepted photo/data/URL
  survive Cancel unchanged. The redundant Edit trigger is hidden, with focus
  restored after Apply/Cancel. Fields use a two-column grid, one column when
  narrow, with spacing before actions; clockwise text uses existing EN/FI/SV
  `photo.rotateRight`. Existing shrink/wrap rules also match the open editor.

Full-run Linux observations: PNG 120x80, depth 8, colour type 6, raw eXIf count
**0** in all engines; contiguous IDAT count **2** in Chromium/mobile and **1**
in Linux WebKit. Injected eXIf count **1**, with IDAT counts unchanged;
bounded-structure, CRC and unique-header/end flags true. Raw pixels/preparation,
all eight injected orientations in both decode paths, and composition passed.
These observations do **not** establish why native Mac failed. Encoder eXIf
duplication remains a hypothesis, not an observed cause. The old helper inserted
before terminal IEND, not after the first IDAT; the old test validated only the
injected source, not a separate raw baseline. Multi-IDAT coverage is not a
root-cause claim. Production admission/normalization/JPEG code was not changed.

### Correction validation

All commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Final executable candidate is `25a268712dc9158259608f5a4f17d11d9b9ad279`.
Units/static processes finished before Vite browser suites; no retry, timeout,
concurrency or existing-test relaxation. Prepared local fixtures were reused
without worker reset/reprovision. All final rows below exited 0.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/crop.test.ts` | Targeted 41/41. |
| `npm run test:unit -- tests/unit/image-headers.test.ts tests/unit/crop.test.ts` | Targeted 93/93. |
| `npm run test:browser -- tests/browser/images.spec.ts --grep 'Original ratio\|cancel, reset\|crop accessibility\|synthetic crop visual' --project=chromium --retries=0` | Targeted 5/5. |
| `npx playwright install --with-deps webkit` | Installed existing pinned browser/system libraries; no dependency/config change. |
| `npm run test:browser -- tests/browser/images.spec.ts --grep 'crop accessibility\|synthetic crop visual' --retries=0` | Targeted final layout checks 6/6, all projects. |
| `npm run lint` / `npm run typecheck` / `npm run check:translations` | Final pass; 402 EN/FI/SV keys, 36 source files. |
| `npm run test:unit` | Final 473/473, 12 files. |
| `npm run test:browser -- --retries=0` | Final 320/320 in 3.5 minutes, no retries/skips; includes all 39 focused I07 cases and unchanged suites. |
| `npm run test:a11y -- --retries=0` | Final 27/27, no retries/skips. |
| `npm run db:start` | Prepared disposable stack healthy; no reset performed. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Normal-owner contracts and recovery UI 1/1; fixture restoration verified. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | All 12 real-local normal A/B/anonymous stages passed. |
| `npm run db:types -- --check` | Actual local generation matches committed types. |
| `npm run build` | JS 163.75 kB gzip, CSS 4.97 kB gzip; existing non-failing >500 kB chunk warning retained. |
| `npm run scan:secrets` | 155 text files and canary checked; changed-file scans also clear before commits. |
| `npm run check:dependencies` | 12 production/220 development, zero unverified dates; completed production audit reported zero alerts at every severity. |
| `git diff --check` | Pass; frozen-file comparison against correction starting head also passed. |

Retained correction failures: first static checks caught a diagnostic variable
inferred as null and lint's caught-error requirement. Explicit typed failure
records fixed both without exposing raw causes. Initial full focused browser
command (`npm run test:browser -- tests/browser/images.spec.ts --retries=0`)
passed 26 Chromium/mobile cases; 13 WebKit cases failed before execution because
the pinned browser was absent. After installation, the focused
`--project=webkit-photo --retries=0` run passed 12/13; enlarged-text overflow
occurred because hiding `#edit-photo` disabled the existing `:has(#edit-photo)`
shrink/wrap CSS. Extending those same selectors to `.crop-editor` fixed it.
The targeted six cases and final complete suites then passed. These failures
were not skipped or claimed as native Mac results.

R4: after all other checks completed and code was committed, invoked the existing
`parallel_validation` **once** on the final candidate. Its actual schema has no
CodeQL-only selector. CodeQL completed **Actions and JavaScript, zero alerts**.
Wall-clock observation bracket: `2026-09-08T13:07:14Z` to
`2026-09-08T13:08:34Z` (80 seconds including call/observation overhead); the tool
provided no internal duration. This was not a timeout or a predecessor result.
The automated review executable `autofind` was still unavailable: the wrapper's
“Success / no comments” is **not a code-review pass**. No repeat call, new
package/tool/workflow, permission or identity change.

### Coordinator handoff and exact remaining question

This is one frozen useful correction checkpoint, not an unchanged native rerun.
Coordinator owns executable/workflow trust review and exact-head CI authorization,
the preserved native old4/new3 selection, actual independent affected-code
rereview, and actual review of all four approved current-head PNGs with
run/head/hashes/verdict. Capture bounds/privacy guards remain unchanged;
worker functional checks are not visual acceptance. No worker viewed an image
or archive. Later a11y/recovery runs reuse disposable test output, so local
captures are not claimed as retained final CI artifacts.

**Native question:** does raw Apple-canvas PNG pass admission and preparation
in both decoder paths, and then do the single-intended-Exif fixtures pass
orientation/composition? If not, use the fixed failure phase/code/stage and
raw/injected counts/structure flags to distinguish raw-source admission,
decode/output, fixture injection or composed preparation. A failure still fails
the job; obtain evidence before proposing any production parser correction.
The Linux results cannot settle that question.

Only eight executable/test files plus this report changed for the correction,
all within the original 21 paths. Generic guides, all workflows/runner budgets,
production image parser/encoder, frozen JPEG helpers/tests/mock, upload/data/Auth/
session/router/profile, schema/types, packages/lock and local tooling remain
unchanged. Current-head CI/native/independent rereview/actual visual gates remain
open; CodeQL is complete for the corrected executable candidate. No merge,
deployment, hosted/private-input operation, additional agent/branch/PR or later
packet was performed. Phase 0/human/device acceptance remains open as above.

## Rollback

Revert the I07 source/tests/workflow additions through a separately authorized
reviewed change to repaired base `cf90288f99a6d5c791923d3bd0bf5d138b4ea72f`,
preserving generic handoff instructions and historical evidence. No database
migration, hosted history replay, fixture reset or account repair is needed.
Previously saved sanitized JPEGs and immutable Save records remain compatible.

## I29a partial checkpoint — local environment blocked

8 September 2026. **Incomplete implementation; not ready for review acceptance,
CI authorization or merge.** I29 / R18 R19 R23 R26 R27 R28, on PR #10,
`copilot/i29a-saved-item-facts`, from approved main
`04b71e1e21e25119ccf5486d618cda8f0a10760b`; starting head
`31a62c3d8d346d2da5d904a8930959211ae99df8`. The initial head's sole parent
is that base and both trees are `127398771c174280dd814b1359ad0d7d1c4321ca`.
I07's later merged engineering evidence supersedes its dated pending status
above; none of that evidence validates this I29a checkpoint.

After context and before source edits, read the full
[plan mirror 5587190952](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5587190952)
and matching [native receipt 5587191372](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5587191372).
The mirror's UTF-8 SHA256 is
`8d6c4af6d6468d47186f7bb4322babec78d877da54e9543ed32a71701c33916a`.
The coordinator verified actual `sweagent-capi:gpt-6-astra`, task
`70e5fb6d-37f0-4b25-b71d-da6737b44e5c`, session
`30e817ad-850f-47f9-aafe-59d139505881`, at
`2026-09-08T14:58:37.1696224Z`, for this PR/branch/base/head.
The plan records actual Anthropic Claude Opus 5 reviewer
`bc532454-fce2-4417-8b53-d69c1f44cc46`, turns 0–2: narrowed foundation,
literal manual-intent transitions and explicit intermediate export/clear
boundaries, with coordinator approval and final no-blocker verdict.
No historical receipt or worker self-attestation substituted for this gate.

Context actually consulted: root/Copilot instructions; full cloud guide and
Phase 2 report; Phase 0 current/ordered-handoff and recovery evidence; local
backend guide; blueprint 00/03/05/10/13/14/20/21, relevant 07/08/15/19 sections;
actual initial migration item/trigger/RLS/export definitions and generated item
types; wardrobe domain, error mapping and upload source; domain, integration,
security and image browser tests and existing mutable mock; local/hosted
guards, quality-gate fixture tests, Playwright configuration, package commands
and Phase 1 sequential-test evidence. PR #10 discussion/diff/reviews/threads,
recent workflow runs and setup job metadata were read. Initial PR CI run
`34241654414` was `action_required`, with no jobs/failure logs. Running setup
job `102113069276` reported successful preparation steps, but its log download
returned HTTP 404. This is not a CAPI model-input failure or a CI pass.

### Partial source and actual commands

Five approved paths change at this checkpoint:

* `supabase/migrations/20260906000000_item_field_provenance.sql`: proposed
  nullable facts, bounded private provenance trigger and raw export version 2.
  No backfill or existing-row data statements. **Not successfully applied.**
* `src/domain/attribute-provenance.ts`: finite codes, read parser, missing-entry
  unknown/0 semantics, explicit manual insert map and semantic comparison.
* `src/images/upload.ts`: title/category user/1 insert map and bounded duplicate
  comparison only; image protocol and frozen attempt remain unchanged.
* `tests/unit/domain.test.ts`: focused domain/source-consistency tests.
* This appended result. No actual regenerated types or new integration,
  security or browser tests have been completed yet.

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`:

| Exact command | Actual result |
|---|---|
| `npm run db:start` | Exit 0; prepared local stack reported healthy. |
| `npm run test:unit -- tests/unit/domain.test.ts` | Exit 0; 11/11, including five new I29a tests. Not database or Save-path proof. |
| `npm run lint` | Exit 0 on partial source. |
| `npm run db:reset` | Exit 1; local reset failed, no fixture provisioning ran. Raw CLI output withheld by existing wrapper. |
| `npm run db:types` | Exit 2; `missing-images-output`, generator exit 0, stdout 4827 bytes, stderr 22 bytes. Existing types preserved. |
| `npm exec -- supabase db reset --local --no-seed --yes` | One diagnostic invocation, exit 1; only lines matching `^ERROR:` were selected for output, none matched. No further reset loop. |
| `npm run typecheck` | Standalone invocation exit 2; two errors in `upload.ts` because preserved base types lack `field_provenance`. Not build-ready. |
| `git diff --check` | Exit 0 including the appended report. |

The chained typecheck commands did **not** run after reset/generation failures;
the subsequent standalone invocation failed as recorded above.
Existing database log inspection found
`FATAL: role "postgres" does not exist`. This does not establish the reset's
cause or implicate the new migration. No account repair, role repair, harness
change, alternate runner, configuration change or handwritten schema types
were used. The coordinator was notified on the receipt thread. Local database
recovery requires coordinator guidance before further implementation/testing.

The remaining required full/static/browser/a11y/build/translation/dependency
and real integration/security gates have not run for this partial candidate.
Native final validation and changed-file secret scanning outcomes belong in the
public checkpoint report; absent or unavailable checks are not passes.

After committing the partial source and finishing other candidate processes,
the existing native `parallel_validation` ran **once**. JavaScript CodeQL
completed with **zero alerts**; no Actions or SQL analysis result was reported.
Automated code review was **unavailable** because `autofind` was missing;
the wrapper's success heading is not a review pass. Changed-file native secret
scans reported no secrets before commits. These limited results do not close
the failed typecheck, unexecuted database migration, unfinished tests or actual
independent-review gates. No validation retry or new checker was introduced.

### Contract limits and next gates

Per-field revisions do not replace expected row-version predicates. Identical
PATCH repetition without a row-version predicate is not detectable as new
intent. The existing touch trigger, grants, RLS and image operations are
unchanged. The initial SQL hash remains
`4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5`.

The proposed raw export-v2 snapshot still includes pending/imageless rows and
is **not** a complete saved-only backup. A durable saved-only boundary and
every-field clearing, including seasons/colours, must finish with later I29
consumers **before I29 closes or backups activate**, not as a Phase 6 waiver.
No naive ready-image filter is added. Historical upgrade/preservation has no
approved automated runner in this packet; no-backfill review and future
post-migration legacy-shaped fixtures cannot establish that proof. Actual
operator-approved upgrade evidence remains required before any hosted migration.

Remaining I29 includes bounded owned receipts, consent/cost reservations/finite
allowances, provider eligibility/setup/evaluation, checked current-photo Save,
same-item source binding and retained provenance history, owner/version-only
description editing, all-field draft/saved editing/clearing, saved-only exports,
stale-result/timeout/manual fallback and expiry/discard behavior, with no
inference on Save/restore. This foundation completes none of those consumers.

Coordinator retains exact-head CI/Apple authorization, independent actual Claude
affected-impact review, actual review of the existing four bounded synthetic
artifacts and any ordinary SHA-guarded merge. No worker image/archive/binary
viewing, extra agent, dependency, Actions approval/rerun, merge, deployment,
hosted access or paid/provider/private-photo operation occurred. Phase 0 remains
engineering complete with manual acceptance open; only the second hosted-account
journey was user-deferred.

Local-only rollback: discard/revert these partial source additions through the
coordinator's reviewed continuation. The failed disposable reset is not a
recoverable production migration or proof of data preservation; obtain guidance
before another local recovery attempt. Never apply this rollback, replay the
base migration or repair migration history on hosted.

## I29a completion attempt — reset failure recurred

8 September 2026. **Still incomplete and blocked, not a merge candidate.**
I29 / R18 R19 R23 R26 R27 R28 only. This continuation started at
`fa127b6ab606c3ee5d9a439228b167526f1071be`, base
`04b71e1e21e25119ccf5486d618cda8f0a10760b`, on the same PR #10 and
`copilot/i29a-saved-item-facts` branch. No new packet or planning round.

Read the complete [approved nine-path plan 5587190952](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5587190952)
and [completion direction 5588042786](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5588042786).
Their actual Anthropic Claude Opus 5 critic
`bc532454-fce2-4417-8b53-d69c1f44cc46`, turns 0–2, remains the approved planning
review, not a completed code review. After context and before edits/commits,
reread the new [receipt 5588067930](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5588067930):
coordinator-selected and authenticated-GET-verified
`sweagent-capi:gpt-6-astra`, task `1828fc25-fabb-4685-b991-14568ecf4dca`,
session `cbb85e40-e6bb-493d-890d-f0a34533dca0`, checked
`2026-09-08T15:58:57.8167936Z`, matching repository/PR node/branch/base/starting
head. The predecessor's receipt was not reused.

Context read: root `AGENTS.md`, `.github/copilot-instructions.md`; relevant
cloud, Phase 0/1/2 and local-backend evidence; blueprint 00/03/05/10/14/20/21
and relevant 07/08/13/15/19 contracts; actual initial and I29a migrations,
generated item types, wardrobe/provenance/error/upload modules, domain tests,
normal integration/security tests, image browser tests and mutable mock;
local and hosted guards, quality-gate fixture tests, Playwright configuration,
package commands and existing setup workflow. PR #10 body/comments/diff/reviews/
threads and MCP workflow/job evidence were inspected. No instruction, harness,
workflow, dependency, image-processing or old browser test file was changed.

### Three distinct environment observations

1. The predecessor's failed reset/type generation/typecheck above remain
   unchanged evidence. Its missing-`postgres`-role cause is still unknown.
2. Fresh CI `34244525058`, attempt 2 at `fa127b6`, is a separate comparison.
   Coordinator direction records successful start/reset/provision, existing
   integration/security/recovery (1 passed), and actual types in Database job
   `102127670620`; it failed types parity only. MCP logs confirmed that parity
   diff and App job `102127671021`'s TS2322/TS2339 failure after successful lint.
   Later App checks were skipped, not passes. No Apple execution was authorized
   for that comparison, and no artifact was downloaded here.
3. This session's setup job `102135394547`, run `34248151824`, at `fa127b6`
   reports successful start, reset/provision (16:00:37–16:01:04 UTC), and type
   generation (16:01:05–16:01:16 UTC). Its running-job log download returned
   HTTP 404; step metadata is available. This is not a CAPI model-input refusal.
   The working tree already contained generated types. Local health, actual
   generation parity and typecheck then passed; only those verified types were
   committed as `febc57ae2d591a38cb468c7b4921800d2b079e41`.

The subsequent **single** guarded reset was justified by an in-scope SQL
correction: integral JSON numbers such as `1.0` pass validation, but the old
text-to-integer casts cannot reuse them. The two casts now use JSONB numeric
conversion; new ordinary-owner cases exercise insert/confirmation/unchanged
updates with integral decimal representations. This correction has **not**
passed live database validation.

`npm run db:reset` failed before provisioning. Its chained generation,
integration and security commands did not execute. No second reset, direct CLI
retry, provisioning/role/account repair, permission change, harness change or
alternate runner was attempted. Bounded read-only diagnostics reported:
database container running/health healthy; a ready message in its last 40 log
lines; missing-`postgres`-role message **not observed in that bounded window**.
Raw logs were withheld. Neither health nor absence in that window proves valid
fixtures or explains the reset failure. The worker stopped implementation under
the completion direction's recurrent-environment-failure gate.

### Partial changes and actual validation

Beyond actual types, the checkpoint narrows provenance comparison to catch only
its own static validation error (unexpected exceptions propagate), adds literal
source-contract/error-propagation units, corrects the two numeric casts, and
adds **unexecuted** normal-owner integration/security cases. These cover nullable
facts and post-migration legacy-shaped rows, all 24 manual fields, confirmation/
clearing/invalidation, row CAS, finite codes, invalid/AI maps, atomic rollback,
foreign/anonymous denials and the intermediate owner-only v2 snapshot.
They are source additions, **not passing live evidence**.

All commands below ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`:

| Exact command | Actual result |
|---|---|
| `npm run db:start` | Exit 0; prepared stack health check, before SQL correction. |
| `npm run db:types -- --check` | Exit 0; actual local generation matched setup-generated working types, before SQL correction. |
| `npm run typecheck` | Exit 0 with actual types; also passed after the checkpoint correction. |
| `npm run test:unit -- tests/unit/domain.test.ts` | 13/13, exit 0, before and after the checkpoint correction. Not live SQL proof. |
| `npm run lint` | Initial exit 1: new integration function accidentally nested/undefined at its call site. Placement corrected without changing existing I06 behavior; subsequent exit 0. |
| `npm run db:reset` | Exit 1; reset failed, no provisioning. One invocation only. |
| `npm run db:types` | Not run after reset failure; successful setup generation remains distinct. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Not run: reset failure halted the command chain. New cases and recovery remain unverified on this checkpoint. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Not run for the same reason. |
| `git diff --check` | Exit 0 after correcting the test placement. |

No I29a browser tests were appended before the stop gate. Required actual Save/
retry tests, full unit/translation/browser/a11y/build/secrets/dependency commands,
post-correction live integration/security/recovery and final type parity remain
open. Maximum-revision overflow branches have literal source assertions only,
not a live fixture advanced through 2,147,483,647 revisions. A post-migration
legacy-shaped fixture is not a historical upgrade/preservation test.

The final native checker and changed-file secret scan results are reported
separately on this partial checkpoint; a partial CodeQL result cannot close
these unfinished gates or establish SQL correctness. Coordinator retains
independent actual Claude affected review, exact-head CI/native/actual four-PNG
review and merge authority. The worker opens no images/archives, creates no
agent/branch/PR, authorizes no Actions, and performs no hosted/provider/paid/
private-photo/deployment operations.

All earlier I07 and failure evidence is preserved. Full field clearing (including
seasons/colours) and a durable saved-only export boundary remain mandatory later
I29 consumer gates **before I29 closes**, not a Phase 6 waiver. The raw v2
snapshot still includes pending/imageless rows. No full I29/Phase 2, hosted,
physical-device or acceptance completion is claimed.

Local-only rollback: the coordinator may review reverting this continuation's
source/test changes to `fa127b6` while preserving the historical failure report.
Generated types reflect the earlier successful local setup, not successful
application of the corrected migration. Obtain coordinator environment guidance
before another recovery attempt; never apply local rollback/reset/history repair
to hosted services.

After all checkpoint processes finished and executable changes were committed,
the existing native `parallel_validation` was invoked **once**. Actual result:
**JavaScript CodeQL, zero alerts**; no SQL or Actions analysis was reported.
Automated code review was **unavailable** (`autofind` absent); the wrapper's
success/no-comments heading is not a review pass. There was no retry, alternate
checker or permission/tool change. Native changed-file secret scans passed
before the generated-types and partial-source commits. These results describe
this incomplete checkpoint only, not final I29a security or feature acceptance.

## I29a DB-independent completion — fresh CI database gate pending

8 September 2026. **Remaining browser regressions and DB-free checks complete;
I29a acceptance remains open.** I29 / R18 R19 R23 R26 R27 R28 only, existing
PR #10 (`PR_kwDOUP-Oyc8AAAABCsPJTg`), branch `copilot/i29a-saved-item-facts`.
Starting head `6218be54d26c22148248702bdcc395b3cbb3a127`; base
`04b71e1e21e25119ccf5486d618cda8f0a10760b`. The eight predecessor paths remain;
this continuation adds the ninth path's tests and appends this evidence only.

### Current authority and context

Read the full [nine-path plan 5587190952](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5587190952),
[controlling routing amendment 5588456115](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5588456115)
and partial report `5588249694`. The amendment supersedes the old reset/testing
sequence, not the product contract or final gates. It records actual
**Anthropic / Claude Opus 5**, reviewer `bc532454-fce2-4417-8b53-d69c1f44cc46`,
turn 3, following core turns 0–2: the normal-session wrapper has no implicit
reset; regular browser/a11y/static work is database-independent; existing fresh
CI can provide the mandatory real-DB proof. The coordinator approved that route,
with final-head Database success required before independent code acceptance.
No new architecture round, reviewer agent or scope amendment was introduced.

After context and before edits, read the full amendment and this task's own
[receipt 5588484305](https://github.com/drrowdev/stillroom-wardrobe/pull/10#issuecomment-5588484305).
The coordinator explicitly selected and authenticated-GET verified
`sweagent-capi:gpt-6-astra`, task `d416f706-019c-4504-b6ab-0e429fe071aa`,
session `dc627fb2-a508-4d88-895d-25415f2bc814`, at
`2026-09-08T16:29:29.5570097Z`, rechecking refs/identity/one-writer status at
`2026-09-08T16:30:26.2090051Z`. Repository, PR node, branch and base/starting head
match above. Neither predecessor receipt nor worker self-attestation was reused.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
cloud guide, Phase 0/2 evidence and relevant local-backend history; blueprint
00/03/05/10/13/14/20/21 and relevant 07/08/15/19 contracts; initial item/image,
touch/RLS/export SQL, I29a migration, generated item types, provenance/domain
tests, upload/error/AddItem source, new ordinary integration/security cases,
existing image browser tests/mutable mock, quality-gate fixtures, package scripts,
Playwright config, normal-session wrapper and unchanged CI/setup workflows.
PR #10 body/discussion/diff/reviews/threads and MCP workflow/job evidence were
consulted. No existing review or review thread was present.

### Preparation is not final database proof

Current native run `34251367887`, job `102146353052`, at starting head `6218be54`
reports successful locked dependency/Chromium setup, Supabase startup
(16:30:47–16:31:54 UTC), migration/reset/provision step (16:31:55–16:32:22 UTC),
and actual type generation (16:32:23–16:32:34 UTC). The running-job log download
returned HTTP 404; these are successful step metadata, not inspected command
logs or a passing owner/security suite. This is not a CAPI model-input failure.
The starting working tree was clean, including the generated types already
committed in `febc57a`; no new type output or schema change was committed.
`git diff --exit-code -- src/data/database.types.ts` returned 0.

Both earlier native warm-reset failures remain preserved above; their cause is
unknown, not declared repaired or permanently unknowable. No old-container
inspection, classifier, raw stderr/credential inspection, reset or repair was
performed. Older fresh CI `34244525058`, attempt 2 at `fa127b6`, remains a
separate successful DB-sequence comparison with an overall failed result.
MCP failure logs confirm committed-type parity failure and App TS2322/TS2339.
That older run cannot validate the corrected numeric casts or new I29 DB cases.
Starting-head CI `34249547377` was `action_required`; this worker did not
authorize or rerun it.

### Appended actual Save regressions

Only `tests/browser/images.spec.ts` and this report change in this continuation.
All existing I07/native/Slice cases, helpers, mock/WIRE, runtime source, schema,
types, workflows, configuration and dependencies remain unchanged.

Three appended cases use the existing `setup`/mutable mock and synthetic fixture:

* Explicit UI Save reaches actual `saveItem` and inserts exactly title/category
  `user` revision 1, with owner/currency and one pending image after commit failure.
  Reordering both map and entry properties then succeeds on Retry with the same
  item/image IDs, prepared-main hash, both stored hashes/sizes and byte-identical
  files. Existing duplicate POST/download checks remain; the receiver accepts
  exactly two original file uploads and no additional payload bytes.
* Separate controlled stored-kind and stored-revision mismatches return the
  existing localized conflict plus retry guidance. The draft stays visible,
  frozen and unsaved; item/image/file state and bytes remain unchanged.
  After Retry, exactly item POST and GET occur, with no subsequent image,
  Storage or commit request.

These are synthetic browser contracts, **not live SQL/RLS/owner proof**.
No production defect or schema-shaped type change was needed.

### Exact native DB-free validation

All commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Unit/static checks finished before Vite-backed browser runs; browser and a11y
ran sequentially. No timeout, worker, retry or harness setting changed.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/domain.test.ts` | 13/13, exit 0. |
| `npm run test:browser -- tests/browser/images.spec.ts --grep 'I29a manual Save' --retries=0` | Initial 0/9: six new assertions expected only the first of two existing alert paragraphs; three WebKit cases could not launch the absent pinned browser. After the corrections below, 9/9, exit 0. |
| `npx playwright install --with-deps webkit` | Exit 0, only after the missing-browser failure; restored the existing pinned browser/system libraries without repository dependency changes. |
| `npm run lint` | Final exit 0. |
| `npm run typecheck` | Final exit 0. |
| `npm run test:unit` | Final 480/480 in 12 files, exit 0. |
| `npm run check:translations` | 402 EN/FI/SV keys, 37 source files, exit 0. |
| `npm run test:browser -- --retries=0` | Final 329/329 in 3.7 minutes, exit 0; no retries/skips. |
| `npm run test:a11y -- --retries=0` | Final 27/27, exit 0; no retries/skips. |
| `npm run build` | Exit 0; JS 164.26 kB gzip, CSS 4.97 kB gzip. Existing non-failing >500 kB chunk warning retained. |
| `npm run scan:secrets` | Exit 0; 157 text files and fresh unprinted canary checked. |
| `npm run check:dependencies` | Exit 0; 12 production/220 development packages, zero unverified dates, completed production audit with zero alerts at all severities. |
| `git diff --check` | Exit 0. |

The new alert assertions now check the two exact localized paragraphs rather
than changing existing UI. Final full suites also cover tightened exact-map and
initial-commit-count assertions. No unrelated test was edited or weakened.
Build and repository secret scan shared a process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`, exported without printing.
Existing approved screenshot buffers/files stayed inside tests, ignored and
unopened. No artifact/image/archive was viewed or sent to the worker model.
The subsequent a11y run reuses disposable test output; local captures are not
claimed as retained or visually approved final CI artifacts.

### Native commands deliberately UNRUN / mandatory handoff

Outside the unchanged preparation workflow, this writer ran **none** of:
`npm run db:start`, `npm run db:reset`, `npm run db:types`,
`npm run db:types -- --check`,
`ALLOW_SECURITY_TESTS=1 npm run test:integration`, or
`ALLOW_SECURITY_TESTS=1 npm run test:security`.
These native DB gates are **UNRUN/PENDING** under the routing amendment, not
passes. No direct CLI reset/psql, provisioning, role/account/permission repair,
hosted smoke or hosted SQL occurred. There is no new recovery experiment.

After the final candidate is committed and other processes finish, the existing
native checker is invoked once; its actual result and any unavailable component
are recorded in the PR, never inferred from its wrapper heading.
The coordinator then owns exact-head/model/actor/no-writer and executable/privacy/
egress/workflow trust checks, followed by the **existing fresh CI Database job**:
startup, guarded reset/provision, new I29 ordinary-owner integration/security
cases, real recovery, actual type generation and committed parity must all pass
on the final head **before independent code acceptance**. Final App/native Apple,
actual independent Claude affected-impact review and actual review of all four
approved I06/I07 artifacts with run/head/hashes/verdict remain required.
Old CI, setup/types, mocks, skipped tests and artifact existence waive none.

Saved-only exports and every-field clearing (including colours/seasons) remain
mandatory later I29 consumer gates before I29 closes, not a Phase 6 waiver.
Raw v2 still includes pending/imageless rows. Receipt/consent/finite-budget,
checked current-photo Save, description edits, provider setup/evaluation and
other full-I29 gates above remain open. Historical upgrade preservation still
needs operator-approved evidence before any hosted migration.
No I29a acceptance/full I29/Phase 2/hosted/release completion is claimed.

Local-only rollback: a separately reviewed change can remove these appended
browser cases back to starting `6218be54` while preserving evidence and the
predecessor source/types. No database reset, hosted replay or history repair is
part of this rollback. This worker stops editing after publishing the final
head/results; no additional agent/branch/PR, Actions authorization/rerun, merge,
deployment, provider/private-photo/paid operation or later packet.

Final native validation: after the completed executable/test candidate `cd9740d`
was committed and all other processes finished, invoked existing
`parallel_validation` **once**. Actual **JavaScript CodeQL completed with zero
alerts**; no SQL or Actions analysis result was reported. Automated code review
was **unavailable** because `autofind` was missing, despite the wrapper's
success/no-comments heading. No checker retry, substitute reviewer or tool/
permission change occurred. This result is current candidate evidence, not the
predecessors' partial scans, and does not establish live SQL correctness.
Only this evidence append follows the validated executable candidate.
Native changed-file secret scanning found no secrets before the candidate commit.
Append-only verification preserved both files' complete starting contents.
