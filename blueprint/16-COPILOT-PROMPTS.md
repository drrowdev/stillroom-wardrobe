# Paste-ready Copilot prompts

These prompts are instructions for future implementation. Do not execute later phases before the previous phase result is complete. Phase 8 is optional and requires a separate request. The no-connection clarification applies to every phase.

Revision 1.4: read `20` for photo-first draft/review/Save and `21` for model selection. Supabase project region is explicitly Stockholm (`eu-north-1`); AI/Edge regions are separate. I29 compares eligible candidates rather than assuming one is best. No post-save worker or AI outfit ranking. Paid activation requires setup approval; supplied SQL is the base only.

## Phase 0 — exact first prompt

```text
Build Phase 0 only of Stillroom Wardrobe from the attached blueprint folder. Copy blueprint/AGENTS.md to repository root and blueprint/.github/copilot-instructions.md to .github/copilot-instructions.md, then follow them.

Read blueprint/00-INDEX.md, 03-MVP-AND-NON-GOALS.md, 05-ARCHITECTURE.md, 07-DATABASE-AND-RLS.sql, 08-API-AND-STORAGE.md, 10-SECURITY-AND-PRIVACY.md, 12-TEST-STRATEGY.md, 13-REPOSITORY-STRUCTURE.md, 19-LOCALIZATION.md, 20-AI-MODELS-AND-WORKFLOWS.md and Phase 0 in 14-IMPLEMENTATION-PLAN.md. Complete issues I01–I05 from 15-GITHUB-ISSUES.md in dependency order. Apply the revision 1.1 base schema only; AI migration/I29 belongs to Phase 2 and outfits remain deterministic.

Use TypeScript, React, Vite and Supabase. Accounts must be completely independent: no household, partner link, user directory, sharing, recipient fields or cross-account recommendations. Reserve exactly two independent test logins administratively; disable public signup. Apply the supplied schema locally. Future hosted Supabase uses Stockholm (eu-north-1), not generic Europe; do not create cloud resources in this phase without explicit approval.

Deliver CI, login/logout, account indicator, one protected wardrobe screen and a JPEG draft/manual-form/explicit-Save flow. Strip metadata and create bounded private main/thumbnail images only on Save. Phase 2 will prefill this form with AI. The browser receives only the publishable key, never a service secret.

Support English, Finnish and Swedish from this slice onward. Use the supplied static catalogs and native Intl helpers with no extra runtime dependency. Persist profiles.ui_language for its owner only, use the saved-owner/sign-in/browser/English precedence, update html lang, and clear language state on logout or UID change. Do not translate user-entered content, identifiers or export keys, and do not change timezone/currency when language changes.

Run real normal-session A/B/anonymous data and image denial tests, the safe-upload journey in all three languages, check:translations, lint, typecheck, unit tests, production build and secret/dependency scans. Setup may use a separate administrator fixture; access assertions must not. Produce docs/phase-0-result.md with exact commands/results and a deployable build. If external credentials or Docker are missing, finish available work and state the specific unrun gate; never claim a mock as a live pass. Do not implement later phases, deferred features or paid AI. Stop after Phase 0’s completion test passes.
```

## Phase 1

```text
Implement Phase 1 only after verifying docs/phase-0-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I06 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/02-PRODUCT-REQUIREMENTS.md, blueprint/04-USER-FLOWS-AND-SCREENS.md, blueprint/06-DATA-MODEL.md, blueprint/08-API-AND-STORAGE.md, blueprint/19-LOCALIZATION.md.

Complete I06 only. Implement private profile/preferences, timezone/currency, account badge, version conflicts and English/Finnish/Swedish UI. Keep personal text unchanged and accounts invisible to one another. I29 adds automatic tagging settings in Phase 2; do not implement that later packet here.

Run the named packet tests plus: npm run test:unit; npm run test:browser -- profile; npm run test:security; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-1-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 2

```text
Implement Phase 2 only after verifying docs/phase-1-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, packets I07, I29, I08–I10 in blueprint/15-GITHUB-ISSUES.md, and blueprint/04-USER-FLOWS-AND-SCREENS.md, blueprint/06-DATA-MODEL.md, blueprint/07-DATABASE-AND-RLS.sql, blueprint/08-API-AND-STORAGE.md, blueprint/10-SECURITY-AND-PRIVACY.md, blueprint/19-LOCALIZATION.md, blueprint/20-AI-MODELS-AND-WORKFLOWS.md.

Complete I07, I29, I08, I09, I10 in that order. Start with photo only; automatically analyze and fill title/category/details in the existing editable form. Allow editing every garment field/description before explicit Save to library; analysis/discard creates no inventory or persistent photo. Implement analyze-clothing, bounded result/cost receipts, consent/allowances and model gate. No tagging queue, scheduler or post-save writeback. Preserve edits/clears, reject stale drafts and allow manual completion on timeout. Include narrow saved-description editing without changing media paths/bytes. No paid activation without approval or real inference in CI. Translate all states; no AI outfit generation.

Run the named packet tests plus: npm run test:unit; npm run test:integration; npm run test:browser; npm run test:security; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-2-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 3

```text
Implement Phase 3 only after verifying docs/phase-2-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I11–I13 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/04-USER-FLOWS-AND-SCREENS.md, blueprint/06-DATA-MODEL.md, blueprint/07-DATABASE-AND-RLS.sql, blueprint/08-API-AND-STORAGE.md, blueprint/12-TEST-STRATEGY.md, blueprint/19-LOCALIZATION.md.

Complete I11–I13 in dependency order. Implement atomic outfits, calendar plans/worn events, immutable history and distinct-day currency-separated statistics in all three languages. Preserve the I29 attribute/provenance contracts. Accounts stay unrelated; no AI outfit generation or additional deferred features.

Run the named packet tests plus: npm run test:unit; npm run test:integration; npm run test:browser; npm run test:security; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-3-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 4

```text
Implement Phase 4 only after verifying docs/phase-3-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I14–I15 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/02-PRODUCT-REQUIREMENTS.md, blueprint/04-USER-FLOWS-AND-SCREENS.md, blueprint/08-API-AND-STORAGE.md, blueprint/09-RECOMMENDATIONS.md, blueprint/19-LOCALIZATION.md.

Complete I14–I15 in dependency order. Implement deterministic rules using saved manual/AI attributes, exact scoring/beam limits, unknown-value semantics, own feedback and honest partial results. No model generates, reranks or explains outfits. Use localized reason keys in all three languages; record the ten-decision usefulness sample. No account connections, AI stylist or deferred features.

Run the named packet tests plus: npm run test:unit; npm run test:integration; npm run test:browser; npm run test:security; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-4-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 5

```text
Implement Phase 5 only after verifying docs/phase-4-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I16–I17 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/04-USER-FLOWS-AND-SCREENS.md, blueprint/05-ARCHITECTURE.md, blueprint/08-API-AND-STORAGE.md, blueprint/09-RECOMMENDATIONS.md, blueprint/10-SECURITY-AND-PRIVACY.md, blueprint/11-COST-AND-HOSTING.md, blueprint/12-TEST-STRATEGY.md, blueprint/19-LOCALIZATION.md.

Complete I16–I17 in dependency order. Implement opt-in weather/fallback and account-isolation checks including I29 drafts, requests/results, usage, consent, discarded analyses and late responses. Translate every feature. No account connections, new AI services or deferred features.

Run the named packet tests plus: npm run test:unit; npm run test:browser; npm run test:security; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-5-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 6

```text
Implement Phase 6 only after verifying docs/phase-5-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I18–I22 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/06-DATA-MODEL.md, blueprint/07-DATABASE-AND-RLS.sql, blueprint/08-API-AND-STORAGE.md, blueprint/10-SECURITY-AND-PRIVACY.md, blueprint/12-TEST-STRATEGY.md, blueprint/17-DEPLOYMENT-AND-RECOVERY.md, blueprint/19-LOCALIZATION.md.

Complete I18–I22 in dependency order. Implement metadata-v2 export, v1/v2 readers, owner-bound restore and fresh-reauth deletion, keeping envelope v1. Preserve saved provenance/descriptions/manual clears; exclude drafts, request results and usage. Save/restore never invokes AI or imports consent. Deletion removes analysis data; late responses cannot create inventory. Translate all features.

Run the named packet tests plus: npm run test:unit; npm run test:integration; npm run test:security; npm run test:browser; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-6-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 7

```text
Implement Phase 7 only after verifying docs/phase-6-result.md contains a passing completion gate. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I23–I26 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/02-PRODUCT-REQUIREMENTS.md, blueprint/04-USER-FLOWS-AND-SCREENS.md, blueprint/10-SECURITY-AND-PRIVACY.md, blueprint/11-COST-AND-HOSTING.md, blueprint/12-TEST-STRATEGY.md, blueprint/17-DEPLOYMENT-AND-RECOVERY.md, blueprint/19-LOCALIZATION.md.

Complete I23–I26 in dependency order. Implement shell-only offline behavior and full device/accessibility/security/recovery gates in all three languages. Cover photo-only prefill, edits before Save, discard, unknown fields, timeout/manual fallback, description edits and no late writes or restore charges. Unsaved drafts are not guaranteed to survive closure. No AI outfit ranking or account connections.

Run the named packet tests plus: npm run lint; npm run typecheck; npm run test:unit; npm run test:integration; npm run test:security; npm run test:browser; npm run test:a11y; npm run build; npm run scan:secrets; npm run check:dependencies; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-7-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```

## Phase 8

```text
This optional Phase 8 is now explicitly requested; verify Phase 7 passed before proceeding. Read root AGENTS.md, blueprint/14-IMPLEMENTATION-PLAN.md, the I27–I28 packets in blueprint/15-GITHUB-ISSUES.md, and blueprint/03-MVP-AND-NON-GOALS.md, blueprint/06-DATA-MODEL.md, blueprint/10-SECURITY-AND-PRIVACY.md, blueprint/12-TEST-STRATEGY.md, blueprint/14-IMPLEMENTATION-PLAN.md, blueprint/19-LOCALIZATION.md.

Complete I27–I28 in dependency order. Implement optional private trips and owned packing lists in all three languages; no collaborative/companion/borrowed fields. Preserve existing tagging and deterministic recommendation boundaries. No account connections, additional AI service or other deferred feature.

Run the named packet tests plus: npm run test:unit; npm run test:integration; npm run test:security; npm run test:browser; npm run check:translations. Also run lint/typecheck/build and secret/dependency checks for changed runtime code. Normal-session authorization assertions must use the users’ tokens, never administrator credentials. Record exact commands/results, device/restore evidence where required, limitations and rollback in docs/phase-8-result.md. Missing infrastructure is an explicit unrun gate, not a pass. Stop after this phase passes; do not start the next phase.
```
