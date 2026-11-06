# GitHub Copilot cloud development

Development now uses fresh isolated LOCAL implementation writers per approved
packet (at most two builders, one writer per branch; models updated 8 October 2026) against
`drrowdev/stillroom-wardrobe`. No new cloud/native coding
allocation, wrapper, retry or automatic fallback is authorized. GitHub Actions
remains CI, not a coding agent. This historical title/path and all existing
headings/anchors remain for evidence-link compatibility. Source is public;
account credentials, photos, backups and local service state must never be published.

## Model and session policy - 8 October 2026

The [owner decision on #84, comment 6067719398](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6067719398)
controls builder and reviewer model selection for new work. It supersedes the
builder and reviewer model assignments in the 7 October section below; the
session lifecycle and every other gate in that section are unchanged. Sessions
already started keep their recorded models.

* **Coordinator:** Anthropic Claude Opus 5.5 (`claude-opus-5.5`), per the owner's
  separate 8 October instruction to the coordinator, not that comment. Keep coordinator
  context economical as a cost guard: before it grows large (about 272K tokens),
  publish a compact handover on #84 and ask the owner for a fresh coordinator
  session.
* **Builders:** a fresh isolated LOCAL Anthropic Claude Sonnet 5.5
  (`claude-sonnet-5.5`) session per approved packet, with
  `reasoning_effort: high`; at most two concurrent. Start read-only in plan mode;
  coordinator approval permits autopilot. After the packet's PR merges, the
  coordinator archives its builder; do not reuse it for another packet. Keep the
  same session/model/source for routine scoped corrections. Retired long-lived
  builders stay retired.
* **Reviewers:** read-only OpenAI GPT-6.1 Sol (`gpt-6.1-sol`) task agents with high
  reasoning, a different provider from the builders. Use `rubber-duck` for
  required Tier A plan critiques and `code-review` for code reviews. The
  coordinator obtains the independent review; writers never launch agents or
  review themselves.
* **Never use GPT-6 Astra for new work.** The actual-model evidence check, STOP on
  a mismatched model, no Auto or fallback, risk tiers, the small-fix rule, one
  review per change, merge and deploy authority and text-only builders are
  unchanged.

## Model and session policy - 7 October 2026

Superseded for the builder and reviewer models by the
[8 October section](#model-and-session-policy---8-october-2026) above; kept as
the dated record and for its session lifecycle rules.

The [owner decision on #84, comment 6036228105](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6036228105)
controlled model selection and session lifecycle. It supersedes older model pins
and long-lived builder instructions in this guide and the root/Copilot
instructions. It also supersedes the 1 October reviewer-model note in
[the release ledger](release-gates.md); its earlier review attributions remain a
historical record. Historical model names, decisions, reviews and receipts remain
evidence, not commands for new work. Other scope, authority, tooling, text-only,
CI and merge gates remain unchanged.

7 October assignments (superseded for new work by the 8 October section):

* **Coordinator:** OpenAI GPT-6.1 Sol (`gpt-6.1-sol`), with compact context below
  272K tokens. Before context grows too large, publish a compact handover on #84
  and ask the owner for a fresh coordinator session.
* **Builders:** a fresh isolated LOCAL OpenAI GPT-6.1 Sol (`gpt-6.1-sol`) session
  per approved packet, with `reasoning_effort: medium`; at most two concurrent.
  Start read-only in plan mode; coordinator approval permits autopilot. Keep the
  same session/model/source for routine scoped corrections. After the packet's
  PR merges, the coordinator archives its builder; do not reuse it for another
  packet. Retired long-lived builders stay retired.
* **Reviewers:** read-only Anthropic Claude Opus 5.5 (`claude-opus-5.5`) task
  agents with high reasoning, a different provider from the builders.
  Use `rubber-duck` for required plan critiques and `code-review` for code
  reviews. The coordinator obtains the independent review; writers never
  launch agents or review themselves.
* **Never use GPT-6 Astra for new work.** Its historical reviews remain
  evidence. Required models must be available and verified; no Auto or fallback.

## Leaner process - 24 September 2026

Updated 24 Sep 2026 (owner decision): leaner process. The owner approved it in
the coordinator session on 24 September 2026 at about 18:10Z. Where older text
in this guide or the root instructions conflicts, this section wins except for
the controlling 8 October model/session policy above (and the 7 October lifecycle
rules it keeps). Historical
PR, comment and receipt references stay as evidence.

**Planning by risk tier.**

* **Tier A**: database schema or hosted database changes, AI/provider/cost/consent,
  auth/security/privacy, deletion/data integrity, and CI infrastructure. Write a
  plan and get ONE read-only OpenAI GPT-6.1 Sol plan critique using a
  `rubber-duck` task agent with high reasoning. The coordinator applies
  its findings as binding amendments and approves. There is no second review
  round unless scope, authority or behaviour changes materially.
* **Tier B**: UI, copy, docs, tests and small features without schema changes.
  The builder writes a short plan; the coordinator approves it directly. No plan
  critique.
* **Small fixes** ([owner decision of 6 October 2026](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6021407660)): about 150 or
  fewer changed lines of product code, touching no auth/sign-in/session, account
  or owner data, RLS/DB/Edge, AI cost/allowance/provider, privacy or storage
  rules, and not a new feature. No separate plan critique: the builder writes a
  short approach in the PR body, and the PR records it with the code review
  below. Everything else is unchanged.

**Code review.** Every change gets ONE read-only OpenAI GPT-6.1 Sol code
review using a `code-review` task agent with high reasoning before merge.
A repair of its findings gets a quick delta check only when the fix is
non-trivial. The coordinator reviews routine CI fixes inside an approved packet.

**Evidence.** Keep the PR description (scope, validation, what is pending), the
review verdict, green exact-head CI for all required jobs, coordinator visual
review of UI captures and a short coordinator merge note. Release files with
checksums, per-file SHA256 receipts, publicly posted model attestations and
"stage exactly N files" instructions are no longer required. The coordinator
still verifies the builder's actual model from session logs and notes it in the
merge note.

**Local validation.** Builders run only `npm run lint`, `npm run typecheck`,
`npm run check:translations`, the affected unit tests and the affected browser
specs on the 3 projects (chromium, mobile, webkit-photo). The full suite is CI's
job ([owner decision of 6 October 2026](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6021407660)); `--repeat-each` is for flake
work only. Builders report honestly what they did not run.

**Tests.** Prefer behaviour checks over pinned counts, file lists or hashes.
Keep pins that protect security or consent: the consent notice hash,
migration-body reproductions and secret scanning.

**Builders don't stall.** Builders use plan mode only for the planning step.
After approval they run in autopilot.

**Deploy more often.** After each merged user-visible change the coordinator
recommends a Pages deploy, which the owner runs. Hosted database changes, paid
AI and provider changes still need their own owner approval.

**Unchanged.** Owner isolation and privacy rules; no secrets in the app, bundle
or logs; hosted mutations only with owner approval; merge guards
(`--match-head-commit`, no `--auto` or `--admin`, no self-approval); one writer
per branch; at most two implementation builders. Model/session policy follows
the controlling 8 October section above (lifecycle per the 7 October section); the
[23 September model decision](https://github.com/drrowdev/stillroom-wardrobe/pull/32#issuecomment-5795033115)
is superseded historical evidence.
Text-only builders, local tooling rules and no cloud coding allocation also
stay as below.

## Local development policy - 11 September 2026

The [user decision at 2026-09-11T12:49:58.200Z](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634772726)
and [actual different-provider critique/coordinator-approved cutover](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634938691)
supersede the former cloud default and two-cloud-builder allowance. Keep one
approved packet/branch/PR and one writer per workspace. Routine scoped repairs
stay in the same packet's local session; fresh sessions per packet and archival
after merge follow the 7 October policy above. Genuine read-only review remains
separate; workers never launch another agent or packet. Never implement in the
main checkout or the coordinator's old read-only checkout. The coordinator
records owned files, dependencies and shared-resource owners before assignment;
do not stop, reset or mutate unrelated services.

Explicitly select **Anthropic Claude Sonnet 5.5 (`claude-sonnet-5.5`)** with
`reasoning_effort: high` for each fresh isolated LOCAL builder session per
approved packet. Required different-provider review uses **OpenAI GPT-6.1 Sol
(`gpt-6.1-sol`)**, high reasoning, read-only task agents:
`rubber-duck` for required plan critiques and `code-review` for code reviews
(8 October 2026 owner decision `6067719398`).
Never use GPT-6 Astra for new work.
The [23 September model decision](https://github.com/drrowdev/stillroom-wardrobe/pull/32#issuecomment-5795033115)
is superseded by the current policy. Historical sessions retain their recorded
models and results; for example, PR #32's GPT-6 Astra writer and Anthropic Claude
Opus 5 review remain evidence, not reusable builders. A model name in a prompt
is not proof. The owner's 23 September reconfirmation of GPT-6 Astra for critique
and rubber-duck work is also superseded historical evidence; public copy in
[`5815445262`](https://github.com/drrowdev/stillroom-wardrobe/pull/37#issuecomment-5815445262).
Start each local implementation
session read-only (plan mode) for the planning step; the coordinator's plan
approval is the edit permission, after which the builder runs in autopilot.
The coordinator independently checks the writer's OWN documented
machine-readable actual-model usage outside the writer's turn output against
the app/CLI identity, repository, workspace, branch, base head and scope, and
notes the result in the merge note (updated 24 September 2026; a publicly
posted attestation before edits is no longer required). Never invent a native
task or PR ID. Requested model names, another session's evidence or a
mismatched model mean STOP, not Auto/fallback. Maintain same
session/model/source continuity through routine scoped corrections.

Local usage telemetry is locally recorded, not tamper-proof or equivalent to
remote native-platform evidence. Independent retrieval and cross-matching
mitigate that weaker provenance; writer self-report does not replace them.
Use supported documented app/CLI metadata tools, not raw metadata-database
access. Historical native receipts were coordinator-authored public comments
backed by authenticated native-platform GET, not platform-posted receipts.
They cannot attest a local writer. The native-only numbered-comment-page and
quiet-window intake is historical, not a local prerequisite or workaround.

Local implementers are deliberately **text-only**, not because a local-platform
image limitation is assumed. No image/binary/archive viewing, image-returning
tools, image attachments, encoded image bytes or image embeds into the model. Existing
packet-approved tests may internally process bounded synthetic fixtures/capture
buffers and return text-only outcomes. Only the designated coordinator actually
reviews approved exact-head artifacts and records run/head/verdict.
Artifact existence, DOM checks or worker judgment cannot replace that review.
Historical capture bounds remain intact; missing/unread evidence stays pending.

Documentation editing needs no Node, Docker or fixtures. Code validation needs
the exact pinned Node toolchain **and required locked dependencies**, plus
installed browsers for browser selections. Never change engines, `.node-version`,
the lockfile, setup/CI pins or add/change another version file to fit the machine.
Use isolated approved tooling rather than silently changing global tools.
System/global installs, Docker/WSL changes, admin operations and licence/EULA
acceptance require specific approval; no registry/TLS workaround, credential/
service-state copy or cloud fallback is authorized. Historical cloud setup
does not establish this laptop's capability. A missing dependency, browser or
service must be reported as blocked, not passed.

Backend-dependent operations require specifically approved working local-stack
ownership/setup: `db:start`, `db:reset`, `db:rehearse`, `db:types` and actual
local type generation, ordinary integration/security, fixture provisioning,
live SQL/container/runtime operations and B1 rehearsal (including
`startAnalysisServer`, `privilegedLocalSql`, `requireLocalContainer`). Until that
capability is established, unchanged CI must supply their mandatory actual
execution evidence; mocks cannot substitute. A CI live failure has no established
local reproduction environment merely because Node works.
Default `test:browser`/`test:a11y` use the `playwright.config.ts` fixture suite
and Vite, with installed dependencies/browsers but no Docker backend requirement.
They prove only that fixture scope. Real recovery through integration and
`playwright.local.config.ts`, or other real-backend browser selections, need the
owned working stack. Inspect intended daemon/project/port ownership before setup.

The tiered plan critique and the one OpenAI GPT-6.1 Sol code review (leaner process
above), all required exact-head CI jobs, coordinator visual review of UI
captures and normal merge protections remain mandatory. Builders run the local
subset listed above; the full suites run in CI. Unavailable review is not a pass.
Phase 0 remains **engineering complete; acceptance open**; only the second
hosted-account journey was deferred, not other operator/device/human checks.
Paid activation, private-input processing, hosted mutations and deployment retain
separate approval. Source writers receive no hosted credentials;
`ALLOW_HOSTED_SMOKE` remains unset in implementation sessions. The dated hosted
actor evidence below is preserved. The rollout subsection dated 23–24 September
2026 is coordinator-recorded evidence, not a fresh observation by any writer.

## Prepared environment

**Historical cloud setup contract, superseded for coding allocation on
11 September 2026.** The technical requirements below remain evidence, not local
capability proof, a local entry protocol or permission to start another cloud
session. Current local entry and tooling requirements are above.

`.github/workflows/copilot-setup-steps.yml` contains the required single
`copilot-setup-steps` job on a standard Ubuntu runner. It installs pinned Node 24,
locked npm dependencies, Chromium and WebKit, then starts disposable local
Supabase, applies the committed migrations and provisions fictional accounts.
`npm run db:types -- --setup-artifact` generates real database types only at
ignored `.supabase/generated-database.types.ts`. Docker images are downloaded
during setup, before the agent's normal network restrictions take effect.

No production Supabase access, paid AI endpoint, larger runner, firewall
disablement or user-supplied production secret is required by cloud setup.
The separately approved hosted project is in Stockholm (`eu-north-1`).

Setup failures are not passes: Copilot may still start in a partially prepared
environment. First inspect its setup log, `git status` and diff; preserve any
unexpected source delta and stop. Confirm service status and actual browser
executable availability before choosing tests; do not run a known missing-engine
matrix or reinstall ad hoc. Initial setup may still use the old default workflow.
Do not reset a useful in-progress fixture unless recovery requires it.
Keep the 45-minute timeout and observe the first actual modified setup runtime.
Linux WebKit is not native macOS or physical iPhone acceptance, and Chromium
iPhone emulation is not Safari.

Setup's fixed `PARITY: MATCH` / `PARITY: DIFFERENT` signal is informational;
read/generation/write errors fail. The artifact proves generation, not tracked
parity. End-of-setup artifact/ignored-path and quiet tracked/staged cleanliness
assertions are early warnings, not a substitute for the worker's own entry checks
and matching runtime receipt. Database CI still generates tracked
`src/data/database.types.ts` and requires zero diff. Never commit the setup
artifact, `.env.local`, service/browser state, test results or logs. The test
wrapper passes ordinary fictional credentials to its child processes and strips
privileged/GitHub credentials. Under the historical cloud policy, after this
workflow reached default, later native allocations required a compatible script
branch, with no silent fallback or automatic rebase of an older branch. That
compatibility contract authorizes no new allocation under the local-only policy.

## Task scope and historical evidence

Historical packet restrictions below do not veto a separately approved next packet.
For each local packet, the controlling scope is the specific coordinator-approved
packet and plan supplied in its authorized kickoff (tiered as in the leaner
process above); the coordinator's approval is the edit permission. Native
receipts and cloud setup/intake requirements below are dated evidence, not
local entry proof.
Dated in-tree packet names and receipts are historical evidence, not permanent
task pins or approval for another assignment. A later separately approved packet
can supersede that dated assignment without editing these instructions again.
Arbitrary newer comments, untrusted authors, memory notes or stale receipts do
not grant scope. All prerequisite, review, model and execution gates still apply;
this rule does not override higher-priority or actual session authorization.
If authorization conflicts, stop and have the coordinator/operator reconcile it
rather than seeking a workaround.

As a dated 8 September 2026 handoff example, the
[reviewed I07 plan 5581494572](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5581494572)
defines phone image preparation/crop work after I06. That example is not a new
permanent I07/PR pin; a future task needs its own authorized reviewed packet.

Local implementation and repair sessions have a deliberate **text-only**
model-input boundary: no image/binary/archive opening, image-returning tools,
image attachments, encoded image output or Markdown image embeds. Only the
packet's reviewed Node/Playwright capture contract may generate bounded synthetic
files, with buffers ignored and functional assertions retained. The designated
coordinator's actual approved-artifact visual review remains mandatory and
separate. This coding-agent restriction is not an application AI-consent rule.
The historical native rule required preserving the head and reporting a platform
blocker if the same file-download failure recurred without image inputs. Its
cause is not inferred resolved by local execution; no cloud retry is authorized.

<a id="active-cloud-task-i06-personal-settings-on-pr-7"></a>

## Historical I06 personal settings on PR #7

On 8 September 2026 the user authorized **continuing through the agreed MVP in
order**. At I06's starting main `7f6e13a89603492e933748b6558b493d3d74e855`,
Phase 0 was **engineering complete; acceptance open**. Only the second
hosted-account test was explicitly deferred; other operator/device/screen-reader
checks remain pending, not waived. Bring back a manual gate when it genuinely
blocks a feature. I06 merged as `6caf1b0b3dde369d85941688c7c32d5664ffce0b`;
[final review 5138563467](https://github.com/drrowdev/stillroom-wardrobe/pull/7#pullrequestreview-5138563467)
records its engineering evidence, not full hosted or human acceptance.

The I06 writer finished saved work on PR #7,
`copilot/copilotphase1-personal-settings`, starting
`54252d79852301a0b7cd20977699bfd6fe01da86`.
[Full plan 5579471741](https://github.com/drrowdev/stillroom-wardrobe/pull/6#issuecomment-5579471741)
records actual **Anthropic / Claude Opus 5** reviewer
`personal-settings-plan-critique`, coordinator approval and the original 22 paths.
Corrections require shared profile/language version serialization, owner/epoch
freshness, retained dirty baselines, one owner read after a null PATCH, accessible
dirty routing and real normal-owner evidence. SQL allows owner INSERT and
server-controls versions; tests must not invent a denial. Style tags are private
text, not a new fixed taxonomy. I06 covers R02/R25/R27 and preserves R01/R11/R26.

[Transport amendment 5579906237](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5579906237)
records actual **Anthropic / Claude Opus 5** `i06-visual-transport-critique` and
coordinator approval before edits. It added only `.github/workflows/ci.yml`'s App
artifact step to I06's allowlist. That continuation authorized no new plan,
branch, PR, agent, schema, dependency, local CLI, JPEG, garment Save, recovery,
provider, hosted operation or I07/I29 work. One writer owned its workspace/branch/PR;
these are that completed packet's boundaries, not a later packet's assignment.

After context and before continuation edits, the writer reread
[receipt 5579937425](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5579937425):
coordinator explicitly selected and authenticated-GET verified actual
`sweagent-capi:gpt-6-astra`, task `210fb893-7617-4dc1-88ef-eae5272e2ab6`,
session `c40a8a6b-551d-4831-8703-691b138c980a`, observed
`2026-09-08T05:47:29.6473139Z`, against this exact PR/base/saved head.
This is the coordinator's runtime evidence, not a worker self-attestation or a
receipt reusable by another task. Historical native tasks/retries needed their
own matching receipt; current local entry uses the model-check contract above.

### Text-only worker and retained visual gate

The two preceding I06 native sessions reported `CAPIError: 400 Error while downloading
file. Upstream status code: 404`; the latest followed viewing a temporary PNG.
The missing upstream URL and causal app-code involvement remain unknown.
I06's single approved alternative kept Astra and excluded all native model image
inputs. That standing native implementation/repair restriction is preserved as
history, not a lapsed I06-only rule; current local policy deliberately retains
the text-only boundary. The native stop rule was to preserve the head and report
a platform blocker on the same failure without image input, not spawn retries.

Existing Node/Playwright tests provide text-only functional/DOM/axe results.
One deterministic synthetic settings flow asserts the loopback protected route,
known fake owner/language and absence of login/password UI, then scans visible
body text and rendered form values in-page for credential-like patterns, returning
only a boolean. Only Chromium writes these full-page captures, ignoring returned
buffers; functional assertions still run in every configured project:

* `test-results/i06-visual/profile-en-desktop.png`: English, 1280px.
* `test-results/i06-visual/profile-fi-mobile.png`: Finnish, 320px.

The test requires exactly two regular PNG files, correct headers/widths and at
most 1 MiB each. No real sessions, photos, wardrobe content, browser storage,
raw headers or offending text enter evidence. Files stay ignored and unopened
by the worker. After a successful **full** browser run, the single non-matrix App
job uploads only those explicit paths using the already pinned upload action,
name `i06-profile-ui-<exact PR head SHA>` (current commit for non-PR events),
one-day retention and missing-file failure. No wildcard, extra permission/cache,
runner, service or Database/Apple job change. Storage is bounded, not guaranteed free.

I06 required coordinator workflow/executable trust review before current-head
CI authorization and independent review, then actual inspection of both verified
artifact PNGs outside the repository. Run/head/PNG SHA256s/verdict were recorded
in PR #7 reviews/comments and the session ledger, including final review
5138563467. That is completed I06 evidence, not a pass for a later task.
The standing visual gate still rejects artifact existence or DOM checks as a
substitute for actual review; absent/unread required images remain pending.
Preserve the primary test failure rather than relabelling it an artifact failure.
No source commit merely records its own head. [Phase 1 results](phase-1-result.md)
preserve worker commands, rollback and dated pending gates; final I06 evidence
is linked from PR #7.

<a id="active-cloud-task-approved-phase-0-password-recovery-on-pr-3"></a>

## Historical approved Phase 0 password recovery on PR #3

The separately approved follow-up is PR #3,
`copilot/approved-phase0-password-recovery`, based on merged main
`20ec93041f1d90d9a9f684b7358ea2b9715527e1`. This continuation started at
`56102303d84b20d53c2b15f024330f434d4e154e`. It implements only the Phase 0
Auth unblocker (I03/I05; R01/R11/R17/R19/R22/R26/R27), not Phase 1, backup
restoration, hosted setup or deployment.

[Full plan 5561361106](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5561361106)
and [controlling approval 5561846573](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5561846573)
record actual two-turn **Anthropic Claude Opus 5** read-only prereview and
precision corrections before Auth edits, including the user-approved raw
24-character floor and recovered-owner global sign-out. The coordinator's
[current-session receipt 5562454517](https://github.com/drrowdev/stillroom-wardrobe/pull/3#issuecomment-5562454517)
records native `sweagent-capi:gpt-6-astra`, task
`7323967d-08f3-4082-b964-6c7d129beeeb`, session
`6bb9e497-8cd7-4f2a-acb0-29fc716cba62`, observed
`2026-09-06T21:56:57.7963482Z`, against that exact base/head. It is not a
self-attestation or evidence for another session.

[Amendment 5562318484](https://github.com/drrowdev/stillroom-wardrobe/pull/3#issuecomment-5562318484)
was actually critiqued by Anthropic Claude Opus 5 before the config-only
`56102303` commit. It only enables local Inbucket on explicit port 54324.
[Cold gate 5562445077](https://github.com/drrowdev/stillroom-wardrobe/pull/3#issuecomment-5562445077)
records CI `34061709323` attempt 2, both jobs successful. This proves cold
baseline readiness, not mail/recovery/UI. The earlier warm-restart REST/DB 503
cause remains unproven; no firewall/image diagnosis is inferred. This session
used the prepared services without restart, reset, config changes or repair.

Normal sessionStorage/PKCE remains unchanged. Recovery uses the existing SDK
with isolated memory-only implicit Auth and an actual Auth/profile fetch guard;
no refresh grant, private wardrobe request, automatic login or normal Auth
broadcast is allowed. Links are scrubbed before Auth/render. Nonempty normal
storage or already-started normal Auth refuses a callback before target lookup;
late callbacks cannot replace an in-flight/active owner. Cancellation only
aborts/clears memory, while a transmitted password update has an explicitly
uncertain outcome. Confirmed updates clear the fields and request isolated
global logout for the recovered owner; HTTP affirmation is required and existing
access JWTs may last until expiry.

See [real local protocol/UI proof and cleanup](local-backend.md#real-local-password-recovery)
and [dated validation](phase-0-result.md#pr-3-password-recovery-continuation).
No hosted email/Auth/password call, credentials, account repair, new provider,
SMTP, paid AI, schema/guard weakening, merge or deployment occurs here.
The coordinator alone inspects/authorizes fresh-head `action_required` CI;
independent final review, required automated gates and separate release/merge
authorization remain external gates. This worker never approves, reruns,
merges or deploys. The dated hosted actor table below remains unchanged.

## Historical approved Phase 0 hosted-readiness packet on PR #2

Updated 6 September 2026: PR #1 was merged with the user's approval at
`f696ee45e5dfe46be90cbc295a9811ec1d34a298`. The user subsequently requested
autonomous continuation toward the complete app and authorized the dedicated
Stockholm backend. Comment `5559949209` approved the completed source packet
after actual Anthropic Claude Opus 5 critique. That assignment, dated
6 September 2026, was only the five-document handoff amendment on PR #2,
`copilot/phase0-hosted-backend-deployment`, following
[plan 5560449572](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560449572)
and [approval 5560847183](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560847183).
The latter records actual read-only Anthropic Claude Opus 5 critique and controlling
amendments. This dated assignment does not pin separately approved future work to PR #2.

The coordinator installed the exact reviewed base SQL in the approved project;
comment `5559976584` records the migration/hash and structural observations.
The cloud agent does not receive hosted credentials or run hosted writes.
Installed structure, coordinator-observed static shell and the dated user-dashboard/
administrative account snapshot below are distinct evidence. Ordinary password
login, own Save/reload, negative RLS/Storage, fixtures, live hosted smoke and
physical-device acceptance remain open.
That historical packet authorized no paid app AI, later phase or merge. Cloudflare access is
connected to the coordinator, not inherited by the cloud worker.

### Hosted state and responsible actors

Installation and setup facts come from comments
[`5559976584`](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5559976584)
and [`5560093343`](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560093343);
the dated updates below identify their later evidence. These are not hosted
operations or independently observed cloud-worker results. The dedicated
**AI Wardrobe** project is `xwrdrugastphdiihzuia`,
organization `murdxzxflzlbyrnpwbqg`, Stockholm `eu-north-1`.

The coordinator applied `supabase/migrations/20260905000000_initial.sql`
**once**, after fresh empty-target/privilege/hash checks, through the private
SupabaseProton connection. Exact source: **35214 bytes**, SHA-256
`4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5`.
Stored remote SQL matches, but the remote migration is
`20260906144202_initial_wardrobe`, not source version `20260905000000`.
**Do not run hosted `db push`, replay, reset or automatic history repair.**
Any future CLI history reconciliation needs a separately reviewed operator step.

Structural checks reported 12 RLS-enabled application tables; private
JPEG-only `wardrobe` bucket with 512000-byte limit; three owner Storage
INSERT/SELECT/DELETE policies and no UPDATE; three Auth admission/email
triggers; zero admissions and zero Auth users at installation. Advisors reported
two informational deny-all private tables and four authenticated checked
SECURITY DEFINER image/restore warnings. Preserve these observations; do not
broaden permissions to silence them. Administrator structural/advisor checks
are **not ordinary-session hosted RLS proof**.

**Coordinator live-shell observation, 6 September 2026:**
[review 5125863611](https://github.com/drrowdev/stillroom-wardrobe/pull/2#pullrequestreview-5125863611)
records successful deployment `91462a90-2f8c-40bf-a828-6a800ce19f33` of reviewed
main `f696ee45e5dfe46be90cbc295a9811ec1d34a298`, not PR #2. At
`2026-09-06T15:09:25Z`, root, JavaScript, CSS and SPA fallback at
`https://stillroom-wardrobe.pages.dev` returned HTTP 200; the main JS contained
the approved Supabase URL, and CSP, no-referrer and nosniff were observed.
The coordinator's later read confirmed the same successful deployment, automatic
production OFF/previews NONE. This proves only that deployment's reachable static
shell, not Auth settings or working login/Save/RLS. A replacement needs fresh
evidence. The worker's earlier queued observation remains history; no cloud-worker
hosted check occurred.

**Dashboard/provisioning snapshot, 6 September 2026:**
[approval 5560847183](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560847183)
records the user's dashboard confirmation: public signup OFF, anonymous sign-in
OFF, Email enabled, Phone/all social providers disabled, and Site URL plus sole
Redirect URL `https://stillroom-wardrobe.pages.dev`. The user privately reserved
the intended emails and created both accounts through Auth Create User.
Coordinator aggregate administrative reads observed **2 reserved, 2 bound/enabled,
2 Auth users, 2 email-confirmed users, 2 profiles and 2 preference records**.
No private email, UID or password was supplied to the coordinator/cloud.
This is a dated snapshot, not live counters or API verification of every Auth
setting. Administrative confirmation is not email-delivery evidence; counts
prove neither ordinary login nor RLS/Storage isolation.

#### Hosted rollouts since 23 September 2026

Coordinator-recorded evidence. Each item cites its source comment; nothing here
is a fresh observation by a writer.

**Current hosted evidence, 7 October 2026 (R5/D20).** The owner separately
[approved publication](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6043088015)
of `e0399184f1351c4c39b990a1c61c1940437d2c79`, then reported success at
17:24:36 UTC: Pages deployment `8786abdf-d020-45a9-b0d2-8962efc6ecb3`.
The [D20 readback](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6043247098)
verifies that exact app version, all 17 referenced entry/catalogue assets,
EN/FI/SV startup catalogues byte-equal to C, reviewed headers/cache policy
and both approved model/runtime binaries. R5 batches ADM2 #172, MODEL1 #173,
OUTFIT1 #174 and test-only regression/diagnostic coverage #175.
The [clean exact-C engineering receipt](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6042149672)
records CI 37648354775 and Apple 37648452447, attempt 1 SUCCESS;
Documentation checks intentionally skipped. Browser accessibility coverage
is not a physical screen-reader check. The earlier candidate's failures remain
unexplained, not fixed or waived. Main is unfrozen; docs-only reconciliation
does not replace the deployed `e0399184` app or need another Pages deployment.

OUTFIT1 was separately
[owner-approved and installed](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6039023712)
from merge `eedc4d00`, bringing the hosted ledger to 30:

| Source migration | Hosted version | Evidence |
|---|---|---|
| `20261007090000_outfit_lifecycle.sql` | `20261007132943_outfit_lifecycle` | 7 Oct: stored migration and both function bodies match Git; authenticated-only EXECUTE, security definer, empty search path and two-second lock timeout verified. Structural checks only, no private rows or hosted lifecycle RPC smoke. |

The [R5-only approved Edge source-equivalence method](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6039970161)
used actual GETs of seven deployed packages (49/49 source files match),
each function's own import closure/map/deno configuration and JWT flag,
against its recorded F3/F2/F5/F8 baseline. Test-only C preserves the full
functions/images/domain/config trees from the verified `eedc4d00` candidate.
Live versions, bundles, JWT and maps were reread before/after publication:
analyze-clothing 18, finalize-analyzed-item 18, finalize-image-change 18,
delete-account 15, stylist-chat 16, enhance-photo 19, try-on 8;
all `verify_jwt=true`. No Edge redeploy occurred.
This proves source equivalence only, **not unchanged hosted settings**:
the owner is unsure of that history and it is not independently verified.
R3/R4's earlier "no Supabase diff" rationale did not meet literal whole-directory
release-checks step 6; the later R5-specific comparison does not retroactively
accept them or relax that rule globally.

See [the current ledger](release-gates.md) for D20, M14, F9/F10, R5 and K3.
Normal-owner OUTFIT1 checks, BULK2 five-photo/large-batch iPhone/laptop feedback,
BULK1 Undo, O1 signed-in/offline reopen, checklist 2-10 and R2-R4 acceptance
remain open. The owner reported shared allowance settings of 200 requests/h
and USD 50/month in the
[7 October handover](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6036228105);
these are not independently verified, and cleanup 60/h is unconfirmed.
Shared allowance settings do not connect the independent accounts or share data.
Existing activation, privacy/provider and F7/A8 gates are unchanged;
no authenticated Supabase/private-content request, provider call or activation
occurred for R5 publication. Parked PR #27 remains deferred; HEIC work remains
declined. The dated rollout observations below are retained as history, not
current status or full Phase 0/product acceptance.

**First hosted rollout, 23 September 2026.** Owner approvals:
[PR #32 `5794990408`](https://github.com/drrowdev/stillroom-wardrobe/pull/32#issuecomment-5794990408)
accepted possible loss of hosted test garments, photos and Save attempts, and a
short no-use window. That replaced the full database and Storage backup gate for
this rollout only; accounts and settings had to be preserved.
[PR #33 `5796499459`](https://github.com/drrowdev/stillroom-wardrobe/pull/33#issuecomment-5796499459)
approved annex R2 (M1–M10, critiqued read-only by OpenAI GPT-6 Astra) and the
Pages route, and accepted Edge Functions running outside the EU for this test
rollout only, with only the owner's test photos. The database and Storage stay in
Stockholm; that is not a general residency waiver. The
[execution receipt `5800183953`](https://github.com/drrowdev/stillroom-wardrobe/pull/33#issuecomment-5800183953)
records:

- Source: accepted main `9f6cee1f2f6ba4d7f9828d7b46cde63170ebc05e` (tree
  `dece8adf`), post-merge CI 35869516551 green.
- Window: the owner confirmed no app use. The baseline was taken at 14:33:13Z
  (database time), and a detection receipt at 15:30:37Z matched it. This is
  limited activity detection only.
- Database: role postgres, not superuser; the M3 capability preflight passed.
  Five migrations were added, giving an 11-row hosted ledger that day. Each body
  was MD5-checked before execution, each ledger row equals its Git blob MD5, and
  objects were read back after each migration. M1: the final
  `item_object_publication_guard` is AFTER I/U/D, tgtype 29, enabled `O` (after
  the intermediate `O`/21); `item_image_identity_guard` is `A`. The `wardrobe`
  bucket is still private, JPEG only, 512000 bytes, with three owner policies and
  no UPDATE policy. M2: no anon or PUBLIC EXECUTE on public functions, and
  service-role-only RPCs are not callable by authenticated users.
- Edge Functions: `analyze-clothing`, `finalize-analyzed-item` and
  `finalize-image-change`, v1 ACTIVE, `verify_jwt=true`, readback byte-identical
  to the Git blobs; `google-cloud.ts` was not uploaded. CORS preflight from the
  exact origin returns 204, a disallowed origin gets 403 with no ACAO, and an
  unauthenticated POST gets a gateway 401. At that point no provider secret
  existed and AI controls were 0.
- Pages: the owner ran one API production create-deployment, `6e01b747`, of
  commit `9f6cee1f`. Automatic production stayed OFF and previews NONE. The
  served JavaScript contains `9f6cee1f`, this project's URL and default
  publishable key; repository `scanText` found nothing in the 5 served assets.
  CSP `connect-src` allows only this project, and no-referrer and nosniff are
  set. Missing asset paths return the platform HTML fallback.
- Owner smoke test, 18:01Z, own account, normal session: sign in, add a photo
  and crop, AI unavailable → Continue manually, edit, Save, reload with thumbnail
  and full image, edit and save, replace photo, sign out and back in. All steps
  passed. Coordinator aggregate deltas are consistent: items 4→5, completed Save
  attempts 3→4, one completed replacement, objects 8→12, no orphans; accounts,
  approvals and preferences unchanged; AI requests 0.

At that point only the manual add/edit/Save/photo-replace journey was live. It
was not full product or Phase 0 acceptance, and it did not use the private
read-only smoke runner.

Source→hosted versions from the coordinator's 23 September 2026 ledger readback,
where every stored statement hash-matched its source blob (receipt `5800183953`):

| Source migration | Hosted version | Method |
|---|---|---|
| `20260905000000_initial.sql` | `20260906144202_initial_wardrobe` | applied once, 6 Sep (`5559976584`) |
| `20260906000000_item_field_provenance.sql` | `20260909062611_item_field_provenance` | installed before 20 Sep (six-row ledger) |
| `20260909070000_item_description_edit.sql` | `20260910060829_item_description_edit` | installed before 20 Sep (six-row ledger) |
| `20260909110000_item_optional_collections.sql` | `20260910060849_item_optional_collections` | installed before 20 Sep (six-row ledger) |
| `20260909180000_ai_request_controls.sql` | `20260910172705_ai_request_controls` | `apply_migration`, 10 Sep ([`5622788324`](https://github.com/drrowdev/stillroom-wardrobe/pull/17#issuecomment-5622788324)) |
| `20260910070000_checked_item_save.sql` | `20260910172928_checked_item_save` | `apply_migration`, 10 Sep (`5622788324`) |
| `20260911040000_ai_analysis_backend.sql` | `20260923143642_ai_analysis_backend` | `apply_migration`, 23 Sep; 24856 B, MD5 `70284cb6…` |
| `20260911200000_checked_ai_item_save.sql` | `20260923144008_checked_ai_item_save` | `apply_migration`, 23 Sep; 29668 B, MD5 `3eee343a…` |
| `20260913120000_item_lifecycle.sql` | `20260923144230_item_lifecycle` | `apply_migration`, 23 Sep; 20822 B, MD5 `878902fe…` |
| `20260921193000_azure_terra_analysis.sql` | `20260923144606_azure_terra_analysis` | `apply_migration`, 23 Sep; 29274 B, MD5 `49121b22…` |
| `20260922020000_checked_image_changes.sql` | `20260923150145_checked_image_changes` | **manual atomic ledger write, method M11**, 23 Sep; 82482 B, MD5 `2dee8119…` |

M11 was reviewed read-only by OpenAI GPT-6 Astra (AMEND C1–C5). The 82 KB body
went in 6 hash-verified chunks into a private scratch table. One atomic DO block
ran the exact body and inserted the ledger row with `created_by` null; this was
not an `apply_migration` call. The prior ten ledger rows were unchanged, and the
scratch table was dropped. Source and hosted versions differ for every row.
**Still do not run hosted `db push`, replay, reset or automatic history repair.**

**Pages deployments since then.** Each was one owner-run create-deployment of
production main HEAD, with automatic production OFF and previews NONE. Each
receipt records that the served JavaScript contains the commit, the project URL
and the publishable key, that `scanText` is clean on 5 assets, that CSP,
no-referrer and nosniff are unchanged, and no database or function change.
Owner review was pending in both receipts.

- `f0016398` of main `c3ce908a` (UX L1a), 24 September
  ([PR #34 `5808561122`](https://github.com/drrowdev/stillroom-wardrobe/pull/34#issuecomment-5808561122)).
- `27a1c642` of main `3ed08147` (UX L1b and L2a), 24 September
  ([PR #36 `5813432944`](https://github.com/drrowdev/stillroom-wardrobe/pull/36#issuecomment-5813432944)).
  This was the latest cited Pages deployment in that 24 September snapshot;
  current publication evidence is R5/D20 above.

**I16 weather CSP (source only, not deployed).** The I16
draft PR adds `https://geocoding-api.open-meteo.com` and
`https://api.open-meteo.com` to the generated CSP `connect-src` in
`vite.config.ts`. The historical CSP observations above stay as recorded.
Weather only works on the hosted site after the owner runs a Pages deploy of a
main that includes I16. No hosted schema, function or Auth change is needed:
the profile weather columns are in the installed base schema.

**P6a backup (source only, not deployed).** The P6a draft PR adds the Settings
Backup card and `scripts/verify-backup.mjs`. It uses the installed
`export_manifest` and `item_attribution_history` RPCs and authenticated Storage
downloads only: no schema, migration, Edge Function, CSP or Auth change, and no
hosted call from builders. The card appears on the hosted site only after the
owner runs a Pages deploy of a main that includes P6a. See
`docs/phase-6-result.md` for scope, deferrals and pending gates.

**P6b restore (source only, not deployed; hosted migration pending).** The
P6b draft PR adds the Settings Restore card and the additive migration
`20260925110000_restore_item_save.sql`: three new authenticated functions,
`reserve_restored_item_save`, `restore_image_change_status` and
`restore_item_save_status`, and no change to any existing object. The hosted apply of that migration waits for the
separately authorized responsible actor; builders make no hosted call. The
card needs both that migration and an owner-run Pages deploy of a main that
includes P6b. Restore never calls analysis. It is partial: attribution history
is not restored (Q5 is open) and Phase 6 is not accepted. See
`docs/phase-6-result.md`.

**P6c account deletion (source only; hosted activation owner-gated).** The P6c
draft PR adds the Settings Delete account card, the `delete-account` Edge
Function, `scripts/resume-deletion.mjs`, the serialized `deletion-rehearsal` CI
job and two migrations, `20260925120000_account_deletion.sql` (not additive:
it replaces `deletion_control` and the Storage publication guard and adds an
`auth.users` trigger) and `20260925120100_deletion_receipt_purge_schedule.sql`
(one inactive job). Nothing runs on hosted until the owner approves Q5, Q2,
the non-additive replacements and triggers, the Edge deploy, the schedule
activation and a disposable hosted drill. Builders make no hosted call. See
`docs/phase-6-result.md`.

**P6d tag-history restore (source only; hosted apply owner-gated).** The P6d
draft PR adds `20260927090000_restore_attribution.sql`. It is not additive: it
adds the imported-history table and three authenticated functions and replaces
P6c's `private.deletion_owner_rows_absent` with the same signature. It requires
P6c to be installed first. Nothing runs on hosted until the owner approves the
exact bodies; the responsible actor then applies it and reads back the bodies,
ACLs, owners and search paths. Builders make no hosted call. See
`docs/phase-6-result.md`.

**ST1a stylist chat backend (source only; inactive; hosted apply owner-gated).**
The ST1a draft PR adds `20260928090000_stylist_chat.sql`, the inactive job
`20260928090100_stylist_expire_schedule.sql` and a fourth Edge Function,
`stylist-chat`. It is behaviour-changing, not additive: stylist requests share
`private.ai_usage` with a `purpose` column, so tagging's unchanged admission
counts them. The stylist manifest and dispatch stay off, and no stylist
allowance is set. Nothing runs on hosted until the owner approves the bodies,
the Edge deploy, the job's activation, the allowance and consent notice, the
direct-call allocation and an exact-route synthetic probe. Builders make no
hosted or paid call. See ADR25 in `blueprint/18` and `blueprint/20`.

**BG2b-1 photo enhancement backend (source only; inactive; hosted apply owner-gated).**
Adds `20260929090000_photo_enhancement.sql`, the inactive job
`20260929090100_enhance_expire_schedule.sql` (`stillroom-enhance-expire`) and a
fifth Edge Function, `enhance-photo`, for the Global deployment
`eval-image25-sunburst-20260908` on `stillroom-ai-eval`. It is behaviour-changing
and non-additive: enhancement rows share `private.ai_usage`, and two triggers on
`public.item_images` run for every image writer. The provider kill switch starts
off (`INITIAL`), no sub-limit or manifest activation is set and no account is
activated. The function reads a new server-only secret, `AI_AZURE_IMAGE_API_KEY`,
intended to hold the resource's *other* key: it can be rotated independently of
tagging's `AI_AZURE_OPENAI_API_KEY`, but both keys have resource-wide scope (any
deployment on `stillroom-ai-eval`). Nothing runs on hosted until the owner
approves the bodies and the Edge deploy (rows M8, F4); the probe spend, the
sub-limit, the consent notice and activation are separate owner gates. Builders
make no hosted or paid call. See ADR26 in `blueprint/18` and `blueprint/20`.

**BG2b-2 photo enhancement client, W1 and probe branch (source only; inactive).**
The client (Add and Replace photo, Settings, the "Photo edited with AI" label,
v4 backups and restore) stays hidden and sends nothing until M8 is applied, F4 is
deployed and the account is activated and consented. The `enhance-photo`
source changes need the same separately approved Edge deploy as row F4: after
the claim, the one work promise that owns dispatch, settlement and cleanup is
registered with `EdgeRuntime.waitUntil` and awaited; if registration is not
available the request fails before the claim, and if it throws after the claim
the row settles `NOT_DISPATCHED` with no provider call. Delivery to a cancelled
client is suppressed, never the accounting.

The operator probe goes through the same deployed handler. It needs all of: the
verified owner JWT, `X-Stillroom-Probe-Authorisation` naming an unexpired,
unstopped `private.enhancement_probe_authorisations` row for that owner,
deployment and manifest (call and spend limits enforced in the database),
`X-Stillroom-Probe-Token` equal to the server-only secret `ENHANCE_PROBE_TOKEN`
(at least 32 random bytes, base64url, compared in constant time), and the
owner's ordinary enhancement switched off (`enhance_activated=false`). A request
with an `Origin` header is refused; CORS is not authentication. With no secret
configured, every probe request is refused before any RPC. Token lifecycle: the
coordinator generates it privately, sets it as a function secret only for the
approved probe window, passes it to `scripts/enhancement-probe.mjs` through the
environment (never a URL, log, bundle or file in the checkout) and deletes the
secret straight after. The script sends at most 6 paid calls: 5 visual samples
and 1 disconnect/accounting call (call 6 verifies the hosted disconnect
behaviour of row F4); it stops at the first non-`OK` result, uses
`redirect: 'error'`, bounds each response and prints no credential or image.

Read-only ledger check after the probe, keyed by the request IDs the script
reports (run by the coordinator in the SQL editor; it changes nothing):

```sql
select u.request_id, u.purpose, u.charge_state, u.reserved_micro, u.accounted_micro,
       u.dispatched_at is not null as dispatched, e.enhance_code, e.enhance_settlement_origin,
       e.enhance_probe_id, e.estimated_micro, e.anomaly, e.enhance_settlement_digest,
       e.provider_refusal, e.usage_absent
from private.ai_usage u
join private.ai_usage_evidence e using (owner_id, request_id)
where u.purpose = 'enhancement' and u.request_id = any($1::uuid[])
order by u.created_at;
```

Every row must be settled (none held), and the disconnect call's usage must be
recorded like the others.

**BG2c-1 "clean up photo" backend (source only; inactive; plan rev4, #84
c5876588292).** Adds `20261002090000_photo_cleanup_manifest.sql`: the manifest
`azure-global-image25-sunburst-cleanup-v1` (prompt version 2) on the same
deployment row as enhance-v1, so both share one capacity window and kill switch;
the constraint `ai_controls_cleanup_notice` (cleanup-v1 needs notice revision 2
or later, NULL refused); and `create or replace` of `enhance_claim` that differs
from M8 only in the accepted manifest literal, with its ACL re-issued. It updates
no row and never copies consent forward. `enhance-photo` now sends the clean-up
prompt and claims cleanup-v1; a v1 policy gets `UNCONFIGURED` before any call.
After the controls cutover, held v1 work is still accounted, but
`enhance_finish`/`enhance_replay` return `UNAVAILABLE` and record no result; a
settled slot stays counted until `held_until`. The client still sends H1 and
uses `compareEnhancement` until BG2c-2, so **`enhance-photo` is never deployed
from a commit with BG2c-1 but without BG2c-2**; routine Pages deploys stay safe.

Rollout order while inactive (plan rev4 §15): hosted apply with read-back
(rows, `pg_get_functiondef(enhance_claim)`, its ACL, the constraint, the expiry
cron); then set `enhance_manifest_id = cleanup-v1`, `enhance_notice_revision = 2`
with `enhance_activated = false` and read it back; the owner deploys
`enhance-photo` and Pages from the BG2c-2 merge commit, and the coordinator
checks the Edge status (cleanup-v1, notice 2, inactive) and the Pages build
identity and inactive behaviour (no review step, zero `enhance-photo` requests),
never activating to look. The USD 2 probe spend, sub-limit and probe
authorisation come after that, and activation is a separate owner decision.

Probe on cleanup-v1 (operator only). `scripts/cleanup-probe-harness.mjs`
(`ALLOW_CLEANUP_HARNESS=1`, clean checkout) builds `vite build --mode
operator-probe` into the ignored `<repo>/.probe-dist` only (no service worker,
precache manifest, app page or public files; checked by `checkOperatorTree`),
serves it on 127.0.0.1 and drives Chromium with every non-loopback request and
service workers blocked. `prepare <samples> <prepared>` reads `crops.json`
(5 visual, 1 disconnect) and writes H0, R (81 920 B) and a binding per sample
plus `samples.json`; `measure <prepared> <calls> <measured>` re-verifies each
binding against the same commit and model and runs the exact `cleanupCheck`.
Output folders must be outside the checkout. `scripts/enhancement-probe.mjs`
then needs `PROBE_SWITCH_ON_AT` (the kill-switch time, ISO UTC) and optionally
`PROBE_LAST_KEY_USE_AT`; it refuses an unverified or ambiguous binding, paces
each call at least 33 s after the previous dispatch and 66 s after the response
of the call two back (and 66 s after switch-on), stops on any non-`OK` result
including `RATE_LIMIT`, and reports evidence as pending until the visual metrics
and the disconnect settlement read-back exist. Wall time is read once, for the
switch-on and last-use wait; that wait and all spacing then run on the
monotonic clock. Evidence is complete only when each visual call has a
`measure` entry bound to its request ID, input, output, reference, commit and
model with every numeric metric its verdict reports, and the disconnect call
actually ended `DISCONNECTED` (a reply before the disconnect leaves F4 pending)
with its own row read back as dispatched, `estimated`, origin `observed`, no
anomaly, an accounted amount and the settlement digest. `checkStaticTree` refuses any
`probe/` path or harness marker, so the harness can't reach a deploy tree.

**VTO-1 virtual try-on backend (source only; inactive; hosted apply owner-gated).**
Adds `20261003090000_try_on.sql` and the job
`20261003090100_tryon_expire_schedule.sql` (`stillroom-tryon-expire`, every 15
minutes, active on install: it only expires and deletes). They follow AD1 and
BG2c-1's `20261002090000_photo_cleanup_manifest.sql`, and are applied after it
when the owner approves the apply (G4). It is
behaviour-changing and non-additive: try-on rows share `private.ai_usage`
(`purpose='try_on'`), the enhancement settlement columns, the deployment
`eval-image25-sunburst-20260908` and its kill switch `enhance_provider_control`,
so an anomaly in either feature stops both. The admin v1 write now refuses a
shared total below a configured try-on sub-limit (`CONFLICT`); the admin v2
RPCs add try-on. VTO-1b adds the sixth Edge Function, `try-on`, reading
`AI_AZURE_IMAGE_API_KEY` and, only during the probe window, `TRYON_PROBE_TOKEN`
(the same lifecycle as `ENHANCE_PROBE_TOKEN`). Nothing is set up for an account
until the bootstrap below, and nothing is activated until G9. See ADR28 in
`blueprint/18`, `blueprint/08` and `blueprint/20`; the gates are in the VTO
plan §11. Builders make no hosted or paid call.

Bootstrap receipt (G7b; database owner in the SQL editor; after G7). Read the
five fields before and after; the call refuses any account already set up with
different values (`CONFLICT`) and never sets activation or consent:

```sql
select tryon_manifest_id, tryon_notice_revision, tryon_max_request_micro,
       tryon_monthly_allowance_micro, tryon_max_requests_per_hour,
       tryon_activated, tryon_consent_revision
from private.ai_controls c join private.approved_accounts a on a.user_id = c.owner_id
where a.admission_no = 1;

select public.tryon_bootstrap(
  (select user_id from private.approved_accounts where admission_no = 1 and enabled),
  'azure-global-image25-sunburst-tryon-v1', 1, 360000, 5000000, 6);
```

Read-only try-on ledger check after the probe (G8), keyed by the request IDs
the script reports; it changes nothing:

```sql
select u.request_id, u.charge_state, u.reserved_micro, u.accounted_micro,
       u.closed_reason, u.dispatched_at is not null as dispatched, e.enhance_code,
       e.enhance_settlement_origin, e.tryon_probe_id,
       e.tryon_dispatch_authorised_at is not null as authorised,
       e.tryon_fetch_started, e.tryon_client_live_at_fetch,
       e.tryon_client_gone_at_finish, e.tryon_settled_at, e.anomaly,
       e.provider_refusal, e.usage_absent
from private.ai_usage u
join private.ai_usage_evidence e using (owner_id, request_id)
where u.purpose = 'try_on' and u.request_id = any($1::uuid[])
order by u.created_at;
```

Every row must be settled. Call 4 passes only with `authorised`,
`tryon_fetch_started`, `tryon_client_live_at_fetch` and
`tryon_client_gone_at_finish` all true, the settlement origin `observed` and
`closed_reason` not `EXPIRED` (a finish that arrives after the provisional
expiry records its usage but keeps `EXPIRED`, which is not a pass); anything
else leaves acceptance incomplete, with no replacement call.

The five calls fit the five-call authorisation only in this outfit order, because
a new chain is refused as `PROBE_LIMIT` unless all of its steps fit the calls
left: P1 (top, bottoms, shoes) for calls 1–3, P3 (one ordinary garment alone)
for the call-4 disconnect test and P2 (the swimwear or form-fitting garment
alone) for call 5.

Probe corrections (VTO-3b, plan rev3 approved on #84). #117/#119 chose a
**single-item P3**; the 2-item P3 used on 30 September was a setup deviation, not
the plan (G8 c5906603780). The script treats P3 as settled only when the
owner's own `tryon_chain_status` reads `OK` with no active attempt (for both
states) and either `running` with `nextStep` 2 (the one step was accepted and
the chain waits) or `complete` with a result ID. A failure, an unreadable
status, a timeout or an unchanged step leaves call 4 incomplete. Before P2 it
must confirm the state it saw: a waiting chain must answer `CANCELLED`; a
completed chain must answer `COMPLETED` with the same result ID, and that
picture's deletion must answer `OK`. Anything else stops with
`P3_TIDY_UNCONFIRMED`. It never sends P3's next step.

P2-only continuation (the missing filter challenge): run the script with
`PROBE_ONLY=P2`, `PROBE_OUTFIT_P2`, `PROBE_PERSON` and
`PROBE_DELETE_BY=2026-10-07`. It refuses any other `PROBE_ONLY` value (there is
no fallback to the full probe), `PROBE_OUTFIT_P1`, `PROBE_OUTFIT_P3` or
`PROBE_OUTPUT`, and any date other than the approved G7 deadline, which it
checks as a real calendar date in Europe/Helsinki; after 7 October (Helsinki
time) it refuses to run, and it checks the date again after each pacing wait
and after each status preflight, so no request is sent once 7 October has
ended (cleanup still runs). It sends one step, at most one paid call; only an
unpaid `RATE_LIMIT` or `BUSY` refused before a claim is tried again. Success is
`FILTERED`, or a final result (`last`, with a valid result ID) that the stop
reports as `COMPLETED` with the same ID and whose deletion answers `OK`. A
malformed `OK` or an intermediate picture is recorded as `OK_NOT_FINAL`,
cleaned up and left incomplete; no further step is sent. It prints `Delete by:
2026-10-07 (Europe/Helsinki)`. Coordinator and owner steps:

1. Keep the first authorisation (`7ec41277…`) stopped. As the database owner,
   create a new one for the one missing call:
   `select public.tryon_probe_authorise('<new id>', <owner>,
   'azure-global-image25-sunburst-tryon-v1', 1, 360000, '#84/tryon-probe-2',
   now() + interval '1 day');`. 360,000 micro-USD is a full reservation; with
   the 134,104 already used the probe stays within 494,104 of the 1,800,000 G7
   allocation.
2. Record the switch state, turn it on, set `TRYON_PROBE_TOKEN`, run the
   script, turn the switch back only if it is unchanged, stop the authorisation
   and unset the token.
3. Run the ledger check above for the one request ID and post the receipt on
   #84. The 7 October deletion deadline is unchanged.

Purge health (G10; in every hosted receipt and at least weekly while try-on is
activated): `select public.tryon_purge_health();` must return zero counts, and
`select status, start_time from cron.job_run_details where jobid = (select jobid
from cron.job where jobname = 'stillroom-tryon-expire') order by start_time desc
limit 3;` shows recent successful runs. While any result is more than 2 hours
past expiry or any try-on usage has been held for more than 10 minutes, new
try-ons are refused. Recovery: run `select public.tryon_expire_due(1000);` as the
database owner until the health counts are zero; if the job failed, fix it and
confirm its next run. The block lifts by itself; tell the owner about any
nonzero count.

**VTO-3a Stop before claim (source only; hosted apply owner-gated as ledger 28).**
Adds `20261004090000_tryon_stop_before_claim.sql`, applied after the VTO-1 pair
(ledger 26 and 27). Stop now works before the server has seen the chain: when
the owner has no chain with that ID, `tryon_cancel` records a private stop
marker in `private.tryon_chain_stops` and answers `CANCELLED`, and a later
step-1 `tryon_claim` of that ID is refused as `CANCELLED` with no chain, usage,
evidence or result. At most 60 new markers per owner per hour (`UNAVAILABLE`
beyond that; the client then does not report stopped). `tryon_expire_due`
deletes markers after one day (`stopsPurged`), `tryon_discard_transient` deletes
them all (`stopsDeleted`), account deletion removes them and they are never
exported. Not additive: cancel of a missing or foreign chain answers
`CANCELLED` instead of `NOT_FOUND`, so the client's Stop is deployed with it.
Try-on activation (G9) stays held until this is applied, deployed and its gates
pass (release-gates row M12).

**TRYON-IDEA1 try on an unsaved Today idea (source only; hosted apply, Edge and Pages deploys owner-gated).**
Adds `20261011090000_tryon_idea.sql`: the Today idea card can try its garments on directly, without saving an outfit
first. `private.tryon_chains` and `private.tryon_results` allow a null `outfit_id` (the composite owner keys skip a null),
chains gain `idea_item_ids` as the idea's immutable request identity, `tryon_claim` gains one trailing defaulted argument
`p_item_ids uuid[]` (dropped with `RESTRICT`; service role only) and `tryon_results_v1` / `tryon_result_image_v1` also answer
for results that have no outfit. The `try-on` Edge function accepts exactly one of `outfitId` or `itemIds` on step 1.
Garments are the owner's own items only (a foreign id answers `NOT_FOUND`); layers, outerwear and accessories are not
tried on. An idea's picture belongs to no outfit: it expires after 7 days, can be deleted by the owner, is listed under
Today's Try-ons and counts toward the 20-result cap. A result without an outfit is returned by `tryon_results_v1` and
`tryon_result_image_v1` only to a request that sends `X-Stillroom-TryOn-Results-Contract: 2` (the app's results reads send
it); without the header an older cached client sees outfit results only and its strict parser keeps working. The owner's
delete by id needs no header, and listing, reading and deleting work while try-on is off or paused. Deploy in this order,
all before try-on activation: database, then the Edge function, then Pages. After applying the migration the operator
reloads the PostgREST schema cache (`notify pgrst, 'reload schema'`) and runs the old-shaped (eight-argument) and new-shaped
(nine-argument) non-dispatching claim checks with a random owner (both must answer `UNAVAILABLE` with no row) BEFORE the Edge
function is deployed. An older Edge (or a database without the migration) refuses an idea before any claim or charge, a cached
query that still names the old signature fails closed (function not found: nothing is claimed, held or charged), and outfit
try-on works in every combination. The BUDGET1 header contract 2 is unchanged. Generated types: `database.types.ts` changes by the one
`p_item_ids` argument and is taken byte for byte from the exact-head CI `database-types` artifact, never written by hand.
Try-on activation (G9) and the probe are unchanged separate owner gates.

**TRYON-PHOTO1 one saved reference photo (source only; hosted apply, Edge and Pages deploys owner-gated).**
Owner decision [#84 c6107168563](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6107168563) (11 October 2026):
the owner can keep ONE full-length photo of themselves so try-on starts from it. This is the single exception to "body photos are
never stored"; it is added only by an explicit Save photo on the try-on screen. Adds `20261011100000_tryon_person_photo.sql`:
`private.tryon_person_photos` (one row per owner, RLS, no grants, cascades with the profile; not Storage), four owner-callable
definer functions (`tryon_person_photo_status_v1`, `_get_v1`, `_put_v1`, `_delete_v1`), a trigger that deletes the photo in the
same statement unless the owner's consent revision and the configured notice revision are both set and equal (so an administrator
reset that clears both removes it too), and a structural JPEG admission (`put` accepts only the app's own 1024x1280 baseline
shape: validated quantisation and Huffman tables, consistent component and table references, no metadata, thumbnail, extra scan
or trailing byte). `put`
needs activation, consent AND the configured notice at revision 2 on the locked controls row; reading and removing need only an
approved owner, so Remove works while try-on is paused, withdrawn or unavailable. The migration moves every configured account's
notice revision 1 -> 2 and never writes consent, so each owner turns try-on on again; an unconfigured account stays unconfigured.
The provider path is unchanged: the app reads the photo through `get` and uploads it in the existing step-1 request, and the Edge
function never reads the table. The shared notice constant moves to 2 and the deployed `try-on` Edge function checks it for
equality, so it must be redeployed with the migration. Production try-on is inactive; every mismatch below fails closed and changes
no user's behaviour.

| Database notice | Installed Edge | Pages app | Result |
| --- | --- | --- | --- |
| 1 | 1 | 1 | today's behaviour |
| 2 | 1 | any | the Edge answers `UNCONFIGURED` for every step; a photo can still be saved only with consent 2 |
| 2 | 2 | 1 | the old app hides Turn on (policy 2 is not its notice); the Edge is fine |
| 1 | 2 | 2 | the new app hides Turn on and the Edge refuses; no photo can be saved (needs notice 2) |
| 2 | 2 | 2 | the full feature, after the owner consents to revision 2 |

Rollout, each its own owner-authorised receipt and all before activation: apply the migration (when no chain is running), then
deploy the `try-on` Edge function, then Pages; the owner then turns try-on on (consent 2). There is no database rollback.
Generated types: four new public function names, so `database.types.ts` is taken byte for byte from the exact-head CI
`database-types` artifact (CI uploads it before its expected parity failure), never written by hand. The photo is not exported
or restored and is not part of the app's own backups: after a restore the owner adds it again. A removed photo can remain in the
platform's encrypted database backups for up to 7 days (G3), as stated in the notice. Notice revision 2 (five new keys) is pinned
in `tests/unit/tryon-notice.test.ts`; revision 1, never shown, stays frozen there. Release-gates row TP1 tracks the pending hosted
steps.

**PHOTO2 manage the saved photo in Settings (source only; Pages deploy owner-gated).**
Settings > Profile has a "Photo of you" block: add, replace and remove the one saved reference photo without opening a try-on.
It reuses the try-on screen's choose, crop and encode flow (`useBodyPhotoPicker`) and the same four RPCs, with an explicit
Save photo; nothing is added to the database, the Edge function or the notice. The saved photo is fetched only when the owner
chooses Show photo, so opening Settings makes no new request. Add and Replace need try-on to be on (the server still decides);
otherwise the block offers a way to turn try-on on, and Remove stays available. The Try-on card keeps only a pointer to the block.

**TRYON-LIMITS1 six garments and kept results (source only; hosted apply, Edge and Pages deploys owner-gated).**
Owner direction of 1 November 2026 ("Keep the photos until I remove them using the app UI."). Adds
`20261101200000_tryon_limits.sql` after `20261101080000`, in one transaction.
- **Garments.** A try-on has up to six steps, one garment per call: top (or a one-piece), bottoms, layer, outerwear, shoes,
  one accessory, in that order (shoes stay last for outfits without the new kinds). A second layer, outerwear piece or accessory
  is listed as not included. The new manifest `azure-global-image25-sunburst-tryon-v2` (prompt version 2; its layer and outerwear
  wording was replaced by manifest v3, see TRYON-PROMPT1 below) adds the layer,
  outerwear and accessory prompts and states six steps; the four existing prompts, the parameters, the rates, the 360,000
  micro reservation, the deployment key and the 30-minute chain lifetime are unchanged, and the v1 row stays installed.
  A full chain takes about 4 to 5 minutes (one provider call of roughly 40 seconds per step, sequential, so the 2 requests
  per minute of the shared deployment is not the limit). The new-chain check requires the whole chain to fit the account's
  one monthly budget at the configured `tryon_max_request_micro` per step; each step then holds one reservation at a time.
  The quality of the three new prompts and of six chained edits is not verified by any test: it needs the owner's own try-on or
  an approved probe. `tryon_probe_authorise` and its table now allow up to six calls (they allowed five), so one probe can cover
  a full chain; `scripts/tryon-probe.mjs` is the archived G8 five-call probe against v1 and is not updated.
- **Results.** A saved picture stays until the owner deletes it in the app and never expires. `tryon_results.expires_at`
  is dropped; the maintenance job (`tryon_expire_due`) no longer deletes by age and still ends expired chains, settles stranded
  accounting and deletes reserved slots whose chain is gone; the new-chain safeguard looks only at stranded accounting. The cap is
  200 stored or reserved results per account (it was 20). **The migration deletes no result**: every ready result, including one
  already past its old 7-day mark that the purge had not removed yet, is kept. Withdrawal still ends running chains and leaves
  results; account deletion and an outfit's permanent deletion cascade as before (results are database rows, there are no Storage
  objects to clean). A result of a trashed outfit is hidden and still counts toward the cap until the outfit is restored or purged.
  200 pictures of at most 512,000 bytes are at most about 100 MB of database space plus backups; typical pictures are far smaller.
- **Notice revision 3.** The consent notice no longer says "7 days" for the picture; revisions 1 and 2 stay frozen in
  `tests/unit/tryon-notice.test.ts` and revision 3 is pinned there. The migration moves configured accounts to the v2 manifest and
  notice 3 and never writes consent, so the owner turns try-on on again. **The saved reference photo is cleared at the notice
  change**: the existing guard deletes it whenever consent no longer equals the configured notice, so the owner saves it again after
  consenting to revision 3 (`tryon_person_photo_put_v1` accepts a notice at revision 2 or later with consent equal to it). There is
  no carve-out.
- **Wire contract.** `tryon_status` reports `maxSteps: 6`, `maxResults: 200` and no `resultDays`; the result list and the final
  step reply carry no `expiresAtMs` (a chain's own 30-minute `expiresAtMs` stays). The result-list reader's bounded response
  allowance is raised to 131,072 bytes (200 results of six items measure about 80 KB).

| Database | Edge `try-on` | Pages app | Result |
| --- | --- | --- | --- |
| old | old | old | today's behaviour |
| new | old | any | the old Edge answers `UNCONFIGURED` (it pins notice 2 and manifest v1); nothing is claimed or charged |
| old | new | any | the new Edge answers `UNCONFIGURED` (policy shows notice 2); nothing is claimed or charged |
| new | new | old | the old app cannot parse the status, so try-on shows as unavailable and Turn on is hidden; a tab opened before the deploy shows the same until it is reloaded |
| old | any | new | the new app cannot parse the status (the retired `resultDays` key), so try-on shows as unavailable |
| new | new | new | the full feature, after the owner consents to revision 3 |

Cached-client recovery: reload the app (or close and reopen the installed one) to get the new version; no data is lost and nothing
is charged while the status cannot be read. Rollout, each its own owner-authorised receipt: **drain first** (no running chain:
`tryon_purge_health()` shows `heldUsage: 0` and no running chain exists; a step already on its way settles by its own evidence, but
its next step is refused after the cutover and the owner starts again), apply the migration, deploy the `try-on` Edge function,
then Pages, back to back; the owner then turns try-on on (consent 3) and saves the reference photo again. There is no database
rollback; if the Edge deploy or Pages is delayed the feature stays unavailable (fail closed), and the fix is to finish the deploys.
Generated types are unchanged (no public function name or signature changed). Release-gates ledger rows follow the coordinator's
merge note.

**TRYON-PROMPT1 coats and jackets are shown open (source only; hosted apply, Edge and Pages deploys owner-gated).**
Owner trial of 2 November 2026 (four garments): with outerwear selected the coat came out closed, so the top underneath was not visible.
Cause: the v2 outerwear prompt asks for the garment "as the outermost layer, over the clothing they already wear" and to keep its
"length and shape", and the model copies the closed coat from the garment photo. Owner decision: show coats and jackets open or
unfastened by default when they have a front opening, so the clothing underneath stays visible. Adds
`20261102090000_tryon_prompt_v3.sql` after `20261101200000`, in one transaction, and the immutable manifest
`azure-global-image25-sunburst-tryon-v3` (prompt version 3).
- **What changes.** Only the `layer` and `outerwear` prompt wording (fixed English words, no item or user text; the exact text is
  pinned in `tests/unit/tryon-chain.test.ts`): an outerwear garment is worn "as the outermost layer over their existing clothing", a
  layer "over their existing clothing"; a garment with an existing front opening is worn fully unfastened with its front panels
  naturally parted, keeping the existing underlying clothing visible through the opening; no top or other clothing is invented and
  nothing hidden by another closed layer is revealed; a garment without a front opening is worn naturally without creating one;
  the garment's colour, pattern, logos, length, cut and design are preserved, allowing only the fastening and drape changes needed to
  wear it open.
  The other five prompts are byte for byte as in v2. The model, deployment key, request
  parameters (same hash), rates, limits, 360,000 micro reservation, six steps, result handling and **notice revision 3** are
  unchanged, so nobody consents again. v1 and v2 stay installed and unchanged; v2 is pinned from `tests/fixtures/tryon-v2-frozen.ts`.
- **Database.** The migration inserts the v3 manifest and its deployment row (same key), moves configured accounts' `tryon_manifest_id`
  v2 -> v3 and replaces only `tryon_claim` and `tryon_bootstrap` (the only latest definitions that name the manifest; the one literal
  changes, proven line by line and byte for byte in `tests/unit/tryon-prompt-schema.test.ts`). Every other try-on function compares
  with the account's configured manifest. Consent, the notice revision, results, chains and the saved reference photo are not written;
  the photo guard runs only when consent no longer equals the notice, so **the saved reference photo stays**.
  **Admission barrier.** First, in one fixed order held to the commit and under a 5-second `lock_timeout`, the migration takes
  `private.ai_controls`, then `private.tryon_chains`, then `private.ai_usage` in `exclusive` mode (reads continue). That mode conflicts
  with the row locks every claim, finish, bootstrap and status read takes with `select ... for update`, so a function that already
  holds a controls row finishes first (and is then seen by the check), and a claim that starts afterwards fails its `nowait` lock and
  returns BUSY without writing. Only then does it check that no chain is running and no try-on charge is reserved or held, and refuse
  (drain first) otherwise, before it inserts v3 or moves any account. The order matches the hosted install (the wrapper's ledger lock
  first, then these) and the scheduled purge and expiry jobs only wait. Afterwards it checks that v3 is on the shared deployment key,
  no account is left on v2, no consent changed, the v2 row is unchanged and both replaced functions equal the installed bodies except
  for the manifest literal. `tests/integration/tryon-prompt.sessions.mjs` runs the migration in the hosted-style `execute` wrapper
  (rolled back): a running chain and a held charge each refuse it with nothing changed, an executing v2 bootstrap finishes first and is
  moved to v3, and a v2 claim during the migration's locks gets BUSY. A function call that *begins* inside the lock window runs the
  old body (PostgreSQL does not see uncommitted function changes); that matters only for `tryon_bootstrap`, an operator-only call used
  for new accounts. **No bootstrap may run during the apply window**, and the cutover is done with the app and the operator tools
  idle. The residual is accepted without a constraint or trigger (no new permanent schema surface); the after-install check in the
  rollout below detects it.
- **Wire contract.** Unchanged (`tryon_status` keys, results, step replies). Only the manifest id the Edge function and the app require
  moved to v3.

The two refusals differ. **Ingress `CONFIG_CHANGED`** (HTTP 503): the request's `manifestId` differs from the Edge version's own; it
is returned before authentication and before the status read. **Preflight `UNCONFIGURED`**: the request matches the Edge version, but
the database policy shows a different manifest (or notice). Neither claims or charges anything.

| Database | Edge `try-on` | Pages app | Result |
| --- | --- | --- | --- |
| v2 | v2 | v2 | today's behaviour |
| v3 | v2 | v2 or v3 | an app that reads the v3 status does not offer Try on; a request naming v3 meets the old Edge: ingress `CONFIG_CHANGED`; a request naming v2 (an app that cached the old status) meets a database showing v3: preflight `UNCONFIGURED`. Nothing is claimed or charged |
| v2 | v3 | v2 | the old app reads v2 and sends a v2 request: ingress `CONFIG_CHANGED` at the new Edge; nothing is claimed or charged |
| v2 | v3 | v3 | the new app does not accept the v2 status, so Try on is not offered; a request that got through is ingress-accepted by the new Edge and meets a v2 database: preflight `UNCONFIGURED` |
| v3 | v3 | v2 (cached) | the old app reads the status, does not accept the v3 manifest and shows try-on as unavailable until it is reloaded; if it sends anyway, ingress `CONFIG_CHANGED`; nothing is charged |
| v3 | v3 | v3 | the full feature with the new prompts, no new consent |

Rollout, each its own owner-authorised receipt: **drain first** (`tryon_purge_health()` shows `heldUsage: 0` and no running chain; the
migration refuses otherwise, so a step never settles across the cutover and a chain never mixes v2 and v3 prompts; a chain still
marked running after its 30 minutes is ended by `tryon_expire_due`, which the scheduled job runs), apply the
migration, deploy the `try-on` Edge function, then Pages, back to back. **After the install, a read-only check:**
`select count(*) from private.ai_controls where tryon_manifest_id is not null and tryon_manifest_id <> 'azure-global-image25-sunburst-tryon-v3';`
must return 0. A non-zero count means a bootstrap ran inside the apply window and left an account on the v2 manifest: do not fix it
silently; record it and repair it with a separately authorised, guarded update of that account's `tryon_manifest_id` to v3 (the
account's notice revision, consent and saved photo stay as they are). Reload the app (or close and reopen the installed one) to
leave the cached version; no data is lost. There is no database rollback; if the Edge deploy or Pages is delayed the feature stays
unavailable (fail closed) and the fix is to finish the deploys. Generated types are unchanged. Release-gates ledger rows follow the
coordinator's merge note.

**Not verified by any test.** No provider call was made, so nothing shows that the model now renders a coat open, keeps the clothing
underneath, or leaves a garment without a front opening alone; the tests pin the wording, hashes and rollout contract only. The
evidence is the owner's own try-on after the Edge deploy. **Owner acceptance has three trials:** (1) a coat or jacket with a front
opening over a visible top: it is worn open and the top shows; (2) a garment without a front opening (a pullover-style layer or
outerwear): it is worn naturally, with no opening created; (3) a one-piece or an outerwear-only outfit (nothing underneath to show):
no top or other clothing appears that was not in the outfit. Wording that depends on the garment is not part of this packet: only the
category is known to the server and no item field is ever sent, so the prompt lets the model read the garment photo for a front
opening. If a trial goes wrong, a follow-up would need its own manifest.

**TRYON-FLOW1 try-on starts at once (app only; no schema, Edge or notice change).** Owner request of 1 November 2026. Show on me
(Today) and Try on (outfit) open straight into generation: with a saved reference photo the chain starts by itself; without one the
same page asks for a photo once and starts when it is cropped, and offers to save that photo while the picture is made. Progress names
the garment being added (1 to 6 steps); Stop leaves nothing. The finished picture replaces the progress in place and is kept under
Try-ons automatically, as the server stores it when the chain completes (owner decision of 2 November 2026: no Save button and no
automatic deletion); the buttons are Try again, Delete (one delete call per press) and Done. Only the Try on button starts a chain by
itself; a reload or pasted link to the outfit's try-on route shows a Try on button instead, so nothing is spent unasked. The saved
photo is added, replaced or removed under Settings > Profile.

Platform restore: after any database restore and before access reopens, run
`select public.tryon_discard_transient();` as the database owner and record its
counts in the restore receipt. It deletes every try-on result, chain and attempt
and (TRYON-PHOTO1) every saved reference photo, so a restore can never bring back
a photo the owner removed (`photosDeleted`; none of these are in the app's export
or restore), never usage or evidence, and settles held try-on usage that is
already due.

**TODAY-IDEAS1 Today shows three ideas (app only; no schema, Edge, provider or engine change).** Owner request of 1 November 2026,
decisions of 2 November 2026: Today shows the engine's page of up to three ideas together instead of one at a time. Phones and
small tablets (under 900 px) get a horizontal scroll-snap row with the next card peeking; wider screens show the cards side by side.
Each card keeps Wear today, Try on (it seeds its own idea), Save as outfit, Like and its More options menu. One Show other ideas
control replaces the whole set with the next ideas (coordinator default, not yet confirmed by the owner); fewer than three ideas show
what exists. Today pins the keys it shows (`featured.ts`): a refresh can drop a card but never reorders or swaps one in, and when
every card has gone the ideas not shown before take their place. Hiding an idea keeps its card in place with Undo; an avoided pair
removes only its card and its Undo brings it back. Show other ideas now skips only the ideas Today actually showed. Verified with
unit tests and the Today, Try on idea, weather and stylist browser specs; the swipe feel on a real phone and the look of three-up
cards need the coordinator's visual review.

**FILT1 provider refusal kind (source only; hosted apply owner-gated as ledger 29).**
Adds `20261005090000_provider_refusal.sql` after ledger 28, in one transaction:
two nullable evidence columns (`provider_refusal`, `usage_absent`), the
`filtered_unmetered` origin and its constraints, both replays, and
`enhance_finish`/`tryon_finish` replaced with two optional trailing arguments
(dropped with `RESTRICT`; service role only). The Edge adapters record a bounded
refusal kind (`rai_input`, `rai_output`, `unknown_filter`, `unverified_filter`;
no provider text). A proven refusal with genuinely absent usage is charged the
full reservation, as Azure bills it, with no anomaly; malformed or partial usage
and every other case keep today's settlement. Existing rows and digests are
unchanged. Order, each by its responsible actor: G1 owner approves ledger 29;
G2 apply it; G3 `notify pgrst, 'reload schema'` and confirm both finish
functions answer an old-shaped call; G4 deploy `try-on`, then `enhance-photo`,
from the merge commit (no Pages deploy); G5 read back a filtered request with
the ledger queries above. Reconcile the `filtered_unmetered` charges against
Azure Cost Management for the same period; the app records the reservation, not
the invoice.

**BG2c-2 "clean up photo" client (source only; inactive; plan rev4).** A newly
chosen photo whose clean-up would be sent opens the crop editor as a pre-upload
review before anything is committed, analysed or sent. Done, even with an
unchanged crop, accepts it and sends H0 (the app-re-encoded crop, never the raw
file); Cancel commits the cut-out with no clean-up; a crop with two similar
garment regions sends nothing and asks for one garment. A later edit of an
accepted photo keeps the normal cancel. The client checks the result with
`cleanupCheck`; `compareEnhancement` is removed. Consent is notice revision 2
(`CLEANUP_NOTICE_REVISION`); revision-1 consent reads as off. The notice text is
a draft until the owner approves it. After this merges, `enhance-photo` and
Pages may be deployed from the merge commit in the rollout order above.

**I23 service worker (source only, not deployed).** The Phase 7 PR-1 draft
adds `src/service-worker.ts`, the Update/Reload prompt and the Settings install
hint. The worker precaches only the public shell listed in the generated
`precache-manifest.json` (index as `/`, hashed assets, icons and the web
manifest; never `_headers`, source maps or the worker itself). It checks the
manifest against the SHA-256 embedded in the worker and each file against the
manifest, so a deploy that lands mid-install leaves the working version in
place. Each release has its own cache, named from the shell and the worker's
own bytes; install fills a staging cache and commits it only after every file
verifies, and older caches are removed only on activation. The worker answers
only document navigations to `/` (from its own verified shell) and same-origin
requests for exactly its listed files with the matching destination. If its
own shell is missing it fails the navigation and unregisters itself rather than
serving the network's HTML; the next load is an ordinary network load. A page
with no controller loads from the network without the worker, so the planned
4 s navigation bound had nothing to apply to and was dropped. Nothing else is
cached: API, Auth, Storage, Edge, image traffic and `/_*` paths pass through. A
new version waits until the user presses Reload; `skipWaiting` is used only by
that button and by the emergency worker.

- **Headers.** `_headers` adds `Cache-Control: no-cache` for
  `/service-worker.js` and `/precache-manifest.json`. The CSP is unchanged.
  Before the owner-run deploy, check the served worker's headers, MIME type and
  scope on Pages; `scripts/serve-dist.mjs` only approximates Pages in tests.
- **Kill switch.** `STILLROOM_SW_KILL_SWITCH=1 npm run build` builds an
  emergency worker that activates at once, deletes only `stillroom-shell-*`
  caches and unregisters itself; that build's page registers no worker. Code
  already loaded in an open tab keeps running; other routes and the next visit
  load from the network, so open tabs may need a reload.
- **Rollback.** Deploying an earlier build is an ordinary update: open tabs see
  the Update prompt. Old shells talk to the current backend and must reject
  unsupported operations safely; cache eviction is not the safety mechanism.
- Any Pages deploy of a main with the worker, and any kill-switch deploy, needs
  the owner's approval. Device, install and visual acceptance stay pending.

**AI activation, owner account only** (from
[`5815445262`](https://github.com/drrowdev/stillroom-wardrobe/pull/37#issuecomment-5815445262)).

- **Activation.** At about 19:20Z on 23 September 2026 the coordinator inserted
  one `private.ai_controls` row for the owner's account only, under reviewed
  annex A2 (OpenAI GPT-6 Astra, AMEND F1–F5) with owner answers.
  - Row values: `azure-eu-terra-devtest-v1`, prompt 1, notice revision 2,
    monthly allowance USD 20 (`20000000` micro-USD), 20 requests per hour,
    result TTL 3600 s.
  - The owner accepted that USD 20 per month is an application allowance, not an
    Azure invoice ceiling.
  - The owner confirmed in the Azure portal: deployment `eval-terra-20260709`,
    `gpt-5.6-terra` 2026-07-09, Data Zone Standard EU (not Global), and no extra
    logging or data sharing.
  - The owner added `AI_AZURE_OPENAI_API_KEY` personally. The coordinator never
    saw the value.
  - The other account has no controls.
  - The profile review date (21 October 2026) was recorded as audit metadata.
    In source it no longer limits availability; see the
    persistent-availability note under the AZ1 contract below.
- **Supervised probe.** At about 07:31Z on 24 September the owner turned photo
  analysis on and analysed one photo.
  - Aggregate readback: 1 usage row, `estimated`, 9018 micro-USD; model
    observation `expected_snapshot` (an observation, not proof of the exact
    snapshot); control `ordinary`; cache read/write 0/0; 8 counters; no anomaly.
  - A wine-red coat was returned as `brown`, which led to COL1.
- **Open gate.** Scheduled purge of expired results is still open on hosted.
  Results are cleared by hand after supervised use for now. The source (an
  inactive `pg_cron` job, 25 September) is described under "Scheduled purge of
  expired AI results"; hosted H1 install and the owner-approved H2 activation
  are pending.

**COL1.** #37 merged as `a6a027eb`.

- The owner approved its hosted rollout (annex R0–R5 in the Phase 2 result) at
  about 13:05Z on 24 September 2026. The R0 read-only baseline was recorded at
  13:33:04Z (`5815445262`).
- COL1 was last recorded at R1 on 24 September
  ([`5815899879`](https://github.com/drrowdev/stillroom-wardrobe/pull/37#issuecomment-5815899879)):
  - M1 `garment_colours` was applied as hosted version `20260924135607`, with
    readback at 14:00:06Z.
  - M2 `azure_colour_manifest` was applied as hosted version `20260924140200`,
    with readback at 14:02:12Z.
  - R2 (Pages deploy of `a6a027eb` and smoke test), R3 (functions), R4
    (controls switch) and R5 (owner coat retest) were recorded as not yet done.
- Later steps are not evidenced by the cited comments. COL1 is not recorded as
  complete.
- The latest cited Pages receipt records deployment `27a1c642` of main
  `3ed08147` (PR #36 `5813432944`).
- The 23 September function versions (v1) and the activation controls
  (`azure-eu-terra-devtest-v1`, prompt 1) are the recorded state as of those
  dates, not a claim about the current state.

**Create-ID conflict normalization (source only, 25 September 2026).**

- Source `20260925100000_uniform_id_conflicts.sql` replaces `save_outfit` and
  `save_wear_event` with `create or replace` (same signatures and grants). It is
  not additive, so the owner's additive pre-approval does not cover it.
- Hosted mapping: **PENDING owner approval** (owner question Q2). No hosted
  version exists yet; hosted keeps the `409 23505` responses until then. After
  an approved apply, the coordinator records the hosted version and reads back
  `md5(prosrc)` of both functions against the source bodies.
- Owner question Q1: accept the remaining create-ID residual (see the Phase 5
  result, Findings).

**Scope at 24 September 2026.** Recorded as live by these comments: add/edit/Save/photo replacement,
AI-filled details for the owner's account only, and the simplified UI (L1a, L1b,
L2a). Not built: outfits, suggestions and weather (Phases 3–5). The owner moved
the calendar (I12/I13: date planning, marking worn, wear counts and
cost-per-wear) to the backlog at about 12:12Z on 24 September 2026
(`5815445262`); Phase 3 continues with I11 outfits only, and Phase 4 suggestions
must not depend on wear history for now. This is not the owner's full core
workflow and not Phase 0 or product acceptance.

The following actor table retains the **24 September snapshot**, including
then-unbuilt features and pending rollout steps. It is not the current hosted
inventory; use the dated R5 update above and the release ledger for later evidence.
Its ordinary-session, human-acceptance and actor boundaries still apply.

| Gate | Dated evidence / next step (24 September snapshot) | Responsible actor |
|---|---|---|
| Backend installation | The eleven Phase 0–2 source migrations are installed (23 September mapping above, including the manual M11 row). The two COL1 migrations were recorded as applied at R1 on 24 September (`5815899879`); see COL1. Future hosted DDL needs separate approval. | Coordinator/operator; cloud source worker must not access it |
| Hosted Auth | User-confirmed dashboard settings in the dated snapshot above; one owner's ordinary sign-in passed in the 23 September smoke test. Email delivery remains unproved. No arbitrary preview/wildcard redirect or inference from local TOML/SQL. | User dashboard confirmation; coordinator/operator tracks remaining gates |
| Intended owners | Privately reserved/created by the user; aggregate administrative evidence above. One owner's ordinary sign-in, own Save/reload, edit, photo replacement and sign-out/in passed on 23 September. Second-account use and negative cross-account RLS/Storage checks remain OPEN (second-account test user-deferred). Credentials stay private; never use local reserve/provision scripts on hosted. Password/account/recovery setup is outside the smoke runner. | User handles private credentials; approved private operator verifies ordinary-session access |
| Website | Git-backed Pages project `stillroom-wardrobe` created; selected GitHub repo access verified. Automatic production deployments OFF, preview deployments NONE, no production backend in preview environment. Deployments since 23 September are owner-run create-deployments of production main HEAD. | Coordinator through official Cloudflare connection only |
| Live deployment | Latest cited deployment: `27a1c642` of `3ed08147` (PR #36 comment `5813432944`, 24 September). Earlier: `f0016398` and `6e01b747`; the 6 September shell `91462a90` is history. Each replacement needs separate approval and fresh evidence. A deployment is not acceptance. | Coordinator; owner runs the create-deployment |
| Edge Functions | Three functions v1 ACTIVE, `verify_jwt=true`, source-identical as recorded on 23 September (`5800183953`). COL1 R3 (functions) was recorded as not yet done at R1 on 24 September (`5815899879`). The out-of-EU Edge location is accepted for the 23 September test rollout only, with owner test photos; general residency remains OPEN. Redeployment needs separate approval. | Coordinator/operator with owner approval; source writers have no access |
| Photo analysis (AI) | Activated for the owner's account only on 23 September (`5815445262`): `azure-eu-terra-devtest-v1`, prompt 1, notice 2, a USD 20/month application allowance (not an invoice ceiling), 20 requests per hour, 3600 s result TTL; the 21 October 2026 review date is audit metadata only. The 24 September single-photo probe had no anomaly. Still open: scheduled purge (manual clearing for now; source job ready inactive, hosted H1 pending, H2 activation needs owner approval, physical retention PENDING until H3), other accounts, quality (see COL1), privacy/retention and device acceptance. | Owner decides; coordinator/operator executes each change |
| Not built / backlog | Outfits, suggestions and weather (Phases 3–5) are not built. The calendar (I12/I13) is in the backlog (`5815445262`). Hosted deletion and recovery flows are not exercised. | Owner prioritises; separate approved packets |
| Hosted smoke | BLOCKED until both intended ordinary sessions and prepared non-personal item/main/thumb fixtures exist. Run the separate read-only command below privately and report only coarse result plus reviewed code head. The 23 September owner journey was a manual single-account check, not this two-owner runner. | Approved private operator, not cloud agent or public CI |
| Phone/accessibility | Actual iPhone/Safari and Android camera/library, rotation/compatible-photo fallback, explicit Save/Discard, own login/logout, EN/FI/SV, VoiceOver/TalkBack and narrow/zoomed layout checks remain open. Emulation/axe is insufficient. | Human owners/testers |
| Code/merge | All required exact-head gates, including App/browser, WebKit photo contracts, Real local Supabase/type parity, native Apple and I06 artifact visual review, plus genuine independent review, no blockers/overlapping writers and normal protections. Under [H1 clarification 5580579847](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580579847), the coordinator may execute a recommended ordinary merge without another user question; record recommendation/evidence and guard the exact head. No `--auto`, `--admin`, self-approval or protection bypass. | Cloud worker reports checks, never merges; coordinator reviews, records recommendation/evidence and executes the exact-head ordinary merge |

Pages production configuration contains only public `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION` and build-only
`NODE_VERSION=24.19.0`. The version shown in Settings is the first 8
characters of the build commit (`CF_PAGES_COMMIT_SHA`, which Pages sets
at build time and is not a browser variable), injected by `vite.config.ts`;
`VITE_APP_VERSION` is only the fallback for builds outside Pages. No administrator secret, Cloudflare Pages
Functions/bindings, paid hosting
or automatic deployment workflow. Other sites, DNS and billing are untouched.
A reachable shell does not prove login, owner setup, Storage/RLS or full Phase 0.

At that PR #2 handoff, proper password recovery was a separately user-approved
focused Phase 0 follow-up, not implemented or authorized by that documentation
packet. Its subsequent plan/prereview and PR #3 implementation are above.
Preserve both accounts: no one-time admin-reset,
deletion/recreation, raw Auth SQL password update, credential capture or magic-login
workaround. An isolated main-based read-only recovery planner has no code authority
and must not write here; no second implementation builder before the common-base gate.

### Private read-only hosted smoke

Run `node scripts/hosted-smoke.mjs` only in an approved private operator process
with a **clean environment**, populated through private process/credential
tooling. Do not paste values into commands, shell history, this repository,
GitHub secrets/environments, comments, screenshots or logs. No dotenv loading,
credential file reads, CLI arguments, password login, refresh, email/OTP/recovery,
signing, mutation, provisioning or remote cleanup occurs. Existing operator
sessions remain untouched. Expired sessions require fresh private operator input.

Required environment names (values must never be published):

* `ALLOW_HOSTED_SMOKE=1`
* `HOSTED_SUPABASE_URL` exactly `https://xwrdrugastphdiihzuia.supabase.co`
* `HOSTED_SUPABASE_PUBLISHABLE_KEY`: modern public `sb_publishable_` key,
  not a legacy JWT or service key
* For each diagnostic label `A` and `B`: `HOSTED_A_USER_ID`,
  `HOSTED_A_ACCESS_TOKEN`, `HOSTED_A_ITEM_ID`, `HOSTED_A_IMAGE_ID`, and the
  corresponding `HOSTED_B_*` names. These are runtime expected identities and
  pre-existing sample IDs, not permanent owner slots or account relationships.

Only those inputs and optional `PATH`, `SystemRoot`, `SYSTEMROOT`, `WINDIR`,
`HOME`, `USERPROFILE`, `LANG`, `LC_ALL`, `TMPDIR`, `TMP`, `TEMP` are accepted.
All other inherited variable names, including empty GitHub/service/DB/cloud
credential entries, proxy overrides and `NODE_OPTIONS`, cause refusal. The
operator must launch a clean process, not pass a copy of their ordinary shell.

Before data checks, `GET /auth/v1/user` must confirm each intended UID and
ordinary non-anonymous authenticated identity; decoded JWT claims alone never
establish identity. All requests are GET, no-store, timeout/size-bounded, and
refuse redirects. Both owners must read their own profile, specified live item,
ready image metadata and matching main/thumbnail bytes. Both foreign directions
then require empty row reads and explicit Storage not-found denial for those
known-existing paths. Finally repeat server identity and all own positives,
including unchanged projected metadata and byte hashes.

Exit **0 / PASS** means only those read-only checks completed, not the full
mutation/admission/access matrix or phone acceptance. Exit **1 / FAIL** means
foreign rows/media were exposed. Exit **2 / BLOCKED** means incomplete inputs,
identity/positive-fixture failure, outage, unexpected denial format, changed
fixture, missing liveness or unavailable evidence. Unexpected responses never
count as denial; cancellation cannot turn a primary failure into success.
Output contains only the coarse result. Unit mocks prove runner contracts,
not hosted RLS. No live hosted invocation was performed in this cloud packet.

## Historical foundation and PR #1 continuation

The initial push is **work in progress**, not a completed Phase 0 release.
Read `docs/phase-0-result.md`, the root agent instructions and the blueprint.

The original cross-tab/landmark/contrast defects and temporary type projection
were repaired before the continuation baseline
`f20c745eec9084cc900770cb2b206100ad94b784` (base
`d20457a82bca6e8d505d20b38dc07b4c930900cd`). Standard
[CI 34025264676 attempt 2](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34025264676)
passed on that head: App/browser job `101466868103` (40 cases), real local
Supabase job `101466868242` (start/reset, ordinary integration/security, actual
type generation and tracked-file/diff parity). Earlier sandbox workarounds are
historical, not a current failed CI gate; retain them in the result document.

The completed PR #1 continuation followed [plan comment 5558504250](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558504250)
and [approval/amendments 5558542193](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558542193):
different-owner SDK broadcast regressions, bounded exact-token correction,
unapproved email admission checks, accurate provider/evidence documentation,
and persistent coordination rules. That historical packet did not authorize
schema, Auth configuration values, setup workflow or phase expansion. Its
baseline success is not transferable evidence or merge approval for PR #2.

Prepared setup in agent run `34026811034`, job `101469132212`, completed the
locked install, Chromium, standard local start/reset/provision and actual type
generation successfully on 6 September 2026. No standalone setup rerun or
manual container workaround is needed for that successful preparation.

```sh
npm run db:start
ALLOW_SECURITY_TESTS=1 npm run test:integration
ALLOW_SECURITY_TESTS=1 npm run test:security
npm run db:types
npm run lint
npm run typecheck
npm run check:translations
npm run test:unit
npm run test:browser
npm run test:a11y
npm run build
npm run scan:secrets
npm run check:dependencies
npm run db:types -- --check
```

If the ephemeral canary is absent in a later CI process, generate a new random
build-only `STILLROOM_SECRET_CANARY` without printing its value before build
and scan. It is a leak-detection fixture, never a production credential.

## I29-AZ1 inactive Azure source contract

The [reviewed AZ1 release](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5766659126)
and [literal/declaration repair](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5766981960)
cover one integrated source packet, not activation or deployment. The additive
`20260921193000_azure_terra_analysis.sql` inserts the immutable
`azure-eu-terra-devtest-v1` manifest without changing any owner's controls,
consent or allowance. All nine installed migration files remain unchanged.

New analysis uses only the fixed Azure OpenAI EU DataZoneStandard DEV/TEST
deployment `eval-terra-20260709` at
`https://stillroom-ai-eval.openai.azure.com/openai/v1/chat/completions`.
Only the server reads `AI_AZURE_OPENAI_API_KEY`; there is no browser key,
endpoint/model router, Google impersonation, automatic retry or fallback.
The requested snapshot is `gpt-5.6-terra-2026-07-09`. A returned family name or
deployment alias is recorded as that observation, not proof of snapshot execution.
The profile review date, 21 October 2026 at 00:00 UTC, is audit metadata tied to the
immutable manifest hashes. It is not a service expiry: migration
`20261101080000_persistent_ai_availability` removes every review-date check from the
active photo analysis, Stylist, photo clean-up and virtual try-on paths (client, Edge
and database), so these stay available until the owner switches them off. It takes
effect in a hosted project only after the separately authorised migration and Edge deploy. Consent and
notice revisions, activation and provider-availability switches, exact manifest/model/prompt
checks, the monthly allowance, reservations, rate limits and every operational TTL
(analysis request/result, provisional settlement, probe authorisation,
scheduled purge) are unchanged; try-on results are kept until the owner deletes them (TRYON-LIMITS1). The Stylist (1 December 2026) and photo clean-up and
try-on (1 January 2027) review dates are metadata in the same way. Legacy Google stays
read-and-finish only.

The CI-only preservation rehearsal replays the frozen historical migrations, whose function bodies still refuse after
those review dates. After the Azure analysis date (21 October 2026) the analysis claim, finish, Save and replacement
fixtures are written as labelled `SYNTHETIC historical fixture` sequences after the real function has refused
(`tests/integration/synthetic-analysis.sessions.mjs`). For the Stylist, photo clean-up, try-on and legacy Google phases,
`tests/integration/manifest-eligibility.sessions.mjs` moves the `review_expires_at` of exactly those named manifests into the
future for the duration of one behavioural phase and restores the exact original dates before the phase ends, in the
disposable rehearsal database only. The move is a single privileged UPDATE that runs with `session_replication_role = replica`
set only around it; the manifest immutability trigger stays installed and enabled, and the ordinary update and delete refusal
is asserted before, during and after each phase. The complete manifest rows are compared with the snapshot taken before the
move, and the exact dates with the migrations. Within a phase every call is unchanged: the real historical functions and RPCs
over the normal transports. The phases are labelled `synthetic manifest eligibility; real historical functions/RPCs`; no phase
spans a migration or a manifest comparison, and AVAIL1 and later run on the current schema with no override. This is a
privileged fixture step, not an immutable one. A failed restoration aborts the rehearsal with `ELIGIBILITY_RESTORE_FAILED`.
Once the real clock is past a family's date, a rolled-back probe also checks that the real historical function answers exactly
`UNCONFIGURED` for valid configured input; before that date it checks that the same input passes the gate. A unit test lists
every function that reads a review date, so a new gate fails there until the harness handles it.

The six explicit input/output/total/reasoning/cache-read/cache-write counters
have no missing-to-zero defaults. Input/output rates are respectively
USD 4.40/19.80 per million tokens; their combined estimate is rounded up once
to micro-USD. The 4,097,351 micro-USD reservation of manifest v2 is allowance arithmetic (v3 holds one micro-USD; see BUDGET2), not
an invoice ceiling. Both cache reads and writes must be zero. Positive applicable
cache counters or identity/control anomalies deny new admissions and ready facts,
preserve accepted/confirmed accounting (or the hold), and deactivate the affected
control. Valid billing with invalid facts still produces an estimate; valid
overruns retain the unclamped estimate. No raw provider extensions are retained.

Legacy Google is **READ-AND-FINISH ONLY**: known receipts remain readable and late
settlement retains its original accounting rules. The deployed entrypoint cannot
dispatch Google and reads no Google credentials. New dispatch/enable is Azure-only. Accepted frozen
Save attempts can still finish after expiry, opt-out or deactivation. A first
reservation can unlock the form only on the exact committed
`analysis_unavailable` acknowledgment with matching owner/item/image identities.
The profile lock and durable terminal request identity prevent a delayed same
claim from succeeding after that refusal. Lost/malformed responses and lock
failures keep the original frozen IDs and payload. Explicit manual continuation
preserves values and user edits without promoting inferred facts to user intent.

Local fixture browser tests are not the real backend gate. Unchanged CI runs
the normal-owner Auth/REST/Storage/Deno-finalizer vehicle and production Node
analysis handler with only the provider synthetic, plus exact base/prior-main/
target upgrade preservation and actual generated-public-type parity.
`npm run db:types -- --check` exists and compares actual generated text; this
writer does not run it without backend authority. Prior-main means exactly
nine applied migrations and the Azure migration pending; target means all ten.

Six-path helper/documentation parity and synthetic metering are not successful
live Azure normalization. Deployment wire/control compatibility, quality,
privacy/retention and human/device acceptance remain live-activation gates.
No private capture, paid call, hosted mutation, production deployment or owner
activation is implied by this source packet.

### BUDGET2 unreserved photo analysis and USD 200 ceiling - 1 November 2026

Owner decision of 1 November 2026: the per-photo hold is removed and the monthly ceiling is USD 200. Source only; hosted
apply, both deploys and the controls switch are separate owner/coordinator gates and are not done by this packet.

- **What changed.** Migration `20261101090000_unreserved_analysis_manifest` adds the immutable manifest
  `azure-eu-terra-devtest-v3` (same model, prompt 2, notice 2, rates and prompt/schema digests as v2) with a reservation of
  1 micro-USD and an input envelope of 16,384 tokens (output 2,048). One micro-USD is the smallest hold the schema accepts:
  `ai_controls.max_request_micro` and `ai_usage.reserved_micro` are `> 0` and a reserved/held row must account exactly its
  reservation; the manifest reservation is only the floor the controls' amount must reach. It replaces, with their exact
  current bodies and only the manifest id lists widened (plus, in `ai_finish_analysis`, the v3 anomaly rule below),
  `ai_claim_analysis`, `ai_analysis_permitted`, `ai_finish_analysis`,
  `ai_status` and `complete_analyzed_item_save` (a v3 Save keeps its manifest lineage), and `admin_set_budget` (ceiling
  `200000000`). No controls row, usage row, consent or notice is written, so nobody is asked for consent again.
- **Allowance, not a hold.** The monthly budget is a recorded-usage *admission allowance*: a new analysis is admitted while
  recorded use (charges plus every reserved or held row of any feature) plus one micro-USD is within it, and finishing records
  the real cost. It is not a hard actual-spend ceiling, not a monetary hold (the one micro-USD is a placeholder), and not an
  account-wide bound on how many calls can start. An expired dispatched request keeps its held charge, now one micro-USD
  instead of USD 4.10.

  | Situation | Overshoot of the allowance |
  |---|---|
  | N analyses outstanding at once, each within the envelope | up to N × USD 0.112639 (16,384 input and 2,048 output tokens at 4.40/19.80 per million; a typical photo is about USD 0.01) |
  | A reply beyond the envelope | its full unclamped cost, recorded afterwards; not bounded by the row above |
  | Lost or invalid metering, or a request whose cost is never learned | not bounded: it keeps only its one-micro placeholder |
  | After the budget is used up | no new analysis is admitted; in-flight ones still finish |

  A positive one-micro-USD amount may show as USD 0.01 in cent-rounded displays; that rounding is never used in admission.
- **Anomaly handling (v3).** A valid reply with more than 16,384 input or 2,048 output tokens keeps its unclamped estimate and
  the evidence `anomaly` flag and fails only that photo (the photo is filled in by hand); analysis stays available for the next
  photo and nothing is deactivated. v1 and v2 keep their deactivation, and for v3 too the other shutdowns are unchanged
  (non-ordinary or contradictory controls and positive cache counters deactivate the control; a missing or unrecognised model
  fails the photo and keeps the Settings notice; invalid or unobserved counters are rejected). The bound is about four times the
  expected request (a high-detail 1600 px photo is about 3,000 image tokens, plus the fixed prompt and schema; the 24 September
  probe used at most 2,049 input tokens). Monitoring after rollout, as counters only: evidence rows with `anomaly = true`, the
  account's `activated`, and the maximum and 95th percentile of `normalized_usage->>'input'`.
- **Rollout order.** (1) apply the migration; (2) deploy `analyze-clothing` (accepts v2 and v3, chosen by the account's
  controls); (3) deploy Pages (v3 profile with a one-micro minimum and the USD 200 ceiling); (4) switch the owner's controls
  with `scripts/budget2-controls-switch.mjs` (`forward`), one guarded transaction; (5) the owner raises the budget in the
  admin screen (needs steps 1 and 3 only; the database first). Any earlier-numbered component alone leaves behaviour unchanged
  or fails closed: controls on v3 with an older Edge function or Pages build make analysis unavailable (never a one-micro hold
  under v2: a v2 account below 4,097,351 is refused by the claim).
- **Guarded switch.** Both `forward` (v2 to v3) and `rollback` (v3 back to v2/4,097,351) use the same quiescence guards and
  refuse with `BLOCKED` before any write unless: the controls are exactly the expected current row; no frozen analysed Save or
  image replacement is still in progress (reported apart from an unreserved ready analysis); no request of the account is
  alive, neither one in flight nor a ready analysis that was never saved (its manifest would no longer match, so it could not
  be saved); and no reserved or held charge exists. A dispatched request that expired keeps its held charge, so it blocks
  too, in both directions: the switch never erases an unknown charge to pass the guard, and reconciling one is a separately
  authorised step. Rollback restores the controls before Edge and Pages are downgraded; activation and consent are never
  written.

  *BLOCKED explanation, one exemption (BUDGET3-GUARD).* The owner's hosted account has exactly one dead hold of 4,097,351
  micro-USD from 8 October 2026 (analysis, held, closed `UNAVAILABLE` by the old anomaly kill switch, no request row). It would
  block the switch forever, so the guard ignores a held row only when **all** of these hold: purpose `analysis`; state `held`;
  a period earlier than the current UTC month; closed (`closed_reason` set); no `private.ai_requests` row; and Azure v2
  evidence with `anomaly = true` and no `normalized_usage` (the shape of that kill switch; a late `ai_finish_analysis` for it
  stops at `USAGE_CONFLICT` before any change, so it can neither re-account the hold nor switch the account's current controls
  off afterwards). Everything else still blocks, and one ineligible row blocks the whole switch: an ordinary expired hold (a
  late finish can still settle it to a different amount), the current or a future month, an unclosed row, a request row still
  present, v3 or other evidence, another purpose, any `reserved` row. The period and the request-liveness cutoff both come
  from one `clock_timestamp()` taken after the profile and controls locks, the period as its UTC month whatever the session
  time zone. The row is not written, closed or cleaned: it is not proven immutable, and an explicit billing reconciliation
  stays possible later.
  **It stays counted.** `private.ai_budget_used` adds every reserved or held row of any month to the current month, so that
  4,097,351 micro-USD (about USD 4.10) keeps reducing the shared admission budget and the current-use displays every month,
  and the admin history keeps showing it as reserved under October. Ignoring it for the switch does not clean it; settling
  it is a separate, separately authorised hosted step.
  **Operator runbook.** Immediately before running the switch on hosted, re-enumerate every reserved/held row of the account
  (`private.ai_usage` with its evidence and any request row) and confirm only the known row exists; any additional
  non-qualifying row must still BLOCK, and nothing is ever cleaned automatically to get past it.
- **Tests.** Unit: `unreserved-analysis-schema`, `budget2-controls-switch`, the endpoint, client, card and consent tests. CI:
  the preservation rehearsal now runs the AVAIL1 proofs unchanged at `budget2-prior` (exactly `20261101080000`), then applies
  BUDGET2 alone and proves its diff and the real v3 claim, finish, status, analysed Save, attribution and image replacement,
  burst and concurrent claims, expired-held rows, the anomaly, the ready-draft reverse cutover, the guarded switch (including
  the BUDGET3-GUARD cases: the real v2 anomaly hold of an earlier month is ignored in both directions, every other held or
  reserved shape and an unclosed, present-request, current-month or future row still blocks, refusals change nothing, a late
  finish of the ignored row stops at `USAGE_CONFLICT`, in non-UTC session time zones) and the
  ceiling. The SQL and those scenarios run only in the CI rehearsal; no local Postgres/Docker was available to the builder.
  Fixtures that pin v2 and 4,097,351 stay as intentional compatibility coverage.

### COL1 garment colours and Azure v2 manifest - 24 September 2026

COL1 adds `burgundy`, `cream`, `khaki`, `light_blue`, `teal`, `gold` and
`silver` to the 14 colour codes. Existing values stay valid and no rows change.
Two additive migrations follow the eleven installed ones:
`20260924100000_garment_colours.sql` widens only the three colour checks
(`private.ai_valid_facts`, `private.reserve_item_save`,
`private.image_change_intent`), and `20260924100100_azure_colour_manifest.sql`
inserts immutable `azure-eu-terra-devtest-v2` (new schema/prompt hashes,
`prompt_version` 2, same model, tariff, limits and expiry) and lets the four
v1-literal functions accept v1 or v2. Each body is its predecessor with exactly
one substitution; a unit test rebuilds both files from the earlier migrations.

The deployed handler dispatches only the v2/prompt 2 pair. Receipts, finishes
and Saves for v1 remain accepted, and the browser accepts either matching pair;
mixed pairs are refused. The consent notice and its hash are unchanged, so the
v2 switch needs no new consent. Preservation stages now include `colours`
(twelve) and final `target` (thirteen); the storage guard accepts exact prefixes
of nine to thirteen. Hosted order is M1, M2, Pages, the three Edge Functions
together (they share `protocol.ts`), then the owner's controls switch to v2;
each step is separately approved.

### Scheduled purge of expired AI results - 25 September 2026

`20260925090000_ai_purge_schedule.sql` is the fourteenth migration. It adds
extension/config objects and new inactive job metadata without modifying
pre-existing application data or objects. In one `do` block it:

- raises and aborts unless `current_user` and `current_database()` are both
  `postgres`, `pg_cron` is absent or already in `pg_catalog`,
  `cron.database_name` is this database, `postgres` can use `cron` and execute
  `cron.schedule(text,text,text)` and
  `cron.alter_job(bigint,text,text,text,text,boolean)`, neither `anon` nor
  `authenticated` has USAGE or CREATE on `cron` (including inherited), and no
  job named `stillroom-ai-purge-expired` exists;
- creates `pg_cron` in `pg_catalog` only if absent, with the two Supabase
  default grants to `postgres`; an existing installation's ACLs are checked,
  never changed;
- schedules `select public.ai_purge_expired(500)` every 15 minutes
  (`*/15 * * * *`) as `postgres` and sets the job inactive in the same statement.

The job stays inactive because a live job would purge the deliberately expired
CI fixtures at an arbitrary moment. No existing function, grant or row is
changed; `ai_purge_expired` stays SECURITY DEFINER, service-role/owner only,
bounded to 1–1000 rows and owner-agnostic. Preservation `target` is now
fifteen (with `20260925100000_uniform_id_conflicts.sql` after it) and the
storage guard accepts exact prefixes of nine to fifteen.

Local evidence (CI DB job only): AI controls S7 checks the exact job row,
`active=false`, zero rows in `cron.job_run_details`, `cron.log_run=on`, a UTC
`cron.timezone`, the purge function owner `postgres`, and `INVALID_INPUT` for
limits 0, 1001 and null; it records each `cron` function ACL by OID without
requiring EXECUTE to be revoked (PUBLIC EXECUTE is the default; the schema USAGE
denial blocks invocation). The security suite requires 406/`PGRST106` for
`cron` reads and RPCs from both owners and anonymous. S4's `removed: 1` is
bounded-purge evidence, not proof that the job never fired; that proof is the
inactive state plus zero runs.

**Retention.** Logical expiry and physical cleanup are separate. A result is
unavailable to its owner as soon as `expires_at` passes (the status/control RPCs
check expiry). Physical cleanup, which closes the request as `EXPIRED` and keeps
only the minimal ledger, happens at the next successful run: the worst case is
about TTL + 15 minutes, plus any run that hits the 500-row bound. With the
current 3600 s owner TTL that stays well under 24 hours; it is not guaranteed
for an 86400 s TTL. A scheduler outage breaks any wall-clock guarantee. The
physical-retention gate stays **PENDING** until H3 below passes; this packet
changes no TTL.

**Hosted runbook.** The coordinator runs each step; STOP on any unexpected
state. H1 is covered by the owner's additive pre-approval; **H2 needs the
owner's separate approval** and is not run by this packet.

- **H0, read-only baseline.** `pg_extension` and `pg_available_extensions` rows
  for `pg_cron` (schema, version); the migration ledger; the live owner of
  `public.ai_purge_expired(integer)` (`pg_get_userbyid(proowner)`, expected
  `postgres`) with its md5, ACL and SECURITY DEFINER; and, from ONE captured
  timestamp `t0`, aggregates only: `private.ai_requests` total and with
  `expires_at <= t0`, and `private.ai_usage` total. STOP if `pg_cron` is in
  another schema, a job with this name exists, or the function owner differs.
- **H1, install (inert).** Check the Git blob bytes (2382) and md5
  (`0d92c55403e3b093d9d886f1ec7abff3`), then one `apply_migration`; no
  `db push`, replay or history repair. The migration aborts as a whole if any
  guard fails, including if it does not run as `postgres`. Readback: ledger
  statement md5 equals the blob; extension in `pg_catalog`; the job row exact
  (name, schedule, command, `postgres`, `postgres`, `active=false`) with zero
  runs; `anon`/`authenticated` without cron USAGE/CREATE; `cron.timezone` and
  `cron.log_run` recorded; H0 aggregates recomputed at the same `t0` are
  unchanged; the function md5/ACL/owner are unchanged. Rollback:
  `select cron.unschedule('stillroom-ai-purge-expired');` (the extension can
  stay).
- **H2, activate (owner approval required).**
  `select cron.alter_job((select jobid from cron.job where jobname='stillroom-ai-purge-expired' and username='postgres'), active := true);`
  Readback: `active=true`, the rest of the row unchanged.
- **H3, liveness acceptance.** Within 45 minutes of H2 there must be at least
  one `cron.job_run_details` row for this job with `status='succeeded'` and
  `end_time` after H2; an empty history or only failures is a FAIL. Then record:
  last-success age (expected under 20 minutes), the expired backlog
  (`count(*)` with `expires_at <= now()`, expected 0 unless more than 500 per
  interval) and the oldest-expired age (expected under 15 minutes plus TTL
  slack). Ledger and usage counts must be unchanged, because closures keep the
  ledger.
- **Monitoring and response.** On each supervised check, read the same three
  values. If the last success is older than 30 minutes, or the oldest expired
  row is older than 30 minutes: pause (`cron.alter_job(..., active := false)`),
  run one manual bounded `select public.ai_purge_expired(500);` as today, record
  the failing run's `status`/`return_message` (no row data), and report to the
  owner before re-activating. Pausing or unscheduling does not restore rows
  already closed by committed runs. It MAY terminate a run in progress
  (pg_cron 1.6 stops the worker or closes its connection when a job changes or
  is removed), and that run's uncommitted changes are rolled back. After any
  pause, unschedule or manual fallback, check `cron.job_run_details` for this
  job for a run still `starting`/`running` or one that `failed` (record only
  `status`/`return_message`), and read the expired backlog again.

### Stylist exact-route probe (ST-OP) - 28 September 2026

Hosted stylist state at the start of this packet: **installed and activated, but
unconsented**. The owner's stylist consent stays null for the whole packet; the
probe calls Azure directly and never touches Supabase, the Edge Function or any
account data. The ST0 Terra-vs-Sol comparison is not approved and is not in the
repository.

**What a PASS means, and what it does not.** Two synthetic requests (`min` and
`max`) go to the exact production route (`STYLIST_ENDPOINT`, Terra
deployment) with the production body builder, controls and response parser. A
PASS records route, schema and control observations plus token calibration at
two synthetic sizes. It is not a token-bound proof, a quality evaluation, an RLS
test or a hosted Edge test.

**Fixtures.** Both are built by `buildStylistRequest` from committed synthetic
data and must pass `parseStylistBody`, the message, history, conversation and
ingress-body limits, item parsing and weather eligibility before anything is
recorded. The `max` fixture is tuned offline to 19,950–20,000 message bytes
(currently 19,980); no calls are spent searching for it. Each run record stores
the source commit, manifest ID, request/settings/controls digests, the Node
version and every call timestamp. `send` refuses a checkout whose probe source
files are untracked or modified.

**Allocation (coordinator, Q1).** Before `init`, the coordinator runs
`stylist_direct_allocation` for USD 0.26 (260,000 micro, total
20,000,000 → 19,740,000) and reads back the owner's allowances. The receipt is a
private JSON file with exactly these keys:
`kind` (`stylist-probe-allocation-v1`), `ownerRef` (SHA-256 hex of the owner
UUID), `allocationMicro`, `reply` (the RPC's `code`, `previousTotalMicro`,
`newTotalMicro`), `readBack` (`monthlyAllowanceMicro`,
`stylistMonthlyAllowanceMicro`), `allocatedAt` (ISO UTC) and `approvalRef` (the
approving GitHub comment URL). Since BUDGET1 the kind is `stylist-probe-allocation-v2`:
its `readBack` is `monthlyAllowanceMicro` alone (the one monthly budget; no
stylist sub-limit exists), and v1 receipts stay accepted unchanged. `init` refuses a receipt whose arithmetic,
read-back or month does not match, or whose allocation cannot cover both slots
(2 × 129,360 = 258,720 micro; the 1,280 left over is not a third call). The value
is a USD operational allocation, not the Azure budget, which is in billing
currency.

**One record per allocation (H1).** The allocation ID is derived from the
receipt, and its run record is created exclusively as
`~/.stillroom-operator/stylist-probe/<id>/` (append-only `probe.jsonl` plus a
`probe.lock` directory). A second `init` of the same allocation fails with
`ALLOCATION_ALREADY_RECORDED` from any working directory or process. The root
must not be inside the repository or an agent session folder. This is
cooperative, not tamper-proof: it stops accidental reuse by an operator using
this tool, not a deliberate edit of the file system.

**Commands.** Run from a clean checkout of the merged commit, with the pinned
Node, on the operator's own machine. Both entrypoints refuse recognised CI
environments (`CI`, `GITHUB_ACTIONS`, `TF_BUILD` and similar, any value) before
any record, key or network access; there is no bypass.

- `node scripts/ai-evaluation/stylist-probe.mjs init <absolute receipt.json>`
  prints the allocation ID; nothing is sent.
- `node scripts/ai-evaluation/stylist-probe.mjs status <id>` prints the summary
  and verdict (`PASS`, `REVISE_ENVELOPE`, `INCOMPLETE`, `UNRESOLVED` or
  `HALTED`) without the key or reply text.
- `node scripts/ai-evaluation/stylist-probe-launch.mjs --subscription <guid> send <id> min`,
  then the same with `max` only after `min` is OK. The coordinator runs `send`
  (Q3).
- `node scripts/ai-evaluation/stylist-probe.mjs reconcile <id> min|max` marks an
  intent without a result as **counted**. It cannot mark a call as not sent.
- `node scripts/ai-evaluation/stylist-probe.mjs recover <id> min|max` is the only
  way out of an unconfirmed write (see below). Run it only when no probe process
  is running.

**Secret-safe launcher (Q3).** The launcher targets resource group
`rg-stillroom-ai-eval`, resource `stillroom-ai-eval` and key `key1` in the
subscription given on the command line. Before either Azure CLI call it refuses
an inherited TLS-verification override, key log, tracing or code-injection
variable (for example `AZURE_CLI_DISABLE_CONNECTION_VERIFICATION`,
`REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `SSLKEYLOGFILE`, `PYTHONPATH`,
`NODE_OPTIONS`). Each `az` call gets a narrow environment: OS basics,
`AZURE_CONFIG_DIR` and any proxy variables, plus fixed overrides that beat the
operator's az config file, including `AZURE_LOGGING_ENABLE_LOG_FILE=false` (az
file logging writes DEBUG output whatever the console verbosity) and telemetry
off. The operator's global az configuration is not changed. The probe child gets
only the OS basics plus the key. It makes exactly two Azure CLI calls
with `--only-show-errors -o json`: `account show --query properties.endpoints`
(the `OpenAI Language Model Instance API` entry, selected in Node rather than in
the query, must have `STYLIST_ENDPOINT`'s exact origin before any key is listed;
`properties.endpoint` is the cognitiveservices endpoint and is not accepted) and `account keys list --query
key1`. The output is captured in memory; the key goes only into the probe child's
environment as `STILLROOM_AZURE_PROBE_KEY`, never into arguments, files, logs or
tool output, and is deleted in `finally`. The child removes it from its own
environment on start. Errors are fixed codes (`USAGE`, `RESOURCE_MISMATCH`,
`KEY_RETRIEVAL_FAILED`, `AZURE_CLI_FAILED`, `LAUNCH_FAILED`); do not add
`--debug` or `--verbose`. If retrieval fails, stop: do not rotate keys, change
RBAC or substitute another resource or deployment.

**Reconciliation rules (M3).** Each slot is used at most once: a durable intent
permanently consumes it, and there is no retry or replacement under the same
allocation. `send` checks the allocation month and review validity, syncs the
intent, then checks both again; only that post-intent check writes `NOT_SENT`,
the sole affirmative evidence that the provider call never began. A crash,
timeout or reset after the intent is not that evidence, so the slot stays
counted. If the intent cannot be synced nothing is dispatched; if the result or
close cannot be synced the lock and the uncertain state remain until
`reconcile` or `recover`. Reconciliation never creates a success: without an OK `min`, `max`
is refused, and without an OK `max` there is no PASS. The run stops on invalid
usage, a model or control anomaly, or an input (24,000) or output (1,200) token
envelope violation.

**Unconfirmed writes.** Every ledger line is preceded by a synced
`probe.pending` marker, removed only after the line is synced and closed. While
the marker exists (or the lock is held) `status` reports `UNRESOLVED`, never
`PASS`, and `send` and `reconcile` refuse with `PERSISTENCE_UNCERTAIN`; removing
the lock by hand changes nothing. The marker and lock are checked both before
and after the ledger is read, so a `status` that overlaps a write keeps any
uncertainty it saw at either point. `recover <id> <slot>` drops a torn final line,
appends a `recover` event, and only then clears the marker and the lock. A
recovered slot is **counted** at the full valuation whatever its visible result
says, so a result written under a failed sync or close can never become a PASS.
An unconfirmed `init` makes the allocation unusable: stop and ask for a new one.

**Restoring the total (Q2, separately approved).** After the probe's UTC month
ends, and only after `status` shows no uncertain slot, the coordinator restores
the total with an expected-value guard:
`update private.ai_controls set monthly_allowance_micro = 20000000 where owner_id = <owner> and
monthly_allowance_micro = 19740000`, expecting exactly one row, then reads it
back. Any other value means STOP and report.

### Admin grant runbook (AD1, ADR27) - 1 October 2026

Source only until approved: `20261001090000_admin_limits` follows M8 (the two
enhancement migrations) and is not applied to hosted. Applying it, the grant
below and the Admin screen (AD1b) are separate owner gates. The coordinator runs
these statements in the SQL editor as the database owner; no app, RPC, restore or
client path writes `private.app_admins`.

Grant (one row; the trigger refuses a stale generation, a disabled admission or
a mismatched user):

```sql
insert into private.app_admins(owner_id,admission_no,admission_generation)
select user_id,admission_no,generation from private.approved_accounts
where admission_no=1 and enabled and user_id is not null;
```

Read-back: `select admission_no,created_at from private.app_admins;` returns one
row. Revoke: `delete from private.app_admins;`. A re-invitation rotates the
admission generation and ends the admin's authority until the operator deletes
the row and grants again. Audit rows are read only here, by SQL:
`select created_at,target_admission_no,reason_code,old_limits,new_limits from
private.ai_limit_audit order by created_at desc limit 20;`. They are never
exported, updated or deleted except by the account-deletion foreign keys.

## Delivery rules

### I10b staged local source authority - 22 September 2026

[Approval, retained independent critique and own-writer local model attestation](https://github.com/drrowdev/stillroom-wardrobe/pull/29#issuecomment-5769933357)
release Stage A only on clean accepted main
`1984b848017dd9c22249907fe303d701bcb48440` / tree
`532730a435bfe29fc0ea9611688efde1fc2cc1fc`, in the persistent
`drrowdev-shiny-umbrella` local writer. All ten existing migrations are immutable.
The eleventh checked-image migration, fixed finalizer and existing test/harness
extensions do not authorize local Docker/backend/SQL fixtures, hosted operations,
provider activation, another actor or source publication.

The pinned Supabase CLI 2.116.0 has no target-version `migration up` flag.
The CI-only preservation owner copies verified config and exactly the first ten
verified migrations into `.supabase/preservation-stage-<run UUID>`. The config is
verbatim; no speculative function stripping is implemented. Nonrecursive
creation rejects existing paths; exact inventory/content and directory ownership
guard cleanup. ROOT-bound history and container identity are checked before
and after the fixed staged CLI command. This proves actual populated base->10
and 9->10 before ROOT applies populated10->11. No migration hiding, moving,
manual ledger write, history repair or reset/reseed substitute is permitted.
The preceding AZ1 nine/ten terminology is historical; I10b adds the separately
named `azure-target` ten-migration stage and final eleven-migration `target`.

Guard installation selects only the exact historical type-21/body pair at
nine/ten or the reviewed type-29/body pair at eleven, using the actual ledger.
Unknown histories/body drift fail; observed code is never adopted as a pin.
The serving inventory is exactly three directories with 7/4/3 files and three
JWT-verified declarations. B1=12/B2=22/C=2 remain unchanged; new I10b real-Deno
and ordinary-session fixtures are separately labeled and add no inference.

Actual CI-generated public types are the Stage B handoff before typed caller/UI
work. This text-only writer does not fabricate them or view image artifacts.
Required later bounded UX artifacts remain coordinator-owned exact-head review.
I10a-D maintenance is deferred, not passed; I22 owner-prefix deletion is still
required in Phase 6. Deletion promises logical native removal/reconciliation and
durable publication fencing, not physical erasure or provider-remnant deadlines.

Delivery uses fresh isolated local writers per approved packet and the model-check contract
above, not cloud/native allocation or historical setup/intake authority.
The dated PR #2 handoff, PR #3 recovery and completed I06/PR #7 restrictions
remain historical evidence. Current ordered development follows the specific
authorized packet under the task scope rule above, not an old packet pin.
Do not reopen merged PRs or push
to `main`. Agreed Phase 0–7 development proceeds after prerequisite engineering,
automated and real normal-owner gates without another phase-start/continue question.
Under [H1 clarification 5580579847](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580579847),
the **coordinator may execute a recommended ordinary merge without another user
question**, only after genuine independent review, all required exact-head gates,
no blockers or overlapping writers, and normal repository protections. Record the
recommendation/evidence in a short merge note and guard the exact head with
`--match-head-commit`. No `--auto`, `--admin`,
self-approval or protection bypass. Workers never merge, deploy, approve/authorize/
rerun Actions or start another agent or packet. After each merged user-visible
change the coordinator recommends a Pages deploy, which the owner runs.

Deployments, paid AI/provider/dependency/codec changes, hosted schema/account/data mutations
and private input capture retain separate approvals. The source worker receives no
hosted credentials and never runs local fixture/reset tools against hosted.
Keep pending/deferred manual acceptance distinct from engineering completion and
bring back a gate when it genuinely blocks a feature. Preserve the photo-first,
editable draft and explicit Save contract, three languages, isolated owners and
deterministic outfits. No later feature is implicit in the assigned packet;
workers never advance to another packet on their own.

Before every implementation packet:

1. Read active root/Copilot instructions, this guide and phase/backend evidence,
   relevant blueprint requirements/work packets, actual schema/source/tests,
   PR body/discussion/diff/reviews and CI job logs. Record exact base/head,
   files actually consulted and unresolved gates.
2. Write a plan before edits, tiered as in the leaner process above (updated
   24 September 2026, model policy updated 8 October). Tier A gets ONE read-only
   OpenAI GPT-6.1 Sol (`gpt-6.1-sol`) plan critique using a
   `rubber-duck` task agent with high reasoning; record provider/model and findings, which the
   coordinator applies as binding amendments before approving. Tier B gets a
   short plan approved directly by the coordinator. The
   historical I06 plan/amendment and actual **Anthropic Claude Opus 5** critiques
   are linked above, not approval for this task. PR #2 `5559949209` and
   `5560449572`/`5560847183` also remain
   historical evidence, not current-packet approval. Automated validation/self-review is
   supplemental, not that prereview; do not invent a native review tool.
3. Explicitly select **Anthropic Claude Sonnet 5.5 (`claude-sonnet-5.5`)** with
   `reasoning_effort: high` and enter each fresh isolated LOCAL implementation
   session per approved packet read-only (plan mode) for planning
   only (owner decision `6067719398`). The coordinator's plan approval is the
   edit permission; the builder then runs in autopilot. The coordinator checks
   the builder's OWN actual model usage in session logs against the
   app/CLI/repo/workspace/branch, base head and scope and notes it in the merge
   note. Fresh source and session/model continuity remain mandatory. Local
   telemetry has the weaker provenance described above, not native-receipt
   equivalence. A mismatched model means STOP; no Auto, silent fallback or
   unverified implementation. A material amendment to a Tier A plan (scope,
   allowed files, authority or behaviour) gets another critique; routine
   corrections do not. Stop if the required model or reviewer is unavailable.
4. Use fresh isolated LOCAL implementation writers per approved packet: at most two
   implementation builders, one writer per workspace/branch/PR and one focused
   approved packet per writer, with genuine on-demand read-only review. The
   former two-cloud-builder allowance is superseded historical policy. Routine
   scoped failures stay in
   the same session; after its PR merges, the coordinator archives the builder.
   Retired long-lived builders stay retired. No main/coordinator-checkout implementation. Before
   assignment, the coordinator names the packet/branch, owned files, dependencies
   and shared mutable-resource owners. Never concurrently mutate the same branch
   or unrelated/shared host resources. The corrected common-base prerequisite
   was merged in PR #2; no additional builder is implicit in a packet, and workers do not
   launch additional agents.
   Session SQL/coordination notes do not change repository authority. Merges,
   hosted DDL and deployments remain serialized and separately authorized; actor/
   credential restrictions still apply. Concurrency itself authorizes no new
   packet/PR, phase, dependency, provider or hosted operation. The coordinator
   handles routine scoped fixes/reviews/CI; consequential decisions go to the user.
5. Report exact validation commands/results, what was not run, and fresh-head
   CI status. Builders run lint, typecheck, check:translations, unit tests and
   affected browser specs; CI runs the full suites. Every change gets one
   read-only OpenAI GPT-6.1 Sol code review using a `code-review` task agent
   with high reasoning before merge.
   Coordinator authorization governs CI reruns/approval; do not bypass it.
   Physical-phone/Safari, camera/library, VoiceOver and TalkBack acceptance
   remains a human gate, not something Chromium emulation or axe proves.

Under the historical cloud setup contract, the setup workflow had to be on the
default branch before preparing cloud agent sessions. Its manual Actions
diagnostics support remains a technical capability, not authorization to run it.
Historical cloud availability/usage depended on the account's GitHub Copilot
settings and plan; configuration alone implied no completion. Current local-only
policy authorizes no fresh cloud setup/allocation or automatic fallback.

### B1 completion setup/readiness evidence — 11 September 2026

This is dated native PR #19 evidence, not a current local intake protocol,
local-machine capability claim or permission to reopen the completed packet.

The earlier PR #19 continuation used
[approval 5632491947](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5632491947)
(actual retained Anthropic Claude Opus 5 reviewer `223d6728`, turns 6/7,
coordinator amendments N1–N6/P1–P6) and its own
[runtime receipt 5632583458](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5632583458).
They do not authorize a future session or another packet.

That native continuation's running-job setup proof paired explicit workflow-step
status with timestamp-bound local critical transcripts. Docker/start, reset/fictional
fixtures, actual ignored type generation and tracked/staged cleanliness must
each succeed. A silent cleanliness command needs explicit current step success
plus a bound transcript and fresh source inspection; absence of failure text is
not proof. Setup `PARITY: DIFFERENT` was the expected ignored artifact state at
that earlier `79c99e1` checkpoint, not final tracked parity or permission to adopt
it before entry. It is not the expected state at the later repair start below.

Do **not** demand the downloadable archive of the worker's own still-running
job; the coordinator reviews that archive after termination. This narrow
exception does not waive required completed logs, pinned authority or the own
receipt: missing/failed/ambiguous prerequisites still mean preserve and STOP.
No consumed diagnostic permission is reusable after a failed normal setup.
After valid entry, ordinary within-scope engineering failures remain the assigned
writer's responsibility; do not confuse those with failed entry prerequisites.

The repaired local probe uses originless OPTIONS and the full handler-owned
204/no-store/nosniff/POST signature, independently of gateway ACAO. Its actual
CLI-served and Google-only-synthetic real Auth/DB checks are documented in
`local-backend.md`. They do not prove production/browser CORS, hosted migration,
paid inference or device/visual acceptance, and do not grant worker deployment,
Actions approval/rerun, merge or additional-agent authority.

### B1 identity/failure-evidence repair — 11 September 2026

The entry/runtime and repair instructions below belong to this historical native
continuation only; they grant no local entry, new cloud allocation or B1 assignment.

[Approval 5633782787](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5633782787)
records actual Anthropic Claude Opus 5 critique (reviewer `223d6728`, turns 9/10,
A1–A9/C1–C3) for an eight-path repair starting at `3b58b50793720d0f82a06aee9b54196fcd73715a`.
[Own receipt 5633845391](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5633845391)
belongs only to task `2205a7c4-8f2f-4992-bb1e-c7655dab4e72`, session
`ad8abfaf-1a93-4bda-a91c-9150197f0522`, actual `sweagent-capi:gpt-6-astra`.
Neither is reusable entry authority for another task.

This entry required **matching** ignored/tracked schema types, successful current
setup step metadata bound to local critical transcripts, fresh clean exact
source, then deliberate own-receipt verification before progress/import/test/
edit. That run `34594725266`, job `103247716857`, had successful Docker,
start, reset/fictional-fixture, actual ignored generation and cleanliness steps.
Fresh type bytes matched. The phase-2 append records the exact ordered entry.

The repair adds runtime-identity replacement and bounded served diagnostics as
specified in `local-backend.md`; it does not diagnose the prior failed POST at
11:03:10.978Z. Even a later green run cannot establish that historical cause.
After targeted units/types/lint, preserve the serialized CI database order:
preservation → only on success reset → integration → security → **one** B1
rehearsal → actual types/parity. A new served/rehearsal failure means preserve
STOP with closed evidence, not another repair/rerun or fixture reset. Existing
app/browser/a11y/capture bounds remain mandatory; missing observations or actual
coordinator visual review remain pending. The coordinator owns subsequent
repair-only independent review and authorization of first new exact-head
CI/Apple execution. No worker review substitute, Actions approval/rerun, merge,
deployment, hosted/provider/paid/private-photo operation or additional agent is
authorized.

### B1 startup-state correction — 11 September 2026

The native receipt/page/entry sequence and P4 permission below are historical
for this continuation, not a local numbered-comment-page prerequisite or a
reusable execution exception. Current work follows its own approved local packet.

[Approval 5634444254](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634444254)
supersedes the earlier native-live sequence only for this six-path continuation
from `450ba7337788988f9700e1303421ed567c5c7873`. Actual read-only Anthropic
Claude Opus 5 reviewer `223d6728-9657-4479-8ea0-1da7421db2d3`, focused turn 12,
accepted P1–P4; the coordinator adopted the required corrections and C1
(ps-created may legitimately become same-ID inspect-running between reads).
No new planning agent was commissioned.

Its own [receipt 5634509076](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634509076)
records explicitly selected, platform-GET-verified `sweagent-capi:gpt-6-astra`,
task `bf6f33b6-6bff-4d8e-8a64-1a3646c7ff34`, session
`16efd2a1-c25e-47e5-8cce-7e5b35db0560`. Full context preceded fresh T2 checks:
current run `34599471062` / job `103262980344` had successful critical setup
steps bound to current local transcripts, ignored generated types matched
tracked bytes, and source was clean. Only then was page33/perPage1 deliberately
read and its immutable metadata verified; progress/tests/edits followed T3.
The phase-2 result records the evidence and limits. This receipt is not reusable.

The only changed paths are `scripts/backend/local.mjs`, its `local.d.mts`,
`tests/unit/local-backend.test.ts`, `docs/local-backend.md`, this guide and
`docs/phase-2-result.md`. The correction distinguishes not-started from malformed
runtime metadata, pins the first replacement/start, permits bounded waiting
only before strict confirmation, and preserves default versus explicit command
capture behavior. Production handler/protocol, rehearsal/served children,
SQL/types, setup/CI, packages, images and Save/UI remain unchanged.

P4 permits native targeted/full units, typecheck/lint/diff and changed-file
secret checks only. No post-setup native live/probe/reset/preservation/rehearsal/
typegen/browser/build/capture sequence runs in this task. Historical S1 and served
failures remain unresolved. The coordinator still owns independent repair-only
review and authorization of the first new exact-head CI/Apple run; unchanged
live preservation, normal-owner/security/B1 Auth-DB, final types/parity, App/
browser/translations/build/dependency/secret, eight bounded artifacts and actual
visual review remain mandatory. No source-complete or merge-ready claim follows
from native units/static checks, and no hosted/provider/paid/deployment authority
is added.

## OUTFITGEN1a AI-judged outfit suggestions, backend only - 6 November 2026

Source packet for ADR31 (owner decisions of 6 November 2026; plan approved with binding amendments B1-B5 and S1-S4). Inactive:
nothing here is applied, deployed, consented or activated, and no provider is called. Contract details are in `blueprint/20`,
`blueprint/08` and `blueprint/10`; this section records the engineering evidence and the rollout.

- **Files.** `20261106090000_outfit_generation.sql` (purpose, controls columns, the immutable manifest
  `azure-eu-terra-outfitgen-v1`, `suggested_outfits`, `outfit_assessed_items`, `outfitgen_requests`, the owner and service
  functions, the replaced `private.admin_account_v3` and `private.deletion_owner_rows_absent`, each its latest body plus additions
  only), `20261106090100_outfitgen_expire_schedule.sql` (inactive job), `supabase/functions/outfit-generate`,
  `src/domain/outfitgen.ts`, `src/domain/outfit-candidates.ts`. The admin spending parser and view include the `outfitGen` purpose
  so the history total stays right (`SPEND_PURPOSES`).
- **Validation done.** Unit tests for the candidates, request and verdict contract, the handler (mocked Auth, RPC, Storage and
  provider) and the migration source proofs. The SQL was also executed once on a scratch in-process PostgreSQL (PGlite) over the
  whole migration chain, with stubs for Auth, Storage and pg_cron, as a smoke test of syntax and the main flows. That is not the
  CI rehearsal: concurrency, ACLs, RLS as the authenticated role and the real Storage and Edge runtime are CI-only.
- **CI registration.** `scripts/preservation-rehearsal.mjs` (inventory, stage `outfitgen-prior`, the PASS line),
  `tests/integration/outfitgen.sessions.mjs` (upgrade proof of the two replaced bodies, then claim, finish, dedupe, caps, Keep,
  Remove, Undo, failure, cooldown, expiry, stale handling and owner isolation), `scripts/isolation-catalog.mjs` and the audit probes,
  `scripts/run-deletion-rehearsal.mjs`, `scripts/backend/ci-storage-guard.mjs`, `scripts/backend/local.mjs` (the function inventory).
- **Rollout (each step a separate owner or coordinator gate; none is done by this packet).** 1. Confirm the Azure TPM/RPM quota of
  the Terra deployment (the documented 20K TPM / 20 RPM is historical and unverified). 2. Apply `20261106090000`, `20261106090100` and
  `20261107090000` (Undo respects the cap of 40 pending suggestions; added by the 1b review). 3. **Activate the `stillroom-outfitgen-expire` job before the first trial:** a request whose reply is never
  finished (runtime termination is not covered by background work) stays held until it settles. 4. Deploy `outfit-generate`.
  5. OUTFITGEN1b (the app: Settings card, Suggested outfits list, triggers). 6. Bootstrap the owner's controls (manifest, notice 1,
  maximum request at least the reservation). 7. The owner consents and runs the trial.
- **Owner trial plan.** With real photos: one manual run, review of the first ~30 suggestions (kept against removed, any clash,
  any duplicate), tokens, cost and time per call from the ledger, any 429, then a second run after adding two garments (only
  sets with the new garments should appear). Tuning (score bar, garments per call, prompt wording) is a new manifest version.

## OUTFITGEN1b suggested outfits in the app - 6 November 2026

Source packet for the app side of ADR31, after OUTFITGEN1a (merged). Contract details are in `blueprint/20`; this records the
engineering evidence and what stays open. Nothing here is deployed or activated; the hosted rollout order of 1a still applies
(Azure quota gate G1, migration, expiry job active before the first trial, Edge deploy, then the owner's consent), and a Pages
deploy of this packet is a separate owner step.

- **Files.** `src/domain/outfitgen-app.ts` (closed replies, view per state, automatic-run policy), `src/data/outfitgen.ts`,
  `src/features/outfitgen/{outfitgen-store,outfitgen-trigger,use-outfitgen}`, `src/features/settings/outfitgen-settings.tsx`,
  `src/features/outfits/suggested-outfits.tsx`, the lazy catalogue `src/i18n/outfitgen.json` (registered like try-on's), wiring in
  `app.tsx`, `outfits-screen.tsx` and `ai-features.tsx` (plus the `outfits` spend source).
- **Validation.** Unit: `tests/unit/outfitgen-app.test.ts`, `tests/unit/outfitgen-notice.test.ts`. Browser: `tests/browser/outfitgen.spec.ts`
  on the mock backend (`outfitgenControl`), with the writes counter of `outfits.spec.ts` ignoring the read-only status and list calls.
  `npm run check:translations`, typecheck and lint.
- **Review fixes (Sol, PR #210).** A run is gated again right before the request is sent (consent change pending, consent off, limit, offline, newer Save), so Turn off can't race a run; a newer Save supersedes an older trigger even while it loads; a list read that began before a decision can't bring a decided card back; status and list parsers read counts above the server cap instead of refusing them; Undo answers PENDING_FULL when 40 suggestions are pending (forward migration `20261107090000_outfitgen_undo_capacity.sql`, its exact-body proof in `tests/unit/outfitgen-schema.test.ts` and a probe in `tests/integration/outfitgen.sessions.mjs`). Accepted residual (lean mode, one owner): two Undos, or an Undo racing a run's recording, at exactly the cap can overshoot to 41 pending; the parsers read such counts and nothing breaks. The notice now says that kept, removed and judged-but-not-suggested sets stay stored (reason and garment list; nothing expires on time) until one of their garments is permanently deleted or the account is.
- **Not verified here.** Real Azure behaviour, how long a run takes on a phone, and whether a mobile browser keeps a 90-second
  request alive while the app is in the background (a cut request ends as a quiet failure and the server expiry job settles it).