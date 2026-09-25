# Phase 6 result: P6a backup (partial)

Status: **engineering in review; partial.** This document covers packet P6a
only: the I18 full encrypted backup and the browser half of I19 (metadata-only
JSON). Restore (P6b), account deletion (P6c) and Phase 6 acceptance are not
claimed.

- Base: `e5c16ccde08a96a7ca8241f687d567c1763edb2e` (origin/main).
- Requirements: R13, R18, R19, R20, R27; blueprint `06` I18/I19, `08`
  export, `10` privacy, `14` Phase 6, `20` (no AI call).
- Plan: Phase 6 plan `6C2BE8A4…`, approved for P6a with binding amendments
  F2, F3, F4 and F6 after one GPT-6 Astra critique.
- No schema, migration, Edge Function, CSP or Auth change. It uses the
  installed `export_manifest` and `item_attribution_history` RPCs and
  authenticated Storage downloads.

## What the owner can do

Settings > Backup:

- **Create backup.** Enter a passphrase twice (at least 16 characters). The
  app reads a snapshot, then offers one download per part. Each part is
  encrypted in the browser with AES-256-GCM and a PBKDF2-SHA256 key
  (600,000 iterations). The passphrase stays in component memory only; it is
  never stored or sent.
- **Download my data (JSON).** An unencrypted file with the same saved-only
  metadata and no photos.

Signing out, switching account or Start again drops the snapshot, any photo
bytes in memory and the passphrase. Offline, both actions are disabled.

## What is in a backup

Saved data only, as one closed projection:

- Profile without `weather_enabled`: consent is never exported as a setting to
  restore.
- Saved items and their saved non-pending photos, including retired photos and
  their descriptions (F4). Pending uploads and unsaved drafts are excluded.
- Saved-only attribution history per item (F2): model ID, prompt version, image
  hash, source-image link and fields. A link whose image is not in the backup,
  or whose image was already removed (the link is then null), is marked
  `source_image_excluded: true`; the recorded hash, model, prompt and fields
  are kept. Charge receipts, analysis requests,
  results and AI consent are excluded.
- Outfits, their items and history. An `outfit_id` pointing at a trashed
  outfit or one emptied by filtering is set to null, and the historical text is
  kept (F3).

Consistency: the snapshot is read twice around the attribution reads; any item
or photo change stops the backup (`backup.changed`). Each photo is checked
against its recorded size and SHA-256 before it is encrypted.

## Offline verifier

`node scripts/verify-backup.mjs --input DIR` reads the passphrase from stdin or
a hidden prompt. It never resolves URLs or paths from the files (F6). Before
reading anything it checks file names, rejects symlinks and limits the part
count (400), per-part bytes (metadata part 12 MiB, photo parts 40 MiB) and the
total (7.5 GiB). It then checks the metadata part first and reads, checks and
releases one photo part at a time, keeping the decoded photo total within
4 GiB. It also bounds JSON depth, string and row sizes, requires unique part and
file IDs, strict base64, exact completeness against the manifest hash, and
sanitized JPEGs (exact main dimensions, thumbnails ≤ 320 px, orientation 1).
Exit 1 means a failed check; exit 2 a usage error.

## Validation (builder, local)

- `npm run lint`, `npm run typecheck`, `npm run check:translations`: clean.
- `npm run test:unit`: 3866/3869 under local load; the 3 failures were 5 s timeouts in existing `ai-schema`, `preservation` and `local-backend` tests, which pass when run with `--testTimeout=60000`. The new crypto suites set a 60 s timeout because PBKDF2 runs per part.
- Playwright `backup`, `profile`, `weather`, `today` and `slice` specs on
  chromium, mobile and webkit-photo: 350/351. The one failure was the existing
  I16 test `weather.spec.ts:261` on webkit-photo (a forecast count read before
  the second request was logged); it passed 5/5 when repeated.
- Two bounded synthetic captures (`test-results/p6a-visual`) are uploaded by
  the CI App job as `p6a-backup-ui-<sha>`.

## Deferred and pending

- **Scope deferral (not completion):** the `export-own` and `restore-own`
  CLIs of I19/I21 are moved to the backlog by coordinator decision under the
  owner's standing approval. I19 and I21 are not complete.
- Restore (P6b) and account deletion (P6c) follow in their own PRs, in that
  order.
- Pending: GPT-6 Astra code review, green exact-head CI (including the
  database/security suites), coordinator visual review of the captures, and an
  owner-run Pages deploy before the card exists on the hosted site.

# P6b restore (partial, non-destructive)

Status: **engineering in review; partial.** P6b adds restore from a P6a (v2)
or reference-exporter (v1) backup. Account deletion (P6c), attribution restore
(Q5, open with the owner) and Phase 6 acceptance are not claimed.

- Base: `30f256be59ca06ac9a45841b6f0f044b9b38a7a5` (origin/main).
- Requirements: blueprint `06` I20/I21, `08` import, `10` privacy, `14`
  Phase 6, `20` (no AI call). Plan rev4 with binding amendments R1 and R2.
- Additive migration `20260925110000_restore_item_save.sql`: new
  `reserve_restored_item_save(jsonb, jsonb)`,
  `restore_image_change_status(uuid, uuid)` and
  `restore_item_save_status(uuid)`, authenticated only. No existing
  function, table, policy or trigger changes. The hosted apply is pending
  separate authorization.

## What the owner can do

Settings > Restore from backup: choose every part, enter the passphrase and
**Check backup**. The check decrypts and verifies the whole backup before
anything is written (wrong passphrase, missing parts, other files, too many or
too large files are refused). The preview shows the backup date, what will be
added, what is already here, and what is skipped. **Restore** then adds items,
photos, outfits and history to the signed-in account.

## Rules

- IDs are rebound to the current owner: each restored ID is a UUIDv8 of
  SHA-256 over `stillroom/restore/v{version}|targetUid|exportId|table|sourceId`,
  so a repeated restore of the same backup resumes instead of adding copies.
  Restoring a backup into the account that made it adds copies with new IDs.
- Items go through the checked Save chain (`reserve_restored_item_save` ->
  upload -> `finalize_item_save`) with the exported provenance kinds and
  revisions reset to 1. Photos are decoded and re-encoded in the browser
  (`prepareImage`), thumbnails are generated from the restored main photo, and
  uploaded bytes match the newly recorded hashes. Retired photos are replayed as
  a replacement chain through the existing `finalize-image-change` function,
  with the latest photo current (R1 completed-prefix validation).
- Before an item is skipped as already here, or resumed, every completed photo
  is checked: both stored files by size and SHA-256, photo 0's checked save
  (`restore_item_save_status`: completed, same image) and each later photo's
  completed replacement request (same image, previous photo, expected
  version). The item's values and provenance kinds must equal the restored
  ones and its version must equal the completed prefix; an edit made here, a
  missing or different stored file, or a mismatched request makes the item a
  conflict, left as it is. A stored file that cannot be read for now (network
  or server error) is not a conflict: the item is retried like any other failure.
- An item that failed in a way that can be retried holds back every outfit,
  rule, feedback entry and history event that refers to it, so their
  deterministic IDs are only written once, complete. The run then reports
  them as not restored and never says it is complete; running it again
  continues. Conflicting or trashed items are final and are left out.
- A v1 part 0 carries photos and may be up to the 40 MiB part limit: a part 0
  over the v2 12 MiB metadata limit is decrypted and accepted only as v1.
- Available dependencies: new, resumed and identical items. Unavailable:
  conflicting, trashed or deleted and fenced items; outfits drop them and
  history keeps its text with the item link cleared. Failed items defer their
  dependants instead (above). History uses the
  checked `restore_history_entry` RPC.
- Not restored: profile and style preferences, `weather_enabled`, AI consent,
  analysis drafts, requests, results, receipts and attribution history. The
  preview says tag history isn't restored.
- Limits (R2): selection is bounded by the P6a `BACKUP_LIMITS`
  (400 parts, 40 MiB per part, 7.5 GiB encrypted in total); the 4 GiB decoded
  photo total is enforced during verification. v1 inputs keep the v1 ID
  namespace.
- No analysis or provider call is made. Offline, signing out or switching
  account stops the restore and drops passphrase and photo bytes; running it
  again continues, and nothing is added twice.

## Validation (builder, local)

See the P6b PR description for exact commands and results. The database,
integration (`tests/integration/restore-save.sessions.mjs`) and security
(isolation audit) suites run in CI; the builder has no local database stack.

## Pending

- GPT-6 Astra code review, green exact-head CI, coordinator visual review of
  the `p6b-restore-ui-<sha>` captures.
- Hosted apply of the additive migration and an owner-run Pages deploy.
- Q5 (attribution restore), P6c account deletion, and the deferred
  `export-own`/`restore-own` CLIs.
- No real-backend restore round trip: the browser restore specs run against
  the mock backend, and the integration suite checks the new functions
  (`reserve_restored_item_save`, `restore_image_change_status`,
  `restore_item_save_status`) and their owner isolation against the local
  database, but not a full backup -> restore replacement chain through
  Storage and `finalize-image-change`. That needs browser image encoding and
  the Edge runtime in one job, beyond the current CI time budget.

# P6c account deletion (source only; hosted activation owner-gated)

Status: **engineering in review.** P6c adds owner-confirmed account deletion
(blueprint `06` I22, `08` deletion, `10` privacy/deletion, `14` Phase 6)
under plan rev1-rev5 and their binding amendments. Attribution restore (Q5)
stays open, so Phase 6 acceptance is not claimed.

- Base: `960aed483116e382a18883041096112dc7965dd1` (origin/main, after P6b).
- Migrations (not additive; the hosted apply needs owner approval):
  - `20260925120000_account_deletion.sql`: admission generations on
    `private.approved_accounts`; a replaced, service-only
    `deletion_control(owner, action, op, code)` with a lease and operation
    token, lock order admission row then job, a bounded attempt budget, an
    existing-job-only operator grant and absence-verified terminal
    reconciliation; the frozen-owner branch in front of the unchanged Storage
    publication guard body; a `before delete on auth.users` trigger that
    removes the exact admission row only for a job at `auth` with the recorded
    generation (Q2). It waits for a held admission row for at most a
    function-local 5 s lock timeout (no NOWAIT); service-only `purge_deletion_receipts()`; and
    `deletion_status()`, which returns only the signed-in owner's own job
    state (`none`, `in_progress`, `retry`, `contact`, `complete`) so a
    frozen account can reach the recovery screen.
  - `20260925120100_deletion_receipt_purge_schedule.sql`: one inactive daily
    job that purges completed receipts older than seven days.
- Edge Function `delete-account`: verifies the user token, re-authenticates
  with the password, takes the owner from the token (no owner in the body) and
  runs the shared stage loop (`supabase/functions/_shared/deletion-loop.ts`):
  freeze -> storage (per-object removal of the owner's prefix) -> rows ->
  auth (GoTrue hard delete) -> complete. The operator tool
  `scripts/resume-deletion.mjs` runs the same loop for an existing job only.
  Before every external request the loop checks the deadline and its lease,
  and checks the deadline again after a renewal. The app gives the deletion
  request its own 120 s transport limit; every other request keeps 20 s.

## What the owner can do

Settings > Delete account: **Make a backup first** moves to the Backup card.
**Delete account** shows the password field, "I understand this can't be
undone" and a typed phrase ("delete my account", "poista tilini", "radera mitt
konto"); **Delete account permanently** runs the deletion. When it finishes the
app signs out and says the account has been deleted. An unfinished deletion
says what to do: enter the password again, wait, or contact the app's
administrator. What is already deleted stays deleted. A frozen account that
signs in again sees only "Account deletion hasn't finished", with its password
field, **Finish deleting** and **Sign out**; no profile or wardrobe data is
read.

## What is deleted

Every owner-keyed row, all of the owner's Storage objects, AI requests,
results, usage and charge receipts, the Auth identity and the exact admission
row. The completed deletion receipt is kept seven days, then purged by the
scheduled job once activated. Downloaded backups and the hosting provider's own
backups are not affected; the card says so.

## Validation (builder, local)

See the P6c PR description for exact commands and results. The database,
security (`tests/security/delete-account.sessions.mjs`) and the serialized
`deletion-rehearsal` CI job (a separately isolated disposable local stack,
with owner C and a control account D) run in CI; the builder has no local
Docker or database stack.

## Pending

- GPT-6 Astra code review, green exact-head CI including the rehearsal job,
  and coordinator visual review of the `p6c-delete-account-ui-<sha>` captures.
- Owner gates before anything runs on hosted: Q5, Q2 (admission row removal),
  the non-additive replacements and triggers, the Edge deploy, activating the
  purge schedule, and a disposable hosted drill; then an owner-run Pages deploy.
- The security suite now serves the Edge functions and requires the
  cross-owner `delete-account` probe to return exactly `INVALID_INPUT` with
  both owners' deletion state unchanged; a missing Edge configuration fails
  the gate. It sends no valid password, so nothing destructive runs there.
- The rehearsal job sets Docker's default host binding to `127.0.0.1` before
  the stack starts; the script itself never changes Docker configuration and
  refuses any effective published address other than `127.0.0.1`. A failed
  rehearsal SQL step prints its step, SQLSTATE and a redacted first error line.
- The deferred `export-own`/`restore-own` CLIs.
