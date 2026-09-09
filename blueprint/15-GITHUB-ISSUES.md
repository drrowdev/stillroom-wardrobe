# GitHub implementation work packets

These are specifications, not created issues. Split I29's migration/endpoint/draft UI if needed while keeping its gate intact. Implement Phases 0–7 only; I27–I28 are optional. Revision 1.3 retains I29 after I07 but replaces background tagging with pre-save form filling/review/Save. All packets inherit owner isolation, localization and `20`. Test paths are future implementation targets.

## I01 — Set up the PWA repository and CI

Phase: **0** · Requirements: **R16 R18 R19 R22 R27** · Depends on: **none**

Goal: Create the TypeScript/React/Vite skeleton, strict checks, exact lockfile, dependency notices and build. Copy agent instructions to root. Copy/adapt the supplied trilingual catalog/helpers and add the check:translations CI gate from 19.

Target files: `package.json`; `src/app/app.tsx`; `src/styles/tokens.css`; `.github/workflows/ci.yml`; `docs/dependencies.json`; `src/i18n/messages.json`; `src/i18n/index.ts`; `src/i18n/format.ts`; `scripts/check-translations.mjs`.

Test files: `tests/unit/smoke.test.ts`; `tests/unit/original-assets.test.ts`; `scripts/scan-secrets.mjs`; `tests/unit/i18n.test.ts`.

Acceptance: Given a clean checkout, when npm ci and the static CI commands run, then a minimal original shell builds with no secret or unsupported dependency. All EN/FI/SV keys/parameters and locale-helper unit tests pass.

Security: Allowlist browser environment variables; no reference-product assets or relationship feature folders.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I02 — Install the schema and provision independent test accounts

Phase: **0** · Requirements: **R01 R11 R19 R26 R27** · Depends on: **I01**

Goal: Apply the supplied SQL unchanged to a fresh local Supabase stack; independently reserve and provision exactly two fictional accounts. Generate database types.

Target files: `supabase/config.toml`; `supabase/migrations/20260905000000_initial.sql`; `scripts/reserve-accounts.sql`; `scripts/provision-test-users.mjs`.

Test files: `tests/integration/schema.test.ts`; `tests/security/admission.test.ts`.

Acceptance: Given fresh local Auth/Storage, when the migration and separate admin fixture run, then both approved logins exist, a third email is rejected and all twelve application tables enforce RLS.

Security: Fixture administrator secret never enters the user-session test process; private admissions are not exposed through PostgREST.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I03 — Build invite-only login and the protected wardrobe screen

Phase: **0** · Requirements: **R01 R02 R11 R26 R27** · Depends on: **I02**

Goal: Sign in with a reserved email/password and fetch only the current profile/items. Display the active account indicator and implement complete logout/UID reset. Localize the slice in English/Finnish/Swedish; add the sign-in language selector and initialize only an unset owner ui_language as specified in 19.

Target files: `src/auth/session.ts`; `src/auth/login.tsx`; `src/app/routes.ts`; `src/features/wardrobe/wardrobe-screen.tsx`; `src/i18n/language-selector.tsx`; `src/data/profile.ts`.

Test files: `tests/browser/auth.spec.ts`; `tests/security/session-cache.spec.ts`.

Acceptance: Given A and B, when each signs in separately, then each sees only their own empty wardrobe; switching or using Back never shows previous-user data. A saved Finnish preference and B saved Swedish preference stay independent; html lang and logout reset follow the active identity.

Security: No signup/user directory/peer lookup; token refresh failure locks the screen.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I04 — Add a sanitized private JPEG upload

Phase: **0** · Requirements: **R03 R04 R12 R23** · Depends on: **I03**

Goal: Implement the vertical-slice JPEG path: title/category, pixel re-encode, main/thumbnail, metadata reservation, immutable private uploads and commit.

Target files: `src/images/process-jpeg.ts`; `src/images/upload.ts`; `src/data/items.ts`; `src/features/wardrobe/add-item.tsx`.

Test files: `tests/unit/image-metadata.test.ts`; `tests/integration/upload.test.ts`; `tests/integration/idempotency.test.ts`.

Acceptance: Given an EXIF-tagged JPEG, when A saves it, then sanitized bounded JPEGs appear on A’s screen, and a retry uses the same item/image identity.

Security: No raw original upload, public bucket, arbitrary filename, storage upsert or privileged key in the browser.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I05 — Prove account isolation and package the deployable slice

Phase: **0** · Requirements: **R01 R11 R12 R19 R23 R27** · Depends on: **I04**

Goal: Adapt the supplied normal-login harness, wire it into local CI, run the protected upload journey and produce a deployable static build plus hosted setup instructions. Include cross-owner language-setting denial and the three-language slice journey.

Target files: `tests/security/rls.sessions.mjs`; `.github/workflows/ci.yml`; `docs/phase-0-result.md`; `public/_headers`.

Test files: `tests/security/rls.sessions.mjs`; `tests/browser/slice.spec.ts`; `scripts/scan-secrets.mjs`.

Acceptance: Given valid normal A/B sessions, when either directly reads/edits/deletes/downloads the other’s data, then it fails without modifying the owner’s data; anonymous calls fail too.

Security: Do not substitute service-role queries or PGlite identity stubs for this gate; report deployment blocked if external credentials are absent.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I06 — Implement private profile and style preferences

Phase: **1** · Requirements: **R02 R25 R27** · Depends on: **I05**

Goal: Build S02 fields, validation and version conflicts; keep preferences independent and optional. Add the owner-only language preference with version-checked saving and no change to timezone/currency or personal text.

Target files: `src/features/profile/profile-screen.tsx`; `src/features/profile/preferences.tsx`; `src/data/profile.ts`; `src/features/settings/language-settings.tsx`.

Test files: `tests/unit/preferences.test.ts`; `tests/browser/profile.spec.ts`; `tests/browser/localization.spec.ts`.

Acceptance: Given a current owner profile, when name/timezone/currency/style/coverage are saved, then only that owner changes and the account badge updates.

Security: No other profile names/emails/options appear; raw errors and preferences never enter logs.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I07 — Complete phone image preparation and crop controls

Phase: **2** · Requirements: **R04 R17 R24** · Depends on: **I06**

Goal: Extend the safe JPEG path to tested PNG/WebP decoding, all orientations, crop/rotate/reset, byte caps and accessible controls. Keep enhancement provider disabled.

Target files: `src/images/validate.ts`; `src/images/process-image.ts`; `src/images/crop-editor.tsx`; `src/providers/enhancement.ts`.

Test files: `tests/unit/image-headers.test.ts`; `tests/browser/images.spec.ts`.

Acceptance: Given orientation and unsupported-format fixtures, when a photo is prepared, then pixels orient once, both outputs meet limits and unsupported HEIC receives a useful JPEG fallback.

Security: No source image or photo is sent to an enhancement provider; metadata remains absent after every processing path.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I29 — Add automatic editable AI clothing details

Phase: **2** · Requirements: **R18 R19 R23 R26 R27 R28** · Depends on: **I07**

Goal: Implement `20`: photo-only start, automatic pre-save form filling including title/category, every garment field editable, explicit Save/discard. Add model/consent/budget gates, authenticated analysis endpoint, bounded receipts/provenance and narrow image-description editing. No library writes from analysis, scheduled worker or post-save AI.

Target files: `supabase/migrations/20260906000000_automatic_tagging.sql`; `supabase/functions/analyze-clothing/index.ts`; `supabase/functions/_shared/ai/`; `src/domain/attribute-provenance.ts`; `src/data/automatic-details.ts`; `src/features/wardrobe/automatic-details.tsx`; `src/features/settings/ai-settings.tsx`; `docs/ai-model-selection.md`.

Test files: `tests/integration/automatic-tagging.test.ts`; `tests/security/automatic-tagging.test.ts`; `tests/unit/ai-schema.test.ts`; `tests/unit/ai-budget.test.ts`; `tests/browser/automatic-details.spec.ts`.

Acceptance: Given a photo only and enabled consent/allowance, automatically fill title/category/details in the editable form. No library item/image exists before Save or after discard. Save persists exactly the reviewed values; all garment fields/descriptions remain editable afterward. Manual clears, new photos and Save defeat stale results. Timeout permits manual completion; missing facts stay unknown. Description edits cannot change image bytes/paths. Complete the model gate in 20.

The I29c manual foundation uses `src/features/wardrobe/item-form.tsx` for all
thirty fields, explicit reviewed-value Save and later correction, with the
separate description section. Its optional-collections migration preserves
historical rows while allowing empty/unknown colours and seasons. Manual value
patches and provenance increments are inseparable; app defaults are not AI facts.
Coverage in `docs/phase-2-result.md` is this packet's evidence, not replacement
of the full I29 or later lifecycle/idempotency acceptance targets. Automatic
analysis, consent, receipts, allowances, expiry and saved-only export still belong
to MVP I29; this manual packet does not defer or implement them.

Security: Owner-authenticated analysis with current consent/budget, server image/output validation, no arbitrary URL/owner/item target and no inventory writes. No direct receipt/usage access or browser provider keys. Discard/expiry purges bounded results; unknown-billing timeouts do not auto-retry. No real inference/photos in ordinary CI.

Done: Follow `21` to compare two eligible models with authorized photos, recording field errors/unknowns, correction effort, latency and billed usage before choosing a configuration. Do not assume Gemini is cheapest/best or Terra the only alternative. Cover duplicate requests, expiry, manual clears, account changes, failed Save and no AI on Save/restore. Metadata-v2 excludes drafts/results/usage. Base SQL/results are not AI evidence.

## I08 — Build full item metadata and lifecycle management

Phase: **2** · Requirements: **R03 R23 R28** · Depends on: **I29**

Goal: Implement every item field in R03, AI provenance/unknown states from I29, favourites, laundry/availability, lifecycle, trash/undo and permanent deletion. Use checked versioned edits that protect manual values and explicit clears from later AI.

Reuse I29c's shared item form and its field/clear/Save contract rather than
creating another editor. I29c's basic availability/lifecycle/flag controls are not
I08 trash, undo, permanent deletion, bulk actions, filtering or eligibility logic.

Target files: `src/features/wardrobe/item-form.tsx`; `src/features/wardrobe/item-detail.tsx`; `src/features/settings/trash.tsx`.

Test files: `tests/browser/items.spec.ts`; `tests/integration/item-lifecycle.test.ts`.

Acceptance: Given an owned active item, when it is edited, laundered, archived or trashed, then lists and eligibility update correctly and history is preserved as specified.

Security: Owner/version predicates on edits; deleting foreign IDs has no effect; no user-to-user action.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I09 — Add search, filters, sorting and lazy image grids

Phase: **2** · Requirements: **R05 R21 R27** · Depends on: **I08**

Goal: Implement own title/brand/tag search, compound filters, stable sorts and 40-thumbnail pages with in-flight coalescing. Use NFC, locale-aware display sorting and localized taxonomy labels; preserve Nordic letters and stable UUID tie breakers.

Target files: `src/features/wardrobe/search.ts`; `src/features/wardrobe/filters.tsx`; `src/images/use-private-image.ts`.

Test files: `tests/unit/search.test.ts`; `tests/browser/wardrobe-grid.spec.ts`.

Acceptance: Given 500 owned items, when filters and sorting change, then results are correct, stable and independent of 500 foreign fixture records.

Security: Cache keys include UID; abort/discard stale responses; do not cache private photos persistently.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I10 — Complete image replacement and orphan cleanup

Phase: **2** · Requirements: **R04 R12 R20 R23** · Depends on: **I09**

Goal: Implement pending/ready/retired transitions, seven-day retired recovery and safe owner-prefix orphan removal.

Target files: `src/images/replace.ts`; `scripts/cleanup-own-images.mjs`; `src/features/settings/trash.tsx`.

Test files: `tests/integration/image-lifecycle.test.ts`; `tests/security/storage.test.ts`.

Acceptance: Given a failed replacement upload, when retry/cleanup runs, then the current image remains intact, duplicate objects are reconciled and only eligible own files are deleted.

Security: Use Storage API for bytes; no metadata-only deletion as proof; cleanup never follows a foreign prefix.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I11 — Build atomic manual outfit creation and editing

Phase: **3** · Requirements: **R06 R23** · Depends on: **I10**

Goal: Use save_outfit for ordered 1–12 owned selections, notes/occasion and optimistic version conflicts. Render current images with CSS, no stored collage.

Target files: `src/features/outfits/editor.tsx`; `src/features/outfits/detail.tsx`; `src/data/outfits.ts`.

Test files: `tests/integration/outfit-rpc.test.ts`; `tests/browser/outfits.spec.ts`.

Acceptance: Given an owned selection, when the outfit saves or conflicts, then parent/links commit together or remain unchanged, and historical missing items are explicit.

Security: Foreign item/outfit UUIDs fail even when manually sent to RPC; no borrowed/shared reference type.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I12 — Implement planned and worn calendar events

Phase: **3** · Requirements: **R07 R23 R27** · Depends on: **I11**

Goal: Build month/agenda view, multiple looks/day, plan-to-worn conversion, undo and historical snapshots using save_wear_event. Localize date presentation without shifting stored local dates.

Target files: `src/features/calendar/calendar.tsx`; `src/data/wear-events.ts`; `src/domain/local-date.ts`.

Test files: `tests/unit/local-date.test.ts`; `tests/integration/wear-rpc.test.ts`; `tests/browser/calendar.spec.ts`.

Acceptance: Given a plan, when marked worn or undone, then state and history update once; future worn dates fail and changing timezone does not move prior local dates.

Security: Every event/link is owner-bound; deleting an item keeps historical text without a foreign link.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I13 — Add wear statistics and cost per wear

Phase: **3** · Requirements: **R08 R21 R27** · Depends on: **I12**

Goal: Compute distinct local-day wear counts, last worn, unworn items and currency-separated cost per wear. Format values with the selected locale while retaining original currencies and unchanged arithmetic.

Target files: `src/domain/statistics.ts`; `src/features/statistics/statistics-screen.tsx`.

Test files: `tests/unit/statistics.test.ts`; `tests/security/statistics.test.ts`.

Acceptance: Given duplicate same-day looks and mixed currencies, when statistics load, then each item counts once per day and currencies are never summed together.

Security: No administrator/global aggregate or foreign-owner input; unknown/zero-wear values have explicit semantics.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I14 — Implement the deterministic rule engine

Phase: **4** · Requirements: **R09 R24 R25 R27** · Depends on: **I13**

Goal: Implement the templates, hard constraints, beam limits, weights, unknown-attribute semantics and explanations in 09 using saved manual/AI fields. No AI call generates or ranks outfits. Return reason keys/parameters rather than English sentences; language changes leave rankings/signatures identical.

Target files: `src/domain/recommendations.ts`; `src/domain/colour-pairs.ts`; `src/domain/attribute-provenance.ts`.

Test files: `tests/unit/recommendations.test.ts`; `tests/unit/recommendations-properties.test.ts`; `tests/unit/provider-disabled.test.ts`.

Acceptance: Given deterministic fixtures, when ranked, then score arithmetic and ordering match, excluded/laundry/foreign items never appear and missing slots are honest.

Security: Catalog owner is mandatory; no foreign input, outfit AI call or inference of weather protection from an unverified tag. Paid tagging is separate I29 work.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I15 — Build Today suggestions and durable feedback

Phase: **4** · Requirements: **R09 R25 R27** · Depends on: **I14**

Goal: Show up to three suggestions, explanations, context and missing-slot states; wire wear-more, exact dislikes and canonical excluded pairs.

Target files: `src/features/today/today-screen.tsx`; `src/features/today/feedback.tsx`; `src/data/feedback.ts`.

Test files: `tests/browser/today.spec.ts`; `tests/integration/feedback.test.ts`.

Acceptance: Given a disliked pair, when suggestions regenerate across a reload, then that pair never returns and no feedback changes another account. Record the ten-dressing-decision usefulness sample in 09 for each owner with sufficient suitable clothes; distinguish missing details from rule/taste failures.

Security: Clear results on logout/UID change; opening a suggestion must not create a wear event.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I16 — Add opt-in city weather and graceful fallback

Phase: **5** · Requirements: **R10 R09** · Depends on: **I15**

Goal: Implement consent, rounded city lookup, selected-date forecast, three-hour cache, manual context and request cooldowns.

Target files: `src/providers/weather.ts`; `src/features/settings/weather-settings.tsx`; `src/features/today/weather-chip.tsx`.

Test files: `tests/unit/weather.test.ts`; `tests/browser/weather.spec.ts`.

Acceptance: Given weather disabled or a 5-second timeout, when Today opens, then no unauthorized location request occurs and useful non-weather suggestions remain available.

Security: No geolocation permission, Auth token, UID or wardrobe metadata in the provider request; no default city lookup before consent.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I17 — Audit completed features for complete account independence

Phase: **5** · Requirements: **R11 R12 R19 R26** · Depends on: **I16**

Goal: Check all implemented tables, RPCs, routes, types, storage and derived-data paths for owner-only access and absence of relationship/discovery features.

Target files: `tests/security/no-connections.test.ts`; `tests/security/exports-and-caches.test.ts`; `docs/phase-5-result.md`.

Test files: `tests/security/no-connections.test.ts`; `tests/security/rls.sessions.mjs`.

Acceptance: Given two populated accounts, when the full normal-session suite runs, then each is invisible to the other and disabling one leaves the other unchanged.

Security: Assert absent recipient/household/peer columns and APIs; no user-visible global usage statistics.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I18 — Implement versioned encrypted export manifests

Phase: **6** · Requirements: **R13 R19 R27** · Depends on: **I17**

Goal: Implement metadata-v2 export with v1 compatibility per 20, using canonical hashes and envelope v1. Include saved attributes/provenance, descriptions and optional ui_language; exclude unsaved drafts, request results, active consent and usage.

Target files: `src/domain/export-format.ts`; `src/features/settings/export.tsx`; `src/data/export.ts`.

Test files: `tests/unit/export-format.test.ts`; `tests/security/export.test.ts`.

Acceptance: Given an owner snapshot, when exported/decrypted, then schema/owner/hashes match and no Auth row, credential or other-user record appears.

Security: Prompt passphrase securely; never send/store it; reject tampered envelopes and foreign-table fields.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I19 — Add complete image backups and local CLI

Phase: **6** · Requirements: **R13 R20 R18** · Depends on: **I18**

Goal: Stream own image bytes, verify hashes, split bounded parts and provide a compatible Node CLI for weekly encrypted backups.

Target files: `src/features/settings/export-parts.tsx`; `scripts/export-own.mjs`; `scripts/verify-backup.mjs`.

Test files: `tests/integration/full-export.test.ts`; `tests/unit/backup-crypto.test.ts`; `tests/unit/budget.test.ts`.

Acceptance: Given 500 images and an interrupted download, when export resumes, then it produces complete independently verified parts or explicitly reports incomplete backup.

Security: No combined-user export or live-bucket backup copy; no credentials in filenames/command logs/CI artifacts.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I20 — Implement restore dry-run and owner-bound ID mapping

Phase: **6** · Requirements: **R14 R23 R27** · Depends on: **I19**

Goal: Validate metadata v1/v2 parts/limits/checksums and owner-bound mapping before writes. Verify original hashes before normalization; v1 without ui_language is unset and without AI provenance is unverified. Reject unsupported languages/versions, remap provenance image references and preserve each version's mapping namespace.

Target files: `src/domain/restore-plan.ts`; `src/features/settings/restore-preview.tsx`.

Test files: `tests/unit/restore-plan.test.ts`; `tests/security/restore-owner.test.ts`.

Acceptance: Given an encrypted export, when previewed, then planned record/file counts and collisions are visible before any write; wrong passwords/missing parts cause no mutation.

Security: Never trust source paths or owner IDs; no cross-account relationship can be imported.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I21 — Execute resumable restore including historical snapshots

Phase: **6** · Requirements: **R14 R20 R23 R27** · Depends on: **I20**

Goal: Restore in dependency order with checked paths/restore_history_entry; skip equal content and flag conflicts. Preserve saved provenance/descriptions/manual clears and current preferences by default. No imported analysis results/consent and no paid inference.

Target files: `src/data/restore.ts`; `scripts/restore-own.mjs`; `src/features/settings/restore-progress.tsx`.

Test files: `tests/integration/restore-roundtrip.test.ts`; `tests/security/restore-owner.test.ts`.

Acceptance: Given an interrupted import containing a permanently deleted historical item, when rerun, then all data/photos recover once and historical text survives without a foreign link.

Security: Never overwrite differing existing data, reactivate another account, or accept raw archive paths; confirm current owner before commit.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I22 — Build resumable deletion of the current account

Phase: **6** · Requirements: **R15 R19 R26 R27** · Depends on: **I21**

Goal: Fresh password reauth, owner-derived deletion, actual Storage bytes/Auth removal and clear states. Freeze analysis/result retrieval and remove the owner's requests/results/usage. Late responses cannot recreate inventory.

Target files: `supabase/functions/delete-account/index.ts`; `src/features/settings/delete-account.tsx`; `scripts/resume-deletion.mjs`.

Test files: `tests/integration/delete-account.test.ts`; `tests/security/delete-account.test.ts`.

Acceptance: Given A requests deletion, when each stage completes or retries, then A’s data is removed while every B record/file remains unchanged.

Security: Missing/forged JWT, wrong password and injected target UID cause no privileged action; service key remains only in function/operator tools.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I23 — Finish installable PWA and offline/session behaviour

Phase: **7** · Requirements: **R16 R26 R27** · Depends on: **I22**

Goal: Provide original icons/install guidance and static-only caching, explicit offline states and reliable account/logout cleanup.

Target files: `public/manifest.webmanifest`; `src/service-worker.ts`; `src/app/offline-banner.tsx`; `src/auth/session.ts`.

Test files: `tests/browser/pwa.spec.ts`; `tests/security/cache.spec.ts`.

Acceptance: Given an installed app, when offline/reopened/switched, then the shell works, writes do not pretend to save and private data never appears in persistent caches or another account.

Security: No background sync queue with private data; no private endpoint intercepted by service worker.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I24 — Complete accessibility and responsive interaction review

Phase: **7** · Requirements: **R17 R22 R27** · Depends on: **I23**

Goal: Resolve focus, contrast, 200% text resize, crop/order keyboard alternatives and VoiceOver/TalkBack paths across all MVP screens. Review all three UI languages, long labels, html lang and translated recovery/privacy warnings; record native-speaker wording review separately.

Target files: `src/styles/`; `src/app/`; `src/features/`; `docs/accessibility-review.md`.

Test files: `tests/browser/accessibility.spec.ts`; `tests/browser/responsive.spec.ts`; `tests/browser/localization.spec.ts`.

Acceptance: Given 320 px or 200% text size and keyboard/screen reader use, when core journeys run, then controls remain reachable and all actions have clear labels/status.

Security: Private account indicator stays visible; no personal content in accessibility test artifacts beyond fictional fixtures.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I25 — Run final security, dependency and performance gates

Phase: **7** · Requirements: **R01 R04 R11 R12 R18 R19 R21 R24 R27** · Depends on: **I24**

Goal: Run the full suite against final schema/configuration; inspect actual phone image performance, 500-item browsing, bundle size, dependencies and no-connection invariants. Require check:translations and the three-language regression gate before release.

Target files: `tests/security/`; `tests/browser/performance.spec.ts`; `docs/release-checks.md`.

Test files: `tests/security/rls.sessions.mjs`; `tests/browser/performance.spec.ts`; `scripts/scan-secrets.mjs`.

Acceptance: Given the release candidate, when required gates execute, then normal-session security passes, engine/image budgets are measured and no secret/unsupported dependency ships.

Security: A skipped security or real-device gate is recorded as blocking release, never a pass.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I26 — Complete the restore drill and release runbook

Phase: **7** · Requirements: **R13 R14 R15 R18 R20** · Depends on: **I25**

Goal: Perform the documented backup/restore drill, validate quota/pause recovery, and have each user independently complete the release journey.

Target files: `docs/operations.md`; `docs/phase-7-result.md`; `scripts/verify-backup.mjs`.

Test files: `tests/integration/restore-roundtrip.test.ts`; `tests/browser/release-journey.spec.ts`.

Acceptance: Given a clean local recovery target, when the verified export is restored, then counts/hashes/history match and access remains isolated; rollback/resume instructions are concrete.

Security: Keep operator backups restricted; no production wipe or real account deletion is used as a test without a separate explicit request.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I27 — Optional: add owned trips and a private trip screen

Phase: **8** · Requirements: **D01** · Depends on: **I26 and a later explicit request**

Goal: Add the deferred owned trip entity/dates/city only after MVP approval and an explicit request.

Target files: `supabase/migrations/optional_trips.sql`; `src/features/trips/trips-screen.tsx`.

Test files: `tests/security/trips.test.ts`; `tests/browser/trips.spec.ts`.

Acceptance: Given an owned trip, when it is created/edited/deleted, then only that account can access it and date validation works.

Security: No collaborative trip, companion field or account connection; keep the route absent before this optional phase.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.

## I28 — Optional: add owned packing checklists

Phase: **8** · Requirements: **D01** · Depends on: **I27**

Goal: Add unique owned item references, quantity 1–20 and packed toggles, with unavailable item states.

Target files: `src/features/trips/packing-list.tsx`; `src/data/packing.ts`.

Test files: `tests/integration/packing.test.ts`; `tests/security/trips.test.ts`.

Acceptance: Given a trip and owned clothes, when packing state changes, then the checklist is consistent and foreign item IDs are denied.

Security: Owner-only RLS/composite FKs; no borrowed/shared catalog; no MVP issue depends on this work.

Done: implement only this packet, run its named tests plus affected CI gates, and attach actual command/results and a rollback note to the PR. Any unavailable gate stays explicitly incomplete.
