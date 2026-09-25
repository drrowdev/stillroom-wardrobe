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
  hash, source-image link and fields. A link whose image is not in the backup
  is marked `source_image_excluded: true`. Charge receipts, analysis requests,
  results and AI consent are excluded.
- Outfits, their items and history. An `outfit_id` pointing at a trashed
  outfit or one emptied by filtering is set to null, and the historical text is
  kept (F3).

Consistency: the snapshot is read twice around the attribution reads; any item
or photo change stops the backup (`backup.changed`). Each photo is checked
against its recorded size and SHA-256 before it is encrypted.

## Offline verifier

`node scripts/verify-backup.mjs --input DIR` reads the passphrase from stdin or
a hidden prompt. It never resolves URLs or paths from the files (F6). It checks
file names, rejects symlinks, limits the part count (400), per-part and
aggregate bytes, JSON depth, string and row sizes, requires unique part and
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
