# GitHub Copilot cloud development

Development now uses **one persistent isolated LOCAL implementation writer
overall** against `drrowdev/stillroom-wardrobe`. No new cloud/native coding
allocation, wrapper, retry or automatic fallback is authorized. GitHub Actions
remains CI, not a coding agent. This historical title/path and all existing
headings/anchors remain for evidence-link compatibility. Source is public;
account credentials, photos, backups and local service state must never be published.

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

Explicitly select **GPT-6 Astra (`gpt-6-astra`)**. Start each local implementation
session read-only until the coordinator independently retrieves the writer's OWN
documented machine-readable actual-model usage outside the writer's turn output.
Cross-match active app/CLI identity, repository, workspace, branch, exact
base/start head, observation time and approved scope. Publish a
**coordinator-observed local model attestation** and explicit edit permission;
the writer reads both after context and before edits, with fresh source/scope
checks. Link the eventual PR when it exists; never invent a native task or PR ID.
Requested model names, another session's evidence, stale/mismatched identity
or unavailable proof mean STOP, not Auto/fallback. Maintain same
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
reviews approved exact-head artifacts and records run/head/hashes/verdict.
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

Genuine different-provider material-plan critique and final review, all required
exact-head automated/live/type/App/browser/native-Apple/coordinator-visual gates
and normal merge protections remain mandatory. Unavailable review is not a pass.
Phase 0 remains **engineering complete; acceptance open**; only the second
hosted-account journey was deferred, not other operator/device/human checks.
Paid activation, private-input processing, hosted mutations and deployment retain
separate approval. Source writers receive no hosted credentials;
`ALLOW_HOSTED_SMOKE` remains unset in implementation sessions. The dated hosted
actor evidence below is preserved, not a fresh hosted-state observation.

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
For each local packet, the controlling scope is the specific coordinator-approved,
actually reviewed packet and public plan URL supplied in its authorized kickoff,
followed after context by that writer's own matching coordinator-observed local
model attestation and explicit edit permission before edits. Native receipts and
cloud setup/intake requirements below are dated evidence, not local entry proof.
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
own matching receipt; current local entry uses the attestation contract above.

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

| Gate | Current evidence / next step | Responsible actor |
|---|---|---|
| Backend installation | Exact base SQL installed once; mapping above preserved. No I29 extension or AI activation. | Coordinator/operator; cloud source worker must not access it |
| Hosted Auth | User-confirmed dashboard settings in the dated snapshot above; ordinary password login and email delivery remain unproved. No arbitrary preview/wildcard redirect or inference from local TOML/SQL. | User dashboard confirmation; coordinator/operator tracks remaining gates |
| Intended owners | Privately reserved/created by the user; aggregate administrative evidence above. Ordinary password access, own Save/reload and negative RLS/Storage checks remain OPEN. Credentials stay private; never use local reserve/provision scripts on hosted. Password/account/recovery setup is outside the smoke runner. | User handles private credentials; approved private operator verifies ordinary-session access |
| Website | Git-backed Pages project `stillroom-wardrobe` created; selected GitHub repo access verified. Automatic production deployments OFF, preview deployments NONE, no production backend in preview environment. | Coordinator through official Cloudflare connection only |
| Live deployment | Reviewed-main shell verified in the dated observation above; no PR #2 deployment. Replacement requires separate authorization and fresh evidence; shell reachability is not hosted acceptance. | Coordinator |
| Hosted smoke | BLOCKED until both intended ordinary sessions and prepared non-personal item/main/thumb fixtures exist. Run the separate read-only command below privately and report only coarse result plus reviewed code head. | Approved private operator, not cloud agent or public CI |
| Phone/accessibility | Actual iPhone/Safari and Android camera/library, rotation/compatible-photo fallback, explicit Save/Discard, own login/logout, EN/FI/SV, VoiceOver/TalkBack and narrow/zoomed layout checks remain open. Emulation/axe is insufficient. | Human owners/testers |
| Code/merge | All required exact-head gates, including App/browser, Real local Supabase/type parity, native Apple and I06 artifact visual review, plus genuine independent review, no blockers/overlapping writers and normal protections. Under [H1 clarification 5580579847](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580579847), the coordinator may execute a recommended ordinary merge without another user question; record recommendation/evidence and guard the exact head. No `--auto`, `--admin`, self-approval or protection bypass. | Cloud worker reports checks, never merges; coordinator reviews, records recommendation/evidence and executes the exact-head ordinary merge |

Pages production configuration contains only public `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION` and build-only
`NODE_VERSION=24.19.0`. No administrator secret, Functions/bindings, paid hosting
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

## Delivery rules

Delivery uses the persistent isolated local writer and own-model attestation
contract above, not cloud/native allocation or historical setup/intake authority.
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
recommendation/evidence and guard the exact head. No `--auto`, `--admin`,
self-approval or protection bypass. Workers never merge, deploy, approve/authorize/
rerun Actions or start another agent or packet.

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
2. Write a focused plan before edits. Obtain an actual different-provider,
   read-only critique; record provider/model, findings and amendments. The
   historical I06 plan/amendment and actual **Anthropic Claude Opus 5** critiques
   are linked above, not approval for this task. PR #2 `5559949209` and
   `5560449572`/`5560847183` also remain
   historical evidence, not current-packet approval. Automated validation/self-review is
   supplemental, not that prereview; do not invent a native review tool.
3. Explicitly select **GPT-6 Astra (`gpt-6-astra`)** and enter each local
   implementation session read-only. After context and before edits, read the
   matching coordinator-observed local model attestation and explicit permission,
   independently bound to OWN actual usage, active app/CLI/repo/workspace/branch,
   base/start head, time and scope. Fresh source and session/model continuity
   remain mandatory. Local telemetry has the weaker provenance described above,
   not native-receipt equivalence. Missing/mismatched proof means STOP;
   no Auto, silent fallback or unverified implementation.
   Every new implementation plan/material amendment requires actual read-only
   different-provider critique (reviewer/provider/model, findings and amendments),
   then coordinator approval before edits. Material means changes to scope, allowed
   files, authority, behaviour, gates or evidence claims, not typo/formatting edits.
   Stop if the required model or reviewer is unavailable.
4. Keep **one persistent isolated LOCAL implementation writer overall**, one
   writer per workspace/branch/PR and one focused approved packet at a time,
   with genuine on-demand read-only review. The former two-cloud-builder
   allowance is superseded historical policy. Routine scoped failures stay in
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
5. Report exact validation commands/results and fresh-head CI status.
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
