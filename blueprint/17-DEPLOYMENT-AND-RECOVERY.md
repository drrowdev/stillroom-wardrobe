# Deployment and recovery runbook

This is an executable implementation runbook, not a record of deployed resources. No cloud project, account, invitation or production app was created during blueprint preparation. All application accounts are independent; operator access is a separate infrastructure privilege.

## 1. Local setup

Use Node 24, npm, git, Docker and a PostgreSQL `psql` client. On Windows, a working Docker Desktop/WSL2 setup is a practical local route. Do not put credentials in the repository or command history. Extract the package so the paths in `13` exist, then let Phase 0 create the application files and npm scripts.

```bash
npm ci
npm run db:start
npm run db:reset
npm run db:types
npm run test:security
npm run dev
```

`db:start` starts the pinned local Supabase CLI stack. `db:reset` targets **only the disposable local URL**, applies `07` and runs the separate provisioning fixture. If Docker is unavailable, ordinary unit/build work can continue, but a PGlite run is not a substitute for the local Supabase Auth/Storage exit gate.

Revision 1.1 adds owner-specific English/Finnish/Swedish support. Fresh projects use updated `07`. If the earlier initial migration was already applied, leave it unchanged and apply `reference-scripts/20260905000001_languages.sql` once as a new migration, then regenerate types. It only adds the nullable owner preference; do not reset a project or update all profiles to one language. Deploy static catalogs with the app and run `check:translations`; no additional translation provider or secret is needed.

Local Auth configuration must disable public registration:

```toml
[auth]
enable_signup = false
enable_anonymous_sign_ins = false

[auth.email]
enable_signup = false
```

Keep phone/OAuth providers disabled. Administrator creation of explicitly approved accounts still works. Pin the CLI and verify its parsed configuration; a setting in an unused file is not proof that the running service uses it.

## 2. Supabase project setup

Create one **Free** project in **North EU (Stockholm), `eu-north-1`**, with a password saved in the operator's password manager. Select that specific region, not the general Europe grouping. If unavailable in the account, stop and report it rather than silently choosing another region. Use a new empty project; no user gets operator privileges through their app login.

[Supabase's region list](https://supabase.com/docs/guides/platform/regions), accessed 2026-09-06, confirms Stockholm. This revision changes the planned region only, not any existing project. The project region determines primary data location; do not promise an observed latency improvement.

Edge Function regional invocation is separate. The reviewed [function-region documentation](https://supabase.com/docs/guides/functions/regional-invocation) does not list Stockholm as an explicit invocation region. Confirm current support during deployment; do not blindly set a function header to `eu-north-1` or claim all functions run in Stockholm. Select/disclose a supported EU execution region if residency requires it. External AI processing follows its own provider contract in `21`.

Apply the reviewed migration using the Supabase CLI/SQL editor as the migration administrator. Keep its original order/transaction. Generate client types from that schema. Confirm:

* all twelve base application tables have RLS enabled, plus every added I29 table before AI deployment;
* `private` is not a PostgREST exposed schema;
* the `wardrobe` bucket is private with the supplied JPEG/size policies;
* Storage has no UPDATE policy and no additive public/foreign-owner SELECT policy;
* only approved public RPCs have authenticated EXECUTE; deletion controller is server-only;
* no relationship/sharing/recipient/peer entity or endpoint exists.

In Auth settings disable public signups, anonymous sign-ins, phone and OAuth signup. Set the exact production origin as the Site URL and add only required local/known callback URLs. Do not add an unrestricted wildcard redirect to arbitrary preview sites. Use a normal anonymous signup attempt and verify rejection after configuring the dashboard; the SQL approval trigger is the second boundary.

## 3. Create the two independent accounts

The operator reserves the two emails independently. There is no invitation or relationship from one user to the other. Use a parameterized administrative SQL script such as:

```sql
-- scripts/reserve-accounts.sql; variables supplied by psql, never committed values.
insert into private.approved_accounts(admission_no,email)
values (1,lower(btrim(:'email_a'))), (2,lower(btrim(:'email_b')));
```

Supply `email_a` and `email_b` through the operator's local setup process, with a proper PostgreSQL service/passfile rather than a password literal in a command. The admission number is an invisible capacity limit only. Account rows do not reference each other.

`scripts/provision-test-users.mjs` uses the **server-only** Supabase SDK admin API for each approved email, with a different securely generated ≥24-character initial password and `email_confirm:true`. The Auth trigger attaches that UUID to its approval and creates the default private profile/preferences. Do not use open signup, put passwords in seed SQL, or return the other account's details to a browser. Local fixture emails are `user-a@example.test` / `user-b@example.test`; production values are never seeded into git.

For production, create confirmed identities only after the operator verifies the intended person's email/control through their existing secure setup process. Give each person only their own initial credential through a password manager or in person, and have them change it on first login. This design does not depend on a paid SMTP service or assume Supabase's default email delivery can serve arbitrary recipients. Do not send an invitation from one app account to another.

Reset/recovery default: the operator verifies the account owner, uses Auth Admin to create a recovery link or reset a temporary credential, and delivers it securely. Recovery links are secrets, never logs, screenshots or public issue comments. Test this handover before relying on it. If automatic recovery email is later desired, verify a configured SMTP route and its limits before exposing that promise in the UI.

After setup, remove the service key from the test process and run normal A/B password sessions. If either can see the other's profile, an item/image or derived/exported data, stop deployment and fix the rule/configuration. Do not delete fixtures by using an unrestricted service-role cleanup routine in the access test itself.

## 4. Hosting, HTTPS and deployment

Cloudflare Pages Free hosts static `dist/`. Connect the private git repository or use an operator deploy token with only the necessary project permission. Build command `npm ci && npm run build`, output `dist`, Node 24. Root CI must be green before a main deployment. The free provider hostname is enough; a custom domain is optional and may cost money. HTTPS is required for installation/camera-related browser capabilities and all credentials.

Only the three public build variables in `13` enter the static build. No wardrobe images, exports or source maps are deployed. Hash routes avoid server route rewrites. Configure headers, substituting the exact Supabase host:

```text
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://PROJECT.supabase.co https://api.open-meteo.com https://geocoding-api.open-meteo.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: geolocation=(), microphone=()
```

Use external compiled CSS rather than inline style injection that violates this CSP. The crop implementation should set styles through CSS classes/custom stylesheet rules or a reviewed nonce-compatible policy; do not casually add `unsafe-inline` to scripts. File-input camera capture must be verified with the actual Permissions Policy and Safari/Chrome. No GPS permission is requested.

Serve HTML and service-worker scripts with no-cache; hashed build assets can be immutable. The service worker explicitly caches only static allowlisted files and does not persist private API responses. Supabase requests use authenticated no-store fetches. Deletion function CORS permits only the configured origin; CORS is never treated as authentication.

Deploy the deletion function only in Phase 6. Select explicit Auth `getUser(token)` verification plus password reauthentication inside the function. If gateway JWT verification is disabled to support the selected signing-key configuration, **all unauthenticated/invalid-token requests must still return 401 before any privileged action**. Record and test that configuration; do not rely on decoding JWT payloads. The function reads a service credential only server-side and calls `deletion_control` with the verified UID.

### Phase 2 AI setup - separate from static hosting

Follow `20` and the dated comparison in `21`. Confirm private-use eligibility, model/region access, retention and a finite allowance before activation. Google Cloud and Gemini Developer API/AI Studio have different terms. Stockholm Supabase storage is not a promise about AI inference location. Do not activate billing from a coding prompt.

Apply I29, regenerate types and deploy user-authenticated `analyze-clothing`. Keep provider credentials and private receipt access server-only; there is no inference scheduler. Verify signed-in membership/consent/budget and image validation, zero inventory writes from analysis, bounded result expiry and discard cleanup. The browser contacts Supabase, not a provider host.

Each owner enables pre-save analysis after the notice. Explain that analysis may be charged even if the draft is discarded. A photo fills the editable form automatically; Save alone adds it to the library. Missing consent/provider/budget falls back to manual completion, not auto-save. Model/provider changes require reviewed configuration/disclosure.

Monitor request failures, result expiry/purge, cost reservations and aggregate provider bills as operator-only information. Owners see only their own usage. No image/prompt/raw-response logs. Result polling and duplicate requests must not issue new model calls; alerts are not enforcement.

Azure fallback: deploy the same `dist/` to Static Web Apps **Free**, with equivalent headers/HTTPS and exact Auth/CORS origin changes. The Azure route needs no Azure credit-consuming services. Do not accidentally use the host's own Auth/invitation model to link the wardrobe accounts.

## 5. Monitoring and free-project pause

The operator checks provider quotas and the date of each person's last completed backup weekly. Each account's app shows only its own local backup status/image usage, not aggregate user activity. Source-of-truth thresholds are in `11`. Turn paid-spend settings off where available and never auto-upgrade.

If Supabase pauses after inactivity, show a generic service-unavailable screen with Retry. The operator resumes the project through the provider dashboard, checks Auth/data/Storage with a normal account and verifies the latest export. Do not create artificial keepalive traffic solely to evade pause policy. The $0 plan has no promised uninterrupted availability.

## 6. Backup procedure and scripts

Default RPO: **up to seven days**, assuming the weekly backup is actually run. Proposed local recovery target: same day, normally under two hours for this data size, subject to provider availability. A failed/missed backup visibly increases the actual RPO.

Each person makes their own full encrypted backup weekly after uploads finish. Keep the latest **three** complete backups per account on their own protected machine; copy the newest to a separate encrypted device or an existing private storage service they control. Do not put backup copies in the live Supabase bucket. Do not combine the two users' portable exports.

Phase 6 supplies these exact script contracts:

```bash
node scripts/export-own.mjs --output /private-backups/stillroom
node scripts/verify-backup.mjs --input /private-backups/stillroom/export-directory
node scripts/restore-own.mjs --input /private-backups/stillroom/export-directory --dry-run
node scripts/restore-own.mjs --input /private-backups/stillroom/export-directory --commit
node scripts/cleanup-own-images.mjs --dry-run
```

Scripts prompt securely for the current user's credentials/passphrase or use that person's OS credential store. They must not accept service-role credentials, log tokens or place a password literal in CLI arguments. `export-own` calls the consistent owner-only manifest RPC, downloads every listed ready/retired image, checks hashes, writes encrypted bounded parts using `08`, and produces a non-secret count/hash summary. If images disappear during export, mark incomplete and retry from a new snapshot. A successful SQL dump alone is not a photo backup.

`verify-backup` checks decryption/authentication tags, part completeness, manifest hash, each JPEG hash/size and relationship consistency without connecting to the cloud. The reference owner-export helper in `reference-scripts/` demonstrates the specified format; implementation scripts must pass the included cryptographic checks and add a complete schema-valid export/restore golden fixture. The supplied crypto vector is not a completed backup/restore test.

Local scheduling is optional: use the user's OS scheduler under their own login, with secrets in their OS credential store and a local failed-job notification. Do not schedule one user's backup through the other user's app or install scheduled tasks during blueprint creation. No passphrase is stored in a task definition. If secure unattended credentials/passphrase handling is not set up, keep a weekly manual backup rather than pretending it is automated.

## 7. Restore and accidental deletion

Language follows the existing profile-merge choice: preserve the current target language by default. V1 backups missing `ui_language` are accepted as unset only after hashes are verified against their original bytes; supported saved codes are `en`, `fi`, `sv`. Locale changes never rewrite exported keys, currency codes, item text or historical dates. See `19-LOCALIZATION.md`.

Write metadata v2/read v1/v2 per `20`, keeping envelope v1. Preserve saved provenance/descriptions/manual clears; exclude unsaved drafts, request results, usage and active AI consent. Image Save/commit and restore must never call analysis. Assert zero provider calls in every restore drill.

For ordinary mistakes, use the eight-second Undo shortcut or seven-day Trash first. Current/retired images remain private to their owner. Permanent account deletion has no application Undo; recovery would require the owner's external backup and explicit re-provisioning, never automatic recreation.

Restore drill, quarterly and before risky migrations:

1. Export/verify the current owner's complete data and images; record counts, byte totals and manifest SHA-256, not content.
2. Create a disposable **local** recovery stack from the same migration and independently provision its approved fictional user. Never wipe production as part of a drill.
3. Dry-run restore. Validate format, limits, known tables/columns, hashes and deterministic owner-bound ID mapping. Default profile/preferences action is preserve current values; import them only when deliberately selected.
4. Commit in the order in `08`. Recompute paths and owner IDs, restore imported historical text through the checked RPC, and do not trust source file paths.
5. Interrupt once after a partial image batch, rerun the same export ID and prove no duplicate rows or silent overwrite. Existing differing records require review.
6. Compare counts and every main/thumbnail hash, inspect representative outfit/calendar/history entries and currency calculations, then run normal-session access tests. No connection to another account may appear.
7. Record the successful drill in the operator runbook and delete the disposable environment/temporary decrypted material. Keep encrypted originals under the owner's control.

## 8. Deletion and cleanup recovery

Pending images with `created_at` older than 24 h, retired images with `retired_at` older than seven days and trash with `deleted_at` older than seven days are candidates. Never use the original upload date to shorten a retired photo's recovery window. `cleanup-own-images --dry-run` lists only the owner's candidate counts. A commit rechecks current metadata, removes actual Storage bytes and then forgets metadata. Enumerate unknown orphan keys only under that owner's UUID prefix, validate their shape and apply the grace period. Server object timestamps are authoritative for orphan age; do not use a client's clock alone.

Account deletion: the function reauthenticates the user, freezes only their approval and uses a private receipt. Remove files in batches with a stable prefix; after each batch re-list from the start so pagination offsets do not skip deleted objects. Mark `storage_removed` only when that prefix is empty; SQL verifies this before deleting profile/private rows. Auth Admin deletion follows, then `auth_removed` completes the receipt. A failure returns a coarse retry code, never success with remaining files. The other account is unaffected.

Freeze blocks new analysis/results. Delete the owner's request/result/usage data with their private graph; late responses cannot recreate items. Already-sent requests may retain a charge and provider-retention period. Explain this in the deletion notice.

`resume-deletion.mjs` is operator-only and accepts a previously verified job ID/owner from the private receipt, not arbitrary browser input. It can resume after Auth deletion prevented the user from logging back in. Purge completed receipts after seven days. The user separately deletes their external backup copies if they want those erased; the app cannot recall them.

## 9. Provider migration or closure

First preserve tested, owner-encrypted exports and image bytes outside the provider. A static-host move changes only deployment/Auth origin settings. A database/storage exit uses a separately encrypted operator schema/data dump plus actual object downloads, or each user's portable export into a fresh compatible backend.

Provision new independent identities; map each old owner only to that same person's verified new identity. Recompute owner paths/foreign keys; never merge profiles or infer relationships. Replace `AuthAdapter`/`WardrobeRepository`/`ImageRepository` while keeping domain types and tests. Recreate and test RLS/authenticated image policies before copying personal data. Freeze writes during final snapshot/cutover, verify row/image hashes, deploy the new URL/configuration, and test each login separately. Keep the old service read-only until validation is complete, then remove it after verified backup and the user's migration decision.

A free-tier closure can mean temporary downtime or a later choice between a paid managed tier and self-hosting. Do not promise a permanent zero-cost provider or omit the operational burden of self-hosting. No paid upgrade/migration executes automatically.
