# Ordered implementation plan

No app has been built. **Latest scope: photo-first AI-filled draft, edit any garment field, explicit Save to library; independent accounts and deterministic outfits.** Phase 0 uses base SQL with a manual draft/Save slice. I29 adds the pre-save AI flow in Phase 2. No post-save background enrichment. Trips remain outside MVP.

| Phase | Work packets | Dependency / exit evidence | Risk and rollback |
|---|---|---|---|
| 0 — secure slice | I01–I05 | New repository/CI, local Supabase, two independently approved test accounts, English/Finnish/Swedish login, one wardrobe screen and one sanitized private JPEG upload. Independent language preferences and translation gate pass. Build deployable. Real A/B/anonymous table and image access tests pass. | Wrong auth/storage configuration is the main risk. Reset only disposable local data; revert static commit. Never weaken RLS to make a test pass. |
| 1 — personal setup | I06 | Phase 0 green; own profile/preferences and language selector save with timezone/currency and conflict handling, account indicator correct. | Cache from another UID; test account switch. Revert UI while schema remains compatible. |
| 2 — wardrobe/images/draft AI | I07, I29, I08–I10 | Photo-only start, automatic title/category/details, editing every field, exact reviewed Save, no library writes on analysis/discard, description editing and model/budget gate. | AI failure allows manual completion; stale responses never overwrite edits/saved values. Current photos survive replacement until Save succeeds. |
| 3 — outfits/history | I11–I13 | Phase 2 green; atomic outfit/calendar operations, DST/date cases and cost-per-wear arithmetic pass. | Lost links or double counts. Use RPC transactions and historical snapshots; revert UI without deleting history. |
| 4 — suggestions | I14–I15 | Phase 3 green; deterministic scoring over manual/AI attributes, unknown hard-constraint cases, feedback and ten-decision usefulness sample. No model calls for outfits. | Inappropriate suggestions. Keep manual outfits available; fix metadata/rules rather than assuming more AI is required. |
| 5 — weather/isolation | I16–I17 | Phase 4 green; city consent/fallback tested; every completed feature contains only own data; no account-connection entity/API exists. | Location leakage or accidentally broad aggregates. Disable weather independently; fix owner filter without widening policies. |
| 6 — portability/deletion | I18–I22 | V1/v2 recovery preserves saved provenance/descriptions, excludes drafts/request results and never triggers AI; deletion removes receipts/usage. | Verified export first; no imported consent, cross-owner data or late response recreating an item. |
| 7 — release | I23–I26 | Phase 6 green; PWA/offline, accessibility, performance, complete security suite and restore drill recorded. Each user independently completes the release journey. | Free-tier pause/quotas and device-specific failures. Resume provider or roll back last static build; no automatic paid upgrade. |
| 8 — optional trips | I27–I28 | Only after Phase 7 and a later explicit request. Separate owned trips/checklist migration and tests. | Scope growth. Keep optional route disabled and remove optional migration only in a disposable environment. |

## Phase completion rules

English/Finnish/Swedish is required from Phase 0, not a deferred phase. I01 establishes the catalog/helpers/translation gate; I03 localizes login, wardrobe and upload and initializes an unset owner preference; I06 adds the full profile/settings selector. Every feature packet translates its UI in the same PR. I24–I25 review all three languages, long labels, screen-reader language and independent preferences. Run `check:translations` at every phase exit. See `19-LOCALIZATION.md` for exact contracts and migration compatibility.

Each phase produces a short `docs/phase-N-result.md` with commit, implemented issue IDs, commands and exit codes, actual tests/device checks, remaining limitations and rollback point. Redact all account data and credentials. A diagram or “looks correct” is not passing evidence. A skipped security test is a failed completion gate.

If infrastructure credentials are missing, finish all local implementation and executable tests, then name the exact external setup needed. Do not invent a deployment or passing live test. The Phase 0 prompt already settles the stack, migration, admission method, image paths and one-screen scope, so this is configuration rather than an architecture question.

No issue automatically activates billing, creates an account relationship or adds a native client. I29 implements the approved paid tagging feature; actual calls require provider/terms/region approval, owner consent and finite allowances. Phase 0 makes no AI calls. Existing issue IDs remain stable: I29 is deliberately ordered after I07 and before I08, not after optional trips.

Keep packets reviewable; I29 can split into migration, endpoint and draft UI. Use `21` to compare two eligible models before recording the chosen configuration and pre-save journey. Confirm terms/region access before personal-photo comparisons. Supabase's project region is Stockholm (`eu-north-1`), independent of AI/Edge processing. No inference scheduler or AI outfit ranking.

## Minimal Phase 0 demonstration

Phase 0 is the manual foundation: sign in -> select/prepare JPEG -> editable title/category form -> explicit Save -> reserve/upload/commit -> show completed item. Phase 2 fills that same form automatically from the photo. Normal A/B/anonymous isolation must hold, with no privileged browser secret. Analysis is not needed to begin the secure slice.

Run the slice in all three languages. Specifically, save A's language as Finnish and B's as Swedish; each subsequent login restores only its own choice. Changing A to English must leave B Swedish and preserve both accounts' timezone/currency and stored content. A cannot PATCH B's `ui_language` even by direct request.
