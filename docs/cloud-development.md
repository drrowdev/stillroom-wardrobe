# GitHub Copilot cloud development

Development continues in GitHub-hosted Copilot sessions against
`drrowdev/stillroom-wardrobe`. Source is public; account credentials, photos,
backups and local service state must never be published.

## Prepared environment

`.github/workflows/copilot-setup-steps.yml` contains the required single
`copilot-setup-steps` job on a standard Ubuntu runner. It installs pinned Node 24,
locked npm dependencies and Chromium, then starts disposable local Supabase,
applies the exact base migration, provisions fictional accounts and generates
real database types. Docker images are downloaded during setup, before the
agent's normal network restrictions take effect.

No production Supabase access, paid AI endpoint, larger runner, firewall
disablement or user-supplied production secret is required by cloud setup.
The separately approved hosted project is in Stockholm (`eu-north-1`).

Setup failures are not passes: Copilot may still start in a partially prepared
environment. First inspect its setup log and `git status`, then confirm the
local stack with `npm run db:start` rather than assuming services survived.
Do not reset a useful in-progress fixture unless recovery requires it.

The generated `src/data/database.types.ts` can initially be untracked. Review
and commit it deliberately; never sweep `.env.local`, `.supabase`, browser
state, test results or logs into a commit. These are ignored. The test wrapper
passes ordinary fictional credentials to its child processes and strips
privileged/GitHub credentials.

## Active cloud task: I06 personal settings on PR #7

8 September 2026: the user authorized **continuing through the agreed MVP in
order**. Phase 0 is **engineering complete; acceptance open** at base main
`7f6e13a89603492e933748b6558b493d3d74e855`. Only the second hosted-account test
was explicitly deferred; other operator/device/screen-reader checks remain
pending, not waived. Bring back a manual gate when it genuinely blocks a feature.
Historical packet restrictions below do not veto a separately approved next packet.

The current writer finishes saved I06 on existing PR #7,
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
coordinator approval before edits. It adds only `.github/workflows/ci.yml`'s App
artifact step to the allowlist. No new plan, branch, PR, agent, schema, dependency,
local CLI, JPEG, garment Save, recovery, provider, hosted operation or I07/I29 work.
One writer owns this workspace/branch/PR.

After context and before continuation edits, the writer reread
[receipt 5579937425](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5579937425):
coordinator explicitly selected and authenticated-GET verified actual
`sweagent-capi:gpt-6-astra`, task `210fb893-7617-4dc1-88ef-eae5272e2ab6`,
session `c40a8a6b-551d-4831-8703-691b138c980a`, observed
`2026-09-08T05:47:29.6473139Z`, against this exact PR/base/saved head.
This is the coordinator's runtime evidence, not a worker self-attestation or a
receipt reusable by another task. New tasks/retries need their own matching receipt.

### Text-only worker and retained visual gate

The two preceding native sessions reported `CAPIError: 400 Error while downloading
file. Upstream status code: 404`; the latest followed viewing a temporary PNG.
The missing upstream URL and causal app-code involvement remain unknown.
The single approved alternative keeps Astra but excludes **all model image inputs**:
no image/binary/archive opening, image-returning tools, image attachments, encoded
image output or Markdown image embeds. If the same failure recurs without image
input, preserve the head and report a platform blocker; do not spawn more retries.

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

The coordinator first reviews the workflow/executable diff, then handles
current-head CI authorization and independent review. The coordinator must
download the exact-head artifact outside the repository, verify run/head/contents,
actually view both PNGs, and record run/head/PNG SHA256s/verdict in a PR #7
review/comment and session ledger. No source commit merely records its own head.
Artifact existence or DOM checks are not a visual verdict; absent/unread images
leave acceptance pending. A primary test failure is retained, not relabelled an
artifact failure. [Phase 1 results](phase-1-result.md) record worker commands,
rollback and pending gates; final visual evidence is linked from PR #7.

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

The dated 6 September PR #2 handoff and subsequent PR #3 recovery restrictions
remain historical evidence. Current ordered development follows the approved I06
packet above, not a permanent Phase-0-only pin. Do not reopen merged PRs or push
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
deterministic outfits. No I07/I29 or later feature is authorized inside I06.

Before every implementation packet:

1. Read active root/Copilot instructions, cloud and phase/backend evidence,
   relevant blueprint requirements/work packets, actual schema/source/tests,
   PR body/discussion/diff/reviews and CI job logs. Record exact base/head,
   files actually consulted and unresolved gates.
2. Write a focused plan before edits. Obtain an actual different-provider,
   read-only critique; record provider/model, findings and amendments. The
   active I06 plan/amendment and their actual **Anthropic Claude Opus 5** critiques
   are linked above; PR #2 `5559949209` and `5560449572`/`5560847183` remain
   historical evidence, not current-packet approval. Automated validation/self-review is
   supplemental, not that prereview; do not invent a native review tool.
3. Before every implementation task and retry, explicitly select **GPT-6 Astra
   (`gpt-6-astra`)**. The coordinator verifies and records the actual runtime/platform
   model for that task/session, time and exact base/head, not another task's evidence
   or a name in a prompt. No Auto, silent fallback or unverified implementation.
   Every new implementation plan/material amendment requires actual read-only
   different-provider critique (reviewer/provider/model, findings and amendments),
   then coordinator approval before edits. Material means changes to scope, allowed
   files, authority, behaviour, gates or evidence claims, not typo/formatting edits.
   Stop if the required model or reviewer is unavailable.
4. Follow the root local/cloud distinction: one writer on the shared **LOCAL**
   checkout; initially at most **two coordinator-approved independent CLOUD
   implementation builders** plus on-demand read-only review. One writer per
   workspace/branch/PR and one focused approved packet per agent. Before launch,
   the coordinator names active packets/branches, owned files, dependencies and
   shared mutable-resource owners. Never concurrently mutate the same branch or
   shared host resources. The corrected common-base prerequisite was merged in
   PR #2; no additional builder is authorized by this one-writer I06 continuation.
   Session SQL/coordination notes do not change repository authority. Merges,
   hosted DDL and deployments remain serialized and separately authorized; actor/
   credential restrictions still apply. Concurrency itself authorizes no new
   packet/PR, phase, dependency, provider or hosted operation. The coordinator
   handles routine scoped fixes/reviews/CI; consequential decisions go to the user.
5. Report exact validation commands/results and fresh-head CI status.
   Coordinator authorization governs CI reruns/approval; do not bypass it.
   Physical-phone/Safari, camera/library, VoiceOver and TalkBack acceptance
   remains a human gate, not something Chromium emulation or axe proves.

The setup workflow must be on the default branch before it can prepare cloud
agent sessions. It also supports a manual Actions run for setup diagnostics.
Cloud agent availability and usage are governed by the account's GitHub
Copilot settings and plan; no completion is implied merely by configuring
this file.
