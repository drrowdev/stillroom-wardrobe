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

## PR #12 — populated-base preservation rehearsal source packet

8 September 2026. **Native unit/static checks complete; actual preservation
rehearsal UNRUN, pending authorized fresh CI.** This is the current-release
preservation prerequisite for I29a / R18 R19 R23 R26 R27 R28, retaining R01/R11
owner isolation. It is not I29b, full I29/Phase 2, B3 resolution or release approval.

### Authority and context

Existing PR #12, node `PR_kwDOUP-Oyc8AAAABCvKWmw`, branch
`copilot/modelgpt-6-astra`; base `3c84cfb07e569dab416ccd1b5d19c7c6e251010c`,
clean starting head `9b8ac6fa82aa10258f0bf1d1c44dd4eaaab5a039`.
Read the full [six-path plan 5591979149](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5591979149)
and [controlling clarification 5592284908](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592284908).
Actual read-only **Anthropic / Claude Opus 5** reviewer
`bc532454-fce2-4417-8b53-d69c1f44cc46`, turns 5–6, and coordinator approval
control this packet. The clarification permits source-derived parser units
before real CI observation; it adds no native DB authority or new architecture.

After context, before edits, read this continuation's own
[public receipt 5592308899](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592308899).
It records explicitly selected, authenticated-GET verified actual
`sweagent-capi:gpt-6-astra`, task `e2bd10ff-b531-4b32-a18d-a062b33e1375`,
session `0551f3a9-c9db-4eee-97bf-66c819936e03`, observed
`2026-09-08T21:46:05.1716489Z` and rechecked
`2026-09-08T21:46:55.8417820Z`, with matching repository/PR/branch/base/head and
one writer. The predecessor's receipt was not reused. Its fixture-provenance
question was an instruction-clarification hold, not a code/DB/CAPI/authorization
failure or an authorization workaround.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
cloud guide, Phase 0 and current Phase 2 evidence, local-backend guide;
blueprint 00/03/05/08/10/14/20 and relevant 15/I29; actual base SQL (hash-identical
to blueprint 07), target migration and generated schema excerpts; backend
local/CLI/environment helpers, db/provision/run-local wrappers, quality `isMain`,
normal integration fixture/RPC contracts, hosted guard separation, quality-gate
unit import pattern, package/CI/lint/Vite configuration. PR #12 discussion,
empty diff/reviews and MCP workflow/job evidence were read. Starting CI
`34279530027` was `action_required`, zero jobs; failed-log query found no failed
jobs, **not a passing CI run**. No Actions authorization or rerun occurred.

### Six-file implementation

Only `scripts/preservation-rehearsal.mjs`,
`tests/integration/preservation.sessions.mjs`, `tests/unit/preservation.test.ts`,
the new `package.json` `db:rehearse` entry, one step in `.github/workflows/ci.yml`
and this append change. Existing app/SQL/types/lockfile/helpers/other tests and
workflows remain unchanged.

The zero-argument orchestrator requires the literal rehearsal/CI/Actions flags,
existing no-service-secret/project/local-Docker/known-container checks and pinned
CLI 2.116.0. Mutable flags prevent accidents, not hostile-code execution.
It checks exactly two regular, non-symlink migrations before reset and again
before upgrade:

| Source version | Bytes | SHA-256 |
|---|---:|---|
| `20260905000000` | 35214 | `4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5` |
| `20260906000000` | 5923 | `4060e963bc5a986857f31bc9b528dd6d7ea8caee720336de8499d59e8f8c3f92` |

The fixed CI sequence is:

1. **S1:** pinned help checks; `db reset --local --no-seed --yes --version
   20260905000000`; `migration list --local` must show applied base and pending
   target; unchanged `scripts/provision-test-users.mjs` provisions the fictional
   owners.
2. **S2:** absolute Node child `tests/integration/preservation.sessions.mjs
   capture <runUUID>` uses exactly
   `normalSessionEnvironment(process.env, await readCredentialCache())`.
   Server-verified ordinary A/B identities, absent base provenance column and
   empty pre-seed application sets precede fixture creation. Both owners get
   implicit/explicit/imageless items, ready/retired images from the existing
   632-byte fictional JPEG, preferences/profile saves, repeated outfit/history
   saves, links, rules and feedback.
3. **S3:** repeat source/history checks; only `migration up --local`; history must
   show exactly both versions applied and none pending. No intervening reset,
   provisioning, reseeding or repair.
4. **S4:** the same normal child in `verify <runUUID>` first compares all ten
   complete table sets (30 total rows), old values, versions and full timestamp
   strings, and eight actual object downloads against stored lengths/hashes and
   before-download evidence. Only the four new item columns are excluded from
   old-value equality; they must separately be null/null/null/`{}`. Old physical
   values remain intact and unverified. Only after this complete comparison run
   bounded range, A/B/anonymous ownership and each owner's raw v2 export probes.

Closed, owner/run/project/source/stage-bound snapshots have exact old column
inventories, correct table identities, no credential/auth-response fields,
exclusive `wx`/0600 creation, regular non-symlink reads and a 512 KiB bound.
They stay ignored at the single derived run path. Finally cleans only that
run's regular snapshot; no directory/wildcard deletion or snapshot artifact.
Output is fixed stages/codes, source inventory and synthetic counts, never
rows, object paths/bytes, credentials or arbitrary error text.

The single CI opt-in step sits between existing `db:start` and `db:reset`.
The 30-minute job, runner, permissions and all later reset/integration/security/
recovery/type-generation/parity checks remain. Failures stop subsequent steps;
skipped checks are not passes.

### Source-derived format/body evidence, not execution

Parser fixtures derive from pinned CLI v2.116.0
`apps/cli-go/internal/migration/list/list.go` (`makeTable`),
`internal/utils/output.go` (`RenderTable`) and `render.go` timestamp formatting,
plus its pinned Glamour v1.0.0 ASCII/table rendering. They are **source-derived,
not observed CLI output and not preservation proof**. Unknown format/version,
duplicates, missing rows, wrong applied/pending columns and empty output fail
closed. First authorized fresh CI must validate the real table and transition;
any actual mismatch remains a failed stage, not a fallback or invented inventory.
The predecessor's [5592028965](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592028965)
records all three real read-only help checks, exit 0, required flags present:
capability evidence only, not rerun or relabelled as this session's execution.

Unit extraction retains the **untrimmed** SQL dollar-body newlines:
base 1452 bytes / MD5 `a8188b771786538ec7ef031d9d974fce`;
target 1452 bytes / MD5 `cb47b75d41751df15813773388c062cf`.
These are source-derived `export_manifest` bodies, not new hosted observations.
The SQL and transaction markers are unchanged; no server-atomicity guarantee.

### Actual native validation

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/preservation.test.ts` | Final 36/36, exit 0; includes import side-effect tripwires, source column/body parity and malformed/history/snapshot/value/byte negatives. |
| `node --check scripts/preservation-rehearsal.mjs` | Final exit 0. |
| `node --check tests/integration/preservation.sessions.mjs` | Final exit 0. |
| `npm run lint` | Final exit 0. |
| `npm run typecheck` | Final exit 0. |
| `npm run test:unit` | Final 516/516 in 13 files, exit 0. |
| `npm run check:translations` | 402 EN/FI/SV keys, 37 source files, exit 0. |
| `npm run build` | Exit 0; JS 164.26 kB gzip, CSS 4.97 kB gzip; existing non-failing >500 kB chunk warning retained. |
| `npm run scan:secrets` | Exit 0; 160 text files and fresh unprinted build canary checked before this documentation append. |
| `git diff --check` | Exit 0. |

Initial checks caught a malformed new authorization-header string, one unused
fixture assignment, strict indexed-access typing in unit fixtures, and a
test-only SQL-column regex that missed digits in SHA column names. All were
corrected before the final passing checks. No unrelated test, configuration,
dependency or compiler setting was weakened. Binary fixture bytes were handled
inside programs only, never viewed, encoded or emitted to the native model.

### UNRUN stages and retained handoff gates

This writer ran **no native** rehearsal opt-in, migration list/reset/up,
provisioning, psql, type generation, backend mutation, integration/security/
recovery/browser/a11y suite, hosted smoke or live operation. S1–S4 and actual
preservation remain **UNRUN/PENDING**, not inferred from 516 unit tests.

After candidate processes finish and changes are committed, the existing native
final validator is called once; its actual components and unavailable tools are
reported on the PR, not inferred from the wrapper heading. Coordinator owns
executable/privacy/egress/workflow trust and fresh exact-head CI authorization,
actual preservation evidence, independent Claude affected review, all existing
App/normal-owner/recovery/types/native Apple gates and actual four-PNG review
with run/head/hashes/verdict. Source tests or artifact existence waive none.

Historical B3 cause remains open despite merged observational PR #11 and clean
current observations. Full saved-only export/every-field editing and I29b stay
parked. Conditional live I29a DDL/runtime approval still requires preservation,
B3/release readiness and fresh metadata; operator-method decision `5592161566`
grants this writer no live authority. No PUT/DELETE/history repair/replay,
transaction-marker removal, privilege change, hosted probe, merge or deployment.
Phase 0 stays engineering complete, acceptance open; only the second hosted
account test was user-deferred. All earlier evidence and holds above remain.

Rollback is source-only removal of this six-file packet, preserving its dated
evidence, through coordinator review. No hosted rollback/reset/history repair is
implied. The writer publishes head/files/results and stops editing for parent
CI/independent review; no extra agent/branch/PR or next packet.

Final native validator: after executable candidate
`b81c155ff696f3fb8667809a7407076ebd4d095f` was committed and all candidate
processes finished, invoked existing `parallel_validation` **once**.
**Actions and JavaScript CodeQL completed with zero alerts.** No SQL analysis
was reported. Automated code review was **unavailable: `autofind` missing**;
the wrapper's success/no-comments heading is not a review pass. No alternate
checker, additional agent, permission change or retry occurred. The six-path
changed-file secret scan passed before that commit, and its required Copilot App
co-author trailer was verified. Only this actual validation-result append follows
the checked executable candidate; fresh CI preservation and all parent-owned
review/release gates above remain pending.

## PR #12 bounded preservation HTTP/history correction — 8 September 2026

Same PR #12 / `copilot/modelgpt-6-astra`, base
`3c84cfb07e569dab416ccd1b5d19c7c6e251010c`, clean starting head
`10927d92bd403fcc51e0cfb130e65e535b90a79e`. This is the routine four-path
correction approved in [5592756899](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592756899),
not a new packet or material planning amendment. Actual independent
**Anthropic / Claude Opus 5** reviewer `01e4035d-ee11-4b4e-bdb3-df15c4b55689`,
turn 6, identified the blocking void-response bug and medium history-stage
misreporting on that exact six-file head; the coordinator accepted both.
The full [six-file plan 5591979149](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5591979149)
and [source-derived formatter clarification 5592284908](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592284908)
were read, including their complete bodies.

Before edits, read this correction's own
[public receipt 5592775939](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592775939):
explicitly requested `gpt-6-astra`, authenticated allocation
`sweagent-capi:gpt-6-astra`, task `3febe5b2-94de-4e00-a799-fbf7b3973df0`,
session `70b69022-5ad8-4aed-895f-a3f1766f1bbb`, authenticated GET
`2026-09-08T22:31:45.2103663Z`, reverified
`2026-09-08T22:32:12.8270644Z`. The local session ID matched the receipt,
as did repository/PR/base/head/branch. No old session receipt was reused.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
cloud guide; relevant Phase 0/Phase 2/local-backend evidence; blueprint
00/03/05/10/13/14/20 and relevant 08 API, 15/I29 contracts; base SQL's
`commit_image` and target migration, generated void return type, exact base
SQL/blueprint-07 hash parity; backend local environment/request guards,
existing normal-session reader, recovery-unit fetch-stub conventions, the
preservation modules/tests, package/CI diff and secret checker. PR discussion,
diff, reviews/review threads and MCP workflow/log evidence were read.
CI `34283894600` and Apple `34283894610` remained `action_required`; the CI
failed-log query returned zero jobs, not a passing execution.

### Correction and focused regression coverage

Only `tests/integration/preservation.sessions.mjs`,
`tests/unit/preservation.test.ts`, `scripts/preservation-rehearsal.mjs` and
this appended evidence change. The existing package script and CI opt-in step
are unchanged; app/schema/types/dependencies/other helpers and suites remain
frozen.

The HTTP reader now accepts null bodies only for HTTP 204, without attempting
to read a nonexistent stream. It still refuses 5xx, missing non-204 streams,
oversized streams and malformed nonempty JSON, and cancels streamed readers.
`commit_image` explicitly requires successful 204/null. Other RPCs require
200/non-null JSON and retain their downstream version/export checks. Required
row/insert/versioned-save/auth consumers reject missing or invalid shapes;
insert responses also require the actual table identity and current owner.
Capture still verifies downloaded bytes against stored lengths/hashes, and
export probes still compare the full closed owner-bound manifest/table sets.

Eight new focused HTTP tests use restored Vitest fetch stubs and standard
`Response` objects, with no sockets or database calls. Coverage includes:
204/null success; rejected 200/null, empty/malformed required JSON and wrong
commit responses; row/insert/save/auth/export negatives and positives; the
512 KiB limit and cancellation; 5xx refusal; mismatched binary downloads and
actual fixture-byte hash comparison inside programs only. The invalid
204-with-stream case starts with a valid 200 `Response` and narrowly overrides
its status getter, so the guard—not response construction—is tested. Existing
import-side-effect tripwires and the two narrow documented JS-import
`@ts-expect-error` boundaries remain intact.

The orchestrator assigns `S1-base-history`, `S3-base-history` and
`S3-target-history` immediately before the respective history calls. A source
assertion covers all three placements. History/parser failures no longer inherit
reset/up stage labels; output stays fixed and non-sensitive. No history/parser,
snapshot, owner, source-hash, cleanup or preservation oracle was weakened.

### Actual correction-session validation

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual final result |
|---|---|
| `npm run test:unit -- tests/unit/preservation.test.ts` | 44/44 passed, exit 0; includes import-safety and stubbed HTTP boundary tests. |
| `npm run test:unit` | 524/524 passed in 13 files, exit 0. |
| `npm run lint` | Exit 0. |
| `npm run typecheck` | Exit 0. |
| `node --check scripts/preservation-rehearsal.mjs` | Exit 0. |
| `node --check tests/integration/preservation.sessions.mjs` | Exit 0. |
| `npm run check:translations` | 402 EN/FI/SV keys, 37 source files, exit 0. |
| `npm run build` | Exit 0; JS 164.26 kB gzip, CSS 4.97 kB gzip; existing non-failing >500 kB chunk warning. |
| `npm run scan:secrets` | Exit 0; 160 text files and fresh unprinted build canary checked before this append. |
| `git diff --check` | Exit 0. |
| `git diff --exit-code 10927d92bd403fcc51e0cfb130e65e535b90a79e -- package.json .github/workflows/ci.yml` | Exit 0; both frozen files unchanged. |

Build and scan shared `export STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`
without printing the value. Initial checks caught a malformed authorization-header
comparison in the new test stub (focused suite parse/lint failure), then an inferred
optional-property type mismatch in the negative manifest fixture list (typecheck
failure). Both ordinary implementation errors were corrected before the final
passing runs, with no compiler/configuration exception or unrelated test change.
Context lookup also encountered an incorrect testing-document filename and absent
shell `rg`; the actual blueprint index and provided search tool resolved those
read-only lookups. No tool installation or environment workaround occurred.

### Explicitly UNRUN and coordinator-owned gates

Real **S1–S4**, actual pinned CLI migration-list format compatibility, populated
base-to-target preservation and all live gates remain **UNRUN/PENDING**.
Source-derived parser fixtures and mocked HTTP responses are not their proof.
The three prior help probes remain historical capability evidence, not commands
rerun by this correction writer. No native migration list/reset/up, provisioning,
psql, rehearsal/opt-in, type generation, integration/security/recovery/browser/
a11y/native Apple/hosted/network test or service mutation ran here.

After the executable candidate is committed and its processes finish, invoke
the existing native final validator once and record actual components/languages
and unavailable tools separately. An unavailable automated reviewer is not a
review pass. Coordinator still owns affected independent review, exact-head
execution/privacy/egress/workflow trust and authorization of the first fresh CI
rehearsal. Normal A/B/anonymous/RLS/private-image/recovery/type-parity, App/unit/
translations/browser/a11y/build/secrets/dependencies, native four plus I07 three,
and actual four-PNG visual gates all remain required. No skipped/mock/admin
result substitutes for those gates.

B3 remains open; clean observational suites were non-reproduction, not a fix or
waiver. No I29b/next feature, live DDL/Cloudflare/account/private-photo/provider/
paid-AI operation, history repair/replay/ledger mutation, Actions approval/rerun,
agent, branch, PR, merge or deployment was authorized or performed. Conditional
approval `5590736782` and operator method `5592161566` are not live authority now.
Native model input remained text-only; fixture bytes were never opened or emitted
to the model. Historical sections above remain unchanged. Publish the final
head/files/results and stop editing for coordinator review.

Final native validator for this correction: after executable candidate
`c1045eb2b29ab0b73e00dde00018fd4a7038070b` was committed and candidate
processes finished, invoked existing `parallel_validation` **once**.
**Actions and JavaScript CodeQL completed with zero alerts**; no SQL analysis
was reported. Automated code review was **unavailable: `autofind` missing**,
not a review pass despite the wrapper heading. No alternate checker, new agent
or repeated invocation was used. Only this evidence append follows the checked
executable candidate; independent affected review and all real gates remain
pending. The changed-file secret scan passed before the candidate commit.

Commit metadata exception: the progress tool's candidate commit omitted the
requested Copilot App co-author trailer. History was not amended. This final
validation-evidence commit explicitly includes
`Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`;
that does not retroactively change the candidate commit's metadata.

## PR #12 pinned history-parser correction — 8 September 2026

Same PR #12 / `copilot/modelgpt-6-astra`, base
`3c84cfb07e569dab416ccd1b5d19c7c6e251010c`, clean starting head
`33148670ecfe8a730d171cd63b86738a298d97c5`. Scope is only the ordinary
three-path correction in [approval 5593272286](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5593272286).
Actual independent **Anthropic / Claude Opus 5** reviewer
`01e4035d-ee11-4b4e-bdb3-df15c4b55689`, turn 8, directly verified the pinned
formatter blobs, confirmed the source-contract defect and accepted this bounded
fix. The coordinator's explicit nonempty-inner-span qualification and closed
failure-reason recommendation are incorporated; no new whole-plan loop or scope
amendment. This supports I29a's preservation prerequisite (R18/R19/R23/R26/R27/R28),
not wider I29 implementation or acceptance.

After context and before edits, read complete
[own receipt 5593293205](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5593293205).
It records explicitly requested `gpt-6-astra`, authenticated actual
`sweagent-capi:gpt-6-astra`, task `28e12a66-c12c-49fb-9129-1eda9ddb434c`,
session `46718486-9e12-4d4b-8b46-fab6218f02dd`, immediate authenticated GET
`2026-09-08T23:26:01.8718499Z` and sole-writer/ref re-verification
`2026-09-08T23:26:31.0252992Z`. Local session ID matched; native run
`34290624601`, repository/PR/base/head/branch matched. No historical receipt,
prompt model name or branch label substituted for platform evidence.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
cloud guide, relevant Phase 0/Phase 2 and local-backend evidence; blueprint
00/03/05/10/13/14/20, relevant 07 schema, 08 API and 15/I29 sections; actual
base/target migrations and generated profile type excerpt; backend local guards,
environment/CLI helpers, preservation orchestrator/unit file and normal-owner
snapshot/comparison/execution excerpts; package/CI diff and secret checker.
Read full [core plan 5591979149](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5591979149),
[fixture clarification 5592284908](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5592284908),
[first CI evidence 5593195354](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5593195354)
and controlling correction; PR details/discussion, affected diff, empty reviews/
threads, MCP workflow-run metadata and failed Database job logs.

### First actual CI evidence, not a preservation pass

CI `34287248039`, attempt 2 (first actual execution after the zero-job hold),
failed at starting head `33148670`. Database job `102269284358` started the
local stack successfully and printed both approved source fingerprints.
The fixed base reset command returned 0; `S1-base-history` then failed with
`EVIDENCE_REQUIRED` and exit 1 (log timestamp `22:59:49Z`).
Exact base-applied/target-pending history was **not established**.
**S1 partially ran**; provisioning, S2 capture, S3 target migration and S4 full
comparison did not run, and no snapshot was created. Following ordinary reset,
integration/security/recovery, type generation and parity were **SKIPPED**.

Privileged CLI stdout/stderr were withheld. Pinned source proves the parser/
fixture defect, not the observed CI table shape or an exclusive failure cause.
Coordinator evidence separately records App job `102269284669` passing
524 units/329 browser cases and Apple run `34287248071` passing four original
plus three I07 cases. Neither establishes preservation or fixes B3. Artifact
metadata matched; images were not viewed and no visual pass is claimed.
The prior 204 and history-stage-label findings remain closed, not reopened.

### Bounded correction and preserved contracts

Only `scripts/preservation-rehearsal.mjs`, `tests/unit/preservation.test.ts`
and this append change. Ordinary-owner capture/verify including 204 handling,
package/CI wiring, SQL/types, application code, dependencies, helpers and all
other files remain frozen.

Read exact CLI 2.116.0 sources at commit
`997a1e69a4a83466964ed874d3a604c88a7b3866`: `list.format.ts` blob
`5d1d0d8a5ed743927b3144b8aebd5b29541b2ec5`, `legacy-glamour-table.ts` blob
`29c6778716b0776366b2fb24d8e4f9a841747fd8`, formatter unit blob
`b8dca8dbb4029e6b75f9d8a556bd792e91ce35d7`. Literal fixtures are explicitly
**SOURCE-DERIVED**, retaining blank/decorative lines, two-space renderer prefix,
quoted cells, padded widths 18/18/23 and trailing blank lines. No upstream code
was vendored or fetched at test time.

Body cells require exactly one balanced backtick pair without inner backticks.
An explicit nonempty-inner guard rejects two-backtick empty spans; only a quoted
single space maps to absent. Bare/mixed, unbalanced/doubled/inner quotes,
multispace/padded inner spans, wrong cell counts/dates, missing/duplicate/extra/
unknown/reordered versions and wrong applied/pending states fail. Both positive
tables and malformed-table negatives retain CRLF coverage. The 4096 ASCII bound,
four logical lines, bare headers, dash separator, ordered versions/time literals,
source inventories and all three history-stage adjacency assertions remain.

The same orchestrator adds 13 closed labels: `history-command`, `length-cap`,
`charset`, `line-count`, `header`, `separator`, `cell-count`, `cell-quoting`,
`cell-content`, `version-mismatch`, `remote-mismatch`, `time-mismatch`,
`inventory-mismatch`. Only its own classified error and a literal allowlist
member produce a reason suffix; arbitrary exceptions/messages and altered unknown
reasons remain generic. Units cover every label and arbitrary-text suppression.
Outer stage, `EVIDENCE_REQUIRED`, nonzero exit, command arguments/environments,
guards, S1–S4 ordering, full old-value/downloaded-byte comparison and exact-run
cleanup are unchanged. There is no raw-output diagnostic, mutable parser status,
new tool/dependency or additional CLI invocation.

### Actual native validation and handoff

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/preservation.test.ts` | 74/74 passed, exit 0; subsequent full run also covers added negative CRLF parity. |
| `npm run test:unit` | Final 554/554 in 13 files, exit 0; 74 preservation cases including retained HTTP/source/import/comparison checks. |
| `npm run lint` | Final exit 0. |
| `npm run typecheck` | Final exit 0. |
| `node --check scripts/preservation-rehearsal.mjs` | Final exit 0. |
| `node --check tests/integration/preservation.sessions.mjs` | Exit 0; frozen module. |
| `npm run check:translations` | 402 EN/FI/SV keys, 37 source files, exit 0. |
| `npm run build` | Exit 0; JS 164.26 kB gzip, CSS 4.97 kB gzip; unchanged non-failing >500 kB warning. |
| `npm run scan:secrets` | Exit 0; 160 text files and fresh unprinted build canary checked before this append. |
| `git diff --check` | Exit 0 before evidence append; repeated before commit. |
| `git diff --exit-code 33148670ecfe8a730d171cd63b86738a298d97c5 -- . ':!scripts/preservation-rehearsal.mjs' ':!tests/unit/preservation.test.ts' ':!docs/phase-2-result.md'` | Exit 0; all frozen tracked paths unchanged. |
| `sha256sum blueprint/07-DATABASE-AND-RLS.sql supabase/migrations/*.sql` | Blueprint/base match `4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5`; target remains `4060e963bc5a986857f31bc9b528dd6d7ea8caee720336de8499d59e8f8c3f92`. |

Build and secret scan shared
`export STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`, without printing it.
No implementation test/static failure occurred in this correction. After candidate
commit/process completion, the existing native final validator is invoked once;
actual components/languages, findings and unavailable tools are reported on the
PR, not inferred from a wrapper heading or recorded through a metadata-only commit.

This worker ran **no** native migration-list/reset/up/provision/psql/rehearsal/
opt-in/typegen, DB/integration/security/recovery/browser/a11y/Apple/hosted command
or service operation; no help probe was rerun. New-head real history and full
populated preservation remain **PENDING**, not proven by source-derived units.
Coordinator must inspect trust and obtain affected independent review before fresh
corrected-head CI; no unchanged `33148670` rerun. All ordinary-owner, recovery,
types/parity, App/browser/a11y, native and actual four-PNG visual gates remain.
No Actions approval/rerun, new agent/branch/PR, merge, deployment or next packet.
Text-only model inputs were retained; fixture buffers stayed program-only.
B3 remains open, and conditional approval `5590736782` / operator method
`5592161566` grant no current live/DDL/history-repair/account/private-input/
provider/paid-AI authority. Publish final head/results and stop editing for review.

## PR #12 user-approved type-generation exit bucket — 9 September 2026

Same PR #12 / `copilot/modelgpt-6-astra`, base
`3c84cfb07e569dab416ccd1b5d19c7c6e251010c`, clean starting head
`056d7b0581ffc17b8cbda7e489d3ced1d931f1ae` (six existing PR paths).
Read full [extension 5595642216](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5595642216)
and [core preservation plan 5591979149](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5591979149).
The user explicitly approved two additional existing tooling paths and one
future fresh check cycle. Actual independent **Anthropic / Claude Opus 5**
reviewer `01e4035d-ee11-4b4e-bdb3-df15c4b55689`, turn 11, rejected unpinned
Docker/postgres-meta prose classification and accepted the bounded numeric
approach. Coordinator amendments require complete canonical tokens, duplicate
rejection, source-grounded framing and neutral labels. This supports I29a's
release-safety prerequisite (R18/R19/R23/R26/R27/R28), not another feature.

After context and before edits, reread complete
[own receipt 5595656064](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5595656064):
explicitly requested `gpt-6-astra`, authenticated actual
`sweagent-capi:gpt-6-astra`, task `610dc1c9-9832-428b-b47a-3faa4108ed1a`,
session `e9b03a93-ef36-4e2d-9160-d4706973ca91`, immediate GET
`2026-09-09T04:10:21.0024405Z`, sole-writer/ref re-verification
`2026-09-09T04:10:59.3268529Z`. The local session ID matched that receipt;
native run `34309921487`, repository/PR/base/head/branch matched.
No historical receipt or prompt/branch model label substituted for allocation
evidence. No additional agent was started.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
cloud guide scope/runtime/hosted sections, relevant Phase 0/Phase 2 and
local-backend evidence; blueprint 00/03/05/10/13/14 and relevant 07/08/15/20
sections; actual base migration excerpt, full target migration and generated
type excerpt; complete local helper and backend unit file, unchanged db wrapper,
secret scanner, preservation orchestrator/unit and normal-owner module excerpts,
and package/CI diff. PR details/discussion, empty reviews/threads and MCP
workflow metadata/Database logs were read, including full fixture clarification
5592284908, prior correction 5593272286 and current evidence 5593746343.

### Existing real evidence remains distinct

[Evidence 5593746343](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5593746343)
and CI `34291271829` / Database `102282051833` at `056d7b0` establish real
S1–S4 preservation PASS: base05-only history, ordinary capture of two fictional
owners / ten tables / thirty rows / eight objects, base-history recheck, only
target06 applied, exact final history, complete old values/versions/raw timestamp
strings and stored-plus-actually-downloaded image comparisons, new unknowns,
post-comparison probes and exact-run cleanup. Normal reset/integration/security
and recovery (one case, 6.3s) passed. This is local fictional-data evidence,
not a hosted migration or full release acceptance. Earlier failures remain above.

The later type-generation gate failed: CLI exit 1, 1984ms, stdout 0 bytes,
stderr 312 bytes, Database/images markers false, connect marker true, seven LF
separators, first-line 21 bytes and `run-container`; wrapper exit 2, existing
type file unchanged. Type upload/parity were skipped, not passes. Raw generator
stderr was not retrieved or published; startup also withholds CLI output.
Matching historical counts do not identify a cause. Separate App 554-unit /
329-browser and native four-plus-three passes do not close type parity, actual
visual acceptance or B3's release-quality decision.

### Exact bounded change and source-derived tests

Only `scripts/backend/local.mjs` inside `describeGenerationResult`,
`tests/unit/local-backend.test.ts`, and this append change. The full PR therefore
has eight paths; all original preservation code, package/CI wiring, other helper
functions/exports, db wrapper, CLI arguments/environment/timeouts, SQL/types,
app, dependencies and browser/Apple/setup configuration remain unchanged.

Read the complete pinned CLI 2.116.0 handler at commit
`997a1e69a4a83466964ed874d3a604c88a7b3866`:
`apps/cli/src/legacy/commands/gen/types/types.handler.ts`, blob
`63a47aa0fd509efc95d3a7cf387be557880f74bf`. It creates the error message
`error running container: exit ${result.exitCode}`. Followed its entrypoint and
the relevant `shared/cli/run.ts` failure path (blob
`758ef9eac2246b73c18f0fc6c8db0efe22b6f280`) through
`shared/output/normalize-error.ts` (blob
`bd89a4c1d54ab454108ebea081cab780dc6a7768`) to the text failure renderer in
`shared/output/output.layer.ts` (blob
`bf2a98728404b799fa2018895d8fa02f2da509de`). The output service/text formatter
were also inspected to distinguish raw failure rendering from CLI parse errors.
With the existing `NO_COLOR=1` environment, the message is bare and followed by
LF; clack framing, CRLF, quoting, padding, ANSI and unterminated lines are not
accepted alternatives. No upstream implementation was copied or fetched at test
time, and no CLI command was added or executed to obtain fixtures.

The new `stderrContainerExitBucket` exists only on `nonzero-with-stderr`,
after all eleven original fields. Its four possible literals are `exit-125`,
`exit-126-or-127`, `other-nonzero`, and `unclassified`. The added scan runs only
when the existing stderr byte count is at most 4096 UTF-8 bytes. Exactly one
`error running container:` anchor anywhere in that bounded string is required,
including malformed/embedded anchors in the duplicate count. A bare full message
at string start or after LF must end in LF and contain a canonical unsigned
decimal 1–255. No partial digit/text match, sign, leading zero, decimal, zero,
out-of-range value or first/last duplicate selection is accepted. Unsupported
or oversized input remains unclassified; invalid tuples retain their original
output without the new field. Only the fixed bucket is emitted, never a captured
number/message, raw text, private identifier or inferred Docker/network/auth cause.
It does not prove that a particular container started.

Sixty-two added unit cases cover numeric boundaries 0/1/124/125/126/127/128/255/256,
malformed/partial/long-digit/duplicate anchors and framing, exact 4096/4097-byte
limits (including multibyte text and an out-of-bound duplicate), unsupported
values, getters/toJSON and private-shaped text. Source-derived positives are
labelled as such. Serialized old eleven-field reports are compared after
omitting only the new field; inactive/invalid golden reports remain byte-equal.
Existing operation-priority, tag, byte/LF counting and privacy tests remain;
the numeric bucket does not override old operation priority. No declarations,
compiler exceptions, test framework or dependency were added or changed.

### Actual native validation and handoff limits

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual final result |
|---|---|
| `npm run test:unit -- tests/unit/local-backend.test.ts` | 182/182 passed, exit 0. |
| `npm run test:unit` | 616/616 in 13 files, exit 0; includes unchanged preservation/import-safety and fail-closed local-runner tests. |
| `npm run lint` | Exit 0. |
| `npm run typecheck` | Exit 0. |
| `node --check /home/runner/work/stillroom-wardrobe/stillroom-wardrobe/scripts/backend/local.mjs` | Exit 0. |
| `npm run check:translations` | 402 EN/FI/SV keys, 37 source files, exit 0. |
| `npm run build` | Exit 0; JS 164.26 kB gzip, CSS 4.97 kB gzip; existing non-failing >500 kB chunk warning. |
| `npm run scan:secrets` | Exit 0; 160 text files and fresh unprinted build canary checked before this append. |
| `git diff --check` | Exit 0 before append; repeated before commit. |
| `git diff --exit-code 056d7b0581ffc17b8cbda7e489d3ced1d931f1ae -- . ':!scripts/backend/local.mjs' ':!tests/unit/local-backend.test.ts' ':!docs/phase-2-result.md'` | Exit 0; all frozen tracked paths unchanged. |

Build/scan shared `export STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`
without printing the value. The initial focused run had two fixture failures
(LF byte count and multibyte boundary padding); the second retained one
incorrect golden stdout byte count. Fixture corrections preceded the final
targeted/full passes; production logic and scope did not change during iteration.
Precommit `node --input-type=module` inline static assertions passed (exit 0):
the existing TypeScript AST located the function body, all helper text outside
it was byte-equal, this file retained its full starting-head byte prefix, and
`git diff --name-only` contained exactly the three allowed files. The
changed-file secret scanner reported no secrets; full PR inventory is eight paths.

After the completed candidate is committed and processes finish, invoke the
existing native final validator **once**; report actual components/languages,
findings and unavailable tools on the PR. An unreported SQL analysis or missing
automated reviewer is not a pass. No alternative scanner, extra agent, repeated
validator or metadata-only evidence repair is authorized.

No native type generation/rehearsal/migration-list/reset/up/provision/psql,
DB/integration/security/recovery/browser/a11y/Apple/hosted command or service
operation ran. Existing units exercise refusal/import-safe paths only, not live
services. No raw privileged log, private photo, image/archive/binary view or
image-bearing model input was used; fixture buffers stayed program-only.

The coordinator owns trust inspection and genuine affected independent review
before the **one new-head unchanged CI plus required Apple cycle, each once**.
The worker has not authorized or rerun either workflow. A classified generation
failure stops with the fixed category for a separate next decision; unclassified
stops without another flag/retry series. If generation and exact parity pass,
record that success while leaving the previous cause unobserved/not fixed and
the new classifier's live failure path **unexercised**. Unit success here is not
such live evidence. Fresh-head normal-owner/App/native/type/visual gates and B3
remain required. No merge/main mutation/deployment, conditional hosted execution,
history repair/replay, account/data/private-input/provider/paid-AI operation,
new branch/PR/agent or next packet occurred. Publish final head/files/results
and stop editing for parent review.

## PR #13 — I29b Stage 1 schema source only — 9 September 2026

**Native unit/static implementation checks pass; new database runtime, generated
types and Stage 2 UI remain UNRUN/PENDING.** This is the I29b subset of
R18/R19/R23/R26/R27/R28, not full I29, Phase 2 or release completion.
Repository `drrowdev/stillroom-wardrobe`; actual platform branch
`copilot/copiloti29b-saved-item-corrections`, PR #13. Base:
`9d1858236309436b3144a3f45fcef581faff8630`; clean starting head:
`ec8a766736d44cfa18700d584713f15df4d38a73`, an empty platform commit directly
parented by that base. No prior PR was reopened or modified.

### Authority and context actually read

Read the **full 21,849 UTF-8-byte**
[approved plan 5597695316](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5597695316),
published on closed PR #12 solely as authority for this new packet. It records
actual read-only **Anthropic / Claude Opus 5**, reviewer
`saved-edit-contract-critique`, on the privileged write/version/locking/migration
boundaries. Coordinator amendments control: no parent lock, no nonempty-text
condition at counter 1, strict reconciliation, and staged real CI type generation.
The kickoff restricts this session to nine of the complete packet's 22 paths.
No new architecture/review loop, agent, dependency or scope expansion occurred.

After context and before edits, reread this task's own
[public receipt 5597947883](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5597947883):
explicit request `gpt-6-astra`, authenticated actual allocation
`sweagent-capi:gpt-6-astra`, task `40280edb-0f1c-468e-90f4-e6b3ec887719`,
session `e9d032f6-b30c-40a6-8d88-e689fcc2eab2`. Immediate GET observation:
`2026-09-09T07:28:01.9530608Z`; repository/PR/sole-writer/ref verification:
`2026-09-09T07:28:45.1937695Z`. Repository, PR #13, branch, base and starting
head match this checkout. No old receipt, prompt/branch label or self-attestation
substituted for the coordinator's allocation evidence.

Files actually consulted: root `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/cloud-development.md`, relevant `docs/phase-0-result.md`,
`docs/phase-1-result.md`, `docs/phase-2-result.md`, `docs/local-backend.md`;
`blueprint/AGENTS.md`, 00/03/05/06/08/10/14/20/21 and relevant 02/07/15 sections;
both existing migrations (base byte-equal to blueprint 07), generated image/item
type excerpts, `src/data/rows.ts`, `src/data/items.ts`, `src/data/errors.ts`;
the existing preservation orchestrator/normal module/units, integration/security
sessions, `scripts/backend/local.mjs` guard excerpts, `scripts/hosted-smoke.mjs`
guard excerpt, `scripts/run-local-tests.mjs`, `scripts/scan-secrets.mjs`,
`package.json` and the existing CI contract read by preservation units.
PR #13 body/comments/diff/reviews/threads and MCP workflow/job evidence were read.

Starting-head CI `34323985068` was `action_required`, with zero jobs and no failed
job logs, not a passing run. Prepared native run `34323984211`, job
`102376909588`, reports successful locked dependencies, local startup
07:29:20–07:30:22 UTC, reset/provision 07:30:23–07:30:50 and actual baseline
type generation 07:30:50–07:31:00. The running-job log download returned HTTP 404;
these are step metadata, not inspected command logs or new-schema runtime proof.
The prepared generated file was clean and remains untouched.

### Exactly nine changed paths and source contract

1. `supabase/migrations/20260909070000_item_description_edit.sql` (new).
2. `tests/integration/local.sessions.mjs`.
3. `tests/security/rls.sessions.mjs`.
4. `scripts/preservation-rehearsal.mjs`.
5. `tests/integration/preservation.sessions.mjs`.
6. `tests/unit/preservation.test.ts`.
7. `docs/phase-2-result.md` (this append only).
8. `blueprint/08-API-AND-STORAGE.md`.
9. `blueprint/06-DATA-MODEL.md`.

The new SQL is **2618 bytes**, SHA-256
`383012f9662a4b672b58d6a690bc12691e741468af464af2fe841525e723bb98`.
Old 05/06 sources remain respectively 35214/5923 bytes and hashes
`4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5` /
`4060e963bc5a986857f31bc9b528dd6d7ea8caee720336de8499d59e8f8c3f92`.

The additive migration gives every image a non-null bigint description counter,
default 1, check 1–2147483647, and relaxes only the alt-text length check to
0–240 while retaining NOT NULL. No old-row DML/backfill, text rewrite, item
change or image grant broadening. Cleared text is valid at counter 1 for future
restores. Exact RPC:
`public.update_image_description(p_image_id uuid, p_expected_description_version bigint, p_alt_text text)`
returns one typed row `(id uuid, owner_id uuid, item_id uuid, alt_text text,
description_version bigint)`, never paths or media.

The VOLATILE SECURITY DEFINER RPC uses empty search_path, current admission and
session-derived ownership. A single conditional target-image UPDATE matches
owned ready/non-retired image, exact counter below ceiling and owned non-deleted
parent; SET contains only text/counter. Same-value matched writes increment.
Zero rows fail; an unlocked lookup can classify owned current counter conflicts,
while absent/foreign/pending/retired/deleted-parent stays generically unavailable.
No parent lock or change to old commit/retire RPCs. Only target state/counter
receives the concurrent row recheck; parent EXISTS does not promise a
newer-than-statement snapshot. Fixed errors and authenticated-only EXECUTE remain.

Existing ordinary-session test source adds both-owner positives, explicit
clears, 240-code-point Unicode/overlong/null/invalid-counter cases, fresh
same-text increments, stale equal-text rollback, concurrent single-counter
winners, pending/retired/deleted-parent/foreign/absent/anonymous denial and
direct UPDATE/DELETE/counter INSERT denial. It checks full item/image rows and
actual downloaded hashes, name/category CAS with preserved untouched facts,
raw owned v2 export including the cleared text/counter, and replacement races
that cannot edit the replacement. No administrator access assertion.

**Stored-at-ceiling runtime case NOT RUN:** ordinary reservation grants exclude
the counter and ordinary image UPDATE is denied. No existing permitted fixture
can place it at 2147483647. Static SQL/finite-bound units cover the limit and the
normal suite rejects an expected ceiling against a lower stored counter; that
is not runtime proof of a stored-at-ceiling row. The normal suite explicitly
reports this gap. Parent must resolve the coverage gate without new privileges,
provisioning changes, an administrator assertion or an enormous RPC loop.

Preservation now pins exactly 05/06/09, each name/length/hash/display time.
The ASCII/4096-character/strict quoted-cell parser requires inventory length + 2
logical lines: 05 applied and both 06/09 pending at base; all three applied and
none pending at target. Snapshot source binding includes all three hashes.
S1 reset/provision, S2 original base columns/fixtures, single S3 local up command,
S4 read-only-first comparison, private 512 KiB wx/0600 snapshot, exact cleanup,
fixed safe outputs and 2 owners/10 tables/30 rows/8 objects remain unchanged.
S4 requires each old image's new counter exactly 1, removes only that column and
the four verified initial I29a item columns, then compares complete old rows,
raw timestamps and stored plus actual downloaded bytes before functional probes.
Source fixtures/static tests are not real migration evidence; earlier two-source
evidence above remains dated and unchanged.

### Actual native commands and results

Working directory: `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/preservation.test.ts` | Initial preservation extension 80/80; first SQL-contract run 81/82, then corrected final 82/82, exit 0. |
| `npm run test:unit` | 624/624 in 13 files, exit 0, including import-safety/refusal tests. |
| `npm run lint` | Exit 0. |
| `npm run typecheck` | Exit 0, unchanged existing app consumers/generated types. |
| `node --check scripts/preservation-rehearsal.mjs` | Exit 0, invoked with absolute path. |
| `node --check tests/integration/preservation.sessions.mjs` | Exit 0, invoked with absolute path. |
| `node --check tests/integration/local.sessions.mjs` | Exit 0, invoked with absolute path; checked again after final test-source edit. |
| `node --check tests/security/rls.sessions.mjs` | Exit 0, invoked with absolute path. |
| `npm run check:translations` | 402 EN/FI/SV keys, 37 source files, exit 0. |
| `npm run build` | Exit 0; JS 164.26 kB gzip, CSS 4.97 kB gzip; existing non-failing >500 kB warning retained. |
| `npm run scan:secrets` | Exit 0; 161 text files and fresh unprinted build canary checked before this append. |
| `npm run check:dependencies` | Exit 0; 12 production/220 development packages, no unverified dates; completed production audit, zero alerts. |
| `git diff --check` | Exit 0; repeated after append. |
| `wc -c supabase/migrations/20260909070000_item_description_edit.sql` and `sha256sum supabase/migrations/*.sql` | Exact new size/hash and frozen old hashes above. |

Build/scan shared `export STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`,
never printed. The one new static-test failure was a test comment-strip pattern
that missed indented SQL comments and incorrectly matched the word “lock”;
the pattern was corrected without changing SQL. Its chained typecheck did not
run after that failure and later passed explicitly. `rg` was unavailable during
context lookup; ordinary existing text tools were used without installing it.
No dependencies, new scanner, helper module, compiler setting or service changed.

Before commit, check exact nine-path inventory, unchanged frozen tracked files,
full starting result-document byte prefix, migration hashes, diff hygiene and
changed-file secrets. The `python -` inline static assertions completed with
exit 0: exact nine changed/untracked paths, `git diff --exit-code` excluding only
those paths, complete base-document byte prefix, and all three exact migration
lengths/SHA-256s. All four absolute-path `node --check` calls and
`git diff --check` then passed again; changed-file scanning found no secrets.
After candidate commit and all processes finish, invoke
the existing native final validator **once** and publish actual components,
languages/findings and unavailable tools on PR #13. Unreported SQL analysis or
missing automated review is not a pass; no metadata-only follow-up commit.

### Mandatory staged handoff and unchanged external gates

No native db:start/reset/up/migration-list/provision/psql/typegen/rehearsal,
opt-in change, live integration/security/recovery/browser/a11y/Apple/hosted
command or service operation ran after unchanged preparation. No role/container
repair or diagnostic-budget reuse. Normal-session source is **UNRUN**, not a
passing live test. All images/binary buffers remained program-only; no image,
archive, credential cache, private row/photo or raw service error entered model
input or evidence output.

Stop after this nine-file commit/report. Parent reviews full diff and execution/
privacy/trust evidence before authorizing the **first fresh current-head existing
Database CI**. It must run new migration, three-source populated preservation,
normal integration/security/recovery and real type generation, retaining only
the existing generated-type artifact. Old committed-type parity is expected to
FAIL in Stage 1, not waived as a final pass. Any failure before parity is a
genuine blocker, not “expected type noise”; no blind unchanged rerun.

Only after actual artifact provenance may the coordinator assign a separate
own-receipt-verified Stage 2 continuation on the same PR for the real generated
file and typed UI. No handwritten types or early UI/domain/catalog/CSS/browser/
visual/workflow changes occurred. Fresh final CI/types/independent review and
actual approved visual/device/screen-reader gates remain. All-field editing,
automatic analysis, consent/budgets/receipts/expiry and saved-only export remain
unfinished I29, not post-MVP deferrals. No I08/later phase or provider work.

Current live release Pages `31bdd067` / main `9d1858`, automatic production OFF /
previews NONE, hosted I29a `20260909062611` and the base hosted mapping remain
untouched. Prior live approval is not approval to apply this new source migration.
B3 remains open with acceptance limited to the released runtime; no new upload
primitive/probe or repeated human task. Rollback would be a separately reviewed
source revert, never hosted SQL replay/history repair. Worker performs no Actions
approval/rerun, merge, deploy, new agent/branch/PR or next packet.

## PR #13 — I29b Stage 2 saved-item editor — 9 September 2026

**Source implementation and native deterministic checks pass. Final independent
review, fresh exact-head CI/type parity, coordinator visual review and the
stored-at-ceiling runtime coverage decision remain OPEN.** This implements only
the three currently entered saved inputs: name, category and photo description.
It is the I29b subset of R18/R19/R23/R26/R27/R28, not full I29, Phase 2, hosted
acceptance or MVP completion.

### Same-PR authority and verified input

Repository `drrowdev/stillroom-wardrobe`, PR #13, branch
`copilot/copiloti29b-saved-item-corrections`; base
`9d1858236309436b3144a3f45fcef581faff8630`; starting head
`27c37aff01c0135cf28c9e94477d68e5c96ecf3a`, tree
`f974e60380e3f51057f596e16ea853f87d17f44d`. No new branch/PR or other writer.
The complete approved
[plan 5597695316](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5597695316)
was read: 21,849 UTF-8 bytes, SHA-256
`c9ba45adf377cf1001ba29d025f4b6f8a2c8e5967c4baea1e9a2bae7d267ce6e`.
Its actual Anthropic / Claude Opus 5 `saved-edit-contract-critique` and coordinator
amendments remain controlling; no additional agent, architecture review or
provider was invoked. The closed PR #12 comment supplies authority, not an edit
target.

After context and before implementation, reread this continuation's own
[receipt 5598692946](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5598692946):
task `3e68a0be-5735-4ef5-b460-e5bee3b8f41a`, session
`a54792b3-15d1-45fb-a316-85536f38980c`; explicit `gpt-6-astra`, coordinator
authenticated actual allocation `sweagent-capi:gpt-6-astra`. Observation
`2026-09-09T08:20:26.5937320Z`, reverified
`2026-09-09T08:21:15.3536818Z` against this repo/PR/base/head/branch and sole
writer. The Stage 1 receipt was not reused.

Context consulted: root `AGENTS.md`, `.github/copilot-instructions.md`; relevant
cloud, Phase 0/1/2 and local-backend evidence; blueprint 00/03/05/06/08/10/14/19
and relevant 07/15/20/21 sections; actual three migration contracts and generated
item/image rows; `src/domain/wardrobe.ts`, `attribute-provenance.ts`,
`src/data/items.ts`, `rows.ts`, `errors.ts`, `profile.ts`, `client.ts`;
`src/auth/session.ts` scope contract, app/router/dialog, wardrobe/add-item/profile
screens, PrivateImages, catalogs/styles; package commands, pinned CI/Playwright,
quality-gate unit fixtures, browser mock and profile/slice tests. PR #13 body,
discussion, diff, reviews/threads and MCP Actions evidence were inspected.

The full
[Stage 1 handoff 5598639436](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5598639436)
records real CI `34324963356` attempt 2, Database job `102383503422`: migration,
three-source populated preservation, ordinary integration/security/recovery,
real generation and upload passed; **only old committed-type parity failed**.
The exact Database log was read through GitHub MCP and confirms that upload
preceded the parity failure. Stage 1 App 624 units/329 browsers and native Apple
4+3 are dated prerequisite evidence, not this candidate's CI passes.

The setup had already modified `src/data/database.types.ts`. It was not blindly
committed: current GitHub metadata confirmed artifact `10093913972`,
`database-types`, run `34324963356`, exact starting head, branch and repo/head-repo
ID `1358925513`, unexpired with expiry `2026-09-10T07:55:54Z`. The exact archive
was downloaded and checked in program-only memory using Python standard
libraries and a 30-second request timeout:

* Archive 2630 bytes, SHA-256
  `21b1bab052497c37ddad6c44a0ebd069c1e93fc2675a32807ceb877f754791ba`,
  matching GitHub's digest, below 1 MiB.
* Exactly one nonencrypted regular Unix `100644` member, `database.types.ts`;
  no directory, symlink or alternate extraction path.
* Member 22312 bytes, below 128 KiB, strict UTF-8/no NUL, SHA-256
  `6787f9a2a776db922d0e424d7bfb11746854dd896bbabeec3fd2f359cd5dd759`.
* Exact byte comparison with the setup-generated file passed. Those identical
  bytes were deliberately adopted in `e95a049`, without rewriting, regenerating
  or hand-authoring types. The text diff is only three `description_version`
  properties and the typed `update_image_description` Args/Returns.

All migration bytes remain frozen: new SQL is still 2618 bytes / SHA-256
`383012f9662a4b672b58d6a690bc12691e741468af464af2fe841525e723bb98`;
old 05/06 hashes remain exactly as recorded above.

### Implemented contract and source boundaries

The owned completed-library card opens strict canonical `#/items/<uuid>`;
`#/items/new` remains creation. Detail reads require the current owner,
non-deleted item and exactly one current ready/non-retired image. Invalid,
foreign, absent and pending-only routes show the same generic unavailable
state. The existing authenticated PrivateImages main Blob is shown once;
missing bytes show the existing unavailable-photo treatment, with no alternate
source or upload.

Two independent sections have separate explicit Saves and the existing
per-section-save explanation. A save remains on detail, updates only its own
baseline, refreshes eventual library data and preserves the sibling draft.
Required name/category use the existing taxonomy/100-character convention.
Saved descriptions trim and accept an intentional `''`, without the creation
title fallback. Only changed name/category fields and their next user
provenance revisions are PATCHed with item/owner/version/deleted-null predicates.
All other fetched item values/provenance are retained for strict comparison;
absence remains visibly unverified. Description writes use only the three typed
RPC arguments and validate the exact five-field response.

Each attempt is frozen and single-flight within its section. Unchanged,
invalid/offline or frozen attempts cannot be submitted. Transport/malformed
responses remain explicitly unconfirmed; known rejections and zero-row conflicts
are not labelled ambiguous successes. Check saved changes performs reads only:
identity, exact next row/counter, intended values, untouched provenance and
item facts must match. Equal text, a later version, altered facts or a replacement
image cannot confirm an attempt. No automatic rebase/rewrite/retry. Explicit
discard/reload affects only that section. Owner/item lifetimes abort/ignore
late work; UID change/logout clear old private state, and logout remains usable
while a save is pending. Dirty/busy history navigation and cancel-focus behavior
use the existing router/dialog patterns.

Stage 2 touches only these fourteen approved paths (the overall PR remains
exactly the approved 22-path packet):

* `src/data/database.types.ts`, `src/domain/item-details.ts`,
  `src/data/item-details.ts`, `src/features/wardrobe/item-detail.tsx`;
* `src/app/app.tsx`, `src/features/wardrobe/wardrobe-screen.tsx`,
  `src/i18n/phase-zero.json`, `src/styles/app.css`;
* `tests/unit/item-details.test.ts`, `tests/browser/item-details.spec.ts`,
  `tests/browser/mock-backend.ts`, `playwright.config.ts`;
* `.github/workflows/ci.yml` and this append-only result document.

Editor/test source was committed as `19dbcb1` with the Copilot App co-author
trailer. Stage 1 SQL, preservation harness/ordinary tests, blueprint additions,
existing browser specs, Auth/profile/settings/add-item/upload/image primitives,
local tooling, dependency/lockfiles and native Apple/setup workflows are
unchanged. WebKit configuration adds only the new spec. CI adds only one pinned
App upload step: the two exact `test-results/i29b-visual/item-details-{en-desktop,fi-mobile}.png`
paths, head-bound name, one-day retention and missing-file failure. Existing
four I06/I07 captures remain. Tests guard synthetic owner/route/no credential-like
visible text, regular PNG names/headers/widths and each file at most 1 MiB.
Buffers stay ignored and unopened; functional assertions run in every project.

### Actual native validation

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Units/static work and Vite-backed browser suites ran sequentially. The final
source candidate was unchanged during the full runs.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/item-details.test.ts` | Final 53/53, exit 0. Domain bounds, identity/provenance/full-fact preservation, frozen attempts, typed read/PATCH/RPC predicates, strict confirmations, definitive versus uncertain errors, owner/epoch/abort guards. Mocked adapters, not live RLS. |
| `npm run typecheck` | Exit 0. |
| `npm run lint` | Exit 0. |
| `npm run check:translations` | Exit 0, 423 EN/FI/SV keys, 40 source files. |
| `npx playwright install --with-deps webkit` | Exit 0; installed the existing pinned browser/runtime libraries missing from prepared setup. No dependency, package, config, engine-selection or timeout change. |
| `npm run test:browser -- tests/browser/item-details.spec.ts --retries=0` | 63/63 after focus/layout repairs, exit 0. All three configured projects. |
| `npm run test:browser -- tests/browser/item-details.spec.ts --grep 'independent item attempt\|UID change' --retries=0` | Later three race additions: 9/9, exit 0. They also pass in the full run below. |
| `npm run test:unit` | 677/677 in 14 files, exit 0. |
| `npm run build` | Exit 0; JS 168.84 kB gzip, CSS 5.12 kB gzip. Existing non-failing >500 kB chunk warning remains. |
| `npm run scan:secrets` | Exit 0, 166 text files and fresh unprinted build canary checked before this append. |
| `npm run check:dependencies` | Exit 0, 12 production/220 development packages; zero unverified release dates and zero reported production vulnerabilities. |
| `npm run test:browser -- --retries=0` | **401/401**, 4.8 minutes, exit 0; includes all 72 new editor cases and unchanged existing suites/capture guards. |
| `npm run test:a11y -- --retries=0` | **30/30**, 40.2 seconds, exit 0; run after the full browser suite. |
| `git diff --check` | Exit 0. |

Build and its secret scan shared the process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"` without printing the value.
Changed-file secret scans passed before source commits. Initial typecheck exposed
not-yet-added catalog keys and an incorrect existing key; lint caught a callback
dependency, both corrected. Initial unit iteration corrected the SDK's empty-array
to-null conflict expectation and parameterized array fixtures. Initial browser
run: 39 passed, 24 failed (21 missing-WebKit launch failures, two discard-cancel
focus failures and one 200%-text overflow). Existing pinned WebKit installation,
explicit detail focus restoration and scoped wrapping fixed those causes;
no retries, skips, timeout increases or unrelated test edits.

The final checker runs once after the result commit and completed processes;
its actual component/language findings and any unavailable reviewer/analysis
are reported on PR #13, not presumed here. No replacement scanner or agent.

### Open gates and unchanged release

No additional native database start/list/reset/up/provision/psql/type generation,
preservation rehearsal, opt-in, integration/security/recovery, native Apple,
hosted smoke, Auth setup or deployment command ran. Full browser tests use
synthetic contract fixtures; they do not replace the Stage 1 ordinary-session
proof or required final fresh CI. Intermediate candidate workflows were observed
as `action_required`, not executed or passed; the worker approved/reran none.

Coordinator owns final execution-trust review, fresh final-head existing CI
(including normal-owner preservation/integration/security/recovery/generated-type
parity), native 4+3, genuine independent review and actual provenance-verified
inspection of all six final-head PNGs. Local DOM/axe/capture checks are not
visual acceptance. Missing/unread images remain pending. **Stored-at-ceiling
runtime remains OPEN/NOT RUN**, not waived by input-bound/denied-injection
tests, static guards or these browser mocks; no privilege/helper/schema change
or giant counter loop was used to manufacture that coverage.

Full draft/saved garment-field editing, automatic analysis, provider consent,
allowances/receipts/expiry and saved-only export remain unfinished MVP I29 work,
not post-MVP deferrals. No I08 lifecycle/trash/filtering/replacement or later
packet is implemented. Accounts remain independent. Current live release,
hosted mappings, B3 limits, pending operator/physical-device/screen-reader
acceptance and automatic-deployment-off settings are unchanged. No new hosted
migration, paid/provider action or private input is authorized. Rollback is a
separately reviewed source revert, never hosted replay/reset/history repair.
Hand off this same PR and stop for coordinator review; no merge/deploy,
new agent/branch/PR or next packet.

## PR #13 — I29b routine Unicode correction — 9 September 2026

U1/U2 source corrections and native deterministic regressions pass. This is only
the saved-input correction within I29b (R18/R19/R23/R26/R27/R28), not full I29,
Phase 2, hosted or manual acceptance. All preceding result bytes are preserved.

### Authority, context and correction

Same repository `drrowdev/stillroom-wardrobe`, PR #13 and branch
`copilot/copiloti29b-saved-item-corrections`; base/main
`9d1858236309436b3144a3f45fcef581faff8630`, starting head
`0be199f262604ea6a7686d84cebed3ef2482c407`. Read the full approved
[plan 5597695316](https://github.com/drrowdev/stillroom-wardrobe/pull/12#issuecomment-5597695316):
21849 bytes, SHA-256
`c9ba45adf377cf1001ba29d025f4b6f8a2c8e5967c4baea1e9a2bae7d267ce6e`.
The full [finished-code review and correction 5599395681](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5599395681)
records actual read-only Anthropic Claude Opus 5
`i29b-final-correctness-review`, U1/U2 and coordinator approval for this routine
five-path correction. No new design, reviewer/agent or scope was introduced.

After context and before any edit, reread this task's own public
[receipt 5599419864](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5599419864):
task `bbebde60-60fd-4787-b4e6-f72994ce365e`, session
`8235c8b0-a88f-49ab-9c48-e9f8cf23787f`, explicitly selected `gpt-6-astra`;
coordinator authenticated actual allocation `sweagent-capi:gpt-6-astra`,
observed `2026-09-09T09:13:18.4025812Z`, reverified
`2026-09-09T09:13:51.2831051Z` against this repository/PR/base/head/branch and sole
writer. No historical session receipt was reused.

Context read included root `AGENTS.md`, `.github/copilot-instructions.md`,
relevant cloud/Phase 0/1/2 evidence, blueprint 00/03/05/07/08/10/13/14/19/20
sections, actual migration/generated RPC text, domain/data/editor source,
unit/browser tests, mock fixture contracts, catalog messages, package scripts,
Playwright configuration and quality-gate fixture isolation. Inspected PR #13
discussion/diff/reviews and GitHub MCP workflow runs/job logs. Historical
`34324963356` Database failure is the old type-parity diff, not a new failure
or permission to regenerate types. Held `34331216204`/`34331216190` remain
unexecuted `action_required`; no Actions authorization or rerun was performed.

U1 counted description UTF-16 code units and capped HTML entry at 240 units,
although SQL and the image baseline accept 240 Unicode code points. The old
stored baseline was not truncated or corrupted; valid astral text was blocked
from editing at its legitimate length. U2 similarly rejected legitimate
saved titles above 100 UTF-16 units, making the whole detail unavailable.

The three domain checks now use the existing `[...value].length` style for
100-code-point title validation/read baselines and 240-code-point descriptions.
Only the two saved fields lose their incompatible HTML `maxLength` attributes.
Raw entered text, including over-limit bulk insertion, remains visible.
Existing EN/FI/SV `detail.invalidFields` / `detail.invalidDescription` messages,
notice classes and linked `aria-invalid` / `aria-describedby` explain invalid
fields. Save stays disabled until correction; a valid sibling section can still
save without discarding the invalid draft. Trimming, required name/category,
NUL rejection, intentional description clear, unchanged-save disabling,
owner/version/provenance/frozen-attempt guards and all write paths are unchanged.
Creation remains frozen, including its narrower input limit and fallback.

Exactly five paths changed: `src/domain/item-details.ts`,
`src/features/wardrobe/item-detail.tsx`, `tests/unit/item-details.test.ts`,
`tests/browser/item-details.spec.ts` and this append. The full PR remains 22
paths. All other paths, SQL/types, ordinary DB/preservation tests, mock backend,
catalog/CSS, workflows/config, dependencies, routing/Auth/settings and image
primitives remain unchanged. Existing six-capture guards/paths/counts are intact;
Unicode cases add no screenshots or artifacts.

### Actual native validation

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Units and Vite browser suites ran sequentially; no source changed during the
final full checks. These browser/data fixtures are synthetic, not live RLS.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/item-details.test.ts` | 59/59, exit 0. ASCII/astral 100/101 and 240/241 bounds; valid stored 60/100-astral titles; exact-limit description edits and strict confirmation. |
| `npm run typecheck` | Exit 0, targeted and final. |
| `npm run lint` | Exit 0, targeted and final. |
| `npm run check:translations` | Exit 0, targeted and final; 423 EN/FI/SV keys, 40 source files. |
| `npm run test:browser -- tests/browser/item-details.spec.ts --retries=0` | First run: 54 passed, 27 failed solely because WebKit executable was absent. After the restoration below: 81/81, exit 0, all three configured projects. |
| `npx playwright install --with-deps webkit` | Exit 0, only after the missing-engine failure; restored existing pinned WebKit/system libraries, no repository dependency/config change. |
| `npm run test:unit` | 683/683 in 14 files, exit 0. |
| `npm run build` | Exit 0; JS 168.91 kB gzip, CSS 5.12 kB gzip. Existing non-failing >500 kB chunk warning remains. |
| `npm run scan:secrets` | Exit 0; 166 text files and unprinted build canary checked. |
| `npm run check:dependencies` | Exit 0; 12 production/220 development packages, zero unverified release dates and zero reported production vulnerabilities. |
| `npm run test:browser -- --retries=0` | 410/410, 5.0 minutes, exit 0; unchanged suites and approved capture guards retained. |
| `npm run test:a11y -- --retries=0` | 30/30, 40.3 seconds, exit 0, after full browsers. |
| `git diff --check` | Exit 0. |

Build and secret scan shared process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`, never printed.
New browser cases in EN/FI/SV use `fill` plus single/bulk `keyboard.insertText`
to exercise browser input and paste-style insertion, not an OS clipboard test.
They load exact-limit stored astral text, retain complete 101/241-character
input, verify visible localized errors and ARIA links, recover in bounds,
save each valid section while the sibling is invalid, and preserve exact text
through read-back/reload and library refresh. No implicit writes occur.

The existing final native checker is reserved for one invocation after this
candidate commit and finished processes. Its actual components, language counts
and unavailable/unreported analysis are to be reported on PR #13, not inferred
from a wrapper status or recorded through an extra self-hash-only source commit.

### Remaining gates and unchanged authority

Coordinator still owns exact-final-head CI (normal-owner preservation,
integration/security/recovery/type parity and native 4+3), narrow U1/U2 closure,
and actual provenance-verified visual inspection of six current-head PNGs.
No image/archive/binary was opened by this worker; DOM/axe/capture results
are not visual acceptance. Missing/unread visual evidence remains pending.

**Stored-at-counter-ceiling runtime coverage remains OPEN / NOT RUN.** Actual
Opus review found no permitted nonprivileged seeding route and no overflow
source bug. Expected-ceiling mismatch, denied injection and static guards are
not an actual stored-at-2147483647 RPC execution. No privilege/helper/schema
change, administrator assertion or huge loop was used; the coordinator must
resolve that separate authority/acceptance gate before whole-packet completion.

No native DB start/reset/list/up/provision/psql/typegen/rehearsal/ordinary DB
tests, hosted operation, Actions approval/rerun, new agent/branch/PR, merge or
deployment occurred. Current release/hosted I29a, B3's released-runtime-only
acceptance, automatic deployments off and pending manual/device checks remain
unchanged. I29b hosted SQL/deployment is not approved. Full I29/all-field edits,
AI consent/receipts/allowances/expiry and saved-only export remain unfinished MVP
work, not implicitly authorized here. Hand off this same PR and stop editing.

## 9 September 2026 — I29c complete manual fields source candidate

This append records the manual all-field foundation for R03/R23/R28, with
R18/R19/R26/R27 ownership, private-image, accessibility and localization
contracts retained. It is not full I29, Phase 2, hosted or manual acceptance.
Earlier results above remain historical evidence, byte-for-byte unchanged.

### This packet's authority and context

Repository `drrowdev/stillroom-wardrobe`, PR #14, branch
`copilot/i29c-manual-garment-field-editing`; authorized base/main
`e00c554af6aed844eb9f582ee9db96ff54805e89`, initial head
`530e7b43a68f9a8949ccba375ec9de689a2c146f`.
Read the full [I29c plan](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5601422784)
and this session's own
[public allocation receipt](https://github.com/drrowdev/stillroom-wardrobe/pull/14#issuecomment-5601586146)
after context and before edits. The coordinator recorded explicit and actual
`sweagent-capi:gpt-6-astra`, task `a0adc76b-7bad-4163-99ee-4df834f1059b`,
session `81cd6c41-ec7f-4c1c-a301-0598fdfe7401`, repository/PR/branch/base/head and
12:07–12:09 UTC verification. This is not a reused historical receipt.

The approved actual different-provider critique was **Anthropic Claude Opus 5**,
`i29c-full-fields-plan-critique`. Its recorded amendments couple every changed
value and user-next assertion, omit untouched INSERT provenance, distinguish
pending/ready caption reconciliation, retain the original preservation oracle,
describe actual system-column authority accurately, reuse catalog/form/format
contracts and separate the two new captures. The coordinator retained ready-row
caption equality and approved the complete 33-path packet before implementation.
No additional reviewer agent or implementation writer was launched here.

Context/source reads included `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/cloud-development.md`, phase results, the approved blueprint requirements,
actual migration/type contracts, and the affected domain/data/editor/upload,
catalog/formatting, browser/mock, CI and normal-session/preservation test files.
In particular the field implementation uses the existing
`src/domain/attribute-provenance.ts`, `src/domain/preferences.ts`,
`src/domain/wardrobe.ts` and `src/i18n/index.ts` contracts rather than a new
taxonomy or form dependency. Current PR discussion/diff/reviews and Actions were
read: base CI `34341096351` passed; initial PR CI `34349237313` and Apple
`34349237329` required authorization. The failed-job log query returned no jobs
or failures; it was not a test pass. This worker authorized/reran no workflow.

Implementation checkpoint `c4bb389d96e7b90e62d08e6ec0627f61f80b46a3` was followed
by the ordinary scoped summary-selector correction at source candidate
`56b2ee1761e08640fe6f2fcfd8d292ce22c2eb1f`. Only the approved 33 paths are changed,
including this append. Governance, packages/locks, Auth/settings, generated
types, old migrations, image processing/transport, B3 receiver/wire sections,
native Apple selections and traceability acceptance targets remain unchanged.
At that source head, CI `34352029043` and Apple `34352029265` still required
authorization; the CI failed-job query returned zero jobs. Fresh final-head
execution remains the coordinator's gate, not an unchanged rerun-to-green.

### Implemented source and evidence boundaries

- One shared controlled `item-form.tsx` exposes all 30 manual garment fields,
  grouped behind the existing optional-details wrapper. Inner accessible
  disclosure buttons preserve the frozen generic summary selector. Unknowns,
  optional clears and six editable app defaults are distinct; localized
  EN/FI/SV labels/errors retain literal personal text and Unicode code points.
  Collapsed invalid groups open before focus. Capture locks remain readonly;
  pending/unconfirmed saved inputs remain disabled.
- The closed raw/validated model preserves pending text, price entry locale,
  canonical decimal meaning, real date-only values, tolerated untouched
  collections and original dirty baselines. Nullable zero/false are not null.
  Numeric SDK conversion checks a finite bounded two-decimal round trip; it
  does not claim exact binary decimal representation or use formatted money
  as stored data. Capture currency initializes once, without a profile write.
- Changed factual values and manual revisions are built together; untouched
  creation assertions are omitted, explicit unknown clears can assert user/1,
  and saved unchanged user facts do not get gratuitous revision bumps.
  All intended values and untouched facts/provenance, including `created_at`,
  participate in strict saved confirmation. App defaults have no provenance.
  The client projection excludes arbitrary system fields; database identity
  UPDATE denial and server-controlled UPDATE timestamps/version do not imply
  a blanket grant denial of owner `deleted_at` or all INSERT metadata.
- Explicit capture Save freezes all reviewed values, description, provenance,
  photo metadata/Blob references, request IDs and owner/epoch. A synchronous
  latch prevents a second allocation. Duplicate continuation checks the entire
  frozen item at version 1 and immutable image metadata. Pending requires the
  matching caption/counter 1; ready permits a later valid counter only with the
  same caption. Conflicts never overwrite or re-upload a changed ready row.
  Storage transport/hash/options, upload ordering and `commit_image` are intact.
- Saved garment and description sections retain separate frozen attempts,
  independent drafts and explicit read-only uncertain-response reconciliation.
  Successful saves stay on detail and refresh the library without losing the
  sibling draft. No automatic rebase, second write, analysis or enrichment runs.
- New `20260909110000_item_optional_collections.sql` is one transaction changing
  only colours/seasons lower cardinalities/defaults. It is 454 bytes, SHA-256
  `5296c58ac806ae560afd3befb4dc7e0bfc4fa61fa1898e9a21ef8e6db212b1d4`.
  There is no backfill, new column/function/grant or old-source edit. Historical
  `['unknown']` and all-four-season arrays/provenance remain stored unchanged.
  Generated types remain 22312 bytes, SHA-256
  `6787f9a2a776db922d0e424d7bfb11746854dd896bbabeec3fd2f359cd5dd759`.
- Preservation adds only the fourth pinned source/binding and bounded
  non-mutating collection rejection probes. The three old hashes/sizes,
  base columns, 2 owners/10 tables/30 rows/8 objects, legacy array oracle,
  raw versions/timestamps and actual downloaded-byte comparisons are retained.
  Source-derived history tests are not actual CLI/migration evidence.
  Added ordinary A/B/anonymous suites cover full fields/clears, default empties,
  numeric limits, atomic rejection, cross-owner denial and unchanged
  profile/history/image bytes. They were **not executed natively**.

### Native validation and corrections

Unit/static suites and Vite browser suites ran sequentially. Iteration exposed
and corrected an early detail-load wait in the new FI/SV tests, the existing
valid-title ARIA contract, and the fourth source-history fixture row count.
The targeted all-project garment/detail run initially had 62 passes/40 failures:
six valid-title ARIA mismatches and 34 missing pinned-WebKit launch failures.
Only after that missing-engine failure,
`npx playwright install --with-deps webkit` restored the existing engine/system
dependencies (exit 0), without repository dependency/version changes.

The first complete `npm run test:browser -- --retries=0` returned 413 passes and
18 failures: the frozen Slice `details.optional-details summary` selector
matched the nested summaries. The scoped disclosure-button correction retained
one matching summary without changing Slice or the other frozen image specs.
The following targeted command then passed **12/12**:

```sh
npm run test:browser -- tests/browser/slice.spec.ts tests/browser/garment-fields.spec.ts tests/browser/item-details.spec.ts --project=chromium --grep 'photo, editable draft|accessibility of private preparation|all thirty|unknown defaults|visual evidence|accessibility.*form' --retries=0
```

Final native results for source candidate `56b2ee1761e08640fe6f2fcfd8d292ce22c2eb1f`
(subsequent changes are this result append only):

| Command | Actual result |
| --- | --- |
| `npm run test:unit` | 815/815 in 15 files, exit 0. |
| `npm run lint` | Exit 0. |
| `npm run typecheck` | Exit 0. |
| `npm run check:translations` | 470 keys in EN/FI/SV, 43 source files, exit 0. |
| `npm run test:browser -- --retries=0` | 431/431, 5.9 minutes, exit 0 after the concrete correction. |
| `npm run test:a11y -- --retries=0` | 33/33, 51.2 seconds, exit 0 after full browsers. |
| `npm run build` | Exit 0; JS 174.64 kB gzip, CSS 5.33 kB gzip. Existing non-failing >500 kB chunk warning remains. |
| `npm run scan:secrets` | 172 text files and build canary checked, exit 0. |
| `npm run check:dependencies` | 12 production/220 development packages; zero unverified release dates; production audit completed with zero critical/high/moderate/low findings, exit 0. |
| `git diff --check` | Exit 0. |

The original phase-result prefix was also compared byte-for-byte against the
authorized base with `cmp` (exit 0). Build and secret scan shared an unprinted process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`.

### Handoff gates and unchanged limits

Coordinator owns fresh trusted exact-final-head CI, actual four-source
preservation, ordinary integration/security/recovery, real type generation and
parity, unchanged native Apple 4+3, genuine independent final review, and actual
inspection of all **eight** current-head PNGs. Existing profile/crop pairs stay;
saved-detail slots show expanded fields; only the new creation pair is added at
1280/320 px under `test-results/i29c-visual`. The existing pinned App artifact
action adds only that exact pair with one-day retention/missing-file failure.
Functional/owner/origin/route/language/privacy/overflow/axe checks run in every
applicable project; only Chromium writes screenshots and validates the bounded
regular PNG files.
The worker opened no image/archive/binary and received no screenshot bytes.
Capture/DOM/hash checks are not actual visual acceptance. The coordinator must
verify run/head/artifact members/type/size/privacy, actually view all eight,
record hashes/verdict publicly and in coordination records, and perform the
named cleanup. Missing/unread evidence remains pending.

The existing native final checker is reserved for one invocation after this
candidate and result append are committed and candidate processes finish.
Its actual components/findings and unavailable analysis belong in the PR
handoff, not an extra self-hash-only source commit or invented SQL pass.
Stored-at-counter-ceiling runtime coverage and existing B3/manual/operator/
device gates retain their prior status; this packet does not waive them.

No native DB start/reset/up/list/provision/psql/typegen/rehearsal, hosted
migration/smoke/Auth operation, Actions approval/rerun, new agent/branch/PR,
merge or deployment was performed. Live remains the reviewed historical
`31bdd067`/source `9d1858`, hosted base plus I29a; I29b/I29c hosted application
is not authorized here. Phase 0 remains engineering complete, acceptance open.
Only the second hosted-account test was user-deferred, not all manual checks.
Automatic photo analysis, consent/allowances/receipts/expiry/source-image history
and final saved-only export remain required unfinished I29/MVP work; I08
trash/undo/deletion/bulk/filter/eligibility workflows are not implemented by
these basic field controls. Hand off PR #14 and stop; no next packet is implicit.

## 9 September 2026 — I29c F1–F3 routine review follow-through

This correction remains on PR #14, `copilot/i29c-manual-garment-field-editing`,
starting at `d42d7f51b2a35b6a371b2366fe499cbeb0cd6da2`, with base/main
`e00c554af6aed844eb9f582ee9db96ff54805e89`. It addresses R03/R23/R28 while
retaining R18/R19/R26/R27. It is not another packet or full MVP acceptance.
The preceding 137596-byte result prefix is preserved unchanged.

### Authority and context

Read the complete [33-path approved plan](https://github.com/drrowdev/stillroom-wardrobe/pull/13#issuecomment-5601422784)
(29220-byte body, SHA-256
`4968c6030d94e15fb2bf5dc7a87a1ab63432302ba86775ba199fb4bc716ecb5d`)
and [finished-code review with controlling corrections](https://github.com/drrowdev/stillroom-wardrobe/pull/14#issuecomment-5602961182).
The actual different-provider reviewer was **Anthropic Claude Opus 5**,
`i29c-finished-code-review`, agent `59aa1f07-9124-4600-ba06-5285da284d4c`.
F1/F2/F3 and the coordinator's amendments authorize this bounded correction:
keep blank descriptions, distinguish formatting-only input from meaningful
intent, retain independent section guards, and correct the renderer/log count.
No new architecture, reviewer agent or scope expansion was introduced.

After context and before edits, reread this task's own
[public runtime receipt 5603034364](https://github.com/drrowdev/stillroom-wardrobe/pull/14#issuecomment-5603034364):
task `6ca6c3fb-26c7-4c80-b031-a4ee9a761d57`, session
`3cc86787-d28e-46a3-8331-8ed4bc66e6a5`, explicit `gpt-6-astra`,
coordinator-authenticated actual `sweagent-capi:gpt-6-astra`, observed
13:52:57.3006291 UTC and reverified 13:54:32.6511517 UTC against this
repository/PR/branch/base/head and sole-writer allocation. The original writer's
receipt is not evidence for this session.

Context reads included root `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/cloud-development.md`, current/historical sections of phase 0/1/2 results
and `docs/local-backend.md`; blueprint `00/03/05/10/14/19/20`, relevant item/API
sections in `07/08`, and requirement/work-packet references in `02/15`.
Source/test reads included the eight paths below, `src/domain/item-details.ts`,
`src/features/wardrobe/item-form.tsx`, `src/app/dialog.tsx`,
`src/i18n/format.ts`, generated item types, the optional-collections migration,
`tests/browser/mock-backend.ts`, `tests/unit/quality-gates.test.ts`,
`playwright.config.ts`, `package.json`, and relevant original PR diffs.
GitHub PR body/discussion/reviews and Actions/job logs were read without opening
images or downloading archives. The PR had no formal submitted reviews; the
actual independent review and approval are in the linked public comment.

Exactly eight existing paths change in this follow-through:

- `src/domain/garment-fields.ts`
- `src/features/wardrobe/item-detail.tsx`
- `src/i18n/phase-zero.json`
- `tests/unit/garment-fields.test.ts`
- `tests/browser/garment-fields.spec.ts`
- `tests/unit/preservation.test.ts`
- `scripts/preservation-rehearsal.mjs`
- `docs/phase-2-result.md` (append only)

### Corrections and regression evidence

- **F1:** EN/FI/SV capture help now says a blank saves without a photo
  description. No fallback or image behavior changed. Unit checks cover the
  wording and blank/whitespace capture attempts. Browser tests in all three
  languages verify the synthetic store's empty `alt_text`, empty grid/detail
  DOM alt, and the surrounding library link's accessible title/category name.
- **F2:** Dirty detection first uses existing validation, then shares the
  effective-value/manual-assertion decision with the closed write builder.
  Invalid input remains dirty; malformed structures do not become clean through
  a catch-all fallback. Valid already-user comma prices, leading-zero integers
  and trimmed titles retain their raw text/entry locale but create no patch,
  provenance/version bump or item navigation warning. One EN/FI/SV non-error
  `detail.noChanges` notice explains the local no-op, never a server-confirmed
  Save. It is absent for invalid, meaningful, pending or unconfirmed states.
  Explicit empty edits/clears remain assertions, including already-empty user
  fields; unknown same-value confirmation also retains its matching user-next
  value/provenance patch. Untouched empty fields remain untouched.
  Tests retain null versus zero/false, actual notes/ordered-array changes,
  intent mismatch protection and entry-locale meaning. Browser fixtures seed
  user-revision-1 price 12.5/display 12.50, retype FI/SV 12,50, 007 for minimum
  temperature 7 and title whitespace, and assert valid ARIA/raw preservation,
  disabled Save, no REST mutation and exact unchanged item snapshots. A dirty
  description still blocks Back; its independent explicit Save preserves the
  raw item formatting, after which Back needs no discard. Invalid raw input,
  same-value manual confirmation, empty clear and frozen/unconfirmed states
  retain protection. No description Save/lifetime/CAS/reconciliation code changed.
- **F3:** The padding/width loop now checks `slice(2, -2)`: header, separator
  and all four migration rows between the decorative blanks. The sole harness
  edit derives the informational source count from the closed `MIGRATIONS.length`.
  Inventory, parser, commands, guards, historical oracle and all pins are intact.

### Actual native validation

Unit/static and Vite-backed browser suites ran sequentially. The first targeted
unit run passed 278 tests, then typecheck found a readonly-array test-fixture
typing error; the fixture was corrected without changing runtime behavior.
Initial new browser cases returned 6 passes/12 failures: six used the wrong
cancel label instead of the existing `common.continueEditing`, and six could
not launch the missing pinned WebKit engine. Only after that missing-engine
failure, `npx playwright install --with-deps webkit` completed with exit 0.
No repository package/version/configuration changed.

| Command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/garment-fields.test.ts tests/unit/preservation.test.ts tests/unit/item-details.test.ts` | 278/278 in 3 files, exit 0. |
| `npm run test:browser -- tests/browser/garment-fields.spec.ts --grep 'blank photo description\|equivalent saved formats\|invalid saved input' --retries=0` | Initial 6 passed/12 failed as described above, exit 1. |
| `npm run test:browser -- tests/browser/garment-fields.spec.ts tests/browser/item-details.spec.ts --retries=0` | After concrete corrections/restoration: 120/120, all three projects, 2.8 minutes, exit 0. |
| `npm run test:unit` | Final 822/822 in 15 files, exit 0. |
| `npm run lint` | Final exit 0. |
| `npm run typecheck` | Final exit 0 after the test-fixture typing correction. |
| `npm run check:translations` | 471 EN/FI/SV keys, 43 source files, exit 0. |
| `npm run build` | Exit 0; JS 174.80 kB gzip, CSS 5.33 kB gzip. Existing non-failing >500 kB chunk warning remains. |
| `npm run scan:secrets` | 172 text files and build canary checked, exit 0. |
| `npm run check:dependencies` | 12 production/220 development packages; zero unverified release dates; production audit completed with zero critical/high/moderate/low findings, exit 0. |
| `npm run test:browser -- --retries=0` | Final 449/449, 6.4 minutes, exit 0; no failed/flaky/skipped summary. |
| `npm run test:a11y -- --retries=0` | 33/33, 52.0 seconds, exit 0 after full browsers. |
| `git diff --check` | Exit 0. |

Build and secret scan shared an unprinted process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`. These are native
unit/synthetic-browser results, not fresh normal-session database evidence.
The existing final checker is invoked once after the new candidate commit and
all candidate processes finish; its actual components/languages/findings or
unavailability are reported publicly on PR #14 after that invocation, without
a self-hash-only source commit. The original writer's checker remains
**UNREPORTED**, not retrospectively passed.

### Handoff and unchanged external gates

Earlier-head evidence remains true only for `d42d7f51b2a35b6a371b2366fe499cbeb0cd6da2`:
CI `34352838305`/Apple `34352838224` succeeded with 815 units/431 browsers,
real four-source preservation, ordinary integration/security/recovery, actual
type generation/parity and native Apple 4+3. The coordinator actually viewed all
eight d42 PNGs and found the known F1 copy issue. Neither that CI nor those views
prove corrected-head acceptance.

Coordinator follow-through still requires fresh exact-head CI, actual four-source
preservation/normal ownership/recovery/type parity, unchanged native Apple checks,
and actual review of all eight approved current-head PNGs with run/head/hashes/
verdict. Existing capture names, bounds, guards and workflow steps are unchanged;
new regressions add no PNGs. Native tools opened no images, binaries or archives.
DOM/synthetic results are not physical-phone, screen-reader or visual acceptance.

The 454-byte optional-collections source retains SHA-256
`5296c58ac806ae560afd3befb4dc7e0bfc4fa61fa1898e9a21ef8e6db212b1d4`;
22312-byte generated types retain
`6787f9a2a776db922d0e424d7bfb11746854dd896bbabeec3fd2f359cd5dd759`.
No native DB start/reset/up/list/provision/psql/typegen/rehearsal, hosted call,
Actions approval/rerun, additional agent/branch/PR, merge or deployment occurred.
The historical B3/counter-ceiling decisions and pending operator/device gates
are neither changed nor waived. Live `31bdd067`/source `9d1858`, hosted base+I29a,
and unapplied hosted I29b/I29c remain unchanged. Full I29 AI consent/receipts/
allowances/expiry/source-image history and saved-only export remain unfinished
MVP work; no I08/provider/next-phase work is authorized here. Stop editing and
hand this correction back to the coordinator.

## 9 September 2026 — I29d provider-disabled contract foundation

PR #15, `copilot/i29d-provider-disabled-ai-contract`, starts from freshly
verified main `48f66ca0645e530c8f67b9efbe96da8322b91a5b`. Initial empty head
`e5b629c3e604932eb1d9ea0bfeafd91feda75f93` is its direct child with unchanged
tree `e17b2d91540a683a9e16f54ddf4e77e793b99b64`. This append preserves all
147436 preceding bytes. Scope is the I29/R18/R19/R23/R26/R27/R28 contract
subset, not working analysis or completed I29.

### Authority, context and five-path boundary

The full [approved plan 5605017667](https://github.com/drrowdev/stillroom-wardrobe/pull/14#issuecomment-5605017667)
was supplied verbatim in the kickoff. It records actual Anthropic Claude Opus 5
`i29-next-foundation-plan-critique` and accepted bounded
`i29-contract-amendment-check`, with coordinator corrections. After context and
before edits, read this task's own
[public receipt 5605054373](https://github.com/drrowdev/stillroom-wardrobe/pull/15#issuecomment-5605054373):
task `292d22ad-fe5c-4968-803b-fb8e7f3c52fc`, session
`be2e7492-dbf5-4a6c-85cd-1046b57bdca5`, explicitly selected `gpt-6-astra`,
coordinator-authenticated actual `sweagent-capi:gpt-6-astra`, full allocation
reverified at 16:15:13.9024543 UTC against this repository/PR/branch/base/head.
No historical PR #14 receipt was reused; no new agent or material amendment.

Context included root/Copilot instructions; relevant cloud, phase-0/phase-2 and
local-backend evidence; blueprint 00/03/05/07/08/10/14/15/19/20/21 sections;
wardrobe/preferences/provenance/garment-fields sources; item schema/generated
types and provenance migration excerpts; garment-fields and quality-gate tests,
file walker, TypeScript/Playwright configuration and package scripts. PR #15's
discussion, empty initial diff/reviews, Actions status and job-log query were
read. Initial CI `34375464541` was `action_required`, with zero jobs/logs,
not a failed test or a pass. Shell `rg` was absent; existing text tools were
used instead. A CLI public-plan retrieval lacked `GH_TOKEN`; no credentials,
permissions or setup were changed to work around it.

Exactly five paths change:

- `src/domain/ai-analysis.ts`: closed fourteen-field semantic facts and
  versioned result parsers; existing taxonomies/limits, derived observation/
  estimate kinds, explicit unknown versus invalid outcomes, UUID/hash/counter/
  millisecond/24-hour bounds, 8192-byte UTF-8 ceiling and frozen copied results.
- `src/domain/ai-draft.ts`: pure immutable context-bound lifecycle, explicit
  request/generation transitions, manual-intent-preserving projection and edits,
  expiry retaining unverified derivation, photo cleanup and terminal reference
  invalidation; deeply immutable, exact-value/kind untrusted Save preparation.
- `tests/unit/ai-schema.test.ts` and `tests/unit/ai-draft.test.ts`: 146 new
  cases covering the contracts and executable TypeScript-AST import isolation.
  Every other source TS/TSX file is walked; static/type/re-export/literal dynamic
  imports resolve to enforce no production wiring. New modules' direct imports
  stay within the approved domain set; existing transitive data/i18n dependencies
  are not claimed absent.
- This append-only result record.

AI never sets manual intent. Partial results and invalid manual input remain
honest; projection introduces no validation error in applied fields. Manual
clears and same-value edits remove AI attribution. Expiry preserves visible
unverified values, then a new photo clears only untouched AI derivation. Tests
explicitly retain the current manual-only builder's rejection of non-default
AI-filled creation fields, before and after expiry.

### Actual native validation

The first domain typecheck found three readonly-array parameter mismatches;
the projection helper was corrected before the successful targeted run.
Unit/static and Vite-backed browser suites ran sequentially.

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/ai-schema.test.ts tests/unit/ai-draft.test.ts tests/unit/garment-fields.test.ts` | 283/283, three files, exit 0. |
| `npm run test:unit` | 968/968, 17 files, exit 0. |
| `npm run lint` | Exit 0. |
| `npm run typecheck` | Exit 0 after the readonly parameter correction. |
| `npm run check:translations` | 471 EN/FI/SV keys, 45 source files, exit 0; no new UI strings. |
| `npm run build` | Exit 0; JS 174.80 kB gzip, CSS 5.33 kB gzip; existing non-failing >500 kB chunk warning. |
| `npm run scan:secrets` | 176 text files and build canary checked, exit 0. |
| `npm run check:dependencies` | 12 production/220 development packages, zero unverified release dates; production audit zero critical/high/moderate/low findings, exit 0. |
| `npm run test:browser -- --retries=0` | First run: 320 passed, 129 WebKit launch failures because pinned `webkit-2359/pw_run.sh` was absent, exit 1. No source correction. |
| `npx playwright install --with-deps webkit` | Existing pinned engine restored only after the missing-engine failure, exit 0; no package/version/config changes. |
| `npm run test:browser -- --retries=0` | Final 449/449, 6.5 minutes, exit 0. |
| `npm run test:a11y -- --retries=0` | 33/33, 53.1 seconds, exit 0 after full browsers. |
| `git diff --check` | Exit 0. |

Build and secret scan shared an unprinted process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`. Synthetic test captures
remain ignored and unopened; no new capture or browser specification was added.
The existing native final checker is invoked once after candidate commit and
process completion; its actual components/results/unavailability are reported
on PR #15, not predeclared here. No self-hash-only follow-up commit is needed.

### Unwired integration destinations and remaining gates

All four migrations and 22312-byte generated types remain byte-identical.
No extra DB start/reset/up/list/provision/psql/typegen/rehearsal, hosted operation,
provider call, dependency change, Actions approval/rerun, merge or deployment.
These are unit/synthetic-browser results, not fresh normal-owner DB evidence.
The coordinator owns exact-head execution trust, genuine independent finished-code
review and fresh CI four-source preservation, ordinary ownership/security/recovery
and actual generated-type parity. Production isolation is executable and no UI
changed, so this packet adds no screenshot-download/review cycle or waiver of
future visual gates.

Next real integration must authenticate the analysis adapter and construct
authoritative receipts; implement consent/allowances and server admission;
connect editable draft UI and local title/description/tags composition; and
authenticate checked Save against its own clock, receipt, current photo and
exact values/kinds. Claims contain no owner target, revisions or provider config.
Conflicts must not silently downgrade into a successful write. Source-image
binding follows successful image commit in that later design. Client pending
state is not atomic server admission/cost enforcement, and reference invalidation
does not erase previously delivered data or outside references.

Saved-only export, legacy imageless/failed-Save ambiguity, receipt/storage schema
and provenance widening remain open: item-row existence is not completed Save.
No provider eligibility or proposed spending figure is approved here. Live
`31bdd067`/source `9d1858`, hosted base+I29a and unapplied hosted I29b/I29c remain
unchanged. Dated B3/counter/device/operator limitations remain pending, not waived.
This finishes only the bounded unwired foundation, not automatic tagging or the
MVP. Stop after the final candidate/checker report for parent review and current CI.

## I29e Stage 1 — persistent request controls, 9 September 2026

**Source-only staging, not completed database/AI acceptance.** This append
preserves the preceding 155139 bytes. The packet is I29/R18/R19/R23/R26/R27/R28,
on existing PR #16, branch `copilot/newpr-15-stage1-only`, approved base
`0d27eb0e3ea9730ae641d915b28375d7b8435ede`, reviewed tree
`89afde0a3b27c25b6079cf5b50c78692a2ea159e`, starting head
`4f2fe11bec1d03bb97fb21fcfb357f5bd7b4b937`. The initial head has no source diff.

### Authority and context

The full accepted plan is `5607052777`; fixture clarification
`5607520616` permits finite named normal children inside S4, not privileged
owner impersonation. The coordinator records actual different-provider
**Anthropic / Claude Opus 5**, reviewer
`ddfa71a0-2487-4281-9203-09f42ee62785`, accepting the original mechanical
corrections and this clarification. Controlling corrections include preserved
twelve old profile UPDATE grants, per-request tombstones, profile-first mutex
across periods, post-lock clock, fixed original expiry, separate financial/
content decisions, explicit target-owner admission and genuine two-owner fixtures.
No new planning authority, agents or provider choice was invented by this worker.

After context and before edits, this continuation reread its **own**
[public receipt 5607561177](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5607561177):
task `bf4e0849-36a0-4f17-9051-76287ce12d1b`, session
`3ad49710-1c51-4e81-97b8-c72c569604c1`, explicitly selected `gpt-6-astra`,
coordinator-authenticated actual `sweagent-capi:gpt-6-astra`, immediate observation
19:30:04.1159871Z and full model/ref/sole-writer verification 19:31:26.6157664Z.
PR/base/head/branch match this checkout. Receipt `5607099391` is historical,
not this session's attestation.

Read root/Copilot instructions, cloud guidance, Phase 0/current Phase 2 evidence,
local-backend guidance, relevant blueprint/phase/AI requirements and current
I29 issue/API/data-model sections; actual base and provenance migration excerpts,
shared AI/garment/provenance/preferences/UUID contracts, generated-type state,
reset/local guards/provisioner/normal runner, existing normal-session modules,
preservation implementation/tests and CI/Playwright/package validation contracts.
PR #16 discussion, empty initial diff, reviews and review threads were read.
Initial CI `34391750557` was `action_required`: job-log lookup returned zero
jobs, not a failed assertion or a pass. No Actions approval/rerun occurred.

### Delivered source boundary

Fifteen approved Stage 1 paths change. Generated types remain exactly 22312 bytes,
SHA-256 `6787f9a2a776db922d0e424d7bfb11746854dd896bbabeec3fd2f359cd5dd759`.
All four historical migrations, production domain/UI/Auth/image implementations,
old ordinary integration/security modules, core provisioner, backend helpers,
packages, CI and setup configuration remain unchanged.

The additive `20260909180000_ai_request_controls.sql` is 28579 bytes, SHA-256
`f3c263ef16035a1ac07afe9911faf2ab27ed3a72b730f5db0168a0180df02ade`.
It adds protected profile consent, private operator controls, minimal per-request
usage/tombstones, temporary full requests and seven bounded RPCs. There is no
default operator policy, provider/Edge endpoint, photo transfer, inventory write,
saved marker, item AI authority, checked Save or scheduler.

Reservations/replays/dispatch/billing/discard/expiry serialize on the owned
profile first. The server derives time and period after the lock; exact arithmetic
counts current settled cost plus all outstanding holds, including prior periods.
NULL cost is unknown, zero is known, and overruns/late anomalous charges are
recorded without content resurrection. Only one eligible dispatch claim exists.
The validated fourteen-field result keeps its original expiry. Export v2 excludes
active consent, not old imageless/pending library rows; saved-only remains open.
`blueprint/08` documents exact parameter, JSON and denial/status contracts.

The new setup seeder runs only after full-reset core provisioning. It forwards
the existing opt-in through the stripped command environment, never manufactures
one, fetches an admin key or changes a core guard. Fresh version-one core
profiles/preferences and empty wardrobe/AI tables are required; used fixture
state is refused. P1/P3/P5 and named S4 children
use strict normal-session environments and real A/B HTTP. S2/S4/S6 privileged
work is operator/server/timestamp/structural only. Both policies share fictional
model/prompt/notice; A's 15000 allowance/rate 20 and B's 100000 allowance/rate 3
isolate cap/rate races. Scratch cost/counts are retained without policy resets.
Final expected state is two distinct ready results, fourteen ledger rows, twelve
explained closures, no unknown holds and accounted A/B totals 16001/0.
These are **test assertions awaiting real CI execution**, not observed DB results.

P3 includes populated ordinary-owned item/image/outfit/history preservation,
actual authenticated downloads of the existing synthetic fixture bytes, and
exact cleanup, plus unchanged profile timestamps/versions around reservation
and status locks. Other named phases exercise the required server financial/content
guards; the limit-one purge removes one of two expired full requests, leaving
the second for normal owner cleanup. Named paired timestamps are fixture-seeded,
not elapsed real-time retention. Later full integration/security suites are
non-consuming/re-runnable, with both-direction real ready-data isolation,
anonymous and server-RPC denials, SQL grant/RLS versus Data API refusal separation,
profile column protection, tombstones and export exclusion.

Preservation now pins five sources and checks base-only/four pending → one
existing migration-up → five applied/none pending. It keeps original COLUMNS,
two owners/ten tables/thirty rows/eight objects, raw values/timestamps/versions,
downloaded byte comparisons and the bounded run-owned snapshot. Normal reads
assert the three new profile defaults separately, without changing the old-row
oracle. The final export source body is 1511 bytes,
MD5 `689a81770938d05caa3a3f800ae3ecef`; base expectation remains unchanged.
The seeder structurally checks the actual final executable body/attributes.
No seeder runs in the base rehearsal.

### Actual native validation

No native database startup/reset/up/list/provision/psql/type generation/rehearsal
was run. The new SQL, normal-session tests and server fixtures have **not** been
executed against a database in this session.

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/ai-schema.test.ts` | Initial 60/60; expanded SQL/shared-contract cases 62/62, exit 0. |
| `npm run test:unit -- tests/unit/preservation.test.ts tests/unit/ai-schema.test.ts` | Final 144/144, exit 0. One earlier negative test targeted the wrong SQL declaration; corrected to exact export declaration. |
| `node --check` on the seven changed `.mjs` files | Exit 0 for db, runner, rehearsal, new seeder, preservation integration and both new normal suites. |
| `npm run test:unit` | 970/970, 17 files, exit 0. |
| `npm run lint` | Final exit 0 after correcting a misplaced fixture-helper scope. |
| `npm run typecheck` | Exit 0. |
| `npm run check:translations` | 471 EN/FI/SV keys, 45 source files, exit 0. No UI strings added. |
| `npm run build` | Exit 0; JS 174.80 kB gzip/CSS 5.33 kB gzip; existing non-failing large-chunk warning. |
| `npm run scan:secrets` | 180 text files and unprinted process-local build canary checked, exit 0. |
| `npm run check:dependencies` | 12 production/220 development packages, zero unverified release dates; production audit zero vulnerabilities, exit 0. |
| `npm run test:browser -- --retries=0` | First run: 320 passed, 129 WebKit launch failures because pinned `webkit-2359/pw_run.sh` was absent, exit 1. Final run after engine installation: 449/449, 6.7 minutes, exit 0. |
| `npx playwright install --with-deps webkit` | Existing pinned engine installed after the concrete missing-executable failure, exit 0; no package/version/configuration change. |
| `npm run test:a11y -- --retries=0` | 33/33 after the successful full browser run, 54.1 seconds, exit 0. |
| `git diff --check` | Exit 0. |

Unit/static checks precede Vite-backed browsers. Synthetic captures stay ignored
and unopened; no image/archive/binary output enters the native model. The existing
native final checker is invoked once after candidate commit/process completion;
its actual components/results/unavailability are reported on PR #16, not assumed.
After browser/a11y completion, final fixture-only freshness/lock assertions were
rechecked with syntax, all 970 units, lint, typecheck, translations, build, secret
scan and dependency audit, all exit 0. Production SQL, runtime sources and browser
tests remained byte-identical to the successful browser run; no unit fixture
process ran concurrently with Vite.

### Staging and remaining gates

The writer stops for parent execution trust, genuine independent completed-code
review and first exact-head CI. Real migrations, full-reset fixture phases,
ordinary integration/security, preservation and actual type generation must
pass. **Only** old committed-type parity can be the anticipated Stage 1 staging
failure after those gates; any other failure needs a concrete scoped correction.
Nothing here claims final parity or a database pass.

Stage 2 is a separately verified same-PR continuation: coordinator verifies the
exact-head generated artifact and conveys its exact text; native imports those
bytes without opening archives, handwriting or normalizing types. Only generated
types/result append are then authorized, absent separately scoped correction.
Fresh final CI must prove generation and tracked-file/exact-diff parity.

Logical expiry and opportunistic cleanup do not promise inactive-account
24-hour physical retention. Scheduler, processor/account, notice, allowance,
deployment and paid/private-photo activation gates remain open. Full I29 still
requires authenticated endpoint/image validation, editable draft/local composition,
checked exact-value Save, source-image history/provenance, saved-only export and
normal-owner acceptance. Live `31bdd067`/source `9d1858`, hosted base+I29a,
unapplied hosted I29b/I29c, B3/counter/device/operator limits remain unchanged.
No agents, new branch/PR, main push, Actions approval/rerun, hosted mutation,
provider/budget choice, merge, deployment, Stage 2 or later packet was undertaken.

## I29e Stage 2 and reviewed Windows fixture correction — 9 September 2026

This continuation addresses I29/R18/R19/R23/R26/R27/R28 on the same PR #16,
branch `copilot/newpr-15-stage1-only`, starting at
`7c45b5e491460b0e11b725996e97c6f69ebc9d83`, base
`0d27eb0e3ea9730ae641d915b28375d7b8435ede`. All 165711 previous result bytes
are preserved; historical Stage 1 observations above are not rewritten.

Authority: [kernel plan 5607052777](https://github.com/drrowdev/stillroom-wardrobe/pull/15#issuecomment-5607052777),
[sequence addendum 5607520616](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5607520616)
and [four-path correction 5608548289](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5608548289).
The correction records actual read-only Anthropic Claude Opus 5 reviewer
`i29e-finished-code-review`, agent `6dbd2788-e067-486e-a974-25c1dbfd6401`,
and its sole actionable finding: Windows restores required OS environment names,
so strict whole-key identity blocked normal fixture children. The coordinator
approved this routine correction plus the planned exact type import; no new
architecture, scope, provider or agent was introduced.

The new [own receipt 5608594646](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5608594646)
was read again after context and before edits. It records explicitly selected,
authenticated actual `sweagent-capi:gpt-6-astra`, task
`29a66b76-dae5-4601-918f-c3b5dcf40c49`, session
`9ed64078-5765-40c3-86d6-59e32d1265b5`, immediate verification
20:52:17.6462935Z and full model/ref/sole-writer verification 20:53:26.4703748Z.
The old receipt is not reused.

Context read includes root/Copilot instructions; cloud task-scope/text-only rules;
Phase 0/current Phase 2 and local-backend evidence; blueprint 00/03/05/10/14/20
and relevant 07/08 excerpts; current controls SQL/generated types; core local
environment validation, AI/preservation normal modules and unit tests; package
commands; PR #15/#16 plans/discussion, current PR refs/diff/reviews, CI run list
and failed job logs. PR #16 had no formal reviews returned by the review API;
the actual independent review is recorded in the coordinator correction above.

### Four-path delivery and exact type provenance

`assertAiSessionEnvironment` retains `normalSessionEnvironment` unchanged.
Only `win32` folds names, accepts equal aliases and the eleven reviewed libuv OS
names, and rejects conflicting aliases. Other platforms retain strict names.
Expected normal values are checked; arbitrary extras, empty secret/deployment
variables and invalid credentials/target/opt-in remain refused. The normal HTTP
client receives the validated stripped copy. Caller input is not mutated; no
values or identities are added to logs. The explicit platform argument is used
only by unit regressions; actual fixture execution defaults to `process.platform`.

The local types were already modified on arrival. Their bytes were compared
directly with the coordinator's complete [public type text 5608562747](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5608562747):
exactly 23625 UTF-8 bytes, LF/no BOM/final LF, SHA-256
`5bde16ca89f7ed857533be2727025160b81c4fc9041ec523360e59c2601eb71c`.
They were retained without modification and committed as `145d85c`.
Provenance is artifact `10123552461`, CI run `34399243001`, head `7c45b5e`.
No archive was opened, no types were reconstructed/normalized, and no native
generation was run. The frozen 28579-byte SQL retains SHA-256
`f3c263ef16035a1ac07afe9911faf2ab27ed3a72b730f5db0168a0180df02ade`.
Only the integration module, its existing ai-schema unit file, generated types
and this append change. Core helpers, choreography, all SQL, UI/runtime,
browser/a11y sources, packages and workflows remain byte-identical.

### Actual continuation validation and limits

Commands below ran from the repository root, sequentially; all exited 0.

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/ai-schema.test.ts tests/unit/preservation.test.ts` | 165 tests, two files; includes 21 new environment regressions. |
| `node --check tests/integration/ai-controls.sessions.mjs` | Syntax pass. |
| `npm run test:unit` | 991 tests, 17 files. |
| `npm run lint` | Pass. |
| `npm run typecheck` | Pass. |
| `npm run check:translations` | 471 EN/FI/SV keys, 45 source files. |
| `npm run build` | Pass; JS 174.80 kB gzip/CSS 5.33 kB gzip; existing non-failing chunk-size warning. |
| `npm run scan:secrets` | 180 text files and unprinted canary checked. |
| `npm run check:dependencies` | 12 production/220 development packages; zero unverified release dates; production audit zero vulnerabilities. |
| `git diff --check` | Pass. |

Windows cases are Linux-hosted simulated-platform regressions, not physical
Windows execution or Windows database proof. The earlier native 449 browser/33
a11y results carry only because runtime/browser/a11y sources remain byte-identical;
neither suite was rerun here. No native DB/start/reset/provision/psql/typegen/
rehearsal, hosted operation, provider call, image download or Actions approval/
rerun occurred.

[Stage 1 real evidence 5608419914](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5608419914)
records five-source preservation, 18 fixture phases, normal A/B, recovery and
actual generation. The inspected failed job `102632541553` confirms old-type
parity as the staging failure, not a final pass. Fresh final current-head CI
must still prove browser/native, real preservation/fixtures/recovery, generation
and exact parity, followed by coordinator precise closure. The existing
new-candidate native checker is invoked once after commit/process completion;
its actual components or unavailability are reported publicly on PR #16.
The earlier native checker remains unreported, not retroactively passed.
The writer then stops; no merge, deployment, paid/live activation or later
packet is authorized by these results. All previous manual/operator/device and
remaining I29 integration/retention gates stay open.

## PR #17 checked manual Save/A1 — Stage 1 source, 10 September 2026

**Database-blocked staging, not a connected Save implementation or merge-ready
packet.** Existing branch `copilot/new-i29-checked-manual-save`, approved base
`c6ee8beb890deeca0c04cf53d6d3deebe4a231f6`, starting/saved head
`46c53668f5ed13d2b5147fa873e61964f0210acb`, tree
`a1413580bd53c0651d9f2a004df793af5ff2da9b`. The starting head was an empty
single-parent commit against that exact base; working tree and PR diff were clean.
This append preserves all preceding dated evidence.

### Own authority and read context

Read the complete [plan 5614413353](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5614413353)
and complete [A1 amendment 5614726097](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5614726097).
Actual different-provider reviewer: Anthropic / Claude Opus 5
(`claude-opus-5`), read-only `d27104d9-e844-42b7-9f7f-a0a6723ba2dc`, turns 3/4.
Their recorded AMEND findings and coordinator adjudication narrow this to manual
checked Save and retain **three** UUIDs, not the rejected weaker two-column
alternative. No new agent/reviewer or scope was invented by this worker.

After context and before source edits, reread this continuation's
[own receipt 5614750064](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5614750064):
task `0afd7714-d002-4ce5-9241-ba5e0a0e9eed`, session
`93155b42-57ac-43a8-8d60-1c427f5eee85`, explicitly selected `gpt-6-astra`,
coordinator-verified actual `sweagent-capi:gpt-6-astra` at
`2026-09-10T07:23:28.2328469+00:00`, matching repository 1358925513,
PR #17, branch, base and saved head. Original receipt 5614441409 was not reused.

Actually read root `AGENTS.md`, `.github/copilot-instructions.md`, both blueprint
instruction templates (not copied), cloud task-scope/text-only/local/hosted gates;
Phase 0/1 relevant acceptance and Phase 2 I29d/e evidence; blueprint
00/02/03/05/06/08/10/14/15/19/20 and relevant 21 model-gate sections.
The complete base migration was read and compared byte-identical to blueprint07;
provenance, description and collection migrations plus AI18 profile/table/lock
sections were read. Source included actual generated item/image/RPC types,
`src/images/upload.ts`, `src/domain/garment-fields.ts`, AddItem's frozen-submit
flow, data errors/package/db commands; normal backend guards, session client,
wrapper, preservation schema/oracle/rehearsal/tests, normal integration/security
examples, affected unit tests and browser mock/upload boundary excerpts.
PR discussion/diff/reviews/review threads and current Actions metadata were read.

This is I29's R03 explicit-creation and R04 private-photo subset, preserving
R01/R11/R17/R19/R26/R27; R23 is predictable retries/concurrency. R22 means original
product, not reliability. No complete-CRUD, automatic AI, full-I29 or MVP claim.

### Observed local database blocker and approved fallback

Current native setup run `34449644831`, job `102782229098`, reports successful
dependency/browser install, Docker, startup, reset/provision and type generation.
The MCP job-log request returned HTTP 404; metadata alone is not execution proof
of the new source. Initial CI `34447378905` and JPEG diagnostic `34447378909`
were `action_required`; CI log lookup returned zero executed/failed jobs, not a
pass. No Actions authorization/rerun occurred.

`npm run db:start` passed. After writing the new SQL, the first
`npm run db:reset && npm run db:types` stopped at reset, exit 1, before
provisioning; **type generation did not run**. A bounded PostgreSQL error-log
query returned no matching diagnostics. Through existing guarded local helpers
(`assertProjectConfig`, `requireLocalContainer`, `cli`), `migration list --local`
then showed all six application migrations pending; diagnostic
`migration up --local` failed in unchanged `20260905000000_initial.sql`,
statement 69: `relation "storage.buckets" does not exist` (42P01).
No new SQL execution or causal claim about the reset's underlying failure follows.

No repeat reset, service/config repair, fake Storage schema, guessed types or
runtime restart was attempted. The plan's expressly approved same-PR Stage 1
fallback applies: SQL/tests/preservation/docs only, then stop for coordinator
execution-trust review and actual Database CI. Stage 2 requires independently
published exact-head type text/hash and a fresh own runtime receipt before
connecting every current manual AddItem Save. Current client/types/browser
sources remain byte-identical; `ensureFile`, upload bytes/options/order,
manual builder, owner epoch and form behavior have not changed.

### Staged source boundary

The only new migration is `20260910070000_checked_item_save.sql`. It specifies
closed ordinary-session atomic reservation, canonical typed intent fingerprint,
live-row/initial-version/caption/counter checks, exact object-aware finalization,
and three-UUID owner-local used-ID guards. Content attempts cascade on item
deletion; image cleanup nulls only their image link; markers last until actual
profile deletion. No fields/hash/time/status enter those markers.

The original commit function is moved intact behind a private non-client seam.
The public wrapper guards either used item or used image identity, preserving
genuine legacy grants, with no raw-row adoption/backfill. New calls lock profile
first, then use NOWAIT on reverse-order attempt/media/item/object edges and a
two-second lock timeout for residual uniqueness/FK waits. Specific conflicts
roll back, not succeed. Existing delete/retire/description behavior is unchanged.
This is reviewed source design, **not executed concurrency proof**.

New integration/security suites use existing `normalClient` with normal A/B/
anonymous PostgREST and the same stripped wrapper environment. They specify
pending/completed exact replay, canonical price/provenance, all-field/image
conflicts, malformed/system/AI assertions, no partial/failed first claim,
foreign/swapped IDs, original/alternate/raw-recreated commit bypass, hard deletion,
missing objects even when ready, cleanup, caption/counter/item changes, owner-local
UUID reuse, genuine legacy success, and bounded overlapping operations.
Tiny synthetic transport bytes prove no JPEG/camera or analysed-byte attestation.
Catalog-only checks specify private ACL/RLS and exact profile/item/image FKs;
no normal fixture profile is deleted to fake account-deletion acceptance.

Preservation now pins six exact migration sources, retaining every old length/hash
and the original COLUMNS, two-owner/ten-table/30-row/eight-object byte oracle.
The normal wrapper still executes existing AI18 and recovery gates. New catalog
checks run only after the original populated comparison. Blueprint06/08 document
the staged protocol; blueprint10 adds only A1's minimal pseudonymous retention
boundary. One row per successful reservation, including abandoned attempts,
accumulates until actual profile deletion; no scheduler, total-growth bound or
working self-service deletion claim.

### Actual validation and remaining gates

Commands ran at the repository root. These are source/unit results, not live
database or connected-client acceptance:

| Exact command | Actual result |
| --- | --- |
| `node --check tests/integration/item-save.sessions.mjs` | Pass. |
| `node --check tests/security/item-save.sessions.mjs` | Pass. |
| `node --check scripts/run-local-tests.mjs` | Pass. |
| `node --check scripts/preservation-rehearsal.mjs` | Pass. |
| `npm run test:unit -- tests/unit/item-save.test.ts tests/unit/preservation.test.ts tests/unit/local-backend.test.ts tests/unit/garment-fields.test.ts tests/unit/private-images.test.ts` | First 402 passed/12 failed: one shared five-source expectation omitted the sixth migration. Corrected that expectation; final 414/414 passed. |
| `npm run typecheck` | Pass against unchanged current generated types; not new-RPC parity. |
| `npm run lint` | Pass. |
| `npm run check:translations` | 471 EN/FI/SV keys; 45 source files, pass. |
| `npm run test:unit` | 1000/1000, 18 files. |
| `npm run build` | Pass; existing non-failing chunk-size warning, unchanged 174.80 kB gzip JS/5.33 kB gzip CSS. |
| `npm run scan:secrets` | Pass, 184 text files and unprinted canary. |
| `npm run check:dependencies` | Pass, 12 production/220 development packages, zero unverified release dates, zero production advisories. |
| `git diff --check` | Pass. |

Actual fresh schema execution, six-source populated preservation, five-to-six
populated transition, structural catalog results, all new/old normal-session
integration/security, AI18's 18 phases, recovery, actual generated types/parity,
connected client/browser/axe and coordinator exact-head artifact review remain
**pending**. No browser/visual run or image/archive input was used in this staging
continuation. Static checks do not establish SQL execution or normal-user access.
The coordinator must validate the frozen source before authorizing Database CI;
no Stage 1 merge. A fresh native validation result will be reported on PR #17
after committing; it cannot replace the required independent exact-head review.

Rollback at this un-applied source stage is reverting the packet; no hosted DDL
or data rollback is authorized. Live Cloudflare `892f9419`/hosted05+06+09+11
remain unchanged, AI18 unapplied, operator window closed. B3's WebKit two-byte
parallel failure remains unlocalized/unfixed; prior PR16 acceptance is not a
waiver. Only the second hosted-account journey is deferred; other foreign-normal,
camera/device/screen-reader gates remain open. Automatic form filling,
analysed-byte binding, expiry/provenance/source history and parked incomplete
backup remain required later work. No AI/provider/codec/dependency, hosted,
private-input or paid operation was performed.

## PR #17 A2 — bounded failure observations, 10 September 2026

**Diagnostics only; backend still blocked, cause unproven.** This continuation
starts from `95f655126b2d68064d32ed2e0e3db03f4fb671c9`, parent
`46c53668f5ed13d2b5147fa873e61964f0210acb`, on the existing
`copilot/new-i29-checked-manual-save` branch. PR base/main remains
`c6ee8beb890deeca0c04cf53d6d3deebe4a231f6`. Initial checkout was clean:
no setup-generated type changes or other untracked source outputs.

Read complete [A2 approval 5615708093](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5615708093),
original plan 5614413353 and A1 5614726097. A2 records actual read-only
Anthropic / Claude Opus 5 (`claude-opus-5`) critique by
`9edf6b92-27a7-47ce-b963-949860fe50a4`, turn 1, verdict AMEND, and
coordinator approval/corrections. Accepted: stderr-only fixed observations,
stdout byte count only, closed runtime shape and preserved guards. The
coordinator corrected the claim that cold startup cannot apply migrations;
both start/reset retain SQLSTATE and migration observations. No new agent,
planning round or speculative repair was performed.

After context and before edits, read this allocation's
[own runtime receipt 5615746110](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5615746110):
task `dffecda2-8b06-4f14-948b-5af6b36faf8e`, session
`1409c392-cecd-4662-b9de-9ea6fb53feb5`, coordinator observation
`2026-09-10T08:42:22.1136042Z`, explicitly selected `gpt-6-astra`,
independently verified actual `sweagent-capi:gpt-6-astra`, repository
1358925513/PR #17 and matching branch/base/saved head. Old receipt 5614750064
was not reused.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`;
cloud task-scope/text-only/hosted sections; Phase 0/1 status, Phase 2 current
I29/PR17 evidence and `docs/local-backend.md`; blueprint 00/03/05/08/10/20,
Phase 2 in 14, relevant 02/15 requirement excerpts and base 07 admission/RLS
prerequisites. Source included actual initial-migration RLS/Storage excerpts,
checked-Save migration/state guards, generated schema/RPC excerpts,
`scripts/db.mjs`, complete `scripts/backend/local.mjs`,
`scripts/hosted-smoke.mjs` guard excerpts, complete local-backend unit tests,
checked-Save unit excerpts and `package.json`. Read current PR details,
discussion, diff scope/relevant hunks, reviews/review threads, Actions metadata
and failed Database job logs. This is observability for I29's R03/R04 subset,
preserving R01/R11/R17/R19/R23/R26/R27, not full CRUD or I29 acceptance.

### Four-file implementation boundary

Only `scripts/db.mjs`, `scripts/backend/local.mjs`,
`tests/unit/local-backend.test.ts` and this dated append changed.
The new pure helper initializes all eleven fields on every return, reads own
data descriptors, refuses malformed/throwing reflection and bounds direct
string inputs to 16 MiB combined UTF-8 bytes before marker scanning. Invalid
inputs return closed defaults. Stdout is never scanned for content.

Stderr observations use the eight existing Docker literals, the unchanged
strict 4096-byte/single bare container-exit gate, exact parenthesized SQLSTATE
format with eleven allowed constants, six exact LF/CRLF migration announcements
and the verified port literal. Distinct observations report `multiple`;
announcements are deduplicated and the last index follows stderr order, not
version order. No arbitrary input text or property is returned. The existing
bounded capture remains unchanged, so the report guarantees neither output
completeness nor absence of unobserved errors.

Source evidence is the pinned dependency record in A2: CLI 2.116.0
`internal/utils/docker.go` (blob `29d2edd3974087e25ca0430ac15d5a1c0483c7c8`),
`pkg/migration/apply.go`, Go/legacy cold-start database bootstrap paths and
pgconn v1.14.3 `errors.go`. These verified literals are observations, not a
diagnostic cause. No guessed disk/rate-limit/deadline classifier was added.
All pre-existing local helpers, including `runCommand` and
`describeGenerationResult`, remain byte-identical. Existing CLI arguments,
timeouts, human failure prefixes and wrapper exits remain unchanged. Only
elapsed timing and JSON of the new report are appended in the existing
start/reset nonzero branches. Success behavior is unchanged.

### Actual commands and stopping evidence

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/local-backend.test.ts` | Initially 260 passed/1 failed because the new test wrapper defaulted explicit `undefined` elapsed input to 1. Corrected the wrapper; 261/261 passed, including all 183 pre-existing tests and 78 new cases. |
| `npm run typecheck` | Pass; unchanged generated schema, not new-RPC parity. |
| `npm run lint` | Pass. |
| `npm run scan:secrets` | Pass; 177 text files and unprinted canary. |
| `git diff --check` | Pass. |
| `npm run db:start` | One invocation; wrapper exit 2. Bounded report below. No retry. |

Exact bounded startup report:

```json
{"tag":"nonzero-with-stderr","exitCode":1,"elapsedMs":18529,"stdoutBytes":0,"stderrBytes":245,"stderrDockerOperation":"run-container","stderrContainerExitBucket":"other-nonzero","stderrSqlState":"none","announcedKnownMigrationCount":0,"lastAnnouncedKnownMigrationIndex":null,"stderrPortAllocationMarker":false}
```

The wrapper preserved its original protected failure prefix and exit 2.
No raw CLI output was exposed. `none`, zero announcements and a false port
marker are not proof that SQL, migrations or ports were uninvolved.
The observed bucket does not identify a cause. Startup failed, so **reset was
not run**, nor were types, normal integration/security, recovery or preservation.
No backend repair, alternate command, service restart or hidden-output bypass
followed this single failed action.

Separately, historical CI `34451006155` attempt 2 at saved head `95f655126`
failed Database job `102792343131` in startup, about 51 seconds after its
announcement, at `08:02:06Z`; all later database gates/types were skipped.
Outcome 5615471418 records App job `102792343527` passing 1000 units/449 browser
cases. Source review 5615571684 found no high-confidence blocking source bug.
Neither establishes execution of the new SQL. The old worker's missing
`storage.buckets` observation remains separate evidence, not the diagnosed
cause of either startup failure.

Fresh-head executable trust/CI, independent source review and native validation
results are handed back to the coordinator. SQL/preservation/normal-session/
recovery/type parity and required browser/visual/human gates remain pending,
not waived. No image/archive inputs, Actions authorization/rerun, additional
writer/branch/PR, merge, deployment, hosted/provider/private-photo operation,
guessed types or client wiring occurred. The live operation window remains
closed. Rollback is reverting these diagnostics, not hosted DDL or data repair.

## PR #17 — narrow IF/CASE syntax repair, 10 September 2026

**Source correction only; real database validation remains blocked.** Same branch
`copilot/new-i29-checked-manual-save`, base/main
`c6ee8beb890deeca0c04cf53d6d3deebe4a231f6`, starting head
`9b3928637b082cc11bb45e8386aac0b3492a1fbc`, starting tree
`d1b7737266290b06f2cfa741b5881aaed928cbd3`, starting parent
`95f655126b2d68064d32ed2e0e3db03f4fb671c9`. Initial `git status --short`
was empty: no tracked setup changes or untracked generated types. The clone is
shallow; `git merge-base HEAD refs/remotes/origin/main` returned exit 1, not
ancestry proof. GitHub PR metadata and the local remote-tracking main both
identify the approved base above. No branch/history mutation was needed.

### Authority, own receipt and context

Read full [repair authorization 5616223669](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5616223669),
[plan 5614413353](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5614413353),
[A1 5614726097](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5614726097)
and [A2 5615708093](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5615708093).
Their actual Anthropic / Claude Opus 5 critiques and coordinator adjudications
remain controlling: plan/A1 reviewer `d27104d9-e844-42b7-9f7f-a0a6723ba2dc`,
turns 3/4; A2 reviewer `9edf6b92-27a7-47ce-b963-949860fe50a4`, turn 1.
Read source-review records 5615571684 and 5616125168 and execution-trust record
5616021139. No new planning round, behavior amendment or additional agent.

After context and before any edit, read this allocation's
[own public runtime receipt 5616267125](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5616267125):
task `40c50a4d-7a9d-430a-9653-e695f7a6a9a3`, created
`2026-09-10T09:22:32.369760818Z`; session
`5424ce1b-808c-4aef-8330-68c67f72c46e`, created
`2026-09-10T09:22:36.403864042Z`. Coordinator publication observation
`2026-09-10T09:23:31.5759424Z` records explicit `gpt-6-astra` selection and
authenticated actual `sweagent-capi:gpt-6-astra`, matching repository 1358925513,
PR #17 / 4492828082, branch, base and starting head/tree/parent. No old receipt
was reused or model availability self-attested.

Actually read root `AGENTS.md`, `.github/copilot-instructions.md`; cloud
task-scope/text-only/setup/hosted sections; Phase 0 status/recovery limits,
Phase 2 PR17/A1/A2 evidence and local-backend baseline sections; blueprint
00/03/05/10/14/19/20, relevant 07 admission/schema and 08 API/checked-Save
sections. Source reads included the complete checked-Save migration, actual
initial-migration RLS/grants/commit excerpts, generated RPC type excerpts,
`package.json`, `scripts/db.mjs`, preservation inventory/catalog/oracle excerpts,
checked-Save unit tests, preservation inventory tests and normal integration/
security Save excerpts. Read current PR details, discussion, diff scope/relevant
hunks, empty reviews/review threads, Actions run/job metadata and failed CI job
logs. I29 R03/R04 scope and preserved R01/R11/R17/R19/R23/R26/R27 are unchanged.

### Five-path repair and actual validation

Only the two parentheses around the existing state CASE changed in
`supabase/migrations/20260910070000_checked_item_save.sql`; every other SQL byte
is retained. The coordinator's PostgreSQL 17 parser finding explains why an
unparenthesized CASE's first THEN can terminate the PL/pgSQL IF expression.
This restores the reviewed comparison, not a new state/authority contract.

Measured SQL identity changed from 16315 bytes /
`9e782cff2cc18d2db8ee2f7c7bc6096de80c011cd9c0b6b83ef5a24783ac9bf3`
to **16317 bytes** / SHA-256
**`9058de2f231c72fc71b930f03e176457aee20de0cf82cab909fc21e879eaaac3`**.
Only that byte length changed in `scripts/preservation-rehearsal.mjs`;
only `SOURCE_HASHES.save` changed in
`tests/integration/preservation.sessions.mjs`. Added one narrowly scoped,
explicitly static IF/CASE regression in `tests/unit/item-save.test.ts`.
This dated append is the fifth permitted path. Old five migrations and original
oracles, A1 markers/cascades/raw grants, A2 diagnostics/guards/commands,
client/generated types and all other files are unchanged.

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`:

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/item-save.test.ts tests/unit/preservation.test.ts` | Exit 0; 91/91 tests, two files. Static source/inventory evidence, not SQL execution. |
| `npm run typecheck` | Exit 0; unchanged generated types, not new-RPC parity. |
| `npm run lint` | Exit 0. |
| `npm run scan:secrets` | Exit 0; 177 text files and unprinted canary checked. |
| `git diff --check` | Exit 0. |
| `npm run db:start` | Exactly one corrected-source invocation; wrapper exit 2, safe report below. |
| `npm run db:reset` | Not run: startup failed. |
| `npm run test:integration` | Not run: dependent database sequence stopped. |
| `npm run test:security` | Not run: dependent database sequence stopped. |

```json
{"tag":"nonzero-with-stderr","exitCode":1,"elapsedMs":19225,"stdoutBytes":0,"stderrBytes":245,"stderrDockerOperation":"run-container","stderrContainerExitBucket":"other-nonzero","stderrSqlState":"none","announcedKnownMigrationCount":0,"lastAnnouncedKnownMigrationIndex":null,"stderrPortAllocationMarker":false}
```

No raw CLI output, retry, reset, alternate diagnostics, config/provisioning
workaround or speculative further SQL repair followed. `none` and zero
announcements mean no such markers observed, not proof of no SQL involvement.
This run-container observation does not prove the syntax repair resolves the
clean-CI error or any other startup cause.

### Separate failures and remaining gates

Read CI `34457240609` attempt 2 / Database job `102813409228`: at starting
head `9b392863`, startup failed at `09:14:31Z`, wrapper exit 2. Its safe
report recorded 51101 ms, 0 stdout bytes, 11145 stderr bytes, SQLSTATE `42601`,
six known migration announcements, last index 6, Docker operation `none`,
container exit bucket `unclassified` and false port marker. This is distinct
from the corrected-source native observation above; no successful new migration
application or actual new types are established by either.

Separately, this native setup run `34460291715` / job `102816260809` reports
startup failure during `09:23:53Z`–`09:24:47Z`, before implementation. Provisioning
and actual type generation were skipped. The in-progress job-log endpoint
returned HTTP 404; only setup step metadata was available, so no exact setup
CLI report or cause is claimed. The failed shell context lookup (`rg` unavailable,
exit 127) was replaced by read-only views/grep, without installing tooling.

Fresh corrected-head CI/execution-trust review, successful migration application,
six-source populated preservation, ordinary integration/security/concurrency,
AI18/recovery and actual generated types/parity remain pending. No `db:types`
command or generated-file edit occurred. Coordinator owns first fresh-head CI,
exact type-artifact evidence and separately verified connected Stage 2. No
unconnected Stage 1 merge or complete I29 claim. Required visual/device/human
gates remain open; no images/archives/browser captures were used. No Actions
authorization/rerun, hosted mutation, deployment, paid/provider/private-photo
operation or extra writer occurred; the live operation window remains closed.

## PR #17 A3 — legacy replacement ordering and closed stages, 10 September 2026

**Eight-path source repair; new ordinary-session execution remains blocked.**
Existing branch `copilot/new-i29-checked-manual-save`, main/base
`c6ee8beb890deeca0c04cf53d6d3deebe4a231f6`, starting head
`659a376068feeaee2691696bf64abaecd14ddc77`, tree
`af9a3254c52e367912e072e3fae12e2431327abc`, starting parent
`9b3928637b082cc11bb45e8386aac0b3492a1fbc`. Initial checkout was clean;
no setup-generated type delta or untracked source output was present. This
append retains the preceding historical evidence, not a claim of Stage 1 or
full I29 acceptance. Requirements: I29 R03/R04 subset, preserving
R01/R11/R17/R19/R23/R26/R27.

### Authority, own receipt and context

Read complete [A3 approval 5617117513](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5617117513),
original plan 5614413353 and A1 5614726097/A2 5615708093. A3 records actual
Anthropic / Claude Opus 5 (`claude-opus-5`) reviewer
`9edf6b92-27a7-47ce-b963-949860fe50a4`, turns 4/5, and coordinator approval.
Turn 4's deletion shortcut was rejected and retracted in turn 5. The approved
amendment keeps profile-first admission, waits on ready media before target/parent,
revalidates identity and retains the post-parent NOWAIT ready recheck. Predicate
NOWAIT alone is not phantom protection, and the private owner helper is not the
only possible source of profile locks. No additional agent or review was launched.

After context and before edits, read this allocation's
[own runtime receipt 5617144094](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5617144094):
task `021f0265-e284-46ea-ab93-7aebaf2b9099`, created
`2026-09-10T10:26:24.623194195Z`; native session
`8bf09eeb-b126-47d1-944d-0cd88b2d0b9d`, created
`2026-09-10T10:26:26.980668962Z`. Coordinator observation
`2026-09-10T10:27:40.8929653Z` records explicit `gpt-6-astra` selection and
authenticated actual `sweagent-capi:gpt-6-astra`, repository 1358925513,
PR #17/artifact 4492828082 and matching branch/base/start head/tree/parent.
No old receipt or prompt model label was substituted.

Actually read root `AGENTS.md`, `.github/copilot-instructions.md`, both blueprint
instruction files (not copied); cloud task-scope/prepared/text-only/hosted rules;
Phase 0 status/recovery, Phase 2 PR17/A1/A2/syntax evidence and local-backend
baseline. Blueprint reads: 00/03/05/14/19, relevant 02 requirement IDs,
07 image/RLS/grant/legacy-RPC sections, 08 description/checked-Save contracts,
10 privacy/deletion and 20 photo-first/Save/AI gates. The base migration matches
blueprint07 byte-for-byte. Source reads included base image/grant/commit/retire/
forget implementation, description migration, AI18 profile-lock excerpts, complete
checked-Save migration, generated item/RPC type excerpts, `src/images/upload.ts`,
`package.json`, `scripts/db.mjs`, local and hosted guard excerpts,
`scripts/run-local-tests.mjs`, preservation inventory/catalog/oracle/normal-client
excerpts, complete checked-Save integration/unit tests, security suite excerpts,
the existing local replacement test and preservation unit diff. Read current
PR metadata/discussion, relevant base-to-head diffs, empty reviews/review threads,
prior source-review records and actual CI failure logs. No private fixture or
image/archive contents were opened.

Prepared run `34466066262`, job `102834828436`, step metadata reports locked
dependencies/browser/Docker/startup successful; reset/provision successful
`10:28:50Z`–`10:29:31Z`; type generation failed `10:29:32Z`–`10:29:34Z`.
Its in-progress log endpoint returned HTTP 404, so no exact setup failure report
or cause is claimed. The tracked type file remains unchanged; no post-edit
generation or type import occurred. A read-only shell lookup found `rg`
unavailable (exit 127); existing grep/views were used, with no installation.

### Exact repair and preserved scope

Only `public.commit_image`'s local declaration/body changes in the sixth
migration. It resolves the owned target's item ID without locking, waits for
existing owner/item ready media under the unchanged two-second lock timeout,
then re-reads/locks the owned target NOWAIT and rejects owner/item drift.
The used ITEM OR IMAGE guard, parent NOWAIT, post-parent ready NOWAIT, unchanged
private delegate and specific `lock_not_available` rollback handler remain.
No broad/deadlock catch, sleep, retry or timeout increase was added. The ordinary
path argument relies on actual image grants, pending-only raw insertion,
`image_one_ready` and profile-serialized reviewed ready transitions; it is not a
universal deadlock/timing claim.

SQL changed from **16317 bytes** /
`9058de2f231c72fc71b930f03e176457aee20de0cf82cab909fc21e879eaaac3`
to **16801 bytes** /
`023be0259305f0700c982dd27cc40e438847cd7b7f818a7fe7d3cc8b260459a8`.
Only the sixth actual length changes in `scripts/preservation-rehearsal.mjs`;
only the sixth actual hash changes in `tests/integration/preservation.sessions.mjs`.
All five older migrations/pins and the original preservation oracle remain intact.

`tests/unit/item-save.test.ts` adds static order, identity, retained-NOWAIT and
unchanged timeout/handler assertions. `tests/integration/item-save.sessions.mjs`
adds one fresh description-versus-commit and one retire-old-ready-versus-commit
request pair per normal owner, using existing fixture/client/cleanup/byte helpers
and the existing 15-second outer bound. Commit must succeed; description must
succeed with its exact result or return exact HTTP 403/42501/Not available;
retirement must succeed. Full old/new image and item rows plus four actual
object downloads/lengths/hashes/bytes are checked. No original checked cases
or generic error acceptance changed. These are request races, not forced
database-overlap proof, and they did not execute in this allocation.

`tests/integration/local.sessions.mjs` changes only constant stage assignments
inside the existing replacement block: main/thumb uploads, concurrent requests,
commit assertion, correction response, old/new rows, item and byte checks.
The commit assertion distinguishes exact HTTP 400/22023/Request conflict from
one fixed unexpected-result label. Original requests/order/Promise.all,
assertions and complete row/byte oracle remain unchanged. No status/body/ID/
path/private text is interpolated into diagnostics. Blueprint08 changes only
the affected description/helper/wrapper locking paragraphs. This dated append
is the eighth path. No other SQL function, grants, A1 markers, A2 diagnostics,
security assertions, client/types, workflows, dependencies or tooling changed.

### Actual validation and stopping evidence

Commands ran in `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`:

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/item-save.test.ts tests/unit/preservation.test.ts` | Exit 0; 92/92 tests, two files; static/inventory evidence only. |
| `npm run typecheck` | Exit 0 against unchanged committed types, not setup-generated/new-RPC parity. |
| `npm run lint` | Exit 0. |
| `npm run check:translations` | Exit 0; 471 EN/FI/SV keys, 45 source files. |
| `npm run scan:secrets` | Exit 0; 178 text files and unprinted canary checked. |
| `git diff --check` | Exit 0. |
| `npm run db:start` | One post-edit invocation; exit 0. |
| `npm run db:reset` | One invocation; wrapper exit 1; safe report below. |
| `npm run test:integration` | Not run: dependent sequence stopped at reset. |
| `npm run test:security` | Not run: dependent sequence stopped at reset. |

```json
{"tag":"nonzero-with-stderr","exitCode":1,"elapsedMs":17779,"stdoutBytes":0,"stderrBytes":252,"stderrDockerOperation":"run-container","stderrContainerExitBucket":"other-nonzero","stderrSqlState":"none","announcedKnownMigrationCount":0,"lastAnnouncedKnownMigrationIndex":null,"stderrPortAllocationMarker":false}
```

No account provisioning ran after that reset failure. No retry, raw CLI/SQL/debug,
service/provisioning workaround, post-edit type generation or unrelated repair
followed. Zero announcements and `none` mean no matching markers were observed;
they prove neither the cause nor absence of SQL activity. Successful setup/start
is not successful changed-SQL execution, preservation or ordinary-session proof.

Separately, actual CI `34460891440` attempt 2 at starting head `659a376068`
passed startup, six-source history/populated preservation (two owners, ten tables,
30 rows, eight objects/catalog/cleanup) and reset/AI18 phases, then failed
integration at the broad old replacement stage at `09:54:17Z`. Database job
`102824485555` logs were read; [evidence 5616839094](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5616839094)
also records App 1079 units/471 keys/449 browser cases. That broad failure does
not isolate an assertion/status/lock or establish this regression mode as its
observed cause. Security/recovery/types were skipped and no database-types
artifact existed; visual artifacts were not reviewed. None transfers to new head.

Coordinator owns independent exact-new-head review, executable trust, first CI
execution and later actual type artifact/verified Stage 2. New-source SQL,
six-source preservation, AI18, normal integration/security/races/recovery,
type parity and applicable artifact/device/human gates remain pending.
No Actions authorization/rerun, additional agent/branch/PR, merge, deployment,
hosted DDL, paid/provider/private-photo access or B3 waiver occurred. Hosted
AI18/checked Save remains unapplied and the operation window closed. Client
connection/full I29 and later packets are outside this repair; implementation
stops at the scoped commit and public handoff.

## PR #17 A4 recovery — strict AI-state oracle and closed phases, 10 September 2026

**Three-path test correction; native checks passed, final-head CI still pending.**
Existing branch `copilot/new-i29-checked-manual-save`, base/main
`c6ee8beb890deeca0c04cf53d6d3deebe4a231f6`, starting head
`e7c8c5adddc2141ac4d25445a926d73b98c66f1b`, tree
`528738a6e515cbfd956262bc216b37a53fbb9c4a`, parent
`c3cbbb83a7547bec225e73f3f2b9c0baf14878d4`. Initial tracked, staged and
untracked-source status was clean, with no setup-generated delta. Requirements:
I29 R03/R04 subset, preserving R01/R11/R17/R19/R23/R26/R27. This is not Stage 2,
connected manual Save, full I29, merge readiness or acceptance.

### Prospective recovery, context and own receipt

Read the full [A4 approval 5617933116](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5617933116)
and [recovery approval 5618548131](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5618548131),
including the user's explicit choice to keep the verified generated file
provisionally and finish A4. Actual different-provider critique: Anthropic /
Claude Opus 5 (`claude-opus-5`), read-only reviewer
`9edf6b92-27a7-47ce-b963-949860fe50a4`, turns 7/8, with coordinator amendments.
Accepted constraints retain full non-clock state, reject code-only UNAVAILABLE,
distinguish successful cleanup from cleanup failure and keep generated types
read-only. Native generation is not final-head parity; additive declarations
can affect type inference and require actual typechecking. No new critique or
agent was launched. Original plan 5614413353 and A1/A2/A3 approvals
5614726097/5615708093/5617117513 were read and remain historical controlling
context, not this allocation's writable scope.

The [stopped handoff 5618024024](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5618024024)
and [freeze/provenance 5618217814](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5618217814)
remain intact. The previous initial progress operation committed types outside
its three-path allocation before full context/own receipt reading; A4 was not
implemented then. Preserve e7's commit/message and missing Copilot App trailer;
this prospective approval does not ratify that operation or backdate its gate.
No revert, amend or history rewrite occurred.

Actually read root `AGENTS.md`, `.github/copilot-instructions.md`, the blueprint
instruction template without copying it, `docs/cloud-development.md`,
Phase 0 status/ordered handoff, Phase 2 PR17/A1/A3 evidence and
`docs/local-backend.md`'s fixture/execution/type gates. Blueprint reads:
00/02/03/05/08/10/14/19/20, I29 in 15, and the relevant base schema/media/RLS/
grants/functions in 07 (byte-identical to the initial migration).
Source reads included all six migration contracts and hashes; full provenance,
description, collections and checked-Save migrations; AI18 status/expiry/locking;
generated RPC types; `src/images/upload.ts` and AddItem source;
`package.json`, `eslint.config.mjs`, `scripts/db.mjs`,
`scripts/backend/local.mjs` guard/runner sections, hosted guard excerpts,
`scripts/run-local-tests.mjs`, core/AI fixture source guards,
preservation inventory/catalog/normal-client/oracle excerpts and unit diff,
complete checked integration/unit tests and normal AI/security test excerpts.
Read current PR discussion, metadata/diff/reviews/review threads (both review
lists empty), controlling comments and actual failed CI database logs. No
credential/service-state files, images or archives were opened.

After that read-only context and repeated clean status/hash checks, read
[this task's own receipt 5618586494](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5618586494)
**before any progress operation or edits**: task
`5105f040-3ee3-46ad-b7f5-adcb1e6f6f66`, session
`e9dd89a5-e14b-4962-b275-463928121463`, coordinator observed
`2026-09-10T12:20:39.8945202Z`, explicitly selected `gpt-6-astra` and verified
actual `sweagent-capi:gpt-6-astra`, repository 1358925513, PR artifact 4492828082,
matching branch/base/start head/tree/parent. No historical receipt or prompt
label was substituted. The subsequent initial progress operation reported
**no changes to commit**.

Retained `src/data/database.types.ts` remains read-only: **23976 bytes**,
SHA256 `9cf1a659a46f2f611cf10a83a7b1b8f7f210233691a21142eee1e5123344e0f4`,
blob `fe497411cc8fc2c7fed2d5b001773db03ef1521e`. Its 13 added lines declare
reserve/finalize; existing `commit_image` is unchanged. Provenance is the actual
prior setup run 34471504040/job 102852230615 at c3, generation log
`11:31:49.142278Z`, as recorded in 5618217814, not alphabetical text shape.
All six SQL files/pins remain unchanged; sixth SQL is **16801 bytes**,
SHA256 `023be0259305f0700c982dd27cc40e438847cd7b7f818a7fe7d3cc8b260459a8`,
blob `2c0aad72e95b844665e9da7927a11fd11730e867`. No new client consumption of
the retained RPC signatures occurred.

### Exact correction and oracle limits

`tests/integration/item-save.sessions.mjs` adds one import-safe comparison
helper using existing `requireEvidence`/deep-strict `eq`. Both inputs must be
non-null, non-array objects with an **own** top-level `serverTimeMs`, each a
nonnegative safe integer. Only that validated top-level clock is excluded,
without mutation; every other key and nested value is compared strictly,
including unknown additions/removals and nested `serverTimeMs`. No coercion,
defaults, clock mocking, elapsed bound or monotonicity assumption was added.
Millisecond timestamps can tie or valid clocks can move backwards.

The approved-owner full shape is `{code,period,serverTimeMs,consent,policy,usage}`:
consent contains `enabled,noticeRevision,consentedAt,profileVersion`; policy is
null or contains `activated,noticeRevision,modelId,promptVersion,maxRequestMicro,
monthlyAllowanceMicro,maxRequestsPerHour,resultTtlSeconds`; usage contains
`accountedMicro,requestsLastHour,warning`. Code-only `{code:'UNAVAILABLE'}`
deliberately fails. Both actual `ai_status` calls and the complete profile
equality remain; no request/order/row/byte/current-state/race assertion changed.

`ai_status` is **not a pure read**: it locks profile/control rows and expires
requests, potentially changing usage. UTC month `period`, sliding-hour counts,
accounting/warning and all expiry-sensitive effects remain strict. Equality
assumes no relevant rollover/expiry between snapshots; changes remain failures
requiring evidence, never ignored or retried away. The original c3 CI run
34466870999 attempt 2/job 102843770044 passed startup, six-source/history/original
two-owner/ten-table/30-row/eight-object preservation/catalog/cleanup, reset/AI18,
legacy integration and full normal AI controls, then failed checked Save at
`11:01:48.9119326Z` with a generic message. Its actual failing assertion remains
unknown. This later green native run does not retroactively isolate that cause.
Security/recovery/types were skipped there; App's 1080 units/471 keys/449 browser
cases exercised the old client, not checked Save.

Fixed phase assignments cover arguments/sign-in, initial snapshots, first
reservation/replay, incomplete upload/state, upload/raw bypass/finalization/
completed replay, unchanged profile/AI, full fields/canonical equivalence/
mutated intents, invalid-first rollback, deletion, stale state, races and legacy
cases. Failure output adds only that closed phase to the existing generic
message/nonzero exit. Cleanup saves the previous phase, labels cleanup before
the existing await, then restores the previous phase **only on success**.
Cleanup failure remains labelled cleanup and may mask an earlier error under
the unchanged semantics. No new catch/retry/request/logger or private output
was added. A phase identifies the last entered test group, not an exact SQL
statement or lock proof.

`tests/unit/item-save.test.ts` preserves every existing body/assertion and adds
51 cases covering clock equality/change/backwards/bounds, malformed clocks on
either side, malformed inputs, own-property and UNAVAILABLE rejection, every
known non-clock field plus unknown/missing/nested values, nested clocks and
input immutability. The A3 early ready `FOR UPDATE` before target/parent and
retained late NOWAIT checks are unchanged. One description-versus-commit and
one retire-old-ready-versus-commit pair per owner retain the 15-second bound and
strict rows/object bytes. HTTP concurrency does not force database overlap;
predicate row locks are not phantom protection or a universal 40P01/timing claim.

### Actual bounded native validation and handoff

This task's setup run **34476166271**, job **102867333464**, at e7 reports
successful startup (`12:21:36Z`–`12:22:46Z`), reset/provision
(`12:22:47Z`–`12:23:28Z`) and type generation
(`12:23:29Z`–`12:23:40Z`) in its job metadata. A text-log URL was obtained, but
the bounded setup-only retrieval was unavailable; no raw processing/fixture
logs were emitted and no exact setup-log cause is inferred. Initial regenerated
type bytes had no delta. Successful reset/provision metadata and the existing
local-only wrapper/fixture guards, not startup alone, permitted the sequence.

Commands ran in `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`:

| Exact command | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/item-save.test.ts tests/unit/preservation.test.ts` | Exit 0; 143/143 tests, two files (previous 92 plus 51 additive cases). Static/unit evidence, not database execution. |
| `npm run typecheck` | Exit 0 against the exact retained generated types above; not CI artifact/parity proof. |
| `npm run lint` | Exit 0. |
| `npm run check:translations` | Exit 0; 471 EN/FI/SV keys, 45 source files. |
| `npm run scan:secrets` | Exit 0; 178 text files and unprinted canary checked. |
| `git diff --check` | Exit 0. |
| `npm run db:start` | One guarded invocation, exit 0. |
| `npm run test:integration` | One invocation, exit 0: original normal-owner integration, full AI controls, checked Save replay/deletion/state/objects/bounded races and one recovery browser test passed. |
| `npm run test:security` | One invocation after integration success, exit 0: original security, full AI controls and checked Save normal A/B/anonymous negatives passed. |

The existing I29b stored description-counter ceiling remains explicitly **NOT
RUN** under ordinary fixture limits; static finite-bound coverage is not live
counter-ceiling proof. No post-edit reset/type generation, repeated run,
alternate script/raw CLI/debug/provisioning workaround or unrelated repair ran.
Read-only lookup misses (`rg` unavailable, two guessed file paths absent) caused
no installation or source changes.

Coordinator owns exact-new-head independent review/execution trust before first
CI. Required final-head six-source/history/populated preservation/catalog/AI18/
legacy/checked normal A-B-anonymous/race/security/recovery evidence and a real
CI database-types artifact with verified run/head/text/hash/byte parity remain
mandatory. Native/setup types and these native checks do not unlock Stage 2;
even a final type-parity-only failure is staging, not a pass. A fresh separately
verified task must connect every manual Save later. No unconnected Stage 1
merge, guessed types/casts, full-I29 or production-ready claim.

Existing e7 CI 34471816347 remains unapproved/action_required with zero jobs;
Apple 34471816391 was untouched. No Actions authorization/rerun, new agent/
branch/PR, merge/deployment, hosted DDL, provider/paid/private-photo operation or
private-input capture occurred. Exact-head coordinator visual review and
applicable device/human gates remain pending, not waived by PR16 B3 or these
tests. Hosted AI18/checked Save remains unapplied; the live operation window
is closed/read-only. Stop after the scoped commit and public handoff.

## PR #17 Stage 2 — connected manual Save; WebKit environment blocked, 10 September 2026

**Connected source candidate, not merge-ready.** This continuation uses existing
PR #17 / `copilot/new-i29-checked-manual-save`, base/main
`c6ee8beb890deeca0c04cf53d6d3deebe4a231f6`, starting head
`1bf2670c46fb94f710a4bddb6b459fff6904ced8`, tree
`690be443f639c4b222f2dc529702f4d9c0f5929d`. Requirements are I29's R03 creation
and R04 private-photo subset with R23 checked retries, preserving
R01/R11/R17/R19/R26/R27; not complete wardrobe CRUD or full I29.

### Authority, entry order and actual source evidence

Read the full [original plan 5614413353](https://github.com/drrowdev/stillroom-wardrobe/pull/16#issuecomment-5614413353),
[A1 5614726097](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5614726097),
controlling A2/A3/A4 and recovery adjudications, and full
[Stage 2 assignment 5619249583](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5619249583).
This is the already-reviewed continuation, not a new material plan.
Actual prereviewer: Anthropic / Claude Opus 5, reviewer
`d27104d9-e844-42b7-9f7f-a0a6723ba2dc`, turn 3; A4 final review
`9edf6b92-27a7-47ce-b963-949860fe50a4`, turn 9, adjudicated in 5618932608.
No additional agent/reviewer was launched by the writer.

Read root `AGENTS.md`, `.github/copilot-instructions.md`, cloud task/hosted
boundaries, Phase 0 status, relevant Phase 2 and local-backend evidence;
blueprint 00/03/05/10/14/19/20/21, I29 in 15 and relevant base-schema/API
sections of 07/08. Inspected actual checked-Save SQL, generated RPC text, upload
seam, garment parser and affected unit/browser test context. Retrieved PR
metadata/discussion/diff, empty formal reviews/threads, recent Actions runs and
actual Database job logs. Large text tool results were paginated or selectively
read; retrieval alone was not treated as a complete source review.

Initial `git status --short`, unstaged/staged diff stats were empty. HEAD/tree/
branch and both pinned text hashes matched the assignment, with no setup delta.
The local historical comparison reported **no merge base** in the shallow clone;
the GitHub PR diff was available. No fetch, history rewrite, reset or restoration
was used. An instruction-directory discovery probe found no `.github/instructions`
directory; it caused no source change.

After these read-only entry checks, read the full matching public
[own receipt 5619278146](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5619278146):
task `375610f6-76e1-4e59-abf0-9ed6f93ea257`, session
`9c0bf2ab-04e3-46b3-8b8b-9800030df835`, coordinator observation
`2026-09-10T13:14:45.4120160Z`, explicit `gpt-6-astra` selection and actual
`sweagent-capi:gpt-6-astra`, repository 1358925513 / PR artifact 4492828082,
matching branch/base/start head/tree. Only then called initial progress, which
reported **no changes to commit**, and edited source. Deeper test-route, owner
lifetime, parser and unchanged-transport inspection followed within the packet.
Read both blueprint child instruction files before the related documentation
edits, without copying their historical templates over current instructions.

[Outcome 5619223183](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5619223183)
records completed CI 34477104827 attempt 2 at the starting head, actual Database
102876472494/App 102876472132 evidence, artifact 10152858915 and coordinator
visual review. The tracked types remain **23976 bytes**, SHA256
`9cf1a659a46f2f611cf10a83a7b1b8f7f210233691a21142eee1e5123344e0f4`;
sixth SQL remains **16801 bytes**, SHA256
`023be0259305f0700c982dd27cc40e438847cd7b7f818a7fe7d3cc8b260459a8`.
Neither file was edited, regenerated or imported. Prior CI's 1131 units and
449 browser cases are not connected-client evidence.

### Connected contract and exact nine-path scope

Only `src/images/upload.ts`, `tests/unit/item-save.test.ts`,
`tests/unit/garment-fields.test.ts`, `tests/browser/mock-backend.ts`,
`tests/browser/garment-fields.spec.ts`, `tests/browser/images.spec.ts`,
`blueprint/06-DATA-MODEL.md`, `blueprint/08-API-AND-STORAGE.md` and this result
change. The optional helper, private-image tests, slice/detail specs and every
other source path remain unchanged.

Every existing AddItem submit/explicit Retry now sends the frozen 32-key item
and 8-key image intent to typed `reserve_item_save`. Before upload, runtime
checks require exactly one well-shaped result, the opaque 64-hex fingerprint,
owned IDs/parent, every frozen field with canonical price/semantic provenance,
version 1/nondeletion, immutable media metadata/paths/caption, description
counter 1/nonretirement and reserved/pending or completed/ready consistency.
Server timestamp fields are shape-checked, not compared with browser time.
Malformed replies fail closed; known closed SQL failures use existing translated
conflict/upload-incomplete messages, all other failures use unavailable.

Both pending and completed retries pass checked reservation and
`finalize_item_save`; a bare ready flag never returns success. Finalization
requires a void response. No rejected reservation is repaired, no raw item/image
INSERT or raw commit remains on the common Save path, and no new IDs, automatic
retry/rebase or inference is introduced. Owner/epoch and abort checks bracket
the asynchronous stages. The original frozen attempt builder, prepared photo,
dirty UI and explicit Retry/Discard remain intact.

Direct text comparison confirmed `ensureFile` and browser `uploadReceiver`
byte-identical to the starting head. Thumb-before-main, JPEG/upsert-false/
cacheControl-zero, authenticated duplicate download/SHA comparison and all
capture bounds remain. These are not analyzed-photo byte attestation.
All original A1/A3/A4 unit bodies remain exact; 69 connected-client unit cases
are additive. Browser metadata routes model checked attempts and lost completed
replies; new cases reject missing objects, changed caption/counter/version,
deleted/retired rows and malformed reservations while preserving frozen retries.
Mocks are not SQL concurrency, authorization or live-backend proof.

### Actual bounded commands and stopping evidence

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Units finished before the Vite-backed browser run.

| Exact command | Actual result |
| --- | --- |
| `npm run typecheck && git diff --check` | Exit 0 after connecting the source seam. |
| `npm run test:unit -- tests/unit/item-save.test.ts tests/unit/garment-fields.test.ts tests/unit/private-images.test.ts && npm run typecheck && npm run lint` | First exit 1: 254 passed / 13 new fixture failures; later commands did not run. Corrected new synthetic Blobs to declare `image/jpeg`, matching the asserted upload contract, without changing production transport. Repeated after that correction: exit 0, 267/267, typecheck/lint passed. |
| `npm run typecheck && npm run lint && npm run check:translations && git diff --check` | Exit 0; 471 EN/FI/SV keys, 45 source files. |
| `npm run test:unit -- tests/unit/item-save.test.ts tests/unit/garment-fields.test.ts tests/unit/private-images.test.ts && npm run typecheck && npm run build && npm run scan:secrets` | Exit 0 after four additional malformed-void-response cases: **271/271** in three files. Typecheck/build passed; JS 596.81 kB / gzip 175.01 kB, existing non-failing >500 kB warning. Secret scan: 184 text files, canary checked. |
| `npm run test:browser -- tests/browser/garment-fields.spec.ts tests/browser/images.spec.ts tests/browser/slice.spec.ts tests/browser/item-details.spec.ts --retries=0` | **Exit 1: 204 passed, 102 failed**, 306 cases / two workers / 2.8 minutes. Chromium and mobile passed, including applicable accessibility and unchanged bounded captures. Every WebKit case failed at browser launch because `/home/runner/.cache/ms-playwright/webkit-2359/pw_run.sh` is absent. No WebKit application assertion ran. |
| `git diff --check` and read-only frozen-function/original-unit-body comparisons | Exit 0; frozen functions and every original checked-Save unit body unchanged. |

This task's setup run 34481417081/job 102884879378 records startup success
13:15:37–13:16:45Z, reset/provision success 13:16:45–13:17:24Z and generation
success 13:17:24–13:17:36Z. This is setup metadata, not new-head CI or a worker
integration pass. Although it met the fixture prerequisite, **no worker
`db:start`, integration/security, reset/typegen or rehearsal ran**: the browser
environment blocker triggered the assignment's stop rule first.
No browser install, dependency restoration/change, timeout/worker modification,
diagnostic workaround or rerun followed. Standalone `test:a11y` was not run;
the selected specs' Chromium/mobile accessibility checks passed, WebKit did not.

### Coordinator handoff and retained gates

The writer stopped implementation/validation at the missing-WebKit blocker and
prepared only this scoped source/evidence handoff. No image/archive/binary was
opened, downloaded into model input, attached or encoded for the worker;
synthetic screenshot buffers remained ignored. Existing capture production is
not coordinator visual acceptance, and the prior eight-image review covers only
the starting head.

New-head independent source/execution-trust review must precede any first CI
request by the coordinator. Full new-head App/Database/preservation/types/
ordinary-owner negatives/security/recovery and actual approved visual review
remain required. The worker authorized/reran no Actions and created no agent,
branch or PR, merged nothing and deployed nothing.
The prior c3 failure remains undiagnosed; missing WebKit does not diagnose or
fix B3's two-byte upload issue. B3 acceptance is not waived. Forced DB overlap,
stored counter ceiling and the account-deletion journey remain unproved.
Hosted AI18/checked Save remain unapplied and the live window closed. Automatic
analysis, trusted photo/provenance binding, source history, complete backup/
export and full I29/MVP/device/human acceptance are not delivered by this packet.

## PR #19 — I29 analysis backend B1 partial source checkpoint, 11 September 2026

**Incomplete and not merge-ready.** The approved source packet is not complete:
the local reset failed before announcing any migration. No actual B1 SQL,
generated-type parity, served function, normal-owner analysis or Google success
is claimed. No provider/hosted operation or paid activation occurred.

### Authority and entry

Existing platform branch `copilot/i29-analysis-backend-b1`, base/parent
`de6bca3ebd7d01b96e313e47353711908f3b8a3e`, start
`0718a7dd21680dcb9d4c97c34c47236f3adac540`, identical tree
`9c41828c260099ef50ef21b59fefbf3c48af3fcc`. Initial tracked/staged/untracked
source was clean, with zero base diff. Setup's generated types were ignored and
reported `PARITY: MATCH`; they were not adopted or committed.

Read the full [proposal 5629192198](https://github.com/drrowdev/stillroom-wardrobe/pull/18#issuecomment-5629192198)
and [controlling approval 5629411306](https://github.com/drrowdev/stillroom-wardrobe/pull/18#issuecomment-5629411306),
including the coordinator-adjudicated actual Anthropic / Claude Opus 5 review
`223d6728-9657-4479-8ea0-1da7421db2d3`, turn 0. No additional agent was launched.
Read this task's [own verified receipt 5629490053](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5629490053)
before progress or edits: native task `747b8d2e-6e9c-4294-8aad-fe73af8a11df`,
session `7d9f03fa-8673-4de5-9d54-eb09aaab29f7`, coordinator-observed
`sweagent-capi:gpt-6-astra`, matching this repository/PR/branch/base/start/tree.
This receipt is platform evidence, not a worker self-attestation.

Context actually consulted: root/Copilot and both blueprint child instructions;
full cloud guide; Phase 0 ordered-development handoff, Phase 1 result and Phase 2
AI18/checked-Save evidence; local-backend guide; blueprint 00/02/03/05/10/14/19/20/21,
07 ownership/schema and 08 control-API excerpts, and I29 in 15. Source reads
included all AI18 SQL, the provenance/description/collections migrations,
initial ownership and checked-Save excerpts, actual generated RPC types,
unchanged JPEG and AI parsers, shared fact vectors, normal AI/preservation
clients, local helpers/declarations, test wrapper, unit-test context, package,
TypeScript and CI configuration. PR #19 discussion/diff/reviews/threads were
read; initial diff/reviews/threads were empty. Relevant large text results were
read in ranges rather than treated as reviewed merely because fetched.

Setup run `34562239733`, job `103147193550`, reports successful Node/locked
dependencies/Chromium/WebKit/Docker/start/reset/18 AI phases/ignored typegen/
cleanliness steps. Actual local setup text logs corroborated these results.
GitHub's running-job log download returned HTTP 404, not a setup-failure
diagnosis. CI `34562243760` and Apple `34562243634` at the initial head were
`action_required`; the worker authorized or reran neither.

### Partial source and actual validation

The checkpoint adds the six function-source/config files, one additive SQL
candidate, endpoint unit tests and source-equivalence checks. It includes
server Auth/JPEG/SHA validation, the fixed Google EU OAuth/adapter, a manifest/
attestation/one-time-claim candidate and estimated-versus-confirmed accounting.
These are **unserved and SQL-unexecuted source**, not a complete endpoint gate.
The seventh migration is pinned in preservation and the observational local
list. All six old migration files/pins, manual Save, image preparation/upload,
forms, dependencies, setup workflow and generated public types stay unchanged.
Requirements: I29 R18/R19/R23/R26/R27/R28, preserving R01/R11.

Commands ran in `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Command | Actual result |
| --- | --- |
| `node --version`; `node_modules/.bin/supabase --version`; `node_modules/.bin/supabase functions serve --help`; `docker info --format '{{.ServerVersion}}'` | Node 24.19.0, CLI 2.116.0, Docker 28.0.4. Help says serve all functions; planned invocation has no positional name. Chromium/WebKit executable access checks passed. No function server was started. |
| `npm run test:unit -- tests/unit/ai-endpoint.test.ts tests/unit/ai-schema.test.ts tests/unit/local-backend.test.ts tests/unit/preservation.test.ts` | Final **506/506**, exit 0, including complete legacy admission-body equivalence and pure legacy settlement source checks. Earlier runs exposed the expected missing seventh inventory pin and two fixed-count assertions, corrected only in allowed paths. |
| `npm run typecheck && npm run lint` | Exit 0 with function files included. Earlier adapter header syntax, Node strip-only parameter-property and new test tuple-typing errors were corrected. |
| `npm run db:start` | Exit 0; not proof of function boot. |
| `ALLOW_SECURITY_TESTS=1 npm run db:reset` | **Exit 1**, 17798 ms, stdout 0 bytes/stderr 252 bytes; `run-container`, `other-nonzero`, no SQLSTATE, zero announced migrations. No provisioning ran. |
| `npm run db:types` in the chained command | **Not run**, because reset failed. Tracked types were not generated or imported. |
| Read-only container inventory | Database recreated and healthy; existing Auth/REST/Storage/gateway/mail containers present, no Edge Runtime container. This does not establish why reset failed. |
| `npm run scan:secrets` | Final exit 0, 186 text files, canary checked. Earlier literal PEM delimiters in the parser/ephemeral-key test triggered the pattern scanner; equivalent delimiter matching/construction removed those false positives without changing the scanner or supplying any real key. |
| `git diff --check`; frozen-path `git diff --exit-code de6bca3ebd7d01b96e313e47353711908f3b8a3e -- …` | Both exit 0. Compared all six old migrations, tracked generated types, `src/images`, `src/features`, package/lock and setup workflow. |

No reset retry, fresh-only warm reprovision, runtime/dependency replacement,
hosted repair, image/model input, provider call or external credential use
followed the failure. Preserve the partially reset disposable state and primary
error for coordinator diagnosis; container health is not schema readiness.

### Remaining work and gates

The owned lifecycle/capability helper, actual CLI-served boot, isolated
Google-transport-only rehearsal, temporary warm-control namespace/cleanup,
new normal-session/security suites and catalog/grant/export oracles are
**not implemented**. CI invocation and the remaining API/runtime/tariff
documentation are not yet wired. Full SQL interaction/concurrency/expiry/
accounting tests, seven-source populated preservation, all legacy18 phases,
normal checked-Save/recovery, actual generated types and final full gates remain
required. Static source tests do not replace any of them.

The provisional 2270823 microUSD reservation is allowance arithmetic, not a
proven invoice ceiling or expected per-photo price. Exact-route total generated
bound including thoughts, current tariff/actual version, account/terms/consent/
allowances, authorized photo evaluation, retention, hosted bundling/migration/
deployment and full I29 UI/provenance/device/human gates remain separate.
Coordinator exact-head independent review, CI/native Apple and approved artifact
visual review are pending. Workers do not merge, deploy or launch a replacement
task. No source-complete, merge-ready or acceptance claim is made.
