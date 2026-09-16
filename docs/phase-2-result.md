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
| Automated validation on source checkpoint `4d290487f935c3678e669c3bdb1ab9579ecc1fec` | CodeQL JavaScript: **0 alerts**. Code review **unavailable**, not a pass: configured `claude-sonnet-4.6` was absent from the tool's model registry. No substitute reviewer or additional agent was launched. |
| GitHub CI `34563329264` and Apple diagnostic `34563329203` on that checkpoint | Both `action_required`; job-log queries report **0 jobs**. No worker approval/rerun and no CI/native acceptance result. |

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

## PR #19 — B1 readiness/completion continuation, 11 September 2026

This dated continuation supersedes the earlier checkpoint's unexecuted-source
status, not its historical failed commands. Scope remains **I29 backend B1 only**,
requirements **R18/R19/R23/R26/R27/R28**, preserving **R01/R11**. No next packet,
UI analysis/trusted Save integration, provider activation, hosted mutation,
deployment or merge is included. Phase 0 remains engineering complete,
acceptance open; I29/MVP/manual/device acceptance is not complete.

### Authority, runtime and entry sequence

Read all nine frozen context pins: PR #18 comments `5629030227`, `5629192198`,
`5629411306`; PR #19 `5629778640`, `5629889200`, `5630622364`, `5631428528`,
`5632401441`, `5632491947`. The first tool was the prescribed authenticated
one-item page-21 probe. Each ID/author/timestamp/PR URL matched.
[Approval 5632491947](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5632491947)
records actual Anthropic / Claude Opus 5 reviewer
`223d6728-9657-4479-8ea0-1da7421db2d3`, turns 6/7, and coordinator adoption of
N1–N6/P1–P6. Original 29-path scope and prior approval remain controlling.
No worker agent/reviewer/task/branch was launched.

* **T1:** context completed after `09:58:09Z`, before the fresh T2 inspection.
  Full root/Copilot and blueprint child instructions, cloud guide, blueprint
  00/03/05/10/13/14/19/20/21; Phase 0 status/hosted and Phase 2 B1 excerpts,
  local-backend evidence, blueprint 07 ownership/grants, 08 API/control and 15
  I29 excerpts. Source included all six function files, full B1/AI18 SQL,
  relevant older migrations/types/JPEG boundaries, helpers/declarations,
  generator/wrapper, package/setup/CI/TypeScript/Playwright contracts and
  endpoint/schema/lifecycle/preservation/ordinary-session tests. PR discussion,
  diff, reviews/threads (empty) and relevant completed CI logs were read.
  Large historical phase documents were read selectively, not claimed as fully read.
* **T2:** `09:58:28.759–09:58:28.918Z`, actual branch
  `copilot/i29-analysis-backend-b1`, HEAD
  `79c99e111771c6757d386ac3e15dcb8bb3c11829`, tree
  `0b4365bab4ba273abd90b993694d61ea0509b514`, base/main
  `de6bca3ebd7d01b96e313e47353711908f3b8a3e`. Tracked, staged and untracked
  source clean; only expected ignored setup state, no pending type-generation
  file. Docker 28.0.4/services and Chromium/WebKit executables available.
* **T3:** deliberately read page 22 only after T1/T2:
  [own receipt 5632583458](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5632583458),
  unedited, created/updated `09:43:23Z`, after cutoff `09:35:43Z`.
  Task `ccfc35c1-92b8-410d-8f4c-f9aa02d1ac86`, session
  `ba09a309-1779-4870-bfe4-b7e2280bef13`, coordinator-verified actual
  `sweagent-capi:gpt-6-astra`, explicit `gpt-6-astra`, no fallback.
  Session matched current platform setup-script records; verification finished
  `09:58:42.697Z`. Repository/PR IDs, kickoff marker and exact base/head/tree matched.
* **T4:** initial write-capable progress call followed completed T3; edits and
  project imports/tests followed that call. No pre-entry worker writes/tests.

Current setup run **34585534602**, job **103218762365**, window
`09:42:17–09:55:12Z`: Docker/start/reset+fictional fixtures/ignored generation/
cleanliness steps all explicitly **success**, paired with current local
transcripts ending respectively `09:53:04.649`, `09:54:16.726`, `09:54:59.688`,
`09:55:11.341`, `09:55:12.128Z`. Silent cleanliness had explicit step success,
a bound zero-byte transcript and fresh T2 source proof. Generation reported
**PASS / PARITY: DIFFERENT**, not final tracked parity. No current active-job
archive was requested; coordinator terminal-archive review remains separate.

Required completed evidence was read: `34577988231/103194764024` (old Docker125
type-generation failure), `34581677783/103206441089` (later setup pass/different
parity), and CI `34563462889` attempt 2, database job `103154672854` (earlier SQL/
ordinary tests succeeded, tracked parity failed). Historical green checks were
not reused as current-head validation. Head-79 CI/Apple runs remained
`action_required`; the worker approved/reran neither.

### Implemented and locally proved

The strict originless probe requires 204/no-store/nosniff/POST and never inspects
ACAO for readiness. Actual gateway observation: old browser preflight **200**
without handler indicators; originless **204**, all indicators present, ACAO
present in both. Literal `"null"` remains denied. The real CLI-served entrypoint
accepted ordinary Auth and returned closed `UNCONFIGURED` for both owners,
without Google configuration or fixture changes. Safe process/probe diagnostics,
startup/lifetime/output limits and owned-process cleanup remain enforced.

The new warm rehearsal uses real Auth/DB with only Google transport synthetic,
strict ordinary-session child environments, exact bounded request namespaces,
real catalog/grant/RLS/check/FK/immutable-registry assertions, complete fact
vectors and replay/concurrency/lost-acknowledgement/terminal/accounting scenarios.
Each successful run produced **12 synthetic generations**, restored exact old
**14 ledger / 2 ready / 0 held-or-reserved** rows and eight-key controls,
A16001/B-three-recent usage, and preserved normal inventory/export/media hashes.
Consent used ordinary CAS: **two profile-version increments per owner per run**,
never rewound. No real Google request, hosted request, private photo, image
display or binary/archive input occurred.

The actual tracked generator added only the three B1 RPC signatures (26 lines);
independent `--check` generation matched. CI now invokes the rehearsal after
existing integration/security and before unchanged final type generation.
API/runtime/tariff/local-cloud documentation is updated in approved paths.
Six old migration bytes, setup workflow, dependencies, image preparation,
manual Save and browser capture bounds are unchanged.

### Current commands and remaining gates

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Command | Result |
| --- | --- |
| `npm run lint`; `npm run typecheck` | Exit 0. |
| `npm run test:unit -- tests/unit/ai-endpoint.test.ts tests/unit/ai-schema.test.ts tests/unit/local-backend.test.ts tests/unit/preservation.test.ts` | **572/572**, four files, exit 0. |
| `npm run test:unit` | **1346/1346**, 19 files, exit 0. |
| `npm run check:translations` | 471 keys EN/FI/SV, 45 source files, exit 0. |
| `npm run build` | Exit 0; existing >500 kB chunk advisory remains. |
| `npm run scan:secrets` | 195 text files, canary checked, exit 0. |
| `npm run check:dependencies` | 12 production/220 development packages, zero unverified dates; production audit zero findings. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Existing local/AI18/checked-Save suites plus B1 baseline passed; recovery browser 1/1. Stored I29b counter-ceiling injection remains explicitly NOT RUN. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Existing ordinary A/B/anonymous suites plus B1 RPC/private-schema refusals passed. |
| `ALLOW_SECURITY_TESTS=1 node scripts/ai-analysis-rehearsal.mjs` | Full served and synthetic-Google/real-DB rehearsal passed, including success-only exact baseline restoration. |
| `npm run db:types`; `npm run db:types -- --check` | Actual generation and exact tracked parity passed. |

Ordinary engineering corrections retained the assertions: the first ad-hoc
served follow-up omitted explicit opt-in and stopped before Auth/fixture writes;
the approved CI step required updating its frozen ordering assertion; a catalog
fact-vector query needed `to_jsonb` rather than parsing PostgreSQL `t/f`.
Catalog invariants themselves all passed. No failed normal setup or consumed
diagnostic permission was reused.

Browser/accessibility and seven-source populated preservation were running at
this record's initial commit; final results are recorded below when available.
Exact-head external CI/Apple, coordinator independent/visual/terminal-setup
review and merge decision remain coordinator-owned and pending. Automated
review/security results must likewise be recorded, not inferred from earlier
checkpoints. Financial maximum/hidden-thinking, current tariff/model-version,
terms/account/consent/allowance, representative-photo, retention/purge, hosted
bundling/deployment, UI/provenance/Save and manual/device gates remain separate.

### Final continuation validation and blocked handoff

Implementation commit **`76a5deb9054464c5bbe1200cd9ff281e0ed35df7`** contains
the 17 intended continuation files; the complete PR remains within the approved
29 paths. Post-commit source was clean and frozen-path comparison confirmed all
six old migrations, package/lock, setup workflow, `src/images` and `src/features`
unchanged. The changed-file secret tool reported no secrets.

| Final check | Actual result |
| --- | --- |
| `npm run test:browser` | **482/482**, 8.2 minutes, exit 0; existing Chromium/WebKit tests and capture bounds unchanged. Images were not opened. |
| `npm run test:a11y` | **33/33**, 53.4 seconds, exit 0. Not physical-device or coordinator visual acceptance. |
| `ALLOW_SECURITY_TESTS=1 ALLOW_PRESERVATION_REHEARSAL=1 npm run db:rehearse` | **Exit 1 at `S1-base-reset`**. Pinned CLI capabilities and all seven source hashes passed. Populated capture, migration-up and subsequent preservation stages **NOT RUN**. Root cause not established by the bounded failure output. |
| Chained `ALLOW_SECURITY_TESTS=1 npm run db:reset`, B1 rehearsal and `npm run db:types -- --check` | **NOT RUN**, because preservation failed. Earlier successful normal-stack/rehearsal/type evidence above remains historical to its actual execution, not proof of the current partially reset state. |
| Automated validation at `76a5deb` | CodeQL Actions and JavaScript: **0 alerts**. Code review **unavailable, not passed**: configured `capi-prod-claude-sonnet-4.6` missing from the registry. No substitute agent/reviewer was launched. |
| GitHub CI `34587975449`, Apple `34587975444`, head `76a5deb` | Both **action_required**; authenticated log queries each reported **zero total jobs**. Worker approved/reran neither. |

The user's time-limit instruction ended further validation/repair. The failed
disposable preservation state is left intact: no blind reset retry, sweep,
reprovision, generation, service-state adoption or new task followed. No complete
seven-migration populated-preservation pass, current final-DB readiness or
merge-ready claim is made. Completing that required gate and genuine independent
exact-head review remains blocking, alongside the coordinator-owned checks
already listed. This final evidence-only update does not change executable code;
fresh-head external checks still belong to the coordinator.

## B1 readiness-identity/failure-evidence repair — 11 September 2026

This is only the eight-path repair under
[approval 5633782787](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5633782787),
not a new packet or completion claim. It targets I29 R18/R19/R23/R26/R27/R28
while preserving R01/R11. The approval records actual independent Anthropic
Claude Opus 5 reviewer `223d6728-9657-4479-8ea0-1da7421db2d3`, turns 9/10,
A1–A9 and coordinator corrections C1–C3, with no remaining approval blocker.
No worker agent or substitute critique was launched.

### Exact ordered entry and context

- Base/main `de6bca3ebd7d01b96e313e47353711908f3b8a3e`; branch
  `copilot/i29-analysis-backend-b1`; start HEAD
  `3b58b50793720d0f82a06aee9b54196fcd73715a`; start tree
  `b75ecf69d7d4e82c98a6c181357f956b311b74cb`.
- The first tool request read exactly PR19 page27/perPage1 and verified the
  unedited owner approval, then all ten finite context pins were read and their
  prescribed metadata checked. PR diff, review records and required completed
  native `34585534602/103218762365`, CI attempt2
  `34588742446/103238729122` (Database failure) and `103238728749` (App success),
  and Apple `34588742433/103238728343` logs were accessible and read as text.
  No binary archive/image was opened and no own active-job archive was required.
- T1 context completed `11:40:56.205Z`. Fully read: root `AGENTS.md`,
  `.github/copilot-instructions.md`, `blueprint/AGENTS.md`,
  `docs/cloud-development.md`, `docs/local-backend.md`;
  blueprint `00-INDEX`, `03-MVP-AND-NON-GOALS`, `05-ARCHITECTURE`,
  `10-SECURITY-AND-PRIVACY`, `13-REPOSITORY-STRUCTURE`,
  `14-IMPLEMENTATION-PLAN`, `19-LOCALIZATION`, `20-AI-MODELS-AND-WORKFLOWS`,
  `21-AI-MODEL-COMPARISON` (all `.md`); `scripts/backend/local.mjs` and
  `local.d.mts`, `scripts/ai-analysis-rehearsal.mjs`, `scripts/db.mjs`,
  `scripts/run-local-tests.mjs`, integration/security `ai-analysis.sessions.mjs`,
  `tests/unit/local-backend.test.ts`; all six production analyze-clothing files;
  `supabase/config.toml`, `package.json`, `.node-version`, `tsconfig.json`,
  `playwright.config.ts`, setup workflow and CI workflow.
- Scoped excerpt reads, not whole-history claims: phase-0 lines 1–125,
  current phase-2 lines 1–35 and 3580–3720; blueprint `07-DATABASE-AND-RLS.sql`
  ownership/schema/grants, `08-API-AND-STORAGE.md` B1/AI sections and
  `15-GITHUB-ISSUES.md` I29; B1 migration declarations/grants and lines 149–225;
  tracked/generated schema excerpts; `src/images/jpeg.ts` lines 1–130;
  endpoint/schema/preservation unit contracts and test inventory. Relevant
  source was inspected directly, not inferred from historical templates.
- Fresh T2 completed `11:41:33.313Z`: expected branch/HEAD/tree, staged,
  unstaged and untracked source clean, only approved ignored dependency/local
  setup state, no pending generation file, exact ignored/tracked type equality.
  Initial read-only `merge-base` returned 1 in the shallow checkout; authenticated
  current PR metadata confirmed exact base/head, and the expected base tree was
  locally available. No fetch, reset or source repair was used.
- Current native setup run `34594725266`, job `103247716857`: Linux dependency,
  browser, Docker, start, reset/fixtures, ignored generation and cleanliness
  steps explicitly succeeded. Docker/start/reset/types/cleanliness transcripts
  were bound to platform scripts and matching setup-window timestamps
  `11:36:24.925`, `11:37:35.003`, `11:38:18.217`, `11:38:29.311`,
  `11:38:30.043Z`. Generation reported `PARITY: MATCH`; zero-byte cleanliness
  was supported by explicit successful step56 and fresh source checks, not
  silence alone. Windows alternatives were skipped, not required Linux gates.
- Only after T1/T2, PR19 page28/perPage1 returned own
  [receipt 5633845391](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5633845391),
  one unedited `drrowdev` item created/updated `11:36:43Z`, strictly after cutoff
  `11:31:29Z`. Task `2205a7c4-8f2f-4992-bb1e-c7655dab4e72`, session
  `ad8abfaf-1a93-4bda-a91c-9150197f0522`, exact repository/PR/source/kickoff
  marker matched. The session also matched current platform-created scripts.
  T3 verified `11:41:47.448Z`; receipt records explicit `gpt-6-astra` and actual
  `sweagent-capi:gpt-6-astra`. T4 initial progress followed, before code/import/
  test operations. No credential/service-state contents were reported.

### Repair and validation checkpoint

Changes are restricted to `scripts/backend/local.mjs`, `local.d.mts`,
`tests/unit/local-backend.test.ts`, `scripts/ai-analysis-rehearsal.mjs`,
`tests/integration/ai-analysis.sessions.mjs`, `docs/local-backend.md`,
`docs/cloud-development.md` and this result file. SQL, production function/
adapter/protocol, schema types, CI/setup, package/lock, images/Save/UI and capture
sources remain untouched.

Readiness now requires a newer stable runtime identity and two strict originless
OPTIONS observations within the single original deadline. Metadata reads have
fixed argv, validated ID, 5000 ms/remaining-time and combined 4096-byte bounds.
Boot/module failure stops immediately. Closed diagnostics preserve last HTTP
indicators separately from transport failure and never expose Docker identity.
This is serialized replacement evidence, not child-PID attribution.

The served ordinary child and parent share bounded, closed records and reject
invalid/overflow evidence. Original ordinary-response guards remain; a separate
bounded invalid-JWT path asserts exactly 401 without requiring handler headers/
JSON. Both ordinary owners still require 503/UNCONFIGURED; the full no-reservation
snapshot and separate real Auth/DB, Google-only-synthetic proof remain mandatory.
Neither 401 nor 503 alone proves its routing/Auth cause.

| Command/check | Actual result before live sequence |
| --- | --- |
| `npm run test:unit -- tests/unit/ai-endpoint.test.ts tests/unit/ai-schema.test.ts tests/unit/local-backend.test.ts tests/unit/preservation.test.ts` | **630/630**, four files, exit 0 at 11:48Z. Earlier syntax-only collection failure corrected before live execution. |
| `npm run typecheck`; `npm run lint` | Exit 0. Missing executable-JS declaration annotation corrected using the existing test convention. |
| `git diff --check` | Exit 0. |
| Serialized preservation/reset/integration/security/one rehearsal/types | Pending at this checkpoint; no live claim. |
| Full units/app/browser/a11y/translations/build/secrets/dependencies | Pending at this checkpoint; unchanged approved capture bounds. |

The prior Database failure at `11:03:10.978Z` remains unexplained; this repair
does not retroactively diagnose it, and later green evidence cannot do so.
Any new actual served/rehearsal failure requires preserving state and STOP,
without resetting, retrying to green or speculative Auth/SQL/policy changes.
Exact-head independent repair review, coordinator-authorized CI/Apple, artifact/
actual visual review and terminal native setup audit remain pending. No source-
complete or merge-ready claim is made. Hosted/provider/paid/private-photo,
financial/hidden-thinking, model/tariff, consent/allowance, UI/Save/provenance,
retention/purge and physical-device acceptance gates remain separate.

### Repair commit validation and terminal preservation STOP

Repair commit **`6ee96b4dbef1658210dc7a863bc67647bbf37665`**, tree
`13f362af5c3546a7394d025db765bed1c72af6c8`, contains exactly the eight permitted
files. Post-commit source was clean. No frozen-path change or extra agent was
introduced.

| Check at the repair checkpoint | Actual result |
| --- | --- |
| `npm run test:unit` | **1404/1404**, 19 files, exit 0; completed before any live preservation or browser suite. |
| `npm run typecheck`; `npm run lint`; `git diff --check` | Exit 0. |
| Changed-file secret scan, all eight paths | No secrets found before the repair commit. |
| Automated validation at `6ee96b4` | CodeQL Actions/JavaScript: **0 alerts**. Code review **unavailable, not passed**: configured `capi-prod-claude-sonnet-4.6` missing from the registry. No replacement agent/reviewer launched. |
| `ALLOW_SECURITY_TESTS=1 ALLOW_PRESERVATION_REHEARSAL=1 npm run db:rehearse` | **Exit 1: `preservation S1-base-reset; EVIDENCE_REQUIRED; subsequent stages NOT RUN`**. Pinned CLI capabilities and exact seven-source inventory/hashes passed. Populated snapshot/migration-up/preservation stages did not run. |
| Subsequent reset, integration, security, single B1 rehearsal, actual types/parity | **NOT RUN** after the preservation failure. No reset/reprovision, diagnostic probe or retry followed. |
| Browser/a11y, translations/build, repository secret/dependency commands | **NOT RUN** after terminal STOP. Earlier-head results do not satisfy these repair-head gates. |

The failed disposable fixture state is preserved. The bounded output does not
establish the cause of `S1-base-reset`; no further Docker/SQL/Auth investigation
or speculative repair was attempted. Unit coverage proves neither actual
runtime replacement nor the new served observations. There is **no new live
served/real-Auth/DB success claim**, and the historical failed POST cause remains
unproven. Required live proof, exact-head coordinator-authorized CI/Apple,
independent repair review, terminal setup audit and actual artifact/visual
review remain blocking/pending. The worker ends this task without another
packet, task restart, Actions approval/rerun, merge or deployment. This final
documentation-only record does not change executable code or failed fixtures.

## B1 startup-state correction — 11 September 2026

Source/unit correction only; **not live-proven, source-complete or merge-ready**.
This continuation addresses I29 R18/R19/R23/R26/R27/R28 while preserving R01/R11.
Base/main `de6bca3ebd7d01b96e313e47353711908f3b8a3e`; starting head
`450ba7337788988f9700e1303421ed567c5c7873`, tree
`c967c430a903e8ad05796bdda50d3545a8cdd97b`; existing PR #19 / branch
`copilot/i29-analysis-backend-b1`.

### Authority and ordered entry

The first authority tool read returned exactly
[approval 5634444254](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634444254),
PR19 page32/perPage1, author drrowdev, created=updated `12:28:59Z`.
Actual different-provider read-only critique was **Anthropic / Claude Opus 5**,
reviewer `223d6728-9657-4479-8ea0-1da7421db2d3`, focused turn 12, ACCEPT P1–P4.
The coordinator adopted the must-fixes and C1: separate ps/inspect observations
must permit a legitimate same-ID created-to-running transition. No new agent
or planning round was launched.

- **T1:** full relevant context completed before the fresh `12:41:05Z` T2
  inspection. Individually verified pinned PR18 pages12–14 and PR19
  pages11/20/21/26/27/29/30/31/32, including exact IDs/authors/timestamps.
  Read current PR body, relevant actual diff, empty formal reviews/threads,
  and authenticated completed text logs: native `34594725266` /
  `103247716857`; CI `34588742446` attempt2 DB `103238729122`,
  App `103238728749`, and Apple `103238728343`. Historical DB preservation
  success is separate from its later served failure; native orchestration
  success is not preservation success. No artifacts/images were opened.
- Repository context actually read: root `AGENTS.md`,
  `.github/copilot-instructions.md`, cloud/local-backend guides, Phase 0
  result lines1–125 and current Phase 2 opening/B1 append lines3471–3855;
  blueprint 00/03/05/08/10/13/14/15-I29/18/19/20/21 and child instructions.
  All seven migration bodies were read and their inventory hashes checked;
  blueprint07 matched the fully read initial migration byte-for-byte.
  Read all six targets, relevant tracked/ignored generated RPC contracts,
  `ai-analysis-rehearsal.mjs`, `preservation-rehearsal.mjs`, `db.mjs`,
  `run-local-tests.mjs`, relevant fixture/preservation/analysis-session callers,
  handler/protocol/index/Google adapter, JPEG validator, targeted endpoint/
  schema/preservation test contracts, package/TypeScript/config/setup/CI.
  Historical file excerpts are not represented as new live evidence.
- **T2:** fresh branch/head/tree matched the pins; staged/unstaged/untracked
  source was clean. Authenticated PR metadata confirmed base/head despite
  unavailable older shallow history; no fetch/reset/rebase was attempted.
  Current run `34599471062`, job `103262980344`, explicitly succeeded at
  Docker step36, start41, reset/fixtures46, ignored generation51 and cleanliness56.
  Current RUNNER_TEMP transcript IDs/time bindings:
  `2c9fa7c1…` Docker `12:34:14.723Z`;
  `12621339…` start `12:35:30.018Z`;
  `48ace337…` reset/fixtures `12:36:12.807Z`;
  `81364202…` actual generation `12:36:24.439Z`;
  `94bc74f9…` cleanliness `12:36:24.966Z`.
  Start/reset/fixtures/generation explicitly passed; generation reported
  `PARITY: MATCH`. Zero-byte cleanliness was paired with successful step56
  and fresh Git checks, not silence alone. Ignored generated bytes matched
  tracked types; no pending file existed. Credential files were checked only
  for existence/ignored status, not contents. T2 completed `12:41:23Z`.
- **T3:** only after T2, deliberate PR19 page33/perPage1 returned exactly own
  [receipt 5634509076](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634509076),
  drrowdev, created=updated `12:34:56Z`, strictly after cutoff. It matched
  the kickoff/source and task `bf6f33b6-6bff-4d8e-8a64-1a3646c7ff34`,
  session `16efd2a1-c25e-47e5-8cce-7e5b35db0560`; actual coordinator
  platform GET verified `sweagent-capi:gpt-6-astra`, explicitly selected.
  Receipt prefix: 32 unique IDs, SHA256
  `c99f34751faeabba1848384b5ecb24a082ef3fcbb5a6e5b83b86bb1bc0407778`.
  **T4:** initial progress operation followed verified T3, before any
  repository import/test/edit/commit operation.

### Corrective source and native validation

Exactly six paths changed: `scripts/backend/local.mjs`, `local.d.mts`,
`tests/unit/local-backend.test.ts`, `docs/local-backend.md`,
`docs/cloud-development.md`, and this result. Production function/protocol,
rehearsal/served children, SQL/types, setup/CI, dependencies, images and Save/UI
remain frozen. Runtime null is accepted only for not-running; the Docker reader
maps only exact created/false/canonical-zero metadata. The first distinct ID and
first fresh start are pinned; pre-confirmation OPTIONS may wait within the
original deadline, but confirmation cannot restart. Default overflow retains
only the bounded prefix; explicit caps discard overflow and timeout stays
nonzero. Existing argv, capture, deadline/lifetime and owner/accounting bounds
remain unchanged.

| Approved native command/check | Actual result |
| --- | --- |
| `npm run test:unit -- tests/unit/ai-endpoint.test.ts tests/unit/ai-schema.test.ts tests/unit/local-backend.test.ts tests/unit/preservation.test.ts` | **660/660**, four files, exit0, 12:43:02Z. |
| `npm run typecheck` | Initial test mock inference error corrected with nullable reader annotation; rerun exit0. |
| `npm run lint`; `git diff --check` | Exit0. |
| `npm run test:unit` | **1434/1434**, 19 files, exit0, 12:43:33Z. |
| Changed-file secrets; committed-code automated validation | Pending at this source checkpoint. |

These are synthetic unit/static results, not actual Docker startup, normal-owner
or preservation proof. Under P4 **no post-setup native** reset, preservation,
integration/security, B1 rehearsal/probe, typegen, browser/build/capture ran.
This corrects source without diagnosing historical S1 or served failures.
Independent repair-only review, first separately authorized exact-head CI/Apple,
serialized live preservation/normal-owner/security/B1 Auth-DB, final generated
types/parity, App/browser/translations/build/dependency/secret, eight bounded
artifacts, actual coordinator visual review and terminal native audit remain
mandatory/pending. Current starting-head CI/Apple was not authorized or rerun.
No additional agent/branch/PR, hosted/provider/paid/private-photo work, merge
or deployment occurred.

### Committed correction validation and handoff

Corrective source commit `ef41d206a4ab144f30a89342694e16b040e75be7`, tree
`9d6faa81770e59fd6298755841925b5c296bb5b3`, contains exactly the six authorized
paths. Post-commit Git status was clean. The changed-file secret scan covered
all six files before commit and found no secrets.

Committed-code automated validation returned **CodeQL Actions/JavaScript:
0 alerts**. Automated code review was **unavailable, not passed**: the wrapper's
success heading/no-comments summary was contradicted by the actual
`capi-prod-claude-sonnet-4.6` missing-model error at `12:45:16.675Z`.
No fallback model, new agent, or repeated tool invocation was used.

The 660 targeted and 1434 full unit results and type/lint checks above apply to
this executable correction. This final evidence append changes documentation
only. Genuine independent repair-only review, terminal native/setup audit and
all exact-final-head CI/live/Apple/artifact/actual visual gates remain pending.
The coordinator owns review, evidence and execution/merge decisions; the worker
has not authorized Actions, rerun a failed job, merged, deployed, or begun
another packet.

## PR #19 B1 duplicate diagnostic removal - 11 September 2026

The completed c906 CI `34600735898` attempt 2 / DB job `103276404916`
passed strict B1 readiness (1418 ms, replacement/running/fresh/stable, 204)
and logged the old-browser-preflight 200, then failed at `served-entrypoint`
before the actual-handler comparison or authoritative served child. The
immediate transport/cancellation cause is unknown; this does not diagnose
earlier S1/served/B3 failures. Populated preservation and the preceding normal
owner/security checks passed, but the separate B1 real Auth/DB plus
Google-only-synthetic proof and generated types/parity did not complete.

Apple job `103276398217` records 4 + 3 passing cases. App `103276404659`
records 1434 units in 19 files and 471 EN/FI/SV keys, but browser/captures
never ran. The coordinator-observed check annotation confirms its 20-minute
job limit expired during Playwright system-dependency installation, not an
application/browser assertion failure. The slow download cause remains
unproven; no timeout/workflow/dependency change or unchanged rerun is authorized.

[Local cutover 5634938691](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634938691)
and [three-file amendment 5635450715](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5635450715)
control this continuation from `c906bbd9947169a17758ef2af46ea22b17d1ebd0`,
tree `c3f886ae4a6ee2a8afb4c9f7de212d463d839e72`, base
`de6bca3ebd7d01b96e313e47353711908f3b8a3e`. Actual Anthropic Claude Opus 5
reviewer `223d6728-9657-4479-8ea0-1da7421db2d3`, turn 14, accepted A1-A3;
the coordinator adopted them. After read-only context and fresh clean-source
inspection, this same local session read and matched its own
[coordinator-observed local model attestation/edit permission 5635556891](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5635556891).
This is local app/usage evidence for actual `gpt-6-astra`, not a native receipt.

Only the comparative loop was removed from `scripts/ai-analysis-rehearsal.mjs`.
Strict startup, the authoritative served child, health/stop calls, deadlines,
closed diagnostics, matrix, preservation and restoration remain unchanged.
One test in `tests/unit/local-backend.test.ts` requires both source anchors in
order and rejects direct `fetch` invocation between them. It is a textual
non-reintroduction guard, not live transport/readiness/child proof. This result
append is the third allowed file; all other paths remain frozen.

[Execution amendment 5635728250](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5635728250)
records the same actual Anthropic Claude Opus 5 reviewer's turn 15:
final parent/test diff **PASS, no findings**, execution amendment **ACCEPT**
with coordinator-adopted B1-B7. The coordinator separately inspected this
result append. For this exact three-file delta only, reviewed source inspection
and `git diff --check` replace successful local automated checks as the
pre-commit condition. Unit/type/lint/secret requirements remain blocked locally
and pending in unchanged full exact-new-head CI, not waived or passed.
The reviewed code/test files remain byte-identical.

Local commands use isolated Node 24.19.0 / npm 11.17.0, not global Node 24.11.1.

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:unit -- tests\unit\local-backend.test.ts` | Initial exit 1: Vitest unavailable because dependencies were absent. |
| `npm.cmd ci --no-fund` | Exit 1: effective package-feed proxy returned E404 for locked `jose@6.2.12`; npm automatic cleanup also reported EPERM under partial `node_modules/playwright-core/lib`. Lockfile/package/pins unchanged; no registry override or manual cleanup attempted. |
| Targeted units after restore, typecheck, lint, existing `npm.cmd run scan:secrets` | Blocked by failed locked dependency restoration; no passing results claimed. The scanner has no `--changed-only` flag. Local scanning without build/canary is not built-bundle/canary proof. |
| `git diff --check` | Exit 0 on the scoped three-file patch; whitespace evidence only. |

The coordinator's secure HEAD requests to the canonical locked package URL
failed with .NET `TLSHandshakeFailure` and Node HTTPS `EPROTO`; the underlying
routing/transport cause is unknown. The failed restore supplied no usable
dependencies or validation. Final filesystem metadata reports `node_modules`
absent; no manual cleanup occurred, and its paths remain ignored. No dependency
retry, registry/TLS override, package substitution, state copying or manual
cleanup is authorized.

No local backend/browser/build/service command, image input, push or Actions
execution occurred. Final document/commit inspection and exact-commit
push/first-CI permission remain coordinator gates; only a local commit is
authorized by the amendment. All exact-head CI/live preservation,
normal-owner/security/B1 real Auth-DB/types/parity, App/browser/native Apple
and approved-artifact actual visual review remain mandatory. No source-complete,
merge-ready, hosted/provider/paid/deployment or human-acceptance claim is made.

## I29 B2 trusted analyzed-item Save source - 12 September 2026

**Unstaged source implementation; not locally executed, independently accepted,
published, merge-ready or deployed.** Requirements R18/R19/R23/R26/R27/R28;
preserve independent-owner R01/R11 and Phase 0 engineering-complete /
acceptance-open boundaries.

Base/head remains `6ba1b88365b5ffb66033f28feb6b0dc65a394a4a`, base tree
`85fffe2e7908593ca46485b5a4ba41e4d3df9135`, isolated branch
`drrowdev-sturdy-telegram`, sole local writer
`7f9ce2cb-b215-48ba-a15c-b2b5790eb872`.
[Proposal 5640041892](https://github.com/drrowdev/stillroom-wardrobe/pull/20#issuecomment-5640041892),
[actual Anthropic Claude Opus 5 turn-22 critique 5640286958](https://github.com/drrowdev/stillroom-wardrobe/pull/20#issuecomment-5640286958)
and [controlling approval/user decision 5643582833](https://github.com/drrowdev/stillroom-wardrobe/pull/20#issuecomment-5643582833)
bound the maximum 29 paths. After completed read-only intake/supplement, the writer
read its entire [own coordinator-observed LOCAL model attestation and source-edit
permission 5643664527](https://github.com/drrowdev/stillroom-wardrobe/pull/20#issuecomment-5643664527)
before editing. This is independently crossmatched local usage for this
session's actual gpt-6-astra, not native-platform-equivalent evidence.

The eighth migration preserves all seven prior SQL files and pins. A protected
initial item-projection marker, checked canonical B1 facts and an UPDATE barrier
separate genuine analyzed attribution from user assertions and explicit unknowns.
Manual admission is extracted without changing its validations, identity lifecycle
or fingerprint; the old manual composer, transport and assertions remain.
Separate frozen attempt metadata and owner-lifetime receipt-use identities
survive short-lived analysis cleanup. Completed history binds a nullable owned
source-image link only after successful image commit.

The sibling client route reserves, uploads immutable thumb/main objects and calls
the synchronous authenticated finalizer. Auth/Storage use the ordinary token;
only the narrow completion RPC receives the server credential. Actual downloaded
bytes, dimensions and hashes are checked before matching exactly two real
Storage object IDs/opaque versions under transactional locks. No JWT/GUC
impersonation, legacy helper delegation, signed URL, new inference or Storage
mutation is part of service completion.

The user-selected already-started Save survives later AI opt-out, analysis-only
discard, expiry and AI deactivation. Current account/row/object guards and
explicit Save cancellation still apply. Expired-first proof never silently
downgrades. Both blueprint `08` and `20` state this temporal boundary.

Source tests explicitly wire ordinary-session baseline suites into the hardcoded
runner and full B2 cases into the owned rehearsal with actual Deno/Auth/DB/Storage
and Google-only synthetic transport. The original B1 twelve synthetic generations
and original fourteen-ledger/two-ready restoration are retained separately;
B2 plans 22 additional synthetic generations. New cases cover mixed provenance,
raw/import/update refusals, service/peer/anonymous denials, byte/object replacement,
completed replay, source-image cleanup, cancellation and seeded-expiry/consent
boundaries. Named SQL-held-lock handshakes exercise actual profile/item/image/
object conflicts rather than claiming parallel HTTP necessarily overlapped.
B2 cleanup is bounded to its synthetic identities and restores the original
private fixture snapshot on success only. B1 and B2 each advance the ordinary
profile consent CAS twice per owner; neither is represented as unchanged profile
timestamps or an elapsed-time expiry test.

Under this packet's CI-backed execution approval, **no local npm/Node, unit,
lint, type, translation, scanner, build, browser, setup, backend or provider
command ran**. No dependencies were restored or probed. SQL-projected public RPC
types are **provisional**, not generated evidence: the complete first exact-head
CI-generated artifact must prove or replace them before merge. Non-executing
Git/diff/source-hash/manual review is not a passing application test or packaged
credential scan. Snapshot-bound credential-pattern and publication permissions
remain coordinator gates; no new scanner profile is inferred.

All existing exact-head CI gates remain owed: lint/type/EN-FI-SV/unit/build,
full scanner plus canary, dependencies, browser/eight approved captures, native
Apple, preservation/recovery/security/normal owners/B1/B2 and generated-type
parity. Real pinned Storage version and lock behavior are unexecuted prerequisites,
not a hosted claim. Genuine final independent review and coordinator-owned
visual review remain pending. No UI/title/description/provider expansion,
saved-only backup/history restore completion, hosted migration, paid activation,
deployment or human acceptance is claimed. PR #20 stays closed.

## I29 photo-first C source candidate - 12 September 2026

**Unstaged source; not executed, independently accepted, published, merged or
deployed.** Requirements R18/R19/R23/R26/R27/R28 retain independent-owner
R01/R11 and Phase 0 engineering-complete / acceptance-open distinctions.
The preceding B2 section is its historical intake record. B2 subsequently
completed under PR #21 comments
[5645805099](https://github.com/drrowdev/stillroom-wardrobe/pull/21#issuecomment-5645805099)
and [5645868493](https://github.com/drrowdev/stillroom-wardrobe/pull/21#issuecomment-5645868493);
its merged source is this packet's base, not new C validation.

This one persistent local GPT-6 Astra writer is canonical session
`c69545b0-699e-4284-b64e-99cb7bcbf371`, workspace alias
`fd165bf2-e75e-4ad4-a64d-7012af4536b8`, isolated branch
`drrowdev-animated-fiesta`. Base/start HEAD remains
`56e52790d6f2014d6a0383ec478c20d70cefd486`, tree
`f9afd08446c7f3f21a01d050ee6f2353307adefd`. Completed read-only context preceded
reading the complete
[own attestation and 33-path source permission 5646092805](https://github.com/drrowdev/stillroom-wardrobe/pull/21#issuecomment-5646092805).
The [proposal 5645946533](https://github.com/drrowdev/stillroom-wardrobe/pull/21#issuecomment-5645946533),
[controlling amendment 5646005294](https://github.com/drrowdev/stillroom-wardrobe/pull/21#issuecomment-5646005294)
and [approval 5646036986](https://github.com/drrowdev/stillroom-wardrobe/pull/21#issuecomment-5646036986)
record the retained Anthropic / claude-opus-5 reviewer
`d4c52a66-e314-4ad0-a96a-675e79fdd049`, turns 4/5 and PASS-amended-plan.
Supported coordinator-observed local telemetry is not native-platform or
tamper-proof evidence; the stopped B2 writer's receipt was not reused.

The source connects consent/status, committed-photo automatic analysis,
locally generated once-per-result EN/FI/SV title/description/tags, all-field
review and explicit trusted/unverified Save. Original manual transport stays
manual. Consent shares the profile/language mutex with nullable typed REST,
an ACK floor, exact own AI-only +1 rebase guard and explicit read-only
reconciliation after uncertainty. Edits/clears, language invariance, expiry,
owner/epoch and stale-generation guards remain. Save/Cancel share a latch;
only a fully validated same-attempt B2 fingerprint enables cancellation.
Missing proof does not trigger reservation from Cancel. Unresolved navigation
does not claim cancellation, deletion, completed Save or refund.

The existing `node scripts/ai-analysis-rehearsal.mjs` CI collector now describes
C after B1/B2 success restoration. It directly spawns the installed
`node_modules/@playwright/test/cli.js test --config playwright.ai.config.ts`
with one Chromium worker, retries zero and a 120-second child inside the fixed
600-second parent deadline. Numeric entry/startup/child/headroom diagnostics
fail closed when there is insufficient time; the budget is not extended.
The exact analysis-route bridge uses the same Node production handler with
only synthetic Google/OAuth transport. Real ordinary Auth/REST/Storage and
Deno finalization are not mocked. Two C UUID namespaces retain native random
suffixes, two distinct prepared photos bind request-local bytes/dimensions/hash
to provider input and real attestation, and each owner explicitly opts out/in
(+2 profile CAS) and Saves once. Raw child output is withheld. Exact owner
cleanup and parent exact-ID/private restoration happen only after their
success gates, preserving all non-C inventories and existing image bytes.
No normal integration collector, SQL/types, backend helper, dependency,
provider, codec, setup or root-policy file is changed.

Browser source adds EN/FI/SV draft/control/navigation cases and retains the
existing functional suites. One pinned one-day artifact step lists exactly
four new synthetic PNGs under `test-results/i29-photo-first-visual`: consent
and analyzed draft at EN desktop 1280 and FI mobile 320, each at most 1 MiB.
All eight existing captures remain. No writer image review is performed.

Under the source-only permission, **no local npm/Node/version, lint/type,
unit/browser/backend, translation/scanner/build, dependency or installation
command ran**. Non-executing source/Git/hash inspection is not runtime or
security-scanner evidence. Locked dependencies remain unrestored. Full
changed-file five-pattern manual review, retained independent source review
and separate publication permission precede any commit/PR. Full automatic
exact-head CI, Apple, generated-type parity, real normal-owner DB/Storage/
security/preservation/recovery, B1=12/B2=22/new C=2, and coordinator artifact
run/head/hash/verdict remain pending. Human/device/release, saved-only backup/
history restoration, hosted migrations, paid/private-photo activation and
deployment remain pending and separately authorized; PR #21 stays closed.

## I29 photo-first C first-CI correction candidate - 12 September 2026

**Five-path source-only correction; unstaged and not yet independently accepted
or published.** The preceding source-candidate checkpoint remains historical.
That candidate and its first source-review correction were subsequently
accepted, committed as `293ff3bf7663161ff4542fe9715bbfc929e59e8a` (tree
`fc872cbbb864b4817c7a9ac23208b0fa8d9afe32`, sole parent
`56e52790d6f2014d6a0383ec478c20d70cefd486`) and published as draft
[PR #22](https://github.com/drrowdev/stillroom-wardrobe/pull/22).

The coordinator's [first exact-head evidence and proposal 5646602214](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5646602214)
records attempt 1 at that head:

- [CI 34699742483](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34699742483)
  failed. App job `103569267225` passed `npm ci --no-fund`, then failed
  `npm run lint`: `src/data/ai.ts:86`, `no-unsafe-finally` / unsafe throw.
  Typecheck, translations, unit, build, scanners, dependency checks, browser
  checks and all twelve visual artifacts were skipped, not passed.
- Backend job `103569267238` passed setup/reset, ordinary integration/security,
  real recovery, B1's exact 12 generations/restoration and B2's exact 22
  additional generations/restoration, then failed at `C-ui-child`. Fixtures
  were preserved, without success restoration. Generated types/artifact/parity
  were skipped. C entry headroom was 557985 ms; startup elapsed 3128 ms and child
  headroom 554857 ms; elapsed from C entry at child exit 5552 ms and remaining
  552433 ms. This is not evidence of insufficient headroom.
- [Apple 34699742501](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34699742501),
  job `103569267251`, passed generated-JPEG 4 cases (17.4 s) and native
  orientation/composition 3 cases (13.6 s). Those limited cases do not establish
  AI UI behavior or visual acceptance.

The source required a nonnull profile language before opening the UI, although
the actual fixture contract permits null and the existing application performs
ordinary first-login language initialization. This precondition mismatch is
source-confirmed; the precise failed child assertion is still unknown because
raw output was withheld. Collection/compile failure is not excluded, and the
first-head typecheck did not run.

The [controlling amendment and own source-only permission 5646653804](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5646653804)
records actual retained reviewer
`d4c52a66-e314-4ad0-a96a-675e79fdd049`, Anthropic / `claude-opus-5`,
turn 8 PASS with controlling conditions and coordinator resolutions.
This is amendment approval, not new-source acceptance. The same canonical
`c69545b0-699e-4284-b64e-99cb7bcbf371` GPT-6 Astra writer retained the isolated
workspace/branch/model. Fresh entry inspection matched clean `293ff3bf`, its
tree/parent and all 33 accepted working SHA256/canonical Git blob/byte pairs.
The full own permission was reread after targeted context and before edits.

This correction moves successful reply return and cleanup-only rejection
outside `finally`, retaining bounded cancellation, lock release and primary
failure priority with explicit failure-presence flags for unknown/falsy
rejections. Added unit source covers delayed cleanup, cleanup-only failures
including undefined/null/false/0, and primary read/parse/cancel/lock-release
failure priority.

C now retains the original nullable profile and uses browser locale `en-US`.
After UI readiness it independently verifies settled initialization: original
null must become `en` at exactly +1; an existing language must remain at the
same version. All other parsed profile values remain equal. The consent
baseline is taken only after that proof; AI opt-out/opt-in still requires
exactly +2, with unchanged non-AI values through analysis/Save/reload.
Only after a fully successful owner journey and successful browser context
closure does an ordinary fresh-version CAS restore an originally-null language
at exactly +1. No failure catch/finally performs restoration. The parent
independently captures C-entry profiles, checks their B1/B2 +4 baseline and
derives total +6 for originally-nonnull or +8 for originally-null profiles,
never a version range. Full non-AI profile equality and explicit AI consent
state checks remain gates, together with existing inventory/ready/baseline
equality and exact-ID success-only private restoration.

The child progress protocol emits only finite fixed stages and owner index
0/1/2 (23 ordered records on success). The parent bounds capture at the existing
262144 bytes, progress lines at 4096, progress records at 32 and record bytes at 128,
then synthesizes a fixed last stage/index and numeric exit alongside existing
timings. Missing, malformed or truncated progress is diagnostic `UNKNOWN`, not
a new success/failure gate. Exit code 2 remains ambiguous, not an inferred
timeout. Raw stdout/stderr remain private. Marker-aware, bounded per-line
parsing tolerates dot-reporter decoration for both protocols; an actual exit 0
still requires exactly one <=4096-byte success receipt, strict JSON, the same
closed ten-key/two-owner membership and independent request/attestation binding.
Duplicate/invalid success receipts fail. The generic failure label now says
AI rehearsal rather than incorrectly assigning a C failure to B1.

Only `src/data/ai.ts`, `tests/unit/ai-client.test.ts`,
`tests/integration/ai-photo-first.spec.ts`, `scripts/ai-analysis-rehearsal.mjs`
and this phase result are changed. The other 28 packet files, SQL/types,
profile controller/adapter, backend helpers/collector, provider/codec,
dependencies/configuration/workflows and all 12 capture definitions are frozen.
The 600-second parent, 120-second child, 150000/135000 ms admissions, one
Chromium worker/retries zero, B1=12/B2=22/C=2, two distinct real prepared JPEGs
and one explicit Save per owner are unchanged.

No local runtime/version/install/lint/type/test/scanner/build/browser/backend
command was run for this correction. Manual source/hash inspection is not
compiler or execution proof. Coordinator full-five-pattern refresh and actual
retained independent source-delta adjudication remain required before separate
commit/publication permission. All new-head CI/type/real-owner/C/restoration/
twelve-visual gates remain pending, as do human/device/release, hosted,
paid/private-photo activation and deployment gates. No merge, deployment,
paid/private activation or production change is claimed or authorized.

## I29 C compiler correction candidate - 12 September 2026

**Source-only, unstaged; new-source acceptance and execution pending.**
The coordinator's [exact-c3 evidence 5646866990](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5646866990)
records CI `34702229945` at `c3d92b0ff198c2f342fcb53e312cf34aed2df0af`:
real ordinary-owner integration/security/recovery, B1=12, B2=22 and C=2
passed, including one explicit Save per C owner and exact cleanup/restoration.
App lint passed, then typecheck failed on incompatible cached/refreshed SDK
response unions and the hook edit-loop inference cycle. Later App checks and
all twelve visual artifacts were skipped. Apple `34702229972` passed its
limited 4+3 cases. None of these results establishes a later source head.

After the successful real rehearsals, `npm run db:types` failed: the closed
diagnostic classified run-container / exit-125, but the underlying cause
remains unknown. Generated-type artifact/parity were skipped. No schema,
helper, dependency or configuration remedy or blind rerun is authorized;
the next genuine source head must run the unchanged full pipeline.

[Own permission 5646910665](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5646910665)
records retained Anthropic / claude-opus-5 reviewer
`d4c52a66-e314-4ad0-a96a-675e79fdd049`, turn 10 pre-edit PASS with conditions,
not new-source acceptance. The same GPT-6 Astra writer verified clean c3 and
all 33 accepted triples, read targeted context and reread full permission.
This four-path candidate separates cached/refreshed responses and validates
the selected session, adds only the existing `AiTransition` annotation to the
hook's edit result, and adds typed returned-error/wrong-owner/thrown-rejection
no-dispatch tests plus a refreshed-token case. Existing guards, null/manual
editing, refresh/no-401-retry and fifteen cleanup cases remain unchanged.
The defensive refresh-null check remains; an error-free null-session mock
is omitted because compatibility with the unavailable local SDK declarations
could not be established without prohibited dependency restoration or casts.

No local runtime/compiler/tests/install/probes ran. The other 29 packet files
remain frozen. Coordinator manual refresh, retained source-delta adjudication
and separate commit/publication permission are pending, as are new-head full
CI/type/C/restoration/generated-type/twelve-visual and human/release gates.
The separate UX-copy request is not part of this correction. No hosted,
provider, paid/private-photo activation, deployment or merge is authorized.

## I29 C import-boundary correction candidate - 12 September 2026

**Source-only and unstaged; new-source acceptance/execution pending.**
[Exact-7344 evidence 5647126842](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647126842)
records CI `34704304057`: lint/typecheck/translations and all 55 ai-client
cases passed; unit totals were 1563 passed / 2 failed. Failures at
`ai-schema.test.ts:366/377` enforce the historical unwired/B2-only contract,
which predates the reviewed C incoming edges and draft-to-presentation import.
Backend ordinary-owner/security/recovery/B1/B2/C/exact restoration, generated
types and repository parity passed. Apple `34704304073` passed its limited
4+3 cases. The prior generator failure did not recur without changes; its
cause remains unknown, not repaired. Later App build/canary/scanner/dependency/
browser and all twelve visual steps were skipped.

[Own permission 5647170119](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647170119)
records actual retained Anthropic / claude-opus-5 turn 13 pre-edit PASS with
A1-A6, not resulting-source acceptance. This two-file correction extends the
packet to 34 paths only for the existing schema test. A single exact-path
admission predicate serves real source assertions and positive/negative
canaries; the full walk must equal the static seven incoming pairs. The
shared outgoing pool adds presentation only for the draft core. The AST
walker, Bundler resolver, seven-form probe and non-vacuity oracles remain
unchanged, as do the test's first 316 lines and all production/UI/copy.

No local runtime/compiler/tests/install/probes ran. The other 32 packet paths
remain frozen. Coordinator manual refresh, actual source-delta adjudication
and separate commit/publication permission precede fresh full CI, including
App/unit/ordinary-owner/B1/B2/C/restoration/types/Apple/twelve-visual gates.
Human/release and hosted/provider/paid/private/deployment gates remain pending;
no generator repair or UX-copy work is authorized here.

## I29 C browser-fixture repair candidate - 12 September 2026

**Source-only, unstaged; execution and resulting-source review pending.**
[Exact-462 evidence 5647388954](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647388954)
records CI `34706266313`: lint/type/translations, 1579 unit tests, build/canary,
secret/dependency checks passed; browser totals were 524 passed / 32 failed.
Backend normal-owner/security/recovery/B1=12/B2=22/C=2/restoration/types/parity
and Apple `34706266181` passed. Visual uploads were skipped; no twelve-image
acceptance follows. The unchanged generator passed again; its earlier failure
cause remains unknown. The 462 type artifact has not yet been independently
content-reviewed; historical 7344 artifact verification is not new-head proof.

[Own permission 5647465239](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647465239)
adopts actual retained Anthropic / claude-opus-5 turn 16 AMEND conditions M1-M7.
This seven-file candidate preserves legacy request records and adds separate
issued-bearer/empty-object status proofs, exact preparation-trigger oracles,
and response-listener timing outside delayed route handlers. The existing
loopback server gains a separate optional analysis protocol; its actual bounded
stream supplies the synthetic hash, never Playwright's body inspector.
Storage guards/counters, production/UI/copy and all twelve capture bounds stay
unchanged. Added canaries cover binary equality, corruption/truncation detection,
byte limits, invalid input, expected rejection liveness and isolated cleanup.

No local runtime/compiler/tests/install/probes or image review ran. The other
27 packet paths and this document's original 294569 bytes remain frozen.
Actual WebKit wire corruption, emptiness or truncation would remain a blocker,
not permission for reconstructed bodies, skips or weaker checks. Coordinator
manual refresh, independent source review and separate commit/publication
permissions precede fresh exact-head CI/types/Apple/twelve-visual gates.
Human/release/hosted/provider/paid/private/deployment gates remain separate;
this is not the UX packet or a claim of full browser acceptance.

## I29 C status setup and storage observation candidate - 12 September 2026

**Source-only, unstaged; source review and execution pending.**
[Exact-47e evidence 5647757080](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647757080)
records CI `34709652699`: 1579 units passed; browser totals were 614 passed,
2 failed and 4 project-gated visual cases skipped. The previous 32 failures
and new analysis-wire canaries passed, including WebKit. Backend ordinary-owner,
security/recovery/B1=12/B2=22/C=2/restoration/types/parity and Apple
`34709652652` passed. Type artifact content and twelve-image acceptance remain
unreviewed. The status canary included late StrictMode image GETs; the separate
WebKit multipart parallel OFF case returned 400 on both configured attempts.
Its cause remains unlocalized; passing ON and analysis tests do not diagnose it.

[Own permission 5647876516](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647876516)
records actual replacement Anthropic / claude-opus-5 reviewer
`1689057f-d002-4b02-abd9-9e188d72a0a8` AMEND and coordinator resolutions R1-R3.
This four-file candidate completes two items and two item-images responses
before the status baseline. Storage observation uses the existing state,
independent of the single old-option-derived response-decoration flag, with
one copied first POST400-attempt snapshot and explicit retry/mode labels.
OFF still does not read response bodies; normal OFF serialization is preserved
structurally, not proven by a new runtime body-equality check. Last-facts null
overwrites, multipart protocol, transport, strict assertions and captures stay.

No local runtime/compiler/tests/install/probes or image review ran. Other30
packet paths and this document's original 296804 bytes remain frozen.
Observation adds overhead, not a storage fix; ON response draining remains an
untested alternative hypothesis. Source review and separate commit/publication
permissions precede any next exact-head CI. The proposed later budget is one
ordinary PR-sync CI only; if still unlocalized, even if green, a user decision
is required. Any 400/reset/lost/corrupt/empty bytes, cleanup failure or flaky
retry blocks; no repeat diagnostics or PR16 waiver follows. Fresh compiler,
browser/normal-owner/B1/B2/C/restoration/types/Apple/twelve-visual/human gates,
UX and hosted/provider/paid/private/deployment authority remain separate.

## I29 C retry-guard correction candidate - 12 September 2026

**Source-only, unstaged; corrected-head validation pending.**
[Own permission and evidence 5648083748](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5648083748)
records exact-944 CI `34712818709`: install passed, then App lint failed at
`slice.spec.ts:340:98` with `no-unsafe-finally`. Remaining App type/translations/
units/build/scanners/browser and visual uploads were skipped. Backend
ordinary-owner/security/recovery/B1=12/B2=22/C=2/restoration/types/parity passed;
Apple `34712818790` passed its four generated and three native cases.
No browser observation ran; the WebKit storage cause remains unknown.

The same Anthropic / claude-opus-5 reviewer `215a1de6-d6ea-4629-b745-f54a666171ef`
assessed this semantics-preserving correction and replacement-budget amendment.
The unchanged invalid-retry predicate now sets captureError directly; only its
else branch assigns retry and collects the same evidence in the original order.
Defaults, surrounding catch, annotation/logging/cleanup, R1/R2 and all strict
transport/capture assertions remain. Other32 paths and this document's original
299268 bytes are frozen. No local lint/compiler/tests/runtime/install/probes ran;
prior source review was not lint proof and this candidate has no runtime pass.

The user approved one replacement normal full CI plus existing Apple companion,
only after source review and separate commit/publication permission. No unchanged
rerun or further diagnostic loop is authorized. Still unlocalized, even if green,
requires a user decision; any 400/reset/lost/corrupt/empty bytes, cleanup failure
or flaky retry blocks, without a PR16 waiver. All corrected-head automated,
twelve-image and human/release gates remain pending; UX/hosted/provider/paid/
private/deployment authority remains separate.

## I29 C reservations-test observation candidate - 12 September 2026

**Source-only, unstaged; source review and new-head validation pending.**
[Independent 2a4 assessment 5648305666](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5648305666)
records an unchanged-against-main reservations/credentials test with a WebKit
upload failure and successful configured retry, but no same-attempt receiver
facts. No affirmative source evidence attributes it to C; neither harness-only
causation nor production-photo corruption is established. Coordinator
[2a4 artifact/visual review 5648267317](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5648267317)
verified types and twelve images without an additional blocking scoped defect;
that dated evidence does not remove the flaky-upload or human acceptance gates.

[User cycle approval 5648398993](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5648398993),
[plan 5648406473](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5648406473)
and [own source permission 5648467753](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5648467753)
record actual Anthropic / claude-opus-5 reviewer215a1de6 Turn4 AMEND and
coordinator resolutions A1-A3. Only the selected case opts into existing server
observation, from setup through the final assertion, with synchronous bounded
finally evidence and unchanged fixture teardown. All original requests,
payloads, response/body-reading behavior and strict assertions remain; the
shared sender, receiver and passing parallel cases are untouched.

Route counters include preceding refusals; the intended valid upload is the
first receiver POST, not a guessed measured counter result. Observation adds
counters/stages/facts, envelope/high-byte work after stream drain and other
bookkeeping; scheduling/response timing effects are not excluded. A captured
stage is not a fix and clean non-reproduction is not localization.

No local runtime/compiler/lint/tests/install/probes/scanner or image review ran.
Other32 paths and this document's original301163 bytes remain frozen. Source
review and separate commit/publication permission precede the user's one future
normal full CI plus existing Apple cycle. Even lint/setup failure consumes it;
no automatic replacement, unchanged rerun or further loop is authorized.
Missing evidence, bad uploads/bytes/reset/cleanup or flaky retry blocks.
Still unlocalized, even if green, requires a user decision; no PR16 waiver.
All corrected-head automated/twelve-image/human gates remain pending; UX and
hosted/provider/paid/private/deployment authority remain separate.

## I29 C raw-analysis observation candidate - 13 September 2026

**Source-only; unstaged, independent SOURCE review and new-head gates pending.**
[User approval 5651327667](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5651327667)
and [proposal 5651291047](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5651291047)
address two dated861 WebKit raw-analysis400 flakes. Existing multipart counters
cannot identify those raw-branch failures. The oversized and synthetic504 calls
use the browser test sender, not the application AI client or a provider timeout;
this does not establish a harness-only cause or exclude production risk.

[Actual plan AMEND/resolutions 5651362398](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5651362398)
records replacement reviewer c372f28c-ff12-4e64-b313-4227796ac4e2, Anthropic /
claude-opus-5/high, and adopted M1-M9. [Own source permission 5651366729](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5651366729)
records coordinator-observed same-writer GPT-6 Astra usage and the clean resumed
preflight. Local telemetry is not native/tamper-proof. Earlier preflights stopped
on reviewer-owned scratch; its removal and fresh checks, not those partial
checks, established the clean baseline.

Only the two selected cases enable a separate four-POST-capped raw observer.
Overflow is an evidence error. Primitive first-attempted400 guard/lifecycle facts
remain separate from per-POST bytes/ordinals, write status, existing end-callback
and suppressed-rejection metadata. Copied evidence precedes page cleanup; outer
synchronous emission retains the original cleanup call and exception precedence.
WriteHead return and end-callback execution do not prove client delivery; a false
callback flag at snapshot is not itself failure. Actual console attempt records
are required; captureErrorfalse does not establish every emission succeeded.

Original sender/URL-only forwarding, response bodies/draining, socket lifecycle,
timers/retries, strict status/byte/hash/isolation/cleanup oracles and twelve capture
bounds remain unchanged. Other30 paths and all303883 pre-append document bytes
are frozen. No local runtime/compiler/lint/tests/install/probes/scanner or image
review ran. Observation overhead is not zero or ruled out; close ordering is an
unranked hypothesis, not an identified cause or fix.

Actual SOURCE review and separate commit/immutable/publication permission remain.
The new one-normal-CI-plus-existing-Apple allowance is unspent and publication
gated; early failure consumes it, with no automatic replacement or unchanged
rerun. Missing evidence, invalid bytes, failed/flaky requests or cleanup failure
blocks; a captured guard is localization, not repair or waiver. New-head automated,
types/twelve-image/human gates remain pending. No transport repair, UX, merge,
deployment, hosted/private/paid/provider authority follows.

## 13 September 2026 - reviewed UX-copy source candidate (unstaged)

This append follows the [UX proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5646983663),
[actual Anthropic T12 critique and coordinator amendments](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5647110681),
and [fresh OWN-model attestation and source permission](https://github.com/drrowdev/stillroom-wardrobe/pull/22#issuecomment-5651727569).
The persistent local writer starts from merged main
`4589b06deb10baf695e432bd6058f4af01085c5d`, tree
`7b0b206171e5b800a6501c75acb0b7e156ca2a2c`. PR #22 remains merged;
this source permission does not authorize publication or a new PR yet.

The R27 localization/accessibility work removes repeated entry, wardrobe,
capture and settings introductions and obsolete future onboarding copy. Active
EN/FI/SV labels and helper/error text are shorter. Genuine owner, recovery,
privacy, consent, provider/location/retention and charge/unknown-outcome guidance
remains; the AI notice uses visible, separately labelled paragraphs. Only
secondary setup/camera instructions are collapsible. Removed select hints have
no dangling accessible-description references. Field editing, explicit Save,
auth/recovery operations, owner isolation, generated personal text, taxonomy,
formatting and provider policy are unchanged.

The existing twelve synthetic captures are retained. Existing recovery fixtures
own sign-in and password-entry EN 1280/FI 320 captures; existing slice fixtures own
empty-wardrobe EN 1280/FI 320 captures. These are the six literal
`test-results/ux-copy-visual/` paths in the additional pinned artifact step,
bounded to one MiB each with regular-file, approved-name/count and PNG/IHDR-width
checks. The two test owners check disjoint exact subsets without a shared-directory
completion race. Functional/language/accessibility checks remain in all selected
projects; only Chromium writes these six buffers. No local images were generated
or viewed. All eighteen actual exact-head artifact reviews remain coordinator
gates, not claims made by this source candidate.

The original 306880 working-file bytes above this append remain frozen, as do
both C integration/support files, domain/helpers/scripts/types/migrations and
existing raw-byte/status/ownership/timing/cleanup oracles. Real recovery changes
are catalog imports/selectors only; operation counts, deadlines and restoration
are unchanged. The existing five visual upload steps are unchanged.

Local runtime, Node/npm/version commands, tests, scanners, builds, browsers,
backend, installation and registry/TLS probes are prohibited and were not run.
Manual text/Git inspection is not a passing runtime check. Independent SOURCE
review and separate commit/publication approval precede new exact-head
lint/types/translations/unit/build/scanner/dependency/browser/axe, real normal-owner
recovery/B1/B2/C/restoration/types, Apple and eighteen-artifact visual gates.
Native/manual acceptance remains open. The historical intermittent raw400 remains
unlocalized, not fixed or reclassified as harness-only/prod-safe. The earlier
accepted integration risk is not a future waiver. Source remains ahead of
production: deployed f318/six hosted migrations; B1/B2 are not hosted. No merge,
deployment, hosted/private/paid/provider or additional writer authority follows.

## 13 September 2026 - UX-copy zoom cleanup compiler correction

First-head CI [34745157539, attempt 1](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34745157539)
at `fd8f839419b0ddd394df48f315b0761839da1be7` failed in App job
`103691615006`: installation and lint passed, but `tsc --noEmit` emitted TS2339
for `Node.remove` in recovery.spec.ts:429 and slice.spec.ts:1151. Subsequent App
steps, browser checks and captures were skipped, not passed. The actual sanitized
compiler log was read. This is a new test-source typing defect, not a raw400
diagnosis. Backend and Apple success reported in the
[repair receipt](https://github.com/drrowdev/stillroom-wardrobe/pull/23#issuecomment-5651952459)
is job/step metadata, not new detailed counts or artifact acceptance.

The same persistent writer narrows each zoom cleanup node to HTMLStyleElement
and requires attachment to document.head before removing it. Unexpected type or
structure throws explicitly. Both 200% assertions, all iterations, captures and
other oracles remain unchanged. Only these two callbacks and this append change;
the preceding 310314 working-file bytes and other 207 tracked paths stay frozen.
No local compiler/runtime/tests/captures or unchanged-job rerun was performed.
This unstaged correction awaits coordinator source/commit/publication gates and
fresh changed-head CI, Apple, types and actual eighteen-image review. Earlier
job success does not validate a new head; all separate holds remain in force.

## 13 September 2026 - garment-form diagnostic source candidate

**Source-only, unstaged; independent source review and runtime gates pending.**
This R23/R27/R28 diagnostic follows the
[reviewed plan and controlling corrections](https://github.com/drrowdev/stillroom-wardrobe/pull/23#issuecomment-5652315814)
and [own local-model attestation, counter amendment and source permission](https://github.com/drrowdev/stillroom-wardrobe/pull/23#issuecomment-5652367276).
The same local writer starts from
`04ef876bc56e6df2a200c7ce4fd8b47ab095eede`, tree
`95ee162d52a89d35cf5526a85ca14b6943ed6b37`. Coordinator-observed own
GPT-6 Astra usage is locally recorded, not tamper-proof/native-platform evidence.
Actual retained Anthropic Claude Opus 5 review was T6 AMEND/T7 correction PASS
and narrow T8 AMEND, with all A1-A6 adopted by the coordinator; these are plan
reviews, not a source or runtime pass for this candidate.

[Actual post-merge blocker](https://github.com/drrowdev/stillroom-wardrobe/pull/23#issuecomment-5652253843)
records automatic main CI34747427454 attempt1, App103697808095:
625 selected, 620 passed, one flaky and four existing skips. WebKit's selected
garment-field case failed at the original line210 because Save garment details
remained disabled for 5000 ms after invalid-input correction/discard-dialog
loops and title whitespace entry. Retry1 passed; Chromium/mobile passed first
try. All six raw-analysis records were clean retry0; this is a distinct,
unlocalized failure. PR #23 remains merged and I08 remains paused.

Only that existing test case gains closed local diagnostic data, assignment-only
stage markers, post-body presentation observation and bounded Node-console JSON.
Native try/finally retains the original exception, including falsy throws.
Observation/emission errors set captureError; a post-finally assertion rejects
incomplete evidence only after normal original-body completion. Serialization
and oversize failures emit explicit failure records; missing emission still
blocks coordinator acceptance. Each actual attempt emits at most one JSON record
of at most 2048 UTF-8 bytes. Unchanged projects/retries/repeats permit at most six
attempt records. No annotation, artifact, listener, polling or new capture.

The sole permitted handler addition is a branchless interception counter capped
at two, after the existing PATCH guard and before unchanged pending/abort actions.
Its separate component, the shared mock's exact PATCH/items-path count, and their
sum serialize as 0/1/more or unavailable null. The shared array is uncapped;
no Playwright request-history buffer is used. These count disjoint handler
invocations, not delivery, abort completion, server writes or all network traffic.
Zero interception before registration is valid; missing mock evidence is not
invented zero. Expected pre-registration 0/0 and final intercepted-write/0 shapes
are context only, not added assertions or replacements for actual observations.

Presentation contains only fixed synthetic value-equality booleans/nulls,
aria-invalid/disabled flags, error/check/reload and offline presentation,
navigator.onLine, closed invalid-field/focus labels and capped visible-dialog
counts. Fixture version is compared with its unchanged version1. No raw values,
text, HTML, URL, token, owner ID or image bytes are emitted. Elapsed milliseconds
are monotonic Node time from original-body start, bounded to a nonnegative safe
integer; they are not browser-input timing. Final focus/dialog state is weak,
non-causal evidence. A successful original body ends after its deliberate failed
write and lock, not at the earlier failing Save-enabled assertion.

Title is a provenance field: this fixture replaces provenance with price/notes
only, so title whitespace editing can confirm unknown title, while explicit
min-temperature clearing contributes independently. Remaining validation errors
can still disable Save. Missing corrected presentation does not prove misrouted
input; correct DOM values with no visible error/lock do not prove lost intent.
DOM is not internal draft state, and navigator.onLine is not React online state.
Observation/counter overhead is nonzero; no production-harmlessness claim follows.
No recurrence means not reproduced, not fixed, and the packet stops.

All original actions, values, assertions, route behavior and cleanup remain,
apart from the explicitly approved counter assignment. Other cases, all eighteen
capture definitions/bounds, upload steps and 208 outside paths stay frozen.
This document's original 311834 working bytes are preserved. Manual text/Git/
hash inspection is not compiler or test execution. No local Node/npm/version,
compiler/lint/test/scanner/build/browser/backend/install/probe or image work ran.
Independent source review and separate commit/publication permission are still
required. One future ordinary new-head full CI plus existing Apple cycle remains
unspent and gated; even early failure consumes it, with no automatic replacement,
unchanged rerun or risk waiver. Exact-head App/browser/translation/unit,
normal-owner recovery/B1/B2/C/restoration/types and actual eighteen-image review
remain pending. Production f318/six hosted migrations, unhosted B1/B2 and all
hosted/private/paid/provider/deployment/manual-device holds remain unchanged.

## 13 September 2026 - diagnostic source-review R1 correction

[Genuine source review and narrow correction permission](https://github.com/drrowdev/stillroom-wardrobe/pull/23#issuecomment-5652431015)
records retained Anthropic Claude Opus 5 Turn9 AMEND for R1, with all other
reviewed items PASS; it is not an unconditional completed-source or runtime PASS.
R1 introduces a local firstSave variable before the existing HTMLButtonElement
check. This uncompiled explicit-narrowing correction is not a proven TypeScript
defect or a fix for the WebKit flake. No diagnostic behavior or test action changes.

Interpretation remains limited: errorPresent also includes per-field alerts;
expectedValue compares against the expected end-state values and may be false
earlier; absent records after termination or timeouts provide no evidence.
All 317230 previously reviewed document bytes and the original 311834-byte prefix
remain frozen. The candidate remains unstaged, with no local runtime checks or
publication; the future gated CI/Apple cycle remains unspent and all holds remain.

## 13 September 2026 - I08 Stage 1 source-only lifecycle candidate

Requirements R03/R23/R28 and related R11/R12/R17/R20/R26/R27. This append follows
the [reviewed T14 corrections](https://github.com/drrowdev/stillroom-wardrobe/pull/24#issuecomment-5653340839)
and [coordinator-observed own-model/source permission](https://github.com/drrowdev/stillroom-wardrobe/pull/24#issuecomment-5653390965),
not the historical diagnostic packet's authority. The existing 318324 working
bytes remain frozen; historical evidence above is not rewritten.

One persistent local writer, canonical session
`a8161d14-3457-4d7f-83a2-e05600445062`, branch `drrowdev-item-lifecycle`, base
`221d60c8a07eb4a89a546133685b80487cf434be`, remains within the thirteen Stage 1
paths. The other 201 original paths, generated types, thirty-field editor,
readiness logic, upload/capture source, diagnostics and workflow remain frozen.
Actual Anthropic Claude Opus 5 T13/T14 AMEND and the coordinator's binding
corrections precede implementation; no unconditional source/runtime PASS is
inferred from plan approval or local model telemetry.

The source candidate adds a private cascading live-item claim, four owner RPCs,
fresh privileged row guards and same-parent image/Storage INSERT fences.
Read-only single-snapshot status includes the original/current versions and
nonce needed for exact reload/resume. Initial pending/orphan states reject
permanent BEGIN before mutation. Claimed image metadata stays intact through
byte removal; FINISH retains parent UPDATE exclusion and requires an empty
whole item prefix before cascade. Unclaimed legacy behavior, saved fields/
provenance and wear-history name/category snapshots are preserved.

The strict ninth canonical source pin is 15332 bytes,
SHA-256 `38de5f1b7bd4edd0f7e3829f90e1b1486c0b32385c1bd75b03b7dee9263ba1c5`.
New ordinary-session/static test definitions and positive catalog checks cover
the claim/grant/lock/replay contract, real Storage removal, retained versions,
history and cross-owner negatives. Source-defined CI-only fixtures hold one
exact disposable parent or add one no-blob catalog marker; ordinary users make
the access assertions. A SQL lock acknowledgement, not a sleep or Promise.all,
is required for forced-overlap evidence. Unknown Storage wrapper responses and
cleanup failures stop the gate. Existing capture retry source is unchanged.

Status: **UNSTAGED, unexecuted source candidate for coordinator review.**
Only manual text/Git/PowerShell/.NET metadata/hash inspection was permitted.
No Node/npm/compiler/lint/unit/browser/backend/build/scanner/install/TLS probe,
Actions query/run, image/archive input, generated artifacts, stage/commit/push,
new PR, hosted operation or deployment was authorized or performed. Static test
definitions are not a passing test run or live SQL/Storage evidence.

Separate publication/execution permission is still required. Stage 1 actual
generation/upload and all preceding gates must succeed before its sole
anticipated final four-RPC type-parity red can be accepted as an intermediate
artifact-producing cycle, never backend/merge PASS. Same-writer Stage 2 still
needs actual generated types, integrated UI, four additional bounded captures,
full exact-head CI/Apple/live/types/coordinator visual and genuine final review.
No run budget has been spent by this source work.

Original Save failure uncertainty and STOP on recurrence remain. Production
f318/six hosted migrations, unhosted B1/B2, paid/private/provider/deployment
holds, physical-device/manual acceptance and mandatory saved-only I29 recovery/
export before release remain unchanged. No I09 compound filters/bulk, I10
replacement/orphan/scheduler, AI lifecycle call or next packet is included.

## 13 September 2026 - I08 T15 source-review R1 correction

[Actual T15 AMEND and narrow correction permission](https://github.com/drrowdev/stillroom-wardrobe/pull/24#issuecomment-5653613862)
records Anthropic Claude Opus 5 review and one cleanup-error-fidelity finding,
not an unconditional source/runtime PASS. Both new I08 fixture helpers now
preserve the exact primary setup/operation rejection, including falsy thrown
values, when release or cleanup also fails. Secondary failures emit only fixed
non-sensitive notices; cleanup-only failures still reject. Parent closure/timer
cleanup and exact marker deletion-count/absence assertions remain required.

Focused mock-only regression definitions cover success, primary-only,
cleanup-only, simultaneous and falsy failures, synchronous/awaited cleanup and
bounded child release. No Docker, SQL or network operation is used by those
mock definitions, and no test was executed here. Only the two helper control
flows, their new unit coverage and this append changed. The full preceding
322125 working bytes and original 318324-byte prefix remain frozen, as do the
other ten candidate blobs, migration/pins and 201 outside paths.

The same writer/session/branch stops UNSTAGED for coordinator verification.
No runtime/compiler/test/probe, publication, Actions or hosted operation was
authorized or performed. All existing exact-head, original Save uncertainty,
Stage 2, production/privacy/paid/deployment and release-acceptance holds remain.

## 13 September 2026 - I08 coordinator source follow-up R2

[Narrow R2 permission](https://github.com/drrowdev/stillroom-wardrobe/pull/24#issuecomment-5653660835)
addresses a setup-before-await readiness rejection and unconditional unit
teardown. An early rejection observer now covers the separate readiness promise;
the actual readiness await, primary rejection and cleanup checks remain intact.
Mock-only setup-failure/async-child-error cases include exact/falsy primary
values and check for unhandled rejection, fixed notice, child closure and timer
cleanup. Timer/network assertions still fail normally, with timer/environment/
global/spy restoration in finally.

The preceding 323640 working bytes and earlier 322125/318324-byte prefixes remain
frozen. Only the same three repair paths changed; all other candidate/source
boundaries and migration pins remain unchanged. T15 remains AMEND, not an
unconditional reviewer or runtime PASS. No tests/runtime commands/publication
ran; the candidate stops UNSTAGED and all prior execution and release holds remain.

## 13 September 2026 - I08 original cycle blocked; R3 source-only correction

[The original cycle's actual evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5653886139)
supersedes the earlier candidate's unexecuted status without rewriting it.
CI34761885375 attempt1 failed at source
`e8829d1aa91187a2c15ff3bf30159a0d486068bc`; actual merge checkout
`37245ab0db1deebd77e061a3f2460ece2f3dd499` had the identical reviewed tree
`75ad01054f059d5b588115649e5a89a039020697`. App's lint reported three
no-unsafe-finally errors in the accepted cleanup correction. Backend passed
the strict nine-source inventory/history/application, populated preservation
(two owners, ten tables, thirty rows, eight objects) and both catalog checks,
then failed in held-upload without an observed response/sub-operation. Exact-run
snapshot cleanup passed. The common reader's pre-body >=500 refusal is a source
boundary, not proof that this response was500 or that the cause is diagnosed.

Later App/backend/type-generation/upload/parity/browser/visual gates did not
run; artifact count was zero. Apple34761885372 attempt1 passed four generated
JPEG and three orientation/composition cases. This is not physical-iPhone,
I08 UI, hosted acceptance or a substitute for failed CI. The original Save
diagnostic case did not run, so no recurrence/non-reproduction is claimed.
The original cycle is consumed and unsuccessful, not the final type-parity
staging condition. No rerun or new cycle is authorized by this source record.

The [R3 proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5653907461)
received actual Anthropic Claude Opus5 T16 AMEND, adopted with
[binding C1-C5 and count corrections](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5653989229).
The same writer's [coordinator-observed entry and edit permission](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5654022792)
authorizes only this five-path source candidate, not runtime or unconditional
review PASS. Start head/tree remain e8829/75ad; all209 outside files, SQL/pins,
shared normalClient, Save/capture/transports, workflow and types are frozen.
The entire preceding324722working-byte document and all earlier prefixes remain.

The candidate separately guards mandatory helper cleanup, reader cancel/release,
observation output and outer fixture cleanup. Explicit primary/cleanup flags
retain the first exact value even if undefined/null/false/zero/empty-string;
rethrows occur after cleanup, outside finally. Fixed notices cannot replace
the retained rejection. A failed child closure/termination is failed evidence,
not an assertion of physical release.

The one existing held-upload negative POST now has a local guarded4096-byte
reader, preserving ordinary credentials, exact endpoint/bytes/headers,
redirect refusal and15-second request timeout. It observes headers/status
before missing, empty, malformed, non-object, UTF-8 or read failures; both
cleanup actions still run where a reader was acquired. **Status<500 remains
necessary for PASS**, with the original !ok, floating <5000ms and exact
classifier. HTTP5xx is recordable failure, not accepted conflict evidence.
No additional request/sign-in or shared API relaxation is introduced.

After the holder settles and before outer cleanup, each attempted phase emits
one validated JSON line of at most1024UTF-8bytes; the two-owner fail-fast loop
allows0/1/2 records according to attempted phases. Closed fields preserve
unobserved nulls; overflow sets bodyBytes:null/truncated:true, never a clamped
or header-derived byte count. Raw errors/bodies/headers/IDs/paths/private values
are excluded. Serialization/output failures remain failures. Last-reached
stage survives failure; released means only a normal holder return. Observation
has bounded nonzero overhead; no performance or causal claim is made.

Added mock-only tests cover exact/falsy cleanup precedence, failed notices,
bounded child failure, reader/shape/size/UTF-8/cleanup errors, original request
identity and headers, strict4xx-versus5xx classification, closed serialization,
record timing/counts and outer cleanup. Existing assertions remain.
Only manual source/Git/PowerShell/.NET inspection occurred: no local lint,
compiler, Node/npm, unit/backend/browser test, probe or install. The candidate
stops UNSTAGED, with actual validation and independent source review pending.

No publication, Actions operation, artifact/image input, hosted/private/paid/
provider operation, merge or deployment occurred. Generated types and Stage2
remain blocked; a new-head CI/Apple cycle needs separate verification and
permission. Original Save uncertainty/stop-on-recurrence, productionf318/six
hosted migrations and human/device/saved-only recovery-export release holds
are unchanged.

## 13 September 2026 - R4 mock typing correction, source only

[The actual R3 cycle result](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5654205492)
records CI34765493857 attempt1 failing at source
`aceb74ee2f68144495854fb89bc6e0ff8dc2b944`. Its actual checkout
`5da9f9834509341f2ef1e1162c3a8e37ba7e3d8b` shared reviewed tree
`73fdd028b8ae521c52a1e5b57a97789a6bab166e`. App lint passed; typecheck
reported five implicit-any errors in the added console-call/record mock code.
These are source defects, not environment failures. Later App checks,
including unit/browser/visual checks and the Save diagnostic, did not run.

Backend again passed nine-source migration application, populated preservation
and catalog checks, then rejected a nonmatching HTTP500 in the first held-upload
phase. The bounded record observed a107-byte JSON object in13ms, with neither
an exact nor contained Request conflict phrase. It does not disclose the raw
code/message or establish a root cause. Reader cleanup flags are not independent
parent-lock release evidence. Later backend/type-generation/upload/parity
gates did not run; artifacts were zero. Apple34765493868 attempt1 passed
four generated JPEG and three orientation/composition cases, not device or
I08 UI acceptance. Both authorized CI cycles are consumed and failed.

[R4 read-only entry](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5654271826)
and [fresh model attestation/source permission](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5654293594)
authorize only a routine unit-typing correction and this append. Concrete
console-call mock signatures use unknown arguments and void results. The
record helper narrows strings, parses into unknown and reuses its existing
object guard to return typed records. Indexed record access also uses that
guard; missing/invalid records reject rather than defaulting or being skipped.
All existing cases, field/count/timing assertions, exact/falsy failure checks
and HTTP5xx rejection remain. No suppression, compiler rule, dependency,
production, SQL, reader/classifier, fixture or workflow change is included.

The entire preceding329636-byte working document and all earlier prefixes
remain intact; all212 other source paths are frozen. Only manual text/Git/.NET
checks were performed. Actual R4 typecheck, lint and tests remain unexecuted,
not inferred passing from source review. The candidate stops unstaged.
No publication, new CI/Apple budget, Stage2, hosted/provider operation or
deployment is authorized. Storage diagnosis remains coordinator-owned;
the observed500 stays failed and no raw response reconstruction or acceptance
relaxation is part of R4. Original Save uncertainty and every production,
privacy, paid, device and saved-only recovery/export release hold remain.

### I08 T20 coherent source repair - unexecuted candidate (13 September 2026)

[T20 actual critique and corrected plan approval](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655317164)
records the retained Anthropic Claude Opus5/high AMEND and binding coordinator
corrections. [Source-only model attestation](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655347691)
matches this same persistent GPT-6 Astra writer, local240b8030/tree9103, branch
drrowdev-item-lifecycle. This append preserves the entire preceding332518-byte
working document and all five earlier checkpoints; dated evidence is not rewritten.

The nineteen-path candidate addresses R03/R23/R28 and related
R11/R12/R17/R20/R26/R27. It replaces admission-only reasoning with an immediate
all-role AFTER/ALWAYS final-publication guard and profile/approval/image/parent
SHARE NOWAIT locks, fresh eligibility and immutable identity/version/dark flags.
Standard-upload and singular-delete server operation restrictions preserve owner
checks. A shared erasable TypeScript singular protocol distinguishes exact
acknowledged removal, exact missing and hard denial; malformed/unknown/5xx fail.
Normal callers and mocks are adapted together, without Save/capture/AI changes.
Only explicit analyzed-Save cancellation blocks finishing accepted Save; no
analysis call, consent import, provider fallback or post-save worker is added.

The user approved retaining only owner/image UUID pairs until actual Auth-row
deletion in [the controlling amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655261015).
Transactional registration preserves replay, rollback and independent cross-owner
reuse while refusing same-owner legacy image reuse. Profile/wardrobe clearing and
disabling an account do not delete this registry. No content/timestamp/path/hash
is added, exposed in client grants, exported or logged. Current-image/checked-Save
backfill does not prove safety for historical deleted IDs absent from those inputs.

Future defined acceptance includes the real two-owner four-byte ordinary POST
paused after native permission and actual partial-file metadata readiness, then
fast-pair Save/Trash/singular deletion/FINISH before slow-body completion. Final
publication denial, labelled actual catalogprefix0 and normal-owner unreadability
are required; privileged INSERT or grant readiness is not a substitute. A valid
pending no-blob marker followed by ordinary legacy deletion preserves pre-BEGIN
orphan refusal and reversible Restore; cleanup uses the real singular API, not a
0055 internal-flag override. Runtime identity/config/mount/digest and byte-phase
proof remain unexecuted. Bounded cleanup/observation faults remain hard failures.

Application source hashes/ACLs and positive catalog properties are pinned.
The bounded native Storage schema inventory is explicitly REVIEW_REQUIRED;
unknown incompatible executable/versioning behavior must not be auto-blessed.
Native Storage55P03/ResourceLocked replaces the source22023/DatabaseError500
mistake at the Storage boundary only. Both earlier CI cycles remain consumed
and failed. The observed500 raw body is unknown; no byte-count reconstruction
or softened classifier is evidence. Original Save uncertainty still requires
STOP on recurrence.

The user's [remnant decision](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5654674701)
accepts inaccessible interrupted-upload remnants at Supabase without a verified
cleanup deadline. It does not accept later publication/readability, accessible
TUS control metadata, failed accessible deletion, physical-purge claims, queued
cleanup as proof, or an indefinite visible deletion hold. Historical TUS JSON/
companion authorization exposure needs exact cutover evidence; it is not a
verified cross-owner/anonymous exploit. Old inflight requests, absent historical
identities, exact deployed backend companions and vendor-trigger privileges/
upgrades remain open hosted gates. The vendor-table trigger exception is source
only, not hosted DDL approval.

Only manual text/Git/.NET source checks are permitted here. No Node/npm/compiler,
lint, tests, backend/browser probe, install, Actions/log/artifact/image access,
staging/commit/push or hosted/provider/deployment operation was run for this
candidate. Defined tests are not passing runtime evidence. Actual generated
public types, all preceding backend gates, exact-head CI/Apple, independent final
review and Stage2/visual/device acceptance remain pending. Four public lifecycle
signatures are unchanged; types are not hand-authored. The complete candidate
must remain unstaged for coordinator source review and later separate authority.

### I08 T21 confirmed source corrections (13 September 2026)

[T21 disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655669664)
authorizes routine corrections under the same T20 receipt and nineteen-path plan.
[Pinned native wire evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655552023)
establishes final HTTP error fields `not_found` for NoSuchKey and `Unauthorized`
for AccessDenied. The shared classifier, intended native mocks, caller assertions
and API documentation now use those exact fields. Counterfeit code-as-error
envelopes remain rejected, not compatibility aliases. Exact200 success, distinct
missing, hard denial and malformed/unknown/5xx failures are unchanged; the existing
adapter's extra range field remains accepted. Only the new rejected-settlement
mock uses an unrelated73-byte count; actual107-byte history is untouched.

The migration and two lifecycle session mjs files are formatted to the existing
LF contract with canonical-before/after equality, without attribute or test
normalization changes. The entire337325-byte prior candidate and all six older
phase prefixes remain intact. The rehearsal's semantic content is temporarily
frozen pending coordinator reconciliation of T21 A1; no unconditional response
resolution or termination-observation relaxation is introduced. N4's speculative
catalog relaxation is not adopted. These are source corrections only: no runtime,
test, compiler, backend, Actions, publication or hosted operation was executed.
The candidate remains unstaged; actual validation and Stage2 remain held.

[T21 final disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655702583)
withdraws A1: existing request-error and close observations settle the respective
promises; cleanup, events, timers and N4 assertions remain unchanged. The released
C1 correction changes only the child's final-denial error field to `Unauthorized`,
retaining HTTP400, statusCode403, codeAccessDenied, messageNot available and all
other checks. Its exact inverse restores the reviewed rehearsal bytes/hash/blob.
N2 is qualified: the real INSERT permission probe also runs the AFTER guard;
previously admitted uploads require the distinct final-publication check.
The full338968-byte prior phase candidate and seven older prefixes are preserved.
This is source-only evidence, not runtime identity or termination proof. No tests
or execution were run; the complete candidate remains unstaged and Stage2 held.

### I08 T23 bounded startup diagnostic - source only (13 September 2026)

[Third-cycle terminal evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655881258)
records CI34779824003 attempt1 failed and Apple34779824006 attempt1 passed at
source f60733cad8a0983b7decf50ef9b4624c7c4bb4f4, actual checkout0e2c59f11bfa35c56f1d2e207218ff46ecbef6c6/tree d5116b23102413f728dcb54958a414f3eabca2fa.
App passed1884 units and621 browser cases with4 existing skips; Apple passed7
cases. The original Save failure did not recur, which does not establish a fix.
The [coordinator's synthetic artifact verdict](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655929995)
records17 byte-identical prior views reused and one changed image actually
reviewed, with no blocking visible regression on those existing surfaces.
This writer read only the text receipt, not images, archives or raw job logs.

Database startup failed with SQLSTATE42501, stderr11805bytes and seven known
announcements/last-known-index7. The prior classifier knew only seven of nine
filenames; no failing migration, statement, target or privilege cause follows.
Rehearsal, lifecycle/Storage, normal-owner/backend/recovery/catalog/type gates did
not run. This third cycle is consumed, not the anticipated final type-parity red.

[Actual T23 critique](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655993126)
and [framing closure/model attestation/edit permission](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5656047462)
record retained Anthropic Claude Opus5/high26+8 actual events, binding coordinator
corrections and five OWN GPT-6 Astra/medium entry events for this persistent
writer. Four paths only: the startup classifier, matching unit declaration/tests,
local-backend documentation and this append. All211 other files remain frozen.
The entire339890-byte preceding working document and eight older prefixes remain
unchanged. No migration, rehearsal, wrapper, workflow, application or pin changed.

The source adds the exact eighth/ninth announcements and two bounded fields:
zero-based `stderrStatementIndex`0–9999/null and an eight-value generic permission
marker. Whole LF/CRLF framing, first severity delimiter, exact42501 suffix and
message-start-only fixed English prefixes prevent loose substring attribution.
Malformed/conflicting statement candidates invalidate the ordinal; distinct
permission categories become multiple. Unsupported/localized message text is
unclassified, while localized severity is permitted. Unsupported superuser
inference is omitted. A complete SQL echo can imitate both shapes: neither field
authenticates a cause, target, failed migration or actual statement execution.
The ordinal can also refer to injected role/history or reset statements.

Existing eleven-field semantics, own-data/accessor/proxy defenses, failure-only/
stderr-only activation,16MiB aggregate UTF-8 cap, closed less-than512-byte output
and wrapper masking/exits/timeouts are preserved. New source-defined cases cover
thirteen keys, nine announcements, framing/bounds/ambiguity, synthetic11805-byte
and maximum-bound input, worst-case output, forged shapes and secret canaries.
These definitions were not executed; manual source/Git/hash checks are not a
test, compiler or runtime pass. The candidate remains unstaged. Startup cause,
runtime/catalog/lifecycle/generated types, Stage2, hosted cutover, independent
final review and human acceptance remain pending; no new run, publication,
privilege change, paid/provider action or deployment is authorized.

### I08 T23 fixture spelling correction - source only (13 September 2026)

[Fourth-cycle terminal evidence and correction permission](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5656189592)
records CI34782897424 attempt1 failed and Apple34782897385 attempt1 passed at
source a94575ebb40789f4d77caa741a2096a0f62a5166. All three jobs used actual
checkout461305a20b65f14fa8bb936a9ad6d28d23038637/tree c600b3b0fd9260fe61d6376607980ce2808574c4,
with parents221d60+a945. The fourth cycle is consumed.

App lint failed with two `no-useless-escape` errors at
`tests/unit/local-backend.test.ts`1137:64/98. Later typecheck, translations, unit,
build, browser and artifact steps were skipped, not passing. This correction
removes exactly two unnecessary backslashes before double quotes in the
single-quoted negative fixture. Its JavaScript string value and unclassified
expectation remain unchanged; no suppression or assertion weakening was added.

Database startup failed again with wrapper exit2. The actual closed diagnostic
reported exitCode1, elapsedMs52896, stdoutBytes0, stderrBytes11705, Docker marker
none, container-exit bucket unclassified, SQLSTATE42501, nine announcements,
last-known-index9, port markerfalse, statement index24 and owner-required.
These are untrusted shape observations, not authenticated cause/target evidence.
The coordinator's proposed statement mapping still needs pinned parser
confirmation; no raw CLI text or privilege cause is reconstructed here.
All subsequent rehearsal/reset/integration/security/recovery/runtime/catalog/type
gates were skipped. The actual artifact inventory was zero.

Apple passed four generated-JPEG cases in17.6s and three orientation/composition
cases in13.4s, not physical-device, Save or lifecycle acceptance. Prior App/browser
passes remain historical. This writer read only the sanitized text receipt.

Only this append and the two-character fixture correction changed. The full
343557-byte preceding phase document and nine older prefixes remain intact;
all213 other files, including the classifier, SQL and rehearsal, remain frozen.
Only manual source/Git/hash checks were performed; this correction has not been
executed. The separate installation-context proposal is not edit authority.
The candidate remains unstaged; no commit, push, new CI budget, Stage2, hosted
mutation, provider activity or deployment is authorized.

## I08 T26 CI-only owner installation source amendment - 14 September 2026

[User direction](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5659040589),
[concrete proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5659102726)
and [binding reviewed design](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5659205055)
replace the rejected T25 ordinary-role-switch direction. The retained
Anthropic Claude Opus5/high critique had25actual events; the coordinator adopted
its amendments, including the in-module image check and catalog joins that do
not require private-schema USAGE. This is not runtime approval or a new review.
[Edit-only release](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5659261035)
records this same writer's9OWN GPT-6 Astra/medium events and independent
05:02:30.8140799Z source/identity guard at
a94575ebb40789f4d77caa741a2096a0f62a5166/tree
c600b3b0fd9260fe61d6376607980ce2808574c4, soleparentf60733c.

The thirteen-path candidate moves only the owner-required Storage ALWAYS
statement from migration nine to a fixed CI-only installer. All eleven function
bodies, other SQL, native pins and nineteen evaluated catalog checks remain
unchanged. The publication body's existing MD5 is now one immutable exported
constant, interpolated into the unchanged catalog. Ninth source bytes are20525,
SHA25651529f087b63f99f0645e57f943b2ec041f3a4ccf0440e8c8307ae6721de0143;
both inventory references change coherently. The integration reader changes
only its lifecycle hash literal. The accepted two-character quote correction
in local-backend.test.ts is frozen and retained.

Pure preflight refuses unapproved start/reset/preservation before CLI mutation.
Only the database job receives the new opt-in; neither stripped environment
helper nor normal child changes. The installer independently checks local
target/container and the pinned17.6.1.165 image under CLI-default ECR/GHCR/Hub
names. Source-only verification used CLI997a1e69's manifest and registry resolver;
no image was pulled and no backend/transport was probed. Fixed owner TCP,
catalog identity/body/config/ACL checks, a bounded relation-locked transaction
and unchanged-metadata comparison allow only O-to-A or already-A verification.
COMMIT precedes the exact success marker; missing/extra/error/timeout output
fails without retry. These are source contracts, not observed installation.

Start/reset verify strict A before readiness/provisioning; S1 remains base-only,
S3 finalizes before target traffic, and types only verifies through the frozen
postgres helper. The selected owner constrains reviewed code, not Docker's
superuser-equivalent authentication capability. Intermediate ordinary-only
trigger state is incomplete isolated setup, not ready or a production waiver.
New unit/mock/source definitions cover scope/import purity, transport bounds,
metadata/SQL/refusal/receipt contracts, environment stripping and ordering;
they have not been executed. Existing ordinary-session and cleanup semantics
are not relaxed.

Only permitted manual source/Git/.NET byte/hash/diff checks were performed.
The full346005-byte preceding document and ten older prefixes are preserved.
The candidate is unstaged; no runtime PASS, fifth cycle, staging/commit/push,
Node/npm/compiler/test/Docker/psql/probe/install/Actions/artifact/hosted work,
new agent, generated types, Stage2 or deployment is authorized. Actual
owner/image/HBA/vendor-trigger compatibility, preservation, normal-owner
negative/access tests, native late-upload, catalog, generated types and all
previous acceptance/Save/cutover holds remain pending. Four prior cycles stay
consumed; hosted ninth installation still needs separately reviewed
owner/quiescence authority.

## I08 T28 ordinary-session headers and bounded diagnostics - 14 September 2026

[Fifth-cycle terminal evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5659993608)
records CI34812510149attempt1 failing at published
e32464115cbaf8ea8fa127d9965fdc0b3244fb76/tree
90b5887c7b9113c3fdc3af6ce83beffcbf55682f. All three jobs actually checked out
909510ebb3a289d4fad2881c87046f1a4c078c0b, with that tree and parents
main221d60c8a07eb4a89a546133685b80487cf434be and heade324641; Node24.19.0.
Database startup/CI owner installation reached readiness. S3 applied all nine
migrations; preservation2owners/10tables/30rows/8objects, checked Save catalog,
profile cascade and nineteen I08 catalog predicates passed. Held-parent Storage
rejectionHTTP400 passed. The broad S4begin-overlap phase and exact lifecycle
fixture cleanup then failed; snapshot cleanup passed. Later reset, integration,
security, AI, recovery, types and parity were skipped; no generated types exist
from this cycle.

App lint/typecheck/translations502keys/52files,2026unit tests/25files, build,
secret and dependency checks passed. Browser exited0 with620passed,1flaky and
4oldskips, not an all-clean run. WebKit's existing one/512000-byte boundary test
received400instead200 on its first attempt and passed its configured retry.
This remains a separate unresolved browser-wire blocker, not the original
Save-button recurrence or a PR16 waiver. Apple34812510135attempt1 passed all
7synthetic cases. Five cycles are consumed; no sixth cycle is authorized.

[Exact e324 catalog/evidence review](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660119420)
accepted the observed catalog projection, not a complete runtime certificate.
[Completed existing-image review](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660235899)
found no blocking visible regression in the18approved synthetic surfaces:
16byte-identical prior actual views plus two changed images actually reviewed,
not18fresh views. The final sign-in view is no longer pending. Existing tall
preview/fine-copy caveats remain. These are historical e324 results, not visual
or runtime acceptance of this T28 candidate. This writer accessed no images,
archives, artifacts or raw logs.

[Proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660005552)
and [binding nine-path disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660219242)
record retained Anthropic Claude Opus5/high review:14actual events, AMEND adopted
with M1-M4/N1-N4 corrections. The two additional standalone normal-session
helpers share the preservation client's automatic bodyless JSON-header defect.
Pinned Storage/Fastify source establishes parser selection and empty-JSON
refusal, not the actual unlogged cause of S4's broad failure.
[Edit-only release](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660296037)
records this same writer's11OWN gpt-6-astra events and independent source/identity
guard;10events record medium effort and one omits effort. The writer refreshed
all217HEAD/index/working canonical blobs, nine raw targets,208outside raw files
and36regular ancestors at07:10:36.9191537Z before re-reading the full release
and patching. This is local coordinator-observed evidence, not a native receipt.

The source candidate changes only the three automatic request headers,
preserving undefined versus null, binary option names, explicit overrides and
all response/cleanup semantics. New unexecuted preservation tests inspect actual
outgoing RequestInit and retain strict parser-error refusal; narrow source
assertions cover the two standalone runners without importing or executing them.
Fixed lifecycle labels separate held/released BEGIN, unchanged-state check,
holder release, singular removal, held/released FINISH and final rows; operations
and primary/cleanup handling do not change. Injected fixture test definitions
retain exact/falsy errors and stop/cleanup assertions. The existing boundary
test opts into its existing bounded observer with two fixed result positions
and a pre-cleanup snapshot; payloads, assertions, traffic, receiver, timers,
retries and captures remain unchanged.

Only authorized manual source/Git/hash/whitespace checks were performed; no
Node/npm/compiler/lint/test/browser/backend/Docker/psql/probe/install ran.
The full349860-byte preceding document and all eleven older prefixes remain.
All208outside files, nine migrations/hashes/elevenSQLbodies/nineteencatalog,
installer/native fixtures/types/workflows/product/Save/provider source stay
frozen. No runtime PASS is claimed. Real bodyless PostgREST, native lifecycle
and cleanup, browser flakiness, later backend/generated types and other
normal-owner/manual/device/hosted/cutover gates remain unresolved. Original
Save STOP-on-recurrence remains. Candidate is unstaged: no object write,
commit/push, Actions, new cycle/agent, Stage2, paid/private processing,
hosted mutation, merge or deployment is authorized.

## I08 T29 singular orphan deletion visibility - 14 September 2026

[Sixth-cycle terminal evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660754752)
records CI34818638302attempt1 failing at source
1a6bb0d0ddf2fc8d3d733d3b4c4bac3859755f6d/tree
90e9c4b656e4db8fdfbe1986b12205c35dd24eb9. All three CI jobs checked out
4c27224848bda470045bff8a35e2dd3f8b47a2e5, that same tree with parents
main221d60c8a07eb4a89a546133685b80487cf434be and head1a6; Node24.19.0.
Startup/owner installation, preservation/checked Save and nineteen lifecycle
catalog checks passed. Both contention fixtures returned. Subsequent catalog
marker and lifecycle cleanup failed; the first failing HTTP operation and
response remain unknown. Later reset/integration/security/AI/recovery/generated
types/upload/parity were skipped. This is not the approved final type-diff red.

App lint/typecheck/translations/build/secret/dependency checks and2048units in
25files passed. Browser621passed with4oldskips and no retry/flaky summary;
three existing boundary records showed200/200 for1/512000bytes, without recorded
rejection, timeout, observer or cleanup failure. A clean run does not establish
that the separate earlier WebKit400 was fixed. Apple34818638294attempt1 passed
all7synthetic cases, not physical-device acceptance.
[Exact1a6 catalog/visual review](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660948869)
accepted the bounded catalog projection and18existing synthetic surfaces:
17byte-identical reuses of prior actual views and1actual current view, not
18fresh views. These are historical1a6 results, not T29 runtime/visual acceptance.
This writer read only sanitized public text receipts, no logs/artifacts/images.

[Proposal5660878443](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5660878443)
and [binding disposition5661198540](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5661198540)
record retained reviewer c372 turn30,13actual Anthropic Claude Opus5/high events
08:13:19.293-08:21:10.888UTC, AMEND adopted with M1-M5/N1-N5 corrections.
The critic's statement24 chronology was corrected to cycle4/a945/34782897424,
not cycle5; no additional owner installation step is introduced.
[Matching edit-only release5661295740](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5661295740)
independently records8OWN gpt-6-astra/medium events for this same persistent
writer,08:33:10.651-08:36:24.538UTC. Supported identity and coordinator source
guard08:37:35.8880982Z matched. Writer rechecked all217canonical/index entries,
ten raw targets,207outside raw bytes and36root-inclusive regular directories at
08:43:17.1869168Z before rereading the complete hash-verified receipt and patching.
This is local coordinator-observed usage, not tamper-proof/native attestation.

The source-supported SELECT/RETURNING mismatch explains an intended deletion
path that was blocked; it is not recovered proof of the first runtime failure.
Only `wardrobe_read` is replaced: existing manifested reads OR existing
approved-owner canonical-prefix deletion during trusted `storage.object.delete`.
DELETE/INSERT and all eleven function bodies remain unchanged. Download/sign/
list/bulk are not granted orphan visibility; direct/privileged SQL GUC capability
is not claimed impossible. The native operation-function contract now also
fences SELECT and requires review on future vendor upgrades, without a version
or installer change here.

The nineteen-key catalog retains independent shape/exact-qual operands and now
requires the complete three-policy set. Its new deparsed read qual is derived,
not measured; a false combined boolean cannot by itself localize the mismatch.
Source units replace old blanket SELECT prohibitions with exact narrow policies.
Marker helper/caller fixed phases preserve operation/SQL order, exact/falsy
primary and first cleanup values, and the original cleanup notice. Shared
real-byte orphan regressions cover normal/spoofed A/B/anonymous read/sign/list,
own bulk refusal, foreign/anonymous singular refusal and exact owner removal
followed by status/NoSuchKey absence. They do not manufacture readable orphan
bytes or claim physical purge. New test definitions remain unexecuted locally.

Current ninth canonical LF is20822bytes/SHA256
8cc0fc1207737d63b7e1d000fc7471a9941a4833aaebebc75979c498a4d6c476.
Its two current source fingerprint references and the backend document match;
the original15332-byte backend pin is explicitly historical. The full354986-byte
preceding phase record and all12older prefixes remain immutable. Other207files,
ALWAYS/publication/claim/history bodies, native pins/inventory, owner installer,
stream/protocol, Save/browser/timers/retries/captures/types/dependencies stay frozen.

Only manual source/Git/hash/whitespace checks are permitted. No local Node/npm/
compiler/lint/tests/browser/backend/Docker/psql/probes/install or runtime PASS.
Candidate remains UNSTAGED for source review: no object writes/commit/push,
Actions/seventh cycle, extra agent/native allocation, Stage2, hosted mutation,
merge/deploy or paid/private-photo processing is authorized. Six cycles consumed;
original Save STOP-on-recurrence, separate browser400 uncertainty, real-owner
lifecycle/cleanup/later backend/types and human/device/hosted/cutover gates persist.

## I08 T30 bounded security diagnosis - 14 September 2026

[Cycle7 terminal5661793018](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5661793018)
records CI34826747424attempt1 failing at09:17:24UTC for source
c7ddb349af5ac22f95ebf0eb7c22fa152020caa9/tree
fdd8f053f93e9cef2583c4f62cb8fa4a7600f312. All three actual job checkouts were
7dbf8c4bc2331a1b457527961da3393da8e3f611, the same tree with ordered parents
main221d60c8a07eb4a89a546133685b80487cf434be and headc7; Node24.19.0.
DB start/rehearsal/reset and full integration for two ordinary owners passed.
All nineteen evaluated lifecycle catalog checks, contention, publication and
marker cleanup passed. The new SELECT qual has positive evaluated exact-equality
evidence, not a separately dumped measured string. The4935-byte native projection
SHA25613a320de0ac4d372108560857eaf24bbe0e4a1a855003f2b46883779666bd484
was accepted by coordinator-verified identical-content reuse, not hosted or
unprojected/image/HBA evidence. Native image/provenance/HBA review remains pending.

Security failed at the coarse `native-operation-boundary` phase. Its actual
failing owner ordinal, operation and response remain unknown. The preceding
shared orphan helper in that iteration returned; this does not prove both
security owners completed. No exact-cleanup failure notice was emitted, which
does not itself prove physical erasure. App failed only lint at unit262,
`no-regex-spaces`. Later App/typecheck/units/browser/visual uploads and later
AI-analysis rehearsal/real types/upload/parity were skipped; artifact inventory
was zero. This is not the approved final four-RPC type-only difference. Old1a6
visual acceptance remains historical, not current-head acceptance.
Apple34826747429attempt1 passed4generated-JPEG plus3orientation/composition tests,
not physical-iPhone/HEIC/Save/RLS or human acceptance. This writer read only public
sanitized text receipts, not Actions logs/artifacts/images.

[Proposal5661891889](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5661891889)
and [binding disposition/edit release5662072605](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5662072605)
record retained critic c372 turns31/32 AMEND:6actual Anthropic claude-opus-5/high
events09:32:57.663-09:38:14.068UTC, with M1-M9 adopted and coordinator corrections.
Fresh OWN attestation records6gpt-6-astra events09:32:40.248-09:34:50.726UTC:
5medium and1reasoning unspecified/NULL, not6medium. Coordinator supported identity
and independent source seal09:42:17.8405036UTC matched this persistent writer.
Writer rechecked all217HEAD/index/working entries,3raw baselines,214outside
raw manifest,14phase prefixes and36root-inclusive directories at09:48:26.3984329UTC;
independent Git/REST refs matched at09:48:13.6843869UTC. The full hash-verified
receipt was reread immediately before the first patch. This is locally recorded
coordinator-observed usage, not tamper-proof/native-platform attestation.

T30 changes only security observation definitions/call-site labels, focused
unit definitions plus the equivalent two-space regexp quantifier, and this
append. The failure-only record has six exact fields: schemaVersion, ownerOrdinal,
case, stage, status, ok; ten fixed cases, three direct and fifteen opaque stages.
Fresh per-owner state and same-statement null resets prevent stale attribution.
Only existing returned bulk/alternate/pending-absence results supply validated
status/ok; catalog, singular deletion and other helpers stay opaque. Null at a
direct stage means no returned result was captured, not proof a request reached
the wire or of any particular failure. The unchanged normal client rejects
HTTP500+ and other failures before returning; no adapter/catch recovers them.
The serializer's100..599 bound is not evidence that current HTTP500+ is observed.

Original request tuples/options/order/refusals and byte/row assertions remain.
Exact outer-phase gating prevents stale evidence from later/cleanup-only failure.
The original coarse failure/nonzero assignment precedes guarded diagnostic output;
capture and fixed-notice sink failures cannot replace it or prevent cleanup.
Closed own-key/data-descriptor/type/null-pair checks reject private/accessor extras;
JSON is bounded to512UTF8bytes with no CR/LF and exact round-trip validation.
Focused units are unexecuted definitions and mock-only value-flow examples, not
native/main execution or privacy proof. No speculative SQL or policy repair.

Full360440preceding raw phase bytes and all13older prefixes stay immutable.
All214other files, including SQL/eleven bodies/ALWAYS/native pins/installer/
transport/product/Save/browser/workflow/dependencies/types and blueprint/backend
docs, remain frozen. Manual source/Git/hash/whitespace review only; no local
compiler/lint/unit/runtime PASS. Candidate is UNSTAGED for source review.
No staging/object write/commit/push, eighth cycle/Actions, local runtime/probe/
install, extra agent/native allocation, Stage2, hosted mutation, merge/deploy or
paid/private-input work is authorized. Seven cycles consumed; original Save STOP,
separate browser400 uncertainty, current App/security/later backend/types/visuals,
native image/HBA and human/device/recovery/export/cutover gates persist.

## I08 T31 bounded TUS fixture response compatibility - 14 September 2026

[Cycle8 terminal5662633020](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5662633020)
records CI34832111814attempt1 failing for source
7fa6934d3c4803496108e7d2ea50ee3d5344925b/tree
a33cf57e2922db8dd8a80e3cdb6bd1a4cd6a41cc. All three actual checkouts were
c123d825b1c3cfb569dd844feab1e23fa5eede7f with ordered main221/head7fa parents.
App passed2102units and621browser checks with4existing skips. DB startup,
rehearsal/reset and ordinary integration for both owners passed; all nineteen
catalog gates and contention/publication/marker checks passed. Apple passed
4generated-JPEG plus3orientation/composition checks. These are7fa results,
not execution of the new T31 definitions.

Security's111-byte failure record identifies ownerOrdinal1,case alternate-tus,
stage alternate-request,status null,ok null. No returned result was captured;
neither actual status/body nor cause or even a sent request is established.
The earlier first-owner checks returned, not both security owners' completion.
Later AI rehearsal/real types/upload/parity were skipped, not the approved final
four-RPC type-only difference. Source-confirmed native TUS raw-message responses
conflict with the client's unconditional non-download JSON assumption, but do
not prove that parsing caused this particular failure. Source pins are not
runtime-image provenance. No server/policy defect or literal native403 is inferred.

[Coordinator visual record5662808761](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5662808761)
accepts7fa's eighteen approved static surfaces using17verified identical-content
reuses and1actual current coordinator view, not eighteen fresh views. Its retained
fine-copy/long-form/contrast and human/device limitations still apply. The writer
read only that public text, never images/archives; this does not accept a future
candidate/head's visual evidence.

[Proposal5662665403](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5662665403),
[reconciliation5662808758](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5662808758)
and [approved disposition/edit release5662899205](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5662899205)
record actual retained critic c372, Anthropic claude-opus-5/high: turn33 AMEND
(3events10:45:07.554-10:47:35.930UTC), turn34 ACCEPT of the bounded correction
(2events10:54:33.749-10:55:51.700UTC). Coordinator adopted M1-M7/N1-N3/N5-N7;
N4's historical array-type inference is not asserted. The original214manifest
mismatch was the coordinator's ordering error, not changed source. Explicit
string[] ordinal paths with invariant decimal/NUL/UTF8 serialization produce
c331eb731af9ea2821fab88b1cf5f41f57f6cf52d60cabe3164a033c0b6eb55f.
The first stopped entry did not reach the phase-prefix checks. Corrected entry
verified all fifteen prefixes; no retroactive first-entry pass is claimed.

Fresh coordinator-observed OWN usage records4gpt-6-astra/medium events
10:54:02.056,10:54:52.465,10:55:40.215,10:55:45.843UTC for canonicala816.
Supported canonical app/CLI identity, source/time and branch matching are in
the release, without borrowing extra active-session fields from writer output.
This is local telemetry, not tamper-proof/native-platform attestation. Writer
prepatch seal11:02:51.9765742UTC matched217HEAD/index/working canonical files,
three W/C/B baselines,214outside raw/canonical files,all fifteen prefixes and
217regular files/36root-inclusive directories. Independent Git+REST guards at
11:02:39.8434216UTC matched7fa/main221/draft25; the full hash-verified matching
receipt was reread immediately before the first patch.

The only transport change is a post-reader raw Buffer exception for exact
POST + /storage/v1/upload/resumable + binary === true. The boolean pins one
existing fixture, not a general binary-response rule. Original request options,
headers/body identity, local/auth gates,15000ms timeout,pre-body500+ rejection,
204/null/non-null contracts,512KiB ceiling,reader/cancel order and final return
remain. Empty non204streams and JSON-looking TUS responses stay byte Buffers;
201 stays ok:true, so the unchanged security caller still refuses success.
Focused stub definitions use fictional422/201 responses, never recovered native
statuses. Exact-match exclusions retain strict JSON. Matching TUS boundary,
network/read/cancel tests retain existing finally precedence: if both read and
cancel reject, the cancel error wins. Other pre-return failures can still yield
the same null/null; source compatibility correction is not guaranteed unblocking.

Only preservation.sessions,its existing HTTP unit describe and this append
change. Full365803preceding phase bytes plus fourteen older prefixes remain
immutable; all214other files, including the complete security runner/T30observer,
lifecycle-schema tests,SQL/native/Save/browser/types/workflow/dependencies, stay
frozen. New tests are UNEXECUTED; only manual source/Git/hash/whitespace review is
authorized. This UNSTAGED candidate awaits source review, not runtime/privacy
acceptance. No staging/object write/commit/push/local runtime/probe/install,
Actions/artifacts/images/hosted/private work,new agent/native allocation,Stage2,
merge or deployment. Eight cycles consumed; no ninth authorized. Original Save
STOP,separate browser400 uncertainty,full security/later backend/real types,
native-image/HBA and human/device/recovery/export/cutover holds persist.

## I08 T32 bounded runtime-reader localization - 14 September 2026

[Cycle9 terminal5663394197](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5663394197)
supersedes the partial running status in
[support5663325972](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5663325972).
CI34838272733attempt1 failed11:36:51UTC for source
2c5e143a8c57abb65c101aee18db687852be3ea3/tree
4fe6246b1f20439022a2f37735e6f4a9d1ee372f. All three actual job checkouts were
a30cb5572115d1a416f288a201cc3464b2cdb90c, ordered main221/head2c5 parents.
App passed2131units/25files and621browser checks with4skips, not passes.
DB startup/rehearsal/reset, full ordinary I08 integration for two owners and
security for two owners plus anonymous passed. Apple passed4generated-JPEG and
3orientation/composition checks. TUS no longer blocked this run; no actual TUS
status/body or cycle8 literal cause was recovered.

B1 baseline integration/security children then passed before served-entrypoint
startup failed. Its readiness record was replacement=false,running=true,
fresh=false,stable=false,elapsedMs=628,reason=reader-failed,lastHttp=null,
transportFailure=false. Running=true came through waitForAnalysisHandler after
at least one successful post-spawn metadata observation, not the baseline-reader
failure record that hardcodes false. The last successful fields need not describe
the failing read. No poll count, Docker code, timestamp, race or cause is inferred.
Authoritative served/catalog work and actual type generation/upload/parity remain
unproven/skipped as applicable; this is not the final four-RPC type-only exception.

The coordinator accepted the exact4935-byte native structural projection by
verified identical content, not actual runtime-image/HBA provenance. Current
eighteen static surfaces were accepted by eighteen verified content reuses
(seventeen via7fa and one via1a6), not fresh views. This writer read only public
receipt text, not logs/archives/images. Those2c5 results do not accept this
candidate or a future head; visual/human/device limitations remain.

[Proposal5663438867](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5663438867),
[disposition5663537543](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5663537543)
and [edit release5663598514](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5663598514)
record actual retained critic c372, Anthropic claude-opus-5/high: turn35 AMEND
(five events11:51:23.048-11:55:37.965UTC) and turn36 ACCEPT with C1/C2
(two events12:00:08.625/12:01:55.319UTC). Coordinator adopted M1-M9/N1-N6,
deferred classification until the primary failure and retained both deadline
observations. The critic withdrew exclusion of the reader from a missing line
and inferred iteration counts. Conditional source interpretation is not diagnosis.

Fresh coordinator-observed OWN evidence records five gpt-6-astra/medium events
11:51:13.993/11:51:30.522/11:52:22.092/11:53:09.026/11:53:14.197UTC,
canonicala816 with matched app/CLI/workspace/branch/source/time. No extra fields
were borrowed from writer output. Local telemetry is not tamper-proof/native
platform attestation. Writer prepatch source seal12:08:40.0782915UTC matched
217HEAD/index/working canonical entries,three W/C/B baselines,214outside files,
all sixteen phase prefixes and217regular files/36root-inclusive directories.
Independent Git+REST guards12:08:23.5013449UTC matched2c5/main221/draft25;
the full hash-verified matching release was reread immediately before patching.

T32 changes only readAnalysisRuntime's invocation-local failure observation,
focused additions in the existing bounded-Docker unit describe and this append.
The B1-RUNTIME-READ record has exactly schemaVersion,step,commandCode,listedState;
seven fixed steps and at most512UTF8bytes including prefix/LF. No success/absence
record, global state or retry. Current result/code reset before each command;
only a result reference is saved after the original post-command deadline check.
Own-data code classification occurs only after the original failure is caught.
Accessors are not reinvoked; diagnostic proxy/serialization/output failures cannot
replace the same thrown value. No raw/private output, IDs, timestamps or hashes
enter the diagnostic record.

Step means section entered, not a precise failed statement. Pre- and post-command
deadline errors may both report a call step/null code; null does not prove the
command was unissued. Code2 may be natural or synthesized for spawn/timeout/
overflow/signal-null, not a cause. Listed state is only the validated ps sample.
After valid ps/inspect shapes with ordinary built-ins, runtime-validation points
to strict StartedAt lexical/fraction/positive-epoch/calendar checks, not an
observed cycle9 timestamp defect. Validators and all surrounding functions stay
unchanged, including command arguments,4096bytes,5s-or-remaining/shared60s bounds,
replacement/freshness/healthy-child/two-probe/identical-metadata and stop precedence.

Reader-failed remains overloaded outside the reader: baseline/second runtime
validation,spawn inputs,time comparisons,freshness refusal and unexpected errors
are a non-exhaustive source map. A delivered reader line may precede an outer
child-health or stop error. Missing output does not exclude the reader because
diagnostic delivery can fail. No fallback, extra request or expanded log follows.
New mock definitions pin same-error identity, deadlines, closed protocol/maximum,
private/proxy/output noninterference and the real reader with a fake owned child
exiting during the read. A separate FICTIONAL old-running then inspect-failure
sequence demonstrates stale readiness fields, not the recovered628ms cause.

Full371432previous phase bytes plus fifteen older prefixes remain immutable.
All214other files, including declarations,T31transport/unit,T30observer,
SQL/types,AI rehearsal,product/browser/workflow/dependencies, remain frozen.
New definitions are UNEXECUTED locally. Manual source/textual-equivalence/Git/
hash/whitespace inspection only; this UNSTAGED candidate awaits source review,
not runtime/privacy acceptance or guaranteed unblocking. No staging/object write/
commit/push,local runtime/probe/install,Actions/log/artifact/image/hosted/private
work,new agent/native allocation,Stage2,merge or deployment. Nine cycles consumed;
no tenth/rerun. Original SaveSTOP,browser400 uncertainty,native-image/HBA,later
backend/real types,human/device/recovery/export/final-review/cutover holds persist.

### 14 September 2026 - T33 I08 Stage2 source candidate (not runtime acceptance)

The [corrected Stage1 gate](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5664571822)
accepts the intended intermediate gate on `033588bec6d75aec45188ff7293fcc14d25175d5`:
App2179 units/621 browser tests with four retained skips, Apple7, ordinary
backend/B1/B2/C, the actual four-RPC type artifact, and18 coordinator-accepted
content-reused visuals. The anticipated final generated-type parity difference
was not a blanket green-CI claim. Corrected review withdrew the false
`--no-password`/auth-class claim and invented HBA/DB-digest prerequisites;
unknown authentication/HBA/credential-source/database/source-image facts remain
limitations, not newly passed facts or permission to investigate credentials.
No cycle9 startup cause or fix is inferred.

The [23-path plan](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5664983574),
[actual retained Anthropic Claude Opus5 T39 critique and binding dispositions](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5666571286),
and [matching coordinator-observed local model/edit release](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5666668828)
authorize this one unstaged candidate in the same GPT-6 Astra writer. Requirements
R03/R23/R28 and the relevant R11/R12/R17/R20/R26/R27 boundaries are addressed by
integrated Trash, eight-second owner-memory Undo, server-checked seven-day Restore,
named permanent-delete confirmation and explicit checked/resumable deletion.
Unconfirmed mutations retain their intent; absent rows never prove byte erasure.
The first production consumer of the frozen singular Storage helper uses the
configured API origin, ordinary session, no-body DELETE and raw parsed JSON.
Malformed/unread/oversized replies are safe unconfirmed failures, not fabricated
classifier data. Work is bounded to30 seconds,4096-byte replies and40-row/path
batches; no explicit auth-refresh fallback, automatic destructive resend or AI call.
Nullable RPC coherence is validated separately from exact generated declarations.

The candidate also wires list status, dirty/owner/route cancellation, per-path
cache invalidation with generation/identity-safe cleanup and concurrency4, and
EN/FI/SV copy. Focused unit and browser definitions cover the boundaries.
Independent real-page cases use per-case ordinary fixtures/sessions, bounded
setup/cleanup within the unchanged120-second test budget, authenticated PAGE
DELETE proof, actual upstream response loss and missing-on-reload/resume.
Their cleanup retains expected used-ID markers; it does not delete Auth accounts
or assert whole-private-baseline erasure. Actual execution must establish fitness
within those budgets; no timing guarantee is claimed.

Only the literal WebKit/local selectors and four-PNG upload addition are changed.
All four future I08 captures belong exclusively to exact project `chromium`,
at1280/320 EN/FI, with each PNG bounded to1MiB; all18 prior capture definitions
remain unchanged. New-file flakiness blocks acceptance. The existing18 visual
acceptances are not automatic acceptance of this future candidate.

Validation at this point is manual source/diff/byte/hash/whitespace inspection
only. New tests are **UNEXECUTED locally**; no compiler, parser, lint, runtime,
backend or browser execution was authorized. The adopted actual generated text
is26875 canonical LF bytes/SHA256
`63cca6eb5af1a341956310932034bef654665e4b9146a260bec291574cd90e5b`.
The previous378095 raw phase bytes and all16 older prefixes remain immutable;
the200 outside files remain frozen. No staging, object write, commit, push,
Actions, artifact/image review, hosted/private mutation, new agent, merge or
deployment accompanies this candidate. Ten cycles spent; no11/rerun is released.
Source review and separate exact-head execution, zero-type-diff/live/App/Apple/
22-image/final-review/normal-merge-main gates remain, along with SaveSTOP,
browser400 uncertainty, human/device/account-deletion/recovery/export/paid/
hosted/cutover holds. Productionf318 and the six hosted migrations are unchanged.

#### T33 routine correction batch after T40 source review

The [completed T40 review and binding coordinator disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5668793354)
authorize one unstaged correction batch in the same writer and23-path scope,
under the existing model/edit attestation. T33 names the writer packet, T39 the
plan critique and T40 the actual retained Anthropic Claude Opus5 source review.
Read-only Refresh now preserves unresolved intents and row locks; reconnect
preserves successfully loaded pages while first offline entry still loads on
reconnect. Confirmation construction is caught inside the admitted action after
closing the dialog. Known cleanup-blocked status uses the approved neutral
EN/FI/SV limitation, without claims about prior/concurrent effects or recovery.
The requested-order mock comparator is ordinal. Focused regression definitions
exercise those paths, owner reset and singular DELETE transport failure without
subsequent path requests or FINISH. No clock or photo-version/history/warning
rewrite accompanies this batch.

The requirement mapping above is scoped: this packet contributes I08 lifecycle
actions to R03, destructive concurrency/retry handling to R23, and preserves R28
explicit-Save, saved-only and no-AI-mutation boundaries. Supporting
R11/R12/R17/R20/R26/R27 remain relevant; R20 here is seven-day Trash/Restore,
not completed backups or quarterly restore. No full R03/R28, Phase0 or MVP
acceptance is claimed. Four token-shaped lines remained semantically withheld
from the reviewer; hashes are not semantic proof and no bypass is authorized.
All new tests remain **UNEXECUTED** pending separate execution authority.
Only static source/diff/byte checks are permitted. The17 original phase prefixes,
exact generated types,200 frozen files and18+4 capture bounds remain unchanged.
Source review, exact-head execution/visual acceptance and all previously stated
holds remain; ten cycles/no11/rerun, no staging/commit/push/merge/deploy.

#### 14 September 2026 - cycle11 repair source, execution pending

[Cycle11 evidence and repair proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5669937352)
record lint failure and two new live-page failures on38c4/tree49a2, with ordinary
cleanup verified in both wrappers; Apple7 passed. All three checkout objects
were coordinator-verified as cb9f/tree49a2 with ordered main221/head38c4 parents.
Later App checks/browser/22visuals and backend security/types were skipped.
The original live exceptions remain unknown: branch labels do not prove DELETE.

[Independent Anthropic Claude Opus5 repair-plan acceptance and disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5670094345)
and [current GPT-6 Astra repair-task model/edit receipt](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5670197301)
authorize only this four-file unstaged repair. The flagged Trash effect uses its
stable run alias; both test helpers scope the exact Trash link to the account
popover, preserving legitimate Undo navigation. The fixture asserts one scoped
target and exercises both visible links. The live test keeps strict click without
an extra count probe. Separate granular main/proof/cleanup checkpoints retain
first failures privately and emit at most one bounded failure-only diagnostic,
never raw exceptions, tokens, identifiers or DOM. Existing assertions, one-shot
transport, timeouts, retries and cleanup remain; no original cause is recovered.

These corrections are **UNEXECUTED**. All19 phase prefixes, exact generated types,
other19 Stage2 files and200 outside files, capture suffix/22bounds and four
withheld-line qualifications remain preserved. Eleven cycles consumed; no12 or
rerun is released. Source review and all runtime/visual/type/security, normal
merge/exact-main and previously recorded human/hosted/cutover gates remain.

#### 15 September 2026 - cycle12 compiler correction, execution pending

[Cycle12 results](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5674670059)
record lint PASS on95fae9c/treeca827, but the first reached Stage2 typecheck
failed with eight diagnostics. Later App checks and22visual captures were skipped.
Real Supabase integration (including3live tests), security, preservation,
rehearsals, generated-type parity and Apple7 passed. Coordinator
[artifact/catalog verification](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5674838721)
does not require a type/source change or establish future-head acceptance.

The [reviewed five-path amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5674799145)
and [current GPT-6 Astra edit receipt with corrected line74 preservation](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5674869284)
control this unstaged correction: registered UI error keys, a mock row string
guard, one captured/narrowed header value and a guarded history snapshot.
Raw denial sentinel input and all uncertainty arguments remain, including
work.changed at74. Unit expectations distinguish exact denial from all seven
unknown replies and pin foreign-epoch/read and changed-owner/begin failures.
Each response case retains one DELETE/no FINISH; owner checks retain their
existing request restrictions. No new visible-copy change is claimed.

Three problematic expressions existed in original Stage2; header extraction
is newer, but the prior inline form's typecheck was never executed, so compiler
regression attribution is not settled. These corrections are **UNEXECUTED**;
passing cycle12 live tests did not recover the old exceptions or exercise every
failure diagnostic. All20 phase prefixes, other18 Stage2+200outside files,
exact types,22capture bounds and originalfour redactions plus unread217 remain.
Twelve cycles consumed; no13/rerun. Scoped-delta review and remaining App/visual,
final-review/normal-merge/exact-main/human/hosted/paid/cutover gates remain.

#### 15 September 2026 - cycle13 browser fixture correction, execution pending

[Cycle13 results](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5675285570)
record lint, typecheck, translations, build, scans and2212unit tests passing
on005f167/tree7052. Backend integration/security/rehearsals/type parity and
Apple7 passed; browser results were12failed/4skipped/663passed across three
projects. Two scenarios stopped at the wardrobe Refresh lookup and two at the
owner-item title assertion. Later assertions were not reached; all22visual
gates remain pending.

The [reviewed three-file correction and M1](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5675500983)
change only two wardrobe lookup keys to the existing accessible name and add
four schema-default fields to the shared owner-tab fixture. All assertions,
nine Trash refresh lookups, timing/retry limits and capture behavior remain.
M1 preserves every non-target item-spec byte, including the complete capture
declaration and body from262. All21phase prefixes,220other current files,
199retained historical-outside files and exact generated types are preserved;
the old200manifest and composite item suffix remain historical evidence.

The [verified evidence supplement](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5675402927)
records exact types/catalog evidence and distinguishes raw-analysis wire,
reservation credentials and deliberately failed-write Save handling. These
are not interchangeable Save proofs or recovery of earlier exceptions.
This correction is **UNEXECUTED**; later owner/logout and other scenario steps
may reveal further defects. Thirteen cycles consumed; no14/rerun authorized.
Scoped-delta review and future-head validation, visual/final-review/normal-merge/
exact-main/human/device/recovery/export/hosted/paid/cutover gates remain.

#### 15 September 2026 - cycle14 raw-analysis diagnostics, execution pending

[Cycle14 results](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5676028969)
record green CI on1462efd/tree647faa, including2212unit tests, backend
integration/security/rehearsals/type parity, three live lifecycle tests and
Apple7. The four corrected browser scenarios passed all12first attempts.
Browser output still records1flaky/4skipped/674passed: the WebKit raw-analysis
response sequence received400 instead of504 on its third request. The receiver
observed an empty completed body and rejected it before the analysis callback.
The retry pass does not satisfy the no-new-flakiness gate; the cause is unknown.

[Coordinator visual acceptance](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5676139788)
covers all22approved surfaces at1462: six inspected images and16verified
identical-content reuses. It is not automatic future-head or device acceptance.
The [distinct diagnostic evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5676169103)
separates raw-analysis boundaries, reservation credentials and deliberately
failed-write Save handling; none proves successful persisted Save or recovery
of earlier exceptions.

The [reviewed diagnostic amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5676448136)
adds sequence-only, bounded observations of constructed Blob size, intercepted
body representation and receiver framing/stream properties. Other helper result
shapes, request bodies, owner/error/cleanup guards and capture limits remain.
Independent route/receiver POST ordinals do not prove a shared TCP connection.
API-absent bodies or framing alone do not identify a browser/transport cause;
instrumentation may affect timing, and nonrecurrence is not causal recovery.
The new diagnostics are **UNEXECUTED**, not a transport fix or acceptance waiver.
All22prior phase prefixes and220other files remain frozen. This supports
R03/R23 integration evidence and preserves R28 explicit-Save boundaries.
Fourteen cycles consumed; no15/rerun, commit/push, merge or deployment authorized.
Retained-delta review, future-head validation and all human/device/account
deletion/recovery/export/hosted/paid/cutover gates remain.

### 15 September 2026 - I09 wardrobe browse source candidate, execution pending

This is the source-only I09/R05/R21/R27, S04 packet under the
[original plan](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5679336263),
[controlling A1](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5679486715)
and [approval](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5679576705).
The [own workspace binding](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5679615220)
and [coordinator-observed model attestation/source release](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5679693839)
identify persistent local writer b072a5ab-1da8-4ee6-9c13-e86e7e618c41,
GPT-6 Astra, branch `drrowdev-glowing-carnival`, starting at
`986d7cb7e5e5f4649c9af5a988f24759943948b9` /
tree `03b0e6f16c3fa3795cea542e0cf6003e2e25a1d4`.
[Accepted I08 exact-main evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5678596450)
is prerequisite history, not this candidate's validation or a reopened PR 25.

The candidate adds title/brand/tag and current-language taxonomy search, seven
compound facets, five deterministic sorts, invariant currency price groups and
one trailing genuine-null-price group. A recorded zero remains a real price.
The seven required browse fields retain valid legacy values and current
empty/null defaults while rejecting invalid projections. Eligibility is saved,
nontrashed, ready-image metadata, never suggestion eligibility or Blob success.
Wear sorts use the existing composite owner/event INNER relation, owner-scoped
500-row advancing keysets and distinct stored local dates (R08 semantics only).
All ready-image metadata may load; thumbnails remain window/viewport bounded.
History deliberately avoids a 500-ID URL and is a paginated read, not a
transactionally frozen cross-page snapshot.
There is no schema/view/RPC/grant/generated-type change or inference trigger.

Owner-memory state preserves browse choices across detail navigation and clears
on owner invalidation. History is on demand with a 30-second overall bound,
cancellation/generation guards, complete snapshots and explicit pending/error
states; failed refreshes retain a visibly stale valid view while pruning known
absences. Forty-card windows and near-viewport thumbnail admission reuse the
unchanged private-image queue/coalescing/global-four/epoch behavior. Per-card
unmount cancels observation/subscription, not an individual shared transport.
EN/FI/SV use only A1's seven new keys. The grid declares two columns below 600,
three at 600-899, four at 900 and five at 1250, with the approved sizing bounds.

New unit/browser test source covers projections, search/facets/sorts, 500/501
keysets, wear-date aggregation, errors, timeout/cancellation, staged/late/owner
responses, memory reset, viewport admission, keyboard/a11y and layout boundaries.
The 500-own plus 500-foreign browser fixtures are mocked evidence, not live
500-row performance or RLS proof. The new small ordinary A/B/anonymous local-CI
query test uses checked explicit Save fixtures, actual metadata/embedded-history
reads, peer/anonymous denial and owner-only cleanup. No administrator access
assertion, hosted endpoint or private input is introduced.

**NOT RUN:** Node/npm, lint, typecheck, translation checks, unit/browser/a11y,
integration/security, build, scans, rehearsals and generated-type parity.
Local execution is prohibited; later CI needs separate publication/execution
release. This entry is not a passing runtime result, engineering acceptance,
performance measurement, commit, merge, deployment or finished MVP claim.
All prior phase text, diagnostics, assertions and 22 capture definitions remain.
The [C1 read-boundary incident](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5680008883)
records three read-range overshoots and no masked-content recovery; preserved
file identities do not erase that incident or establish semantic inspection.
Exactly two new bounded CI captures are declared: EN 1280x900 wardrobe grid and
FI 320x1200 filters, each at most 1 MiB, with one-day retention. Neither has been
generated or viewed here. Coordinator exact-head/run/hash review and actual
user/operator review of new/changed pixels remain required before merge.
These two representative captures do not cover every state, the three-column
band, Swedish wording, pending/errors or real devices; DOM checks are distinct
from visual acceptance. No physical-phone LCP or native-language/a11y acceptance
is claimed.
Independent review, exact-head CI/no-new-flakiness, normal-owner evidence and
all existing human/device/recovery/export/hosted/paid/cutover gates remain;
Phase 0 is engineering complete with acceptance open.

## I10a stage1 source increment - 16 September 2026

This section records the first fourteen-path backend/test increment only.
The accepted PR26 main at
`bdb48cee783a9eb5be83c52cd8791e5066eba639`, tree
`248aca28fa5d737f6aaa67ed7bee72db4cfd30ed`, supersedes its historical
preexecution entries above. It does not supply I10a runtime evidence.
Requirements: **R04, R12, R20, R23**, blueprint15 I10 and revision 1.3
photo-first, approved pre-save AI rules.

Authority is the [full plan](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5695610221),
[A1](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5695944194),
[coordinator dispositions/approval](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5696162128),
[own stage1 model/edit release](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5696311665),
[public retained helper contract](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5696501155),
[A2 proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5696525488)
and [A2 dispositions/same-writer resume](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5696691067).
Independent Anthropic Claude Opus 5/high critiques70/71/72 returned **AMEND**;
coordinator dispositions, not critic READY or writer self-approval, authorize
this source scope. The coordinator-observed local attestation belongs only to
`582a6642-4ebd-440d-a7a6-80c590ecfd65` on
`drrowdev-laughing-invention`; it is locally recorded usage evidence, not
tamper-proof or native-platform-equivalent proof.

The proposed tenth migration is
`20260916100000_image_cleanup.sql`: LF-canonical **30667 bytes**,
SHA256 `7ac5beaeec7a05074920f866e6153ea19c0cc3a429e9e29070d3e7aa5573c6b1`.
All nine historical SQL files remain unchanged. It adds owner-scoped
preview/begin/status/claims/finish RPCs, durable private claims and an exact
private deletion context. Pending images require strictly more than 24 hours;
retired images and each present canonical orphan member require strictly more
than 7 days. Ready images remain ineligible even with missing bytes. Unsupported
paths and unverifiable metadata are coarse review reasons, not automatic
deletion authority. Frozen manifest evidence and fresh immutable catalog
identity checks precede checked metadata deletion and compact completed receipts.
Catalog absence is not a claim of physical erasure.

The four replacement-body MD5 pins, computed from actual tenth-migration
function bodies including their original whitespace, are:

| Current function | MD5 |
| --- | --- |
| `private.guard_item_image_deletion()` | `3a84bb649cc47fdb09b8217debf27837` |
| `private.may_create_item_object(text)` | `b2cb4bdec114c45f21e2d0bd607bc4ad` |
| `private.guard_item_object_publication()` | `5e886ec32267f7992e963a4a0e952708` |
| `public.begin_item_deletion(uuid,bigint,uuid,text)` | `63974c11678275f25476ec91340e9411` |

A2 changes only old line367 and old383-387 of the lifecycle schema test.
The replacement loop asserts all eleven unique original bare names, seven
unchanged historical hashes and exactly four absent superseded hashes. The new
test derives all four current signature/hash tuples from actual SQL bodies,
including the publication body rather than using its imported constant as the
expected oracle. The eleven live catalog pins, grants, native Storage guard
checks and ALWAYS requirements remain mandatory.

New ordinary integration/security suites do not receive privileged fixture
flags. A separately guarded CI rehearsal is registered after AI rehearsal and
before type generation, with both cleanup and legacy preservation opt-ins.
It declares strict age boundaries, owner isolation, ready-photo preservation,
partial deletion/resume, multi-page candidates/claims, permanent image markers,
metadata-insertion orderings, whole-item exclusion/replay, retention and native
housekeeping checks. Structural synthetic AI/save rows are not evidence that a
real analyzed Save minted those rows; the existing real B2 gates remain.

Both owners retain their one admitted four-byte native slow-upload denial case.
The callback begins image cleanup but leaves pending metadata, a live untrashed
parent and an active cleanup claim until the helper joins denied settlement.
Catalog-zero and ordinary download/sign/list checks precede finish. These cases
exclude the named deleted-metadata/whole-item-claim/canceled-AI alternatives,
but contain neither an identical unclaimed successful slow control nor an exact
guard trace. HTTP shape alone is not causal proof. The native localhost5000
boundary is not evidence about gateway/Kong buffering. An active-claim UPDATE
refusal may expose an earlier housekeeping UPDATE in native DELETE; disabled
versioning does not waive that runtime check or justify claiming no self-block.

The source declares a 480-second rehearsal budget with 120 seconds reserved for
teardown, finite request/scan/resume bounds and joined operations. These are
unexecuted declarations, not measured performance, proof of whole-process-tree
termination, or guaranteed teardown after runner loss. Normal cleanup preserves
production-lifetime compact receipts and used-ID records; it does not delete
profiles/Auth to manufacture retention evidence.

**NOT RUN:** local Node/npm, parser/compiler/formatter, lint/typecheck,
translation checks, unit/integration/security/browser/a11y tests, build/scans,
backend/native rehearsals, Docker, generated-type parity or hosted operations.
Only ordinary Git and PowerShell/.NET source text/byte/hash checks are permitted
for this source release. No image/archive review or local application execution
is authorized. Source holds remain in force; hash-only preservation is not
semantic review.

Original UI and tracked generated database types remain unchanged. No operator,
browser/config/capture or stage2 work is included. The coordinator owns future
publication/CI admission, exact-head independent review, expiring artifact
preservation, actual matching CI-generated type adoption and any stage2 release.
This entry grants no push, PR, CI, merge, deployment, hosted DDL/account/data,
paid-provider or private-photo authority.

**I10 remains incomplete:** I10b replacement/recovery with approved pre-save AI
is still required; I11 is not made eligible by this source increment. Phase 0
remains engineering complete with acceptance open. All pending normal-owner,
operator, device, recovery/export, visual and hosted gates remain pending.

## I10a R1 timezone repair source - 16 September 2026

This append records the bounded repair of candidate
`5202d179aaf0edb8bd877c7877d4239e9b84e354`, not an observed runtime failure.
The coordinator challenged retained independent review73's initial bounded-CI
READY before publication. Actual Anthropic Claude Opus 5/high review74 confirmed
the source dependency and corrected a manifest-only timezone-setting proposal.
The [reviewed E1-E4 disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5697438532)
and [matching own model/edit release](https://github.com/drrowdev/stillroom-wardrobe/pull/26#issuecomment-5697506931)
control this six-path, same-writer repair. No new review verdict or runtime
acceptance is inferred.

Registered and Storage timestamps previously entered hashed JSON using the
session timezone. Setting only the hashing function's timezone would not repair
JSON already encoded by its callers. A changed timezone could reject the
page-to-BEGIN manifest or strand status/finish retries in that changed context;
this is not a claim that recovery under the original timezone was impossible.
Calendar seven-day subtraction also spans 167 or 169 hours across DST.

The new I10 helpers now use UTC timestamp arithmetic for strict elapsed-age
comparisons, encode registered created_at/retired_at and Storage created_at in
UTC, and explicitly parse the offset-free registered strings back as UTC.
Finite/future checks, nulls, exact sixteen/four-field projections, eligibility_at,
signatures, receipts and all four replacement bodies remain unchanged.
Old I08 and the nine historical migrations are not repaired or reinterpreted.

The guarded rehearsal adds fixed spring-forward/fall-back anchors with 168-hour
and 24-hour boundaries, equality and +/-1 microsecond. It asserts expected
booleans as well as UTC/America-Los-Angeles equality. Existing pending and
retired fixtures exercise non-null registered/catalog timestamps and retired_at,
with one captured observation instant and non-null eligible manifest checks.
Timezone settings are transaction-local inside the existing control-owned
disposable CI transaction. These are private-helper determinism regressions,
not ordinary-owner API timezone evidence, and have not been executed.
Existing boundaries, two slow-upload denial owners, budgets and teardown remain.

The repaired tenth migration is LF-canonical **30839 bytes**, SHA256
`8fa2ea77b162ca2de587dfffc3199db24b2cb6d428b78d9be9eadc9e51a399e6`.
Its Windows CRLF working representation is **31320 bytes**, SHA256
`2e5f0a88f3bf11478a99937d6e45bdf9ca79dfe7f4974e34fa2abd441aa56b11`.
The tenth inventory byte pin and cleanup source hash now match actual source.
PowerShell/.NET text/byte hashing confirmed all four replacement-body MD5s still
match the table above; `git diff --check` passed, and the scoped source diff was
inspected. These are static results only, not SQL execution or test results.
The complete prior phase-result text remains historical evidence.

**NOT RUN:** compiler/parser/formatter, lint/typecheck, tests, native/backend
rehearsals, actual timezone preferences, normal-owner flows, CI and visual review.
PostgREST13 documents timezone preferences, but this application's installed
stack and SDK header API remain unprobed. No new transport contract is assumed.
The restricted Authorization value remains unreviewed and untouched; owner-only
positive calls on the new fixture deletion transport do not prove its peer
isolation or credential correctness. Mandatory production-path owner/peer
acceptance is still pending, not waived.

Publication, CI admission, exact-head review, artifacts and stage2 remain
coordinator gates. This repair authorizes no push, PR, CI operation, hosted
mutation, provider processing, deployment or merge. I10/I10b and Phase 0
acceptance limitations above remain unchanged.

## PR27 CI1 failure and R2 source correction - 16 September 2026

The [coordinator's complete CI1 record](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5698289348)
reports **CI1 FAILED**; its first-cycle allowance is consumed. The following
results belong to source `0bb17ad477444ede32a242998539c3f064712b21`,
base `bdb48cee783a9eb5be83c52cd8791e5066eba639`, not this later correction.
CI run35100624137 attempt1 and Apple run35100624112 attempt1 checked out
merge commit `e85fcab0de3f7e2d4505e2f23ba31e269fd12fe5`, whose tree
`2302c9dc80628cc58ddde5e9764d08f377ef14a0` matches the reviewed source.
Its parents are the stated base and feature head; it is not the feature commit.

App job104808834063 passed dependency installation, then failed `npm run lint`:
`scripts/image-cleanup-rehearsal.mjs:409:7`, `no-useless-assignment`, one error
and zero warnings. All subsequent App checks and eight visual uploads were
SKIPPED, including typecheck, translations, unit/build/scans and browser tests.

Backend job104808834171 passed installation, pinned Chromium, `npm run db:start`,
`npm run db:rehearse`, `npm run db:reset`, ordinary integration and security.
This includes the exact ten-source preservation/catalog checks, new I10a
non-aged protocol/refusals and ordinary peer/anonymous checks, plus four
existing real-local browser cases. It does not establish aged cleanup or
timezone/native rehearsal success.

The old AI rehearsal then failed at served-entrypoint after its B1 normal-session
baseline children passed. Closed evidence reports `inspect-result`,
`commandCode:1`, `listedState:running`; readiness reports `reader-failed`,
`elapsedMs:647`, `lastHttp:null`, no transport failure, and no fresh/stable
readiness. A running container listing preceded a nonzero Docker inspect
result, before inspect-shape parsing. **The cause remains UNKNOWN.** No raw
private evidence was recovered, and no container-replacement race, HTTP
readiness or specific Docker cause is inferred.

The new cleanup rehearsal, type generation/upload and parity were SKIPPED.
The failed partial backend job took 242 seconds; this is not a completed
cleanup or stage2 budget measurement. Artifact inventory was zero: no current
generated types or visual bundles exist to adopt. Stage2/type adoption remains
blocked, not waived.

Apple job104808833802 passed all four generated JPEG cases (10.9 seconds) and
three I07 orientation/composition cases (10.5 seconds) on macOS26.6.2,
build25G83, arm64, image20260907.0351.1. This is generated Mac WebKit evidence,
not physical iPhone/HEIC or user acceptance.

Under the [matching R2 own-model/edit release](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5698396352),
the only executable-source change removes the redundant initial assignment:
`let restored = false;` becomes `let restored;` in `disabledOwner`. Every
finally path already assigns the flag before its checks. All restoration
operations, true/false assignments, failure branches and primary-error handling
remain unchanged; no lint rule or assertion is suppressed.

R2 does **not** diagnose or repair the separate B1 reader incident. Its PR27
incident/merge hold remains even if a later separately admitted run passes.
The frozen reader, old AI rehearsal, SQL, pins, tests, types, workflows and
restricted transport are untouched. The restricted Authorization value and
exact-transport peer gap remain unreviewed; production-path owner/peer acceptance
is still required.

R2 local validation is limited to ordinary Git and text/byte identity checks.
`git diff --check` and `git diff --cached --check` passed. Static hashing
confirmed the exact one-declaration change and intact 402168-byte prior document
prefix; the two-file staged diff was inspected. Other 235 paths are unchanged.
No local lint, compiler/parser/formatter, tests, runtime, backend or Docker
execution is permitted or claimed. CI1 evidence above was supplied by the
coordinator, not queried through Actions by this writer. No passing lint or CI
result is claimed for R2. No push, CI2/retry, stage2, type adoption, hosted,
provider/private/paid, deployment or merge authority follows from this record.

## PR27 CI2 failure and A3 fixture/test correction - 16 September 2026

The [complete coordinator CI2 record](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5698931942)
reports **CI2 FAILED** on source `6eb981229200167016d8b1a7e085f1a18d481ea8`,
base `bdb48cee783a9eb5be83c52cd8791e5066eba639`. CI35104616934 attempt1
and Apple35104617293 attempt1 used actual merge checkout
`6ac0065634e1203ccc3fab1f28a232e9f3a52c69`, tree
`38baaa6bd72a1ef54e1333f2b73a7c8b23922679`, with exactly that base and feature
as parents. The merge checkout is not the feature commit or this later repair.

App104822486440 passed installation, lint, typecheck and translations. R2 now
has actual passing lint evidence. Unit tests failed: 2244 passed, three failed,
27 passing files and two failing files, 7.76 seconds. Failures were the new
manifest-key extractor and two stale preservation assertions. The unchanged
local-backend unit passed all 513 tests. Build, scans, dependency/browser checks
and all eight visual uploads were skipped; negative-test stdout is not a
separate failed test.

Backend104822486867 passed installation, start, preservation, reset, ordinary
integration/security and the old AI rehearsal. Four existing real-local browser
cases passed in 15.0 seconds. AI readiness returned three successful observations
(1491/1326/1331ms). CI1's B1 inspect/code1 failure did not recur, but its cause
remains **UNKNOWN** and the incident/merge hold remains, even after a green run.

The new cleanup rehearsal failed with exit2 and the closed message
`REFUSED: B2 fixture lock boundary.` The unchanged legacy guard requires both
item/image UUIDv4 identities in its admitted b229 namespace; its new caller's
real empty fixture did not request that namespace. Profile-lock admission failed
before its callback, so the profile-lock photo read did not execute. Reaching
this point is execution-order evidence that preceding age, setup, private-helper
timezone and disabled-owner controls returned, not a separately passing cleanup
suite, ordinary-owner timezone API result or teardown acceptance. Later
candidate/claim/native deletion/slow-upload work was not completed.

The cleanup step ran 13:56:52-13:56:56 UTC; the 330-second backend job was a
partial failed run, not a completed cleanup-budget measurement. Type generation,
upload and parity were skipped. CI2 artifact inventory was zero. Apple104822487543
passed four generated JPEG cases (16.1 seconds) and three I07 cases (13.5 seconds);
this is not physical iPhone/HEIC acceptance. No types or visual artifacts from
this cycle exist to adopt or review.

The [A3 disposition](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5699158450)
and [controlling approval](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5699294877)
record actual retained Anthropic Claude Opus5/high critiques76/77, both AMEND,
and coordinator corrections. Earlier claims that the 16-key extractor held were
withdrawn. The suggested factory-body read and inaccurate workflow matcher were
not adopted. The unit already has direct/transitive transport imports; a dynamic
constructor lookup does not provide collection-time module isolation.

Under the [fresh own-model/edit release](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5699379886),
A3 changes only the new rehearsal, new schema unit, preservation unit and this
append. The rehearsal requests two independently fresh b229 UUIDv4 identities,
calls the existing public factory once, then checks the non-null result and
five identity/path equalities against requested inputs before tracking, try/finally
or privileged fixture control. Only the validated real empty fixture is tracked
and reused in the existing upload:false creation loop and housekeeping call.
The 21 siblings, both 1080 slow-denial cases, bounds and exact reverse teardown
remain unchanged; no fake guard-only fixture or helper change is introduced.

The new public-factory contract test uses synthetic IDs, five boolean comparisons
and an in-body dynamic import. It is explicitly skipped unless both CI and
GITHUB_ACTIONS are true; unexpected skipping in a later admitted GitHub App job
is missing evidence. Neither that test nor the new runtime preflight has executed.
The combined-options contract remains unproven; a mismatch must stop before
fixture mutation, not authorize a factory edit or weaker checks.

Both manifest extractors now admit digits after the first identifier character,
preserving the exact ordered 16 registered and four catalog fields, UTC encoding,
parseback and negative assertions. Preservation retains its widths/decorative
lines with the corrected 16-line count, and one exact contiguous workflow literal
including cleanup's IMAGE then PRESERVATION keys with global preservation count2.
The workflow, all SQL/pins/types, old helpers and other 233 paths are unchanged.

Static Git whitespace/diff/attribute checks and bounded source desk review were
performed; downstream manifest projections, UTC parseback, renderer widths,
workflow order/step-local flags and package script remain consistent with the
edited assertions. Canonical byte/blob and staged-prefix checks preserve the
entire 406369-byte previous document prefix. These are source checks, not local
parser/compiler/lint/test/runtime execution or a prediction of green CI.
The restricted transport remains opaque: only retained HEAD/index identity and
normal status were checked, with no factory/header/destructor-body read.
No CI3, push, type adoption or stage2 is released. Final independent exact-head,
native/normal-owner/production-peer, visual/manual/device and I10b gates remain;
I10 is incomplete and I11 ineligible. No hosted/private/provider/paid, deployment
or merge authority follows from this correction.

## PR27 CI3 failure and R4 bounded diagnostic - 16 September 2026

The [coordinator's complete CI3 result](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5700033751)
records **CI3 FAILED** on source `ce23d1cb5b1c1886090fbb8faf145d00205eff23`,
base `bdb48cee783a9eb5be83c52cd8791e5066eba639`. CI35113101529 attempt1
and Apple35113101500 attempt1 used merge checkout
`8947291a1cc5cebf5f30d735ebefe52f2173b6fb`, tree
`76e9e078e4f7c0b4dd5beb696c1015bc2fd6d74d`, with exactly that base and source
as parents. The merge checkout is not the feature commit or this later R4 source.

App104851572078 passed installation, lint, typecheck and translations. Unit
results were 2248 passed and one failed, 2249 total, 28 passing files and one
failing file, 7.92 seconds, with no skips. The A3 public combined-options factory
test actually ran and passed, as did its preflight source checks, registered
16-key assertion and corrected preservation tests. The dynamic-import directive
passed typecheck and remains unchanged. These results neither inspect the factory
body nor establish successful ordinary-owner cleanup.

The single failing catalog assertion received id/name/version/created_at/orphan
instead of the four expected catalog keys. Its whole-routine matcher also counted
the later old_enough orphan argument. The actual catalog-building statement still
has four keys. Earlier source desk checks missed this non-projection match; they
were not executed passing evidence. App build/scans/dependency/browser checks
and all eight visual uploads were skipped.

Backend104851572467 passed installation, start, preservation, reset, ordinary
integration/security and the existing AI rehearsal. Four real-local browser
cases passed in 15.9 seconds; AI readiness returned 2002/1325/1123ms ready
observations. The new cleanup step ran 15:12:00-15:12:06 UTC and failed with
exit1: `FAIL: image cleanup rehearsal primary and fixture teardown.`
Both failure flags were set, but the exact primary phase and teardown causes
remain **UNKNOWN**. The real-owner preflight returned before that catch/finally;
the aggregate message does not diagnose a factory, profile-lock, DELETE, RLS,
timing or transport cause. Zero late-upload completion lines do not prove whether
either case started. No complete cleanup, successful teardown or budget acceptance
is claimed; the 325-second backend job was a partial failed run.

Type generation/upload/parity were skipped and CI3 artifact inventory was zero.
Apple104851571466 passed four generated JPEG cases (16.7 seconds) and three I07
cases (12.5 seconds), not physical-device/HEIC acceptance. No fresh types or
visual artifacts exist to adopt or review.

The [controlling R4 plan](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5700291977)
records actual retained Anthropic Claude Opus5/high critique79, AMEND, and
coordinator dispositions. Its seven-key diagnostic supersedes the proposed
six-key shape. The [fresh own-model/edit receipt](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5700466767)
releases only the new rehearsal, new schema unit and this append.

R4 scopes catalog extraction to its unique building statement before the orphan
branch. It preserves the four ordered catalog keys and all 16 registered keys,
UTC/parseback/shape/negative assertions. A separate whole-routine regression
expects the five observed key/argument matches and locates the orphan call outside
the catalog slice; this does not add a fifth catalog field. SQL remains unchanged.

The backend change is **diagnostic-only, not a cleanup fix**. A fixed 25-label
phase vocabulary tracks existing groups without wrapping, retrying or changing
their operations. The initial phase is age-boundaries, avoiding a redundant
initializer; the existing catch captures it without inspecting the caught value.
The original primary value, including falsy values, and all terminal precedence,
messages, exit codes and success output remain intact.

The three original teardown catches retain every cleanup attempt and add only
category flags. Fixture destruction records every failed attempt (0..38) and the
first original reverse-loop slot (null or 0..37), preserving slot0. False flags
mean no observed failure, not proof a category executed: empty or unreached
categories can remain false. The exact tuple arrays, actor/value arguments,
preflight, 38-fixture registry, 21 siblings, 20-per-page caps, two late cases,
reverse teardown and time/resource bounds are unchanged.

After finally, only a failure emits one added stderr record prefixed
I10A-CLEANUP-FAILURE. Its seven fields are schemaVersion, primaryPhase,
markerRestoreFailed, fixtureDestroyFailed, fixtureDestroyFailures,
firstFixtureSlot and absenceCheckFailed. Nullable fields initialize explicitly
and use nullish coalescing, not truthiness. Values are fixed phase labels,
booleans, bounded synthetic counts/slots and null; no private error, identifier,
path, credential, raw result or environment value is inspected or emitted.
There is no success diagnostic, new catch, forced exit, size-check exception,
logging framework, helper/body recovery or extra artifact.

The unit adds callback/diagnostic-scoped source assertions for these boundaries,
exact output shape, null/zero semantics, all teardown attempts and unchanged
failure branches. The passing A3 public-factory test and other prior coverage
remain. Static .NET UTF8 measurement of the worst-case fixed record, including
prefix and newline, is 215 bytes, below 512. The new unit assertions and actual
diagnostic output have not executed; no runtime or performance result is inferred.

Ordinary Git diff/whitespace/attribute checks, exact scoped staged-diff inspection,
canonical byte/blob checks and the entire 412200-byte prior document-prefix check
are the permitted local validation. Other 234 paths remain unchanged, including
preservation unit, all SQL/pins/types/workflows/helpers and the opaque transport.
Only that transport's retained HEAD/index identity and normal status were checked;
no restricted header/factory/destructor/old-helper body was read.

CI1's B1 inspection incident and CI3's primary/teardown incident remain separate
UNKNOWN holds. A later green run would emit no failure record and would not by
itself diagnose, fix or waive either incident. No local Node/npm/compiler/parser/
formatter/lint/tests/browser/backend/Docker/probe/install/version execution,
push, CI4, type adoption or stage2 is authorized by this record. Final exact-head
engineering, normal-owner/production-peer, native/visual/manual/device and I10b
gates remain; I10 is incomplete and I11 ineligible. Hosted/private/provider/paid,
deployment and merge remain outside this correction.

## I10a R5 - qualified adoption cases and bounded assertion diagnostics, 16 September 2026

### Authority and actual CI4 evidence

This append follows full coordinator result/proposal
[5701416425](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5701416425),
controlling plan approval
[5701959344](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5701959344)
and OWN-model edit/one-commit release
[5702054653](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5702054653).
The release was read in full and matched 10438 ASCII/UTF8 bytes and SHA256
`ee8fc6dbe092ea98b328f08ddefc6a052764216ded33496faa52511032f59e5c`.
The same writer session `582a6642-4ebd-440d-a7a6-80c590ecfd65`,
explicitly selected `gpt-6-astra`/medium, continues on
`drrowdev-laughing-invention` and draft PR27. The coordinator independently
observed seven OWN actual-model entry requests from 17:48:23.749 through
17:50:40.736 UTC. This is locally recorded entry evidence, not a requested-name
claim, another session's usage or tamper-proof/native-platform evidence.

Actual Anthropic Claude Opus 5/high critiques 82 and focused 83 were supplied-text
only, without tools/source access. Their findings, the AMEND disposition and
focused readiness, and the final coordinator amendments are in 5701959344.
The original proposed ready-fixture positive control was superseded: the approved
existing REBOUND control preserves the original ready/retired constructor tuples.
No new planning ladder, writer, reviewer or authority is created by this append.

CI4 run `35122056554`, attempt 1, FAILED. Apple4 `35122056510`, attempt 1,
SUCCEEDED. Actual merge checkout was
`0422129f46a3979dbb75eae0d650fc2d45a82499`, tree
`023270c6b078c96ca4a18ef8187311b2df84ce98`, parents accepted main
`bdb48cee783a9eb5be83c52cd8791e5066eba639` and source
`cce53fa11b425f0bca97b16c12e5db6b14e49473`.

App job `104882003052` succeeded: install, lint, typecheck, translations,
2251 unit tests in 29 files with no skips, build, secret/dependency checks,
697 browser passes with four existing explicit skips, and all eight visual
uploads. The A3 GitHub-only public-factory test actually executed and passed.
Backend job `104882002542` passed through the older AI rehearsal, then failed
the cleanup rehearsal at registered-claims. Types generation/upload and later
parity were skipped. Apple job `104882001562` passed four JPEG and three I07
checks on the actual runner; that is not physical-device acceptance.

The coordinator observed one real 209-byte version1 failure record, including
newline: registered-claims, markerRestoreFailed false, fixtureDestroyFailed true,
fixtureDestroyFailures 21, firstFixtureSlot 37, absenceCheckFailed false.
That identifies the primary phase and teardown count/first original slot only.
It does not identify the precise assertion, SQLSTATE, every failed fixture,
which siblings failed, or any destructor cause. CI1 B1 inspection failure and
the CI3/CI4 cleanup failure family retain their separate UNKNOWN incident holds.
No historical failure cause is claimed diagnosed or repaired by R5.

The coordinator's attached observation ended at 16:38:45.7591691 UTC, within
the prior finite deadline. Eight archives containing 24 PNGs were preserved.
Twenty-three same-name byte/hash/dimension matches reuse accepted-main content
evidence; the English I08 delete image has a pending exact-head visual verdict.
No image/archive was opened or supplied to this writer. No types artifact
exists. Review80's off-scope access incident remains recorded; its withdrawn
metrics/lint assertions are not evidence and were not repeated here.

### Three-file correction

Only `scripts/image-cleanup-rehearsal.mjs`,
`tests/unit/image-cleanup-schema.test.ts` and this append are changed from cce53fa.
The complete prior 418962 LF-byte document prefix is retained, with SHA256
`bc512e06cebc56a6aefe6e1a31bbae432ab7c86a5b212ee82415ef15ae9a07b0`.
All other 234 paths, including every migration, generated type, workflow,
preservation unit, old helper and opaque transport, remain frozen.

The existing rebound fixture is created pending with options `{}` at
registered-setup. An ordinary owner read checks exact owned identity, actual
pending state and canonical main/thumb metadata paths. Its parent differs from
ready, both historical parents and the new adoptable parent, while its image
identity remains shared with the historical fixtures. The existing privileged
fixture-control SQL qualifies absence of owner AND (item OR image) used IDs,
an active exact-image cleanup claim and a whole-item deletion claim. A PUBLIC
`commit_image` call must return explicitly null/absent error. An ordinary read
then checks the same identity and canonical paths in ready state.
The original ready:true/retired-newItem:false tuples and their order are intact.
The control is not an upload-byte provenance or matched-pair claim; differing
IDs/times/provenance and the retained shared historical image identity matter.
The privileged qualification is not normal-user RLS evidence.

Exactly one new otherwise-adoptable pending fixture adds two generated-object
uploads. All 38 old fixtures and their relative order remain; the total is 39,
including the unchanged 21 pagination siblings. Registered iteration order is
empty, adoptable, pending, retired, unmarked, historicalA, historicalB.
Only pending/retired receive the original retention seeds and identity-specific
finalize/preflight/edit/delete/trash/item-claim/retention checks.

The active pending claim's checked status, exact two canonical paths and
presence flags qualify each new denial case. Privileged owner AND (item OR image)
used-ID absence is checked without the positive-only claim-absence predicate.
Immediately before the PUBLIC call, an ordinary read verifies actual owned
pending identity. Adoptable requires specifically 22023 under
`claim-guard-adoption-refusal`, followed by ordinary pending-state and active
claim/both-present preservation. The original zero-object b229 empty case
requires specifically P0001 under `incomplete-upload-refusal`, followed by
active claim/both-absent preservation. That qualified incomplete-upload refusal
is not UPDATE-guard proof. Seeded pending/retired still require 22023 under
`used-id-adoption-refusal`. Original resume and byte-absence checks follow.
No arbitrary error/code union, marker removal, state rewind or hidden-helper
assumption substitutes for these qualifications.

The failure-only record is now version2 with exactly nine ordered primitive
keys: schemaVersion, primaryPhase, markerRestoreFailed, fixtureDestroyFailed,
fixtureDestroyFailures, firstFixtureSlot, absenceCheckFailed, primaryCheck,
primaryClaimOrdinal. A callback-local recorder stores a fixed literal assertion
label on false and delegates the same condition/label to unchanged requireCleanup.
It inspects no error object/property. The original primary catch snapshots the
check and ordinal before finally only for registered-claims; other phases emit
null. A helper/RPC throw before an assertion is recorded leaves primaryCheck null.

Internal claim ordinal starts null, then becomes 0 through 6 before each
registered iteration's first operation. It is separate from original registry
slot null/0..38 and failed-destruction count 0..39. Nullable fields retain `?? null`,
including zero. Every original reverse destruction attempt, primary/falsy value,
failure precedence, restoration flag, terminal error and success output remains.
The 25 fixed phases, page20, two late-upload 1080 cases and their existing bounds,
eight-minute rehearsal, two-minute teardown reserve and 30-minute job remain.
The additional fixture/qualification work is not claimed zero-cost or proven
within the full runtime budget.

### Static evidence and remaining gates

Fresh ordinary guards passed at 17:54:55.3734526 UTC against exact cce53fa/tree023/
soleparent ce23d1c, clean 237 normal stage0/mode100644/H index entries.
`git diff --check` passed and the scoped rehearsal/unit diffs were desk-reviewed.
PowerShell/.NET UTF8 text measurement over all 25 phase and 15 assertion labels
gives a worst-case nine-key record envelope of 294 bytes including prefix/newline,
strictly below 512. False flags, null nullable fields and the two-digit count
cover the longest spellings of those domains. The approved conservative 324-byte
structural envelope was not an executed diagnostic. Neither is this 294-byte
finite-label bound a runtime result.

Directly affected source-unit assertions now cover rebound qualification and
explicit success, the three refusal cases, canonical status preservation,
unchanged reference-identity retention blocks, 39 fixtures, nine-key order,
fixed-label recorder, separate ordinal domain and strict byte bound. Passing
16+4/global5 catalog, UTC, negative, A3 preflight and GitHub-only constructor
coverage is retained. These updated tests have NOT been executed locally.
The permitted remaining checks are exact staged diff/whitespace, regular files/
attributes, canonical LF byte/SHA/blob and HEAD/index identities, full document
prefix, frozen other paths, refreshed ordinary guards and postcommit cleanliness.
Final commit identity and three pins are reported separately without rewriting
this historical prefix or claiming future CI success.

No local Node/npm/compiler/parser/formatter/lint/test/browser/backend/Docker/
probe/install/version execution occurred. Restricted transport verification
uses only retained HEAD/index identity and normal status, not body/header/factory/
destructor access. No push, PR edit, Actions query or CI5 is authorized here.
Type adoption, stage2, hosted/private/provider/paid processing, merge and deployment
remain unreleased. Both UNKNOWN runtime holds and the recorded access incident
remain; a future green run alone is not a waiver. Final independent exact-head,
types/full-budget, normal-owner/production-peer/header/native/manual/device/
visual and I10b replacement/recovery with approved pre-save AI gates remain.
Phase0 is engineering complete with acceptance open; I10 remains incomplete
and I11 ineligible.

## I10a R6 - distinguish direct privileges from qualified claim checks, 16 September 2026

### Reviewed authority and current CI5 evidence

This append follows full result/proposal
[5702843536](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5702843536),
controlling amended approval
[5703023881](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5703023881)
and fresh OWN-model edit/one-commit release
[5703097074](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5703097074).
The release matched 10929 ASCII/UTF8 bytes and SHA256
`5838ff1dbdee07d78d944d4cd52066c2c55b1664d1c9987ecef253eb81f238e4`.
Accepted read-only entry ran 19:07:00.5051505-19:08:12.0059650 UTC against
`e58bd66a857534e4242600b88439b72d6aa4a831`, tree
`956ef126860835239a069f4232297aea4453da4b`, sole parent
`cce53fa11b425f0bca97b16c12e5db6b14e49473`, base/main
`bdb48cee783a9eb5be83c52cd8791e5066eba639`.

The coordinator independently verified seven OWN session582a actual
`gpt-6-astra`/medium requests from 19:06:58.855 to 19:08:54.115 UTC for this entry.
The same explicit model/setting, isolated workspace, branch and draft PR27
continue. This local telemetry is not tamper-proof/native-platform evidence;
app mapping and requested model names are not substitutes for the actual rows.
Actual supplied-text-only critique85 used Anthropic Claude Opus5/high, with one
verified OWN row at 18:59:11.336 UTC and zero tools/source access. It required A1
and A2; the coordinator adopted both, with the causality/coverage limits below.
No new reviewer, writer, planning ladder or authority is created here.

CI5 `35134515616`, attempt1, FAILED; Apple5 `35134515641`, attempt1, SUCCEEDED.
All three actual job logs bind merge checkout
`58a2e106cd040bbe209805d55d2ed2b3058c2dc8`, tree956 above, parents bdb+e58.
App `104923420971` passed lint, typecheck, translations, 2253 unit tests in
29 files with no skips, build, secret/dependency checks, 697 browser tests with
four existing explicit skips, and all eight visual uploads. The cleanup source
unit had 23 passing tests; the A3 public-constructor case executed.
Backend `104923420547` passed db:rehearse, reset, ordinary integration/security
(four real-local browser cases) and the older AI rehearsal, then failed cleanup.
Its 281 seconds were partial failed execution, not a full-budget result.
Types generation/upload/parity were skipped; there are no types to adopt.
Apple `104923420271` passed four generated JPEG and three I07 checks, not
physical-device or HEIC acceptance. These results come from coordinator receipt
5702843536; this writer did not query Actions or open artifacts.

The actual closed version2 failure record was 279 UTF8 bytes including prefix/LF:
registered-claims, primaryCheck claimed-image-edit-refusal, primaryClaimOrdinal2,
all three teardown-category flags false, destroycount0, firstslotnull.
Ordinal2 is pending. The direct UPDATE assertion's expected22023 predicate
failed, but its actual response code was not logged. In particular, 42501 is
not an observed CI5 response. Source-order evidence shows the R5 rebound
promotion, qualified empty/adoptable checks and pending finalize/preflight
predicates returned earlier. It does not reconstruct CI3/CI4 or explain their
21 destructor failures. Later cases/groups were not reached.

The coordinator preserved all eight exact-run archives and 24 approved PNGs.
Twenty-three match accepted CI4 content; English sign-in matches accepted PR26
CI7 content under 5687241771. All24 have scoped accepted-content reuse, not a
new image inspection, device verdict or future-head acceptance. No image/archive
was supplied to or opened by this writer. The prior R5 append remains historical.

### Approved source correction and A1/A2

Initial SQL explicitly revokes authenticated UPDATE and DELETE on item_images.
Direct ordinary calls therefore test the privilege boundary, not execution of
the active-claim row trigger. Their corrected exact42501 expectations are
source-supported and still unexecuted. The existing pending-only UPDATE input
and both calls' identity filters remain unchanged. Ordinary exact owner/item/image
SELECTs with the fixed eight-field projection bracket both calls. Successful,
nonnull pending rows must have canonical paths; the after row must preserve
identity/state/paths, alt_text and description_version. This is combined
preservation, not per-operation attribution. Exact code checks reject unexpected
success/no-op; before/after reads alone do not detect every no-op.

The existing zero-object EMPTY arm retains its qualified P0001 refusal, then
adds a distinct read-only `$forget$` fixture-control block: no exact Storage
objects via unchanged storageTarget(value), no owner/item whole-item deletion
claim, and no owner/item/image delete context. It does not query or forbid the
active IMAGE claim. No marker/context/row is created, removed or rewound.
That privileged fixture qualification is not normal-owner RLS/access evidence.

A2 explicitly links value.main/thumb to canonical owner/item/image paths and
the ordinary before row's metadata paths to those exact fixture paths, retaining
the original A3 early empty preflight. One PUBLIC forget_image call must return
exact22023. An ordinary after row must remain owned/pending with the same
paths/caption/counter, followed by the unchanged checked active/absent afterClaim
and original resume/byte-absence flow. The READY-only description RPC is not
substituted for this pending-image check.

A1 narrows the formerly whole-claims private-table ban to the unique,
existence/order-checked shared `$adoption$` used-ID block. That block still
excludes IMAGE/ITEM claims and delete context. Separate exact `$forget$` SQL
assertions retain its positive qualifications and ban active-IMAGE queries or
privileged mutations. Scoped empty/adoptable branch/code/label and ordering
assertions replace the now-invalid contiguous branch pin, confining the single
forget call to EMPTY before the shared claim/resume checks. Unrelated assertions
are unchanged; no arbitrary-error list, skip or import adjustment is introduced.

Rebound success, qualified adoptable UPDATE refusal, seeded used-ID cases,
pending finalize/preflight and all retired/reference-identity retention behavior
remain. So do 39 fixtures, seven registered ordinals, 21 siblings, both late
cases, page20, all reverse teardown attempts, child/byte/poll/response/join
bounds, eight-minute rehearsal, two-minute reserve and 30-minute backend limit.
The version2 nine-key emitter, 25 phases, nullable zero handling, global slot
0..38/count0..39, registered ordinal0..6, false-only recorder, snapshots,
falsy-primary handling and failure precedence are unchanged.

The two direct labels are renamed and five fixed labels added, giving exactly
20 in the approved order. Recomputed PowerShell/.NET closed-text enumeration
covered 9828 shapes, with a maximum294 UTF8 bytes including prefix/LF, strictly
below512. This is a new static measurement with the new list, not reuse of the
R5 result or execution of the diagnostic/source-unit test. False flags, null
nullable fields and two-digit failure counts bound the longest field spellings.

### Static checks and unreleased gates

Fresh ordinary pre-edit guards passed at 19:12:25.6958768 UTC: exact e58/tree956/
parentcce, same branch, clean including ignored/untracked, 237 normal stage0/
mode100644/H index entries, boolean fsmonitorfalse before status, normal identity
available without values, signingfalse/unset, canonical single origin and no
hooks/locks/operations/rewrites/extra targets or overrides.
`git diff --check` passed; the exact rehearsal/unit working deltas were read.
Permitted precommit checks additionally cover full staged diff/whitespace,
regular files/attributes, canonical UTF8/LF byte/SHA/blob identities, frozen
other paths, refreshed ordinary guards and final clean commit identity.
No application parser/compiler/lint/unit/browser/backend execution occurred.
Final commit and pin results are reported separately, without rewriting history.

Only rehearsal, its new source-unit file and this append change. The full prior
429114 canonical LF-byte document prefix is preserved, SHA256
`9d5ac2fd87fefbad5f77d241afb5e403c3949f755fc7fd1ddd6f368bc2666e5e`.
Other234 paths remain frozen, including SQL/types/workflows/preservation unit/
old helpers and opaque transport. Transport checks are retained HEAD/index
identity plus normal status only, not body/header/factory/destructor access.

Prior reads are not atomic with RPCs;22023 does not exclude every lock contender
or establish unique historical causality. This selected narrow DELETE case and
the retained UPDATE case do not prove globally complete guard coverage, the only
possible route/fixture, a matched pair, byte provenance or physical erasure.
CI1 B1 and CI3/CI4 causes remain UNKNOWN/unwaived; review80's access incident
remains recorded. A later green run alone is not a waiver.
No push/PR edit/Actions query/CI6/artifact/type adoption/stage2 is authorized here.
No local tooling/runtime/probe/install/version, extra agent/session/branch,
hosted/account/data/private-photo/provider/paid, merge or deployment operation
occurred. Exact-head independent/engineering/type/full-budget/normal-owner/peer/
header/native/manual/device/visual/I10b gates remain. I10 is incomplete and
I11 remains ineligible.

## I10a R7 - generated types and exact-space lint correction, 16 September 2026

Full CI6 evidence, artifact provenance and the material sequencing approval are in
[5703681478](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5703681478).
CI6 `35141338291`/Apple `35141338275`, attempt1, used actual merge checkout
`4afeecaf43245def12299def0c5b0bb3fadd4680`, tree
`28cba0e980dba4f033054f4b93234e30ef9a3341`, parents mainbdb plus source
`a1a649eab72604f94cb8a89c17586b57b673ded2`.
App `104946320864` failed `npm run lint`: exactly one no-regex-spaces error,
zero ESLint warnings, at cleanup unit581:30. All later App commands and visual
uploads were skipped, including typecheck and the new source-unit/factory tests.
Backend `104946321011` passed preservation/reset/integration/security/AI and
image-cleanup, then `npm run db:types` and upload; only final tracked-type parity
failed. Cleanup passed in10358ms, with both admitted slow-upload denials and
teardown reporting32 retained minimal claims. Complete backend time was313s,
not a fully green job or a measured performance improvement. Apple passed4JPEG
and3I07 cases, not physical-device/HEIC acceptance. Zero CI6 visual artifacts
exist; prior CI5 content reuses do not accept this or a future head.

Actual supplied-text-only Anthropic Claude Opus5/high critique87 returned AMEND.
The coordinator satisfied A1 using the singular actual lint diagnostic, rejected
A2's broad zero-reference scan and nil-risk premise, and retained mandatory
new-head typecheck. No broad source scan or zero-type-risk claim was made.
This explicit amendment moves an already-approved packet type synchronization
earlier despite App failure; it releases no other stage2 UI/adapter/operator work.

Fresh OWN-model/edit receipt
[5703778033](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5703778033)
matched8888ASCII/UTF8bytes/SHA256
`28db9625efc6d54f37c0f1bae6c547965f7d33bebea6145964d733b3fd80b716`.
The coordinator verified seven actual OWN582a gpt-6-astra/medium entry rows
19:59:51.769-20:03:23.487UTC. Same writer/model/setting/workspace/branch/PR27
continues. Entry's culture-sensitive BOM-prefix check was corrected to exact
EFBBBF bytes; no artifact was normalized or changed. The regular raw .ts artifact
was verified as strictUTF8/LF/noBOM before its targeted text read.

The unit change replaces exactly twelve literal ASCII spaces with ` {12}`;
all other characters and assertions remain. Types adopt the exact CI6 artifact
10465945222 from backend104946321011:27474bytes, SHA256
`ae56564089d0e7c529b2c18596d3ab3ecc56a19befcf142430859743dbf4d009`,
Gitblob `257483843b71f213fa234dda67ecbeb9787d42a2`.
Its19added lines/599bytes contain only five cleanup RPC definitions, matching
the read SQL declarations; no local generation, schema or permission change.
The expected unit target is61285LFbytes/SHA256
`f587a0ca17b80ea4f69814a97c7dd5c81db1e023327d5c0fc8c1f411c9a5a6e3`,
blob `97b544b1e43c0221b6d163944d124397c8f19f10`.

Fresh ordinary pre-edit guards/current source and artifact pins passed at
20:07:12.1500826UTC against clean a1a/tree28c/parent e58,237normal index entries.
The three scoped apply_patch edits are subject to exact target SHA/blob checks,
`git diff --check`, full working/staged delta review, `git diff --cached --check`,
regular-file/attribute/index guards and one ordinary commit. Final commit/pin
results are reported separately. This append preserves all438534priorLFbytes,
SHA256 `f653d0954db280bdc130232c8e9bcdc5ee95c0cbb392d05cae987f1681953791`.
Other234paths, including the rehearsal and opaque transport, remain frozen.
No local runtime/parser/compiler/lint/typecheck/tests/probes/install/version,
held-body/header/private-error/image/archive or Actions access occurred.

CI6 selected predicates passed on a1a, not retroactive historical-cause proof.
CI1 B1/CI3/CI4 UNKNOWN holds and review80's access incident remain unwaived.
Final exact-head App/type/unit/backend/Apple/visual/independent/normal-owner/
peer/header/native/manual/device/I10b gates remain. No future pass, physical
erasure or exhaustive coverage is claimed. Stop after the one ordinary commit:
no push/PR edit/CI7, other stage2, hosted/provider/private/paid, merge or deployment.

## I10a Linux runner characterization - source only, 16 September 2026

The bounded two-file plan is
[5704996173](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5704996173),
8976ASCIIUTF8LFbytes/SHA256
`248a75e9154e3502bfd252dd8d8def9fa73f029c7e6bf57309ea7e6d0ef3a69b`.
Actual supplied-text Anthropic Claude Opus5/high review89 returned AMEND;
the coordinator incorporated A1-A4. This is not approval of the blocked
27-path product integration or a general runner repair.

Fresh OWN-model edit receipt
[5705053720](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5705053720)
matched5521ASCIIUTF8LFbytes/SHA256
`31737ab506dd6e4eb9469a57ce913000ceaaf003b72c37ba536072bdf01b9342`.
The coordinator independently verified five OWN582a gpt-6-astra/medium entry rows
21:44:37.332-21:45:54.243UTC. The same explicitly selected writer continues.
The read-only entry matched f923/tree610a/parent a1a,237normal clean index entries,
both complete append prefixes and canonical public PR/main identities.
Fresh pre-edit ordinary guards passed21:49:19.4010108UTC.

The source appends one CI/GitHub/Linux-gated test with a10000ms timeout and
zero retries. Dynamic imports remain inside that test; existing imports/tests
are untouched. Two sequential inert cases use the unchanged runCommand,
absolute Node, empty child environments and1024-byte capture:
DIRECT requests2000ms with an8000ms natural exit, requiring elapsed>=2000/<8000;
INHERITED requests1000ms with a finite2500ms leaf, requiring elapsed>=2000/<10000.
All success markers use synchronous writes. Exact whole-line integrity,
empty stderr, code2 and elapsed bounds are checked as booleans under fixed labels,
without printing child output. A rejected runner promise becomes a fixed failure.
No permanently wedged child, shell, detachment, network, file, credential,
fixture, helper rewrite or product operation is introduced.

At most two completed-case lines use I10A-RUNNER-LIFETIME and exactly eight
ordered fields: schemaVersion,platform,case,requestedTimeoutMs,elapsedMs,
resultCode,readySeen,endSeen. The platform is linux; integer elapsed is0-9999.
The source checks the strict512UTF8-byte limit including prefix and LF.
The coordinator's169-byte maximum over20000 serialized domain combinations
is static .NET text evidence recorded in the plan, not execution by this writer.

No runtime characterization has run for this source. A future passing inherited
case would characterize a FOUND Linux deadline gap, not browser quiescence,
8-minute budget conformance, guaranteed descendant termination or successful
fixture teardown. The supplied runner contract can settle on error as well as
close; code2 is not a universal cause decoder. Runner/OS loss and missing
completion cannot be represented as joined work. Any later repair needs its
own reviewed scope and suitable conformance assertions.

All61285prior unit LFbytes retain SHA256
`f587a0ca17b80ea4f69814a97c7dd5c81db1e023327d5c0fc8c1f411c9a5a6e3`;
all442795prior document LFbytes retain SHA256
`74e6f9a54bda73d26c1aeed1ac1708f150e035d24d5368e484f51c4b21420730`.
Final static delta/prefix/pin and ordinary-commit results are reported separately.
Other235tracked files stay frozen, including39fixtures/25phases/20labels/
seven ordinals/nine-key rehearsal diagnostics and9828representative shapes.
No local runtime/parser/compiler/formatter/lint/test/probe/install/version,
additional source discovery, held-content recovery or Actions access occurred.
CI8/publication require a separate release. Historical runtime causes, review80,
the writer read incidents and A/E/peer/header/native/manual/final-review/I10b
gates remain open. No merge, deployment, hosted, private or paid authority.

### Runner test-options correction - source only, 16 September 2026

[5705147479](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5705147479)
records the first-party Vitest `test(name, options, body)` API correction.
Fresh OWN-model edit receipt
[5705179850](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5705179850)
matched3491ASCIIUTF8LFbytes/SHA256
`cb3e5b74ce180c267fef4c56ee3e746f1e69b8f0613ee439ec1a0761a0cae8f4`;
the coordinator verified four OWN582a gpt-6-astra/medium entry rows.
Only the unchanged timeout/retry options line moves before the async callback.
All other unit bytes and all446535prior document LFbytes are preserved.
Commit0df remains history; this is an ordinary correction, not an amendment.
No probe execution, runtime failure/pass, deadline or browser-quiescence
conformance is claimed. Publication/CI8 and all existing holds remain pending.
