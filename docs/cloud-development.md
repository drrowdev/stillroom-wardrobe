# GitHub Copilot cloud development

Development now uses persistent isolated LOCAL implementation writers (at most
two builders, one writer per branch; updated 24 September 2026) against
`drrowdev/stillroom-wardrobe`. No new cloud/native coding
allocation, wrapper, retry or automatic fallback is authorized. GitHub Actions
remains CI, not a coding agent. This historical title/path and all existing
headings/anchors remain for evidence-link compatibility. Source is public;
account credentials, photos, backups and local service state must never be published.

## Leaner process - 24 September 2026

Updated 24 Sep 2026 (owner decision): leaner process. The owner approved it in
the coordinator session on 24 September 2026 at about 18:10Z. Where older text
in this guide or the root instructions conflicts, this section wins. Historical
PR, comment and receipt references stay as evidence.

**Planning by risk tier.**

* **Tier A**: database schema or hosted database changes, AI/provider/cost/consent,
  auth/security/privacy, deletion/data integrity, and CI infrastructure. Write a
  plan and get ONE read-only GPT-6 Astra plan critique. The coordinator applies
  its findings as binding amendments and approves. There is no second review
  round unless scope, authority or behaviour changes materially.
* **Tier B**: UI, copy, docs, tests and small features without schema changes.
  The builder writes a short plan; the coordinator approves it directly. No plan
  critique.

**Code review.** Every change gets ONE read-only GPT-6 Astra code review before
merge. A repair of its findings gets a quick delta check only when the fix is
non-trivial. The coordinator reviews routine CI fixes inside an approved packet.

**Evidence.** Keep the PR description (scope, validation, what is pending), the
review verdict, green exact-head CI for all required jobs, coordinator visual
review of UI captures and a short coordinator merge note. Release files with
checksums, per-file SHA256 receipts, publicly posted model attestations and
"stage exactly N files" instructions are no longer required. The coordinator
still verifies the builder's actual model from session logs and notes it in the
merge note.

**Local validation.** Builders run `npm run lint`, `npm run typecheck`,
`npm run check:translations`, `npm run test:unit` and the browser specs their
change affects. The full browser, integration and security suites run in CI.
Builders report honestly what they did not run.

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
per branch; at most two implementation builders; model policy: Claude Opus 5.5
builds, GPT-6 Astra critiques and reviews
([PR #32 comment 5795033115](https://github.com/drrowdev/stillroom-wardrobe/pull/32#issuecomment-5795033115)).
Text-only builders, local tooling rules and no cloud coding allocation also
stay as below.

## Local development policy - 11 September 2026

The [user decision at 2026-09-11T12:49:58.200Z](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634772726)
and [actual different-provider critique/coordinator-approved cutover](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634938691)
supersede the former cloud default and two-cloud-builder allowance. Keep one
approved packet/branch/PR and one writer per workspace. Routine scoped repairs
stay in the same persistent local session. Genuine read-only review remains
separate; workers never launch another agent or packet. Never implement in the
main checkout or the coordinator's old read-only checkout. The coordinator
records owned files, dependencies and shared-resource owners before assignment;
do not stop, reset or mutate unrelated services.

Explicitly select **Anthropic Claude Opus 5.5 (`claude-opus-5.5`)** for each new
local implementation builder, per the
[owner decision of 23 September 2026](https://github.com/drrowdev/stillroom-wardrobe/pull/32#issuecomment-5795033115).
Required different-provider critique, rubber-duck and review work uses **OpenAI
GPT-6 Astra (`gpt-6-astra`)**, read-only. Sessions held before that decision keep
their recorded models and results; for example, PR #32's GPT-6 Astra writer keeps
its Anthropic Claude Opus 5 review. A model name in a prompt is not proof. The
owner reconfirmed GPT-6 Astra for critique and rubber-duck work in the
coordinator session on 23 September 2026 at about 12:49Z; public copy in
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

The tiered plan critique and the one GPT-6 Astra code review (leaner process
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
  This is the latest cited Pages deployment.

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
  - The profile review expires on 21 October 2026, per the AZ1 source contract
    in this guide.
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

**Scope.** Recorded as live by these comments: add/edit/Save/photo replacement,
AI-filled details for the owner's account only, and the simplified UI (L1a, L1b,
L2a). Not built: outfits, suggestions and weather (Phases 3–5). The owner moved
the calendar (I12/I13: date planning, marking worn, wear counts and
cost-per-wear) to the backlog at about 12:12Z on 24 September 2026
(`5815445262`); Phase 3 continues with I11 outfits only, and Phase 4 suggestions
must not depend on wear history for now. This is not the owner's full core
workflow and not Phase 0 or product acceptance.

| Gate | Current evidence / next step | Responsible actor |
|---|---|---|
| Backend installation | The eleven Phase 0–2 source migrations are installed (23 September mapping above, including the manual M11 row). The two COL1 migrations were recorded as applied at R1 on 24 September (`5815899879`); see COL1. Future hosted DDL needs separate approval. | Coordinator/operator; cloud source worker must not access it |
| Hosted Auth | User-confirmed dashboard settings in the dated snapshot above; one owner's ordinary sign-in passed in the 23 September smoke test. Email delivery remains unproved. No arbitrary preview/wildcard redirect or inference from local TOML/SQL. | User dashboard confirmation; coordinator/operator tracks remaining gates |
| Intended owners | Privately reserved/created by the user; aggregate administrative evidence above. One owner's ordinary sign-in, own Save/reload, edit, photo replacement and sign-out/in passed on 23 September. Second-account use and negative cross-account RLS/Storage checks remain OPEN (second-account test user-deferred). Credentials stay private; never use local reserve/provision scripts on hosted. Password/account/recovery setup is outside the smoke runner. | User handles private credentials; approved private operator verifies ordinary-session access |
| Website | Git-backed Pages project `stillroom-wardrobe` created; selected GitHub repo access verified. Automatic production deployments OFF, preview deployments NONE, no production backend in preview environment. Deployments since 23 September are owner-run create-deployments of production main HEAD. | Coordinator through official Cloudflare connection only |
| Live deployment | Latest cited deployment: `27a1c642` of `3ed08147` (PR #36 comment `5813432944`, 24 September). Earlier: `f0016398` and `6e01b747`; the 6 September shell `91462a90` is history. Each replacement needs separate approval and fresh evidence. A deployment is not acceptance. | Coordinator; owner runs the create-deployment |
| Edge Functions | Three functions v1 ACTIVE, `verify_jwt=true`, source-identical as recorded on 23 September (`5800183953`). COL1 R3 (functions) was recorded as not yet done at R1 on 24 September (`5815899879`). The out-of-EU Edge location is accepted for the 23 September test rollout only, with owner test photos; general residency remains OPEN. Redeployment needs separate approval. | Coordinator/operator with owner approval; source writers have no access |
| Photo analysis (AI) | Activated for the owner's account only on 23 September (`5815445262`): `azure-eu-terra-devtest-v1`, prompt 1, notice 2, a USD 20/month application allowance (not an invoice ceiling), 20 requests per hour, 3600 s result TTL, review expiry 21 October 2026. The 24 September single-photo probe had no anomaly. Still open: scheduled purge (manual clearing for now; source job ready inactive, hosted H1 pending, H2 activation needs owner approval, physical retention PENDING until H3), other accounts, quality (see COL1), privacy/retention and device acceptance, and renewal before expiry. | Owner decides; coordinator/operator executes each change |
| Not built / backlog | Outfits, suggestions and weather (Phases 3–5) are not built. The calendar (I12/I13) is in the backlog (`5815445262`). Hosted deletion and recovery flows are not exercised. | Owner prioritises; separate approved packets |
| Hosted smoke | BLOCKED until both intended ordinary sessions and prepared non-personal item/main/thumb fixtures exist. Run the separate read-only command below privately and report only coarse result plus reviewed code head. The 23 September owner journey was a manual single-account check, not this two-owner runner. | Approved private operator, not cloud agent or public CI |
| Phone/accessibility | Actual iPhone/Safari and Android camera/library, rotation/compatible-photo fallback, explicit Save/Discard, own login/logout, EN/FI/SV, VoiceOver/TalkBack and narrow/zoomed layout checks remain open. Emulation/axe is insufficient. | Human owners/testers |
| Code/merge | All required exact-head gates, including App/browser, WebKit photo contracts, Real local Supabase/type parity, native Apple and I06 artifact visual review, plus genuine independent review, no blockers/overlapping writers and normal protections. Under [H1 clarification 5580579847](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580579847), the coordinator may execute a recommended ordinary merge without another user question; record recommendation/evidence and guard the exact head. No `--auto`, `--admin`, self-approval or protection bypass. | Cloud worker reports checks, never merges; coordinator reviews, records recommendation/evidence and executes the exact-head ordinary merge |

Pages production configuration contains only public `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION` and build-only
`NODE_VERSION=24.19.0`. No administrator secret, Cloudflare Pages
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
The profile review expires on 21 October 2026 at 00:00 UTC.

The six explicit input/output/total/reasoning/cache-read/cache-write counters
have no missing-to-zero defaults. Input/output rates are respectively
USD 4.40/19.80 per million tokens; their combined estimate is rounded up once
to micro-USD. The 4,097,351 micro-USD reservation is allowance arithmetic, not
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

Delivery uses the persistent isolated local writers and the model-check contract
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
   24 September 2026). Tier A gets ONE read-only OpenAI GPT-6 Astra
   (`gpt-6-astra`) plan critique; record provider/model and findings, which the
   coordinator applies as binding amendments before approving. Tier B gets a
   short plan approved directly by the coordinator. The
   historical I06 plan/amendment and actual **Anthropic Claude Opus 5** critiques
   are linked above, not approval for this task. PR #2 `5559949209` and
   `5560449572`/`5560847183` also remain
   historical evidence, not current-packet approval. Automated validation/self-review is
   supplemental, not that prereview; do not invent a native review tool.
3. Explicitly select **Anthropic Claude Opus 5.5 (`claude-opus-5.5`)** and enter
   each new local implementation session read-only (plan mode) for planning
   only (owner decision `5795033115`). The coordinator's plan approval is the
   edit permission; the builder then runs in autopilot. The coordinator checks
   the builder's OWN actual model usage in session logs against the
   app/CLI/repo/workspace/branch, base head and scope and notes it in the merge
   note. Fresh source and session/model continuity remain mandatory. Local
   telemetry has the weaker provenance described above, not native-receipt
   equivalence. A mismatched model means STOP; no Auto, silent fallback or
   unverified implementation. A material amendment to a Tier A plan (scope,
   allowed files, authority or behaviour) gets another critique; routine
   corrections do not. Stop if the required model or reviewer is unavailable.
4. Keep persistent isolated LOCAL implementation writers: at most two
   implementation builders, one writer per workspace/branch/PR and one focused
   approved packet per writer, with genuine on-demand read-only review. The
   former two-cloud-builder allowance is superseded historical policy. Routine
   scoped failures stay in
   the same session; no main/coordinator-checkout implementation. Before
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
   read-only GPT-6 Astra code review before merge.
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
