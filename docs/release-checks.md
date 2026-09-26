# Release checks

Status: **partial**. This file records the automated performance budgets (I25, R21) and the gates that
stay with the owner. It also describes the CI-only Edge runtime gate (PR-3b). The later I26 dependency and restore checks will be added here by
their own PRs. Nothing here claims Phase 7 acceptance.

## Automated budgets

| Check | Budget | Where |
| --- | --- | --- |
| Initial JavaScript (entry plus its static imports), gzip | ≤ 240,000 B | `npm run check:bundle` (App job) and `performance.spec.ts` |
| Any emitted JavaScript chunk, raw | ≤ 300,000 B | same |
| Any lazy (dynamically imported) chunk, gzip | ≤ 30,000 B | same |
| Initial encoded transfer on first install (HTML, CSS, JS, headers) | ≤ 250,000 B | `performance.spec.ts` |
| Sign-in readiness (password field visible), median of 5 cold runs | ≤ 2,500 ms, first install and worker-controlled | same |
| Largest Contentful Paint, median of 5 | ≤ 2,500 ms, first install and worker-controlled | same |
| Cumulative Layout Shift, worst of 5 | ≤ 0.1 | same |
| Offline reopen readiness (worker-controlled, network off), median | ≤ 2,500 ms | same |
| Precache traffic on first install | reported; capped only by the whole servable build | same |
| Worker-controlled reopen, shell bytes from the network | 0 | same |
| Wardrobe with 500 owned items, thumbnail requests before scrolling | > 0 and ≤ 40 | same |
| Wardrobe, sign-in to the first 40 tiles, median of 5 | ≤ 1.25 × baseline (below) | same |
| Recommendation engine, 500 items, slowest of 23 contexts per call, median of 5 runs, 4× CPU | < 200 ms | same |

The budgets change only in a reviewed PR that says why. They are never recalibrated to make a candidate pass.

## Method

- `npm run test:performance` runs `playwright.performance.config.ts`: its own CI job ("Performance
  budgets"), one worker, no retries, serial tests, and a reporter that fails the run if
  `performance.spec.ts` executed nothing. It is separate from the dev-server and `pwa-prod` configs so
  nothing else competes for the CPU.
- Global setup makes one production build with the fictional fixture backend
  (`node_modules/.cache/stillroom-performance/app`) and a separate IIFE bundle of the recommendation
  engine with a seeded 500-item catalogue (`tests/performance/engine-entry.ts`).
- The build is served by `scripts/serve-dist.mjs`, the same local production host as `pwa-prod`: it
  applies the emitted `_headers` rules and serves gzip, and it records each response's encoded body length
  and start/end times.
- Every run uses a fresh browser context (cold HTTP cache, no worker, no storage). The first-install
  visit disables the HTTP cache through CDP.
- **Network shaping.** The sign-in measurements use a second host instance started with
  `throttle: { bytesPerSecond: 200000, latencyMs: 150 }`: every response waits 150 ms, and every body is
  paced in 16 KB chunks through **one link shared by all connections** at 200,000 B/s (1.6 Mbit/s). It
  is in the host, not CDP, because Chromium's `Network.emulateNetworkConditions` applies only to the
  page target: service-worker fetches (the precache) bypassed it, so the first install did not include
  a constrained precache. CPU is 4× through `Emulation.setCPUThrottlingRate` on the page; the worker's
  CPU is not throttled. The wardrobe and engine tests use an unshaped host instance.
- **Calibration.** On every first install the spec requires at least one worker-originated fetch, each
  taking at least 90% of 150 ms plus its bytes' wire time, and one of at least 32 KB, so an unshaped
  worker path fails. It also requires readiness to be at least 90% of the page's wire time plus two
  round trips. A unit test proves that two concurrent responses share the link.
- **Expected assets and compression reconciliation.** The expected first-install set is read from the
  build: the document, the entry script, its static imports (the emitted import graph, as
  `check:bundle` computes it), the modulepreloads and the stylesheets. Every one must show a positive
  CDP transfer, and each encoded length must equal the gzip size of the emitted file (Node's zlib
  default) plus at most 4,096 B of headers. The initial encoded transfer budget counts **every** page
  transfer observed until the sample is taken, including dynamic imports and prefetches outside that set;
  a missing expected asset fails rather than counting as zero. The job log reports the bytes outside the set.
- **Missing measurements fail.** Every first-install and controlled sample must have a finite, positive
  readiness and LCP and a finite CLS before anything is aggregated; the offline sample needs readiness.
- **First install versus worker-controlled.** The first visit measures readiness, LCP and CLS while the
  worker installs; precache traffic is the server-side bytes of worker fetches after the page loads. A
  second page in the same context is then controlled by the worker and is measured under the same
  shaping; its shell must come from the worker cache (0 network bytes). A third page opens offline.
- **Wardrobe.** A mocked normal-session backend with 500 owned items. CPU is throttled after the sign-in
  form renders; the time runs from filling and submitting the sign-in form to 40 rendered tiles and to the first decoded
  thumbnail. Thumbnails are admitted by viewport, so only visible tiles request them before scrolling.
- **Engine.** `recommend()` runs in a blank page at 4× CPU for 20 occasion × season contexts and 3
  outdoor weather contexts; each context must produce suggestions.
- Results print as `PERF <name> {json}` lines in the job log and are written to
  `test-results/performance/results.json` (not uploaded).

The blueprint's issue list names `tests/browser/performance.spec.ts`; the approved Phase 7 plan (rev3)
moved it to `tests/performance/` with its own config so it runs isolated from the functional browser suite.

## Baseline

Committed once, from exact-head CI runs of the PR that introduced these checks (PR #63, job
"Performance budgets" on `ubuntu-latest`), and not recalibrated afterwards. The review of PR #63 found
that CDP shaping skipped worker fetches, so the sign-in rows were re-measured with host shaping
(run 36195614538 at `e3cff1db`); the bundle, wardrobe and engine rows use unchanged methods and keep their first baseline.
Local runs on a slower or busy machine can exceed the timing budgets; the CI job is the gate.

**Runner variance.** The same tree ran twice (run 36187424127 at `378a0df4`, and run 36188540244 at the
next head, which changed only this budget and these docs). The second runner was slower throughout:
engine 22 → 41 ms, controlled readiness 200 → 338 ms, first-install readiness 1,647 → 1,776 ms, wardrobe
tiles 314 → 464 ms. The plan's wardrobe rule is 1.25 × measured; its baseline is the slower of the two
same-tree medians, so runner speed alone does not fail the gate. The readiness budget was 2.0 s (plan rev2) and had
11% headroom on the slower runner; the coordinator set it to the rev1 plan value, 2.5 s, and the measured
value stays reported in the job log.

| Measure | Baseline (median of 5 unless noted) | Budget |
| --- | --- | --- |
| Initial JS gzip (7 files) | 207,677 B | ≤ 240,000 B |
| Largest lazy chunk gzip | 18,696 B | ≤ 30,000 B |
| Initial encoded transfer | 221,901 B expected set at `e3cff1db`; the all-transfers total found 0 B outside it locally | ≤ 250,000 B |
| First install: readiness / LCP | 1,655 ms / 1,668 ms (runs 1,650–1,671 ms), host shaping | ≤ 2,500 / ≤ 2,500 ms |
| Worker-controlled: readiness / LCP | 313 ms / 328 ms, 0 network bytes | ≤ 2,500 / ≤ 2,500 ms |
| Offline reopen readiness | 314 ms | ≤ 2,500 ms |
| CLS, worst run | 0 | ≤ 0.1 |
| Precache traffic on first install | 292,270 B of a 942,145 B servable build, 27 shaped worker fetches (58,945 B in 451 ms) | reported |
| Wardrobe, 500 items: sign-in to 40 tiles / first thumbnail | 314 ms (runs 278–341 ms) / 355 ms; second run 464 ms (447–486 ms) / 536 ms | tiles ≤ 580 ms (1.25 × 464) |
| Wardrobe thumbnail requests before scrolling | 4 (viewport admission) | > 0 and ≤ 40 |
| Engine, slowest of 23 contexts / first call | 22 ms / 18 ms | < 200 ms |

## Findings fixed in this PR

- **Sign-in layout shift (CLS 0.17 at 390 px).** The loading card was replaced by the taller sign-in card
  inside a vertically centred `main`, so the card jumped about 190 px up. On single-column screens
  (≤ 650 px) the entry `main` is now top-aligned, so the card grows downward: CLS 0 at 390 px. At two
  columns the centred layout is kept; the measured shift there is 0.043 (1280 × 800) and 0.087
  (768 × 1024), under the budget but not zero. The budget is measured at 390 × 844.

## Owner and device gates (pending, not a pass)

| Gate | Requirement | Status |
| --- | --- | --- |
| Recommendations under 200 ms on a representative phone at 500 items | R21 | Pending: owner device. The 4× CPU run above is a CI proxy only. |
| Real-photo performance on the phone: capture, crop, re-encode and upload of a full-size camera image | R21 | Pending: owner device. |
| Pre-save analysis latency, measured separately, with the form staying editable | R21 | Pending: owner hosted use. |
| LCP and layout on a real phone over mobile data | R21 | Pending: owner device. |
| VoiceOver (iPhone) and TalkBack (Android) pass over the release journey | I26 | Pending: owner device. The automated journey is `tests/browser/release-journey.spec.ts`. |
| Hosted H1: backup, offline verify and non-committing restore check on the owner's account | I26, R20 | Pending: owner. See [operations.md](operations.md#hosted-operations). |

Backups, the restore drill and recovery steps are in [operations.md](operations.md).

The status of every release gate, with evidence links, is in [release-gates.md](release-gates.md).

## Edge runtime gate (PR-3b, CI only)

`npm run test:edge` is the last step of the **Real local Supabase** job, after the types check. It uses
the disposable CI database only: no hosted access, no real provider credential and no paid inference.
Every line carries one label:

- **EDGE-RUNTIME / PROVIDER-DOUBLE**: the production `analyze-clothing` handler served by the stack's
  pinned edge-runtime image, with the provider replaced only through its injected `azureTransport`. The
  CI-only entrypoint `tests/edge-fixtures/analyze-clothing-double/index.ts` accepts only the exact pinned
  Azure URL and forwards to the provider double; anything else is rejected and counted.
- **EDGE-RUNTIME**: `finalize-analyzed-item`, `finalize-image-change` and `delete-account` as served by
  the stack.
- **HANDLER**: the existing unit tests of the handler code, not served.

A `FAIL` or `BLOCKED` line, or an I17 `DELEGATED` subcase that the gate did not pass, fails the job.
Missing evidence is BLOCKED, never a pass.

How it is isolated:

- A privileged controller (`scripts/edge-fixture.mjs`) runs behind the I17 CI guards and accepts only
  closed operations (freeze/restore owner A or B, count, verify-deleted, down). The normal-session gate
  (`tests/security/edge-runtime.sessions.mjs`) never receives credentials.
- The fixture runtime sits on an internal network in Docker's isolated gateway mode
  (`com.docker.network.bridge.gateway_mode_ipv4=isolated`, IPv6 off), so the bridge has no host
  address. The controller asserts the mode, that no host interface holds a fixture-subnet address and
  that binding the bridge gateway address fails with `EADDRNOTAVAIL`. Its only route out is a fixed-upstream gateway
  (`tests/edge-fixtures/fixture-gateway.mjs`) to the verified stack Kong, with exact route, method and
  header allowlists. The controller compares the gateway's effective config before activation.
- An egress probe in the runtime's network namespace must fail to reach a canary, public TCP and Kong
  directly, and every forbidden route class must be refused (the gateway's 403, or a parser 400 for the backslash and duplicate-Host classes) and absent from both the gateway's upstream record and Kong's log.
  The canary must record no hit. A host canary listening on `0.0.0.0` (proven live from the host on
  loopback and both host-held bridge gateways) and the host-published stack API must stay dark from the
  fixture bridge gateway, `docker0`, the stack network gateway and `0.0.0.0`.
- The stack and fixture runtimes must both run edge-runtime v1.74.3 by the digest pinned in
  `scripts/edge-fixture.mjs`; the fixture is launched by that immutable reference and its image ID must
  equal the stack container's.
- `AZURE_REVIEW_EXPIRES` blocks the gate once the review date passes.
- Owner-scoped request IDs are tested as fresh UUIDs: a foreign ID gives the same result as a new one
  and leaves the victim unchanged.

Each endpoint gets owned positive controls, then foreign-ID, anonymous and frozen-owner negatives. The
victim's rows, object statuses and SHA-256 hashes, AI status and the relevant receipt are read with its
own session immediately before and after every negative and must not change. Two approved accounts are
the most the schema admits, so the `delete-account` positive deletes owner B as the final case, with a
seeded item and image for both owners that must download first; afterwards owner A is unchanged and B's
rows, images, objects and login are gone. Owner A's AI consent is
left at revision 2; the CI database is discarded after the job. Restore is asserted: frozen owners are unfrozen, `ai_controls` must equal the pre-activation snapshot and no `e3b0` gate rows may remain.

`npm run check:deploy-artifacts` (App job) walks the static import graph of every deployable function
(each `[functions.*]` entry and every function directory) and fails if it reaches `tests/`, `scripts/`, a seed
file or an edge fixture, uses a non-literal dynamic import, or if a migration or seed file contains a
fixture marker. It parses `supabase/config.toml` with a strict subset parser that rejects anything it
does not understand (literal or multi-line strings, quoted or dotted keys, inline or array tables,
unknown function keys), and resolves import maps the way the runtime does: the configured `import_map`,
else the function's `deno.json` or `deno.jsonc` (both is an error), else `functions/import_map.json`,
including `scopes`. Keys, targets and scopes follow import-map URL rules: every scope key and every
relative key or target is joined against the map's URL (so a bare `"sub/"` scope applies), a bare
target is an invalid address, and a prefix match that backtracks out of its target fails. Every mapped
target in every map file is checked.
