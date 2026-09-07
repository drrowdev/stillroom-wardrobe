# Phase 0 - result

Date: 6 September 2026. PR #1 was merged with explicit user approval into
`f696ee45e5dfe46be90cbc295a9811ec1d34a298`. Phase 0 I01–I05 hosted readiness
continued on now-merged PR #2; the approved password-recovery follow-up is PR #3.
Full Phase 0 is **not complete**. Earlier reset failures,
accessibility findings and their later repairs remain below as historical
evidence. No new merge or next phase is authorized.

## PR #3 password-recovery continuation

6 September 2026. Starting head
`56102303d84b20d53c2b15f024330f434d4e154e`, branch
`copilot/approved-phase0-password-recovery`; base main
`20ec93041f1d90d9a9f684b7358ea2b9715527e1`. Scope: approved Phase 0
I03/I05 Auth unblocker, preserving R01/R11/R17/R19/R22/R26/R27. No later phase,
new dependency, schema/type hand-edit, profile-helper change or hosted operation.
The source/test/docs changes stay inside the approved 25-path packet.

Read full PR #2 plan `5561361106` and controlling approval `5561846573`:
actual read-only **Anthropic Claude Opus 5**, two turns before implementation,
with original-access transport enforcement, opaque-refresh refusal, unselected
server target confirmation, early scrub/in-flight normal-mode isolation, honest
update/revocation uncertainty, privacy-safe real mail/context separation and
ordinary cleanup corrections. User choices: raw 24-character floor and
recovered-owner global sign-out. No new scope decision or replacement review.
PR #3 amendment `5562318484` and cold gate `5562445077` were also read.
Coordinator receipt `5562454517`, re-read before edits, verifies this session's
actual native model; exact task/session/time/base/head are in the
[cloud handoff](cloud-development.md#active-cloud-task-approved-phase-0-password-recovery-on-pr-3).
Historical receipts were not reused.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
README and cloud/Phase-0/local-backend docs; blueprint `00/03/05`, relevant
admission/RLS `07`, Auth/error `08`, `10/12/13`, Phase 0 in `14`, I01–I05 in
`15`, relevant `17/18/19/20/21`; actual migration/generated schema excerpts;
Auth/session/stored-session/Login, app/bootstrap, client/config/profile, i18n,
styles, unit/browser/integration/security/local tools and CI; package/pinned
SDK implementation; PR history, comments/diff/reviews/checks and cold CI job
logs. No credential cache or privileged service key was printed.

### Protocol and UI evidence are distinct

Cold CI `34061709323` attempt 2 at `56102303` passed Real Supabase
`101564798717` and App/browser `101564798990`. It established fresh-stack
readiness only. This session did not restart/reset services, change configuration
or reproduce the earlier warm-restart 503; that cause remains unproven.

Protocol-only local SDK/Auth feasibility passed first, committed as
`ba40ad6b8c6361c6c6925da63fc674362b98be75`. It accepted a raw 72-byte password
under unchanged `secure_password_change=true`, without nonce/current-password/
MFA workaround, and verified affirmative global logout, new/old login behavior,
B's pre-existing refresh and ordinary restoration. It was not UI acceptance.

Initial harness attempts failed on Mailpit-vs-old-Inbucket endpoint/ID assumptions
and serving the actual redirect; no Auth setting was weakened. The first real
UI run failed before password entry because the parser omitted pinned Auth's
standard empty `sb` marker. Both original accounts were verified; no password
update occurred in that UI failure. The corrected parser accepts only a single
empty optional marker, not another callback flow. The subsequent **real UI
journey passed**, then all 11 real security stages passed sequentially.

That journey closes requester R, consumes the actual link in new no-opener A
in context C with B's ordinary tab, explicitly confirms the server target,
resets once, affirmatively revokes globally on the isolated session, returns to
normal Login, verifies new-password UI login/old-password refusal, checks B's
pre-existing ordinary Node refresh/browser data and both owners' synthetic
item/image/profile preservation, then self-restores/cleans up and verifies both
original ordinary logins. See the [local test contract](local-backend.md#real-local-password-recovery).
Mocked negatives/races and emulation are not live or physical-device proof.

Initial targeted checks passed. A full browser run then found one new
keyboard-focus test failing in both projects (96/98 passed); Continue's focus
transition was repaired, and targeted keyboard/paste tests passed in both.
Final complete command run, after those repairs (all exit 0):

| Exact command | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm run check:translations` | 336 keys, EN/FI/SV, 26 source files |
| `npm run test:unit` | 238 tests, nine files |
| `npm run test:browser -- --retries=0` | 98 cases, desktop/emulated mobile |
| `npm run test:a11y -- --retries=0` | 10 cases |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Existing real ordinary suite plus actual recovery UI journey; originals/cleanup verified |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | All 11 real stages, run after integration |
| `npm run db:types -- --check` | Actual local generation, exact committed parity |
| `git ls-files --error-unmatch src/data/database.types.ts` | Tracked |
| `git diff --exit-code -- src/data/database.types.ts` | No drift |
| `npm run build` | Pass; JS 149.76 kB gzip; non-failing 500 kB uncompressed chunk warning |
| `npm run scan:secrets` | 136 text files; fresh unprinted canary checked |
| `npm run check:dependencies` | 12 production/220 development packages; zero reported production vulnerabilities |
| `git diff --check` | Pass |

Build/scan used the same process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`, exported without printing.
No new tools/dependencies or warning-threshold changes. The immutable code head,
scope/secret checks and automated review are recorded in the PR report;
fresh-head CI and independent final review remain separate gates.

After that full run, a final UI-only cleanup clears in-memory password fields
on external cancellation/admission loss/expiry. Repeated lint, typecheck,
`git diff --check` and
`npm run test:browser -- tests/browser/recovery.spec.ts --grep 'logout cancels|lost own-profile|expiry margin|confirmed password success' --retries=0`
passed (eight cases). The full/live suites were not repeated for that cleanup.

No hosted access or password policy was measured. The existing hosted account,
shell, ordinary-session RLS/Save/smoke and human-device gates below remain open.
No merge/deployment or paid activation was performed or authorized to this worker.

## Historical PR #2 hosted-readiness packet

Starting base: `f696ee45e5dfe46be90cbc295a9811ec1d34a298`; exact starting head:
`5a61a942289d7c7a296fab2237d4d7938b1f641c`,
`copilot/phase0-hosted-backend-deployment`. Scope: I01–I05, principally I02/I05
and R01/R11/R12/R19/R23/R26/R27. The clean starting diff changed only the three
reviewed instruction/handoff files. No merged foundation re-audit or new plan
scope was introduced.

Read before edits: PR #2 approval `5559949209`, installed-backend evidence
`5559976584`, previous blocker `5559977267`, and reviewed control-plane repair/
hosting update `5560093343`. The coordinator records genuine read-only
**Anthropic Claude Opus 5** critique before approval, including exact-host
isolation, server identity verification, two-sided positives/denials/liveness,
nonzero incomplete evidence, no hosted mutations and separate actor gates.
This is the coordinator's published refinement, not a claim to possess the
planning task's unavailable full transcript. No material scope amendment.

GPT-6 Astra was explicitly selected. Local runtime `assistant_usage_events`
records report `gpt-6-astra` for this session
`11bf777c-5a39-46d0-8675-4a162ede1284`, whose repository working directory and
creation time (2026-09-06 15:07:45 UTC) match this retry. Coordinator platform
verification remains independently reviewable; this does not attest any other
session's model. One writer, no Auto/fallback or additional implementation task.
Active root/session instructions now permit PR #2, resolving the prior blocker.

Added only `scripts/hosted-smoke.mjs`, its `.d.mts` and
`tests/unit/hosted-smoke.test.ts`; updated only the five approved active
documents. The runner uses privately provided existing ordinary access tokens,
expected UIDs and prepared item/image IDs. GET-only server identity, owner
profile/item/image/main/thumb positives, both foreign read/download denials and
repeated own identity/positives are mandatory. No login/refresh/logout, email,
account/row/object/policy/schema writes, privileged credential, arbitrary URL,
redirect, local-guard modification, dependency, UI, migration or CI change.
Private response content and inputs never enter output.

### Hosted evidence and unresolved gates

Coordinator installed the base SQL **once**, not this cloud worker:
`supabase/migrations/20260905000000_initial.sql`, **35214 bytes**, SHA-256
`4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5`,
maps to remote **`20260906144202_initial_wardrobe`** with matching stored SQL.
Project **AI Wardrobe**, `xwrdrugastphdiihzuia`, organization
`murdxzxflzlbyrnpwbqg`, Stockholm `eu-north-1`. No automatic hosted `db push`,
replay, reset or history repair; future reconciliation requires separate review.

Installation observations: 12 RLS-enabled tables, private JPEG-only `wardrobe`
bucket limited to 512000 bytes, three owner Storage policies (no UPDATE), three
admission/email triggers, zero approval rows/Auth users. Advisors: two
informational deny-all private-table notices and four authenticated checked
SECURITY DEFINER image/restore warnings. Preserve those notices without broader
grants. Admin structure/advisors are not ordinary-user hosted RLS evidence.

Coordinator also created only the git-backed Pages project
`stillroom-wardrobe`, automatic production OFF/previews NONE, with no production
backend in previews. Deployment `91462a90-2f8c-40bf-a828-6a800ce19f33` of reviewed
CI-green main `f696ee45e5dfe46be90cbc295a9811ec1d34a298` was queued, **not verified
live here**. URL: `https://stillroom-wardrobe.pages.dev`. Public VITE URL/key/
version plus build-only `NODE_VERSION=24.19.0`; no privileged secrets,
Functions/bindings, paid hosting, PR #2 deployment or automatic workflow.

**Coordinator live-shell update, 6 September 2026:**
[review 5125863611](https://github.com/drrowdev/stillroom-wardrobe/pull/2#pullrequestreview-5125863611)
records successful deployment `91462a90-2f8c-40bf-a828-6a800ce19f33` of reviewed
main `f696ee45e5dfe46be90cbc295a9811ec1d34a298`, not PR #2. At
`2026-09-06T15:09:25Z`, root, JavaScript, CSS and SPA fallback at
`https://stillroom-wardrobe.pages.dev` returned HTTP 200. Main JS contained the
approved Supabase URL; CSP, no-referrer and nosniff were observed. A later
coordinator read confirmed the same successful deployment, automatic production
OFF/previews NONE. This supersedes queued as current status without rewriting the
earlier worker observation above. Evidence covers only this reachable static
shell; a replacement needs fresh proof. No cloud-worker hosted check occurred.

**Dashboard/provisioning snapshot, 6 September 2026:**
[approval 5560847183](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560847183)
records user dashboard confirmation of public signup OFF, anonymous sign-in OFF,
Email enabled, Phone/all social providers disabled, and Site URL plus sole
Redirect URL `https://stillroom-wardrobe.pages.dev`. The user privately reserved
the intended emails and created both accounts through Auth Create User.
Coordinator aggregate administrative reads observed **2 reserved, 2 bound/enabled,
2 Auth users, 2 email-confirmed users, 2 profiles and 2 preference records**.
No private email, UID or password was supplied to the coordinator/cloud. The
installation zero-count remains history, not current account status. This dated
snapshot is not API verification of every Auth setting or ordinary-session RLS
proof; administrative email confirmation does not prove email delivery.

The [actor/gate table and private smoke contract](cloud-development.md#hosted-state-and-responsible-actors)
assign remaining work: ordinary password login, own Save/reload, negative
RLS/Storage, prepared non-personal fixtures and actual private-operator hosted
smoke remain **OPEN**, as do human phone/Safari camera/library, rotation/
compatible-photo fallback, login/logout, explicit Save/Discard, VoiceOver/TalkBack,
EN/FI/SV and narrow/zoomed journeys. No hosted credentials were requested/read
and no hosted test or operation ran in this cloud task. Shell/dashboard/admin
observations do not complete these gates or full Phase 0. Proper password recovery
is a separately user-approved focused Phase 0 follow-up with its own plan/prereview,
not implemented here; no admin-reset, account deletion/recreation or magic-login workaround.

### Fresh-head validation

Starting-head [CI 34041029288](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34041029288)
passed: App/browser `101507694900` (46 cases), Real local Supabase
`101507695054` (standard start/reset, ordinary integration/11 security stages,
actual generation and tracked diff parity). Job logs were read. These results
apply to `5a61a942`, not automatically to this packet's new head.

Initial targeted run caught malformed new authorization-header syntax before
executing hosted unit cases; all 50 existing local guards passed. After repair:
`npm run test:unit -- tests/unit/hosted-smoke.test.ts tests/unit/local-backend.test.ts`
exited 0 (**106 tests**); `npm run typecheck` and `npm run lint` exited 0.
These hosted mocks prove guard/outcome contracts only, not live hosted access.
Full packet validation on code commit
`5004ef4ee638e9e710ca1a096f70ff7c1b71ab7e` plus the five documentation updates:

| Exact command | Actual result |
|---|---|
| `npm run lint` | Exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm run check:translations` | Exit 0; 299 keys, en/fi/sv, 23 source files |
| `npm run test:unit` | Exit 0; 197 tests, eight files |
| `npm run test:browser` | Exit 0; 46 desktop/emulated-mobile cases, no retries |
| `npm run test:a11y` | Exit 0; four cases, no retries |
| `npm run build` | Exit 0; compressed JavaScript 140.90 kB |
| `npm run scan:secrets` | Exit 0; 129 text files, fresh unprinted build canary checked |
| `npm run check:dependencies` | Exit 0; 12 production / 220 development packages; zero reported production vulnerabilities |
| `npm run db:start` | Exit 0; prepared disposable local stack healthy, no additional reset |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0; real ordinary A/B schema/item/JPEG/version/RPC checks |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0; all 11 real ordinary-session stages, cleanup completed |
| `npm run db:types` | Exit 0; actual local schema generation |
| `npm run db:types -- --check` | Exit 0; exact parity with another actual generation |
| `git ls-files --error-unmatch src/data/database.types.ts` | Exit 0; tracked |
| `git diff --exit-code -- src/data/database.types.ts` | Exit 0; no generated drift |
| `git diff --check` | Exit 0 |

Integration/security ran sequentially. Build/scan used the same process-local
`STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"`, exported without printing.
No dependency install, manual service workaround, local guard weakening or
hosted execution. Final immutable head and automated review/CI status are
recorded in the PR completion reply; fresh-head CI, independent coordinator
read-only Claude review and explicit user merge approval are distinct gates.

Automated validation of `ed624a84b00f2f98dd5e7d0b56ab020a5e8f31f5` found zero
CodeQL alerts. Its MIME-whitespace compatibility finding was addressed for
JSON/JPEG, with a case/parameter regression. The claimed HTTP 300 acceptance
was incorrect (`status < 300 || status >= 400` rejects it); an explicit 300
case now verifies refusal. The third comment acknowledged existing malformed
Storage-body coverage and no concrete defect. No authorization rule was weakened.
Follow-up exact targeted command above passed **108 tests**, and
`npm run test:unit` passed **199 tests**. Lint, typecheck, translations, build,
canary secret scan, dependency check and `git diff --check` were repeated,
all exit 0. Browser/a11y/real-local results in the table remain from their
recorded code state, not claimed as repeated for this MIME-only follow-up.

Fresh PR CI run `34041749524` for `ed624a8` is **action_required**; both the jobs
and failed-job logs endpoints report zero jobs. Coordinator approval is needed
for the final head's App/browser and Real local Supabase jobs. No approval/rerun
was bypassed and no absent/neutral result was counted as passing. Final head
and follow-up automated validation are reported in the PR, not self-approved.

Context actually read: root `AGENTS.md`, `.github/copilot-instructions.md`,
`README.md`, `docs/{cloud-development,phase-0-result,local-backend}.md`;
blueprint `00/03/05/08/10/12/13/18/19`, deployment portions of `17`,
Phase 0 and I01–I05 in `14/15`, workflow/model portions of `20/21`,
base `07`/byte-identical actual migration profile/item/image/admission/grant
contracts; `src/data/{items,config,client,database.types}.ts`,
`src/images/private-images.ts`, `scripts/backend/local.{mjs,d.mts}`,
`scripts/{run-local-tests,scan-secrets}.mjs`, local-backend unit and ordinary
security/integration harness excerpts, package/TypeScript/ESLint/Vite/CI
configuration; merged PR #1 metadata and retained result evidence; current
PR #2 body/comments/diff/empty reviews/threads and required CI job logs.
No historical instruction template replaced active rules.

## Historical merged foundation evidence

## Implemented foundation

* React/TypeScript/Vite application with original responsive styling.
* English/Finnish/Swedish sign-in, configuration, wardrobe and manual draft UI.
* Supabase SDK sessions, owner profile/language loading, private data guards,
  cross-tab logout and cancellation of obsolete data requests.
* JPEG preparation with bounded sanitized main/thumbnail files, explicit
  reviewed Save, immutable owner paths and retry reconciliation.
* Verbatim revision 1.1 base migration, guarded disposable local provisioning,
  ordinary-session integration/security runners and actual type-generation command.
* CI, license inventory, secret/canary scanning and Copilot cloud setup.

No paid AI, later-phase feature, production backend or public photo storage has
been enabled. The source repository is public at the user's request.

## Historical first cloud-session commands and outcomes

Re-run in the GitHub Copilot cloud session against the disposable local
Supabase stack (Docker) on 6 September 2026.

| Command / scope | Outcome |
|---|---|
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm run check:translations` | Exit 0; 299 keys in three languages |
| `npm run test:unit` | Exit 0; 108 tests across six files |
| `npm run test:browser` (slice suite, chromium and mobile) | Exit 0; 20 passed |
| JPEG browser module suite | Exit 0; 20 desktop/mobile cases |
| `npm run build` | Exit 0; initial compressed JavaScript approximately 140.87 kB |
| `npm run scan:secrets` with ephemeral canary | Exit 0; 124 text files checked, canary checked |
| `npm run check:dependencies` | Exit 0; 12 production / 220 development packages; production audit reported no vulnerabilities |
| `node scripts/provision-test-users.mjs` | Exit 0 after the Auth configuration repair |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | PASS; normal password sessions only, no service key |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | PASS; nine stages, normal password sessions only |
| `npm run db:types` and `npm run db:types -- --check` | Exit 0; committed types exactly match actual local generation |
| `npm run db:start` / `npm run db:reset` | Not completed end to end in that sandbox; see historical workarounds below |

## Standard baseline CI and prepared setup

Baseline head: `f20c745eec9084cc900770cb2b206100ad94b784`; PR base:
`d20457a82bca6e8d505d20b38dc07b4c930900cd`. The five pre-existing PR commits
are preserved, with no rewritten history or direct-main push.

[CI 34025264676, attempt 2](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34025264676)
completed successfully at that baseline on 6 September 2026, 09:57:03 UTC:

* [App/browser job 101466868103](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34025264676/job/101466868103):
  lint, types, translations, units, build, scans and **40 browser cases** passed.
* [Real local Supabase job 101466868242](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34025264676/job/101466868242):
  standard `npm run db:start` / `npm run db:reset`, ordinary integration and
  nine security stages passed. Actual `npm run db:types`, tracked-file check
  and `git diff --exit-code -- src/data/database.types.ts` passed. This was
  real generation parity, not inspection of a generated-looking file.

Prepared setup in agent run `34026811034`, job `101469132212`, also completed
the locked install, Chromium, standard local start/reset/provision and actual
type generation (10:13–10:15 UTC). Dependencies were already installed; no
gratuitous `npm ci`, separate setup rerun or setup-workflow edit was needed.
These successes apply to their recorded heads, not automatically to later code.

## Earlier approved continuation and historical results

Initial implementation commit: `46f61805d46a6622a50c41b32cc6aa31d953f2f8`;
evidence/review clarification commit: `bfe3bd124c939977cf438d29bec3ca26ab34e425`.
Code head `29ad6f0475b4facab9754f7732792f790f2d4f40` adds explicit `unknown`
narrowing and primitive-JSON regression cases while preserving the same
parsed-token policy. The final documentation head is recorded in PR replies.
Scope: I01–I05; R01/R02/R04/R11/R12/R19/R23/R26/R27.
The implementation agent was explicitly selected and its runtime reported
`gpt-6-astra`; this does not attest the coordinator's model. Both
[plan 5558504250](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558504250)
and [amended approval 5558542193](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558542193)
were read before edits. The coordinator records actual prior **Anthropic
Claude Opus 5** read-only critique there; automated validation is supplemental.

* Two sign-in-order browser cases use actual SDK broadcasts in same-origin
  tabs, A/Finnish and B/Swedish, each with distinct nonempty fictional clothes.
  In-memory event/owner markers prove foreign delivery before assertions;
  focus/reload settles own UI and owner-filtered requests. Both logout
  initiators clear both tabs, cancel held profile requests, ignore late
  replies, and remain signed out after reload. No tokens are recorded in the
  markers, and existing empty-second-tab/same-owner logout cases remain.
* `holdsStoredSession` compares the parsed `access_token` exactly. The
  regression first failed three cases under the old whole-JSON `includes`
  logic (prefix, substring and another JSON field), then passed after the
  bounded fix. Missing/unparseable/non-string-token policy is preserved.
  This is guard correctness, not a demonstrated RLS leak.
* Normal-session email checks require pinned Auth v2.196.0 creation denial:
  OTP create/no-create return 422 `signup_disabled` / `otp_disabled`;
  recovery returns empty 200; invalid email/recovery verification returns
  403 `otp_expired`. No usable session results, and approved A/B password
  access is rechecked. Initial status assumptions failed (exit 1); pinned
  source and live responses established 422 before the successful run.
  No 5xx was accepted as authorization evidence.
* `supabase/config.toml` changes are comments only. Email-provider enabling
  covers more than password grants; client URL detection is not a backend
  endpoint switch. Global/anonymous signup controls, admission and RLS remain.
  Recovery 200 is not proof of admission or Auth-row absence. Inbucket is
  disabled; no approved-account email request, SMTP/delivery/recovery UI,
  password change or administrator assertion was added. See
  `local-backend.md` for source-verified confirmation/password-change semantics.
* Active root/Copilot/cloud instructions now persist full context, exact-head
  planning, actual different-provider critique/amendments, coordinator approval,
  verified explicit Astra, one writer and user approval **before every merge**.

Commands ran from the repository root; outcomes are not mock/live equivalents:

| Command | Actual continuation outcome |
|---|---|
| `npm run test:unit -- tests/unit/stored-session.test.ts` | Exit 1 first (3 failed, 9 passed); then exit 0, 12 passed |
| `npm run test:unit -- tests/unit/stored-session.test.ts tests/unit/local-backend.test.ts` | Exit 0; 44 passed |
| `npm run test:browser -- tests/browser/slice.spec.ts` | Exit 0; 24 desktop/emulated-mobile cases |
| `npm run lint` | Exit 0 |
| `npm run typecheck` | Exit 0 after correcting new fixture types for the existing compiler target |
| `npm run check:translations` | Exit 0; 299 keys, en/fi/sv, 23 UI source files |
| `npm run test:unit` | Exit 0; initially 120, finally **123 tests**, seven files, including all 15 guard cases |
| `npm run test:browser` | First full run exit 1 (43 passed, accessibility failed); isolated rerun exit 0, 44 passed without retries |
| `npm run test:a11y` | Initial exit 0 only after retries (**two flaky cases**); final sequential run exit 0, two passed without retries; earlier finding remains |
| `npm run build` | Exit 0; compressed JavaScript initially 140.88 kB, finally 140.89 kB |
| `npm run scan:secrets` | Exit 0; 126 text files, ephemeral canary checked |
| `npm run check:dependencies` | Exit 0; 12 production / 220 development packages, no reported production vulnerabilities |
| `npm run db:start` | Exit 0, before and after the reset attempt |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Before reset: exit 0, **11 stages**, ordinary sessions including added email checks |
| `npm run db:reset` | Later in-session attempt: exit 1, reset failed before provisioning; no manual workaround |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | After failed reset: exit 1 at normal Auth/schema availability; **not a live integration pass** |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | After failed reset: exit 2 / **BLOCKED** at password sign-ins; no assertion stage passed |
| `npm run db:types -- --check` | After failed reset: exit 2 / **NOT RUN**; actual generator unavailable, file unchanged |
| `git ls-files --error-unmatch src/data/database.types.ts` and `git diff --exit-code -- src/data/database.types.ts` | Exit 0; tracked/unchanged only, **not** a substitute for the blocked current generation check |

Build/scan used a fresh unprinted process-local canary:

```sh
STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"
export STILLROOM_SECRET_CANARY
npm run build
npm run scan:secrets
```

The first full browser run also encountered an axe navigation-context failure.
The reproducible underlying loading-state finding is `aria-prohibited-attr`:
`src/features/wardrobe/wardrobe-screen.tsx` has a loading `div` with `aria-label`
but no nameable role. That line is untouched by this packet. A later 44-case
pass does not erase the finding; it needs coordinator follow-up, not suppressed
assertions or an unauthorized broader UI change.

The failed reset left live password operations and actual type generation
unavailable despite `db:start` health success. No raw service logs or credentials
were published; the specific current reset cause is not established. Do not
repeat the historical workaround as a current fix. A coordinator-authorized
fresh full CI run, including standard reset and actual generated parity, remains
required. CI `34027502820` at `46f61805d46a6622a50c41b32cc6aa31d953f2f8`
is **action_required**, not passing. The final head/run is reported in the PR
completion replies; any later documentation commit also requires its own CI.

Automated parallel validation reported **zero CodeQL alerts**. Its two
non-behavioral review suggestions (separate missing-token test labels and
explicit held-request array type) were incorporated; static typing had already
passed. A subsequent review requested explicit `unknown` narrowing of parsed
JSON; that preserves the same policy and is covered by three additional
primitive-JSON cases. Afterward the complete static/unit/build/canary/dependency,
44-browser and two-a11y gates were run sequentially, all exit 0. No finding
justified a broader authentication rewrite, and later passes do not erase the
recorded loading-state issue or blocked live-backend gates.

Final automated validation of code head `29ad6f0` again found zero CodeQL
alerts. Its remaining review comment recommends denying malformed/non-string
token payloads instead of preserving their fallback policy. This conflicts
with explicit amendment 2 in approval `5558542193`; it was **not implemented**.
Absent/empty storage already returns false and is tested separately. Changing
the other fallback cases needs renewed different-provider critique and
coordinator approval, not an unapproved authentication change or a claim of
a proven RLS leak. This review disposition remains visible for the coordinator.

Context actually consulted included active instructions and all three handoff
documents; blueprint `00`, `02`, `03`, `05`, full `07`, `08`, `10`, `12`, `13`,
Phase 0 in `14`/`15`, `18`, `19`, `20`; the byte-identical actual migration and
relevant generated-type ranges; `src/auth/{session.ts,login.tsx}`,
`src/data/{client.ts,config.ts,profile.ts,rows.ts,items.ts}`, `src/app/app.tsx`,
`src/images/private-images.ts`, `src/features/wardrobe/wardrobe-screen.tsx`;
browser slice/backend, ordinary integration/security, backend/media unit tests;
`scripts/{db.mjs,provision-test-users.mjs,run-local-tests.mjs,reserve-accounts.sql}`,
`scripts/backend/local.mjs`, the secret scanner, package/Vite/Playwright
configuration, CI/setup workflows, relevant SDK broadcast/recovery source,
PR body/comments/reviews/diff and baseline/setup job evidence.

## Historical approved narrow amendment — local results

Starting clean head: `1d1c961ac9c3b61ddf760debbf5f1d32fde6d5c7`; base `main`:
`d20457a82bca6e8d505d20b38dc07b4c930900cd`. Work stays on PR #1,
`copilot/finish-phase-0-stillroom-wardrobe`, within Phase 0 I01–I05.
[CI 34027852509 attempt 2](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34027852509)
passed at that starting head: App/browser job `101472581269` (44 cases) and
real Supabase job `101472581391` (standard start/reset, ordinary-session
integration/11 security stages, actual generation and tracked-file/diff parity).
That supersedes the earlier blocked CI/backend state **for that head only**,
not the reproducible loading finding or fresh-head CI requirement.
Prepared agent setup `34028594776` / `101473915563` completed
start/reset/provision/types; the healthy stack was not reset again.

[Amendment 5558727273](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558727273)
records the GPT-6 Astra coordinator's plan, actual **Anthropic Claude Opus 5**
read-only prereview and approval before implementation. It was read alongside
comments `5558504250` and `5558542193`. This cloud writer did not perform or
claim a new independent prereview. Runtime agent-registry evidence reports
`astra-narrow-amendment`, model **`gpt-6-astra`**, matching explicit selection;
one implementation writer, no fallback or material scope amendment.

* **I02/I05; R01/R11/R19/R26:** one pure `securityFailureExitCode` helper is
  used in the outer security catch and both cleanup catches. Coarse warnings
  and all HTTP/ownership assertions remain intact. The 18 new unit cases cover:

  | Primary status | Cleanup `LocalBackendError` | Cleanup assertion/unknown error |
  |---|---|---|
  | Absent or 0 | 2 / BLOCKED | 1 / FAIL |
  | 1 / FAIL | 1 / FAIL | 1 / FAIL |
  | 2 / BLOCKED | 2 / BLOCKED | 2 / BLOCKED |

  Unknown error values, including a lookalike error object/string, cannot
  produce success. Unrecognized primary values cannot propagate as success.
  Tradeoff: a primary BLOCKED plus secondary cleanup assertion remains BLOCKED;
  the secondary warning is retained and CI is still non-passing.
* **I03/I05; R17/R27:** the loading grid is a named `section` with unchanged
  class, `aria-busy` and existing translated label. All grid/responsive/skeleton
  styles are class-driven; no CSS or catalog change was needed. The regression
  holds the actual item-list request, checks visible busy skeletons before and
  after full-page axe, asserts the named region, releases in `finally` on every
  path and confirms the resolved owner wardrobe through the existing fixture.
  No sleeps, static JSX mock, axe exclusions or cross-account test changes.

All commands below were executed by this writer on the amendment working tree:

| Exact command | Result |
|---|---|
| `npm run test:unit -- tests/unit/local-backend.test.ts` | Red: exit 1, 18 new cases failed because helper was not yet implemented; 32 existing passed. Green: exit 0, 50 passed. This is unit coverage, not a live outage/cleanup simulation. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'accessibility while wardrobe items are loading' --retries=0` | Red: exit 1, both projects failed specifically on axe `aria-prohibited-attr` at the generic loading div, not a role timeout. Green: exit 0, both passed while response remained held. |
| `npm run lint` | Exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm run check:translations` | Exit 0; 299 keys, en/fi/sv, 23 source files |
| `npm run test:unit` | Exit 0; 141 tests, seven files |
| `npm run test:browser` | Exit 0; 46 desktop/emulated-mobile cases, no retries |
| `npm run test:a11y` | Exit 0; four cases, no retries, including held loading in both projects |
| `npm run build` | Exit 0; compressed JavaScript 140.90 kB |
| `npm run scan:secrets` | Exit 0; 126 text files, fresh ephemeral canary checked |
| `npm run check:dependencies` | Exit 0; 12 production / 220 development packages, zero reported production vulnerabilities |
| `npm run db:start` | Exit 0; prepared local stack confirmed healthy, no additional reset |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0 / PASS; real ordinary A/B sessions, schema/JPEG/retry/version/RPC checks |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0 / PASS; all 11 stages, ordinary sessions, cleanup completed |
| `npm run db:types` | Exit 0; actual local generation |
| `npm run db:types -- --check` | Exit 0; exact comparison with another actual generation |
| `git ls-files --error-unmatch src/data/database.types.ts` | Exit 0; tracked |
| `git diff --exit-code -- src/data/database.types.ts` | Exit 0; no generated drift |
| `git diff --check` | Exit 0 |

Live integration/security ran sequentially. Build and scan used the same shell
with fresh `STILLROOM_SECRET_CANARY="$(openssl rand -hex 24)"` and
`export STILLROOM_SECRET_CANARY`; its value was never printed. No dependency
install, schema/config/workflow change, credentials or raw service logs.

Context actually read: `AGENTS.md`, `.github/copilot-instructions.md`;
`docs/{cloud-development,phase-0-result,local-backend}.md`; blueprint
`00/02/03/05/10/12/13/18/19`, Phase 0 in `14/15`, relevant `07/08/20`
sections; actual migration RLS/storage excerpts and generated
`src/data/database.types.ts` item/image/profile excerpts;
`scripts/backend/local.{mjs,d.mts}`, `scripts/{db,run-local-tests,scan-secrets}.mjs`;
`tests/unit/local-backend.test.ts`, `tests/security/rls.sessions.mjs`,
`tests/integration/local.sessions.mjs` opening contracts,
`tests/browser/{slice.spec,mock-backend}.ts`;
`src/features/wardrobe/wardrobe-screen.tsx`, `src/app/app.tsx`,
`src/data/items.ts`, `src/styles/{app,tokens}.css` (relevant style selectors);
`package.json`, `playwright.config.ts`, `.github/workflows/ci.yml`;
PR body, approved comments, review/empty inline threads, scoped baseline diff
and baseline CI job logs. No credential/service-state files were inspected.

The final code/evidence head is linked in the coordinator's PR completion
reply. Automated review, fresh full CI on that head and explicit user merge
approval remain coordinator gates. Physical phone/Safari, camera/library,
VoiceOver and TalkBack acceptance remains unperformed. No broader Auth
fallback change, later phase, hosted service, deployment or paid AI.

## Repaired defects

* Local sign-in failed with `FAIL: a provisioned local identity could not sign
  in`. The Supabase CLI maps `[auth.email].enable_signup` to GoTrue's
  `GOTRUE_EXTERNAL_EMAIL_ENABLED`, which disables the whole email provider,
  including password sign-in for administratively created identities. The
  option is now enabled in `supabase/config.toml`. Self-service signup stays
  closed by `[auth] enable_signup = false` and by the database admission
  trigger; both anonymous signup denials are still asserted by the security
  suite.
* `src/data/database.types.ts` is now generated from the actual local schema
  and committed; the temporary `database-projection.ts` was removed and the
  client, profile access and tests use the generated types through
  `src/data/rows.ts`.
* The security fixture inserted rows with non-uniform keys, which PostgREST
  rejects (`PGRST102`), and omitted the non-null `items.notes` column. The
  fixture now sends uniform rows; no policy or assertion was weakened.
* `.workspace-identity` is now an `aside` landmark with a translated label, so
  all page content sits inside landmarks.
* The accent colour was darkened to `#9C5840` to reach the 4.5:1 contrast ratio
  for small text on the application background.
* A tab adopted another tab's sign-in because the Supabase SDK broadcasts
  session events between tabs. Sessions are per-tab `sessionStorage`, so the
  session controller now ignores any session this tab does not hold. The
  explicit logout broadcast and its assertions are unchanged, and the browser
  test additionally asserts that the second tab still shows its own sign-in
  form.

## Historical sandbox workarounds

* The first cloud session on 6 September 2026 reported blocked name resolution
  for Docker containers created after its start, so `supabase start` and `supabase db reset` (and
  therefore `npm run db:reset` end to end) could not run here. The schema was
  applied to the existing local database and the Auth, REST and Storage
  containers were recreated manually with host mappings so that the real gates
  above could run against normal sessions. Image pulls from the CloudFront
  backed registry are blocked as well, so the `postgres-meta` image used by
  type generation was pulled from Docker Hub and re-tagged locally. These are
  environment workarounds only; nothing about them was committed. Standard
  baseline CI subsequently passed clean reset and actual type parity, as
  recorded above. The continuation did not repeat those workarounds.

## Historical PR #1 remaining limits

* Fresh-head full CI approval/run and coordinator review remain gates. The
  narrow amendment above corrects loading accessibility and passes current
  local integration/type parity; neither substitutes for fresh-head CI.
* Physical-device behaviour remains unverified: no real phone, VoiceOver or
  TalkBack acceptance is claimed. Browser evidence is Chromium desktop and
  emulated mobile only. Actual iPhone/Safari camera/library behavior and
  assistive-technology acceptance still require human checks.
* No paid AI, later-phase feature, production backend or hosted Supabase
  project has been enabled. AI prefill remains Phase 2 scope.

The preview URL is `http://127.0.0.1:5173` when explicitly started; this
continuation does not claim a persistent preview server. Without Supabase
settings the app displays an honest setup screen, not simulated private data.
See `cloud-development.md` for the cloud continuation task.

## Historical publication and rollback

This is an initial WIP source snapshot, not a deployed release. No prior
production application or data is changed. Stop the preview or revert the
new source commit to roll back; never reset a live database. Subsequent
cloud work must use a pull request and update this report with actual
commands, results, commit and remaining limits.

Current PR #2 rollback is a reviewed source revert only. Do not reset or replay
the installed hosted schema; Pages remains on the separately authorized reviewed-main
deployment; any replacement requires coordinator authorization and fresh evidence. Independent accounts,
EN/FI/SV and the manual editable draft/explicit Save are preserved. Phase 2's
photo-first AI-filled title/category and all-field editing remain unimplemented;
no automatic library save, post-save worker, outfit AI or paid activation.

## PR #3 bounded review corrections — 6 September 2026

Starting head `7356c9b3f88acd948b4387609943816ca955a112`, base
`20ec93041f1d90d9a9f684b7358ea2b9715527e1`; same PR/branch, one writer.
Full review [5126939876](https://github.com/drrowdev/stillroom-wardrobe/pull/3#pullrequestreview-5126939876)
records actual read-only **Anthropic Claude Opus 5** critique and coordinator
approval of these three corrections under plan `5561361106`, controlling
approval `5561846573` and cold amendment `5562318484`. No material scope change.
Public receipt [5562961986](https://github.com/drrowdev/stillroom-wardrobe/pull/3#issuecomment-5562961986),
read before edits, records native `sweagent-capi:gpt-6-astra`, task
`2f79ee32-fa44-46b2-9d61-455d7ec0a804`, session
`9fded7d7-f377-42ed-862e-490060d7224c`, observed
`2026-09-06T23:24:33.2885891Z`, against that exact base/head.

Context read: active root/Copilot instructions; README/cloud/phase/local-backend
evidence; relevant blueprint `00/03/05/07/08/10/12/13/14/15/17/18/19/20/21`;
actual schema/profile types, Auth/bootstrap/UI/transport, pinned SDK, unit/browser
and real-mail tests, wrappers/configuration, PR diff/discussion/reviews and
available CI logs. Starting-head CI `34064501007` was `action_required` with
zero jobs, not passing.

Corrective code/tests commit `29d8f037a51219d8a7d0d6e14a806be919bfa9a2`:

* **I03/I05; R01/R19/R26:** bounded decoded auth-key detection leaves benign
  query/hash navigation alone with empty or occupied storage. Strict accepted
  fragment grammar, scrubbing, replay/expiry checks and late-adoption refusal
  remain. Refusal rendering uses the narrowed actual kind/notice.
* **I03/I05; R11/R26/R27:** the initial return notice belongs to the reactive
  `none` snapshot, not a separate global. Auth activity/events, explicit logout,
  a new request and leaving the episode clear it without render consumption.
  StrictMode browser tests retain the genuine initial success/unconfirmed
  revocation notice, then verify no replay after same-page A and B login/logout,
  preserving their independent Finnish/Swedish preferences and logout reset.
* **I03/I05; R19/R26:** unavailable becomes uncertain only with `updateSent`.
  Actual guarded-SDK unit tests assert zero underlying PUTs on pre-send refusal,
  one fetch attempt on dispatched network failure, no retry and no success/logout.
  Dispatch is not proof of network delivery.

Validation performed here (commands from the repository root):

| Command | Result |
|---|---|
| `npm run test:unit -- tests/unit/recovery.test.ts tests/unit/stored-session.test.ts` | Exit 0; 80 tests |
| `npm run test:browser -- tests/browser/recovery.spec.ts tests/browser/slice.spec.ts --retries=0` | Exit 0; 88 cases together |
| `npm run lint` / `npm run typecheck` / `npm run check:translations` | Each exit 0; 336 EN/FI/SV keys |
| `npm run test:unit` | Exit 0; 264 tests, nine files |
| `npm run test:browser -- --retries=0` | Separate rerun exit 0; 108 cases |
| `npm run test:a11y -- --retries=0` | Exit 0; 10 cases |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0 at `29d8f03`; ordinary suite plus one real-local mail/UI recovery journey, originals/cleanup verified |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0 afterward; all 11 stages |
| `npm run db:types -- --check` | Exit 0; actual generation parity |
| `git ls-files --error-unmatch src/data/database.types.ts` / `git diff --exit-code -- src/data/database.types.ts` | Each exit 0; tracked, unchanged |
| `npm run build` / `npm run scan:secrets` / `npm run check:dependencies` | Each exit 0; unprinted ephemeral canary checked, zero reported production vulnerabilities |
| `git diff --check 7356c9b3f88acd948b4387609943816ca955a112 HEAD` | Exit 0 |

Before fixes, new tests reproduced five unit and four targeted browser failures.
An intermediate type-narrowing error and test fresh-page setup error were corrected.
The first full browser run returned exit 1 (107/108): an invalid-link refusal
appeared before the competing-callback test's trigger. Its cause is unproven;
no assertion/guard was weakened. The full separate rerun above passed.
Build retained the non-failing 500 kB chunk warning (150.09 kB gzip JavaScript).

Supplemental automated validation reported zero CodeQL alerts and only the
previously approved `weak_password` indentation issue, subsequently normalized.
That whitespace-only change and this appended evidence do not repeat the real
mail call or replace final-head CI. The real harness/config/wrapper, schema/types,
dependencies, root instructions and hosted surfaces remain unchanged.
No extra agent, service restart/reset, protocol spike, hosted operation, merge
or deployment. PR remains draft pending coordinator **final-head CI and independent
follow-up review**; physical-device and hosted acceptance remain separate gates.

## PR #4 bounded JPEG compatibility — 7 September 2026

Base `0545cf3b679fe29a373929d6188e9953e352d8ec`; starting head
`51c9adc6f6b0f96d75b5ab9829a208fe33e8d60e` had the same tree.
Branch `copilot/phase0-iphone-photo-capture-fix`, one writer. I04/I05, principally
R04, preserving R03/R11/R12/R17/R19/R23/R26/R27; not Phase 1, full I07 or AI.
Full [plan 5567450856](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5567450856)
was read and its SHA-256 matched
`a2931f3f92160c017d893471205f243a4b4cdd14863ca632fcf95abf49a3a57e`.
[Controlling approval 5567639838](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5567639838)
records actual read-only **Anthropic Claude Opus 5** AMEND-AND-APPROVE critique:
defensive Gate B, fresh-output-only identity/absent-orientation removal, independent
byte/pixel oracles, fixture metadata accounting, private disclosure and narrow WebKit.
Those amendments, not the plan's earlier conditional stop, govern this implementation.

Before edits, [coordinator receipt 5567680245](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5567680245)
was read: native `sweagent-capi:gpt-6-astra`, task
`b671ab8a-8939-4569-9c34-0e2fd66f5eda`, session
`e92350e1-13d2-42b3-a970-efa1af556e92`, observed
`2026-09-07T08:27:00.8481680Z`, matching this PR/base/head. No historical
receipt substitution or additional agent. Context actually read: root/Copilot
instructions, README, cloud/local-backend and relevant Phase-0 history; blueprint
00/03/05, image/owner excerpts of 07/08, 10/12/13, Phase 0 in 14, I04/I05/I07
boundaries in 15, relevant 17/18/19/20/21; actual image schema/types, image
preparation/upload/private-download/item adapters, AddItem/owner lifetime,
catalog/helper, JPEG unit/fixture/browser/slice tests, mock/local-session contracts,
local/hosted guard excerpts, package commands, Playwright/CI, and PR discussion,
empty starting diff/reviews/checks and CI job-log lookup.

### Implementation and evidence limits

**Gate B, not a reproduced iPhone root cause.** Before production edits, tiny
four-colour native-canvas probes passed in Linux Chromium 153.0.8010.12
(revision 1243) and WebKit 26.6 (revision 2359), Node 24.19.0. WebKit first failed
to launch because its executable was absent; the existing pinned
`./node_modules/.bin/playwright install --with-deps webkit` succeeded, then both
probes passed. No npm/dependency/lockfile changes. Linux WebKit is not Apple
ImageIO, native HEIC, Vivaldi camera or physical-iPhone evidence.

Fresh sRGB encoder output now removes only complete exact-signature Exif APP1
and existing ICC APP2 segments. Absent/1 orientation is eligible, including
consistent duplicate segments; malformed/nonidentity/conflicting orientation and
linked-directory ambiguity fail closed. All scans/EOI are checked. Source parser,
source trailer/admission, strict final validator and all resource limits remain
unchanged. Independent test-only segment ranges verify exact removals, retained
bytes, idempotence and terminal EOI; same-engine decoded-pixel hashes remain equal,
including native colour-profile removal. Final JPEG byte hashes, both TIFF orders,
all eight orientations and three decoder paths are covered. Native byte budgets
are distinct from injected quality-loop/floor assertions.

The photo panel has default-off, non-live, EN/FI/SV preparation details containing
only typed static stage/reason labels. The existing `photo.invalid` key no longer
asserts that a different JPEG is the diagnosis. Actual selection/reselection,
discard and owner lifecycle clear details; no-file cancellation preserves them.
No filenames, metadata, measurements, hashes, identifiers, raw exceptions,
telemetry, persistent diagnostics or uploads are added. Manual edits/clears,
explicit Save and frozen retry adapters remain unchanged.

### Commands and unresolved gates

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/jpeg.test.ts` | First: exit 1, 42 existing passed/3 new failed. Final: exit 0, 49 passed. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts --grep 'fresh native four-colour' --project=chromium --project=webkit-photo --retries=0` | Before production edits: initially missing WebKit; after pinned installer, exit 0, 2 passed. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts tests/browser/slice.spec.ts --project=chromium --project=webkit-photo --retries=0` | Latest: exit 1, 70/72 passed; all image-processing cases passed in both engines. Failures below remain visible. |
| `npm run lint` / `npm run typecheck` / `npm run check:translations` | Each exit 0; 350 keys, EN/FI/SV, 26 source files. |
| `npm run test:unit` | Exit 0; 271 tests, nine files. |
| `npm run test:browser -- --retries=0` | Exit 1; 169/170 passed across Chromium, Chromium-mobile and narrow WebKit. Only WebKit's empty mocked-upload byte assertion failed. |
| `npm run test:a11y -- --retries=0` | Exit 0; 21 passed, including EN/FI/SV photo details in all three projects. |
| `npm run build` / `npm run scan:secrets` / `npm run check:dependencies` | Each exit 0; 136 scanned text files, same unprinted process-local random canary; 12 production/220 development packages, no reported production vulnerabilities. Existing non-failing chunk warning retained (151.45 kB gzip JS). |
| `git diff --check` and exact allowlist/source-validator/limits/database-job comparison | Exit 0; only approved existing paths, no source-guard or database-job changes. |

The first expanded run exposed test-authoring errors (loop brace, a decoder-accepted
synthetic header, and an incorrect post-login route expectation); those were
corrected without changing source admission, decoding or navigation. The known
corrupt-table fixture now proves the decode error stage.

**Required browser gate is NOT green.** WebKit's mock upload stores zero bytes
where prepared metadata declares 287; the strengthened byte/hash assertion fails
before retry, and the unchanged Save adapter correctly rejects mismatching bytes.
This does not establish a real network upload defect. Existing owner-tab tests
intermittently time out waiting for Playwright `requestfailed` after signed-out UI
appears. The latest targeted run also encountered a Chromium discard-dialog
detachment/navigation timeout. No skip, browser exclusion, timeout increase,
weakened assertion, Auth/Save change or excluded mock-backend edit was used.
Those timing failures did not recur in the subsequent full run; their causes
remain unproven. The repeatable empty mocked-upload failure is still blocking.
Coordinator review/actual different-provider critique and approval are needed
before any material harness/evidence amendment, including adding the excluded
`tests/browser/mock-backend.ts` path if investigation requires it.

Fresh-head App and unchanged real-local integration/security/types-parity CI remain
required. Starting-head CI `34097907908` was `action_required`, zero jobs; detailed
log lookup reported no failed jobs, not a pass. No CI authorization/rerun, local
fixture reset, hosted operation, merge or deployment occurred here.

Physical-phone acceptance remains **OPEN**: record actual iOS/Safari/Vivaldi
versions and separate camera preview, returned capture, artificial camera-roll
JPEG/HEIC picker conversion, prepared preview/orientation, explicit Save/reload,
cancel/reselect/discard, accessibility and safe high-resolution refusal. Safari's
working camera preview and the two apps' shared Apple platform prove neither
independent engines nor completed photo Save. Raw HEIC remains unsupported and
requires a separately reviewed bounded packet if actual picker conversion is
insufficient; manual conversion forever is not completion. No private photo was
requested or inspected. Every merge needs fresh explicit user approval;
deployment is separately authorized. Rollback is the coordinator's separately
authorized previous reviewed static build based on `0545cf3`, never a DB rollback
or a change to the working recovery flow.

Supplemental automated review of code commit `2204dd7` returned zero CodeQL
alerts (JavaScript/Actions). Its two suggestions were not adopted: a collapsed
`hidden` section remains a valid DOM target for `aria-controls`, and the
zero-based post-increment counter already accepts exactly 4096 header segments
and rejects segment 4097. An independent exact-boundary unit regression was added
for the latter; no production guard/accessibility change was needed. These
automated checks do not replace coordinator independent final review.
After this test-only addition, `npm run test:unit -- tests/unit/jpeg.test.ts`
passed 50 tests and `npm run test:unit` passed 272 tests; lint, typecheck and
`git diff --check` each returned exit 0. Browser/build results above apply to
unchanged production code at `2204dd7`, not a new browser rerun. CI `34102995096`
on that code commit is also `action_required`; no required job pass is claimed.

### PR #4 approved upload-wire harness correction — 7 September 2026

Base `0545cf3b679fe29a373929d6188e9953e352d8ec`; starting head
`38eef7cc2589d8b44ebc20030f063d7a61db2a64`, same branch/PR, one writer.
I04/I05/R04/R12 test support only. Read full plan `5567450856`, approval
`5567639838`, controlling [amendment 5568270851](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5568270851)
and [review 5130236784](https://github.com/drrowdev/stillroom-wardrobe/pull/4#pullrequestreview-5130236784).
The coordinator records actual read-only **Anthropic Claude Opus 5** harness
prereview (`4e125`) and clean seven-file runtime review (`c4a35485`).
No runtime correction was requested or made.

Before edits, re-read [current-session native receipt 5568495884](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5568495884):
task `cdfea63a-edb9-47a1-987c-d357abf9e13c`, session
`01e1f8c3-c5d5-4c2e-80c5-5374b57ea691`, observed
`2026-09-07T09:26:35.4628900Z`, actual `sweagent-capi:gpt-6-astra`, matching
PR/base/head. Historical receipts were not substituted.
Context read: root/Copilot instructions; README and cloud/local-backend/Phase-0
evidence; relevant blueprint 00/03/05/07/08/10/12/13/14 Phase 0/15 I04–I05 and
I07 boundary/17/18/19/20/21; actual image migration/type excerpts, Save,
private-image/item/client source, mock/slice, installed Storage SDK, package,
Playwright/ESLint/TypeScript/CI configuration; PR discussion/review/diff and CI
job-log lookup. No credential cache or hosted inputs were read.

Only `tests/browser/mock-backend.ts`, `tests/browser/slice.spec.ts` and this
document change. The page-owned Node receiver binds `127.0.0.1:0`, accepts only
reserved synthetic owner/item/image paths and issued fixture credentials, and
receives URL-only continued browser POSTs. It checks the actual multipart stream
before storing a positive JPEG file part; no inspector replay or expected-byte
backfill. The 1 MiB streamed-body bound, five-second request/header deadlines,
explicit local-origin/header CORS and listener/all-socket cleanup cover failure
and page/setup closure. Existing scripted errors, duplicate 409, commit failure,
Auth/profile/REST/download behavior remain. Negative tests cover missing/empty/
ambiguous/multiple/wrong-name/wrong-type/malformed/truncated/oversized parts,
metadata/cache-field ambiguity, scope/credentials, independent pages and cleanup.

**Measured synthetic transport, not an application upload diagnosis:** pinned
Playwright 1.63.0, WebKit 2359, Node 24.19.0. The first WebKit socket proof
received **4096 payload bytes**, SHA-256
`c8f5d0341d54d951a71b136e6e2afcb14d11ed8489a7ae126a8fee0df6ecf193`;
the observed inspector file part was **0 bytes**. One preflight reached the
receiver, zero the original OPTIONS route. Chromium/mobile delivered the same
known bytes/hash and exposed 4096 inspector file bytes, with neither preflight
observed. No engine-specific fallback or exclusion. Intentional same-length
corruption and wrong-length comparisons both throw, proving a non-vacuous oracle.
Actual app-prepared main/thumb were each **287 bytes**, SHA-256
`84f279ce939b14f724a91e543bbd9726b1f67b08828f1700868b6a0a463790f2`
in all three projects. Existing exact-byte/hash/retry assertions remain, with
positive length, UUID and no-additional-socket-upload checks.

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
JSON reports used existing `--reporter=list,json` with
`PLAYWRIGHT_JSON_OUTPUT_FILE` under `/tmp`, never committed.

| Exact command | Actual result |
|---|---|
| `npm run typecheck` / `npm run lint` | Initial token-registration syntax error corrected; subsequently both exit 0. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'actual upload wire' --project=webkit-photo --retries=0` | Initially blocked by syntax, then missing executable; after pinned installation, socket proof exit 0. |
| `./node_modules/.bin/playwright install --with-deps webkit` | Exit 0, only after actual missing-browser failure; no dependency/configuration edit. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'retrying a failed commit' --project=webkit-photo --retries=0` | Exit 0, unchanged strong app assertion first. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'actual upload wire\|retrying a failed commit' --project=webkit-photo --retries=0` | Initial expanded run 15/16; corrected test expectation to existing unauthenticated 401, not an Auth change. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts tests/browser/slice.spec.ts --project=chromium --project=mobile --project=webkit-photo --retries=0 --reporter=list,json` | Exit 0, **153/153**, no skips/retries. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'actual upload wire\|retrying a failed commit' --project=chromium --project=mobile --project=webkit-photo --retries=0` | Final scoped run exit 0, **48/48**, after diagnostic instrumentation; no skips/retries. |
| `npm run test:unit` / `npm run check:translations` | Exit 0; **272 tests**, 350 EN/FI/SV keys. |
| `npm run test:browser -- --retries=0` | Exit 1, **214/215**; all wire/Save cases pass, existing WebKit B-first owner-tab profile `requestfailed` wait times out at 30 seconds. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'different-account tabs.*b signs in first' --project=webkit-photo --retries=0 --reporter=list,json` | One diagnostic run, exit 0; not a replacement full-suite pass. |
| `npm run test:a11y -- --retries=0` | Exit 1, **20/21**; Chromium loading-state test waits 30 seconds for the sign-in email input. No retry or Auth correction. |
| `npm run db:start` | Exit 0; prepared local stack, no reset or manual service repair. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0; ordinary local suite and unchanged real recovery UI journey. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0; all 11 ordinary-session stages, sequentially after integration. |
| `npm run db:types -- --check` | Exit 0; actual local generation matches committed bytes. |
| `git ls-files --error-unmatch src/data/database.types.ts` / `git diff --exit-code -- src/data/database.types.ts` | Exit 0; tracked, unchanged. |
| `npm run build` / `npm run scan:secrets` / `npm run check:dependencies` | Exit 0; existing chunk warning, 136 scanned text files with same unprinted process-local canary, no reported production vulnerabilities. |
| `git diff --check` | Exit 0. |

The profile diagnostic adds only coarse synthetic event timing: requests held
at 6/9 ms, failure events at 154/138 ms, both signed-out screens observed at
178 ms; both receiver POST counts zero. It did not reproduce or explain the
full-run timeout. The accessibility startup failure is also unexplained. No
timeout increase, assertion relaxation, Auth rewrite or full rerun-to-green;
**full browser and accessibility gates remain OPEN**. The combined 153-case
result predates this diagnostic-only instrumentation; no production code changed.

CI `34103319777` on the starting head is `action_required`; detailed failed-job
lookup returned zero jobs, not a pass. Final-head CI trust authorization and
independent follow-up review remain coordinator gates. This fixture proof is
not real hosted RLS/Storage, Apple HEIC, personal-photo or completed iPhone
acceptance. Physical Safari/Vivaldi camera/library/Save/accessibility gates remain
open. No hosted calls, new agent, merge or deployment; every merge still requires
fresh explicit user approval. Preserve the previously recorded rollback boundary.

### PR #4 approved test-timing correction — 7 September 2026

Base `0545cf3b679fe29a373929d6188e9953e352d8ec`; starting head
`d32dfdc8c251a6714421dc05bbc5bbedd207eba2`, existing
`copilot/phase0-iphone-photo-capture-fix`, one writer. I04/I05 test support,
preserving R04/R11/R12/R17/R19/R26/R27. Only `tests/browser/slice.spec.ts`
and this result document change in this follow-up.

Read the full controlling [amendment 5569237411](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5569237411)
before edits. The coordinator records actual read-only reviewer `c4a35485`,
**Anthropic / Claude Opus 5**: clean seven-file runtime review, clean upload-wire
review, then approval of the refined timing fixture. The review identified a
held-route/protocol-notification ordering hazard; it did not recover the original
failing trace. Controlling corrections reject strict failure-before-release
timestamps, blanket cancellation catches and raw HTML/URL diagnostics. This
implementation follows that approved plan, not a new material amendment.

The matching [native-model receipt 5569268531](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5569268531)
was read before edits: coordinator explicitly selected `gpt-6-astra` and verified
native `sweagent-capi:gpt-6-astra` at `2026-09-07T10:29:50.9567124Z`, task
`73ce339d-3e53-4760-a581-b46548779a87`, session
`7bea9293-01f0-4ae8-a93c-8bf0aeee3659`, matching this PR/base/head.
No old-session receipt or additional implementation agent was substituted.
Context actually read: root/Copilot instructions; cloud guide and current
Phase-0 PR #4 evidence; local-backend evidence; blueprint 00/03/05/10/20,
Phase 0 in 14, relevant 07/08/12/13 and I03–I05 in 15; actual profile migration/
generated-type excerpts, `src/auth/session.ts`, `src/data/client.ts` and
`src/data/profile.ts`; affected slice tests, mock-backend contracts, local/hosted
guard excerpts, package/Playwright/CI configuration; PR discussion, diff,
reviews/threads and CI job-log lookup.

The two-owner test installs a test-local, bounded profile-GET signal observer.
It forwards unchanged native fetch arguments/results with the correct receiver,
checks a bare same-origin GET before arming, and never reads bodies, headers,
credentials or upload content. One matching synthetic owner/profile GET is held
per tab; other requests retain normal fixture routing. Both signed-out screens,
one held/observed request each and real `AbortError` signals are required before
either reply is released. Protocol failure events are diagnostic only.
Finally cleanup releases both routes, bounds fulfillment/settlement to five
seconds, settles latches and removes listeners. Coarse unexpected/unsettled
outcomes fail without replacing a primary assertion failure. Existing owner,
late-response, language, storage/cache and reload assertions remain intact.

Loading-a11y now retains finally diagnostics limited to navigation completion/
HTTP bucket, ready state, separate email-present/visible flags, known selectors,
allowlisted language/error names and request category counts with synthetic A.
No raw URL, HTML, exception/message, header/body, screenshot or trace is added.
Selectors, acceptance, production code, upload receiver and timeouts are unchanged.

Commands ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`.
Browser commands below used `--reporter=list,json`, with
`PLAYWRIGHT_JSON_OUTPUT_FILE` set respectively to `/tmp/pr4-timing-targeted.json`,
`/tmp/pr4-timing-browser.json` and `/tmp/pr4-timing-a11y.json`. Reports are not committed.

| Exact command | Actual result |
|---|---|
| `npm run typecheck` / `npm run lint` / `git diff --check` | Test-authoring type/cleanup-initializer errors corrected before browser execution; final checks each exit 0. |
| `./node_modules/.bin/playwright install --with-deps webkit` | Exit 0 after confirming WebKit absent; existing pinned browser, no dependency/configuration change. |
| `npm run test:browser -- tests/browser/slice.spec.ts --grep 'different-account tabs\|accessibility while wardrobe items are loading' --project=chromium --project=mobile --project=webkit-photo --retries=0 --reporter=list,json` | Exit 0, **9/9**: A-first/B-first and loading-a11y in all three projects. |
| `npm run test:browser -- --retries=0 --reporter=list,json` | One fresh full run, exit 0, **215/215**, zero skips/flaky/retries; started `2026-09-07T10:39:10.612Z`. |
| `npm run test:a11y -- --retries=0 --reporter=list,json` | One fresh run after browser success, exit 0, **21/21**, zero skips/flaky/retries; started `2026-09-07T10:41:08.696Z`. |
| `npm run check:translations` / `npm run test:unit` | Exit 0; 350 EN/FI/SV keys and **272 tests** in nine files. |
| `npm run db:start` | Exit 0; prepared disposable local stack, no reset or service repair. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0; ordinary-session suite and one real local recovery UI journey. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0; all 11 ordinary-session stages, after integration. |
| `npm run db:types -- --check` / `git ls-files --error-unmatch src/data/database.types.ts` / `git diff --exit-code -- src/data/database.types.ts` | Each exit 0; tracked types match actual local generation and remain unchanged. |
| `npm run build` / `npm run scan:secrets` / `npm run check:dependencies` | Each exit 0; same unprinted process-local random canary, 136 scanned text files, no reported production vulnerabilities. Existing chunk warning remains (151.45 kB gzip JS). |

Full-run coarse diagnostics show each owner's observed count = held count = 1,
signal present and aborted with `AbortError` before release, both outcomes
`fulfilled`, completed cleanup and zero receiver POSTs/payload bytes. Loading
diagnostics show completed 2xx navigation, complete document, English workspace,
no fatal selector, no page errors and no failed requests. These successful end
states do not explain the earlier Chromium startup failure.

**Ordering hazard removed; original WebKit trace unavailable; earlier a11y cause
unproven.** Preserve the preceding failed-run history. The fresh local browser/
a11y gates above now pass, not by skipping cases or weakening ownership assertions.
Starting-head CI `34108385173` is `action_required`; MCP failed-job lookup returned
zero jobs, not a pass. Fresh committed-head CI authorization/results and independent
follow-up review remain coordinator gates before the user's separate merge decision.
Physical iPhone Safari/Vivaldi, native HEIC and hosted-owner acceptance remain
OPEN. No hosted call, production change, merge, deployment or later phase is
authorized or performed; preserve the existing rollback boundary.

Supplemental automated validation of correction commit
`2e732c12bc1976a856798d8e04ae1738389bbb4a` returned zero JavaScript/Actions CodeQL
alerts. Its suggested removal of the loading test's finally release was not
adopted: that idempotent release is required if an earlier assertion fails.
The other suggestion concerns the unchanged upload receiver's duplicate-race
400 versus route-level 409; no receiver change is authorized here, and removing
its duplicate guard would weaken rejection. That observation is left for
coordinator disposition, not treated as a production transport defect.
Fresh-code-head CI `34112928196` is `action_required`; MCP log lookup returned
zero jobs, not a passing CI result. Automated validation is supplemental and
does not replace the required independent final review.
### PR #5 Apple-native JPEG diagnostic — 7 September 2026

I04/I05 diagnostic support only, preserving R03/R04/R12/R23, private images,
independent owners and explicit Save. Base main
`bf0ad74dddc4bbc4a3db312dc376edd9495de439`; starting head
`4057679375939b304b213dcdbc8c9ddfe485f92d` (empty platform plan commit).
The coordinator's [current-session receipt 5571425820](https://github.com/drrowdev/stillroom-wardrobe/pull/5#issuecomment-5571425820)
was read before edits: actual `sweagent-capi:gpt-6-astra`, task
`71689469-7d3e-4b5a-adad-2e71e98284a7`, session
`136b1f57-d7a4-4b8b-934b-45478e904415`, observed
`2026-09-07T13:34:08.9224964Z`. It explicitly accepts the platform-created
`copilot/copilotphase0-apple-jpeg-probe` branch spelling.

The full [controlling plan 5571393492](https://github.com/drrowdev/stillroom-wardrobe/pull/4#issuecomment-5571393492)
records completed different-provider prereview: **Anthropic / Claude Opus 5**,
`c4a35485` turns 5/6 and replacement `apple-probe-plan-check`. The approved
observer amendment selects option (b): existing exif/icc/other kind and primitive
marker/length only, no payload-signature classifier. No new plan or runtime fix.
Context consulted: root/Copilot instructions, cloud guide and current Phase-0
evidence; blueprint 00/03/05/07/08/10/14 Phase 0/15 I04–I05/20; image migration/
generated-type references; both JPEG source modules, image spec/fixture helper,
package/lock, Node/TypeScript/ESLint/Playwright config and existing CI; approved
PR discussion, current diff/reviews and CI job-log lookup.

The reported physical-iPhone `outputCheck / invalid` follows source admission,
decode and both encodes; its particular Blob/normalization/validation failure is
still **unknown**. No private image or metadata was supplied. This packet adds
only the separate workflow, existing image spec, optional fixture observer and
this evidence entry. The runtime, validator/normalizer/limits, Save/Auth, schema,
upload receiver, dependencies, existing CI/config and root instructions are unchanged.

Generated opaque sRGB native-four-colour/resize/dense cases retain the last
actual native Blob and dimensions per main/thumb canvas, forwarding callbacks
unchanged. Browser-side independent rechecks separately record Blob read,
normalization, strict validation and replacement, with truthful not-run
prerequisites. These are explicitly **captured-output independent rechecks**,
not instrumentation of private `verifyAndHash` internals; actual `prepareJpeg`
reports only allowlisted stage/code. No unseen thumbnail is inferred.
The strict helper's optional callback gets fresh primitive copies only after
validated collection. Inventories retain the first 64 validated-prefix records,
total/truncated and separate callback-error status; the last record does not
identify a rejecting guard or marker. Node emits generated-only JSON/attachments
and job-summary records before the unchanged success/pixel/hash/size/privacy
assertions. Rejection or unknown error remains failure. The small truncated-tail
regression checks default/undefined parity, prefix retention, copied-record
isolation and unchanged callback-error propagation.

Commands from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`:

| Exact command | Actual result |
|---|---|
| `npm run lint -- tests/browser/image-processing.spec.ts tests/fixtures/jpeg-helpers.ts` | Initial exit 1: redundant initializer and `this` alias; corrected. |
| `./node_modules/.bin/eslint tests/browser/image-processing.spec.ts tests/fixtures/jpeg-helpers.ts` / `npm run typecheck` / `git diff --check` | Each exit 0. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts --project=chromium --workers=1 --retries=0 --grep '(?:^\| )(fresh native four-colour JPEG baseline has independently checked outputs\|resizes without upscaling, preserving portrait and landscape aspect ratios\|dense native synthetic pixels meet both budgets without cross-engine reduction assumptions\|generated JPEG observer retains validated prefix without changing strict failure)$'` | Exit 0, **4/4**. Initial start-anchored grep selected no tests (exit 1); corrected for Playwright's full-title prefix, not widened. |
| Same exact selection with `--project=webkit-photo --list` | Exit 0: exactly four cases in the image spec, no wardrobe suite; listing is not execution. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts --project=chromium --project=webkit-photo --workers=1 --retries=0` | Exit 1: **19 Chromium passed**, 19 WebKit launch failures (missing pinned executable), no skips/retries. |
| `./node_modules/.bin/playwright install webkit` | Download exit 0, existing WebKit 2359/26.6; host validation reports missing Linux libraries. No system packages installed; Linux WebKit remains BLOCKED. |

GitHub API confirmed repository `private: false`. The isolated PR-only workflow
uses one standard `macos-26` arm64 job, 15-minute timeout, existing pinned actions,
read-only contents, no persisted checkout credentials/cache/artifact upload,
and locked npm/Playwright. It records only runner image/macOS versions and
architecture, uses the exact four-case selection above with zero retries and
preserves the test exit code. Trace/video/screenshots remain off. No backend,
hosted inputs or service mutation is needed. The approved plan records standard
public macOS runner cost eligibility; no larger runner or paid service is added.

**Native execution and fresh-head required CI remain external gates.**
Starting-head CI `34128003202` is `action_required`; detailed log lookup found
zero jobs, not a pass. The coordinator reviews the executable diff before trust
authorization; this writer never approves/reruns workflows or waits idle for a
native job. Linux results are not Apple proof. Reproduction and non-reproduction
both end this diagnostic without a runtime correction, platform/quality search,
UI telemetry, merge or deployment. A failing probe stays draft/unmerged.
Mac WebKit is not physical iPhone/Safari, HEIC admission, Save/reload or hosted
RLS acceptance. All earlier evidence and remaining device/privacy gates stand.

### PR #5 approved fresh-encoder APP13 correction — 7 September 2026

This bounded I04/I05 correction preserves R03/R04/R12/R23 and supersedes only
the diagnostic's no-runtime-change stop gate, not its historical observations.
Base main `bf0ad74dddc4bbc4a3db312dc376edd9495de439`; starting head
`e1a8b26f648529563ac957b4c32bfd644d0f2c2e`, branch
`copilot/copilotphase0-apple-jpeg-probe`. The full
[approval 5571889903](https://github.com/drrowdev/stillroom-wardrobe/pull/5#issuecomment-5571889903)
records actual **Anthropic / Claude Opus 5**, reviewer `b5395860`, turns 1/2:
stronger raw-rejection, neighboring-marker, bounds and exact-byte/pixel/hash
oracles, then acceptance of the safer fixed-enum diagnostic amendment.
Coordinator approval preceded this implementation; no new plan or scope was added.

After context review and before edits, the writer reread
[matching native-session receipt 5571919563](https://github.com/drrowdev/stillroom-wardrobe/pull/5#issuecomment-5571919563):
explicitly selected actual `sweagent-capi:gpt-6-astra`, task
`8e082ea3-b110-47b5-bd04-442b5835596b`, session
`72ee9a12-5d5e-4c57-b29c-4ab0ce50561f`, coordinator observation
`2026-09-07T14:14:55.9693217Z`, matching this PR/base/starting head.
The former diagnostic session's receipt is not this task's model evidence.
Context read: `AGENTS.md`, `.github/copilot-instructions.md`,
`docs/cloud-development.md`, latest sections of this result; blueprint
00/03/05/08/10/20, 14 Phase 0, 15 I04/I05 and 13 command contracts; relevant
07/base-migration/generated-type image boundaries; both `src/images/jpeg.ts`
and `src/images/process-jpeg.ts`; JPEG unit/browser/fixture files;
`package.json`, `playwright.config.ts`, existing CI and Apple workflows;
PR #5 discussion/diff/reviews and MCP Actions runs/failed-job logs. The later
wire-failure inspection read the relevant `tests/browser/slice.spec.ts` and
`tests/browser/mock-backend.ts` paths without changing them. Local validation
also used the existing `scripts/db.mjs`, `scripts/run-local-tests.mjs` and
`scripts/backend/local.mjs` contracts; separate hosted guards were read, not run.

**Preserved native failure:** [run 34129040724 attempt 2](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34129040724),
job `101767033286`, macos-26 image `20260831.0337.3`, macOS 26.6.2/build
25G83/arm64, WebKit 26.6: **3 failed, 1 passed** at the starting head.
All six generated inputs reproduced actual `prepareJpeg` `outputCheck / invalid`.
Actual main/thumb reads and normalization were `ok`; strict validation was
`invalid`. Complete inventories had 13 segments before (Exif marker 225,
78 bytes; APP13 marker 237, 58 bytes) and 12 afterward: Exif removed, APP13
retained. No observer/capture error or truncation was reported. This agrees
with [coordinator evidence 5571787062](https://github.com/drrowdev/stillroom-wardrobe/pull/5#issuecomment-5571787062).
Required CI `34129040577` attempt 2 passed at that head, but does not waive
native failure. Neither observation establishes an exact iPhone root cause.

The only production changes are the directly related comment and adding
`segment.marker === 0xed` to `stripEncoderMetadata`'s existing range-removal
condition. Bounds are checked before removal; APP13 payload signatures grant
no permission. Its only runtime call remains after fresh sRGB canvas encoding
in `verifyAndHash`. `assertSanitizedJpeg`, `parseHeader`, `assertEncoderExif`,
all `JPEG_LIMITS`, source admission, orientation and `process-jpeg.ts` remain
byte-unchanged. No blanket APP removal: APP11/12/14, XMP and COM remain retained
and rejected. Raw APP13 still fails the strict validator.

New regressions cover empty/known/unknown APP13 payloads, multiple removals,
inter-scan/post-SOS/pre-EOI positions, variable FF fill, entropy/stuffing/restarts,
exact retained bytes/deltas/idempotence, malformed/truncated lengths, missing
EOI/trailing data and original header byte/4096-segment caps. Generated native
main/thumb injection checks independently constructed expected ranges, same-engine
decoded pixel hashes and independently recomputed final SHA-256 values. Existing
orientation and combined private-metadata rejection tests remain; only applicable
Exif/ICC expected-removal filters now include APP13.

The generated-only probe adds fixed `jfif`, `photoshop-3.0`,
`adobe-photoshop-2.5`, `other`, `not-app` observations and canonical-JFIF boolean.
The bounds-checked classifier skips FF fill, validates the length field and
derives payload start from the validated end; short/unknown/case-mismatched
prefixes, fill and invalid bounds have small checks inside the existing probe.
No raw prefix/payload/error/URL leaves the page. Classifications never gate
runtime removal. Every captured source/main/thumb now also compares decoded
pixels before/after normalization, and all prepared hashes are independently
checked. The fixture observer's primitive kind/API and the four-case Apple
workflow are byte-unchanged; no additional native variant was added.

Commands below ran from `/home/runner/work/stillroom-wardrobe/stillroom-wardrobe`
against this correction's working tree based on `e1a8b26`; the accompanying
commit identifies the resulting source. Logs/artifacts remain ignored or in
`/tmp`, never committed.

| Exact command | Actual result |
|---|---|
| `npm run test:unit -- tests/unit/jpeg.test.ts` | Exit 0, **60/60**, including after browser edits. |
| `npm run typecheck` / `npm run lint` / `git diff --check` | Each exit 0. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts --project=chromium --project=webkit-photo --workers=1 --retries=0 --grep 'fresh encoder APP13 removal'` | Exit 1: Chromium passed; WebKit failed to launch because the pinned executable was missing. Not a pass. |
| `./node_modules/.bin/playwright install --with-deps webkit` | Exit 0; existing pinned WebKit 2359/26.6 and required disposable Linux libraries installed. No package/lock/config change. |
| `npm run test:unit` | Exit 0, **282/282**, 9 files. |
| `npm run check:translations` | Exit 0; 350 EN/FI/SV keys, 26 source files. |
| `npm run build` | Exit 0; existing >500 kB chunk warning remains. |
| `npm run scan:secrets` | Exit 0; 137 text files and canary checked. |
| `npm run check:dependencies` | Exit 0; 12 production/220 development packages, zero unverified release dates; production audit zero critical/high/moderate/low advisories. |
| `npm run test:browser -- tests/browser/image-processing.spec.ts tests/browser/slice.spec.ts --project=chromium --project=mobile --project=webkit-photo --retries=0` | Exit 1: **158 passed, 1 failed**, zero retries/skips. All **60 image tests passed**. Linux WebKit parallel-page actual-wire test failed at `slice.spec.ts:183`: second valid two-byte upload returned 400 rather than 200. |
| `npm run test:browser -- tests/browser/slice.spec.ts --project=webkit-photo --workers=1 --retries=0 --grep 'actual upload wire isolates parallel pages'` | One isolated diagnostic run, exit 0, **1/1**. Does **not** convert the failed suite into a pass or establish its cause. No receiver/assertion change. |
| `npm run test:a11y -- --retries=0` | Exit 0, **21/21**, all configured projects. |
| `npm run db:start` | Exit 0; reused prepared disposable local stack, no reset/restart or account reprovisioning. |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | Exit 0; both ordinary fictional owners' real local image/RPC lifecycle plus **1/1 real recovery browser test**. |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | Exit 0; actual ordinary A/B/anonymous isolation, language, Storage, export and admission checks. No service key in assertions. |
| `npm run db:types -- --check` | Exit 0; committed types exactly match actual local generation, no type-file write. |

All 18 generated probe cases across Chromium/mobile/Linux WebKit reported
378/378 operations `ok`, successful classifier checks and zero APP13 after
normalization. Linux native encoders emitted JFIF/ICC, not Apple's APP13;
the injected APP13 tests therefore remain distinct from the pending Mac proof.
No cross-engine hardcoded pixel hash is used.

**Outstanding gates:** the full affected browser run is not green. The failed
parallel-wire case sends synthetic two-byte Blobs without JPEG preparation;
its unchanged receiver uses coarse 400 for several guards, so the precise
failure remains unproved and needs coordinator disposition, not a scope
expansion or flaky-as-pass claim. Fresh exact-head required CI (including real
Supabase/recovery/security/types) and the unchanged four-case macOS26 workflow
remain PENDING coordinator trust inspection/authorization. Native main/thumb
operations, pixels, APP13 before/absent after, family/JFIF observations and
absence of observer/capture errors must pass on the new head. Independent
final review and merge approval remain separate gates. No worker Actions
approval/rerun, second agent, hosted operation, merge, deployment, HEIC/codec,
provider or later-phase work occurred. Live app is unchanged. Mac success
will still not prove physical-iPhone preparation/Save/reload or hosted acceptance.
