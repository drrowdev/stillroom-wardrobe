# Phase 1 — I06 personal settings result

8 September 2026. Existing PR #7, `copilot/copilotphase1-personal-settings`.
Base main: `7f6e13a89603492e933748b6558b493d3d74e855`; saved starting head:
`54252d79852301a0b7cd20977699bfd6fe01da86`. Final validated executable head:
`557a44e772f9561e5bf8455806a9df5dedbe3fbe`; this subsequent document changes
no executable input. Local engineering checks pass. **Fresh-head CI, independent
final review and coordinator visual acceptance remain pending**, not Phase-1
acceptance passes. No merge or deployment occurred.

## H1 documentation correction — 8 September 2026

[Approval 5580579847](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580579847)
authorizes only the active authority correction in the four handoff guides and
this result note, starting at `efb96aa1cca195c196815aa708663e909c3f53bf`, with
the same PR/branch/base. After context and before edits, the writer read its own
[coordinator native Astra receipt 5580603905](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580603905),
for task `e899b9ea-7785-4608-9e26-b4ddd0b6eb90`, session
`7b622749-63b2-4029-ad9a-246cae6a7709`, observed `2026-09-08T06:51:36.8859162Z`.
No old receipt was reused. Historical decisions and failed-run evidence remain
unchanged; the original worker handoff above and below remains dated evidence.

For that starting head, CI `34194039775` and native Apple `34194039797` passed.
[Parent review 5138212823](https://github.com/drrowdev/stillroom-wardrobe/pull/7#pullrequestreview-5138212823)
records actual review of both synthetic PNGs, their hashes and a visual PASS.
The H1 approval records actual Anthropic Claude Opus 5 reviewer
`20666849-c59d-4948-93cf-0067af8f3454` finding no significant functional issues.
These predecessor results do not validate the new documentation head.
The coordinator owns required new-head CI and actual artifact review, recorded
on PR #7 rather than in a source commit merely recording its own hash. No local
app/browser/database suites or image generation/viewing ran for this correction.
Phase 0 remains engineering complete, acceptance open; only the second hosted
account test is user-deferred, and other manual checks remain pending, not waived.

## Authority and context

Read both full approvals before edits:
[I06 plan 5579471741](https://github.com/drrowdev/stillroom-wardrobe/pull/6#issuecomment-5579471741)
and [controlling transport amendment 5579906237](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5579906237).
They record actual **Anthropic / Claude Opus 5** reviewers
`personal-settings-plan-critique` and `i06-visual-transport-critique`.
Coordinator amendments cover shared profile versions, scoped freshness, retained
draft baselines, one owner read after an empty PATCH, SQL's actual owner INSERT/
server-version behavior, and bounded private-input-free artifacts with retained
visual review. This was completion of the approved packet, not a new plan,
replacement feature or another agent.

After context and before edits, reread
[public receipt 5579937425](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5579937425):
coordinator explicitly selected and authenticated-GET verified actual
`sweagent-capi:gpt-6-astra`, task `210fb893-7617-4dc1-88ef-eae5272e2ab6`,
session `c40a8a6b-551d-4831-8703-691b138c980a`, at
`2026-09-08T05:47:29.6473139Z`, matching this PR/base/starting head.
Old failed-session receipts were not substituted.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/cloud-development.md`, current/historical result excerpts and
`docs/local-backend.md`; blueprint 00/03/05/10, relevant profile/RLS 07, API 08,
commands 13, Phase 1 in 14, I06 in 15, localization 19 and pre-save contract 20.
Read actual migration/generated-type profile/preferences and ownership excerpts;
all 17 saved changed code/test files, relevant Auth/app/error/i18n/style and mock
context, local-only/hosted guard excerpts, test wrapper, package scripts,
Playwright config, CI and the unchanged Apple workflow. PR #6/#7 discussions,
PR #7 body/diff/reviews and MCP workflow/job logs were consulted. During
validation, also read the existing recovery URL contracts, quality-gate fixture
test, Vite config/installed tsconfig watcher and R02/R25/R27 requirement text.
No image, binary archive, private credential cache or hosted input was opened
through the worker's model tools.

## Implemented packet and boundaries

I06 maps to **R02/R25/R27**, preserving **R01/R11/R26**. This supplies I06's
profile/preferences portion, not the later suggestion-feedback implementation
or the whole MVP.

* Protected `#/settings`, account-menu entry, current-owner badge and cream/green
  desktop/narrow layout. Name, IANA timezone and uppercase three-letter currency
  save separately from language and optional preferences.
* Explicit PATCH allowlists, current owner/version predicates and scope signal;
  validate returned ownership and adopt the returned row. A null representation
  performs exactly one normal owner read: changed version is a conflict, missing
  row is unavailable/locked, unchanged row is a failure. No upsert or false success.
* Profile/language writes share one authoritative saved row and serialize. Owner
  epoch is not recreated by either save. Older same-owner reads cannot replace a
  newer published row; another owner's lower version remains valid.
* Dirty baselines do not advance on unrelated refreshes. A known own language-only
  version advance preserves input. Conflicts retain input with explicit reload or
  re-submit choices. Preferences report their own load/save/error independently.
* Optional arrays allow 8 colours, 8 private-text style tags and 7 exclusions;
  coverage 0–2, cold sensitivity −2–2, repeat gap 0–14. New style tags are bounded
  to 40 Unicode code points. Persisted unknown/duplicate/longer values remain
  visible/preservable, never silently translated, truncated or dropped.
* EN/FI/SV labels, errors, native-name language controls, live announcements,
  keyboard groups and visible numeric choices. Offline disables remote saves,
  not editing. Native `Intl` options have feature detection; known SQL timezone
  rejection becomes localized actionable feedback, not raw upstream text.
* One dirty-navigation mechanism covers settings/capture and Back/Forward/hash
  changes. Reload preserves history position, same-route entries retain dirty
  state, and benign startup URLs are not rewritten. Logout/owner change clear
  drafts without discard prompts. Language saves preserve unsaved garment input.

The original 17 saved code/test files were resumed. Only the approved 23 paths
change across the PR: original 22-path packet plus the App CI artifact step.
The active handoff repair is a separate documentation commit `e93231b31a4acf48775dab15a7db11da377c369d`.
Schema/migrations/generated types, packages/lockfile, local CLI tooling, recovery
source/tests, JPEG/wire receiver, garment Save and native Apple workflow stay
unchanged. No weather, AI/provider, export/deletion UI, other-account directory,
I07/I29, new dependency or hosted operation was added.

## Actual validation

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Final browser execution was serial with unit/build/other validation stopped;
all browser invocations below explicitly disabled retries.

| Exact command | Actual result |
|---|---|
| `npm run typecheck` / `npm run lint` | Final runs exit 0. |
| `npm run test:unit -- tests/unit/preferences.test.ts` | Exit 0, **28/28**. Bounds, private/unknown text, field allowlists, returned rows, owner/version/signal checks and null-PATCH disambiguation. |
| `npm run check:translations` | Exit 0, **383 EN/FI/SV keys**, 31 source files. |
| `npm run test:unit` | Exit 0, **380/380**, 10 files. |
| `npx playwright install --with-deps webkit` | Exit 0; restored the existing pinned missing browser/system libraries, no package/workflow change. |
| `npm run test:browser -- tests/browser/profile.spec.ts --retries=0` | Exit 0, **54/54** across Chromium, mobile emulation and Linux WebKit after layout/history fixes. Final full run below also covers the later controlled reload assertion. |
| `npm run test:browser -- tests/browser/profile.spec.ts tests/browser/recovery.spec.ts --grep 'external focus refresh\|benign URL bootstrap' --repeat-each=5 --retries=0` | Exit 0, **35/35**. Existing recovery tests unchanged. |
| `npm run test:browser -- tests/browser/profile.spec.ts --grep 'localized timezone\|external focus refresh' --repeat-each=5 --retries=0` | Exit 0, **30/30**, without concurrent validation processes. |
| `npm run test:a11y -- --retries=0` | Exit 0, **24/24**, run before the final full browser command. |
| `npm run test:browser -- --retries=0` | Final serial run exit 0, **281/281**, including all configured engines, owner/draft/conflict/localization cases and both capture guards. No skips or engine weakening. |
| `npm run db:start` | Exit 0; confirmed the prepared disposable stack. No worker reset/reprovision. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0: both real normal owners' settings/version/conflict/clear/unchanged-other-owner/item-money checks plus existing contracts; **1/1 real recovery UI journey** passed. Repeated after the router correction. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0, **12 stages**, normal A/B/anonymous only. Actual SQL identity immutability and server versions, both foreign directions, independent language, Storage/admission and owner liveness; fictional fields restored using fresh versions. Repeated sequentially after integration. |
| `npm run db:types -- --check` | One invocation, exit 0; actual local generation exactly matches committed types. |
| `git diff --exit-code 7f6e13a89603492e933748b6558b493d3d74e855 -- src/data/database.types.ts supabase package.json package-lock.json scripts .github/workflows/apple-jpeg-probe.yml` | Exit 0; these boundaries remain unchanged. |
| `npm run build` | Exit 0; JS **158.08 kB gzip**, CSS **4.72 kB gzip**. Non-failing >500 kB uncompressed chunk warning remains; no threshold change. |
| `npm run scan:secrets` | Exit 0, **144 text files** at the executable head, **145** including this result; setup canary checked. Changed-file scans also passed before commits. |
| `npm run check:dependencies` | Exit 0; 12 production/220 development packages, zero unverified release dates and zero reported production advisories. |
| `git diff --check` | Exit 0. |

Failures are not erased: initial saved syntax had an extra parenthesis, stopping
typecheck before lint/units. Initial targeted browsers found 200%-text overflow
and absent WebKit; settings intro wrapping and bounded workspace skip-link width
resolved the overflow without hiding it. First full run was **278/281**: two
benign-URL regressions were fixed in app routing, not recovery, and one conflict
re-submit observation failed. Its test now explicitly controls the reload reply
and checks draft retention before/after it. A second full run was **280/281**,
with an unexpected same-route reload during timezone validation.

Those full runs overlapped unit/static validation. Source investigation found
`tests/unit/quality-gates.test.ts:22–34,97` creates/deletes a `tsconfig.json`
inside the watched repository; installed Vite's `reloadOnTsconfigChange` broadcasts
full-page reloads for that filename. This is a concrete interference mechanism,
not proof of the exact original event timing. Keep unit and browser suites
sequential, as existing CI already does. No unrelated tooling fix was made.
Isolated repeated cases and the final complete serial run passed without retries.

Automated validation at executable head `557a44e` found **zero CodeQL Actions
and JavaScript alerts**. The code-review executable was unavailable despite the
wrapper's success heading: **not a code-review pass**. Actual coordinator
independent final review remains required.

## Visual evidence and remaining gates

The approved text-only alternative was followed. Tests alone wrote exactly:

| Ignored synthetic artifact path | Final local filesystem metadata |
|---|---|
| `test-results/i06-visual/profile-en-desktop.png` | Regular PNG, 1280px English, **170242 bytes** |
| `test-results/i06-visual/profile-fi-mobile.png` | Regular PNG, 320px Finnish, **189240 bytes** |

The test asserts protected loopback settings, known fabricated owner/language,
no login/password controls, and a boolean-only credential-pattern scan of visible
body text plus rendered form values before capture. Each configured project
executes the functional/axe checks; only Chromium writes PNGs. One flow checks
exact file count, regular-file status, PNG header/width and ≤1 MiB each.
Screenshot buffers are ignored. The worker inspected **filesystem metadata only**,
not PNGs, and made no visual-quality verdict or image-baseline claim.

After the full browser command succeeds, App CI uploads only these two explicit
paths as `i06-profile-ui-<PR head SHA>` (current commit on non-PR events), using
the existing pinned upload action, one-day retention and missing-file failure.
No Database job, permission, cache, matrix, runner, service or deployment changed.

At executable head `557a44e`, [CI 34193167527](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34193167527)
and [Apple 34193167514](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34193167514)
were **action_required**, not passes. The coordinator must review the exact
published head, authorize required CI, complete independent review, verify
artifact provenance/contents, and actually view both PNGs. Its final visual
run/head/PNG SHA256s/verdict is linked from **PR #7's review/comments and session
ledger**, without another source commit to record that commit's own head.
Missing/unread images leave visual acceptance pending. A failed full browser run
retains its primary failure; absent artifacts are not invented root causes.

The earlier two native CAPI 400/file-download upstream-404 failures remain
platform evidence; the missing URL and app-code causation are unknown. No model
image input occurred here. No hosted smoke, private input, deployment, merge,
Actions approval/rerun or additional agent was used.

Phase 0 is engineering complete with acceptance open. Only the second hosted
account test was user-deferred; other hosted/operator, actual iPhone/Android,
camera/library, native-language and VoiceOver/TalkBack checks remain pending.
Linux WebKit, mobile emulation and axe are not those human/device passes.
The user-authorized ordered-development policy does not make I07/I29 part of
this packet or waive separate paid/provider/hosted/deployment approvals.

## Rollback

Revert the reviewed I06 UI/data/session/navigation, tests and App artifact step
through a separately approved PR to the compatible base
`7f6e13a89603492e933748b6558b493d3d74e855`; preserve historical evidence and the
current handoff policy. No migration rollback, hosted replay, reset or account
repair is needed. Existing profile/preferences and item money remain compatible;
version counters do not roll backward. Worker rollback is not merge/deployment
authority.
