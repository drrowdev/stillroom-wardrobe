# Test strategy and traceability

The package contains executed PostgreSQL authorization checks and a runnable normal-session HTTP harness. It does not contain an implemented app. `validation/VALIDATION-REPORT.md` states precisely what ran. Future test paths below are implementation targets, not existing passing tests.

Revision 1.3 defines photo-first filling and reviewed Save. Revision 1.4 adds Stockholm and the current comparison in `21`; neither changes that flow. Historical results do not cover the endpoint/migration. CI uses fixtures, never paid calls. I29 compares two eligible models with authorized photos and records correction effort, abstention, latency and billed usage, separately from structural/schema tests.

## Access matrix

A and B are fictional test identities, not a household relationship. Test both directions. A denied SELECT may be an empty 200 response; denied UPDATE/DELETE may affect zero rows. Verify the owner's value remains unchanged as well as checking status.

| Resource/operation | A on A | A on B | B on B | B on A | Anonymous |
|---|---|---|---|---|---|
| Private tables SELECT | Own rows | Empty/denied | Own rows | Empty/denied | Denied |
| Private INSERT with owner override | Allowed when valid | Denied | Allowed when valid | Denied | Denied |
| UPDATE/DELETE original | Allowed within narrower grants | No effect | Allowed within narrower grants | No effect | Denied |
| Profile language preference | Own valid language | No effect | Own valid language | No effect | Denied |
| Outfit/wear/restore RPC | Own graph only | Denied | Own graph only | Denied | Denied |
| Storage list/download | Own reserved objects | Empty/denied | Own reserved objects | Empty/denied | Denied |
| Storage upload/delete | Own reserved paths | Denied | Own reserved paths | Denied | Denied |
| Storage overwrite | Denied; new image version required | Denied | Denied | Denied | Denied |
| Storage signing through raw owner API | Own only, no app link feature | Denied | Own only, no app link feature | Denied | Denied |
| Export | Own rows/files only | Impossible target | Own rows/files only | Impossible target | Denied |
| User/profile discovery | No endpoint | No endpoint | No endpoint | No endpoint | No endpoint |
| Server-only deletion controller | Denied from user session | Denied | Denied from user session | Denied | Denied |
| Own deletion Edge endpoint | Fresh own password required | Target parameter ignored/rejected | Fresh own password required | Target parameter ignored/rejected | Denied |
| AI consent/status/retry | Own only | Denied/no effect | Own only | Denied/no effect | Denied |
| Analyze draft photo/result retrieval | Own consent + allowance | No foreign target/results | Own consent + allowance | No foreign target/results | Denied |
| Private AI requests/usage | No direct table access | Denied | No direct table access | Denied | Denied |
| Image-description edit | Own/version checked | No effect | Own/version checked | No effect | Denied |

Narrower grants intentionally deny direct profile creation/deletion, image-state changes, history import flags and all access to private administrative tables. Checked RPCs implement permitted workflows. There are no sharing exceptions.

## Levels and fixtures

* Unit: scoring arithmetic/hard constraints, calendar date/DST, currency grouping, search, JPEG headers/metadata, export crypto envelope, UUIDv8 mapping and retries. Check all EN/FI/SV keys/parameters, plurals, negotiation, Nordic text, locale price input and invariant date/currency storage. Use deterministic clocks and fictional items.
* Database/integration: apply fresh migration and separately exercise the additive language upgrade; enforce all constraints/policies/functions; verify atomic multi-row writes and zero cross-owner effects, including different language preferences. PostgreSQL stubs supplement, never replace, real Supabase service tests.
* HTTP security: normal password sign-ins to local Supabase, separate tokens, anonymous client, explicit object/sign/list calls, guessed IDs, foreign FKs, exports and service-RPC denial. Verify A can save Finnish and B Swedish, unsupported language codes fail, and cross-owner language changes have no effect. Setup privilege is kept in a separate process.
* Browser: sign-in/capture/outfit/wear/statistics/export/restore/logout flows in all three languages and separate browser contexts for A/B, mobile layouts, slow requests, network outage and session change. Check html lang, localized critical messages, independent saved language and complete reset on UID change.
* Accessibility: automated axe plus real VoiceOver/Safari and TalkBack/Chrome; keyboard crop/order/calendar alternatives; 320 px/200% text, long Finnish/Swedish labels and contrast. Automated zero findings alone is insufficient.
* Operations: encrypted full export → empty disposable recovery target → restore → count/hash comparison and normal-session isolation. Fault injection between upload/commit and every deletion stage.

Security tests must never use a production deletion as a fixture. The live harness inserts temporary owned fixtures, cleans only those UUIDs and restores each disposable owner's previous language preference. It refuses missing explicit test consent or any service secret in its process. Test output logs names/outcomes, never credentials/content.

The supplied catalog/helper checks validate translation references only. They do not prove a browser UI, screen-reader behaviour or native-speaker wording review; those remain implementation gates in `19-LOCALIZATION.md`.

## Requirement traceability

Each row is Requirement → Screen → Table → Operation → Issue → Test. `approved_accounts`/`deletion_jobs` are private schema tables. Screens are defined in `04`; issue packets in `15`.

| Requirement | Screen | Tables/data | Operation | Issue | Test target |
|---|---|---|---|---|---|
| R01 | S01/S04 | approved_accounts, profiles, items | Auth admission; own SELECT | I02 I03 I05 I25 | tests/security/rls.sessions.mjs |
| R02 | S02 | profiles, style_preferences | Version-checked PATCH | I06 | tests/browser/profile.spec.ts |
| R03 | S04–S06/S13 | items, item_images | Item CRUD/lifecycle | I04 I08 | tests/browser/items.spec.ts |
| R04 | S05/S06 | item_images; storage.objects | Prepare/reserve/upload/commit | I04 I07 I10 | tests/browser/images.spec.ts |
| R05 | S04 | items | Owner query; local filters | I09 | tests/unit/search.test.ts |
| R06 | S07–S09 | outfits, outfit_items | save_outfit | I11 | tests/integration/outfit-rpc.test.ts |
| R07 | S10 | wear_events, wear_event_items | save_wear_event | I12 | tests/integration/wear-rpc.test.ts |
| R08 | S11 | items, wear_events, wear_event_items | Own counts/currency reducer | I13 | tests/unit/statistics.test.ts |
| R09 | S03 | Own catalog/history, preferences | Pure rules-v1 | I14 I15 I16 | tests/unit/recommendations.test.ts |
| R10 | S03/S12 | profiles; memory weather cache | Opt-in weather adapter | I16 | tests/browser/weather.spec.ts |
| R11 | All protected screens | All tables; absence of relationship entities | No user directory/foreign input | I02 I05 I17 I25 | tests/security/no-connections.test.ts |
| R12 | S04–S09 | item_images; storage.objects | Authenticated Storage operations | I04 I10 I17 | tests/security/rls.sessions.mjs |
| R13 | S12 | All owner export tables | export_manifest + encrypted parts | I18 I19 | tests/integration/full-export.test.ts |
| R14 | S12 | Owner graph; import_id on history | Dry-run/map/restore_history_entry | I20 I21 | tests/integration/restore-roundtrip.test.ts |
| R15 | S12 | deletion_jobs; own rows/Auth/files | delete-account; deletion_control | I22 | tests/security/delete-account.test.ts |
| R16 | S01–S13 | Session memory only | Static service worker/install | I01 I23 | tests/browser/pwa.spec.ts |
| R17 | S01–S13 | Private alt_text; semantic forms | Keyboard/screen-reader/contrast | I07 I24 | tests/browser/accessibility.spec.ts |
| R18 | S12/operator runbook | Own sizes; provider dashboard | Quotas/build/budget checks | I01 I19 I26 | tests/unit/budget.test.ts |
| R19 | All boundaries | No secrets in public tables/logs | Env allowlist/log redaction/scan | I01 I05 I18 I22 I25 | scripts/scan-secrets.mjs |
| R20 | S12/S13 | Owner records/images; deletion receipts | Backup/cleanup/restore drill | I10 I19 I21 I26 | tests/integration/restore-roundtrip.test.ts |
| R21 | S03/S04/S11 | Owner indexes and bounded catalog | Lazy grid/bounded beam | I09 I13 I25 | tests/browser/performance.spec.ts |
| R22 | S01–S13 | Original static taxonomy/assets | Source/asset review | I01 I24 | tests/unit/original-assets.test.ts |
| R23 | S05/S08/S10/S12 | UUIDs, versions, immutable paths | RPC atomic writes/idempotent retries | I04 I08 I10 I11 I12 I20 I21 | tests/integration/idempotency.test.ts |
| R24 | S03/S05 | No provider data table | Disabled provider interfaces | I07 I14 | tests/unit/provider-disabled.test.ts |
| R25 | S02/S03 | preferences, combination_rules, feedback | Own feedback actions | I06 I14 I15 | tests/integration/feedback.test.ts |
| R26 | S01/all protected | approved_accounts; session memory | Current approval and logout | I02 I03 I17 I22 I23 | tests/security/session-cache.spec.ts |
| R27 | S01–S13 | profiles.ui_language; static translation catalog | Owner language PATCH; translation/Intl formatting | I01 I03 I06 I24 I25 | tests/unit/i18n.test.ts |
| R28 | S05/S06/S12 | profiles consent; saved provenance; private ai_requests/ai_usage | Analyze draft; edit all fields; explicit Save/discard | I29 | tests/integration/automatic-tagging.test.ts |

## Concrete critical cases

1. Sign A and B in normally. Create an item and image for each. Query the opposite ID with SELECT/PATCH/DELETE, nested outfit/wear relations, RPCs and Storage download/sign/list/upload/delete. Assert no read and no mutation, in both directions.
2. Attempt public signup and an unapproved third email. Confirm no approved profile can result. Ordinary users cannot query the approval table or call a user-list function.
3. Populate all own tables. Export as A. Every exported `owner_id` equals A; B's text, IDs and bytes do not occur. Repeat for B.
4. Attempt to import owner overrides/foreign IDs/paths and call the service-only deletion controller. These must fail. Correct own restore preserves old text for a deleted item through the import RPC.
5. Disable A through an isolated admin fixture while A has a valid token. Fresh A database/storage access fails; B still works. Do not simulate this assertion by issuing a privileged query.
6. Upload photo fixtures with all eight EXIF orientations and GPS/XMP metadata. Decode main/thumb output: right orientation, declared dimensions/byte limits, no EXIF/GPS/XMP. Raw originals never appear in network requests.
7. In two A sessions, edit with the same version. One succeeds and the stale write reports conflict without changing links. Retry identical create/upload IDs: no duplicates. Interrupt between both image uploads and commit: old image survives.
8. Reuse a garment in multiple same-day looks: count once. Plans count zero. Trash/undo updates counts. Permanent item deletion retains historical text; account deletion removes the complete owner graph.
9. Add 500 foreign records to a recommendation fixture: output remains identical. Laundry, excluded pair and unsupported context never become a complete suggestion. Engine expansions remain bounded.
10. Build with a unique service-secret canary in the server environment. Scan every deployable file and source map; zero canary/privileged credential occurrences. User metadata cannot supply identity or an administrator role.
11. After logout and UID change, inspect DOM, in-memory adapters, Cache Storage, IndexedDB, service-worker caches and late network responses. No previous-user content may render.
12. Corrupt/truncate/miss an export part and try a wrong password. Dry-run must make zero writes. Re-run interrupted valid restore: equal rows/files skip; differing existing content requires review.
13. Set A to Finnish and B to Swedish. Save/reopen each session, attempt foreign language PATCH in both directions, and switch accounts on one device. Each owner retains their own preference; previous-owner language clears. Changing language preserves drafts, personal text, timezone/currency, calendar dates and recommendation IDs/scores.
14. Start with only a photo, automatically fill title/category/details, edit every garment field and description, and Save. Assert no item/image objects, search results, suggestions, history or export entries before Save. Discard leaves no inventory. Save persists exactly the reviewed values; late analysis cannot change them.
15. Test edits/clears during analysis, photo-generation changes, timeout/manual completion, invalid/unknown output, expired receipts, logout, consent withdrawal, freeze/deletion, duplicates and budget races. Identical status/retries never redispatch; uncertain charges are not assumed zero. No invented price/warmth/protection.
16. Export/restore metadata v1/v2 including saved provenance/description edits. Exclude drafts/request results; never enable AI or call a model on Save/restore. Edit existing alt text with owner/version checks while image bytes/paths remain unchanged. Outfit calculation uses saved items only and makes zero AI calls.

## Release gates and stopping rule

Phase 0 covers normal-session isolation, a safe explicit save and deployable build. Phase 2 adds I29's photo-only start, editable prefill, no writes before Save, description editing, receipt/budget suite and authorized model sample. Phase 4 covers unknown values/usefulness. Phase 5 checks all owner boundaries; Phase 6 covers v1/v2 recovery without AI calls. Phase 7 runs final device/recovery gates. Optional trips need a later request.

Do not broaden testing after the required gates pass unless a concrete remaining risk or discovered defect calls for it. Report skipped/unavailable gates explicitly. No real service credentials were supplied for this documentation task, so live Auth/Storage/browser/deletion tests are pending implementation, not claimed successes.
