# Security and privacy

The accounts have no relationship or connection. All app records/images remain owner-only. Revision 1.3 permits a disclosed processor to analyze a sanitized photo **before library Save** after owner setup consent. The result fills an editable draft; analysis cannot save inventory. No household, peer discovery, sharing, borrowing or cross-account API.

## Threat model and limits

| Threat | Concrete control | Verification |
|---|---|---|
| Anonymous visitor or third identity | Public/anonymous/OAuth signup disabled; two independent administrative approvals; Auth admission trigger; current approval checked by RLS | Signup denial, third-email fixture and anonymous REST/RPC tests |
| Authenticated user guesses another UUID | Owner-only policies and composite owner FKs on every private relationship | Both directions of A/B reads, updates, deletes, joins, RPCs and guessed IDs |
| Foreign private image access | Private bucket; reserved owner paths; authenticated owner-only download/list/sign/upload/delete | Direct Storage operations against the other owner are denied |
| Accidental profile connection | No pair/household/sharing entity, cross-account reference or user enumeration endpoint | SQL catalog assertions and route/domain-type checks |
| Browser XSS/dependency compromise | Plain-text notes, strict CSP, no analytics/fonts/third-party scripts, exact lockfile and dependency review | XSS fixtures, bundle scan, notices and audit |
| Reused or lost device | Session storage by default, optional trusted-device Auth persistence, no persisted wardrobe; cross-tab logout and UID-bound caches | Switch/logout/Back/offline tests |
| Privileged deletion abuse | Auth token verification plus password reauthentication; target UID derived server-side; no caller-supplied owner parameter | Missing/forged token, wrong password and foreign target injection tests |
| Malformed/oversized images | Header/type/size validation, new JPEG pixel encoding, metadata checks, private MIME-limited bucket | EXIF/GPS, orientation, decoder and oversized fixtures |
| Backup theft or mixed-account restore | Individually encrypted exports, owner-scoped snapshot and owner-bound import IDs; no credential export | Tampering, wrong password, missing part and ownership tests |
| Valid old token after administrative freeze | `private.is_approved()` queries the live approval row | Disabled account has no new database/storage access |
| Unapproved analysis or runaway calls | Owner consent, server credentials, deduplicated requests and atomic cost reservations | No unapproved calls; discarded drafts can still have a legitimate charge |
| AI overwrites edits or saves an unwanted item | Bounded schema, no tools, draft-generation/field guards and explicit reviewed Save | Analysis/discard makes no library writes; late responses cannot alter saved values |

One backend hosts the independent accounts. Project administration and infrastructure quotas are common operational concerns; they are not a relationship between user profiles. The operator can technically read both through administrative tools, and this is not end-to-end encryption. No operator privilege is granted by either user's normal application login. Neither user's app sees the other account, its quota use or its activity.

Already delivered bytes on a device cannot be remotely erased. The app holds private data only in session memory and clears it on logout/account change. New authenticated access is denied after freeze; deliberately owner-issued diagnostic signed links have their own expiry, as described in `08`.

## Authentication and initial provisioning

Use Supabase email/password Auth with two pre-reserved email slots. Disable public signups, anonymous sign-ins, OAuth providers and phone signup. Also keep the SQL admission trigger: UI-only allowlists are insufficient. No self-service invitation or email-change page. Updating an account email requires an operator to update its reserved email and Auth identity together after verifying the person.

The operator inserts two real lower-case emails into independent approval rows through a parameterized administrative script/SQL, then creates two confirmed Auth identities with separate high-entropy initial passwords. The trigger creates each private profile/preferences row. Deliver each credential only to its intended person through an existing password manager or in person; each changes their own password on first use. No email service is required for this $0 route, and no messages are sent during blueprint creation. Optional email recovery can be added only after SMTP delivery is verified; default built-in email delivery is not assumed suitable for arbitrary recipients.

Local tests use `user-a@example.test` and `user-b@example.test` and locally generated passwords. The administrator/service key is allowed **only in the isolated setup script**. The security test process must have no service-role credential and must sign in as the two users. Do not claim a test run as a normal-session test if its requests use the administrator key.

Store session tokens in the SDK's custom sessionStorage adapter by default. A separate “Keep me signed in on this device” checkbox may opt into localStorage for Auth tokens only. Do not persist wardrobe objects there. On logout, clear both stores, in-memory data, object URLs and pending requests; broadcast logout to other tabs. On UID change, clear state before rendering the new profile. An expired session never falls through to another user's cached data.

## Database and Storage enforcement

All twelve base tables in `07` enable RLS. I29 adds equivalent protections for private AI requests/results/usage, with no direct normal-user table grants. Owner-only result/status APIs cannot expose peer data. Analysis returns draft fields, not inventory writes. Explicit Save validates owner/provenance; description editing is restricted to `alt_text` without changing media paths/bytes.

Image state, profile admission/deletion and imported history fields have narrower privileges and checked functions. Security-definer routines have an empty search path, explicit owner/membership checks and an execute allowlist. The service-only deletion controller has no user EXECUTE grant. The `private` schema is not exposed through PostgREST.

**CONFIRMED:** Supabase documents RLS on Storage objects, separate upload/overwrite permissions and complete RLS bypass by service keys. [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) · accessed 2026-09-05. The bucket is private; policies require approved ownership and a reserved path. Storage UPDATE has no policy. The migration refuses an existing project with additive Storage policies that could defeat these controls.

There is no shared-media function. Owner images use authenticated downloads. No public bucket, user-facing signed URL creation, cross-owner SELECT branch or global statistics view exists. Search and recommendations receive only owner records. A future SQL view must use invoker semantics or an explicitly reviewed owner predicate with negative tests.

## Data minimisation and logs

Language is an independent profile setting (`en`, `fi`, `sv`) under the same owner RLS. A's selection cannot read or change B's preference. Clear owner-language state on logout/UID change; no device-global profile preference, remote translation service, or automatic translation of private clothes/notes. Static dictionaries may be shell-cached because they contain no account data. See `19-LOCALIZATION.md`.

Keep a display name/optional city, not body/medical information, precise GPS or retailer credentials. Re-encode images without EXIF/GPS/XMP or original filenames. Owner setup consent covers automatic analysis of prepared draft photos before Save; explain that discarding is not cancellation of already-delivered provider data or billing. No AI call occurs without this consent. Pixels may still contain personal information.

The user-authenticated analysis endpoint sends one bounded sanitized JPEG and fixed instructions/taxonomy only; no notes/location/email/history/peer data. Validate the image again on the server and output as untrusted data; no arbitrary URLs or model tools. Provider keys stay server-only. No item/image target is accepted, and the endpoint cannot save wardrobe data. Browser draft guards protect edits/clears. Result retention is bounded to 24 hours with discard/expiry cleanup; only coarse charge receipts outlive it.

Weather is optional and sends rounded city coordinates/IP to its provider, never wardrobe data, a user UUID or an Auth token. Disabling weather clears its cache; saved city can also be cleared. No telemetry SDK or third-party font is included.

Application logs allow only random request ID, route name, coarse outcome code, byte count and latency. Never log emails, names, item/outfit IDs, notes, prices, city queries, photos, paths, JWTs, passwords, signed URLs or raw HTTP/SQL bodies. Provider infrastructure may retain IP/path logs outside app control; do not claim zero provider logs. Keep optional telemetry off and use available provider retention controls.

| Browser-safe configuration | Server/operator-only secrets |
|---|---|
| Supabase project URL; publishable/legacy anon key; app version; fixed weather endpoint; UI feature flags | Service-role/secret key; JWT signing secrets/private keys; database URL/password; Supabase management token; deployment token; backup passphrase; AI provider credentials; optional Azure credentials |

A publishable key is safe only with correctly enforced RLS. Allowlist `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION`; all VITE-prefixed values are bundled. Ignore real environment files in git. Disable public production source maps. Scan tracked files and `dist/` for secret patterns and a injected secret canary. Never upload session files or backups as CI artifacts.

## Deletion and recovery

### I10b deletion guarantee and authority - 22 September 2026

The approved guarantee is native Storage logical removal plus exhaustive
authoritative application/catalogue reconciliation under a durable publication
fence. It is **not** physical erasure, provider-backup removal or a cleanup
deadline for inaccessible interrupted-upload remnants. Retained wear history
keeps its existing title/category snapshots with null item links. I10a-D routine
maintenance is deferred, not passed; I22 still needs owner-prefix capability
for Phase 6 account deletion and is not implemented by this packet. P6c
(Phase 6, source only) adds it as a frozen-owner Storage exception; its hosted
activation is owner-gated (see `docs/phase-6-result.md`).

Stage A adds READ COMMITTED admission using the existing approved-account row:
ordinary mutations take SHARE NOWAIT; short deletion fence transitions take
conflicting NO KEY UPDATE NOWAIT before profile/child/parent locks. Fresh
native INSERT/UPDATE/DELETE guards for every role in the supported origin-mode
runtime retain locks through transaction
completion. A permission probe alone is not publication proof. Completed
deletion markers survive item/profile clearing until Auth identity deletion.

The private mutation context is transaction/owner/item/target/purpose/version/
old-hash/new-hash bound and consumed once. Token creation and mutation must
share the same closed rollback scope: DELETE is not rollback-resistant.
Replacement, pending-forget and BEGIN/FINISH purposes are not interchangeable.
No client context table or service shortcut is exposed. Unsupported inventory,
tuple drift, uncertain native removal and failed reconciliation remain blocked,
not success. A canceled preparation cannot cancel an already authorized deletion.

### I08 ordinary-item deletion boundary - unexecuted source candidate

The ninth lifecycle migration uses an owner-only private live-item claim,
not a public item flag or another copy of garment fields/photos. Its request UUID,
original expected version and server start time persist only while that live
item has unfinished deletion. The claim is not a completed receipt, export
member or log entry. It has no client table grants/policies, automatic purge or
independent profile cascade.

After explicit BEGIN, item/image mutation and Restore are refused; partial byte
removal retains the frozen metadata and can resume using the same nonce and
original/current versions. Private SECURITY DEFINER guards use fresh visibility
of claims and Storage even for ordinary raw DELETE, so RLS-hidden orphan objects
cannot masquerade as an empty prefix. An immediate AFTER/origin-mode
publication guard holds profile/approval/image/parent SHARE locks through commit,
not merely through the earlier permission probe. It checks the exact pending
image/path/owner and live parent, cancellation and claim state; identity/version/
versioning replacement is refused. The final parent UPDATE lock therefore
protects the ordinary final-publication boundary.
Completion requires an empty entire literal item prefix before the metadata
cascade. Generic absent is deliberately not a byte-deletion receipt.

Permanent item deletion removes the garment record and its registered photos;
**wear history retains the recorded garment name and category** with a null
item link. Current outfit links and impossible feedback follow their existing
cascades. The later named confirmation must say this naturally in English,
Finnish and Swedish and distinguish this operation from whole-account deletion.
No promise is made to erase historical text, external exports or provider backups.

Unclaimed legacy operations remain supported. An initial unmanifested-prefix
case blocks permanent BEGIN without changing rows/versions; reversible
Trash/Restore remains possible within its window. I10 orphan cleanup is not
implemented. No scheduler, provider call or global raw-DELETE redesign is hidden
in I08. T29's replacement SELECT policy supplies only the existing approved-owner
canonical-prefix predicate during native singular deletion, alongside unchanged
manifested reads. The trusted native operation is not taken from client headers;
orphan download/sign/list, own bulk deletion and foreign/anonymous singular
deletion remain excluded. This is not protection against privileged/direct SQL
holders setting GUCs. The pinned operation-function dependency now covers both
read and delete and must be re-reviewed on vendor upgrades. The derived catalog
qual is not yet a measured runtime pin. New normal-session real-byte assertions
retain strict `removed` acknowledgements followed by absence, never equate
prior RLS-hidden GET with deletion, and reject5xx or malformed success evidence.
They are source definitions, not a completed runtime/privacy acceptance claim.
The normal deletion controller's bytes-first account sequence remains;
a privileged profile deletion which bypasses it may now be refused while a
claimed item's objects remain. Structural cascade checks are not account-journey
acceptance.

Future CI includes positive private-schema/grant/trigger/policy catalog checks,
ordinary A/B/anonymous assertions and exact retained-photo/history/peer checks.
Separately labelled CI-only setup may hold one exact disposable item-row lock or
insert one exact canonical catalog marker for a valid pending fixture image.
The marker has no blob. It is created only for a legitimate pending image before
BEGIN, passes the publication guard, and becomes an orphan through ordinary
unclaimed legacy deletion. Recreated-item BEGIN must refuse it without an
irreversible claim; Restore remains possible. Cleanup requires a real singular
owner API acknowledgement and labelled catalog1-to-0 verification, never a
0055 protection-flag override. The setup never serves as the access-assertion
identity, and exact cleanup failure fails the gate.

The approved image-ID registry retains only owner/image UUID pairs, inaccessible
to clients and absent from exports/logs, until actual Auth-row deletion. It
survives profile/wardrobe clearing and identity disabling. These pseudonymous IDs
are not anonymous data. Existing checked-Save replay and transactional rollback
remain valid; same-owner legacy image-ID reuse no longer is. Missing pre-cutover
deleted IDs are not recovered by backfill and remain an explicit rollout hold.

Published objects require individually verified singular deletion. The user
accepted inaccessible interrupted-upload remnants at Supabase **without a
verified cleanup deadline**, not physical purge, queued-cleanup proof or an
indefinite visible deletion hold. Preventing later publication/readability is
mandatory. Historical TUS JSON/other companion metadata has potential
authorization exposure requiring exact cutover verification; this is not a
verified cross-owner or anonymous exploit. Such accessible metadata is not
covered by the remnant acceptance and must not be relabeled as backups.

The source-only vendor-table trigger exception is approved; actual catalog,
backend identity, upgrade behavior and hosted privilege/cutover evidence remain
separate gates. No hosted DDL or privileged bypass is authorized.

**23 September2026 HC1:** the
[owner amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/30#issuecomment-5791405199)
and [reviewed A1-A6 plan](https://github.com/drrowdev/stillroom-wardrobe/pull/30#issuecomment-5791784903)
replace the historical T26 Storage-owner installer with one strict O/origin
verifier. All eleven migration bytes, publication/deletion function bodies,
locks, RLS and pending-object download/hash retry remain unchanged. Image identity
protection on app-owned `item_images` remains A/ALWAYS; vendor `protect_delete`
retains its O-or-A allowance. Application publication A is rejected, not accepted
as an optional profile or automatically downgraded.

O and A are not equivalent. Privileged replica-mode bulk operations are unsupported
while live and are not protected by this publication guard. Checking the
verifier's own postgres session does not establish every Storage connection's
runtime mode. Actual hosted version/privilege/runtime, quiescence/admitted-request
drain, coherent recovery, Auth/API/Edge EU and Cloudflare gates remain pending.
Docker/loopback structural checks remain privileged evidence, not ordinary-owner
access assertions. The original native late-upload/FINISH race must still reject
late publication and prove zero actual catalog-prefix objects, not merely hidden
reads. No read predicate is tightened to conceal a failure or break interrupted
Save. No reset, deployment, provider activation or private-input permission follows.

The reviewed PR #17/A1 checked-manual-Save source candidate retains a minimal
private retry guard after item/image cleanup: exactly three UUIDs
`owner_id,item_id,image_id`, unique per owner, with no timestamps, status,
ordering, counts, fields, captions, hashes, fingerprints, model or result content.
These are **pseudonymous identifiers**, not anonymous/unlinkable data or an
activity log. They are inaccessible through client table/API grants and excluded
from logs/exports. The separate live attempt's fingerprint and server times
cascade on item deletion; the bare used identities do not resurrect that content.

One guard row accumulates for every successful checked reservation, including
abandoned reservations, until the owner profile is actually deleted. Its
ON DELETE CASCADE is a structural retention boundary only. There is no scheduler,
bounded-total-growth guarantee or completed self-service account-deletion
journey: that UI/endpoint remains pending. Existing normal fixtures must not be
destroyed to simulate that acceptance. This source change implies no paid
processing, hosted migration or live deployment.

Normal item/outfit/history deletion is seven-day trash with an eight-second Undo shortcut. Confirm permanent deletion with the owned object's readable name and image count. Remove image bytes before final metadata deletion. Interrupted byte removal is retryable and visible; absence of a SQL row is not proof of physical file deletion.

Account deletion requires a fresh password check in the Edge Function, a deliberate confirmation and an Export first option. Never store/log the password. Sequence: private deletion receipt → disable only that approval → remove owner-prefix files → delete that profile and cascading private records → remove Auth identity → complete receipt. The server-only SQL controller guards the stages. Resume failures with the same owner/job; an operator can finish a job after the Auth identity disappears. The other account's profile, images, outfits, preferences and history must remain byte-for-byte unchanged.

The minimal completed receipt is purged after seven days. The owner must also remove their external backup copies and backup job tokens from their devices if they want those gone. The live app cannot erase exported copies or promise instant physical removal from a provider's internal disaster-recovery media. Those limits must be stated in the account-deletion screen without implying another user has access.

Backups are separate per account and encrypted outside the live bucket. Never provide a combined user-visible export. An operator disaster-recovery dump is separately encrypted and restricted because an operator is privileged; it is not a feature accessible to a user account. Portable wardrobe backups never include Auth rows, password hashes, refresh tokens, admission emails or service credentials.

Freeze/withdrawal/deletion stops new analysis and result retrieval; deletion removes the owner's request/results/usage. Logout/discard also clears client drafts and ignores late results. Provider retention/charges cannot be recalled by canceling a draft. Exports contain only saved attributes/provenance, excluding unsaved drafts, request results, active consent and usage. Restore never invokes analysis.

## Negative test gate

Execute the access matrix in `12` with normal A/B logins and an anonymous client: tables, RPCs, Storage download/list/sign/upload/delete, foreign keys, exports, account freeze, cache reset and recommendation inputs. Assert that no table, routine, route or domain type creates a connection between users. Inspect the browser bundle for service-key canaries.

Administrator privilege is used only in separately labelled provisioning/configuration fixtures, never in access assertions. The delivered PostgreSQL checks execute under the authenticated role with simulated identity claims. The real-session harness signs in using passwords and rejects service-key input; it has not run here because no Supabase project/test logins were supplied. Its Auth/Storage results remain release gates.
