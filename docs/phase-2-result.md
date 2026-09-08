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
