# Disposable local backend

## Implemented scope and current evidence

The local tools use the pinned Supabase CLI **2.116.0**, Node 24 and Docker. They do not install Docker, create cloud resources, link projects, use a management API, or reset remote databases. Host `psql` is not needed: the isolated provisioning process uses `docker exec` into the specifically labelled local database container, connecting to that container's own loopback Postgres endpoint with stock local trust authentication. It refuses password prompting.

The initial migration is a byte-for-byte copy of `blueprint/07-DATABASE-AND-RLS.sql`, revision 1.1, including its transaction. SHA-256:

```text
4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5
```

Supabase retains management of the Auth and Storage schemas. No stubs, embedded database, additional migration, AI endpoint or paid generation is substituted for them.

### Historical initial-local evidence (5–6 September 2026)

The initial local environment had no Docker installation/daemon. Real Auth,
Storage, migration execution, generated types and live security/integration
were blocked there, not completed. Unit tests covered safety/refusal paths
only; no placeholder `database.types.ts` was generated.

Local verification: **32 backend unit tests passed**, scoped ESLint passed, backend unit TypeScript checks passed, and all owned `.mjs` files passed `node --check`. Installed CLI version/command help were inspected; its status command failed on missing Docker with no reported configuration parsing error. `start`, `reset`, `types`, and `types --check` each returned exit 2 / `NOT RUN`. Real-test commands also returned exit 2 for missing consent/credentials. These are refusal-path results, not live authorization evidence.

### Current standard-stack evidence (6 September 2026)

[CI 34025264676 attempt 2](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34025264676)
passed at `f20c745eec9084cc900770cb2b206100ad94b784`. Real local Supabase job
`101466868242` completed standard start/reset, ordinary integration/security,
actual `npm run db:types`, tracked-file verification and zero generated diff.
App/browser job `101466868103` passed all gates and 40 Chromium cases.
The current prepared cloud setup also completed standard start/reset/provision
and actual generation (agent run `34026811034`, job `101469132212`).
See `phase-0-result.md` for continuation commands/results and remaining gates;
baseline CI does not validate a later implementation head.

## Email-provider semantics and admission

`[auth.email].enable_signup = true` maps to `GOTRUE_EXTERNAL_EMAIL_ENABLED`,
the whole email provider, not just password grants. Backend recovery and
OTP/magic-link capabilities remain subject to their configuration and delivery
prerequisites. The historical baseline exposed password login only; PR #3 adds
the isolated password-recovery flow described below, not generic email login. Client
`detectSessionInUrl: false` does not disable backend endpoints, and legitimate
approved-account email authentication is not an admission defect.

Public signup remains disabled globally, anonymous sign-in is disabled, and
the admission trigger plus enabled-owner RLS remain unchanged. Inbucket was
disabled in that baseline; its cold-prepared PR #3 enablement is recorded below.
The existing live security harness sends email requests only for one
fresh unapproved fictional address, never either approved account.

With pinned CLI 2.116.0 / Auth **v2.196.0**, the harness requires:

| Request | Observed/required result |
|---|---|
| OTP `create_user: true` | 422, `signup_disabled`, no usable session |
| OTP `create_user: false` | 422, `otp_disabled`, no usable session |
| Recovery | 200 with empty JSON, no usable session |
| Invalid email and recovery verification | 403, `otp_expired`, no usable session |
| Approved A/B afterward | Normal password login and own-profile access still work |

Recovery's anti-enumeration 200 is not admission or proof that an Auth row is
absent. Wrong-password failure would not prove absence either. These checks
verify real global creation denial, not independent execution of the SQL
admission trigger behind that gate. Any 5xx/transport outage is BLOCKED and
nonzero, never passing authorization evidence; unexpected 4xx fails too.

Confirmation settings are not a blanket requirement to email on every password
change. Pinned Auth's
[password-update code](https://github.com/supabase/auth/blob/v2.196.0/internal/api/user.go)
requires reauthentication under secure-password-change policy when the session
is absent or older than 24 hours; a recent session does not require that nonce.
Password-change notification is a separate setting. Email confirmation and
double-confirmed address changes are distinct flows; see
[signup](https://github.com/supabase/auth/blob/v2.196.0/internal/api/signup.go)
and [verification](https://github.com/supabase/auth/blob/v2.196.0/internal/api/verify.go).
Those baseline observations were source-verified semantics, not live
password-change/mail tests; that security harness changed no approved passwords
or addresses. The separate current recovery proof is below. OTP/recovery source:
[OTP](https://github.com/supabase/auth/blob/v2.196.0/internal/api/otp.go),
[magic link](https://github.com/supabase/auth/blob/v2.196.0/internal/api/magic_link.go),
[recovery](https://github.com/supabase/auth/blob/v2.196.0/internal/api/recover.go).

## Real local password recovery

PR #3 follows approved plan `5561361106`, controlling approval `5561846573`
(merged PR #2), and config-only amendment `5562318484`. The committed Inbucket
setting is enabled on fixed port **54324** before cold setup. Cold CI
`34061709323`, attempt 2, passed at `56102303d84b20d53c2b15f024330f434d4e154e`;
comment `5562445077` records baseline readiness, not recovery proof. Do not
toggle/restart an old stack, weaken Auth settings, or reset uncertain fixtures.
Unexpected cold-service failure is a coarse blocked stage requiring review.

`ALLOW_SECURITY_TESTS=1 npm run test:integration` first runs ordinary backend
integration, then `tests/integration/recovery.spec.ts` via
`playwright.local.config.ts`. Existing Chromium is required. Vite serves
**127.0.0.1:5173**, `--strictPort`, `reuseExistingServer: false`; an occupied port
fails rather than reusing another server. The existing redirect allowlist and
`secure_password_change=true` are unchanged.

The separate mail guard accepts only fixed **http://127.0.0.1:54324**, no
authentication/apikey headers, redirects or environment override. The pinned
CLI's Inbucket-named container serves Mailpit: `/api/v1/messages?limit=1000`
and bounded `/api/v1/message/{id}` reads. The original API **54321** guards are
unchanged. One actual `/recover` is sent per recovery-test run; the prior-ID
cursor, intended fictional recipient, received time and hard deadline must
identify a new message. The real security suite's separate unapproved-address
request remains unchanged.

The requester context R is closed before the actual Auth link is consumed,
without prefetching, in a new no-opener page in context C alongside ordinary B.
The test checks early URL scrubbing, explicit unselected server-email
confirmation before password fields, original-bearer-only recovery traffic,
one password update, affirmative HTTP global logout, new-password UI login,
old-password refusal, B's pre-existing ordinary Node-client refresh and browser
liveness, and unchanged owned synthetic item/image bytes and profile fields.
Finally, ordinary login/self-update restores A's original password, versioned
language restoration and owned fixture cleanup run, and both original logins
and own profiles are verified. Cleanup preserves the primary failure; any
unreconciled state is nonzero and **stops shared suites**, never admin repair,
cache rewriting, account recreation or a reset.

Actual local SDK protocol-only feasibility passed first at commit `ba40ad6`.
The completed real UI journey subsequently passed under the same secure policy.
Both accepted a raw **72-byte** password; pinned Auth's
[bcrypt implementation](https://github.com/supabase/auth/blob/v2.196.0/internal/crypto/password.go)
corroborates the compatibility cap. This is not a measured hosted policy.
The standard successful redirect includes an empty `sb` marker
([pinned source](https://github.com/supabase/auth/blob/v2.196.0/internal/tokens/service.go));
the parser accepts it only once and empty, alongside the bounded recovery
fragment. It still rejects code/token-hash/generic magic-link/OAuth flows.
`type=recovery` is intent, not cryptographic recovery provenance: server
original-access identity plus own-profile RLS establish the admitted target.
Opaque refresh tokens are never exchanged; all token grants are denied and the
150-second expiry margin is a precaution, not a refresh strategy.

Real-fixture runs disable trace, video, screenshots, page snapshots and server
stdout/stderr. No mail body, reset URL, password, bearer or raw SDK error is
printed. Only coarse stages/booleans are reported. Mocked browser/unit variants
cover cancellation, races, expiry, errors, bounds, EN/FI/SV, keyboard/paste and
accessibility; mocks and emulated devices are not hosted or physical-phone proof.

## First local run

### I29e staged AI control fixtures (source/local CI only)

The full `npm run db:reset` branch invokes
`scripts/provision-ai-control-fixtures.mjs` **after** the unchanged core
provisioner. Start/types and the base-preservation provisioner are unchanged.
There is no hosted target, admin-key/status fetch, owner impersonation,
JWT/GUC/SET ROLE, new role, extension, environment override or fixture self-heal.
The seeder requires existing project, local Docker socket/container, literal
loopback and credential-cache guards, exactly the two matching fictional core
accounts, and empty new AI tables before setup. Used/unexpected state fails.
Existing `ALLOW_SECURITY_TESTS=1` is required; the seeder never invents an opt-in.

P1–S6 are ordered checkpoints, with finite named normal children in S4 per the
accepted PR #16 clarification. All owner actions/assertions use actual A/B
password HTTP sessions in `normalSessionEnvironment`; only setup, trusted-server
RPC calls, named timestamp seeding and SQL metadata inspection use privileged
local SQL. No values, UUIDs, tokens, SQL or HTTP bodies are printed.

* **P1:** normal UNCONFIGURED/default-deny, failed enable leaves profiles exact,
  withdrawal without configuration.
* **S2:** setup fictional policies with the **same** model `fictional:controls/v1`,
  prompt 1, notice 1 and TTL 3600 for both owners; max reserve 5000 micro each.
  A allowance 15000/rate 20, B allowance 100000/rate 3. A's finite spare rate
  capacity accommodates eight named scratch requests; it does not weaken the
  independent allowance race. No real provider/budget approval is implied.
* **P3:** normal consent CAS and stale denial, all twelve old profile UPDATE
  columns including trigger-neutralized timestamp/version input, A ready/expiring
  and B ready/spare reservations, exact replay/conflicts, active-draft denial
  before exhaustion, and separate monetary/rate races with exact rejection codes.
  Each race admits exactly one request with one reserve/count delta.
  Temporary normal-owned item/image/outfit/history fixtures use the existing
  632-byte synthetic JPEG and real authenticated Storage; raw rows and downloaded
  byte hashes are compared around controls, then exact owned fixtures are removed.
  This is not private-photo/provider transfer or a new capture scenario.
* **S4:** trusted dispatch/settlement creates distinct ready A/B results; named
  normal children release race/spare reservations, reserve scratch requests,
  withdraw/restore consent, read and discard. Release preserves admitted counts.
  Server checks distinguish NULL from zero, never-dispatched release from held
  failure, once-only dispatch, withdrawal/expiry denial, billing after removal,
  immutable delayed-result lifetime, equal/different bills/facts, invalid facts,
  a 16000-micro overrun and a one-micro anomalous late charge without dispatch.
  No limit/balance reset occurs. Named scratch requests finish closed; no unknown
  hold is silently refunded.
* At the end of S4, only named new paired ledger/request timestamps and UTC
  periods are seeded consistently into the past. A delayed-completion scratch
  preserves its original one-hour lifetime. The purge scratch and A expiry
  fixture become expired; a **limit-one** purge removes exactly one of two full
  rows, retaining a held charge until known reconciliation. These are
  **fixture-seeded clocks**, not elapsed real-time retention evidence.
* **P5:** a normal owner reads the remaining expired fixture against actual server
  time, receives no facts and removes the full context. Both owners finish
  configured/consented with distinct ready results; final A accounted cost is
  16001, B zero. No new reserve can bypass the tested allowance/rate.
* **S6:** privileged structural verification checks two remaining ready full
  rows, fourteen admitted ledger rows, twelve explained closures, no outstanding
  reserved/held rows and retained expiry reason/cost. SQL grants/RLS and actual
  export executable body/attributes are checked separately from Data API schema
  refusal; these are not administrator assertions of owner access.

The ordinary integration/security runner invokes the **full** new modules.
Later runs are non-consuming/re-runnable read, replay, denial, isolation,
terminal-state and immutability checks, including both directions with real
ready peer data. Missing/changed/expired fixtures fail with reset guidance.
They do not silently reconsent, reseed, refund or skip a subset.

Preservation pins all five migrations: base-only applied/four pending, the one
existing migration-up, then five applied/none pending. Its original two owners,
ten tables, thirty rows, eight object byte comparisons, raw old timestamps/
versions and 512-KiB run-bound snapshot remain unchanged. New AI profile defaults
are checked separately in normal owned reads; the old profile/export oracle
excludes them. This seeder never runs in the base rehearsal.

**Stage 1:** generated types stay unchanged. Native validation is static/unit/
synthetic-browser only; no extra local DB startup/reset/up/list/provision/psql/
typegen/rehearsal. Parent trust/review and first exact-head CI must prove actual
schema, fixtures, ordinary access, preservation and generation. Only subsequent
old committed-type parity may be an anticipated staging failure, never a final
pass. **Stage 2:** a separately verified continuation imports only the verified
exact-head generated artifact's text, then fresh final CI proves exact parity.

Logical expiry and opportunistic/server deletion are not an inactive-account
24-hour physical retention guarantee. No scheduler is installed; paid/private
photo activation, provider/account/notice/allowance setup, hosted migrations and
deployment remain separately blocked. Live/source/hosted state is unchanged.

Install/start Docker separately, using a local Unix socket or Docker Desktop Windows named pipe. Ensure ports 54320–54322 and 54324 are free. Docker contexts pointing to SSH/TCP daemons and `DOCKER_HOST`/`DOCKER_CONTEXT` overrides are deliberately refused. Use the Docker CLI's selected local context.

On Windows, use `npm.cmd` if PowerShell script execution blocks `npm.ps1`:

```powershell
npm.cmd ci
npm.cmd run db:start
npm.cmd run db:reset
npm.cmd run db:types
$env:ALLOW_SECURITY_TESTS = '1'
npm.cmd run test:integration
npm.cmd run test:security
npm.cmd run db:types -- --check
npm.cmd run dev
Remove-Item Env:\ALLOW_SECURITY_TESTS
```

On Linux/macOS:

```sh
npm ci
npm run db:start
npm run db:reset
npm run db:types
ALLOW_SECURITY_TESTS=1 npm run test:integration
ALLOW_SECURITY_TESTS=1 npm run test:security
npm run db:types -- --check
npm run dev
```

`db:start` launches the actual local services, checks the known database container, and verifies a healthy Auth HTTP response. Initial Docker image downloads can take several minutes. CLI output is captured rather than printed because startup/status can include credentials.

`db:reset` is destructive **only to the disposable local stack**. It checks Docker locality and the database container's exact name, Supabase project label, Postgres image and running state. It invokes `db reset --local --no-seed`, never `--linked`, `--db-url` or `--project-ref`; extra arguments are rejected. A changed initial migration hash also aborts the reset.

After successful migration, a separate Node process runs `scripts/provision-test-users.mjs`:

1. Read CLI status JSON into setup-only memory, never console output.
2. Through local container `psql`, reserve two independent fictional approval slots using `scripts/reserve-accounts.sql`. Refuse unexpected existing identities. No password is passed in SQL, a process argument or a command log.
3. Generate independent random 32-byte passwords and save the local credential cache **before** Auth creation, so an interrupted fixture can be resumed.
4. Create each missing confirmed Auth account once with the SDK admin API. Already-created accounts are verified normally; passwords are never silently rotated.
5. Verify each owner's profile with normal password login, then sign out. This is labelled setup verification, not the security access suite.

To retry interrupted provisioning without wiping data:

```powershell
node .\scripts\provision-test-users.mjs
```

Fixtures use `user-a@example.test` and `user-b@example.test` exclusively. Credential cache: ignored `.supabase/test-users.json`, mode 0600 where supported, parent directory mode 0700. Windows mode bits do not replace ACLs: keep this folder restricted to your user. Never publish/cache/upload this directory in CI. The file contains only fictional login credentials and public configuration, not a service key. If existing identities have no valid matching cache, provisioning refuses; reset this disposable stack rather than modifying unknown account credentials.

Provisioning creates `.env.local` **only if absent**, with the public URL/key and app version. It never writes passwords/admin keys there and preserves every existing file. If existing public configuration is different, review it manually; no remote config is silently replaced. The expected frontend URL is `http://127.0.0.1:54321`. Retrieve local login credentials from the private cache in your editor/password manager, not by dumping them into logs.

## Security/integration execution

Both commands require explicit `ALLOW_SECURITY_TESTS=1`. Without complete local credentials or a healthy local Auth service, they return **exit 2 / NOT RUN**, never a skipped pass. Assertion/cleanup failures return nonzero. The wrapper itself performs no CLI status or privileged requests.

By default the wrapper reads the fixture cache. Alternatively supply the complete set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, `TEST_B_PASSWORD` through a private process environment; partial explicit configuration does not fall back to another identity. No CLI password arguments or dotenv secret auto-loading exist.

The child process receives only those six settings, `ALLOW_SECURITY_TESTS`, and a short OS-runtime allowlist. Administrator/database credential variables are refused; `GH_TOKEN`, `GITHUB_TOKEN`, unrelated tokens, `NODE_OPTIONS`, cloud credentials and service keys are not inherited. Both harnesses independently validate configuration, even when invoked directly. Remote overrides do not exist; only literal loopback HTTP origins on port 54321 are accepted, and authenticated fetches refuse redirects.

* `tests/security/rls.sessions.mjs`: adapted supplied normal-session harness and original synthetic JPEG. Real A/B/anonymous Auth/REST/Storage calls cover private tables in both directions, owner override/FK/RPC rejection, no profile directory, independent Finnish/Swedish preferences, export ownership, foreign Storage download/sign/list/upload/delete, and disabled public/anonymous signup. Owners verify unchanged values and file hashes.
* `tests/integration/local.sessions.mjs`: distinct real normal-session checks for schema/profile access, explicit item creation, duplicate IDs, stale versions, image reservations and authoritative paths, incomplete commits, JPEG upload/hash retries, no overwrite, owner listing/signing, idempotent commit, interrupted replacement, and atomic outfit RPC retries.
* Both clean up only generated fixture IDs through normal owner sessions; security restores each previous language with version checks. No bulk privileged cleanup runs inside assertions. Do not run suites concurrently against the same fixture accounts.

This Phase 0 harness does not claim physical-device behavior, account-freeze orchestration, paid inference, full backup restoration or deletion Edge Function coverage. Those remain separate gates; password recovery is covered only by the dedicated local journey above.

## Actual database type generation

`npm run db:types` requires the real running local container and invokes the pinned CLI `gen types typescript --local --schema public`. Only successful plausible generator output is atomically written to `src/data/database.types.ts`. `--check` compares the exact output, including line endings, and fails on a missing or differing file. Nothing is hand-generated from the SQL and failures never replace a previous file.

The actual generated file is now committed and used by `AppClient` and the
`src/data/rows.ts` projections. Runtime guards remain, but are not schema
generation evidence. `--check` invokes real generation and compares exact
bytes; it is not a visual inspection of a generated-looking file.

A Docker-capable Ubuntu CI runner can execute the same real-stack commands. Its first type-generation run must use `npm run db:types`; `--check` intentionally fails until the generated file is present. If retrieving generation from CI, upload **only** `src/data/database.types.ts`, never `.supabase`, `.env.local`, CLI status output, test credentials or session state. An artifact alone is not an integration pass: retain the actual job outcomes separately. Subsequent CI runs can use `--check` against the reviewed committed file.

## Targeted local validation

```powershell
npm.cmd run test:unit -- tests/unit/local-backend.test.ts
node .\scripts\db.mjs start
node .\scripts\db.mjs reset
node .\scripts\db.mjs types --check
```

Without Docker, the last three commands report `NOT RUN` and nonzero status.
That historical refusal is not a passing live backend test, nor does it negate
the later successful standard-stack CI evidence above.
