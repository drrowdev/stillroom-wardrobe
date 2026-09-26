# Disposable local backend

## Implemented scope and current evidence

### HC1 hosted Storage compatibility - 23 September 2026

[Owner amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/30#issuecomment-5791405199)
and [reviewed plan with binding A1-A6](https://github.com/drrowdev/stillroom-wardrobe/pull/30#issuecomment-5791784903)
replace the historical T20/T26 publication-ALWAYS installation requirement below
with one strict **O/origin** contract. The executable reserved-owner installer is
removed. All eleven migration bytes, publication/deletion function bodies, locks,
RLS and pending-object read/hash retry behavior are unchanged. Historical SQL
comments and earlier evidence remain historical, not the active installation rule.
The app-owned `item_image_identity_guard` still requires **A/ALWAYS**.

O is not equivalent to A: privileged replica-mode bulk operations are unsupported
while the application is live. The verifier proves its own postgres connection is
in origin mode, not that every hosted Storage connection uses it. Actual hosted
Storage version/runtime/privilege compatibility, quiescence and admitted-request
drainage, coherent recovery, Auth/API/Edge EU and Cloudflare gates remain separate.
No local command or source change authorizes hosted writes, reset or deployment.

The serial preservation rehearsal retains populated1->10,9->10 and10->11 lanes.
After their served finalizer shuts down, one additional fixed reset creates
schema6 fixtures, followed by one existing `migration up --local` through7..11.
Exact six-applied/five-pending and final eleven-applied histories, immutable source
hashes and unchanged container identity are required. Six/seven/eight are not
verifier readiness profiles; no intermediate pause within migration-up is claimed.

Both fictional owners retain nondefault provenance, revised description counters,
profile/preferences/history/link values and ready/retired images, plus completed
and pending checked Saves. All16 preserved objects use the existing632-byte JPEG.
One further ordinary never-uploaded reservation/deletion per owner proves
item/image/attempt absence and used-ID retention before capture. Public inventory
is38rows, with4 live attempts,6 used IDs and8 images; the exact image/used-ID UNION
contains10 registry entries, including two used-only identities.

The closed memory-only public snapshot and owner-scoped private comparison retain
32-row/table and512-KiB bounds. Private preservation covers exactly
`item_save_attempts`, `item_save_used_ids` and inactive `ai_controls`; only the new
null `execution_manifest_id` is allowed. Requests/usage must be empty in this lane.
Only enumerated new image-change/deletion tables must start empty; the two
source-installed execution manifests are not unexpected data. Existing later-schema
AI preservation lanes remain distinct. Full public/byte/private comparison precedes
completed replay and pending-byte/hash verification/resume. The original normal-owner
publication cases run again at eleven, including rejection of an admitted slow
upload after FINISH and actual literal Storage-catalog prefix count zero.

Capture, comparison and replay/probes each have120-second phase budgets; ordinary
requests retain15-second limits and the existing race/settlement/cleanup bounds
remain unchanged. There is one owned stack, no extra job/matrix/retry and no
increase to the30-minute CI job cap. Accepted-main run35817276066/job107041392123
took6m35s overall and1m53s for rehearsal; these are prior measurements, not new
lane execution evidence or a performance prediction. Native HC1 proof is pending.

### I08 Stage 1 source-only candidate (13 September 2026)

The initial 13 September I08 candidate added a strictly pinned ninth migration,
`20260913120000_item_lifecycle.sql`, historical canonical LF 15332 bytes,
SHA-256 `38de5f1b7bd4edd0f7e3829f90e1b1486c0b32385c1bd75b03b7dee9263ba1c5`.
The current T29 source candidate is canonical LF 20822 bytes,
SHA-256 `8cc0fc1207737d63b7e1d000fc7471a9941a4833aaebebc75979c498a4d6c476`;
neither fingerprint claims hosted installation or completed lifecycle evidence.
All eight earlier pins and base-to-target content comparisons remain unchanged.
History parsing requires all nine exact names/versions/times; this is not a
permissive migration-count increase. Existing checked-Save catalog evidence
remains separate from the new positive claim/RPC/trigger/Storage-policy checks.

`run-local-tests.mjs` adds the I08 ordinary integration/security children after
the unchanged existing children and before integration's recovery selection.
They use only the existing normal-session environment. The source tests cover
versioned Trash/Restore, exact replay and reload versions, pending/orphan refusal,
partial actual Storage cleanup, retained versions, legacy DELETE, snapshots,
owner-local nonce reuse, private406 and foreign-row/byte preservation. Seeded
legacy timestamps on either side of seven days are labelled fixtures, not
seven days of observed operation. Ordinary Promise.all samples are not forced
overlap proof.

T29 replaces only `wardrobe_read`: its existing manifested-read branch remains,
and the existing approved-owner canonical-prefix delete predicate is admitted
only during native `storage.object.delete`. PostgreSQL SELECT visibility is
also needed by the pinned singular DELETE/RETURNING query. Normal orphan
download/sign/list and bulk deletion remain excluded, even with spoofed operation
headers. The already pinned native operation-function contract now fences read
as well as delete; any future vendor upgrade needs re-review. This is an ordinary
API boundary, not a claim that privileged/direct SQL cannot set custom GUCs.
DELETE/INSERT policies, all eleven bodies and owner installation stay unchanged.

The nineteen-key catalog retains separate shape and exact-qual operands inside
`storageReadDelete`, plus the complete three-policy set. Its new deparsed SELECT
string is derived, **not yet measured**; one false combined boolean alone does
not distinguish a shape mismatch from a text mismatch. Marker helper diagnostics
label setup/callback/cleanup-count/removal/final-absence and retain distinct
primary/cleanup phases, exact/falsy errors and the original cleanup notice.
Caller labels identify the failing callback operation without losing it to
later removal. Real-byte orphan regressions use existing ordinary A/B/anonymous
fixtures, explicit own bulk refusal, foreign/anonymous singular refusal, strict
owner `removed` acknowledgements and subsequent status/NoSuchKey absence.
Initial byte/hash checks and replacement-byte checks are not downloads of
inaccessible orphan bytes, nor provider physical-erasure proof.

Cycle6's unlogged first HTTP failure remains unknown. Its reviewed1a6 catalog,
App/Apple and18existing visual results are historical, not T29 acceptance.
New definitions remain unexecuted locally. No seventh cycle, local runtime,
Stage2, generated types, browser400 resolution, Save-uncertainty waiver or hosted
cutover is authorized by this source change.

Only preservation rehearsal defines/executes the special CI fixture callbacks,
after unchanged preservation comparison and positive catalog verification.
The fixture gate requires CI, GITHUB_ACTIONS, ALLOW_PRESERVATION_REHEARSAL and
ALLOW_SECURITY_TESTS literal opt-ins, a validated local container and newly
allocated `1080`-prefixed disposable item UUIDs. It does not borrow B2's `b229`
guard or accept arbitrary SQL/table/owner overrides.

The lock callback holds exactly one owned parent row in UPDATE or KEY SHARE;
its SQL acknowledgement proves the lock is held before normal HTTP assertions
begin. It is released by rollback, with a 15-second deadline and closed output.
Tests observe the real Storage wrapper's fixed-conflict response (otherwise
fail), verify unchanged draft/IDs/rows, then explicitly retry after release.
The original marker callback inserted an unmanifested marker after claim; the
T20 repair below supersedes that incompatible fixture with canonical pending
metadata and an ordinary legacy-delete orphan. It has no bytes. Normal BEGIN
must refuse the orphan without an irreversible claim; singular API cleanup and
labelled catalog1-to-0 verification are mandatory. No fixture profile,
shared row, production RPC or provider-side blob is created/deleted by setup.

**At initial source review, none of this candidate had executed locally or in CI.** Local tooling
restoration and all runtime probes remain prohibited by the source-only receipt.
The candidate must stop unstaged for coordinator review; there is no publication
or run budget. An eventual Stage 1 cycle needs all preceding checks plus actual
generated-type upload, with only the specifically approved final four-RPC type
parity difference allowed as an intermediate red, not backend PASS. Actual
generated types and Stage 2 UI/captures, full exact-head CI/Apple/live/visual/
independent review remain later gates. No new run or rerun is authorized here.
Original Save uncertainty/stop-on-recurrence, production/privacy/paid/deployment
holds, manual/device acceptance and saved-only recovery/export release work
remain unchanged.

### I08 original cycle failure and R3 source correction (13 September 2026)

[Original-cycle evidence](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5653886139)
records CI34761885375 attempt1 at source `e8829d1`, with the actual PR merge
checkout sharing tree `75ad01054f059d5b588115649e5a89a039020697`.
App lint failed with three `no-unsafe-finally` errors. Backend's strict nine-source
inventory, migration application, populated preservation and both catalog checks
passed, then the held-upload fixture failed without a response/substep record.
That does not establish HTTP500 or its cause. Later backend/type-generation,
App/browser and visual gates did not run; there were zero artifacts.
Apple34761885372 attempt1 passed its four generated JPEG and three approved
orientation/composition cases, not physical-device or I08 UI acceptance.
The original cycle is consumed and failed, not the anticipated final type diff.

[T16 AMEND with binding corrections](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5653989229)
and [matching source permission](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5654022792)
bound R3 to five source/document files. The candidate moves fixture rethrows
after cleanup, outside finally. Explicit flags retain exact/falsy primary and
first cleanup values. Mandatory child end/termination/closure/timer, marker
delete/count/absence and outer fixture cleanup are individually guarded;
fixed notices cannot replace an earlier failure. A failed closure deadline
remains failed release evidence, never proof that the child/lock disappeared.

Only the existing held-parent negative POST uses a test-local response reader.
It retains the exported local/session/key guards, verified ordinary owner,
exact thumb path, four synthetic bytes, original headers, no-store,
redirect:error and 15-second request timeout. There is no extra request,
sign-in, retry, general helper option or change to shared normalClient.
Headers/status precede bounded incremental body reads; at most4096bytes are
retained. Strict UTF-8 and a non-array JSON object are required for classification.
Missing/empty bodies cannot pass. Overflow fails with `truncated:true` and
`bodyBytes:null`, not a clamped count or Content-Length estimate. Cancellation
and reader release are both attempted without masking the first failure.
The original floating elapsed interval includes body handling/cleanup; only
record metadata is rounded. **HTTP<500 remains required**, alongside `!ok`,
the existing <5000ms limit and exact conflict classifier. Even an exact-conflict
500 is diagnostic failure, not a new acceptance class.

One validated JSON line, at most1024UTF-8bytes, is attempted after each held
phase settles and before outer cleanup. The two-owner fail-fast loop permits
zero records before any attempt, one after a first-owner failure, or two if
the second owner is reached. Unobserved values remain null; stages and all
code/message/error-shape classes are closed. No IDs, paths, headers, raw body,
private strings or digests are printed. Serialization/output failures fail
the evidence gate. The distinct parent-release notice remains authoritative
for failed release; `released` is set only after a normal holder return.
Observation has bounded nonzero overhead, not a demonstrated causal effect.

R3's behavior/mocked fault tests are source definitions only: no local runtime
or test executed. The candidate remains unstaged for coordinator review.
No new CI/Apple cycle, publication or Stage2 is authorized. Actual lint,
unit/typecheck, normal-owner/Storage/lock/recovery/type/browser/visual evidence
and every original Save, production, hosted, paid and release hold remain.

### I08 T20 final-publication repair - source only (13 September 2026)

[Approved nineteen-path plan](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655317164)
and [fresh writer attestation/edit permission](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5655347691)
authorize the coherent source correction, not execution or publication. Original
and R3 cycles both failed and are consumed; R4 is local240b8030, not published.
The actual500 raw body remains unknown. Pinned Storage maps22023 to DatabaseError500
and55P03 to ResourceLocked; this source explanation does not reconstruct that body.
The new Storage helper uses55P03 and strict HTTP400/body423/ResourceLocked.
The existing <5s gate and every5xx failure remain.

Storage1.70.3 (`288dd95c4c06f3df72a2369ea5196a8e400aeed7`) rolls its
permission probe back before transfer. A source-approved app-owned immediate
AFTER/ALWAYS trigger fences final INSERT and identity/version-changing UPDATE for
every role. Profile/approval/image/parent SHARE NOWAIT locks survive publication;
fresh checks reject canceled Save, retired/nonpending images, trash/claims and
missing owners/items. Native owner_id is authoritative text; deprecated owner
may be null. Probe version1 is not mistaken for a UUID. Unchanged identity/version/
dark flags permit genuine metadata maintenance. The private owner/image ID pair
prevents rebinding; it is retained until actual Auth deletion, not profile
clearing or disabling, under the user's limited-retention decision.

Standard native upload and singular native DELETE predicates accompany one shared
erasable TypeScript deletion helper and all normal fixture callers. Only exact
acknowledged success is `removed`; exact NoSuchKey is distinct `missing`, and
AccessDenied/unknown/malformed/5xx fail. Missing is not byte proof. No bulk-success
mock, new auth/HTTP harness, endpoint, dependency or AI invocation substitutes for
this protocol. Future Node24 execution imports the helper explicitly as `.ts`.
The blueprint reference validation script is historical and **not executed or
updated** as part of this repair.

After nine-source preservation, future rehearsal checks nineteen positive
application catalog properties, including exact eleven routine-body hashes,
ACLs, trigger type/ALWAYS/nondeferred state and two-ID registry/Auth FK. A bounded
32768-byte schema-metadata-only Storage trigger/function/column/constraint
inventory and SHA256 are emitted as **REVIEW_REQUIRED**, not auto-enrolled as a
compatible baseline. Actual0055/0058/0062 and any unknown executable/versioning
behavior must be reviewed by the coordinator before compatibility acceptance.
No row contents, credentials, image bytes or private-schema function bodies are
included. This adds no separate inspection-run permission.

The real late-upload fixture uses two ordinary owners and one four-byte POST
each inside the verified owned FileBackend container. CLI2.116.0 stable selects
the legacy start handler and Storage service; its source config is file backend,
`/mnt`, tenant/global bucket `stub`, and the project-named volume. Runtime checks
must still verify exact container/project/image content ID, repository digests,
mount and the four nonsecret config values. Source assumptions do not pass them.
There is no additional control upload or broad directory discovery.

Each child receives only the ordinary token and fresh1080 fixture IDs via bounded
stdin, in a stripped environment. It sends two bytes and withholds the last two.
Readiness requires an actual single UUID-version regular partial file of size2,
under the exact fresh namespace, with symlink/type checks and at most100 polls/
5s; client write completion or a sleep is not readiness. No file content is read.
After readiness the fast normal pair is uploaded, checked Save completes, and
Trash/BEGIN/two acknowledged singular removals/FINISH complete before release.
The withheld bytes are then sent; publication must fail, followed by labelled
privileged catalogprefix0 and ordinary download/sign/list/row absence checks.
The direct container HTTP test is not proof of gateway buffering behavior.

Child HTTP/body/IPC/deadlines are bounded (4KiB body,1KiB closed output,15s).
Requests and closure are observed, cancellation is attempted on every failure,
and exact/falsy primary and first cleanup failures survive secondary notices.
Unacknowledged child closure is failure, not proof of termination. The no-blob
marker now passes the real publication guard for a pending canonical image;
ordinary unclaimed deletion creates the orphan. Its true singular API cleanup
uses FileBackend's missing-file-safe deletion and catalogue1-to-0 checks, never
the0055 internal flag or privileged SQL DELETE.

The accepted limitation is inaccessible interrupted-upload remnants **without a
verified cleanup deadline**, not physical purge, async cleanup proof, failed
accessible deletion, backups, or an indefinite visible hold. Historical TUS JSON/
other companions have potential authorization exposure, not a verified cross-owner
or anonymous exploit; outer registration was not fully reviewed. Exact hosted
backend/companions, old admitted requests, absent historical identity records,
vendor-trigger privileges/upgrades and cutover remain separately authorized gates.
No new source-inferred runtime PASS, generated types, Stage2/UI/captures, run budget,
hosted DDL, deployment, spending or provider action is granted.

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
accounts, fresh version-one core profiles/preferences, empty wardrobe tables
and empty new AI tables before setup. Used/unexpected state fails.
Existing `ALLOW_SECURITY_TESTS=1` is required; the seeder never invents an opt-in.

P1–S6 are ordered checkpoints, with finite named normal children in S4 per the
accepted PR #16 clarification. All owner actions/assertions use actual A/B
password HTTP sessions in `normalSessionEnvironment`; only setup, trusted-server
RPC calls, named timestamp seeding and SQL metadata inspection use privileged
local SQL. No values, UUIDs, tokens, SQL or HTTP bodies are printed.

S7 (25 September) inspects the `pg_cron` purge job created by
`20260925090000_ai_purge_schedule.sql`. The job is created **inactive** in
every environment, so it never fires during reset, fixtures or preservation
rehearsal and cannot purge the deliberately expired fixtures. S7 requires the
exact job row, `active=false` and zero run-history rows, and prints only the
cron timezone, run logging and each `cron` function signature/ACL.

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

### T28 bodyless ordinary-session requests

The three ordinary-session test transports must not add an automatic Content-Type
when `body === undefined`. Explicit headers still apply; `null` remains JSON
`null`, and binary/JSON bodies retain their existing serialization and headers.
The singular Storage deletion utility currently has no product caller: this is
a harness repair and a rule for the later product transport, not a deployed fix.

Pinned Storage/Fastify source selects the JSON parser for a bodyless DELETE with
application/json and refuses its empty input before the handler. That establishes
a request-construction defect, not the recovered cause of cycle5's coarse
begin-overlap/cleanup failure. Empty-JSON400 still fails closed; it is neither
`missing` nor `removed`. Real bodyless PostgREST and native deletion remain gates,
including the skipped integration/security suites. The separate WebKit boundary
400/200 flake is unresolved; its existing bounded observer adds evidence only.
No receiver, retry, cleanup or response assertion is relaxed.

### T26 CI-only Storage installation boundary

**Historical T26, superseded by HC1 on23September2026.**
The [reviewed T26 amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5659205055)
moved the Storage-owner `ENABLE ALWAYS` step out of the ninth migration.
HC1 deletes that installer rather than keeping an optional privileged profile.
Current readiness requires publication **O**, identity **A**, and the verifier's
own postgres session in **origin** mode. Vendor `protect_delete` retains its
existing O-or-A allowance; it is not an application-trigger fallback.

`db:start`, `db:reset` and the preservation parent now refuse before CLI mutation
unless the approved disposable database job has literal
`ALLOW_CI_DATABASE_MUTATION=1`, `CI=true`, `GITHUB_ACTIONS=true`,
`GITHUB_REPOSITORY=drrowdev/stillroom-wardrobe` and `GITHUB_JOB=database`.
The pure zero-argument `assertCiDatabaseMutationAllowed` also rejects service
secrets and extra arguments. The old installer flag alone cannot admit mutation.
Only Database CI sets the current flag. Do not spoof CI variables for local use;
normal children and stripped command environments inherit none of this scope.

The fixed read-only verifier checks project, local daemon, named running container and
the pinned `supabase/postgres:17.6.1.165` image's CLI-default ECR/GHCR/Hub names.
It never pulls or selects a fallback. These names come from CLI
`997a1e69a4a83466964ed874d3a604c88a7b3866`'s Dockerfile and registry resolver,
not proof of hosted image/HBA compatibility. Both history and catalog calls use
fixed container TCP127.0.0.1:5432, database/actor/session `postgres`, `psql -X`,
`--no-password`, `ON_ERROR_STOP=1`, stripped environment and SQL stdin.
Docker/loopback trust remains privileged; this is structural evidence, never
an ordinary-user access assertion. No role switch, grant, owner connection,
ownership transfer or trigger alteration remains in the verifier.

Catalog joins validate actual table/function ownership, exact trigger identity,
body/config/ACLs and metadata. Exact history prefixes9/10/11 choose only the
reviewed legacy/final body/type pairs. Unknown histories or missing/A/D/R/null
publication state fail closed. An existing A stack is not repaired or downgraded;
only a separately approved disposable recreation/reset can replace it.
No automatic reset or production-reset remedy is authorized.

Each SQL call has a30-second process bound, successful exit and empty stderr:
history output is capped at1024bytes and verification at4096bytes. Both use
read-only transactions with10s statement/2s lock/10s idle limits. Catalog JSON
and full function bodies stay inside the DO block; only the fixed verification
receipt emitted **after COMMIT** returns. The generic120s/16MiB privileged SQL
helper is unchanged and is not used by these two calls. This is not a30-second
bound for the entire Docker/preflight/two-call operation.

Start verifies before status/Auth health; reset verifies before account/AI
fixture provisioning; types verifies before authentic generation.
Preservation verifies each observed applicable9/10/11 transition before traffic,
including9->10. Base and schema6 fixture setup are not readiness assertions.
Failure is nonzero without retry, observed-body adoption or success fallback.

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

After the HC1 mutation preflight, `db:start` launches the actual local services, verifies the strict O/origin Storage contract and identity A, checks the known database container, and verifies a healthy Auth HTTP response. Initial Docker image downloads can take several minutes. CLI output is captured rather than printed because startup/status can include credentials.

The [T23 startup-diagnostic amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/25#issuecomment-5656047462)
defines thirteen closed fields; marker observations activate only on failed
stderr-bearing results. The known
announcement inventory now covers all nine exact migration filenames; its last
index is one-based and follows stderr order, not proof of the failing migration.
`stderrStatementIndex` observes whole LF/CRLF `At statement: N` lines, with a
zero-based ordinal0–9999; absent, malformed or conflicting candidates yield null.
It is not a source line/byte position and may denote injected restore/history or
reset statements. `stderrPermissionMarker` emits only a fixed generic category
from a head-shaped42501 line, with nonempty server-supplied severity and an exact
English message-start prefix. Unsupported messages remain unclassified; distinct
categories are multiple. No identifiers, severity, SQL, role, path or raw message
are emitted. Complete forged SQL-echo heads/markers can match: these are untrusted
shape observations, not authenticated causes or permission evidence.

Parsing retains the16MiB combined UTF-8 input cap and a less-than512-byte JSON
record; the4096-byte container-exit gate does not restrict these two fields.
CLI2.116.0/PG17 source framing is not proof of the failing runtime's identity.
The third I08 cycle failed startup with42501 before rehearsal; the diagnostic
amendment does not repair privileges or authorize a retry, execution or cutover.

`db:reset` is destructive **only to the disposable local stack**. It checks Docker locality and the database container's exact name, Supabase project label, Postgres image and running state. It invokes `db reset --local --no-seed`, never `--linked`, `--db-url` or `--project-ref`; extra arguments are rejected. A changed initial migration hash also aborts the reset.

After successful migration and strict Storage guard verification, a separate Node process runs `scripts/provision-test-users.mjs`:

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

`npm run db:types` requires the real running local container and read-only strict O/origin Storage publication verification plus identity A before invoking the pinned CLI `gen types typescript --local --schema public`. It never installs the guard. Only successful plausible generator output is atomically written to `src/data/database.types.ts`. `--check` compares the exact output, including line endings, and fails on a missing or differing file. Nothing is hand-generated from the SQL and failures never replace a previous file.

The actual generated file is now committed and used by `AppClient` and the
`src/data/rows.ts` projections. Runtime guards remain, but are not schema
generation evidence. `--check` invokes real generation and compares exact
bytes; it is not a visual inspection of a generated-looking file.

Cloud setup instead uses `npm run db:types -- --setup-artifact`: the same guards,
generator and TypeScript parsing, with staging and atomic rename beside the fixed
ignored `.supabase/generated-database.types.ts` destination. It never writes the
tracked file. `PARITY: MATCH` / `PARITY: DIFFERENT` compares tracked text exactly;
a difference is informational, but read/generation/write errors fail. The flag
cannot combine with `--check`, accept an output path/extra argument or apply to
start/reset; invalid arguments are refused before Docker. `--check` always reads
the tracked file.

Database CI remains `npm run db:types` followed by tracked-file and zero-diff
checks. If retrieving its generation, upload **only** `src/data/database.types.ts`,
never `.supabase`, `.env.local`, CLI status, credentials or session state. The
setup artifact is generation evidence, not tracked parity or an integration pass.
Child-process unit refusals do not prove generation, atomicity or runtime
non-mutation; the modified setup run must demonstrate its ignored artifact and
clean tracked/staged tree, alongside unchanged Database CI parity.

### CI-D1 bounded generation and browser evidence

[Corrected plan and independent critique](https://github.com/drrowdev/stillroom-wardrobe/pull/31#issuecomment-5793998514)
and [local source release](https://github.com/drrowdev/stillroom-wardrobe/pull/31#issuecomment-5794149757)
add evidence and enforce the existing no-flakiness gate, not a causal repair of
the [post-merge failure](https://github.com/drrowdev/stillroom-wardrobe/pull/31#issuecomment-5793600025).
The failed generation's run-container/exit-125 category neither identifies its
cause nor proves the container never started. Missing generated types/parity
remain missing; earlier successful output is not a replacement.

Only a valid nonzero result with nonempty stderr gains
`stderrDockerErrorMarker`. It is one of `unclassified`,
`image-resolution-or-registry`, `missing-network`, `container-name-conflict`,
`oci-runtime-start` or `multiple`. The new scan reads only already-captured
primitive stderr at **at most 4096 UTF-8 bytes**. Longer input is unclassified,
even when the unchanged old operation field still classifies it. Actual producer
regressions require serialized JSON below512 UTF-8 bytes. All old fields/order,
tag/descriptor handling, raw byte/LF counts and exit-bucket rules remain.

Only LF-terminated lines participate. Remove exactly one framing CR before LF,
reject any remaining CR and ignore an unterminated tail. Strip at most one exact
leading `docker: `, then require exact `Error response from daemon: `.
There is no trimming, case folding, ANSI removal, regex or arbitrary cleanup in
this new classifier. Case-sensitive remainder families are:

| Remainder | Marker |
|---|---|
| Starts with `pull access denied for `, `manifest for ` or `failed to resolve reference ` | `image-resolution-or-registry` |
| Starts with `network ` and ends with ` not found`, with a nonempty middle | `missing-network` |
| Starts with `Conflict. The container name ` | `container-name-conflict` |
| Starts with `failed to create task for container: `, `OCI runtime create failed: ` or `OCI runtime start failed: ` | `oci-runtime-start` |

Tails after recognized prefixes are not validated. These are literal families,
not complete/authenticated Docker messages. Each eligible daemon line contributes
its category or unclassified; duplicates collapse, different categories including
known plus unknown yield sticky multiple. Non-daemon lines are ignored; no eligible
line yields unclassified. Generic125, `Unable to find image locally` and network
already-exists wording alone do not identify a family. Canonical-looking text
can be echoed or injected, so no automated recovery follows. No raw line,
identifier, URL, message hash, exception or credential is returned.
The old `stderrDockerOperation` deliberately retains fixed-priority first-match
semantics, not the new marker's ambiguity rule or an operation count.
Generation argv/180-second deadline, Docker/image/network selection,16MiB capture,
stdout checks, TypeScript parsing, atomic writes and parity stay unchanged.

`failOnFlakyTests: Boolean(process.env.CI)` makes the main CI browser command
fail when a first failure passes on the existing retry. Unset/empty CI remains
false. Projects, workers, engines, retries, timeouts and capture bounds are
unchanged. Apple selections explicitly use retries0, so cannot produce a
retried-pass flaky outcome. A separate `test:a11y` invocation uses this config,
but CI does not currently invoke that command. Existing success-only visual
uploads skip after a flaky failure; absent visual review stays pending.

Since CI2 the browser run is split across two jobs with the same config:
"App and browser contracts" runs `--project=chromium --project=mobile` (timeout
30 minutes) and keeps all 12 visual uploads, because only those projects write
captures; "WebKit photo contracts" runs `--project=webkit-photo` (timeout 20
minutes) and uploads nothing. Each invocation applies `failOnFlakyTests`
independently. A WebKit failure no longer skips the App job's uploads, but it
still fails its own required gate. `tests/unit/ci-workflow.test.ts` fails if a
Playwright project is not selected by exactly one job or an upload moves. The
timeouts are estimates from the ~19.6-minute single job; measured durations
must stay within 60 % of each timeout.

Only the existing oversized analysis call adds its pre-fetch `constructedBytes`,
expecting exactly413/response/512001. The other eleven authorization/envelope
results retain two keys and their original statuses. The closed copier retains
at most four clients and status allowlist `[200,400,403,413,502,504]`, including
actual400 plus size0. It also preserves existing boundaries/response-sequence
capture and safe integer sizes0..512001; malformed evidence sets captureError.

Only the reserved first upload adds `reservation-first-upload` and its existing
pre-fetch source-array/Blob/form-file sizes, expecting200/oktrue/5/5/5.
The finally record closed-copies the four own data fields rather than sharing
the nested observation. Sizes are null or safe integers0..1048576; malformed
observations set captureError without replacing actual status/ok. Diagnostic
parsing stays off; scripted503, fresh senders, duplicate409, old labels/default
shapes and authorization/byte/hash/storage/cleanup assertions remain. This adds
no claim that the reservation record proves final listener closure.

Each touched spec has one pure no-page/network test of its actually used copier.
They run in the separately authorized native Playwright suite, not via a local
import/list workaround that starts the configured server. Numeric zero means
that measured value; null/missing/invalid capture is an **observation gap**, not
zero construction or proof of a source defect. Expected sizes with empty receive
only narrow the interval, not distinguish engine/interception/serialization/
transport/collection. Observations can perturb timing. Future nonrecurrence
is inconclusive about either historical cause, never a fix or acceptance waiver.

### GD1 type-generation Docker diagnostics

GD1 adds evidence for the intermittent `db:types` exit 125. It is not a causal
repair. In pinned CLI 2.116.0, stable releases run the TypeScript legacy
`gen types` handler. It writes `Connecting to db 5432`, runs
`docker run --rm … <pg-meta image> node dist/server/server.js`, forwards the
child's stdout/stderr and then reports `error running container: exit N`.
Exit 125 can therefore come from the `docker run` command itself, before or
without the pg-meta process. Nothing in the report proves which.

Only a valid `nonzero-with-stderr` report appends `dockerDiag: {h,i,s,f}` after
`stderrDockerErrorMarker`. All earlier keys, order and values are unchanged.
Above 4096 UTF-8 bytes of stderr there is no scan and the value is
`{h:null,i:null,s:"over",f:"over"}`. Otherwise line framing matches the marker
scan: only LF-terminated lines, one framing CR removed, any remaining CR rejected,
unterminated tail ignored, and only exact `===`/`startsWith`/`endsWith` literals.

- `h` is true when a line is exactly `Run 'docker run --help' for more information`.
- `i` is true when a line starts with `Unable to find image '`, ends with
  `' locally` and has a nonempty middle.
- `h:false` means no eligible exact help-trailer line was observed; it does not
  establish that pg-meta ran. `i:false` means no eligible image-missing line was
  observed; it does not prove absence of acquisition activity. The separately
  successful pull step, not either boolean, is the acquisition evidence.
- An eligible line strips one leading `docker: ` (`s` kind `docker`) and then, at
  most once, `Error response from daemon: ` (kind `daemon`). A line with
  neither prefix is ignored. `s` is `none`, `docker`, `daemon`, `multi` or `over`.
- `f` classifies each eligible remainder by the first matching rule below, or
  `unknown`. No eligible line gives `none`. Duplicates collapse; distinct values,
  including known plus `unknown`, give sticky `multi`. `s` aggregates the same way.

| Order | Remainder | `f` |
|---|---|---|
| 1 | Starts `failed to resolve reference "` and ends `429 Too Many Requests` | `rate` |
| 2 | Starts `toomanyrequests: ` | `rate` |
| 3 | Starts `unauthorized: ` or `denied: ` | `auth` |
| 4 | Starts `manifest unknown` | `nomanifest` |
| 5 | Starts `pull access denied for `, `manifest for ` or `failed to resolve reference ` | `img-ref` |
| 6 | Starts `network `, ends ` not found`, nonempty middle | `net-missing` |
| 7 | Starts `Conflict. The container name ` | `conflict` |
| 8 | Starts `failed to create task for container: `, `OCI runtime create failed: ` or `OCI runtime start failed: ` | `oci` |
| 9 | Starts `Get "https://` or `Head "https://`, ends `: no such host` | `net-dns` |
| 10 | Same starts, ends `: i/o timeout`, `(Client.Timeout exceeded while awaiting headers)` or `: context deadline exceeded` | `net-timeout` |
| 11 | Same starts, ends `: connect: connection refused` | `net-refused` |
| 12 | Same starts, ends `: TLS handshake timeout` | `net-tls` |
| 13 | Ends `: no space left on device` | `disk` |
| 14 | Exactly `context canceled` | `canceled` |
| 15 | Starts `Cannot connect to the Docker daemon at ` | `daemon-down` |

These are literal text shapes, not authenticated Docker messages or causes;
text can be echoed or injected. No raw line, image name, URL, connection string
or tail is returned. The measured widest producer report is 470 UTF-8 bytes,
below the 512-byte limit.

The Database CI job runs one visible step before `db:start`: it asserts that
`SUPABASE_ENV` is unset, that none of the eight project dotenv files the legacy
CLI loads (`.env.development.local`, `.env.local`, `.env.development` and `.env`,
in `supabase/` and the project root) exist, and that
`supabase/.temp/pgmeta-version` is absent. It then acquires
`public.ecr.aws/supabase/postgres-meta:v0.98.0`. That reference is
the pinned CLI's Dockerfile pg-meta tag with its default public.ecr.aws registry.
Ambient overrides are filtered; project dotenv overrides remain possible, but are
absent in this checkout/current CI. No writer for `pgmeta-version` was found in
the legacy TypeScript sources; that is a negative search result.

CI2 (24 September 2026) made acquisition bounded and verified after two
`toomanyrequests: Rate exceeded` ECR failures (runs 35999112583 and 36002588126,
attempt 1), under `shell: bash -eo pipefail {0}`:

1. One `docker pull` of the ECR tag. On success, the image's RepoDigests must
   contain `public.ecr.aws/supabase/postgres-meta@sha256:cef71ba901751dcc242cc685cf13786935ea8926820fb342f23bb0fbef77de5a`,
   so upstream tag drift fails visibly.
2. Only if that pull fails: a `::warning` annotation, one `docker pull` of
   `ghcr.io/supabase/postgres-meta@<same digest>`, a `docker tag` to the exact
   ECR tag, and a RepoDigests check for the GHCR digest reference.

That is at most two `docker pull` invocations; neither has its own elapsed-time
bound beyond the job timeout. A failed pull, tag, inspect or digest check fails
the job; there is no loop, sleep, suppression or third source, and `db:types`
itself is never retried. A GHCR recovery is an honest pass for image
availability only, never evidence about ECR or the exit-125 cause. On 24 September
2026, anonymous manifest requests with identical Accept headers returned the same
OCI image index digest from both registries (linux/amd64 `sha256:4f23a37b…`,
linux/arm64 `sha256:1fa69d28…` plus two attestation entries). The pull can
change the timing or path of a failure; a later green run proves nothing about
the cause or its elimination.
`tests/unit/local-backend.test.ts` pins the step text, its order, the digest and
the `supabase` 2.116.0 pin, and runs the step body under a docker stand-in for
the pass, recovery and failure branches. **Whenever the CLI pin changes,
re-derive the image reference by hand from that version's source and the digest
from both registries (they must be identical)**; the test cannot do it. Any
introduced override file or variable also requires stopping and re-deriving it.

Separately, pinned CLI 2.116.0 already protects `supabase start` images: it
first checks local candidates, then makes up to three pull attempts per
candidate with 4 s/8 s backoff across ECR, `ghcr.io/supabase` and the Docker Hub
source repository. A registry override disables that fallback, and inspection
or spawn failures can end it early. `db:types` uses the single ECR reference,
which is why only the pg-meta acquisition needed this step.

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

## B1 warm analysis rehearsal

After successful normal setup and the existing integration/security suites:

```sh
ALLOW_SECURITY_TESTS=1 node scripts/ai-analysis-rehearsal.mjs
```

This is an opt-in **disposable local** parent fixture process, not a hosted or
paid test. It first checks the exact warm AI18 baseline: two old ready envelopes,
14 ledger rows, no held/reserved rows, exact eight-key policies, A's 16001
accounted amount and B's three recent admissions. Sufficient TTL/rate headroom
and an empty B1 namespace are mandatory; it never reruns the fresh-only AI
provisioner against warm state. A ten-minute progress deadline bounds the
rehearsal; child/request/owned-process limits apply independently.

The actual pinned CLI is invoked as `functions serve` without a positional name,
with a closed function inventory and unchanged `verify_jwt=true`. Its owned
process must pass originless OPTIONS at the real function URL with
`Access-Control-Request-Method: POST`, status 204, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and `Access-Control-Allow-Methods: POST`.
Readiness never consults ACAO: Kong may append `*`. Generic browser preflight can
be intercepted with status 200 and does not prove handler boot. Diagnostics
expose only bounded exit/boot/module/limit/probe indicators, not child output.
This verifies local routing, not browser/deployed production CORS.

Under [repair approval 5633782787](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5633782787),
readiness also requires replacement of the previously observed exact
`supabase_edge_runtime_stillroom-wardrobe` container. The existing local/project/
Docker guards precede fixed-argument, shell-free `docker ps -a --no-trunc` for
that anchored name and a single validated full-ID `docker inspect` selecting
only ID, Running and StartedAt. Each read uses at most 5000 ms of the **same
60-second deadline**, established before the pre-spawn read, and a combined
4096-byte capture cap. Empty successful ps means absent; failed, ambiguous or
malformed metadata and capture overflow fail closed. Other command callers
retain the 16 MiB default and, on overflow, only their previously collected
bounded prefix with nonzero exit. Explicit numeric caps, including an explicit
16 MiB, discard both streams on overflow. Timeout is always nonzero, even if
the terminated child exits zero.

Under [startup-state correction 5634444254](https://github.com/drrowdev/stillroom-wardrobe/pull/19#issuecomment-5634444254),
the three-field runtime contract allows `startedAt: null` only while not running.
Only ps `created` plus same-ID inspect Running=false and exact Docker timestamp
`0001-01-01T00:00:00Z` maps to null. Exited/running zero, epoch zero and malformed
values fail closed. The two reads are separate observations: ps-created followed
by same-ID inspect-running with a valid positive timestamp is legitimate (C1).

The first distinct replacement ID is pinned even before starting; disappearance
or replacement never repins it. Its first valid StartedAt must be strictly newer
than the previous valid start (nanosecond precision); if initially absent or
never started, it must be at/after spawn. A preexisting never-started ID must
still be replaced. Null may transition once to a valid fresh start; that start
then freezes, so reversion or timestamp change fails closed.

Before the first strict signature, the same candidate may wait for start or
serving, including transient transport/nonmatching responses. Every attempt
rereads metadata, pauses 250 ms between attempts, checks owned-child health, and
caps its probe at min(remaining, 2000 ms) within the original deadline.
Confirmation is metadata → strict OPTIONS → identical metadata → strict OPTIONS
→ identical metadata → healthy owned child → ready. Once the first strict
signature succeeds, any confirmation failure is terminal, not a retry-to-green.
No POST is retried. Deadline reasons distinguish `replacement-not-started`,
`replacement-not-serving`, `absent-no-replacement` and `identity-unchanged`.
Boot/module failure stops the owned process immediately.
The owned 600-second lifetime, 1 MiB output ceiling and owned-only termination
remain. This proves stable replacement under the serialized single-writer
guarantee, **not child-PID attribution**. `B1-READINESS` exposes bounded predicates,
elapsed time, closed reason and last HTTP indicators separately from transport
failure, never container IDs/timestamps or child output. A later received HTTP
response clears the latest-attempt transport-failure flag; a transport failure
does not erase the last received HTTP indicators.

After that gate, the server is not returned until every other served function
(`finalize-analyzed-item`, `finalize-image-change`, `delete-account`) answers one
side-effect-free OPTIONS preflight with its own handler signature (204,
`no-store`, `nosniff`, `Allow-Methods: POST`). Only gateway 404/502/503 answers
and the transport errors `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_SOCKET` or the
probe's own timeout mean the worker is still booting; they are retried every
250 ms within the same 60-second startup deadline. Any other exception fails at
once as `warm-<function>-transport-other`. Redirects are not followed, so a 3xx
fails as `status-3xx`, like any other status (for example `status-5xx` for a
router 500 on an invalid worker response), without reading the body. A 204
without the signature, a dead owned process or the deadline also fails startup
closed as `warm-<function>-<reason>`. One `B1-WARM` line records the function count, the
number of attempts, the elapsed time, the reason and the last status. Before
this step, the first real request to a function that had not booted yet raced
its worker startup.

`supabase functions serve` reloads Kong after it starts the runtime, and the
reload's old nginx workers close their idle keep-alive connections. So the
server is also not returned until the gateway has settled. Kong's worker
process IDs are read with `docker top` before serve starts; startup waits up
to 15 seconds for every worker to be new and none to be shutting down. That
wait has its own budget, checked before each read, and always leaves 7 seconds
of the startup deadline for the health answers. It then
needs three consecutive 200 answers from `/auth/v1/health`, 250 ms apart,
within the same deadline. Closed, reset or refused connections, the probe's own
timeout and gateway 502/503 answers restart the count; any other answer fails
at once as `gateway-status-<class>`. If the workers cannot be read or no reload
is seen, the healthy answers alone are a timing heuristic. One `B1-GATEWAY`
line records whether the reload was `observed`, `not-seen` or `unobserved`,
the attempts, the socket errors, the elapsed time, the reason and the last
status. The readiness, warm-up and settle probes each use a fresh connection
that is closed afterwards, so they leave no pooled socket for the next request.
The normal-session password sign-in shared by COL1, I10b and B2 retries, at
most three times in total, only when the connection closed or reset
(`UND_ERR_SOCKET`, `ECONNRESET`) before any response; any answer is final.

Rehearsal failures keep their existing `FAIL:` prefixes and add
`; step=<step>; cause=<cause>` from fixed lists (`PROBE_STEPS`, `PROBE_CAUSES`
in `scripts/backend/local.mjs`). Any other value prints as `other`. Causes are
HTTP status classes, transport classes, `assert`, `unexpected-body` or startup
reasons, never IDs, paths, bodies or messages. A B2 child prints one
`PROBE-REASON <step> <cause>` line, and the parent adopts it only after the same
validation.

Separate ordinary-session children receive the existing strict environment
allowlist and only an ephemeral loopback origin/stage argument. The parent alone
holds local service/fixture authority and an ephemeral synthetic signing key.
Real Auth, claims, status and settlement remain unmocked; only Google transport
is synthetic. The parent briefly switches just the two fictional controls to
the reviewed manifest, 2270823 maximum, 100000000 allowance, rate 200, notice 1
and TTL 3600. Closed A/B request namespaces are bounded to 32 admissions per
owner. Rejected validation allocates none.

The CLI-served check pairs both ordinary owners' exact 503/UNCONFIGURED results
with a separate bearer-character-valid, invalid-JWT request requiring exactly
401. Ordinary `analysisRequest` retains its no-store/nosniff and 32768-byte JSON
guards; the invalid-token request separately bounds/cancels the response without
demanding handler headers or JSON. A 401 alone does not establish gateway
attribution, and 503 alone does not prove an Auth round trip: the separate real
Auth/DB rehearsal remains mandatory. The full pre/post no-reservation snapshot
is unchanged.

`B1-SERVED` records contain only fixed case, A/B owner, status, header/JSON
booleans, a shared closed handler-code allowlist (or `unrecognized`) and finite
transport category. Producer and parent enforce eight records/2048 serialized
bytes; malformed, extra-key, unknown-code or overflowing evidence is rejected,
not forwarded/truncated. Arbitrary child stdout/stderr is never forwarded.
Evidence cannot control assertions, readiness, retry, admission or success;
missing required observations still block completion evidence. Any actual
served/rehearsal failure preserves state and is a **STOP**, not permission to
reset, rerun to green or speculate on Auth/SQL/policy changes.

Coverage includes normal/anonymous refusals, actual grants/RLS/constraints,
cross-owner FK rejection, immutable registry, legacy/trusted separation,
once-only dispatch/replay/concurrency, lost acknowledgement, structural JPEG/
server hash checks, shared fact vectors, terminal/consent/configuration guards,
held/estimated/confirmed usage and cross-month reconciliation. Full-row negative
oracles and normal-session inventory/export/media hashes guard preservation.
On success only exact harness ledger IDs are deleted (dependent evidence cascades),
captured controls are restored exactly and the old baseline is reverified.
Consent changes use ordinary CAS and retain two version increments per run.
No profile version is rewound. Unknown failure preserves state and exits nonzero;
there is no automatic cleanup/reset masking the primary failure.

Database CI runs this after existing integration/security and before actual type
generation. No dependency, setup workflow, six old migrations, image preparation
or Save behavior is changed. Required external/visual/native/paid gates remain
separate from this local evidence.

For the six-path native correction above, approval P4 allows only targeted/full
units, typecheck, lint, diff and changed-file secret checks after valid entry.
No post-setup native reset, preservation, B1 rehearsal, backend probe, type
generation, browser, build or capture is authorized. The unchanged serialized
live CI sequence and final-head owner/security/types/App/Apple/artifact/actual
coordinator visual gates remain mandatory after independent repair review and
separate coordinator execution authorization; this is not a live-proof waiver.
