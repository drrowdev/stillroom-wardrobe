# Phase 0 - result

Date: 6 September 2026. PR #1 was merged with explicit user approval into
`f696ee45e5dfe46be90cbc295a9811ec1d34a298`. Phase 0 I01–I05 hosted readiness
continues only on PR #2; full Phase 0 is **not complete**. Earlier reset failures,
accessibility findings and their later repairs remain below as historical
evidence. No new merge or next phase is authorized.

## Current PR #2 hosted-readiness packet

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

The [actor/gate table and private smoke contract](cloud-development.md#hosted-state-and-responsible-actors)
assign remaining work: coordinator verifies actual dashboard/management Auth
settings (global/anonymous signup off, password/email provider on, exact site/
redirect URLs and no phone/OAuth), live HTTPS/assets/headers and private owner
admission; user supplies actual identities privately; approved private operator
runs read-only smoke after prepared non-personal fixtures exist; humans verify
actual phone/Safari camera/library, VoiceOver/TalkBack and three-language journeys.
No hosted credentials were requested/read and no hosted test or operation ran.
Reachable static HTML would not prove login, storage isolation or full Phase 0.

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
the installed hosted schema; Pages remains on the separately reviewed main
deployment until coordinator verification/authorization. Independent accounts,
EN/FI/SV and the manual editable draft/explicit Save are preserved. Phase 2's
photo-first AI-filled title/category and all-field editing remain unimplemented;
no automatic library save, post-save worker, outfit AI or paid activation.
