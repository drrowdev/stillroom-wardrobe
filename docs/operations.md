# Operations: backups, restore drills and recovery

This runbook covers the recurring backups (R20), the restore drill (I26), the
limits on hosted operations, and recovery from quota pressure, a paused project or
a bad release. The source requirements are `blueprint/17-DEPLOYMENT-AND-RECOVERY.md`
§5–§8 and `blueprint/11-COST-AND-HOSTING.md` (charge controls). The automated
release checks are in [release-checks.md](release-checks.md).

## Recurring backups (R20)

| | |
|---|---|
| **Schedule** | Each owner makes their own backup weekly, after uploads finish. The two accounts are independent: neither owner can back up, restore or see the other account. |
| **Retention** | Keep the latest **3 complete** backups per account. Complete means every part plus a green `verify-backup` result. At least one encrypted copy lives off the device: the owner's own cloud storage or an external disk. Never put a backup in the live Supabase bucket, and never combine the two accounts' backups. |
| **Passphrase** | In the owner's password manager. It is never written in a script, a scheduled task, an argument or an environment variable. |
| **RPO** | 7 days, assuming the weekly backup actually runs. A missed or failed backup visibly increases the real RPO. Recovery target: same day, normally under two hours for this data size, subject to provider availability. |
| **Drills** | Quarterly, and before any risky migration (see [Restore drill](#restore-drill-i26)). |
| **Actors** | Each owner for their own backups and off-device copy. The coordinator runs the local drill; the owner runs the hosted H1 check. The operator checks each account's last completed backup date weekly, alongside the quotas. |

**Failure handling.** A failed backup or a failed verification is retried with the
same command; an interrupted `export-own` run resumes within a day. A partial
backup is never counted as complete. If an account has no green backup within
7 days, it becomes an open item in the release-gate ledger, and the owner is told.
A backup that stops because a photo or item changed during the snapshot is rerun
from a new snapshot.

### Commands

In the app, a backup is **Settings → Backup → Create backup**, which downloads each
encrypted part. The command-line equivalents run on the owner's own machine, under
their own login:

```bash
# Encrypted backup of your own account (prompts for email, password and passphrase).
node scripts/export-own.mjs --output /private-backups/stillroom
# Offline check: decryption, part completeness, manifest hash, every JPEG hash and size.
node scripts/verify-backup.mjs --input /private-backups/stillroom/stillroom-<export id>
```

`export-own` accepts only the publishable key (`SUPABASE_PUBLISHABLE_KEY`) and
refuses to run when administrator or database credentials are present in the
environment. Secrets are never taken from arguments or files. `verify-backup`
makes no network connection.

**Restore** in the app is **Settings → Restore from backup**: *Check backup* reads the parts
and shows a non-committing plan (items to add, already present, photos to
re-encode), and nothing is written until *Restore*. The command-line
`restore-own` (dry run and commit) is **pending in #66** and is not yet part of this
runbook; until it merges, use the app.

Scheduling is optional. Use the owner's own OS scheduler under their login, with
secrets in the OS credential store. If unattended passphrase handling isn't set up,
keep the weekly manual backup rather than pretending it is automated.

## Restore drill (I26)

Restore and idempotence are proven **only locally**, on fictional data. The
automated drill is `tests/integration/restore-roundtrip.spec.ts`, part of
`npm run test:integration` (it runs in CI against the disposable local stack;
builders don't reset or provision the shared local stack). It:

1. Builds fictional owner B's data through normal sessions: a photo replaced once
   (a retired chain with a preserved and a re-encoded photo), AI-observed,
   AI-estimated, unknown and user provenance, manual clears, a trashed item, an
   outfit, a wear event, a rule and feedback.
2. Makes B's encrypted backup and decrypts it offline; the manifest hashes must
   equal the carried files.
3. Restores it into fictional owner A through the app: *Check backup* (no writes), then a
   run interrupted during the photos, then a resumed run to completion.
4. Compares hashes three ways: **source** (the backup manifest), **expected** (the
   restore plan: a preserved main keeps the source hash; a re-encoded main and every
   regenerated thumbnail use the planned hash) and **actual** (downloaded from
   Storage through A's normal session).
5. Checks the expected per-table differences: mapped IDs owned by A, the retired
   chain, descriptions, field provenance and manual clears. Saved attribution
   history is not restored (Q5): A's `item_attribution_history` stays empty, a
   recorded gap rather than a pass.
6. Restores the **same** backup a second time into A. Every item is already present,
   and rows, versions and Storage objects are unchanged, with no uploads or save
   reservations.
7. Asserts zero provider calls: no `analyze-clothing` request, no AI or
   analyzed-save RPC during any restore step, and B's data unchanged throughout.

The owner-side release journey on fictional data is
`tests/browser/release-journey.spec.ts` (sign in, language, photo add with Save,
search, outfit order, Today, backup with offline verification, offline notice,
sign-out with nothing private left). The VoiceOver and TalkBack pass on the owner's
phones is an owner device gate and stays pending until the owner reports it.

**Drill artifacts.** Fictional-data backups and any decrypted output go in a
separate folder named `drill-<YYYY-MM-DD>`, never next to the owner's retained
backups, and are deleted after the drill. They never count as one of the 3 retained
copies. Record only counts, byte totals and the manifest SHA-256 of a drill, not
content. Delete the disposable environment afterwards.

## Hosted operations

**H1 (the owner, their own account, no restore).**

1. Create a backup.
2. Verify it offline with `verify-backup`.
3. Open **Restore from backup** and run *Check backup* to the non-committing plan, then close
   it without starting.
4. Record the counts, bytes and manifest SHA-256.

H1 proves the hosted read, encryption and decryption paths only. No hosted restore
or idempotence is claimed.

**Everything else hosted needs its own approval.** Each hosted restore, deletion,
migration, Edge function deploy, Pages deploy or service-worker rollback needs an
explicit owner approval that names the target, the expected writes, the cost and the
cleanup. A drill is never run against production, and production data is never
wiped for one.

## Quota pressure

The operator reads provider dashboards weekly and records the values in a local
operations checklist. Thresholds come from `blueprint/11`:

| Resource | Warn | Act at | Action |
|---|---:|---:|---|
| File storage | 600 MB | 800 MB; pause new uploads at 900 MB | Review and remove expired retired/trash versions after owner-visible review; take a backup before any deletion. Never remove current or recovery-required photos. |
| Database | 300 MB | 400 MB | Inspect growth; remove expired feedback and deletion receipts; back up first. |
| Uncached egress/month | 3 GB | 4 GB; conserve at 4.5 GB | Postpone redundant exports, but keep the weekly backup and urgent recovery downloads. Flag any missed backup against the 7-day RPO. |
| Edge invocations/month | 100,000 | 400,000 | Investigate loops or abuse; pause the deletion endpoint and use operator-assisted deletion meanwhile. |

A quota shortfall never triggers an upgrade from the app. Any paid plan is a
separate owner decision.

## Paused project

If Supabase pauses the free project after inactivity, the app can't load data and
shows its ordinary load errors with *Try again* (there is no dedicated pause
screen). To resume:

1. The operator resumes the project in the Supabase dashboard (owner approval, as a
   hosted operation).
2. Sign in with a normal account and check that the wardrobe, a photo and a saved
   change work.
3. Confirm each account's latest backup still verifies; if the pause outlasted the
   RPO, each owner makes a fresh backup first.

No artificial keepalive traffic is created to avoid the pause policy.

## Rollback and resume

- **App release.** Roll back by deploying an earlier reviewed build to Pages; open
  tabs see the Update prompt. The emergency worker
  (`STILLROOM_SW_KILL_SWITCH=1 npm run build`) removes only the app's shell caches
  and unregisters itself. Both are owner-approved deploys; see
  [cloud-development.md](cloud-development.md) (service worker).
- **Database.** Never reset or replay the hosted database. A bad migration is fixed
  by a reviewed forward migration. Restoring data means an approved restore from the
  owner's own backup, after a local drill on the same backup format.
- **Interrupted backup or restore.** Run the same command or press the same button
  again: `export-own` resumes the same export ID within a day, and the app's restore
  resumes from the same backup, adding nothing that is already present.
- **Accidental deletion.** Use Undo (eight seconds) or Trash (seven days) first.
  Permanent account deletion has no Undo; recovery needs the owner's external backup
  and explicit re-provisioning.
