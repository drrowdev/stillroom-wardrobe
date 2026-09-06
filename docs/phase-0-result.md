# Phase 0 - result

Date: 6 September 2026. Phase 0 I01–I05 remains under review on existing PR #1.
The original defects were repaired and baseline CI passed. The approved
continuation adds bounded regression coverage; current validation below also
records a later local reset failure and an inherited accessibility finding.
The exit gate is **not self-approved**; no merge or next phase is authorized.

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

## Approved continuation and current results

Initial implementation commit: `46f61805d46a6622a50c41b32cc6aa31d953f2f8`;
evidence/review clarification commit: `bfe3bd124c939977cf438d29bec3ca26ab34e425`.
Subsequent explicit `unknown` narrowing preserves the same parsed-token policy
and adds primitive-JSON regression cases. Final head is recorded in PR replies.
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

## Remaining limits

* Fresh-head full CI approval/run, current clean-stack integration/type parity
  and the loading-state accessibility finding remain review gates.
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

## Publication and rollback

This is an initial WIP source snapshot, not a deployed release. No prior
production application or data is changed. Stop the preview or revert the
new source commit to roll back; never reset a live database. Subsequent
cloud work must use a pull request and update this report with actual
commands, results, commit and remaining limits.
